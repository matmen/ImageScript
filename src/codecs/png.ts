import { crc32 } from './crc.ts';
import { concat } from '../util/mem.ts';
import { encode as utf8, decode as utf8Decode } from '../util/utf8.ts';
import { orientation as exifOrientation, xmpOrientation } from './exif.ts';
import { compressAsync, decompressAsync } from './zlib.ts';

const HEAD = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const IHDR = 0x49484452;
const PLTE = 0x504c5445;
const tRNS = 0x74524e53;
const IDAT = 0x49444154;
const IEND = 0x49454e44;
const eXIf = 0x65584966;
const tEXt = 0x74455874;
const zTXt = 0x7a545874;
const iTXt = 0x69545874;
const acTL = 0x6163544c;
const fcTL = 0x6663544c;
const fdAT = 0x66644154;

const COLOR_TYPE_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CHANNELS_TO_COLOR_TYPE: Record<number, number> = { 1: 0, 2: 4, 3: 2, 4: 6 };
const VALID_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

export interface EncodeOptions {
    /** text chunks, empty values are skipped */
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
    /** whether to paeth filter the rows (pays off for truecolor and greyscale images) */
    filter?: boolean;
}

export interface Decoded {
    width: number;
    height: number;
    /** 8-bit RGBA */
    pixels: Uint8Array;
    /** Exif orientation (1-8) */
    orientation: number;
}

// where the pixels of an (interlacing) pass go: output offset of the pass' row y, and the step between its pixels
interface Placement {
    row: (y: number) => number;
    step: number;
}

type Converter = (pixels: Uint8Array, rowBytes: number, w: number, h: number, out: Uint8Array, place: Placement) => void;

// [x start, y start, x step, y step] per adam7 pass
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];


/**
 * Encodes raw pixel data into a PNG
 * @param data Raw pixel data, rows packed MSB first for depths below 8
 */
export async function encode(data: Uint8Array, { text, width, height, channels, depth = 8, level = 0, palette, transparency, filter: filterRows = false }: EncodeOptions): Promise<Uint8Array> {
    const rowBytes = Math.ceil(width * channels * depth / 8);
    let filtered: Uint8Array;
    if (filterRows) filtered = filter(data, rowBytes, height, Math.max(1, channels * depth / 8));
    else {
        // prefix every row with filter type 0 (none)
        filtered = new Uint8Array(height * (rowBytes + 1));
        for (let y = 0; y < height; y++) filtered.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
    }

    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = depth;
    header[9] = palette ? 3 : CHANNELS_TO_COLOR_TYPE[channels];

    const chunks = [chunk(IHDR, header)];
    if (palette) chunks.push(chunk(PLTE, palette));
    if (transparency) chunks.push(chunk(tRNS, transparency));
    chunks.push(...textChunks(text));
    chunks.push(chunk(IDAT, await compressAsync(filtered, level)));

    chunks.push(chunk(IEND, new Uint8Array(0)));
    return concat([HEAD, ...chunks]);
}

// text chunks (before the image data, where all readers find them), empty values are skipped: tEXt holds Latin-1,
// other text goes into an (uncompressed) iTXt as UTF-8
function textChunks(text: EncodeOptions['text']): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    const latin1 = (s: string): number[] => Array.from(s, c => c.charCodeAt(0));
    for (const key in text) {
        const value = text[key];
        if (!value) continue;
        if (/^[\x00-\xff]*$/.test(value)) chunks.push(chunk(tEXt, concat([latin1(key), [0], latin1(value)])));
        else chunks.push(chunk(iTXt, concat([latin1(key), [0, 0, 0, 0, 0], utf8(value)])));
    }
    return chunks;
}

/**
 * Filters every row with the paeth filter. Picking a filter per row (libpng's heuristic) costs twice as much and
 * compresses within 0.1% of it for photos, graphics and gradients alike
 */
