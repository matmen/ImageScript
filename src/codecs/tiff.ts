import { decompressAsync } from './zlib.ts';
import * as jpeg from './jpeg.ts';
import { MAX_PIXELS, checkPixels, checkBytes } from '../util/limits.ts';

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

const TAGS = {
    ImageWidth: 256,
    ImageLength: 257,
    BitsPerSample: 258,
    Compression: 259,
    Photometric: 262,
    FillOrder: 266,
    Orientation: 274,
    StripOffsets: 273,
    SamplesPerPixel: 277,
    RowsPerStrip: 278,
    StripByteCounts: 279,
    PlanarConfiguration: 284,
    Predictor: 317,
    ColorMap: 320,
    TileWidth: 322,
    TileLength: 323,
    TileOffsets: 324,
    TileByteCounts: 325,
    ExtraSamples: 338,
    SampleFormat: 339,
    JPEGTables: 347,
    YCbCrCoefficients: 529,
    YCbCrSubSampling: 530,
    ReferenceBlackWhite: 532
};

const COMPRESSION_NAMES: Record<number, string> = { 2: 'CCITT RLE', 3: 'CCITT fax 3', 4: 'CCITT fax 4', 6: 'old-style JPEG', 32809: 'ThunderScan', 34676: 'SGI LogLuv', 34677: 'SGI LogL' };

/**
 * Decodes the first image of a TIFF into 8-bit RGBA pixel data
 * Supports classic and BigTIFF in both byte orders, strips and tiles, chunky and planar data,
 * no/LZW/deflate/PackBits/JPEG compression, horizontal and floating point predictors,
 * 1-32 bit integer and 32/64 bit float samples (auto-ranged), greyscale, palette, RGB, CMYK and YCbCr images with alpha
 * @param {Uint8Array} data
 * @return {{width: number, height: number, pixels: Uint8Array}}
 */
type ValuesOf = (tag: number, fallback: number[]) => number[];

interface SampleReader {
    (rowOffset: number, n: number): { raw: number, value: number };
}

