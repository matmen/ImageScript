/*!
 * JPEG XL's restoration filters on the color channels: Gaborish (a 3x3 convolution) and the edge-preserving filter
 * (up to 3 passes of weighted averages by local differences, per 8x8 block's sigma); ported from jxl-oxide
 * (crates/jxl-render/src/filter). Copyright (c) Wonwoo Choi, MIT License (see THIRD_PARTY_NOTICES.md)
 */
import { EPF } from './frame-header.ts';
import { mirror } from './upsample.ts';

/** Gaborish on 3 w x h channels: per channel the weights of the sides and corners */
export function gaborish(channels: Float32Array[], w: number, h: number, weights: number[]): Float32Array[] {
    return channels.map((src, c) => {
        const w0 = weights[2 * c], w1 = weights[2 * c + 1], norm = 1 / (1 + 4 * w0 + 4 * w1);
        const out = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            const t = mirror(y - 1, h) * w, m = y * w, b = mirror(y + 1, h) * w;
            const at = (x: number, l: number, r: number): number =>
                (src[m + x] + (src[t + x] + src[b + x] + src[m + l] + src[m + r]) * w0 + (src[t + l] + src[t + r] + src[b + l] + src[b + r]) * w1) * norm;
            out[m] = at(0, mirror(-1, w), mirror(1, w));
            // (the columns between the edges: no mirroring; the left and center columns carried along, in the same order
            // of operations)
            let tl = src[t], tc = src[t + 1], ml = src[m], mc = src[m + 1], bl = src[b], bc = src[b + 1];
            for (let x = 1; x < w - 1; x++) {
                const tr = src[t + x + 1], mr = src[m + x + 1], br = src[b + x + 1];
                out[m + x] = (mc + (tc + bc + ml + mr) * w0 + (tl + tr + bl + br) * w1) * norm;
                tl = tc;
                tc = tr;
                ml = mc;
                mc = mr;
                bl = bc;
                bc = br;
            }
            if (w > 1) out[m + w - 1] = at(w - 1, w - 2, mirror(w, w));
        }
        return out;
    });
}

// per pass: the displacements of the taps (each also negated), whether the distances are summed over a plus
const STEPS = [
    { u: [0, 1, 0, 2, 1, 0, 2, 0, 1, 1, -1, 1], plus: true },
    { u: [0, 1, 1, 0], plus: true },
    { u: [0, 1, 1, 0], plus: false }
];
const STRIP = 128;

// a row of the weighted differences of 3 channels to a displacement (columns: mirrored x of padded column + 5)
function diffRow(i0: Float32Array, i1: Float32Array, i2: Float32Array, ry: number, ruy: number, xs: Int32Array, ux: number, d: Float64Array, o: number, pw: number, s0: number, s1: number, s2: number): void {
    // (the columns whose samples need no mirroring: x and x + ux within the row)
    const lo = Math.max(3, 3 - ux), hi = Math.min(pw - 3, pw - 3 - ux);
    for (let px = 0; px < pw; px++) {
        if (px === lo && lo < hi) {
            for (let a = ry + px - 3, b = ruy + px - 3 + ux; px < hi; px++, a++, b++) {
                d[o + px] = s0 * Math.abs(i0[b] - i0[a]) + s1 * Math.abs(i1[b] - i1[a]) + s2 * Math.abs(i2[b] - i2[a]);
            }
            if (px >= pw) break;
        }
        const a = ry + xs[px + 2], b = ruy + xs[px + 2 + ux];
        d[o + px] = s0 * Math.abs(i0[b] - i0[a]) + s1 * Math.abs(i1[b] - i1[a]) + s2 * Math.abs(i2[b] - i2[a]);
    }
}

function plusRow(d: Float64Array, sum: Float64Array, o: number, pw: number): void {
    for (let px = 1, k = o + 1; px < pw - 1; px++, k++) sum[k] = d[k] + d[k - 1] + d[k + 1] + d[k - pw] + d[k + pw];
}

