/*!
 * The forward transforms of JPEG XL's varblocks for the encoder: DCTs (the decoder's DCTs forward), the special 8x8
 * transforms (DCT2X2, DCT4X4 and IDENTITY like libjxl's TransformFromPixels, lib/jxl/enc_transforms-inl.h: Copyright
 * (c) the JPEG XL Project Authors, BSD-3-Clause License, see THIRD_PARTY_NOTICES.md; the others by inverting their
 * inverse as a matrix), and the LF of the varblocks from their lowest frequencies
 */
import { dct2d, inverseTransform, scaleF } from './dct.ts';
import { SIZES, single } from './vardct.ts';
import { fdct8, fdct16, fdct32, fdct64 } from './fdct.ts';

/** A sparse matrix (64 x 64): per row its non-zero entries' columns and values */
interface Sparse {
    start: Int32Array;
    column: Int32Array;
    value: Float64Array;
}

const forwardMatrices = new Map<number, Sparse>();

// the forward transform of a special 8x8 type: the inverse of its inverse's matrix (Gauss-Jordan elimination), sparse
function forwardMatrix(type: number): Sparse {
    const cached = forwardMatrices.get(type);
    if (cached) return cached;
    // (the inverse transform of each unit coefficient: the columns)
    const m = new Float64Array(64 * 128), buf = new Float32Array(64);
    for (let k = 0; k < 64; k++) {
        buf.fill(0);
        buf[k] = 1;
        inverseTransform({ buf, offset: 0, stride: 8, w: 8, h: 8 }, type);
        for (let p = 0; p < 64; p++) m[p * 128 + k] = buf[p];
    }
    for (let i = 0; i < 64; i++) m[i * 128 + 64 + i] = 1;
    for (let col = 0; col < 64; col++) {
        let pivot = col;
        for (let r = col + 1; r < 64; r++) if (Math.abs(m[r * 128 + col]) > Math.abs(m[pivot * 128 + col])) pivot = r;
        if (pivot !== col) {
            for (let k = 0; k < 128; k++) {
                const t = m[col * 128 + k];
                m[col * 128 + k] = m[pivot * 128 + k];
                m[pivot * 128 + k] = t;
            }
        }
        const inv = 1 / m[col * 128 + col];
        for (let k = 0; k < 128; k++) m[col * 128 + k] *= inv;
        for (let r = 0; r < 64; r++) {
            if (r === col) continue;
            const factor = m[r * 128 + col];
            if (factor) for (let k = 0; k < 128; k++) m[r * 128 + k] -= factor * m[col * 128 + k];
        }
    }
    const start = new Int32Array(65), column: number[] = [], value: number[] = [];
    for (let r = 0; r < 64; r++) {
        for (let k = 0; k < 64; k++) {
            const v = m[r * 128 + 64 + k];
            if (Math.abs(v) < 1e-9) continue;
            column.push(k);
            value.push(v);
        }
        start[r + 1] = column.length;
    }
    const f = { start, column: Int32Array.from(column), value: Float64Array.from(value) };
    forwardMatrices.set(type, f);
    return f;
}

const px = new Float64Array(64), tmp = new Float32Array(64), block4 = new Float32Array(16);

// the 2x2 sums and differences of the top s x s of a block (libjxl's DCT2TopBlock)
function dct2Top(src: Float32Array, so: number, stride: number, out: Float32Array, size: number): void {
    const n = size / 2;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const o = so + y * 2 * stride + x * 2;
            const c00 = src[o], c01 = src[o + 1], c10 = src[o + stride], c11 = src[o + stride + 1];
            tmp[y * 8 + x] = (c00 + c01 + c10 + c11) * 0.25;
            tmp[y * 8 + n + x] = (c00 + c01 - c10 - c11) * 0.25;
            tmp[(y + n) * 8 + x] = (c00 - c01 + c10 - c11) * 0.25;
            tmp[(y + n) * 8 + n + x] = (c00 - c01 - c10 + c11) * 0.25;
        }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[y * 8 + x] = tmp[y * 8 + x];
}

// the 2x2 DCT of the top left coefficients
function dct2x2Corner(c: Float32Array): void {
    const b00 = c[0], b01 = c[1], b10 = c[8], b11 = c[9];
    c[0] = (b00 + b01 + b10 + b11) * 0.25;
    c[1] = (b00 + b01 - b10 - b11) * 0.25;
    c[8] = (b00 - b01 + b10 - b11) * 0.25;
    c[9] = (b00 - b01 - b10 + b11) * 0.25;
}