export async function decode(data: Uint8Array, maxPixels = MAX_PIXELS): Promise<{ width: number, height: number, pixels: Uint8Array, orientation: number }> {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    let little: boolean;
    if (data[0] === 0x49 && data[1] === 0x49) little = true;
    else if (data[0] === 0x4d && data[1] === 0x4d) little = false;
    else throw new Error('TIFF: invalid byte order');

    const u16 = (offset: number): number => view.getUint16(offset, little);
    const u32 = (offset: number): number => view.getUint32(offset, little);
    const u64 = (offset: number): number => {
        const lo = view.getUint32(offset + (little ? 0 : 4), little);
        const hi = view.getUint32(offset + (little ? 4 : 0), little);
        return hi * 0x100000000 + lo;
    };

    const version = u16(2);
    if (version !== 42 && version !== 43) throw new Error('TIFF: invalid version');
    const big = version === 43;

    const ifdOffset = big ? u64(8) : u32(4);
    if (ifdOffset + 2 > data.length) throw new Error('TIFF: invalid IFD offset');

    // read the first IFD
    const tags = new Map<number, { type: number, count: number, offset: number }>();
    const entryCount = big ? u64(ifdOffset) : u16(ifdOffset);
    const entrySize = big ? 20 : 12;
    const inlineSize = big ? 8 : 4;

    for (let i = 0; i < entryCount; i++) {
        const entry = ifdOffset + (big ? 8 : 2) + i * entrySize;
        if (entry + entrySize > data.length) break;

        const tag = u16(entry);
        const type = u16(entry + 2);
        const count = big ? u64(entry + 4) : u32(entry + 4);
        const size = TYPE_SIZES[type];
        if (!size) continue;

        const valueField = entry + (big ? 12 : 8);
        const offset = size * count <= inlineSize ? valueField : big ? u64(valueField) : u32(valueField);
        if (offset + size * count > data.length) continue;

        tags.set(tag, { type, count, offset });
    }

    const read = (type: number, offset: number): number => {
        switch (type) {
            case 1: case 2: case 7: return data[offset];
            case 6: return view.getInt8(offset);
            case 3: return u16(offset);
            case 8: return view.getInt16(offset, little);
            case 4: case 13: return u32(offset);
            case 9: return view.getInt32(offset, little);
            case 5: return u32(offset) / u32(offset + 4);
            case 10: return view.getInt32(offset, little) / view.getInt32(offset + 4, little);
            case 11: return view.getFloat32(offset, little);
            case 12: return view.getFloat64(offset, little);
            case 16: case 18: return u64(offset);
            case 17: return Number(view.getBigInt64(offset, little));
            default: return 0;
        }
    };

    function values(tag: number): number[] | undefined;
    function values(tag: number, fallback: number[]): number[];
    function values(tag: number, fallback?: number[]): number[] | undefined {
        const entry = tags.get(tag);
        if (!entry) return fallback;

        const result: number[] = new Array(entry.count);
        const size = TYPE_SIZES[entry.type];
        for (let i = 0; i < entry.count; i++) result[i] = read(entry.type, entry.offset + i * size);
        return result;
    }

    function value(tag: number): number | undefined;
    function value(tag: number, fallback: number): number;
    function value(tag: number, fallback?: number): number | undefined {
        const v = values(tag);
        return v && v.length ? v[0] : fallback;
    }

    const orientationTag = value(TAGS.Orientation, 1);
    const orientation = orientationTag >= 1 && orientationTag <= 8 ? orientationTag : 1;
    const width = value(TAGS.ImageWidth);
    const height = value(TAGS.ImageLength);
    if (!width || !height) throw new Error('TIFF: invalid dimensions');

    const samplesPerPixel = value(TAGS.SamplesPerPixel, 1);
    const bitsPerSample = values(TAGS.BitsPerSample, [1]);
    const bps = bitsPerSample[0];
    if (bitsPerSample.some(b => b !== bps)) throw new Error('TIFF: mixed bit depths are not supported');

    const compression = value(TAGS.Compression, 1);
    const photometric = value(TAGS.Photometric, samplesPerPixel >= 3 ? 2 : 1);
    const planar = value(TAGS.PlanarConfiguration, 1) === 2 && samplesPerPixel > 1;
    const predictor = value(TAGS.Predictor, 1);
    const sampleFormat = value(TAGS.SampleFormat, 1);
    const fillOrder = value(TAGS.FillOrder, 1);
    const extraSamples = values(TAGS.ExtraSamples, []);

    if (COMPRESSION_NAMES[compression]) throw new Error(`TIFF: ${COMPRESSION_NAMES[compression]} compression is not supported`);
    if (![1, 5, 7, 8, 32773, 32946].includes(compression)) throw new Error(`TIFF: compression ${compression} is not supported`);
    if (![0, 1, 2, 3, 5, 6].includes(photometric)) throw new Error(`TIFF: photometric interpretation ${photometric} is not supported`);
    if (sampleFormat === 3 ? bps !== 32 && bps !== 64 : bps < 1 || bps > 32) throw new Error(`TIFF: ${bps}-bit samples are not supported`);

    const colorChannels = ({ 0: 1, 1: 1, 2: 3, 3: 1, 5: 4, 6: 3 } as Record<number, number>)[photometric];
    if (samplesPerPixel < colorChannels) throw new Error('TIFF: not enough samples per pixel');

    // the first extra sample is alpha if it is marked as associated (1) or unassociated (2)
    const alphaType = samplesPerPixel > colorChannels ? extraSamples[0] || 0 : 0;
    const alphaChannel = alphaType === 1 || alphaType === 2 ? colorChannels : -1;

    // pre-6.0 tiled files store tile offsets in the strip tags
    const tiled = tags.has(TAGS.TileWidth) && tags.has(TAGS.TileLength);
    const segmentWidth = tiled ? value(TAGS.TileWidth) : width;
    const segmentHeight = tiled ? value(TAGS.TileLength) : Math.min(height, value(TAGS.RowsPerStrip, height));
    const offsets = values(TAGS.TileOffsets) || values(TAGS.StripOffsets);
    const byteCounts = values(TAGS.TileByteCounts) || values(TAGS.StripByteCounts);
    if (!offsets || !segmentWidth || !segmentHeight) throw new Error('TIFF: missing image data');

    const segmentsAcross = Math.ceil(width / segmentWidth);
    const segmentsDown = Math.ceil(height / segmentHeight);
    const segmentsPerPlane = segmentsAcross * segmentsDown;
    const segment = (index: number): Uint8Array => {
        const offset = offsets[index];
        const count = byteCounts ? byteCounts[index] : data.length - offset;
        if (offset === undefined || offset >= data.length) throw new Error('TIFF: missing image data');
        return data.subarray(offset, Math.min(data.length, offset + count));
    };

    checkPixels(width, height, maxPixels);
    // tiles may reach past the image, but not by much (a segment's buffer is that large), and samples can take more
    // memory than the pixels
    checkPixels(segmentWidth, segmentHeight, Math.max(4 * width * height, 1 << 20));
    checkBytes(Math.ceil(width * samplesPerPixel * bps / 8) * height, maxPixels);
    const pixels = new Uint8Array(width * height * 4);

    // JPEG compressed segments decode straight to RGBA
    if (compression === 7) {
        const jpegTables = tags.get(TAGS.JPEGTables);
        const tables = jpegTables ? data.subarray(jpegTables.offset, jpegTables.offset + jpegTables.count) : null;
        const transform = photometric === 6 ? 'ycc' : photometric === 2 ? 'rgb' : photometric === 5 ? 'cmyk' : null;

        for (let s = 0; s < segmentsPerPlane; s++) {
            let stream = segment(s);
            // abbreviated streams: tables (without EOI) + segment (without SOI)
            if (tables) {
                const joined = new Uint8Array(tables.length - 2 + stream.length - 2);
                joined.set(tables.subarray(0, tables.length - 2));
                joined.set(stream.subarray(2), tables.length - 2);
                stream = joined;
            }

            const decoded = jpeg.decode(stream, { transform });
            blitRGBA(decoded.pixels, decoded.width, decoded.height, pixels, width, height, (s % segmentsAcross) * segmentWidth, (s / segmentsAcross | 0) * segmentHeight);
        }

        return { width, height, pixels, orientation };
    }

    // decompress every segment into a contiguous sample buffer (one plane per sample when planar)
    const samplesPerRow = planar ? 1 : samplesPerPixel;
    const planes = planar ? samplesPerPixel : 1;
    const subsampling = photometric === 6 ? values(TAGS.YCbCrSubSampling, [2, 2]) : [1, 1];
    const subsampled = photometric === 6 && (subsampling[0] !== 1 || subsampling[1] !== 1);

    if (subsampled) {
        if (tiled || planar || bps !== 8) throw new Error('TIFF: subsampled YCbCr is only supported for 8-bit strips');
        const [h, v] = subsampling;
        const unitsPerRow = Math.ceil(width / h);
        const unitRowBytes = unitsPerRow * (h * v + 2);
        const units = new Uint8Array(Math.ceil(height / v) * unitRowBytes);

        let written = 0;
        for (let s = 0; s < segmentsPerPlane && written < units.length; s++) {
            const expected = Math.min(units.length - written, Math.ceil(segmentHeight / v) * unitRowBytes);
            const raw = await decompressSegment(segment(s), compression, expected);
            units.set(raw.subarray(0, expected), written);
            written += expected;
        }

        ycbcrUnitsToRGBA(units, width, height, h, v, ycbcrConversion(values), pixels);
        return { width, height, pixels, orientation };
    }

    const rowBytes = Math.ceil(width * samplesPerRow * bps / 8);
    const planeBytes = rowBytes * height;
    const raw = new Uint8Array(planeBytes * planes);
    const segmentRowBytes = Math.ceil(segmentWidth * samplesPerRow * bps / 8);

    for (let plane = 0; plane < planes; plane++) {
        for (let s = 0; s < segmentsPerPlane; s++) {
            const sx = (s % segmentsAcross) * segmentWidth;
            const sy = (s / segmentsAcross | 0) * segmentHeight;
            const rows = tiled ? segmentHeight : Math.min(segmentHeight, height - sy);
            const expected = rows * segmentRowBytes;

            const bytes = await decompressSegment(segment(plane * segmentsPerPlane + s), compression, expected);
            if (fillOrder === 2) reverseBits(bytes);
            if (predictor === 2) undoHorizontalPredictor(bytes, segmentRowBytes, rows, samplesPerRow, bps, little);
            else if (predictor === 3) undoFloatingPointPredictor(bytes, segmentRowBytes, rows, samplesPerRow, bps);

            // copy rows, clipping tiles at the image edges
            const visibleRows = Math.min(rows, height - sy);
            const startBit = sx * samplesPerRow * bps;
            const copyBits = Math.min(segmentWidth, width - sx) * samplesPerRow * bps;

            for (let row = 0; row < visibleRows; row++) {
                const target = plane * planeBytes + (sy + row) * rowBytes;
                if (startBit % 8 === 0) {
                    const start = target + startBit / 8;
                    raw.set(bytes.subarray(row * segmentRowBytes, row * segmentRowBytes + Math.ceil(copyBits / 8)).subarray(0, rowBytes - startBit / 8), start);
                } else copyBitsUnaligned(bytes, row * segmentRowBytes * 8, raw, target * 8 + startBit, copyBits);
            }
        }
    }

    // read samples into RGBA
    // the floating point predictor reassembles samples as little endian
    const sampleLittle = predictor === 3 ? true : little;
    const readSample = sampleReader(raw, bps, sampleFormat, sampleLittle, sampleFormat === 3 ? floatRange(raw, bps, sampleLittle) : null);
    const sampleAt = planar
        ? (x: number, y: number, s: number) => readSample(s * planeBytes + y * rowBytes, x)
        : (x: number, y: number, s: number) => readSample(y * rowBytes, x * samplesPerPixel + s);

    const colormap = photometric === 3 ? values(TAGS.ColorMap, []) : [];
    if (photometric === 3 && colormap.length < 3 << bps) throw new Error('TIFF: missing color map');
    const ycc = photometric === 6 ? ycbcrConversion(values) : null;

    for (let y = 0, o = 0; y < height; y++) {
        for (let x = 0; x < width; x++, o += 4) {
            if (photometric === 3) {
                const index = sampleAt(x, y, 0).raw;
                const entries = 1 << bps;
                pixels[o] = colormap[index] >> 8;
                pixels[o + 1] = colormap[entries + index] >> 8;
                pixels[o + 2] = colormap[2 * entries + index] >> 8;
            } else if (photometric <= 1) {
                const v = sampleAt(x, y, 0).value;
                pixels[o] = pixels[o + 1] = pixels[o + 2] = photometric === 0 ? 255 - v : v;
            } else if (photometric === 2) {
                pixels[o] = sampleAt(x, y, 0).value;
                pixels[o + 1] = sampleAt(x, y, 1).value;
                pixels[o + 2] = sampleAt(x, y, 2).value;
            } else if (photometric === 5) {
                const k = sampleAt(x, y, 3).value;
                pixels[o] = cmykToRGB(sampleAt(x, y, 0).value, k);
                pixels[o + 1] = cmykToRGB(sampleAt(x, y, 1).value, k);
                pixels[o + 2] = cmykToRGB(sampleAt(x, y, 2).value, k);
            } else (ycc as YCbCrConverter)(sampleAt(x, y, 0).value, sampleAt(x, y, 1).value, sampleAt(x, y, 2).value, pixels, o);

            if (alphaChannel === -1) pixels[o + 3] = 0xff;
            else {
                const alpha = pixels[o + 3] = sampleAt(x, y, alphaChannel).value;
                // associated alpha is premultiplied
                if (alphaType === 1) {
                    for (let c = 0; c < 3; c++)
                        pixels[o + c] = alpha ? Math.min(255, Math.round(pixels[o + c] * 255 / alpha)) : 0;
                }
            }
        }
    }

    return { width, height, pixels, orientation };
}