// a row of a pass's output: per tap pair the distances at p (+u) and p - u (-u); rows: the source rows of y - 2..y + 2
function outputRow(cur: Float32Array[], out: Float32Array[], y: number, w: number, sums: Float64Array[], p0: number, pw: number, u: number[],
    rows: Int32Array, xs: Int32Array, sigma: Float32Array | null, sigmaRow: number, sigmaModular: number, stepMul: number, borderMul: number): void {
    const [i0, i1, i2] = cur, [o0, o1, o2] = out, n = u.length / 2, yBorder = ((y + 1) & 6) === 0;
    // (rows 2 away from the edges: the taps without mirroring)
    const innerRow = rows[0] === (y - 2) * w && rows[4] === (y + 2) * w;
    const row = y * w;
    // per tap pair: the offsets of +u in the sums and in the row
    const sumOff = TAPS.subarray(0, n), srcOff = TAPS.subarray(8, 8 + n);
    for (let k = 0; k < n; k++) {
        sumOff[k] = u[2 * k + 1] * pw + u[2 * k];
        srcOff[k] = u[2 * k + 1] * w + u[2 * k];
    }
    for (let x0 = 0; x0 < w; x0 += 8) {
        const x1 = Math.min(x0 + 8, w);
        const sg = sigma ? sigma[sigmaRow + (x0 >> 3)] : sigmaModular;
        if (sg < 0.3) {
            o0.set(i0.subarray(row + x0, row + x1), row + x0);
            o1.set(i1.subarray(row + x0, row + x1), row + x0);
            o2.set(i2.subarray(row + x0, row + x1), row + x0);
            continue;
        }
        // (the block's columns 0 and 7, and its rows 0 and 7, are weighted by borderMul)
        const borderInvSigma = 6.6 * (Math.SQRT1_2 - 1) / sg * (stepMul * borderMul), innerInvSigma = 6.6 * (Math.SQRT1_2 - 1) / sg * stepMul;
        if (n === 2 && innerRow && x0 >= 2 && x1 <= w - 2) {
            // (the passes of 2 tap pairs, below and right, inside the frame: unrolled, the same order of operations)
            const sa = sums[0], sb = sums[1], soA = sumOff[0], soB = sumOff[1], toA = srcOff[0], toB = srcOff[1];
            for (let x = x0; x < x1; x++) {
                const i = row + x, p = p0 + x;
                const negInvSigma = yBorder || (x & 7) === 0 || (x & 7) === 7 ? borderInvSigma : innerInvSigma;
                let sumW = 1, sum0 = i0[i], sum1 = i1[i], sum2 = i2[i];
                let weight = 1 + sa[p] * negInvSigma;
                if (weight > 0) {
                    sumW += weight;
                    sum0 += weight * i0[i + toA];
                    sum1 += weight * i1[i + toA];
                    sum2 += weight * i2[i + toA];
                }
                weight = 1 + sa[p - soA] * negInvSigma;
                if (weight > 0) {
                    sumW += weight;
                    sum0 += weight * i0[i - toA];
                    sum1 += weight * i1[i - toA];
                    sum2 += weight * i2[i - toA];
                }
                weight = 1 + sb[p] * negInvSigma;
                if (weight > 0) {
                    sumW += weight;
                    sum0 += weight * i0[i + toB];
                    sum1 += weight * i1[i + toB];
                    sum2 += weight * i2[i + toB];
                }
                weight = 1 + sb[p - soB] * negInvSigma;
                if (weight > 0) {
                    sumW += weight;
                    sum0 += weight * i0[i - toB];
                    sum1 += weight * i1[i - toB];
                    sum2 += weight * i2[i - toB];
                }
                o0[i] = sum0 / sumW;
                o1[i] = sum1 / sumW;
                o2[i] = sum2 / sumW;
            }
            continue;
        }
        for (let x = x0; x < x1; x++) {
            const i = row + x;
            const negInvSigma = yBorder || (x & 7) === 0 || (x & 7) === 7 ? borderInvSigma : innerInvSigma;
            let sumW = 1, sum0 = i0[i], sum1 = i1[i], sum2 = i2[i];
            const p = p0 + x;
            if (innerRow && x >= 2 && x < w - 2) {
                for (let k = 0; k < n; k++) {
                    const sum = sums[k], so = sumOff[k], to = srcOff[k];
                    let weight = 1 + sum[p] * negInvSigma;
                    if (weight > 0) {
                        sumW += weight;
                        sum0 += weight * i0[i + to];
                        sum1 += weight * i1[i + to];
                        sum2 += weight * i2[i + to];
                    }
                    weight = 1 + sum[p - so] * negInvSigma;
                    if (weight > 0) {
                        sumW += weight;
                        sum0 += weight * i0[i - to];
                        sum1 += weight * i1[i - to];
                        sum2 += weight * i2[i - to];
                    }
                }
            } else {
                for (let k = 0; k < n; k++) {
                    const ux = u[2 * k], uy = u[2 * k + 1], sum = sums[k];
                    let weight = 1 + sum[p] * negInvSigma;
                    if (weight > 0) {
                        const t = rows[2 + uy] + xs[x + 5 + ux];
                        sumW += weight;
                        sum0 += weight * i0[t];
                        sum1 += weight * i1[t];
                        sum2 += weight * i2[t];
                    }
                    weight = 1 + sum[p - uy * pw - ux] * negInvSigma;
                    if (weight > 0) {
                        const t = rows[2 - uy] + xs[x + 5 - ux];
                        sumW += weight;
                        sum0 += weight * i0[t];
                        sum1 += weight * i1[t];
                        sum2 += weight * i2[t];
                    }
                }
            }
            o0[i] = sum0 / sumW;
            o1[i] = sum1 / sumW;
            o2[i] = sum2 / sumW;
        }
    }
}
const TAPS = new Int32Array(16);

