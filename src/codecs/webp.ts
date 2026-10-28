/*!
 * WebP container. Animation frames are blended with libwebp's integer arithmetic (Copyright (c) 2010 Google Inc., BSD
 * license, see THIRD_PARTY_NOTICES.md)
 */
// RIFF container (RFC 9649, https://www.rfc-editor.org/rfc/rfc9649): simple lossy/lossless files, extended files with
// alpha and animation
import * as vp8l from './vp8l.ts';
import * as vp8 from './vp8.ts';
import { encodeVP8, encodeAlpha } from './vp8-enc.ts';
import { rgbaToYUV } from './vp8-enc-dsp.ts';
import { orientation as exifOrientation } from './exif.ts';
import { MAX_PIXELS, checkPixels } from '../util/limits.ts';

const fourCC = (s: string): number => s.charCodeAt(0) | s.charCodeAt(1) << 8 | s.charCodeAt(2) << 16 | s.charCodeAt(3) << 24;
const RIFF = fourCC('RIFF'), WEBP = fourCC('WEBP');
const VP8 = fourCC('VP8 '), VP8L = fourCC('VP8L'), VP8X = fourCC('VP8X');
const ALPH = fourCC('ALPH'), ANIM = fourCC('ANIM'), ANMF = fourCC('ANMF'), EXIF = fourCC('EXIF');

export interface WebPFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    /** milliseconds */
    duration: number;
    /** whether the frame is alpha blended onto the canvas (false: it replaces the covered area) */
    blend: boolean;
    /** whether the frame's area is cleared to transparent after it was shown */
    dispose: boolean;
    /** RGBA */
    pixels: Uint8Array;
}

export interface WebPAnimation {
    width: number;
    height: number;
    /** 0 = forever */
    loopCount: number;
    /** ARGB background color hint (decoders, like browsers, are free to ignore it) */
    background: number;
    frames: WebPFrame[];
}

interface Chunk {
    type: number;
    data: Uint8Array;
}

function chunks(data: Uint8Array, start: number, end: number): Chunk[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out: Chunk[] = [];
    let offset = start;
    while (offset + 8 <= end) {
        const type = view.getUint32(offset, true);
        const size = view.getUint32(offset + 4, true);
        const dataStart = offset + 8;
        // tolerate a truncated last chunk, the bitstream decoders report missing data
        out.push({ type, data: data.subarray(dataStart, Math.min(end, dataStart + size)) });
        offset = dataStart + size + (size & 1);
    }
    return out;
}

function container(data: Uint8Array): Chunk[] {
    if (data.length < 12) throw new Error('WebP: invalid header');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== RIFF || view.getUint32(8, true) !== WEBP) throw new Error('WebP: invalid header');
    const size = view.getUint32(4, true);
    return chunks(data, 12, Math.min(data.length, 8 + size));
}

const u24 = (d: Uint8Array, o: number): number => d[o] | d[o + 1] << 8 | d[o + 2] << 16;

/**
 * Decodes a frame's image data: a VP8L chunk, or a VP8 chunk with an optional ALPH chunk before it
 */
function decodeBitstream(list: Chunk[], maxPixels: number): { width: number, height: number, pixels: Uint8Array } {
    let alpha: Chunk | null = null;
    for (const chunk of list) {
        if (chunk.type === ALPH) alpha ??= chunk;
        else if (chunk.type === VP8L) {
            const { width, height, argb } = vp8l.decode(chunk.data, maxPixels);
            // ARGB -> RGBA in memory, one 32-bit word per pixel (written little endian, the byte order doesn't matter)
            const pixels = new Uint8Array(width * height * 4);
            const out = new DataView(pixels.buffer);
            for (let i = 0; i < argb.length; i++) {
                const p = argb[i];
                out.setUint32(i * 4, (p << 8 | p >>> 24) >>> 0);
            }
            return { width, height, pixels };
        } else if (chunk.type === VP8) {
            const image = vp8.decode(chunk.data, maxPixels);
            if (alpha) applyAlpha(image.pixels, image.width, image.height, alpha.data);
            return image;
        }
    }
    throw new Error('WebP: no image data');
}