// returns a function reading the n-th sample of a row as {raw, value} with value scaled to 8 bits
function sampleReader(raw: Uint8Array, bps: number, sampleFormat: number, little: boolean, range: [number, number] | null): SampleReader {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const result = { raw: 0, value: 0 };

    if (sampleFormat === 3) {
        const [min, max] = range || [0, 1];
        const scale = 255 / (max - min || 1);

        return (rowOffset, n) => {
            const v = bps === 32 ? view.getFloat32(rowOffset + n * 4, little) : view.getFloat64(rowOffset + n * 8, little);
            result.raw = v;
            result.value = v === v ? Math.min(255, Math.max(0, Math.round((v - min) * scale))) : 0;
            return result;
        };
    }

    const signed = sampleFormat === 2;
    const max = 2 ** bps - 1;

    if (bps === 8) {
        return (rowOffset, n) => {
            result.raw = raw[rowOffset + n];
            result.value = signed ? result.raw ^ 0x80 : result.raw;
            return result;
        };
    }

    if (bps === 16) {
        return (rowOffset, n) => {
            result.raw = view.getUint16(rowOffset + n * 2, little);
            result.value = (signed ? result.raw ^ 0x8000 : result.raw) >> 8;
            return result;
        };
    }

    if (bps === 32) {
        return (rowOffset, n) => {
            result.raw = view.getUint32(rowOffset + n * 4, little);
            result.value = (signed ? (result.raw ^ 0x80000000) >>> 0 : result.raw) >>> 24;
            return result;
        };
    }

    // arbitrary bit depths are packed MSB first
    return (rowOffset, n) => {
        let bit = rowOffset * 8 + n * bps;
        let v = 0;
        for (let remaining = bps; remaining > 0;) {
            const byte = raw[bit >> 3];
            const available = 8 - (bit & 7);
            const take = Math.min(available, remaining);
            v = v * (1 << take) + (byte >> available - take & (1 << take) - 1);
            bit += take;
            remaining -= take;
        }

        if (signed) v = (v + 2 ** (bps - 1)) % 2 ** bps;
        result.raw = v;
        result.value = bps === 1 ? v * 255 : Math.round(v * 255 / max);
        return result;
    };
}

