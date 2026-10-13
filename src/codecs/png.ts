import { crc32 } from './crc.ts';
import { concat } from '../util/mem.ts';
import { encode as utf8 } from '../util/utf8.ts';
import { compress, decompressAsync } from './zlib.ts';

const HEAD = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const IHDR = 0x49484452;
const PLTE = 0x504c5445;
const tRNS = 0x74524e53;
const IDAT = 0x49444154;
const IEND = 0x49454e44;
const IEND_CRC = crc32(Uint8Array.of(73, 69, 78, 68));

const COLOR_TYPE_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CHANNELS_TO_COLOR_TYPE: Record<number, number> = { 1: 0, 2: 4, 3: 2, 4: 6 };
const VALID_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

export interface EncodeOptions {
    /** tEXt chunks, empty values are skipped */
    text?: Record<string, string | undefined>;
    width: number;
    height: number;
    channels: number;
    depth?: number;
    level?: number;
}

export interface Decoded {
    width: number;
    height: number;
    /** 8-bit RGBA */
    pixels: Uint8Array;
}

type Converter = (pixels: Uint8Array, rowBytes: number, w: number, h: number, out: Uint8Array, position: (x: number, y: number) => number) => void;

// [x start, y start, x step, y step] per adam7 pass
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];


/**
 * Encodes raw pixel data into a PNG
 * @param {Uint8Array} data Raw pixel data (8 bits per channel)
 * @param {{text?: Object<string, string>, width: number, height: number, channels: number, depth?: number, level?: number}} options
 * @return {Uint8Array}
 */
export function encode(data: Uint8Array, { text, width, height, channels, depth = 8, level = 0 }: EncodeOptions): Uint8Array {
    let offset = 0;
    let tmp_offset = 0;
    const row_length = width * channels;
    const tmp = new Uint8Array(height + data.length);

    while (offset < data.length) {
        tmp[tmp_offset++] = 0;
        tmp.set(data.subarray(offset, offset += row_length), tmp_offset);
        tmp_offset += row_length;
    }

    let textChunks: Uint8Array | null = null;
    if (text) {
        const chunks: Uint8Array[] = [];

        for (const key in text) {
            const value = text[key];
            if (!value) continue;

            const kb = utf8(key);
            const tb = utf8(value);
            const chunk = new Uint8Array(1 + 12 + kb.length + tb.length);
            const view = new DataView(chunk.buffer);

            chunk[4] = 0x74;
            chunk[5] = 0x45;
            chunk[6] = 0x58;
            chunk[7] = 0x74;
            chunk.set(kb, 8);
            chunk.set(tb, 9 + kb.length);
            view.setUint32(0, chunk.length - 12);
            view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
            chunks.push(chunk);
        }

        textChunks = concat(chunks);
    }

    offset = textChunks ? textChunks.length : 0;
    const compressed = compress(tmp, level);
    const array = new Uint8Array(49 + offset + HEAD.length + compressed.length);
    const view = new DataView(array.buffer);

    array.set(HEAD, 0);
    view.setUint32(8, 13);
    view.setUint32(12, IHDR);
    view.setUint32(16, width);
    view.setUint32(20, height);
    array[24] = depth;
    array[25] = CHANNELS_TO_COLOR_TYPE[channels];
    view.setUint32(29, crc32(new Uint8Array(array.buffer, 12, 17)));
    view.setUint32(33, compressed.length);
    view.setUint32(37, IDAT);
    array.set(compressed, 41);
    view.setUint32(41 + compressed.length, crc32(new Uint8Array(array.buffer, 37, 4 + compressed.length)));
    if (textChunks) array.set(textChunks, 45 + compressed.length);
    view.setUint32(45 + offset + compressed.length, 0);
    view.setUint32(49 + offset + compressed.length, IEND);
    view.setUint32(53 + offset + compressed.length, IEND_CRC);

    return array;
}

/**
 * Decodes a PNG into 8-bit RGBA pixel data
 * Supports all color types, bit depths, tRNS transparency and adam7 interlacing
 * @param {Uint8Array} array The PNG data
 * @return {{width: number, height: number, pixels: Uint8Array}}
 */