// ALPH chunk, RFC 9649 section 2.7.1.2: preprocessing (ignored), filtering, compression (raw or VP8L)
function applyAlpha(rgba: Uint8Array, width: number, height: number, chunk: Uint8Array): void {
    if (!chunk.length) return;
    const header = chunk[0];
    const compression = header & 3, filter = header >> 2 & 3;
    const total = width * height;
    let alpha: Uint8Array;

    if (compression === 0) {
        alpha = new Uint8Array(total);
        alpha.set(chunk.subarray(1, 1 + total));
    } else if (compression === 1) {
        // a VP8L stream without its header, the alpha values are in the green channel
        const argb = vp8l.decodeStream(new vp8l.BitReader(chunk, 1), width, height);
        alpha = new Uint8Array(total);
        for (let i = 0; i < total; i++) alpha[i] = argb[i] >> 8 & 255;
    } else throw new Error('WebP: invalid alpha compression');

    if (filter) unfilterAlpha(alpha, width, height, filter);
    for (let i = 0; i < total; i++) rgba[i * 4 + 3] = alpha[i];
}

// alpha filtering: 1 horizontal, 2 vertical, 3 gradient; the first row and column predict from left/top
function unfilterAlpha(a: Uint8Array, width: number, height: number, filter: number): void {
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            const i = row + x;
            let prediction: number;
            if (x === 0 && y === 0) prediction = 0;
            else if (y === 0) prediction = a[i - 1];
            else if (x === 0) prediction = a[i - width];
            else if (filter === 1) prediction = a[i - 1];
            else if (filter === 2) prediction = a[i - width];
            else {
                const g = a[i - 1] + a[i - width] - a[i - width - 1];
                prediction = g < 0 ? 0 : g > 255 ? 255 : g;
            }
            a[i] = a[i] + prediction & 255;
        }
    }
}

/** Whether the WebP is animated */
export function isAnimated(data: Uint8Array): boolean {
    const list = container(data);
    const header = list[0];
    return header && header.type === VP8X && header.data.length >= 10 && (header.data[0] & 2) !== 0 && list.some(c => c.type === ANMF);
}

/**
 * Decodes a still WebP into RGBA pixels. Animated WebPs decode to their first frame composited on the canvas
 */
export function decode(data: Uint8Array, maxPixels = MAX_PIXELS): { width: number, height: number, pixels: Uint8Array, orientation: number } {
    const list = container(data);
    if (!list.length) throw new Error('WebP: no image data');

    let orientation = 1;
    const exif = list.find(c => c.type === EXIF);
    if (exif) orientation = exifOrientation(exif.data);

    if (list.some(c => c.type === ANMF)) {
        const animation = decodeAnimation(data, true, maxPixels);
        const frame = composite(animation)[0];
        return { width: animation.width, height: animation.height, pixels: frame.pixels, orientation };
    }

    const image = decodeBitstream(list, maxPixels);
    if (list[0].type === VP8X && list[0].data.length >= 10) {
        // the canvas size wins over the bitstream's, they have to match
        const width = u24(list[0].data, 4) + 1, height = u24(list[0].data, 7) + 1;
        if (width !== image.width || height !== image.height) throw new Error('WebP: canvas and image sizes differ');
    }
    return { ...image, orientation };
}

/**
 * Decodes an animated WebP into its frames (not composited); still WebPs become a single frame
 */