// floats have no fixed range: [0, 1] and [0, 255] data is used as is, anything else is normalized to its min..max
function floatRange(raw: Uint8Array, bps: number, little: boolean): [number, number] {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const size = bps / 8;
    let min = Infinity, max = -Infinity;

    for (let o = 0; o + size <= raw.length; o += size) {
        const v = size === 4 ? view.getFloat32(o, little) : view.getFloat64(o, little);
        if (v < min) min = v;
        if (v > max) max = v;
    }

    if (min >= 0 && max <= 1) return [0, 1];
    if (min >= 0 && max <= 255) return [0, 255];
    return [min, max];
}

async function decompressSegment(bytes: Uint8Array, compression: number, expected: number): Promise<Uint8Array> {
    let out: Uint8Array;
    if (compression === 5) out = lzw(bytes, expected);
    else if (compression === 8 || compression === 32946) out = await decompressAsync(bytes, expected);
    else if (compression === 32773) out = packBits(bytes, expected);
    // uncompressed segments are views into the input, copy them as predictors and fill order are undone in place
    else out = bytes.slice(0, expected);

    if (out.length >= expected) return out.length === expected ? out : out.slice(0, expected);

    // short segments are padded with zeros
    const padded = new Uint8Array(expected);
    padded.set(out);
    return padded;
}

