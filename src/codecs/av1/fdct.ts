/*!
 * AV1 forward transforms for the encoder: the projection of residuals onto the basis of the decoder's inverse
 * transforms (itx.ts), so that the inverse transform of the coefficients gives back the residuals (with the same
 * scaling and pass shifts)
 */
import { TXFM_DIMENSIONS } from './tables.ts';
import { inverseBasis, transformTypes1D, passShift } from './itx.ts';

// the pseudo inverse (B^T B)^-1 B^T of a basis of n x k values: k x n
function pseudoInverse(b: Float64Array, n: number, k: number): Float64Array {
    const g = new Float64Array(k * 2 * k);
    for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) {
            let s = 0;
            for (let r = 0; r < n; r++) s += b[r * k + i] * b[r * k + j];
            g[i * 2 * k + j] = s;
        }
        g[i * 2 * k + k + i] = 1;
    }
    // Gauss-Jordan elimination with partial pivoting
    for (let c = 0; c < k; c++) {
        let p = c;
        for (let r = c + 1; r < k; r++) if (Math.abs(g[r * 2 * k + c]) > Math.abs(g[p * 2 * k + c])) p = r;
        if (p !== c) {
            for (let j = 0; j < 2 * k; j++) {
                const t = g[c * 2 * k + j];
                g[c * 2 * k + j] = g[p * 2 * k + j];
                g[p * 2 * k + j] = t;
            }
        }
        const pivot = g[c * 2 * k + c];
        for (let j = 0; j < 2 * k; j++) g[c * 2 * k + j] /= pivot;
        for (let r = 0; r < k; r++) {
            if (r === c) continue;
            const f = g[r * 2 * k + c];
            if (f) for (let j = 0; j < 2 * k; j++) g[r * 2 * k + j] -= f * g[c * 2 * k + j];
        }
    }
    const out = new Float64Array(k * n);
    for (let i = 0; i < k; i++) {
        for (let r = 0; r < n; r++) {
            let s = 0;
            for (let j = 0; j < k; j++) s += g[i * 2 * k + k + j] * b[r * k + j];
            out[i * n + r] = s;
        }
    }
    return out;
}

const projections = new Map<number, Float64Array>();
const projection = (log2: number, type: number): Float64Array => {
    const key = log2 * 4 + type;
    let p = projections.get(key);
    if (!p) {
        const n = 4 << log2;
        projections.set(key, p = pseudoInverse(inverseBasis(log2, type), n, Math.min(n, 32)));
    }
    return p;
};

const tmp = new Float64Array(64 * 32);

// the unnormalized DCT-II (X_k = sum of x_i cos(pi (2i + 1) k / 2n)) of n values at x[o] (step 1) in place, by Lee's
// recursion (scratch: n values)
// (1 / (2 cos(pi (2i + 1) / 2n)) for n = 2-64, at n / 2 + i)
const TWIDDLES = new Float64Array(64);
for (let n = 2; n <= 64; n *= 2) for (let i = 0; i < n / 2; i++) TWIDDLES[n / 2 + i] = 1 / (2 * Math.cos(Math.PI * (2 * i + 1) / (2 * n)));

function dct(x: Float64Array, o: number, n: number, scratch: Float64Array, so: number): void {
    if (n === 1) return;
    const half = n / 2;
    if (n === 2) {
        const a = x[o], b = x[o + 1];
        x[o] = a + b;
        x[o + 1] = (a - b) * TWIDDLES[1];
        return;
    }
    for (let i = 0; i < half; i++) {
        const a = x[o + i], b = x[o + n - 1 - i];
        scratch[so + i] = a + b;
        scratch[so + half + i] = (a - b) * TWIDDLES[half + i];
    }
    dct(scratch, so, half, x, o);
    dct(scratch, so + half, half, x, o + half);
    for (let k = 0; k < half; k++) {
        x[o + 2 * k] = scratch[so + k];
        x[o + 2 * k + 1] = scratch[so + half + k] + (k + 1 < half ? scratch[so + half + k + 1] : 0);
    }
}

// the scale of each DCT frequency that gives the projection's coefficients
const dctScales = new Map<number, Float64Array>();
const dctScale = (log2: number): Float64Array => {
    let s = dctScales.get(log2);
    if (!s) {
        const n = 4 << log2, k = Math.min(n, 32), p = projection(log2, 0);
        s = Float64Array.from({ length: k }, (_, j) => p[j * n] / Math.cos(Math.PI * j / (2 * n)));
        dctScales.set(log2, s);
    }
    return s;
};

const line = new Float64Array(64), scratch = new Float64Array(64);