export function decodeAnimation(data: Uint8Array, onlyFirstFrame = false, maxPixels = MAX_PIXELS): WebPAnimation {
    const list = container(data);
    const header = list[0];
    if (!header || header.type !== VP8X || !list.some(c => c.type === ANMF)) {
        const { width, height, pixels } = decodeBitstream(list, maxPixels);
        return { width, height, loopCount: 0, background: 0, frames: [{ x: 0, y: 0, width, height, duration: 0, blend: false, dispose: false, pixels }] };
    }

    if (header.data.length < 10) throw new Error('WebP: invalid VP8X chunk');
    const width = u24(header.data, 4) + 1, height = u24(header.data, 7) + 1;
    // every frame is composited onto a canvas of its own
    checkPixels(width, height, maxPixels, onlyFirstFrame ? 1 : list.filter(c => c.type === ANMF).length);
    let loopCount = 0, background = 0;
    const frames: WebPFrame[] = [];

    for (const chunk of list) {
        if (chunk.type === ANIM && chunk.data.length >= 6) {
            const d = chunk.data;
            // stored as BGRA
            background = (d[3] << 24 | d[2] << 16 | d[1] << 8 | d[0]) >>> 0;
            loopCount = d[4] | d[5] << 8;
        } else if (chunk.type === ANMF) {
            const d = chunk.data;
            if (d.length < 16) throw new Error('WebP: invalid ANMF chunk');
            const frame = decodeBitstream(chunks(d, 16, d.length), maxPixels);
            frames.push({
                x: u24(d, 0) * 2,
                y: u24(d, 3) * 2,
                width: frame.width,
                height: frame.height,
                duration: u24(d, 12),
                blend: (d[15] & 2) === 0,
                dispose: (d[15] & 1) === 1,
                pixels: frame.pixels
            });
            if (onlyFirstFrame) break;
        }
    }

    if (!frames.length) throw new Error('WebP: animation without frames');
    return { width, height, loopCount, background, frames };
}

/**
 * Composites animation frames onto the canvas like browsers do (transparent background, the background color hint
 * is ignored as the spec allows)
 */
export function composite({ width, height, frames }: WebPAnimation): Array<{ pixels: Uint8Array, duration: number }> {
    const canvas = new Uint8Array(width * height * 4);
    const output = [];

    for (const frame of frames) {
        const x0 = Math.min(frame.x, width), x1 = Math.min(frame.x + frame.width, width);
        const y0 = Math.min(frame.y, height), y1 = Math.min(frame.y + frame.height, height);

        for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) {
                const s = ((y - frame.y) * frame.width + x - frame.x) * 4, d = (y * width + x) * 4;
                const sa = frame.pixels[s + 3];
                // nothing to blend with on a transparent canvas pixel (blending would only add rounding errors)
                if (!frame.blend || sa === 255 || canvas[d + 3] === 0) {
                    canvas[d] = frame.pixels[s];
                    canvas[d + 1] = frame.pixels[s + 1];
                    canvas[d + 2] = frame.pixels[s + 2];
                    canvas[d + 3] = sa;
                } else if (sa !== 0) blendOver(frame.pixels, s, canvas, d);
            }

        output.push({ pixels: canvas.slice(), duration: frame.duration });

        if (frame.dispose)
            for (let y = y0; y < y1; y++) canvas.fill(0, (y * width + x0) * 4, (y * width + x1) * 4);
    }

    return output;
}

// source over destination, non-premultiplied: libwebp's integer version of the spec's formula
function blendOver(src: Uint8Array, s: number, dst: Uint8Array, d: number): void {
    const sa = src[s + 3], da = dst[d + 3];
    const dstFactor = da * (256 - sa) >> 8;
    const alpha = sa + dstFactor;
    const scale = alpha ? Math.floor((1 << 24) / alpha) : 0;
    for (let c = 0; c < 3; c++) {
        const blended = src[s + c] * sa + dst[d + c] * dstFactor;
        dst[d + c] = blended * scale >>> 24;
    }
    dst[d + 3] = alpha;
}

// ---------------------------------------------------------------------------
// encoder (lossless)
// ---------------------------------------------------------------------------