function lzw(input: Uint8Array, expected: number): Uint8Array {
    const out = new Uint8Array(expected);
    // pre-5.0 libtiff wrote LSB first codes without early change
    const compat = input[0] === 0 && (input[1] & 1) === 1;

    const prefix = new Uint16Array(4096);
    const suffix = new Uint8Array(4096);
    const first = new Uint8Array(4096);
    const lengths = new Uint16Array(4096);
    for (let i = 0; i < 256; i++) {
        suffix[i] = first[i] = i;
        lengths[i] = 1;
    }

    let codeSize = 9, next = 258, previous = -1;
    let buffer = 0, bits = 0, position = 0, written = 0;

    while (written < expected) {
        while (bits < codeSize) {
            if (position >= input.length) return out.subarray(0, written);
            buffer = compat ? buffer | input[position++] << bits : (buffer << 8 | input[position++]) & 0xffffff;
            bits += 8;
        }

        let code;
        if (compat) {
            code = buffer & (1 << codeSize) - 1;
            buffer >>>= codeSize;
        } else code = buffer >> bits - codeSize & (1 << codeSize) - 1;
        bits -= codeSize;

        if (code === 256) {
            codeSize = 9;
            next = 258;
            previous = -1;
            continue;
        }

        if (code === 257) break;

        let entry;
        if (previous === -1) {
            if (code > 255) break;
            entry = code;
        } else if (code < next) entry = code;
        else if (code === next) entry = previous;
        else break; // invalid code

        const length = lengths[entry];
        let c = entry;
        for (let i = written + length - 1; i >= written; i--) {
            if (i < expected) out[i] = suffix[c];
            c = prefix[c];
        }
        written += length;

        if (code === next && written < expected) out[written] = first[previous];
        if (code === next) written++;

        if (previous !== -1 && next < 4096) {
            prefix[next] = previous;
            suffix[next] = first[code === next ? previous : code];
            first[next] = first[previous];
            lengths[next] = lengths[previous] + 1;
            next++;
        }

        // new style LZW switches code size one code early
        if (next + (compat ? 0 : 1) >= 1 << codeSize && codeSize < 12) codeSize++;
        previous = code;
    }

    return out.subarray(0, Math.min(written, expected));
}

