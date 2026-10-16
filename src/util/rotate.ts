// bilinear rotation on the pixels as 32-bit words: 8-bit premultiplied pixels and 8-bit weights, so red and blue,
// green and alpha share a multiplication (like the fast resampling)

import { littleEndian, isOpaque, premultiply8, unpremultiply8 } from './alpha.ts';

// the range of steps x (within from..to) where start + x * step lies within 0..limit, widened by a step on either side
function span(start: number, step: number, limit: number, from: number, to: number): [number, number] {
    if (step === 0) return start >= 0 && start < limit ? [from, to] : [from, from];
    const a = -start / step, b = (limit - start) / step;
    const lo = Math.floor(Math.min(a, b)) - 1, hi = Math.ceil(Math.max(a, b)) + 1;
    return [Math.max(from, lo), Math.max(Math.max(from, lo), Math.min(to, hi))];
}

/**
 * Samples the source rotated counterclockwise (by the angle of `sin` and `cos`) around its center into `out`, centered
 * as well. Pixels outside the source stay transparent, edges fade like the taps outside the source were transparent.
 * Returns false (without writing anything) on big endian machines
 */
export function rotateBilinear(src: Uint8ClampedArray, width: number, height: number, out: Uint8ClampedArray, outWidth: number, outHeight: number, sin: number, cos: number): boolean {
    if (!littleEndian) return false;

    // premultiplied, with a transparent border of one pixel: taps outside the source need no checks
    let bitmap = src;
    if (!isOpaque(src)) premultiply8(src, bitmap = new Uint8ClampedArray(src.length));
    const pixels = new Int32Array(bitmap.buffer, bitmap.byteOffset, width * height);
    const stride = width + 2;
    const padded = new Int32Array(stride * (height + 2));
    for (let y = 0; y < height; y++) padded.set(pixels.subarray(y * width, (y + 1) * width), (y + 1) * stride + 1);

    const result = new Int32Array(out.buffer, out.byteOffset, outWidth * outHeight);
    // source position (in padded coordinates) of the center of the first pixel in a row, then one step per pixel
    const x0 = 0.5 - outWidth / 2, cx = width / 2 + 0.5, cy = height / 2 + 0.5;
    for (let oy = 0; oy < outHeight; oy++) {
        const dy = oy + 0.5 - outHeight / 2;
        const sx0 = x0 * cos - dy * sin + cx, sy0 = x0 * sin + dy * cos + cy;
        // the pixels of the row that hit the source (give or take one, the check below is exact)
        const [xFrom, xTo] = span(sx0, cos, width + 1, 0, outWidth);
        const [from, to] = span(sy0, sin, height + 1, xFrom, xTo);
        let o = oy * outWidth + from, sx = sx0 + from * cos, sy = sy0 + from * sin;
        for (let ox = from; ox < to; ox++, o++, sx += cos, sy += sin) {
            if (!(sx >= 0 && sy >= 0 && sx < width + 1 && sy < height + 1)) continue;
            const ix = sx | 0, iy = sy | 0;
            // 8-bit fractions, and weights summing to 256
            const fx = (sx - ix) * 256 + 0.5 | 0, fy = (sy - iy) * 256 + 0.5 | 0;
            const w11 = fx * fy + 128 >> 8, w10 = fx - w11, w01 = fy - w11, w00 = 256 - fx - fy + w11;
            const i = iy * stride + ix;
            const p00 = padded[i], p10 = padded[i + 1], p01 = padded[i + stride], p11 = padded[i + stride + 1];
            const rb = Math.imul(p00 & 0xff00ff, w00) + Math.imul(p10 & 0xff00ff, w10) + Math.imul(p01 & 0xff00ff, w01) + Math.imul(p11 & 0xff00ff, w11) + 0x800080;
            const ga = Math.imul(p00 >>> 8 & 0xff00ff, w00) + Math.imul(p10 >>> 8 & 0xff00ff, w10) + Math.imul(p01 >>> 8 & 0xff00ff, w01) + Math.imul(p11 >>> 8 & 0xff00ff, w11) + 0x800080;
            result[o] = (rb >>> 8 & 0xff00ff) | (ga & 0xff00ff00);
        }
    }

    // the edges are translucent even for opaque sources
    unpremultiply8(out);
    return true;
}
