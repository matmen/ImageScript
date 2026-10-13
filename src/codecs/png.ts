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
    /** packed RGB palette, makes the data palette indices (1 channel) */
    palette?: Uint8Array;
    /** alpha per palette entry */
    transparency?: Uint8Array;
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
 * @param data Raw pixel data, rows packed MSB first for depths below 8
 */
export function encode(data: Uint8Array, { text, width, height, channels, depth = 8, level = 0, palette, transparency }: EncodeOptions): Uint8Array {
    // prefix every row with filter type 0 (none)
    const rowBytes = Math.ceil(width * channels * depth / 8);
    const filtered = new Uint8Array(height * (rowBytes + 1));
    for (let y = 0; y < height; y++) filtered.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);

    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = depth;
    header[9] = palette ? 3 : CHANNELS_TO_COLOR_TYPE[channels];

    const chunks = [chunk(IHDR, header)];
    if (palette) chunks.push(chunk(PLTE, palette));
    if (transparency) chunks.push(chunk(tRNS, transparency));
    chunks.push(chunk(IDAT, compress(filtered, level)));

    for (const key in text) {
        const value = text[key];
        if (!value) continue;
        chunks.push(chunk(0x74455874, concat([utf8(key), [0], utf8(value)])));
    }

    chunks.push(chunk(IEND, new Uint8Array(0)));
    return concat([HEAD, ...chunks]);
}

function chunk(type: number, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(body.length + 12);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    view.setUint32(4, type);
    out.set(body, 8);
    view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
    return out;
}

/**
 * Encodes 8-bit RGBA pixels into a PNG with the smallest lossless color type:
 * a palette for up to 256 colors, otherwise greyscale or RGB, with alpha only if a pixel isn't opaque
 */
export function encodeRGBA(rgba: Uint8Array, width: number, height: number, level: number, text?: EncodeOptions['text']): Uint8Array {
    const count = width * height;
    if (rgba.byteOffset % 4) rgba = rgba.slice(0, count * 4);
    const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, count);
    let opaque = true, grey = true;

    // collect up to 257 distinct colors, runs of equal pixels are skipped cheaply
    let colors: Map<number, number> | null = new Map();
    let previous = -1;
    for (let i = 0; i < count; i++) {
        const value = pixels[i];
        if (value === previous) continue;
        previous = value;

        const o = i * 4;
        if (rgba[o + 3] !== 255) opaque = false;
        if (rgba[o] !== rgba[o + 1] || rgba[o] !== rgba[o + 2]) grey = false;
        if (colors && !colors.has(value)) {
            if (colors.size === 256) colors = null;
            else colors.set(value, colors.size);
        }
    }

    const options = { width, height, level, text };

    if (colors) {
        // opaque entries are moved to the end, so tRNS can be cut short
        const entries = [...colors.keys()].map(value => new Uint8Array(new Uint32Array([value]).buffer));
        entries.sort((a, b) => a[3] - b[3]);
        const index = new Map<number, number>();
        entries.forEach((bytes, i) => index.set(new Uint32Array(bytes.buffer)[0], i));

        const palette = new Uint8Array(entries.length * 3);
        entries.forEach((bytes, i) => palette.set(bytes.subarray(0, 3), i * 3));
        const translucent = entries.filter(bytes => bytes[3] !== 255).length;
        const transparency = translucent ? Uint8Array.from(entries.slice(0, translucent), bytes => bytes[3]) : undefined;

        const depth = entries.length <= 2 ? 1 : entries.length <= 4 ? 2 : entries.length <= 16 ? 4 : 8;
        const rowBytes = Math.ceil(width * depth / 8);
        const perByte = 8 / depth;
        const data = new Uint8Array(rowBytes * height);

        let last = -1, lastIndex = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const value = pixels[y * width + x];
                if (value !== last) {
                    last = value;
                    lastIndex = index.get(value) as number;
                }
                data[y * rowBytes + (x / perByte | 0)] |= lastIndex << (8 - depth - (x % perByte) * depth);
            }
        }

        return encode(data, { ...options, channels: 1, depth, palette, transparency });
    }

    const channels = (grey ? 1 : 3) + (opaque ? 0 : 1);
    if (channels === 4) return encode(rgba, { ...options, channels });

    const data = new Uint8Array(count * channels);
    for (let i = 0, o = 0; i < count; i++) {
        const s = i * 4;
        if (grey) data[o++] = rgba[s];
        else {
            data[o++] = rgba[s];
            data[o++] = rgba[s + 1];
            data[o++] = rgba[s + 2];
        }
        if (!opaque) data[o++] = rgba[s + 3];
    }

    return encode(data, { ...options, channels });
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