// one dimension of the forward transform: n values (step) into k coefficients (step out), by the fast DCT or the
// projection matrix
function forward1D(log2: number, type: number, inp: Float64Array, io: number, step: number, out: Float64Array, oo: number, outStep: number): void {
    const n = 4 << log2, k = Math.min(n, 32);
    if (type === 0) {
        for (let i = 0; i < n; i++) line[i] = inp[io + i * step];
        dct(line, 0, n, scratch, 0);
        const s = dctScale(log2);
        for (let j = 0; j < k; j++) out[oo + j * outStep] = line[j] * s[j];
        return;
    }
    const p = projection(log2, type);
    for (let j = 0; j < k; j++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += p[j * n + i] * inp[io + i * step];
        out[oo + j * outStep] = sum;
    }
}

/**
 * The coefficients of residuals (w x h, rows of w) for a transform size and type, in the decoder's layout:
 * out[y + x * min(h, 32)] for the min(w, 32) x min(h, 32) coefficients
 */
export function forwardTransform(res: Float64Array, tx: number, txtp: number, out: Float64Array): void {
    const w = 4 * TXFM_DIMENSIONS[tx * 8], h = 4 * TXFM_DIMENSIONS[tx * 8 + 1];
    const lw = TXFM_DIMENSIONS[tx * 8 + 2], lh = TXFM_DIMENSIONS[tx * 8 + 3];
    const kw = Math.min(w, 32), kh = Math.min(h, 32);
    const [rowType, colType] = transformTypes1D(txtp);
    // (the inverse: the columns of the rows' output, shifted between the passes, rectangular ones scaled by 181 / 256,
    // the result by 1 / 16)
    const scale = 16 * 2 ** passShift(tx) / (w * 2 === h || h * 2 === w ? 181 / 256 : 1);
    // rows (h x kw), then columns
    for (let y = 0; y < h; y++) forward1D(lw, rowType, res, y * w, 1, tmp, y * kw, 1);
    for (let kx = 0; kx < kw; kx++) forward1D(lh, colType, tmp, kx, kw, out, kx * kh, 1);
    for (let i = 0; i < kw * kh; i++) out[i] *= scale;
}

const energies = new Map<number, number>();

/**
 * The squared error in pixels of a unit error of a coefficient of a transform size (on average over the coefficients,
 * of the DCT's basis)
 */
export function pixelEnergy(tx: number): number {
    let e = energies.get(tx);
    if (e === undefined) {
        const w = 4 * TXFM_DIMENSIONS[tx * 8], h = 4 * TXFM_DIMENSIONS[tx * 8 + 1];
        const lw = TXFM_DIMENSIONS[tx * 8 + 2], lh = TXFM_DIMENSIONS[tx * 8 + 3];
        const norm = (log2: number): number => {
            const n = 4 << log2, k = Math.min(n, 32), b = inverseBasis(log2, 0);
            let s = 0;
            for (let i = 0; i < n * k; i++) s += b[i] * b[i];
            return s / k;
        };
        const scale = (w * 2 === h || h * 2 === w ? 181 / 256 : 1) / (16 * 2 ** passShift(tx));
        energies.set(tx, e = scale * scale * norm(lw) * norm(lh));
    }
    return e;
}

/**
 * The forward Walsh-Hadamard transform of lossless blocks, ported from libaom (av1_fwht4x4_c; Copyright (c) 2016,
 * Alliance for Open Media, BSD-2-Clause License, see THIRD_PARTY_NOTICES.md): the 4x4 integer residuals (rows of 4)
 * into the coefficients in libaom's order (out[row * 4 + column], unscaled: the quantized values of lossless blocks)
 */
export function forwardWht(res: Int32Array, out: Int32Array): void {
    for (let i = 0; i < 4; i++) {
        let a = res[i], b = res[4 + i], c = res[8 + i], d = res[12 + i];
        a += b;
        d -= c;
        const e = (a - d) >> 1;
        b = e - b;
        c = e - c;
        a -= c;
        d += b;
        out[i] = a;
        out[4 + i] = c;
        out[8 + i] = d;
        out[12 + i] = b;
    }
    for (let i = 0; i < 4; i++) {
        let a = out[i * 4], b = out[i * 4 + 1], c = out[i * 4 + 2], d = out[i * 4 + 3];
        a += b;
        d -= c;
        const e = (a - d) >> 1;
        b = e - b;
        c = e - c;
        a -= c;
        d += b;
        out[i * 4] = a;
        out[i * 4 + 1] = c;
        out[i * 4 + 2] = d;
        out[i * 4 + 3] = b;
    }
}