function packBits(input: Uint8Array, expected: number): Uint8Array {
    const out = new Uint8Array(expected);
    let i = 0, o = 0;

    while (i < input.length && o < expected) {
        const n = input[i++];

        if (n < 128) {
            const count = Math.min(n + 1, expected - o, input.length - i);
            out.set(input.subarray(i, i + count), o);
            i += n + 1;
            o += count;
        } else if (n > 128) {
            const count = Math.min(257 - n, expected - o);
            out.fill(input[i++], o, o + count);
            o += count;
        }
    }

    return out.subarray(0, o);
}

function reverseBits(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
        let b = bytes[i];
        b = (b & 0xf0) >> 4 | (b & 0x0f) << 4;
        b = (b & 0xcc) >> 2 | (b & 0x33) << 2;
        bytes[i] = (b & 0xaa) >> 1 | (b & 0x55) << 1;
    }
}

function undoHorizontalPredictor(bytes: Uint8Array, rowBytes: number, rows: number, samplesPerPixel: number, bps: number, little: boolean): void {
    if (bps === 8) {
        for (let r = 0; r < rows; r++)
            for (let i = r * rowBytes + samplesPerPixel, end = (r + 1) * rowBytes; i < end; i++)
                bytes[i] = bytes[i] + bytes[i - samplesPerPixel];
    } else if (bps === 16 || bps === 32) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const size = bps / 8;
        const get = size === 2 ? (o: number): number => view.getUint16(o, little) : (o: number): number => view.getUint32(o, little);
        const set = size === 2 ? (o: number, v: number): void => view.setUint16(o, v, little) : (o: number, v: number): void => view.setUint32(o, v >>> 0, little);
        const stride = samplesPerPixel * size;

        for (let r = 0; r < rows; r++)
            for (let o = r * rowBytes + stride, end = r * rowBytes + Math.floor(rowBytes / size) * size; o < end; o += size)
                set(o, get(o) + get(o - stride));
    } else throw new Error(`TIFF: horizontal predictor with ${bps}-bit samples is not supported`);
}

