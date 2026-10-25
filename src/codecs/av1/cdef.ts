/*!
 * The AV1 constrained directional enhancement filter, as the AV1 specification describes it (section 7.15) and dav1d
 * implements it (src/cdef_tmpl.c). Copyright (c) 2018-2021, VideoLAN and dav1d authors, Copyright (c) 2018, Two
 * Orioles, LLC, BSD-2-Clause License (see THIRD_PARTY_NOTICES.md)
 */

import { Frame } from './decode.ts';

const DIV_TABLE = [0, 840, 420, 280, 210, 168, 140, 120, 105];
const UV_DIR = [[[0, 1, 2, 3, 4, 5, 6, 7], [1, 2, 2, 2, 3, 4, 6, 0]], [[7, 0, 2, 4, 5, 6, 6, 6], [0, 1, 2, 3, 4, 5, 6, 7]]];
const PRI_TAPS = [[4, 2], [3, 3]], SEC_TAPS = [2, 1];
const floorLog2 = (v: number): number => 31 - Math.clz32(v);

/** whether CDEF changes the frame */
export function cdefActive(f: Frame): boolean {
    const c = f.hdr.cdef;
    return f.seq.cdef && (c.yStrengths.some(s => s) || c.uvStrengths.some(s => s));
}

/**
 * Applies CDEF: reads the deblocked frame (src, a copy of the frame's planes), writes into the frame. The directions
 * and variances of the 8x8 blocks can be kept between calls on the same source (dirs: 2 per 8x8 block, -1 for unknown)
 */
export function cdef(f: Frame, src: Uint16Array[], dirs?: Int32Array): void {
    const c = f.hdr.cdef;
    const coeffShift = f.bitdepth - 8;
    const s4 = f.b4Stride;

    for (let r = 0; r < f.bh; r += 2) {
        for (let col = 0; col < f.bw; col += 2) {
            const idx = f.cdefIdx[(r >> 4) * (s4 >> 4) + (col >> 4)];
            if (idx === -1) continue;
            const o = r * s4 + col;
            if (f.skip[o] && f.skip[o + s4] && f.skip[o + 1] && f.skip[o + s4 + 1]) continue;

            // the direction and variance of the luma block (used by the primary filters only)
            const usesDirection = c.yStrengths[idx] >> 2 || (f.planes.length > 1 && c.uvStrengths[idx] >> 2);
            let yDir = 0, variance = 0;
            if (usesDirection) {
                const k = (r >> 1) * (s4 >> 1) + (col >> 1);
                if (dirs && dirs[2 * k] >= 0) {
                    yDir = dirs[2 * k];
                    variance = dirs[2 * k + 1];
                } else {
                    yDir = direction(src[0], r * 4 * f.strides[0] + col * 4, f.strides[0], coeffShift);
                    variance = directionVariance;
                    if (dirs) {
                        dirs[2 * k] = yDir;
                        dirs[2 * k + 1] = variance;
                    }
                }
            }

            const ys = c.yStrengths[idx];
            let priStr = (ys >> 2) << coeffShift;
            const secY = ys & 3;
            const secStr = (secY === 3 ? 4 : secY) << coeffShift;
            const dir = priStr ? yDir : 0;
            const varStr = variance >> 6 ? Math.min(floorLog2(variance >> 6), 12) : 0;
            priStr = variance ? (priStr * (4 + varStr) + 8) >> 4 : 0;
            filterBlock(f, src, 0, r, col, priStr, secStr, c.damping + coeffShift, dir);

            if (f.planes.length === 1) continue;
            const uvs = c.uvStrengths[idx];
            const uvPri = (uvs >> 2) << coeffShift, secUv = uvs & 3;
            const uvSec = (secUv === 3 ? 4 : secUv) << coeffShift;
            const uvDir = uvPri ? UV_DIR[f.ssx][f.ssy][yDir] : 0;
            for (let p = 1; p < 3; p++) filterBlock(f, src, p, r, col, uvPri, uvSec, c.damping + coeffShift - 1, uvDir);
        }
    }
}

// the partial sums of the 8 directions (15 each), their costs; the variance of the last direction found
const partial = new Int32Array(8 * 15), cost = new Float64Array(8);
let directionVariance = 0;

