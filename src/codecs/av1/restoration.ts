/*!
 * AV1 superres upscaling and loop restoration (Wiener and self guided filters), as the AV1 specification describes them
 * (sections 7.16, 7.17) and dav1d implements them (src/looprestoration_tmpl.c, src/mc_tmpl.c), with dav1d's tables.
 * Copyright (c) 2018-2021, VideoLAN and dav1d authors, Copyright (c) 2018, Two Orioles, LLC, BSD-2-Clause License (see
 * THIRD_PARTY_NOTICES.md)
 */

import { Frame } from './decode.ts';
import { RESTORATION_NONE, RESTORATION_WIENER } from './obu.ts';
import { RESIZE_FILTER } from './tables.ts';

/** Upscales the planes horizontally to the upscaled width (superres), returns the new planes and strides */
export function superres(f: Frame, planes: Uint16Array[]): { planes: Uint16Array[], strides: number[] } {
    const out: Uint16Array[] = [], strides: number[] = [];
    const max = f.bitdepthMax;
    for (let p = 0; p < planes.length; p++) {
        const subX = p ? f.ssx : 0, subY = p ? f.ssy : 0;
        const downW = f.width + subX >> subX, upW = f.hdr.upscaledWidth + subX >> subX, h = f.height + subY >> subY;
        const stepX = Math.floor(((downW << 14) + (upW >> 1)) / upW);
        const err = upW * stepX - (downW << 14);
        let initialSubpelX = Math.trunc((-((upW - downW) << 13) + (upW >> 1)) / upW) + (1 << 7) - Math.trunc(err / 2);
        initialSubpelX &= (1 << 14) - 1;
        const maxX = ((f.bw >> subX) * 4) - 1;
        const src = planes[p], srcStride = f.strides[p];
        const stride = upW + 31 & ~31;
        const dst = new Uint16Array(stride * (h + 8));
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < upW; x++) {
                const srcX = -(1 << 14) + initialSubpelX + x * stepX;
                const px = srcX >> 14, subpel = (srcX & (1 << 14) - 1) >> 8;
                let sum = 0;
                for (let k = 0; k < 8; k++) {
                    const sx = Math.min(maxX, Math.max(0, px + k - 3));
                    sum -= src[y * srcStride + sx] * RESIZE_FILTER[subpel * 8 + k];
                }
                const v = (sum + 64) >> 7;
                dst[y * stride + x] = v < 0 ? 0 : v > max ? max : v;
            }
        }
        out.push(dst);
        strides.push(stride);
    }
    return { planes: out, strides };
}

// Sgr_Params: radius and eps of the two passes
const SGR = [
    [2, 12, 1, 4], [2, 15, 1, 6], [2, 18, 1, 8], [2, 21, 1, 9], [2, 24, 1, 10], [2, 29, 1, 11], [2, 36, 1, 12],
    [2, 45, 1, 13], [2, 56, 1, 14], [2, 68, 1, 15], [0, 0, 1, 5], [0, 0, 1, 8], [0, 0, 1, 11], [0, 0, 1, 14],
    [2, 30, 0, 0], [2, 75, 0, 0]
];


/**
 * Applies loop restoration: reads the CDEF output (cdef) and, across the edges of the 64 row stripes, the deblocked
 * frame before CDEF (pre), writes into out (a copy of cdef)
 */