/**
 * The edge-preserving filter on 3 w x h channels
 * @param sigma the sigma of each 8x8 block (bw per row), or null for e.sigmaForModular everywhere
 */
export function epf(channels: Float32Array[], w: number, h: number, e: EPF, sigma: Float32Array | null, bw: number): Float32Array[] {
    let cur = channels;
    const steps = e.iters === 3 ? [0, 1, 2] : e.iters === 2 ? [1, 2] : [1];
    // (the strips' planes are padded by 3; xs: mirrored columns from -5)
    const pw = w + 6, ph = STRIP + 6;
    const diffs = Array.from({ length: 6 }, () => new Float64Array(pw * ph)), sums = Array.from({ length: 6 }, () => new Float64Array(pw * ph));
    const xs = new Int32Array(w + 10);
    for (let x = 0; x < xs.length; x++) xs[x] = mirror(x - 5, w);
    const rows = new Int32Array(5);
    for (const step of steps) {
        const out = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
        const { u, plus } = STEPS[step], n = u.length / 2;
        const stepMul = step === 0 ? e.pass0SigmaScale : step === 2 ? e.pass2SigmaScale : 1;
        const [s0, s1, s2] = e.channelScale;
        const [i0, i1, i2] = cur;
        for (let y0 = 0; y0 < h; y0 += STRIP) {
            const strip = Math.min(STRIP, h - y0);
            // the weighted differences to each displacement at q (padded: q + 3), summed over the plus around each p
            for (let k = 0; k < n; k++) {
                const ux = u[2 * k], uy = u[2 * k + 1], d = diffs[k], sum = sums[k];
                for (let py = 0; py < strip + 6; py++) {
                    diffRow(i0, i1, i2, mirror(y0 + py - 3, h) * w, mirror(y0 + py - 3 + uy, h) * w, xs, ux, d, py * pw, pw, s0, s1, s2);
                }
                if (!plus) sum.set(d);
                else for (let py = 1; py < strip + 5; py++) plusRow(d, sum, py * pw, pw);
            }
            for (let ry = 0; ry < strip; ry++) {
                const y = y0 + ry;
                for (let k = 0; k < 5; k++) rows[k] = mirror(y + k - 2, h) * w;
                outputRow(cur, out, y, w, sums, (ry + 3) * pw + 3, pw, u, rows, xs, sigma, (y >> 3) * bw, e.sigmaForModular, stepMul, e.borderSadMul);
            }
        }
        cur = out;
    }
    return cur;
}