function filter(data: Uint8Array, rowBytes: number, height: number, bpp: number): Uint8Array {
    const out = new Uint8Array(height * (rowBytes + 1));

    for (let y = 0; y < height; y++) {
        const row = y * rowBytes, o = y * (rowBytes + 1) + 1;
        out[o - 1] = 4;

        // the first row has no row above, the first pixel of every row no left neighbour
        if (y === 0) {
            for (let i = 0; i < rowBytes; i++) out[o + i] = data[row + i] - (i >= bpp ? data[row + i - bpp] : 0);
            continue;
        }

        for (let i = 0; i < bpp; i++) out[o + i] = data[row + i] - data[row + i - rowBytes];
        for (let i = bpp; i < rowBytes; i++) {
            const a = data[row + i - bpp], b = data[row + i - rowBytes], c = data[row + i - rowBytes - bpp];
            const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
            out[o + i] = data[row + i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
    }

    return out;
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

interface PixelFormat {
    channels: number;
    depth: number;
    palette?: Uint8Array;
    transparency?: Uint8Array;
    /** converts RGBA pixels to this format's packed rows */
    convert(rgba: Uint8Array, width: number, height: number): Uint8Array;
}

/**
 * Picks the smallest lossless format that fits all the given RGBA images: a palette for up to 256 colors,
 * otherwise greyscale or RGB, with alpha only if a pixel isn't opaque
 */
/**
 * How much more an opaque image costs per pixel with transparent pixels than without them, given the pixel formats
 * (palette, grey or truecolor) both get: e.g. 4/3 for RGBA instead of RGB, 4 for RGBA instead of a palette when the
 * transparent pixels are the 257th color, 2 for 8 instead of 4 bit palette indices when they're the 17th
 * @param images RGBA, only the transparent pixels aren't opaque
 */
export function alphaCost(images: Uint8Array[]): number {
    let grey = true;
    const colors = new Set<number>();
    // more than 256 colors and not grey: truecolor either way, nothing else can change
    scan: for (const rgba of images) {
        const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
        let previous = -1;
        for (let i = 0; i < pixels.length; i++) {
            const value = pixels[i];
            if (value === previous) continue;
            previous = value;
            const o = i * 4;
            if (rgba[o + 3] === 0) continue;
            if (rgba[o] !== rgba[o + 1] || rgba[o] !== rgba[o + 2]) grey = false;
            if (colors.size <= 256) colors.add(value);
            else if (!grey) break scan;
        }
    }
    // bytes per pixel: palette 1/8 to 1 (by its bit depth), grey 1 (with alpha 2), truecolor 3 (with alpha 4)
    const palette = (entries: number): number => (entries <= 2 ? 1 : entries <= 4 ? 2 : entries <= 16 ? 4 : 8) / 8;
    const transparent = colors.size < 256 ? palette(colors.size + 1) : grey ? 2 : 4;
    const opaque = colors.size <= 256 ? palette(colors.size) : grey ? 1 : 3;
    return transparent / opaque;
}

function pixelFormat(images: Uint8Array[]): PixelFormat {
    let opaque = true, grey = true;

    // collect up to 257 distinct colors, runs of equal pixels are skipped cheaply
    let colors: Map<number, number> | null = new Map();
    for (const rgba of images) {
        const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
        let previous = -1;
        for (let i = 0; i < pixels.length; i++) {
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
    }

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

        return {
            channels: 1, depth, palette, transparency,
            convert(rgba, width, height) {
                const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
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
                return data;
            }
        };
    }

    const channels = (grey ? 1 : 3) + (opaque ? 0 : 1);
    return {
        channels, depth: 8,
        convert(rgba, width, height) {
            if (channels === 4) return rgba;
            const count = width * height;
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
            return data;
        }
    };
}

// 4-byte aligned copy if needed (pixel analysis reads 32-bit words)
const aligned = (rgba: Uint8Array): Uint8Array => rgba.byteOffset % 4 ? rgba.slice() : rgba;

/**
 * Encodes 8-bit RGBA pixels into a PNG with the smallest lossless color type (see {@link pixelFormat}).
 * Rows of non-palette images are paeth filtered (unless the data isn't compressed), palette indices aren't
 * filtered (like libpng recommends)
 */
export async function encodeRGBA(rgba: Uint8Array, width: number, height: number, level: number, text?: EncodeOptions['text']): Promise<Uint8Array> {
    rgba = aligned(rgba.subarray(0, width * height * 4));
    const format = pixelFormat([rgba]);
    const { channels, depth, palette, transparency } = format;
    return encode(format.convert(rgba, width, height), { width, height, level, text, channels, depth, palette, transparency, filter: level > 0 && !palette });
}

// filters (or just prefixes) the rows and compresses them
async function compressRows(data: Uint8Array, width: number, height: number, channels: number, depth: number, level: number, filterRows: boolean): Promise<Uint8Array> {
    const rowBytes = Math.ceil(width * channels * depth / 8);
    let filtered: Uint8Array;
    if (filterRows) filtered = filter(data, rowBytes, height, Math.max(1, channels * depth / 8));
    else {
        filtered = new Uint8Array(height * (rowBytes + 1));
        for (let y = 0; y < height; y++) filtered.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
    }
    return compressAsync(filtered, level);
}

export interface APNGEncodeFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    /** milliseconds (stored as a fraction of up to 65535/65535 seconds) */
    duration: number;
    /** 0 none, 1 background (transparent), 2 previous */
    dispose: number;
    /** whether the frame is alpha blended onto the canvas, otherwise it replaces its area. Default: true */
    blend?: boolean;
    /** RGBA */
    pixels: Uint8Array;
}

/**
 * Encodes frames into an APNG. Frames are alpha blended onto the canvas ("over"); the first frame is also the
 * default image that viewers without APNG support show
 * @param plays How often to play the animation, 0 = forever
 * @param text tEXt chunks, empty values are skipped
 */
export async function encodeAnimation(frames: APNGEncodeFrame[], width: number, height: number, plays: number, level: number, text?: EncodeOptions['text']): Promise<Uint8Array> {
    if (!frames.length) throw new Error('PNG: an animation needs at least one frame');

    // the default image has to cover the whole canvas: pad the first frame if needed
    const first = frames[0];
    if (first.x !== 0 || first.y !== 0 || first.width !== width || first.height !== height) {
        const pixels = new Uint8Array(width * height * 4);
        for (let y = 0; y < first.height && first.y + y < height; y++) {
            const row = first.pixels.subarray(y * first.width * 4, (y * first.width + Math.min(first.width, width - first.x)) * 4);
            pixels.set(row, ((first.y + y) * width + first.x) * 4);
        }
        frames = [{ ...first, x: 0, y: 0, width, height, pixels }, ...frames.slice(1)];
    }

    for (const f of frames)
        if (f.x < 0 || f.y < 0 || f.x + f.width > width || f.y + f.height > height || !f.width || !f.height)
            throw new RangeError('PNG: APNG frames have to lie within the canvas');

    const images = frames.map(f => aligned(f.pixels.subarray(0, f.width * f.height * 4)));
    const format = pixelFormat(images);
    const { channels, depth, palette, transparency } = format;
    const filterRows = level > 0 && !palette;

    const header = new Uint8Array(13);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    header[8] = depth;
    header[9] = palette ? 3 : CHANNELS_TO_COLOR_TYPE[channels];

    const actl = new Uint8Array(8);
    new DataView(actl.buffer).setUint32(0, frames.length);
    new DataView(actl.buffer).setUint32(4, plays);

    const chunks = [chunk(IHDR, header), chunk(acTL, actl)];
    if (palette) chunks.push(chunk(PLTE, palette));
    if (transparency) chunks.push(chunk(tRNS, transparency));
    chunks.push(...textChunks(text));

    let sequence = 0;
    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const fctl = new Uint8Array(26);
        const v = new DataView(fctl.buffer);
        v.setUint32(0, sequence++);
        v.setUint32(4, f.width);
        v.setUint32(8, f.height);
        v.setUint32(12, f.x);
        v.setUint32(16, f.y);
        // milliseconds as num/1000 where they fit, otherwise centiseconds
        const ms = Math.max(0, Math.round(f.duration));
        if (ms <= 65535) { v.setUint16(20, ms); v.setUint16(22, 1000); }
        else { v.setUint16(20, Math.min(65535, Math.round(ms / 10))); v.setUint16(22, 100); }
        fctl[24] = f.dispose;
        fctl[25] = f.blend === false ? 0 : 1; // APNG_BLEND_OP_SOURCE or APNG_BLEND_OP_OVER
        chunks.push(chunk(fcTL, fctl));

        const data = await compressRows(format.convert(images[i], f.width, f.height), f.width, f.height, channels, depth, level, filterRows);
        if (i === 0) chunks.push(chunk(IDAT, data));
        else {
            const body = new Uint8Array(data.length + 4);
            new DataView(body.buffer).setUint32(0, sequence++);
            body.set(data, 4);
            chunks.push(chunk(fdAT, body));
        }
    }

    chunks.push(chunk(IEND, new Uint8Array(0)));
    return concat([HEAD, ...chunks]);
}

interface PNGHeader {
    width: number;
    height: number;
    depth: number;
    colorType: number;
    interlace: number;
}

interface APNGFrameControl {
    width: number;
    height: number;
    x: number;
    y: number;
    /** milliseconds */
    delay: number;
    dispose: number;
    blend: number;
}

interface Parsed {
    header: PNGHeader;
    palette: Uint8Array | null;
    transparency: Uint8Array | null;
    idat: Uint8Array[];
    exif: Uint8Array | null;
    text: Array<{ type: number, chunk: Uint8Array }>;
    /** set for APNGs: number of frames and plays (0 = forever) */
    animation: { frames: number, plays: number } | null;
    /** APNG frames, with their zlib data; the IDAT is the first frame if it has a fcTL */
    frames: Array<{ control: APNGFrameControl, data: Uint8Array[] }>;
    /** set if the animation is broken, which makes decoders fall back to the default image */
    animationError: boolean;
}

function parse(array: Uint8Array): Parsed {
    const view = new DataView(array.buffer, array.byteOffset, array.byteLength);

    for (let i = 0; i < HEAD.length; i++)
        if (array[i] !== HEAD[i]) throw new Error('PNG: invalid signature');

    let header: PNGHeader | null = null;
    let palette: Uint8Array | null = null;
    let transparency: Uint8Array | null = null;
    const idat: Uint8Array[] = [];
    let exif: Uint8Array | null = null;
    const text: Array<{ type: number, chunk: Uint8Array }> = [];
    let animation: Parsed['animation'] = null;
    const frames: Parsed['frames'] = [];
    let current: Parsed['frames'][number] | null = null;
    let sequence = 0;
    let animationError = false;

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
        } else if (type === IDAT) {
            idat.push(chunk);
            // the default image is the first frame if a fcTL came before it
            if (current && !frames.length) frames.push(current);
        } else if (type === acTL) {
            // only one acTL, before the image data
            if (animation || idat.length || length < 8) animationError = true;
            else animation = { frames: view.getUint32(start), plays: view.getUint32(start + 4) };
        } else if (type === fcTL) {
            // (a fcTL before the acTL is tolerated, like browsers do)
            if (length < 26 || view.getUint32(start) !== sequence++) animationError = true;
            if (animationError) { offset = end + 4; continue; }
            const num = view.getUint16(start + 20), den = view.getUint16(start + 22) || 100;
            current = {
                control: {
                    width: view.getUint32(start + 4),
                    height: view.getUint32(start + 8),
                    x: view.getUint32(start + 12),
                    y: view.getUint32(start + 16),
                    delay: num * 1000 / den,
                    dispose: chunk[24],
                    blend: chunk[25]
                },
                data: idat.length ? [] : idat
            };
            if (idat.length) frames.push(current);
        } else if (type === fdAT) {
            if (length < 4 || view.getUint32(start) !== sequence++ || !current || current.data === idat) animationError = true;
            else current.data.push(chunk.subarray(4));
        } else if (type === eXIf) exif ??= chunk;
        else if (type === tEXt || type === zTXt || type === iTXt) text.push({ type, chunk });
        else if (type === IEND) break;

        offset = end + 4;
    }

    if (!header) throw new Error('PNG: missing IHDR');
    if (!idat.length) throw new Error('PNG: missing IDAT');

    const { width, height, depth, colorType } = header;
    const channels = COLOR_TYPE_CHANNELS[colorType];
    if (!channels) throw new Error(`PNG: invalid color type ${colorType}`);
    if (!VALID_DEPTHS[colorType].includes(depth)) throw new Error(`PNG: invalid bit depth ${depth} for color type ${colorType}`);
    if (width === 0 || height === 0) throw new Error('PNG: invalid dimensions');
    if (colorType === 3 && !palette) throw new Error('PNG: indexed color image has no PLTE');

    // more frames than announced are ignored; fewer (or none) make the animation invalid
    if (animation) {
        if (frames.length > animation.frames) frames.length = animation.frames;
        if (!frames.length || frames.length < animation.frames || frames.some(f => !f.data.length)) animationError = true;
    }
    return { header, palette, transparency, idat, exif, text, animation, frames, animationError };
}