// the special 8x8 transforms with a direct forward transform (libjxl's TransformFromPixels): DCT2X2, DCT4X4, IDENTITY
function special8x8(type: number, src: Float32Array, so: number, stride: number, c: Float32Array): boolean {
    if (type === 2) {
        dct2Top(src, so, stride, c, 8);
        dct2Top(c, 0, 8, c, 4);
        dct2Top(c, 0, 8, c, 2);
        return true;
    }
    if (type === 3) {
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 2; x++) {
                for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) block4[iy * 4 + ix] = src[so + (y * 4 + iy) * stride + x * 4 + ix];
                dct2d({ buf: block4, offset: 0, stride: 4, w: 4, h: 4 }, false);
                // (transposed, like libjxl's scaled DCT of square blocks)
                for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) c[(y + iy * 2) * 8 + x + ix * 2] = block4[ix * 4 + iy];
            }
        }
        dct2x2Corner(c);
        return true;
    }
    if (type === 1) {
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 2; x++) {
                let dc = 0;
                for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) dc += src[so + (y * 4 + iy) * stride + x * 4 + ix];
                const center = src[so + (y * 4 + 1) * stride + x * 4 + 1];
                for (let iy = 0; iy < 4; iy++) {
                    for (let ix = 0; ix < 4; ix++) {
                        if (ix === 1 && iy === 1) continue;
                        c[(y + iy * 2) * 8 + x + ix * 2] = src[so + (y * 4 + iy) * stride + x * 4 + ix] - center;
                    }
                }
                c[(y + 2) * 8 + x + 2] = c[y * 8 + x];
                c[y * 8 + x] = dc / 16;
            }
        }
        dct2x2Corner(c);
        return true;
    }
    return false;
}

// the DCT of a w x h block in place (rows, then columns), unrolled up to 64 points (direct calls, which inline)
function dct2(buf: Float32Array, w: number, h: number): void {
    if (w === 8 && h === 8) {
        for (let y = 0; y < 64; y += 8) fdct8(buf, y, 1);
        for (let x = 0; x < 8; x++) fdct8(buf, x, 8);
        return;
    }
    if (w > 64 || h > 64) {
        dct2d({ buf, offset: 0, stride: w, w, h }, false);
        return;
    }
    for (let y = 0; y < h; y++) fdct(buf, y * w, 1, w);
    for (let x = 0; x < w; x++) fdct(buf, x, w, h);
}

function fdct(buf: Float32Array, o: number, step: number, n: number): void {
    if (n === 8) fdct8(buf, o, step);
    else if (n === 16) fdct16(buf, o, step);
    else if (n === 32) fdct32(buf, o, step);
    else fdct64(buf, o, step);
}

/**
 * The forward transform of a varblock of a type: the pixels at src[so] (rows stride apart) become its coefficients
 * (in the decoder's layout, rows of the varblock's width) and the LF of its 8x8 blocks (rows of its width in blocks)
 */
export function forwardTransform(type: number, src: Float32Array, so: number, stride: number, coeffs: Float32Array, lf: Float32Array): void {
    const w8 = SIZES[2 * type], h8 = SIZES[2 * type + 1], w = w8 * 8, h = h8 * 8;
    if (single(type) && type !== 0) {
        if (special8x8(type, src, so, stride, coeffs)) {
            lf[0] = coeffs[0];
            return;
        }
        const { start, column, value } = forwardMatrix(type);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[y * 8 + x] = src[so + y * stride + x];
        for (let r = 0; r < 64; r++) {
            let v = 0;
            for (let k = start[r]; k < start[r + 1]; k++) v += value[k] * px[column[k]];
            coeffs[r] = v;
        }
        lf[0] = coeffs[0];
        return;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) coeffs[y * w + x] = src[so + y * stride + x];
    dct2(coeffs, w, h);
    if (type === 0) {
        lf[0] = coeffs[0];
        return;
    }
    // (the LF: the inverse DCT of the lowest frequencies, scaled; on a copy, the coefficients stay)
    const lw = 31 - Math.clz32(w8), lh = 31 - Math.clz32(h8);
    for (let y = 0; y < h8; y++) for (let x = 0; x < w8; x++) lf[y * w8 + x] = coeffs[y * w + x] * scaleF(y, 5 - lh) * scaleF(x, 5 - lw);
    dct2d({ buf: lf, offset: 0, stride: w8, w: w8, h: h8 }, true);
}