// the direction of the 8x8 luma block at luma[o] (sets directionVariance)
function direction(luma: Uint16Array, o: number, ls: number, coeffShift: number): number {
    partial.fill(0);
    for (let i = 0; i < 8; i++) {
        const row = o + i * ls, ih = i >> 1;
        for (let j = 0; j < 8; j++) {
            const x = (luma[row + j] >> coeffShift) - 128, jh = j >> 1;
            partial[i + j] += x;
            partial[15 + i + jh] += x;
            partial[30 + i] += x;
            partial[45 + 3 + i - jh] += x;
            partial[60 + 7 + i - j] += x;
            partial[75 + 3 - ih + j] += x;
            partial[90 + j] += x;
            partial[105 + ih + j] += x;
        }
    }
    cost.fill(0);
    for (let i = 0; i < 8; i++) {
        cost[2] += partial[30 + i] * partial[30 + i];
        cost[6] += partial[90 + i] * partial[90 + i];
    }
    cost[2] *= DIV_TABLE[8];
    cost[6] *= DIV_TABLE[8];
    for (let i = 0; i < 7; i++) {
        cost[0] += (partial[i] * partial[i] + partial[14 - i] * partial[14 - i]) * DIV_TABLE[i + 1];
        cost[4] += (partial[60 + i] * partial[60 + i] + partial[60 + 14 - i] * partial[60 + 14 - i]) * DIV_TABLE[i + 1];
    }
    cost[0] += partial[7] * partial[7] * DIV_TABLE[8];
    cost[4] += partial[67] * partial[67] * DIV_TABLE[8];
    for (let i = 1; i < 8; i += 2) {
        const p = i * 15;
        for (let j = 0; j < 5; j++) cost[i] += partial[p + 3 + j] * partial[p + 3 + j];
        cost[i] *= DIV_TABLE[8];
        for (let j = 0; j < 3; j++) cost[i] += (partial[p + j] * partial[p + j] + partial[p + 10 - j] * partial[p + 10 - j]) * DIV_TABLE[2 * j + 2];
    }
    let bestCost = 0, yDir = 0;
    for (let i = 0; i < 8; i++) {
        if (cost[i] > bestCost) {
            bestCost = cost[i];
            yDir = i;
        }
    }
    directionVariance = Math.floor((bestCost - cost[(yDir + 4) & 7]) / 1024);
    return yDir;
}