// inflates and converts one image (the default image or an APNG frame) to RGBA
async function decodeImageData(p: Parsed, chunks: Uint8Array[], width: number, height: number): Promise<Uint8Array> {
    const { depth, colorType, interlace } = p.header;
    const channels = COLOR_TYPE_CHANNELS[colorType];
    const bitsPerPixel = channels * depth;
    const bpp = Math.max(1, bitsPerPixel >> 3);
    const passes = interlace ? ADAM7.map(([xs, ys, dx, dy]) => [xs, ys, dx, dy, Math.ceil((width - xs) / dx), Math.ceil((height - ys) / dy)]) : [[0, 0, 1, 1, width, height]];

    let expected = 0;
    for (const pass of passes) {
        const [, , , , pw, ph] = pass;
        if (pw > 0 && ph > 0) expected += ph * (1 + Math.ceil(pw * bitsPerPixel / 8));
    }

    if (!chunks.length) throw new Error('PNG: missing image data');
    const data = await decompressAsync(chunks.length === 1 ? chunks[0] : concat(chunks), expected);
    if (data.length < expected) throw new Error('PNG: image data is truncated');

    const rgba = new Uint8Array(width * height * 4);
    const toRGBA = createConverter(colorType, depth, p.palette, p.transparency);

    let dataOffset = 0;
    for (const [xs, ys, dx, dy, pw, ph] of passes) {
        if (pw <= 0 || ph <= 0) continue;

        const rowBytes = Math.ceil(pw * bitsPerPixel / 8);
        const size = ph * rowBytes;
        const pixels = unfilter(data, dataOffset, ph, rowBytes, bpp);
        dataOffset += size + ph;

        toRGBA(pixels, rowBytes, pw, ph, rgba, { row: y => ((ys + y * dy) * width + xs) * 4, step: dx * 4 });
    }

    return rgba;
}