export async function decode(array: Uint8Array): Promise<Decoded> {
    const view = new DataView(array.buffer, array.byteOffset, array.byteLength);

    for (let i = 0; i < HEAD.length; i++)
        if (array[i] !== HEAD[i]) throw new Error('PNG: invalid signature');

    let header: { width: number, height: number, depth: number, colorType: number, interlace: number } | null = null;
    let palette: Uint8Array | null = null;
    let transparency: Uint8Array | null = null;
    const idat: Uint8Array[] = [];

    let offset = 8;
    while (offset + 8 <= array.length) {
        const length = view.getUint32(offset);
        const type = view.getUint32(offset + 4);
        const start = offset + 8;
        const end = start + length;

        if (end > array.length) {
            // tolerate truncated trailing chunks as long as we already have image data
            if (type === IDAT) idat.push(array.subarray(start));
            break;
        }

        const chunk = array.subarray(start, end);

        if (end + 4 <= array.length && crc32(array.subarray(offset + 4, end)) !== view.getUint32(end))
            throw new Error('PNG: chunk checksum mismatch');

        if (type === IHDR) {
            if (length < 13) throw new Error('PNG: invalid IHDR');
            header = {
                width: view.getUint32(start),
                height: view.getUint32(start + 4),
                depth: chunk[8],
                colorType: chunk[9],
                interlace: chunk[12]
            };
        } else if (type === PLTE) {
            if (palette) throw new Error('PNG: PLTE can only occur once in an image');
            palette = chunk;
        } else if (type === tRNS) {
            if (transparency) throw new Error('PNG: tRNS can only occur once in an image');
            transparency = chunk;
        } else if (type === IDAT) idat.push(chunk);
        else if (type === IEND) break;

        offset = end + 4;
    }

    if (!header) throw new Error('PNG: missing IHDR');
    if (!idat.length) throw new Error('PNG: missing IDAT');

    const { width, height, depth, colorType, interlace } = header;
    const channels = COLOR_TYPE_CHANNELS[colorType];
    if (!channels) throw new Error(`PNG: invalid color type ${colorType}`);
    if (!VALID_DEPTHS[colorType].includes(depth)) throw new Error(`PNG: invalid bit depth ${depth} for color type ${colorType}`);
    if (width === 0 || height === 0) throw new Error('PNG: invalid dimensions');
    if (colorType === 3 && !palette) throw new Error('PNG: indexed color image has no PLTE');

    const bitsPerPixel = channels * depth;
    const bpp = Math.max(1, bitsPerPixel >> 3);
    const passes = interlace ? ADAM7.map(([xs, ys, dx, dy]) => [xs, ys, dx, dy, Math.ceil((width - xs) / dx), Math.ceil((height - ys) / dy)]) : [[0, 0, 1, 1, width, height]];

    let expected = 0;
    for (const pass of passes) {
        const [, , , , pw, ph] = pass;
        if (pw > 0 && ph > 0) expected += ph * (1 + Math.ceil(pw * bitsPerPixel / 8));
    }

    const data = await decompressAsync(idat.length === 1 ? idat[0] : concat(idat), expected);
    if (data.length < expected) throw new Error('PNG: image data is truncated');

    const rgba = new Uint8Array(width * height * 4);
    const toRGBA = createConverter(colorType, depth, palette, transparency);

    let dataOffset = 0;
    for (const [xs, ys, dx, dy, pw, ph] of passes) {
        if (pw <= 0 || ph <= 0) continue;

        const rowBytes = Math.ceil(pw * bitsPerPixel / 8);
        const size = ph * rowBytes;
        const pixels = unfilter(data, dataOffset, ph, rowBytes, bpp);
        dataOffset += size + ph;

        toRGBA(pixels, rowBytes, pw, ph, rgba, (x, y) => ((ys + y * dy) * width + xs + x * dx) * 4);
    }

    return { width, height, pixels: rgba };
}