function riffChunk(type: string, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    const view = new DataView(out.buffer);
    view.setUint32(0, fourCC(type), true);
    view.setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

function riff(chunks: Uint8Array[]): Uint8Array {
    let size = 4;
    for (const c of chunks) size += c.length;
    const out = new Uint8Array(8 + size);
    const view = new DataView(out.buffer);
    view.setUint32(0, RIFF, true);
    view.setUint32(4, size, true);
    view.setUint32(8, WEBP, true);
    let offset = 12;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

function toARGB(rgba: Uint8Array, count: number): Uint32Array {
    const argb = new Uint32Array(count);
    for (let i = 0, o = 0; i < count; i++, o += 4) argb[i] = (rgba[o + 3] << 24 | rgba[o] << 16 | rgba[o + 1] << 8 | rgba[o + 2]) >>> 0;
    return argb;
}

const set24 = (d: Uint8Array, o: number, v: number): void => { d[o] = v & 255; d[o + 1] = v >> 8 & 255; d[o + 2] = v >> 16 & 255; };

const hasAlpha = (rgba: Uint8Array): boolean => {
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
    return false;
};

/**
 * Encodes RGBA pixels into a lossless WebP
 * @param exif Exif data (a TIFF header and IFDs), needs the extended format (VP8X)
 */
export function encode(rgba: Uint8Array, width: number, height: number, exif?: Uint8Array): Uint8Array {
    const bitstream = riffChunk('VP8L', vp8l.encode(toARGB(rgba, width * height), width, height));
    if (!exif) return riff([bitstream]);

    const vp8x = new Uint8Array(10);
    vp8x[0] = 8 | (hasAlpha(rgba.subarray(0, width * height * 4)) ? 16 : 0); // exif, alpha
    set24(vp8x, 4, width - 1);
    set24(vp8x, 7, height - 1);
    return riff([riffChunk('VP8X', vp8x), bitstream, riffChunk('EXIF', exif)]);
}

/**
 * Encodes RGBA pixels into a lossy WebP like libwebp does with its default settings (VP8, with a losslessly
 * compressed alpha plane if the image isn't opaque)
 * @param quality 0-100
 * @param exif Exif data (a TIFF header and IFDs), needs the extended format (VP8X)
 * @param method libwebp's method (0-6: faster to smaller)
 */
export function encodeLossy(rgba: Uint8Array, width: number, height: number, quality: number, exif?: Uint8Array, method = 4, sharp = false): Uint8Array {
    const { alpha, chunks } = lossyChunks(rgba, width, height, quality, method, sharp);
    if (!alpha && !exif) return riff(chunks);

    const vp8x = new Uint8Array(10);
    vp8x[0] = (exif ? 8 : 0) | (alpha ? 16 : 0);
    set24(vp8x, 4, width - 1);
    set24(vp8x, 7, height - 1);
    return riff([riffChunk('VP8X', vp8x), ...chunks, ...exif ? [riffChunk('EXIF', exif)] : []]);
}

// the ALPH (if not opaque) and VP8 chunks of a lossy image
function lossyChunks(rgba: Uint8Array, width: number, height: number, quality: number, method: number, sharp = false): { alpha: boolean, chunks: Uint8Array[] } {
    if (width > 16383 || height > 16383) throw new RangeError('WebP: lossy images can be at most 16383 pixels wide and high');
    const picture = rgbaToYUV(rgba, width, height, sharp);
    const frame = encodeVP8(picture, quality, method);
    // (libwebp counts the padding byte in the chunk's size)
    const padded = new Uint8Array(frame.length + (frame.length & 1));
    padded.set(frame);
    const chunks = [riffChunk('VP8 ', padded)];
    if (picture.a) chunks.unshift(riffChunk('ALPH', encodeAlpha(picture.a, width, height, method)));
    return { alpha: !!picture.a, chunks };
}

export interface WebPEncodeFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    /** milliseconds */
    duration: number;
    /** whether the frame's area is cleared after it was shown */
    dispose: boolean;
    /** whether the frame is alpha blended onto the canvas, otherwise it replaces its area. Default: true */
    blend?: boolean;
    /** RGBA */
    pixels: Uint8Array;
}

/**
 * How much a color channel of a lossy animation's pixel may change for it to count as unchanged (libwebp's
 * QualityToMaxDiff: 1 at quality 100, 3 at 85, 31 at 0)
 * @param quality 0-100
 */
export function lossyTolerance(quality: number): number {
    const value = Math.sqrt(quality / 100);
    return Math.max(1, Math.round(31 * (1 - value) + value));
}

/**
 * Encodes frames into an animated WebP, lossless or (with a quality) lossy. Frame offsets have to be even (the format
 * stores them halved)
 * @param plays How often to play the animation, 0 = forever
 * @param exif Exif data (a TIFF header and IFDs)
 * @param quality 0-100 for lossy frames
 * @param method libwebp's method for lossy frames (0-6: faster to smaller)
 */
export function encodeAnimation(frames: WebPEncodeFrame[], width: number, height: number, plays: number, exif?: Uint8Array, quality?: number, method = 4, sharp = false): Uint8Array {
    if (!frames.length) throw new Error('WebP: an animation needs at least one frame');
    if (width > 1 << 24 || height > 1 << 24) throw new RangeError('WebP: canvas too large');

    let alpha = false;
    for (const [i, f] of frames.entries()) alpha ||= needsAlpha(f, i === 0, width, height);
    return animationFile(frames.map(f => frameChunk(f, quality, method, sharp)), width, height, plays, alpha, exif);
}

/**
 * Whether a frame makes the animation need the alpha flag: transparency also comes from the canvas, where the first
 * frame doesn't cover it, and where frames are disposed (decoders like libwebp take the canvas as opaque without it)
 */
export function needsAlpha(f: WebPEncodeFrame, first: boolean, width: number, height: number): boolean {
    return (first && (f.x > 0 || f.y > 0 || f.width < width || f.height < height)) || f.dispose || hasAlpha(f.pixels);
}

/** A frame of an animation as its ANMF chunk */
export function frameChunk(f: WebPEncodeFrame, quality?: number, method = 4, sharp = false): Uint8Array {
    if (f.x & 1 || f.y & 1) throw new RangeError('WebP: frame offsets have to be even');
    const bitstream = quality === undefined ? riffChunk('VP8L', vp8l.encode(toARGB(f.pixels, f.width * f.height), f.width, f.height))
        : concat(lossyChunks(f.pixels, f.width, f.height, quality, method, sharp).chunks);
    const header = new Uint8Array(16);
    set24(header, 0, f.x >> 1);
    set24(header, 3, f.y >> 1);
    set24(header, 6, f.width - 1);
    set24(header, 9, f.height - 1);
    set24(header, 12, Math.min(0xffffff, Math.max(0, Math.round(f.duration))));
    header[15] = (f.blend === false ? 2 : 0) | (f.dispose ? 1 : 0); // no blending, disposal
    const body = new Uint8Array(16 + bitstream.length);
    body.set(header);
    body.set(bitstream, 16);
    return riffChunk('ANMF', body);
}

/** An animation's file from its frames' ANMF chunks */
export function animationFile(frames: Uint8Array[], width: number, height: number, plays: number, alpha: boolean, exif?: Uint8Array): Uint8Array {
    const vp8x = new Uint8Array(10);
    vp8x[0] = 2 | (alpha ? 16 : 0) | (exif ? 8 : 0); // animation, alpha, exif
    set24(vp8x, 4, width - 1);
    set24(vp8x, 7, height - 1);

    const anim = new Uint8Array(6); // transparent background color
    anim[4] = plays & 255;
    anim[5] = plays >> 8 & 255;

    const chunks = [riffChunk('VP8X', vp8x), riffChunk('ANIM', anim), ...frames];
    if (exif) chunks.push(riffChunk('EXIF', exif));
    return riff(chunks);
}