/**
 * Decodes a PNG into 8-bit RGBA pixel data (for APNGs, the default image)
 * Supports all color types, bit depths, tRNS transparency and adam7 interlacing
 * The orientation comes from the eXIf chunk, or, if there is none, from the Exif text ImageMagick wrote before eXIf
 * existed ("Raw profile type exif") or from the XMP packet
 */
export async function decode(array: Uint8Array): Promise<Decoded> {
    const p = parse(array);
    const { width, height } = p.header;
    const pixels = await decodeImageData(p, p.idat, width, height);
    return { width, height, pixels, orientation: p.exif ? exifOrientation(p.exif) : await textOrientation(p.text) };
}

export interface APNGFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    /** milliseconds */
    duration: number;
    /** 0 none, 1 background (transparent), 2 previous */
    dispose: number;
    /** 0 source (replace), 1 over */
    blend: number;
    pixels: Uint8Array;
}

/** Whether the PNG is an APNG (has an acTL chunk) */
export function isAnimated(array: Uint8Array): boolean {
    try {
        const p = parse(array);
        return p.animation !== null && !p.animationError;
    } catch {
        return false;
    }
}

/**
 * Decodes an APNG (https://wiki.mozilla.org/APNG_Specification) into its (uncomposited) frames; a plain PNG becomes
 * a single frame
 * @return plays: 0 = forever
 */