export function loopRestoration(f: Frame, pre: Uint16Array[], cdef: Uint16Array[], out: Uint16Array[], strides: number[]): void {
    const hdr = f.hdr, bitdepth = f.bitdepth, max = f.bitdepthMax;
    for (let p = 0; p < out.length; p++) {
        if (hdr.restoration.types[p] === RESTORATION_NONE) continue;
        const subX = p ? f.ssx : 0, subY = p ? f.ssy : 0;
        const planeW = hdr.upscaledWidth + subX >> subX, planeH = f.height + subY >> subY;
        const unitSize = 1 << hdr.restoration.unitSizeLog2[p ? 1 : 0];
        const unitCols = f.lrUnitsW[p], unitRows = f.lrUnitsH[p];
        const stride = strides[p], cur = pre[p], cd = cdef[p], dst = out[p];

        for (let stripe = 0; (-8 + stripe * 64) >> subY < planeH; stripe++) {
            const stripeStart = (-8 + stripe * 64) >> subY, stripeEnd = stripeStart + (64 >> subY) - 1;
            const y0 = Math.max(0, stripeStart), y1 = Math.min(planeH, stripeEnd + 1);
            if (y0 >= y1) continue;
            // the unit row of the stripe's (first) 4x4 block row
            const lumaRow = Math.max(0, stripe * 64 - 8) >> 2;
            const unitRow = Math.min(unitRows - 1, Math.floor(((lumaRow * 4 + 8) >> subY) / unitSize));
            // samples: clamped to the plane, outside the stripe from the frame before CDEF (at most 2 rows away)
            const sample = (x: number, y: number): number => {
                x = Math.max(0, Math.min(planeW - 1, x));
                y = Math.max(0, Math.min(planeH - 1, y));
                if (y < stripeStart) return cur[Math.max(stripeStart - 2, y) * stride + x];
                if (y > stripeEnd) return cur[Math.min(stripeEnd + 2, y) * stride + x];
                return cd[y * stride + x];
            };

            for (let unitCol = 0; unitCol < unitCols; unitCol++) {
                const x0 = unitCol * unitSize, x1 = unitCol === unitCols - 1 ? planeW : Math.min(planeW, x0 + unitSize);
                const unit = f.lr[p][unitRow * unitCols + unitCol];
                const w = x1 - x0, h = y1 - y0;
                // the samples around the block, 3 on each side
                const ww = w + 6, win = new Int32Array(ww * (h + 6));
                for (let y = 0; y < h + 6; y++) for (let x = 0; x < ww; x++) win[y * ww + x] = sample(x0 + x - 3, y0 + y - 3);
                if (unit.type === RESTORATION_WIENER) wiener(win, ww, w, h, unit.filterV, unit.filterH, bitdepth, dst, y0 * stride + x0, stride);
                else if (unit.type !== RESTORATION_NONE) selfGuided(win, ww, w, h, unit.type - 3, unit.sgrWeights, bitdepth, cd, dst, y0 * stride + x0, stride, max);
            }
        }
    }
}

function wienerFilter(coeff: number[]): number[] {
    const filter = [coeff[0], coeff[1], coeff[2], 128, coeff[2], coeff[1], coeff[0]];
    filter[3] -= 2 * (coeff[0] + coeff[1] + coeff[2]);
    return filter;
}

function wiener(win: Int32Array, ww: number, w: number, h: number, v: number[], hf: number[], bitdepth: number, dst: Uint16Array, d: number, stride: number): void {
    const round0 = bitdepth === 12 ? 5 : 3, round1 = bitdepth === 12 ? 9 : 11;
    const vfilter = wienerFilter(v), hfilter = wienerFilter(hf);
    const offset = 1 << (bitdepth + 7 - round0 - 1), limit = (1 << (bitdepth + 1 + 7 - round0)) - 1;
    const max = (1 << bitdepth) - 1;
    const inter = new Int32Array(w * (h + 6));
    for (let r = 0; r < h + 6; r++) {
        for (let c = 0; c < w; c++) {
            let s = 0;
            for (let t = 0; t < 7; t++) s += hfilter[t] * win[r * ww + c + t];
            const x = (s + (1 << (round0 - 1))) >> round0;
            inter[r * w + c] = x < -offset ? -offset : x > limit - offset ? limit - offset : x;
        }
    }
    for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
            let s = 0;
            for (let t = 0; t < 7; t++) s += vfilter[t] * inter[(r + t) * w + c];
            const x = (s + (1 << (round1 - 1))) >> round1;
            dst[d + r * stride + c] = x < 0 ? 0 : x > max ? max : x;
        }
    }
}

