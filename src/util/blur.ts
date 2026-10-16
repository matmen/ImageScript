// gaussian blur approximated by three box blurs (the box sizes match the gaussian's variance), each pass is a
// running sum, so the cost doesn't depend on the radius. Pixels outside the image repeat the edge pixels

import { littleEndian, isOpaque, premultiply8, unpremultiply8 } from './alpha.ts';

// widths of the three boxes for a gaussian with the given standard deviation: the formula of Peter Kovesi's "Fast
// Almost-Gaussian Filtering" (2010), as in Ivan Kuckir's "Fastest Gaussian Blur" (boxesForGauss)
function boxSizes(sigma: number): number[] {
    const n = 3;
    let lower = Math.floor(Math.sqrt(12 * sigma * sigma / n + 1));
    if (lower % 2 === 0) lower--;
    const upper = lower + 2;
    const m = Math.round((12 * sigma * sigma - n * lower * lower - 4 * n * lower - 3 * n) / (-4 * lower - 4));
    return Array.from({ length: n }, (_, i) => i < m ? lower : upper);
}

// box blurs `count` lines of `length` interleaved RGBA float values, lines start `lineStride` apart, values `step` apart
function boxPass(src: Float32Array, dst: Float32Array, count: number, length: number, lineStride: number, step: number, radius: number): void {
    const scale = 1 / (2 * radius + 1);
    const last = (length - 1) * step;

    for (let line = 0; line < count; line++) {
        const base = line * lineStride;
        const first = base, end = base + last;
        // window around the first value, repeating the edge values: the first value radius + 1 times, the next ones,
        // and the last one for what the window reaches past the end (so the cost doesn't depend on the radius)
        let r = (radius + 1) * src[first], g = (radius + 1) * src[first + 1], b = (radius + 1) * src[first + 2], a = (radius + 1) * src[first + 3];
        const inside = Math.min(radius, length - 1);
        for (let k = 1, o = base + step; k <= inside; k++, o += step) {
            r += src[o];
            g += src[o + 1];
            b += src[o + 2];
            a += src[o + 3];
        }
        const beyond = radius - inside;
        r += beyond * src[end];
        g += beyond * src[end + 1];
        b += beyond * src[end + 2];
        a += beyond * src[end + 3];

        for (let i = 0, o = base; i < length; i++, o += step) {
            dst[o] = r * scale;
            dst[o + 1] = g * scale;
            dst[o + 2] = b * scale;
            dst[o + 3] = a * scale;

            // slide the window: add the value entering on the right, remove the one leaving on the left
            const add = Math.min(end, o + (radius + 1) * step), remove = Math.max(first, o - radius * step);
            r += src[add] - src[remove];
            g += src[add + 1] - src[remove + 1];
            b += src[add + 2] - src[remove + 2];
            a += src[add + 3] - src[remove + 3];
        }
    }
}

// box blurs columns, sliding a window of whole rows (memory friendly, unlike walking down each column)
function boxPassRows(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number): void {
    const stride = width * 4;
    const scale = 1 / (2 * radius + 1);
    const sum = new Float64Array(stride);
    const row = (y: number): number => (y < 0 ? 0 : y >= height ? height - 1 : y) * stride;

    // the window around the first row (see boxPass)
    const inside = Math.min(radius, height - 1), last = (height - 1) * stride;
    for (let x = 0; x < stride; x++) sum[x] = (radius + 1) * src[x] + (radius - inside) * src[last + x];
    for (let k = 1; k <= inside; k++) {
        const o = k * stride;
        for (let x = 0; x < stride; x++) sum[x] += src[o + x];
    }

    for (let y = 0; y < height; y++) {
        const o = y * stride, add = row(y + radius + 1), remove = row(y - radius);
        for (let x = 0; x < stride; x++) {
            dst[o + x] = sum[x] * scale;
            sum[x] += src[add + x] - src[remove + x];
        }
    }
}

// normalized gaussian weights from -radius to radius, radius = ceil(3 sigma)
function gaussianKernel(sigma: number): Float64Array {
    const radius = Math.ceil(3 * sigma);
    const kernel = new Float64Array(2 * radius + 1);
    let total = 0;
    for (let i = -radius; i <= radius; i++) total += kernel[i + radius] = Math.exp(-i * i / (2 * sigma * sigma));
    for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
    return kernel;
}