// floating point predictor: byte-wise differencing over byte planes (most significant first)
function undoFloatingPointPredictor(bytes: Uint8Array, rowBytes: number, rows: number, samplesPerPixel: number, bps: number): void {
    const size = bps / 8;
    const count = rowBytes / size;
    const tmp = new Uint8Array(rowBytes);

    for (let r = 0; r < rows; r++) {
        const row = bytes.subarray(r * rowBytes, (r + 1) * rowBytes);
        for (let i = samplesPerPixel; i < rowBytes; i++) row[i] = row[i] + row[i - samplesPerPixel];
        tmp.set(row);

        // reassemble the byte planes into little endian samples
        for (let n = 0; n < count; n++)
            for (let b = 0; b < size; b++)
                row[n * size + b] = tmp[(size - b - 1) * count + n];
    }
}

function copyBitsUnaligned(src: Uint8Array, srcBit: number, dst: Uint8Array, dstBit: number, count: number): void {
    for (let i = 0; i < count; i++, srcBit++, dstBit++) {
        const bit = src[srcBit >> 3] >> 7 - (srcBit & 7) & 1;
        if (bit) dst[dstBit >> 3] |= 0x80 >> (dstBit & 7);
        else dst[dstBit >> 3] &= ~(0x80 >> (dstBit & 7));
    }
}

function blitRGBA(src: Uint8Array, sw: number, sh: number, dst: Uint8Array, dw: number, dh: number, x0: number, y0: number): void {
    const w = Math.min(sw, dw - x0);
    for (let y = 0; y < sh && y0 + y < dh; y++)
        dst.set(src.subarray(y * sw * 4, (y * sw + w) * 4), ((y0 + y) * dw + x0) * 4);
}

type YCbCrConverter = (Y: number, Cb: number, Cr: number, out: Uint8Array, o: number) => void;

function ycbcrConversion(values: ValuesOf): YCbCrConverter {
    const [lr, lg, lb] = values(TAGS.YCbCrCoefficients, [0.299, 0.587, 0.114]);
    const reference = values(TAGS.ReferenceBlackWhite, [0, 255, 128, 255, 128, 255]);

    const scale = (v: number, black: number, white: number, center: boolean): number => (v - black) * (center ? 127 : 255) / (white - black || 1);

    return (Y: number, Cb: number, Cr: number, out: Uint8Array, o: number): void => {
        const y = scale(Y, reference[0], reference[1], false);
        const cb = scale(Cb, reference[2], reference[3], true);
        const cr = scale(Cr, reference[4], reference[5], true);

        const r = y + cr * (2 - 2 * lr);
        const b = y + cb * (2 - 2 * lb);
        const g = (y - lb * b - lr * r) / lg;

        out[o] = Math.min(255, Math.max(0, Math.round(r)));
        out[o + 1] = Math.min(255, Math.max(0, Math.round(g)));
        out[o + 2] = Math.min(255, Math.max(0, Math.round(b)));
    };
}

function ycbcrUnitsToRGBA(units: Uint8Array, width: number, height: number, h: number, v: number, convert: YCbCrConverter, pixels: Uint8Array): void {
    const unitsPerRow = Math.ceil(width / h);
    const unitSize = h * v + 2;

    for (let uy = 0; uy < Math.ceil(height / v); uy++)
        for (let ux = 0; ux < unitsPerRow; ux++) {
            const u = (uy * unitsPerRow + ux) * unitSize;
            const cb = units[u + h * v], cr = units[u + h * v + 1];

            for (let j = 0; j < v; j++)
                for (let i = 0; i < h; i++) {
                    const x = ux * h + i, y = uy * v + j;
                    if (x >= width || y >= height) continue;

                    const o = (y * width + x) * 4;
                    convert(units[u + j * h + i], cb, cr, pixels, o);
                    pixels[o + 3] = 0xff;
                }
        }
}

function cmykToRGB(c: number, k: number): number {
    const t = (255 - c) * k + 128;
    const v = 255 - (c + ((t >> 8) + t >> 8));
    return v < 0 ? 0 : v;
}