export async function decodeAnimation(array: Uint8Array, onlyFirstFrame = false): Promise<{ width: number, height: number, plays: number, frames: APNGFrame[] }> {
    const p = parse(array);
    const { width, height } = p.header;

    // broken animations show the default image, like browsers do
    if (!p.animation || p.animationError) {
        const pixels = await decodeImageData(p, p.idat, width, height);
        return { width, height, plays: 0, frames: [{ x: 0, y: 0, width, height, duration: 0, dispose: 0, blend: 0, pixels }] };
    }

    const frames: APNGFrame[] = [];
    for (const { control: c, data } of p.frames) {
        if (!c.width || !c.height || c.x + c.width > width || c.y + c.height > height) throw new Error('PNG: invalid APNG frame region');
        frames.push({
            x: c.x, y: c.y, width: c.width, height: c.height, duration: c.delay,
            // DISPOSE_OP_PREVIOUS on the first frame means background
            dispose: !frames.length && c.dispose === 2 ? 1 : c.dispose,
            blend: c.blend,
            pixels: await decodeImageData(p, data, c.width, c.height)
        });
        if (onlyFirstFrame) break;
    }

    return { width, height, plays: p.animation.plays, frames };
}

/**
 * Composites APNG frames onto the canvas, as the APNG specification describes (the integer "over" operation of its
 * blend_op section, https://wiki.mozilla.org/APNG_Specification)
 */