// convolves lines with a symmetric kernel, the same layout as boxPass
function kernelPass(src: Float32Array, dst: Float32Array, count: number, length: number, lineStride: number, step: number, kernel: Float64Array): void {
    const radius = (kernel.length - 1) / 2;
    const last = length - 1;

    for (let line = 0; line < count; line++) {
        const base = line * lineStride;
        for (let i = 0; i < length; i++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = -radius; k <= radius; k++) {
                const j = i + k;
                const o = base + (j < 0 ? 0 : j > last ? last : j) * step;
                const w = kernel[k + radius];
                r += src[o] * w;
                g += src[o + 1] * w;
                b += src[o + 2] * w;
                a += src[o + 3] * w;
            }

            const o = base + i * step;
            dst[o] = r;
            dst[o + 1] = g;
            dst[o + 2] = b;
            dst[o + 3] = a;
        }
    }
}

// convolves columns with a symmetric kernel, accumulating whole rows
function kernelPassRows(src: Float32Array, dst: Float32Array, width: number, height: number, kernel: Float64Array): void {
    const stride = width * 4;
    const radius = (kernel.length - 1) / 2;

    for (let y = 0; y < height; y++) {
        const o = y * stride;
        for (let k = -radius; k <= radius; k++) {
            const j = y + k;
            const s = (j < 0 ? 0 : j >= height ? height - 1 : j) * stride;
            const w = kernel[k + radius];
            for (let x = 0; x < stride; x++) dst[o + x] += src[s + x] * w;
        }
    }
}

/**
 * Blurs premultiplied RGBA float pixels in place
 * @param sigma standard deviation of the gaussian in pixels
 */
export function gaussianBlur(pixels: Float32Array, width: number, height: number, sigma: number): void {
    if (!(sigma > 0)) return;
    const tmp = new Float32Array(pixels.length);

    // the box approximation is coarse for small radii, a real gaussian kernel is cheap there
    if (sigma < 2) {
        const kernel = gaussianKernel(sigma);
        kernelPass(pixels, tmp, height, width, width * 4, 4, kernel);
        pixels.fill(0);
        kernelPassRows(tmp, pixels, width, height, kernel);
        return;
    }

    for (const size of boxSizes(sigma)) {
        const radius = (size - 1) / 2;
        if (radius < 1) continue;
        boxPass(pixels, tmp, height, width, width * 4, 4, radius);
        boxPassRows(tmp, pixels, width, height, radius);
    }
}

// box blurs the pixels of one row (32-bit words) from src into dst, the edge pixels repeat. Red and blue share an
// int as two 16-bit lanes, green and alpha another: a window of up to 257 pixels fits (255 * 257 < 65536).
// `mult` divides by the window size (65536 / size)
function boxRowWords(src: Int32Array, dst: Int32Array, s: number, length: number, radius: number, mult: number): void {
    const last = length - 1;
    const first = src[s], end = src[s + last];
    let rb = (radius + 1) * (first & 0xff00ff), ga = (radius + 1) * (first >>> 8 & 0xff00ff);
    for (let k = 1; k <= radius; k++) {
        const p = src[s + (k < last ? k : last)];
        rb += p & 0xff00ff;
        ga += p >>> 8 & 0xff00ff;
    }

    for (let x = 0; x < length; x++) {
        dst[s + x] = (Math.imul(rb & 0xffff, mult) + 32768 >>> 16) | (Math.imul(ga & 0xffff, mult) + 32768 >>> 16) << 8
            | (Math.imul(rb >>> 16, mult) + 32768 >>> 16) << 16 | (Math.imul(ga >>> 16, mult) + 32768 >>> 16) << 24;
        const add = x + radius + 1, remove = x - radius;
        const entering = add < last ? src[s + add] : end, leaving = remove > 0 ? src[s + remove] : first;
        rb += (entering & 0xff00ff) - (leaving & 0xff00ff);
        ga += (entering >>> 8 & 0xff00ff) - (leaving >>> 8 & 0xff00ff);
    }
}