function unfilter(data: Uint8Array, offset: number, height: number, rowBytes: number, bpp: number): Uint8Array {
    const out = new Uint8Array(height * rowBytes);

    for (let y = 0; y < height; y++) {
        const filter = data[offset++];
        const row = y * rowBytes;
        const prev = row - rowBytes;

        if (filter === 0) out.set(data.subarray(offset, offset + rowBytes), row);
        else if (filter === 1) {
            for (let i = 0; i < rowBytes; i++)
                out[row + i] = data[offset + i] + (i >= bpp ? out[row + i - bpp] : 0);
        } else if (filter === 2) {
            if (y === 0) out.set(data.subarray(offset, offset + rowBytes), row);
            else for (let i = 0; i < rowBytes; i++)
                out[row + i] = data[offset + i] + out[prev + i];
        } else if (filter === 3) {
            for (let i = 0; i < rowBytes; i++) {
                const a = i >= bpp ? out[row + i - bpp] : 0;
                const b = y > 0 ? out[prev + i] : 0;
                out[row + i] = data[offset + i] + ((a + b) >> 1);
            }
        } else if (filter === 4) {
            for (let i = 0; i < rowBytes; i++) {
                const a = i >= bpp ? out[row + i - bpp] : 0;
                const b = y > 0 ? out[prev + i] : 0;
                const c = i >= bpp && y > 0 ? out[prev + i - bpp] : 0;
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                out[row + i] = data[offset + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            }
        } else throw new Error(`PNG: invalid filter type ${filter}`);

        offset += rowBytes;
    }

    return out;
}

function createConverter(colorType: number, depth: number, palette: Uint8Array | null, transparency: Uint8Array | null): Converter {
    const maxValue = (1 << depth) - 1;

    // reads the n-th sample of a row; samples of depth < 8 are packed MSB first
    const sample: (row: Uint8Array, n: number) => number = depth === 8 ? (row, n) => row[n]
        : depth === 16 ? (row, n) => row[n * 2] << 8 | row[n * 2 + 1]
            : (row, n) => {
                const bit = n * depth;
                return (row[bit >> 3] >> (8 - depth - (bit & 7))) & maxValue;
            };

    // scales a raw sample to 8 bits
    const scale: (v: number) => number = depth === 8 ? v => v : depth === 16 ? v => v >> 8 : v => Math.round(v * 255 / maxValue);

    if (colorType === 3) {
        const pal = palette as Uint8Array;
        const entries = pal.length / 3 | 0;
        const lut = new Uint8Array(256 * 4);

        for (let i = 0; i < 256; i++) {
            if (i < entries) {
                lut[i * 4] = pal[i * 3];
                lut[i * 4 + 1] = pal[i * 3 + 1];
                lut[i * 4 + 2] = pal[i * 3 + 2];
            }

            lut[i * 4 + 3] = transparency && i < transparency.length ? transparency[i] : 0xff;
        }

        return (pixels, rowBytes, w, h, out, position) => {
            for (let y = 0; y < h; y++) {
                const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

                for (let x = 0; x < w; x++) {
                    const o = position(x, y);
                    const i = sample(row, x) * 4;
                    out[o] = lut[i];
                    out[o + 1] = lut[i + 1];
                    out[o + 2] = lut[i + 2];
                    out[o + 3] = lut[i + 3];
                }
            }
        };
    }

    if (colorType === 0) {
        const key = transparency && transparency.length >= 2 ? (transparency[0] << 8 | transparency[1]) & maxValue : -1;

        return (pixels, rowBytes, w, h, out, position) => {
            for (let y = 0; y < h; y++) {
                const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

                for (let x = 0; x < w; x++) {
                    const o = position(x, y);
                    const raw = sample(row, x);
                    const v = scale(raw);
                    out[o] = out[o + 1] = out[o + 2] = v;
                    out[o + 3] = raw === key ? 0 : 0xff;
                }
            }
        };
    }

    if (colorType === 2) {
        const key = transparency && transparency.length >= 6
            ? [transparency[0] << 8 | transparency[1], transparency[2] << 8 | transparency[3], transparency[4] << 8 | transparency[5]].map(v => v & maxValue)
            : null;

        return (pixels, rowBytes, w, h, out, position) => {
            for (let y = 0; y < h; y++) {
                const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

                for (let x = 0; x < w; x++) {
                    const o = position(x, y);
                    const r = sample(row, x * 3);
                    const g = sample(row, x * 3 + 1);
                    const b = sample(row, x * 3 + 2);
                    out[o] = scale(r);
                    out[o + 1] = scale(g);
                    out[o + 2] = scale(b);
                    out[o + 3] = key && r === key[0] && g === key[1] && b === key[2] ? 0 : 0xff;
                }
            }
        };
    }

    if (colorType === 4) {
        return (pixels, rowBytes, w, h, out, position) => {
            for (let y = 0; y < h; y++) {
                const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

                for (let x = 0; x < w; x++) {
                    const o = position(x, y);
                    const v = scale(sample(row, x * 2));
                    out[o] = out[o + 1] = out[o + 2] = v;
                    out[o + 3] = scale(sample(row, x * 2 + 1));
                }
            }
        };
    }

    // colorType === 6
    if (depth === 8) {
        return (pixels, rowBytes, w, h, out, position) => {
            // non-interlaced 8-bit RGBA maps 1:1 onto the output
            if (position(1, 0) === 4 && w * 4 === rowBytes && position(0, 1) === rowBytes) return out.set(pixels);

            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++)
                    out.set(pixels.subarray(y * rowBytes + x * 4, y * rowBytes + x * 4 + 4), position(x, y));
        };
    }

    return (pixels, rowBytes, w, h, out, position) => {
        for (let y = 0; y < h; y++) {
            const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

            for (let x = 0; x < w; x++) {
                const o = position(x, y);
                out[o] = scale(sample(row, x * 4));
                out[o + 1] = scale(sample(row, x * 4 + 1));
                out[o + 2] = scale(sample(row, x * 4 + 2));
                out[o + 3] = scale(sample(row, x * 4 + 3));
            }
        }
    };
}