export function compositeAnimation({ width, height, frames }: { width: number, height: number, frames: APNGFrame[] }): Array<{ pixels: Uint8Array, duration: number }> {
    const canvas = new Uint8Array(width * height * 4);
    const output = [];

    for (const f of frames) {
        const previous = f.dispose === 2 ? canvas.slice() : null;

        for (let y = 0; y < f.height; y++)
            for (let x = 0; x < f.width; x++) {
                const s = (y * f.width + x) * 4, d = ((f.y + y) * width + f.x + x) * 4;
                const sa = f.pixels[s + 3], da = canvas[d + 3];
                if (f.blend === 0 || sa === 255 || da === 0) {
                    if (f.blend === 0 || sa !== 0) canvas.set(f.pixels.subarray(s, s + 4), d);
                } else if (sa !== 0) {
                    const u = sa * 255, v = (255 - sa) * da, al = u + v;
                    for (let c = 0; c < 3; c++) canvas[d + c] = (f.pixels[s + c] * u + canvas[d + c] * v) / al | 0;
                    canvas[d + 3] = al / 255 | 0;
                }
            }

        output.push({ pixels: canvas.slice(), duration: f.duration });

        if (f.dispose === 1)
            for (let y = 0; y < f.height; y++) canvas.fill(0, ((f.y + y) * width + f.x) * 4, ((f.y + y) * width + f.x + f.width) * 4);
        else if (previous) canvas.set(previous);
    }

    return output;
}

const RAW_EXIF = /^Raw profile type (exif|APP1)$/;
const XMP = 'XML:com.adobe.xmp';

/**
 * Finds the orientation in Exif or XMP text chunks
 */
async function textOrientation(chunks: Array<{ type: number, chunk: Uint8Array }>): Promise<number> {
    for (const { type, chunk } of chunks) {
        const separator = chunk.indexOf(0);
        if (separator < 1) continue;
        const keyword = utf8Decode(chunk.subarray(0, separator));
        if (!RAW_EXIF.test(keyword) && keyword !== XMP) continue;

        let body: Uint8Array;
        try {
            if (type === tEXt) body = chunk.subarray(separator + 1);
            else if (type === zTXt) body = await decompressAsync(chunk.subarray(separator + 2), 1 << 20);
            else {
                // compression flag and method, then language and translated keyword (both null terminated)
                const language = chunk.indexOf(0, separator + 3);
                const translated = language < 0 ? -1 : chunk.indexOf(0, language + 1);
                if (translated < 0) continue;
                body = chunk[separator + 1] ? await decompressAsync(chunk.subarray(translated + 1), 1 << 20) : chunk.subarray(translated + 1);
            }
        } catch {
            continue;
        }

        const value = utf8Decode(body);
        const orientation = keyword === XMP ? xmpOrientation(value) : exifOrientation(hexProfile(value));
        if (orientation !== 1) return orientation;
    }

    return 1;
}

/**
 * Parses ImageMagick's hex encoded profiles: "\n<name>\n<length>\n<hex digits in lines>"
 */
function hexProfile(text: string): Uint8Array {
    const match = /^\s*\S+\s+(\d+)\s+([\da-fA-F\s]+)/.exec(text);
    if (!match) return new Uint8Array(0);
    const digits = match[2].replace(/\s+/g, '');
    const out = new Uint8Array(Math.min(+match[1], digits.length >> 1));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.substr(i * 2, 2), 16);
    return out;
}