// filters an 8x8 (luma, subsampled chroma) block from src into the frame; the samples outside the frame (in 4x4 units)
// aren't used
function filterBlock(f: Frame, src: Uint16Array[], plane: number, r: number, c: number, priStr: number, secStr: number, damping: number, dir: number): void {
    if (!priStr && !secStr) return;
    const subX = plane ? f.ssx : 0, subY = plane ? f.ssy : 0;
    const s = src[plane], dst = f.planes[plane], stride = f.strides[plane];
    const x0 = (c * 4) >> subX, y0 = (r * 4) >> subY, w = 8 >> subX, h = 8 >> subY;
    const maxX = (f.bw * 4) >> subX, maxY = (f.bh * 4) >> subY;
    const priTaps = PRI_TAPS[(priStr >> (f.bitdepth - 8)) & 1];
    // the shifts of constrain (damping minus the log2 of the strength)
    const priShift = priStr ? Math.max(0, damping - floorLog2(priStr)) : 0, secShift = secStr ? Math.max(0, damping - floorLog2(secStr)) : 0;
    // the taps (the primary direction's two, then the two secondary directions') as offsets and as (y, x)
    for (let n = 0; n < 6; n++) {
        const t = n >> 1, k = n & 1;
        const d = (t === 0 ? dir : t === 1 ? dir + 6 : dir + 2) & 7;
        const dy = DIRECTIONS[d * 4 + k * 2], dx = DIRECTIONS[d * 4 + k * 2 + 1];
        offsets[n] = dy * stride + dx;
        dys[n] = dy;
        dxs[n] = dx;
        taps[n] = t ? SEC_TAPS[k] : priTaps[k];
        strengths[n] = t ? secStr : priStr;
        shifts[n] = t ? secShift : priShift;
    }
    // the taps reach 2 samples around: blocks that far inside the frame need no checks
    if (x0 >= 2 && y0 >= 2 && x0 + w + 2 <= maxX && y0 + h + 2 <= maxY) {
        const p0 = offsets[0], p1 = offsets[1], s0 = offsets[2], s1 = offsets[3], s2 = offsets[4], s3 = offsets[5];
        const t0 = priTaps[0], t1 = priTaps[1];
        // constrain by the difference (offset by the largest one)
        const off = (1 << f.bitdepth) - 1;
        const P = constrainTable(priStr, priShift, f.bitdepth), S = constrainTable(secStr, secShift, f.bitdepth);
        for (let i = 0; i < h; i++) {
            for (let j = 0, o = (y0 + i) * stride + x0; j < w; j++, o++) {
                const x = s[o];
                const a0 = s[o + p0], b0 = s[o - p0], a1 = s[o + p1], b1 = s[o - p1];
                const c0 = s[o + s0], d0 = s[o - s0], c1 = s[o + s1], d1 = s[o - s1];
                const e0 = s[o + s2], f0 = s[o - s2], e1 = s[o + s3], f1 = s[o - s3];
                const ox = off - x;
                const sum = t0 * (P[a0 + ox] + P[b0 + ox]) + t1 * (P[a1 + ox] + P[b1 + ox]) +
                    2 * (S[c0 + ox] + S[d0 + ox] + S[e0 + ox] + S[f0 + ox]) + S[c1 + ox] + S[d1 + ox] + S[e1 + ox] + S[f1 + ox];
                // clamped to the range of the sample and its taps, which only changes the result if it's beyond every
                // tap (cheaper than keeping the minimum and maximum)
                let v = x + ((8 + sum - (sum < 0 ? 1 : 0)) >> 4);
                if (v > x) {
                    if (v > a0 && v > b0 && v > a1 && v > b1 && v > c0 && v > d0 && v > c1 && v > d1 && v > e0 && v > f0 && v > e1 && v > f1)
                        v = Math.max(x, a0, b0, a1, b1, c0, d0, c1, d1, e0, f0, e1, f1);
                } else if (v < x) {
                    if (v < a0 && v < b0 && v < a1 && v < b1 && v < c0 && v < d0 && v < c1 && v < d1 && v < e0 && v < f0 && v < e1 && v < f1)
                        v = Math.min(x, a0, b0, a1, b1, c0, d0, c1, d1, e0, f0, e1, f1);
                }
                dst[o] = v;
            }
        }
        return;
    }
    for (let i = 0; i < h; i++) {
        const y = y0 + i;
        for (let j = 0; j < w; j++) {
            const xx = x0 + j, o = y * stride + xx;
            const x = s[o];
            let sum = 0, max = x, min = x;
            for (let t = 0; t < 6; t++) {
                for (let sign = -1; sign <= 1; sign += 2) {
                    const py = y + sign * dys[t], px = xx + sign * dxs[t];
                    if (py < 0 || px < 0 || py >= maxY || px >= maxX) continue;
                    const p = s[o + sign * offsets[t]];
                    sum += taps[t] * constrain(p - x, strengths[t], shifts[t]);
                    if (p > max) max = p;
                    if (p < min) min = p;
                }
            }
            const v = x + ((8 + sum - (sum < 0 ? 1 : 0)) >> 4);
            dst[o] = v < min ? min : v > max ? max : v;
        }
    }
}

// constrain's results by the difference plus (1 << bitdepth) - 1, by strength, shift and bitdepth
const tables = new Map<number, Int16Array>();
function constrainTable(strength: number, shift: number, bitdepth: number): Int16Array {
    const key = (strength * 32 + shift) * 16 + bitdepth;
    let t = tables.get(key);
    if (!t) {
        const off = (1 << bitdepth) - 1;
        t = new Int16Array(2 * off + 1);
        for (let d = -off; d <= off; d++) t[d + off] = constrain(d, strength, shift);
        tables.set(key, t);
    }
    return t;
}

// the difference to a tap, limited by the strength (less for larger differences)
function constrain(diff: number, strength: number, shift: number): number {
    if (!strength) return 0;
    const a = diff < 0 ? -diff : diff;
    let v = strength - (a >> shift);
    if (v > a) v = a;
    if (v <= 0) return 0;
    return diff < 0 ? -v : v;
}

// Cdef_Directions[dir][k]: the (y, x) offsets of the taps
const DIRECTIONS = new Int8Array([
    -1, 1, -2, 2, 0, 1, -1, 2, 0, 1, 0, 2, 0, 1, 1, 2,
    1, 1, 2, 2, 1, 0, 2, 1, 1, 0, 2, 0, 1, 0, 2, -1
]);
// filterBlock's taps
const offsets = new Int32Array(6), dys = new Int32Array(6), dxs = new Int32Array(6), taps = new Int32Array(6),
    strengths = new Int32Array(6), shifts = new Int32Array(6);