// the box filter of a pass: F for the block (w x h)
function boxFilter(win: Int32Array, ww: number, w: number, h: number, r: number, eps: number, pass: number, bitdepth: number, cd: Uint16Array, d: number, stride: number): Int32Array {
    const n = (2 * r + 1) * (2 * r + 1), n2e = n * n * eps;
    const s = Math.floor(((1 << 20) + Math.floor(n2e / 2)) / n2e);
    const oneOverN = Math.floor(((1 << 12) + (n >> 1)) / n);
    const shiftA = 2 * (bitdepth - 8), shiftB = bitdepth - 8;
    const aw = w + 2, A = new Int32Array(aw * (h + 2)), B = new Int32Array(aw * (h + 2));
    // the sums of the samples and of their squares over the box around each position: rows first, then columns
    const rowSum = new Int32Array(ww), rowSq = new Float64Array(ww);
    for (let i = -1; i < h + 1; i++) {
        // the first pass only uses the odd rows
        if (pass === 0 && !(i & 1)) continue;
        rowSum.fill(0);
        rowSq.fill(0);
        for (let dy = -r; dy <= r; dy++) {
            const o = (i + dy + 3) * ww;
            for (let x = 0; x < ww; x++) {
                const c = win[o + x];
                rowSum[x] += c;
                rowSq[x] += c * c;
            }
        }
        for (let j = -1; j < w + 1; j++) {
            let a = 0, b = 0;
            for (let dx = -r; dx <= r; dx++) {
                a += rowSq[j + dx + 3];
                b += rowSum[j + dx + 3];
            }
            a = shiftA ? (a + (1 << (shiftA - 1))) >> shiftA : a;
            const dd = shiftB ? (b + (1 << (shiftB - 1))) >> shiftB : b;
            const p = Math.max(0, a * n - dd * dd);
            const z = Math.floor((p * s + (1 << 19)) / (1 << 20));
            const a2 = z >= 255 ? 256 : z === 0 ? 1 : Math.floor(((z << 8) + (z >> 1)) / (z + 1));
            A[(i + 1) * aw + j + 1] = a2;
            B[(i + 1) * aw + j + 1] = Math.floor(((256 - a2) * b * oneOverN + 2048) / 4096);
        }
    }
    const F = new Int32Array(w * h);
    for (let i = 0; i < h; i++) {
        const shift = (pass === 0 && i & 1 ? 4 : 5) + 4, rnd = 1 << (shift - 1);
        const up = i * aw, mid = (i + 1) * aw, down = (i + 2) * aw;
        for (let j = 0; j < w; j++) {
            let a: number, b: number;
            if (pass === 0) {
                // odd rows: the rows above and below (6 straight, 5 diagonal); even rows: only its own (the row is odd)
                if (i & 1) {
                    a = 6 * A[mid + j + 1] + 5 * (A[mid + j] + A[mid + j + 2]);
                    b = 6 * B[mid + j + 1] + 5 * (B[mid + j] + B[mid + j + 2]);
                } else {
                    a = 6 * (A[up + j + 1] + A[down + j + 1]) + 5 * (A[up + j] + A[up + j + 2] + A[down + j] + A[down + j + 2]);
                    b = 6 * (B[up + j + 1] + B[down + j + 1]) + 5 * (B[up + j] + B[up + j + 2] + B[down + j] + B[down + j + 2]);
                }
            } else {
                a = 4 * (A[up + j + 1] + A[mid + j] + A[mid + j + 1] + A[mid + j + 2] + A[down + j + 1]) + 3 * (A[up + j] + A[up + j + 2] + A[down + j] + A[down + j + 2]);
                b = 4 * (B[up + j + 1] + B[mid + j] + B[mid + j + 1] + B[mid + j + 2] + B[down + j + 1]) + 3 * (B[up + j] + B[up + j + 2] + B[down + j] + B[down + j + 2]);
            }
            F[i * w + j] = (a * cd[d + i * stride + j] + b + rnd) >> shift;
        }
    }
    return F;
}

function selfGuided(win: Int32Array, ww: number, w: number, h: number, set: number, weights: number[], bitdepth: number, cd: Uint16Array, dst: Uint16Array, d: number, stride: number, max: number): void {
    const [r0, e0, r1, e1] = SGR[set];
    const flt0 = r0 ? boxFilter(win, ww, w, h, r0, e0, 0, bitdepth, cd, d, stride) : null;
    const flt1 = r1 ? boxFilter(win, ww, w, h, r1, e1, 1, bitdepth, cd, d, stride) : null;
    const w0 = weights[0], w1 = weights[1], w2 = 128 - w0 - w1;
    for (let i = 0; i < h; i++) {
        for (let j = 0; j < w; j++) {
            const u = cd[d + i * stride + j] << 4;
            let v = w1 * u;
            v += flt0 ? w0 * flt0[i * w + j] : w0 * u;
            v += flt1 ? w2 * flt1[i * w + j] : w2 * u;
            const s = (v + 1024) >> 11;
            dst[d + i * stride + j] = s < 0 ? 0 : s > max ? max : s;
        }
    }
}