function unfilter(data: Uint8Array, offset: number, height: number, rowBytes: number, bpp: number): Uint8Array {
    const out = new Uint8Array(height * rowBytes);
    const first = Math.min(bpp, rowBytes);

    // the first row and the first pixel of every row have zero neighbours, those are handled by separate loops
    for (let y = 0; y < height; y++) {
        const filter = data[offset++];
        const row = y * rowBytes;
        const src = offset - row; // data index = src + out index

        if (filter === 0 || (filter === 2 && y === 0)) out.set(data.subarray(offset, offset + rowBytes), row);
        else if (filter === 1) {
            out.set(data.subarray(offset, offset + first), row);
            for (let i = row + bpp; i < row + rowBytes; i++) out[i] = data[src + i] + out[i - bpp];
        } else if (filter === 2) {
            for (let i = row; i < row + rowBytes; i++) out[i] = data[src + i] + out[i - rowBytes];
        } else if (filter === 3) {
            if (y === 0) {
                out.set(data.subarray(offset, offset + first), row);
                for (let i = row + bpp; i < row + rowBytes; i++) out[i] = data[src + i] + (out[i - bpp] >> 1);
            } else {
                for (let i = row; i < row + first; i++) out[i] = data[src + i] + (out[i - rowBytes] >> 1);
                for (let i = row + bpp; i < row + rowBytes; i++) out[i] = data[src + i] + (out[i - bpp] + out[i - rowBytes] >> 1);
            }
        } else if (filter === 4) {
            if (y === 0) {
                // paeth with no row above picks the left neighbour
                out.set(data.subarray(offset, offset + first), row);
                for (let i = row + bpp; i < row + rowBytes; i++) out[i] = data[src + i] + out[i - bpp];
            } else {
                // and with no left neighbour the one above
                for (let i = row; i < row + first; i++) out[i] = data[src + i] + out[i - rowBytes];
                for (let i = row + bpp; i < row + rowBytes; i++) {
                    const a = out[i - bpp], b = out[i - rowBytes], c = out[i - rowBytes - bpp];
                    const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                    out[i] = data[src + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
                }
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

        return (pixels, rowBytes, w, h, out, place) => {
            for (let y = 0; y < h; y++) {
                const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

                for (let x = 0, o = place.row(y); x < w; x++, o += place.step) {
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

        return (pixels, rowBytes, w, h, out, place) => {
            for (let y = 0; y < h; y++) {
                const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

                for (let x = 0, o = place.row(y); x < w; x++, o += place.step) {
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

        return (pixels, rowBytes, w, h, out, place) => {
            for (let y = 0; y < h; y++) {
                const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

                for (let x = 0, o = place.row(y); x < w; x++, o += place.step) {
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
        return (pixels, rowBytes, w, h, out, place) => {
            for (let y = 0; y < h; y++) {
                const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

                for (let x = 0, o = place.row(y); x < w; x++, o += place.step) {
                    const v = scale(sample(row, x * 2));
                    out[o] = out[o + 1] = out[o + 2] = v;
                    out[o + 3] = scale(sample(row, x * 2 + 1));
                }
            }
        };
    }

    // colorType === 6
    if (depth === 8) {
        return (pixels, rowBytes, w, h, out, place) => {
            // non-interlaced 8-bit RGBA maps 1:1 onto the output
            if (place.step === 4 && w * 4 === rowBytes && place.row(0) === 0 && place.row(1) === rowBytes) return out.set(pixels);

            for (let y = 0; y < h; y++)
                for (let x = 0, o = place.row(y); x < w; x++, o += place.step)
                    out.set(pixels.subarray(y * rowBytes + x * 4, y * rowBytes + x * 4 + 4), o);
        };
    }

    return (pixels, rowBytes, w, h, out, place) => {
        for (let y = 0; y < h; y++) {
            const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

            for (let x = 0, o = place.row(y); x < w; x++, o += place.step) {
                out[o] = scale(sample(row, x * 4));
                out[o + 1] = scale(sample(row, x * 4 + 1));
                out[o + 2] = scale(sample(row, x * 4 + 2));
                out[o + 3] = scale(sample(row, x * 4 + 3));
            }
        }
    };
}

