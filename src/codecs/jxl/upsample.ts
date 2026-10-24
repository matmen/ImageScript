/*!
 * JPEG XL's non-separable upsampling (2x, 4x, 8x: 5x5 kernels per output position, clamped to the neighborhood),
 * ported from jxl-oxide (crates/jxl-render/src/features/upsampling.rs). Copyright (c) Wonwoo Choi, MIT License (see
 * THIRD_PARTY_NOTICES.md)
 */
import { ImageHeader } from './headers.ts';

/** index into 0..len with mirrored edges (-1 is 0, len is len - 1) */
export function mirror(i: number, len: number): number {
    for (; ;) {
        if (i < 0) i = -i - 1;
        else if (i >= len) i = 2 * len - i - 1;
        else return i;
    }
}

/** Upsamples a w x h plane by a factor (2, 4, 8), cropped to outW x outH */
export function upsample(src: Float32Array, w: number, h: number, factor: number, image: ImageHeader, outW: number, outH: number): Float32Array {
    const weights = factor === 2 ? image.up2 : factor === 4 ? image.up4 : image.up8;
    const half = factor / 2;
    // the kernels of the top left quarter (the others are mirrored): kernel (my, mx) at [(my * half + mx) * 25]
    const kernels = new Float32Array(half * half * 25);
    let k = 0;
    for (let y = 0; y < 5 * half; y++) {
        for (let x = y; x < 5 * half; x++) {
            const v = weights[k++];
            kernels[(Math.floor(y / 5) * half + Math.floor(x / 5)) * 25 + (y % 5) * 5 + x % 5] = v;
            kernels[(Math.floor(x / 5) * half + Math.floor(y / 5)) * 25 + (x % 5) * 5 + y % 5] = v;
        }
    }
    // padded by 2 on each side
    const pw = w + 4, padded = new Float32Array(pw * (h + 4));
    for (let y = 0; y < h + 4; y++) {
        const sy = mirror(y - 2, h);
        for (let x = 0; x < pw; x++) padded[y * pw + x] = src[sy * w + mirror(x - 2, w)];
    }
    const out = new Float32Array(outW * outH), window = new Float32Array(25);
    for (let y = 0; y < outH; y++) {
        const ry = Math.floor(y / factor), fy = y % factor, my = Math.min(fy, factor - fy - 1), flipV = fy >= half;
        for (let x = 0; x < outW; x++) {
            const rx = Math.floor(x / factor), fx = x % factor, mx = Math.min(fx, factor - fx - 1), flipH = fx >= half;
            const kernel = (my * half + mx) * 25;
            let sum = 0, min = Infinity, max = -Infinity;
            for (let iy = 0; iy < 5; iy++) {
                const ky = flipV ? 4 - iy : iy, row = (ry + iy) * pw + rx;
                for (let ix = 0; ix < 5; ix++) {
                    const kx = flipH ? 4 - ix : ix, v = padded[row + ix];
                    sum += kernels[kernel + ky * 5 + kx] * v;
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
            }
            out[y * outW + x] = min > max ? NaN : sum < min ? min : sum > max ? max : sum;
        }
    }
    void window;
    return out;
}