// box blurs the columns of src into dst, sliding a window of whole rows (sums per column, in lanes as above)
function boxColumnsWords(src: Int32Array, dst: Int32Array, width: number, height: number, radius: number, mult: number, rbs: Int32Array, gas: Int32Array): void {
    for (let x = 0; x < width; x++) {
        const p = src[x];
        rbs[x] = (radius + 1) * (p & 0xff00ff);
        gas[x] = (radius + 1) * (p >>> 8 & 0xff00ff);
    }
    for (let k = 1; k <= radius; k++) {
        const o = Math.min(k, height - 1) * width;
        for (let x = 0; x < width; x++) {
            const p = src[o + x];
            rbs[x] += p & 0xff00ff;
            gas[x] += p >>> 8 & 0xff00ff;
        }
    }

    for (let y = 0; y < height; y++) {
        const o = y * width, add = Math.min(height - 1, y + radius + 1) * width, remove = Math.max(0, y - radius) * width;
        for (let x = 0; x < width; x++) {
            const rb = rbs[x], ga = gas[x];
            dst[o + x] = (Math.imul(rb & 0xffff, mult) + 32768 >>> 16) | (Math.imul(ga & 0xffff, mult) + 32768 >>> 16) << 8
                | (Math.imul(rb >>> 16, mult) + 32768 >>> 16) << 16 | (Math.imul(ga >>> 16, mult) + 32768 >>> 16) << 24;
            const entering = src[add + x], leaving = src[remove + x];
            rbs[x] = rb + (entering & 0xff00ff) - (leaving & 0xff00ff);
            gas[x] = ga + (entering >>> 8 & 0xff00ff) - (leaving >>> 8 & 0xff00ff);
        }
    }
}

/**
 * Blurs 8-bit RGBA in place with the three box blurs of {@link gaussianBlur}, on the pixels as 32-bit words: two
 * channels per sum, rounded to 8 bits after each box (within a step of blurring floats, several times faster).
 * Transparent images are premultiplied to 8 bits first: that rounds the color of pixels that are almost
 * transparent, which only shows unpremultiplied (composited, they stay within half a step). Returns false (and
 * does nothing) on big endian machines and for radii the box approximation doesn't cover (below 2) or that don't
 * fit the lanes
 */
export function boxBlurRGBA(bitmap: Uint8ClampedArray, width: number, height: number, sigma: number): boolean {
    const sizes = boxSizes(sigma);
    if (!littleEndian || !(sigma >= 2) || Math.max(...sizes) > 257) return false;

    const opaque = isOpaque(bitmap);
    if (!opaque) premultiply8(bitmap, bitmap);

    const pixels = new Int32Array(bitmap.buffer, bitmap.byteOffset, width * height);
    const tmp = new Int32Array(pixels.length), rbs = new Int32Array(width), gas = new Int32Array(width);
    for (const size of sizes) {
        const radius = (size - 1) / 2;
        if (radius < 1) continue;
        const mult = Math.round(65536 / size);
        for (let y = 0; y < height; y++) boxRowWords(pixels, tmp, y * width, width, radius, mult);
        boxColumnsWords(tmp, pixels, width, height, radius, mult, rbs, gas);
    }

    if (!opaque) unpremultiply8(bitmap);
    return true;
}

/**
 * Converts 8-bit RGBA to premultiplied floats
 */
export function premultiply(rgba: Uint8ClampedArray): Float32Array {
    const out = new Float32Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3];
        out[i] = rgba[i] * a / 255;
        out[i + 1] = rgba[i + 1] * a / 255;
        out[i + 2] = rgba[i + 2] * a / 255;
        out[i + 3] = a;
    }
    return out;
}

/**
 * Converts premultiplied floats back to 8-bit RGBA (the clamped output rounds)
 */
export function unpremultiply(pixels: Float32Array, out: Uint8ClampedArray): void {
    for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3];
        if (a < 0.5) {
            out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
            continue;
        }

        const f = 255 / a;
        out[i] = pixels[i] * f;
        out[i + 1] = pixels[i + 1] * f;
        out[i + 2] = pixels[i + 2] * f;
        out[i + 3] = a;
    }
}
