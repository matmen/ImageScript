/*!
 * AV1 intra prediction: the edges of a block, and DC, directional, smooth, Paeth, filter, chroma from luma and
 * palette prediction, ported from dav1d (src/ipred_prepare_tmpl.c, src/ipred_tmpl.c). Copyright (c) 2018-2021,
 * VideoLAN and dav1d authors, Copyright (c) 2018, Two Orioles, LLC, BSD-2-Clause License (see THIRD_PARTY_NOTICES.md)
 */

import {
    DC_PRED, VERT_PRED, HOR_PRED, VERT_LEFT_PRED, SMOOTH_PRED, SMOOTH_V_PRED, SMOOTH_H_PRED, PAETH_PRED, FILTER_PRED,
    LEFT_DC_PRED, TOP_DC_PRED, DC_128_PRED, Z1_PRED, Z2_PRED, Z3_PRED, EDGE_I444_TOP_HAS_RIGHT, EDGE_I444_LEFT_HAS_BOTTOM,
    SM_WEIGHTS, DR_INTRA_DERIVATIVE, FILTER_INTRA_TAPS
} from './tables.ts';

/** Flags or'd into the angle: filter the edges, the edges are smooth (a neighbour uses smooth prediction) */
export const ANGLE_USE_EDGE_FILTER = 1024, ANGLE_SMOOTH_EDGE = 512;

/** The edge buffer: the top left pixel at EDGE, the top (and top right) after it, the left (and bottom left) before */
export const EDGE = 128;
export const edgeBuffer = new Uint16Array(2 * EDGE + 1);

const MODE_TO_ANGLE = [90, 180, 45, 135, 113, 157, 203, 67];
// the edges each predictor uses: left, top, top left, top right, bottom left
const NEEDS_LEFT = 1, NEEDS_TOP = 2, NEEDS_TOPLEFT = 4, NEEDS_TOPRIGHT = 8, NEEDS_BOTTOMLEFT = 16;
const NEEDS: number[] = [];
NEEDS[DC_PRED] = NEEDS_TOP | NEEDS_LEFT;
NEEDS[VERT_PRED] = NEEDS_TOP;
NEEDS[HOR_PRED] = NEEDS_LEFT;
NEEDS[LEFT_DC_PRED] = NEEDS_LEFT;
NEEDS[TOP_DC_PRED] = NEEDS_TOP;
NEEDS[DC_128_PRED] = 0;
NEEDS[Z1_PRED] = NEEDS_TOP | NEEDS_TOPRIGHT | NEEDS_TOPLEFT;
NEEDS[Z2_PRED] = NEEDS_LEFT | NEEDS_TOP | NEEDS_TOPLEFT;
NEEDS[Z3_PRED] = NEEDS_LEFT | NEEDS_BOTTOMLEFT | NEEDS_TOPLEFT;
NEEDS[SMOOTH_PRED] = NEEDS[SMOOTH_V_PRED] = NEEDS[SMOOTH_H_PRED] = NEEDS_LEFT | NEEDS_TOP;
NEEDS[PAETH_PRED] = NEEDS[FILTER_PRED] = NEEDS_LEFT | NEEDS_TOP | NEEDS_TOPLEFT;

/** the angle prepareEdges computed (the absolute angle of directional modes) */
export let preparedAngle = 0;

/**
 * Fills the edge buffer for a transform block at dst (x, y, w, h in 4 pixel units: the block's position and the tile's
 * (or image's) end), returns the predictor to use. The pixels above are read from the picture: it is filtered only
 * after the whole frame is decoded
 */
export function prepareEdges(x: number, haveLeft: boolean, y: number, haveTop: boolean, w: number, h: number,
    edgeFlags: number, pic: Uint16Array, dst: number, stride: number, mode: number, angle: number, tw: number, th: number,
    filterEdge: boolean, bitdepth: number): number {
    const e = edgeBuffer;
    if (mode >= VERT_PRED && mode <= VERT_LEFT_PRED) {
        angle = MODE_TO_ANGLE[mode - VERT_PRED] + 3 * angle;
        if (angle <= 90) mode = angle < 90 && haveTop ? Z1_PRED : VERT_PRED;
        else if (angle < 180) mode = Z2_PRED;
        else mode = angle > 180 && haveLeft ? Z3_PRED : HOR_PRED;
    } else if (mode === DC_PRED) {
        mode = haveLeft ? haveTop ? DC_PRED : LEFT_DC_PRED : haveTop ? TOP_DC_PRED : DC_128_PRED;
    } else if (mode === PAETH_PRED) {
        mode = haveLeft ? haveTop ? PAETH_PRED : HOR_PRED : haveTop ? VERT_PRED : DC_128_PRED;
    }
    preparedAngle = angle;
    const needs = NEEDS[mode];
    const top = dst - stride;

    if (needs & NEEDS_LEFT) {
        const sz = th << 2, left = EDGE - sz;
        if (haveLeft) {
            const have = Math.min(sz, (h - y) << 2);
            for (let i = 0; i < have; i++) e[left + sz - 1 - i] = pic[dst + stride * i - 1];
            if (have < sz) e.fill(e[left + sz - have], left, left + sz - have);
        } else e.fill(haveTop ? pic[top] : (1 << bitdepth >> 1) + 1, left, left + sz);

        if (needs & NEEDS_BOTTOMLEFT) {
            const haveBottomLeft = haveLeft && y + th < h && edgeFlags & EDGE_I444_LEFT_HAS_BOTTOM;
            if (haveBottomLeft) {
                const have = Math.min(sz, (h - y - th) << 2);
                for (let i = 0; i < have; i++) e[left - 1 - i] = pic[dst + (sz + i) * stride - 1];
                if (have < sz) e.fill(e[left - have], left - sz, left - have);
            } else e.fill(e[left], left - sz, left);
        }
    }

    if (needs & NEEDS_TOP) {
        const sz = tw << 2, t = EDGE + 1;
        if (haveTop) {
            const have = Math.min(sz, (w - x) << 2);
            for (let i = 0; i < have; i++) e[t + i] = pic[top + i];
            if (have < sz) e.fill(e[t + have - 1], t + have, t + sz);
        } else e.fill(haveLeft ? pic[dst - 1] : (1 << bitdepth >> 1) - 1, t, t + sz);

        if (needs & NEEDS_TOPRIGHT) {
            const haveTopRight = haveTop && x + tw < w && edgeFlags & EDGE_I444_TOP_HAS_RIGHT;
            if (haveTopRight) {
                const have = Math.min(sz, (w - x - tw) << 2);
                for (let i = 0; i < have; i++) e[t + sz + i] = pic[top + sz + i];
                if (have < sz) e.fill(e[t + sz + have - 1], t + sz + have, t + 2 * sz);
            } else e.fill(e[t + sz - 1], t + sz, t + 2 * sz);
        }
    }

    if (needs & NEEDS_TOPLEFT) {
        if (haveLeft) e[EDGE] = haveTop ? pic[top - 1] : pic[dst - 1];
        else e[EDGE] = haveTop ? pic[top] : 1 << bitdepth >> 1;
        if (mode === Z2_PRED && tw + th >= 6 && filterEdge) e[EDGE] = ((e[EDGE - 1] + e[EDGE + 1]) * 5 + e[EDGE] * 6 + 8) >> 4;
    }
    return mode;
}

function splat(dst: Uint16Array, d: number, stride: number, width: number, height: number, v: number): void {
    for (let y = 0; y < height; y++, d += stride) dst.fill(v, d, d + width);
}

const ctz = (v: number): number => 31 - Math.clz32(v & -v);

function dcTop(e: Uint16Array, width: number): number {
    let dc = width >> 1;
    for (let i = 0; i < width; i++) dc += e[EDGE + 1 + i];
    return dc >> ctz(width);
}

function dcLeft(e: Uint16Array, height: number): number {
    let dc = height >> 1;
    for (let i = 0; i < height; i++) dc += e[EDGE - 1 - i];
    return dc >> ctz(height);
}

function dcBoth(e: Uint16Array, width: number, height: number, hbd: boolean): number {
    let dc = (width + height) >> 1;
    for (let i = 0; i < width; i++) dc += e[EDGE + 1 + i];
    for (let i = 0; i < height; i++) dc += e[EDGE - 1 - i];
    dc >>= ctz(width + height);
    if (width !== height) {
        const quarter = width > height * 2 || height > width * 2;
        // (dav1d's multipliers for 8 and more bits)
        dc = hbd ? Math.floor(dc * (quarter ? 0x6667 : 0xAAAB) / 131072) : dc * (quarter ? 0x3334 : 0x5556) >>> 16;
    }
    return dc;
}

/** the DC value of the DC predictors (also of chroma from luma) */
export function dcValue(mode: number, width: number, height: number, bitdepthMax: number): number {
    const e = edgeBuffer;
    switch (mode) {
        case DC_PRED: return dcBoth(e, width, height, bitdepthMax > 255);
        case LEFT_DC_PRED: return dcLeft(e, height);
        case TOP_DC_PRED: return dcTop(e, width);
        default: return (bitdepthMax + 1) >> 1;
    }
}

function filterStrength(wh: number, angle: number, smooth: boolean): number {
    if (smooth) {
        if (wh <= 8) {
            if (angle >= 64) return 2;
            if (angle >= 40) return 1;
        } else if (wh <= 16) {
            if (angle >= 48) return 2;
            if (angle >= 20) return 1;
        } else if (wh <= 24) {
            if (angle >= 4) return 3;
        } else return 3;
    } else {
        if (wh <= 8) {
            if (angle >= 56) return 1;
        } else if (wh <= 16) {
            if (angle >= 40) return 1;
        } else if (wh <= 24) {
            if (angle >= 32) return 3;
            if (angle >= 16) return 2;
            if (angle >= 8) return 1;
        } else if (wh <= 32) {
            if (angle >= 32) return 3;
            if (angle >= 4) return 2;
            return 1;
        } else return 3;
    }
    return 0;
}

const KERNELS = [[0, 4, 8, 4, 0], [0, 5, 6, 5, 0], [2, 4, 4, 4, 2]];
const clampIndex = (i: number, from: number, to: number): number => i < from ? from : i > to - 1 ? to - 1 : i;

// filters the edge in[i..] (indices from..to-1 valid) into out[o..o+sz)
function filterEdge(out: Uint16Array, o: number, sz: number, limFrom: number, limTo: number, inp: Uint16Array, i0: number, from: number, to: number, strength: number): void {
    const k = KERNELS[strength - 1];
    let i = 0;
    for (; i < Math.min(sz, limFrom); i++) out[o + i] = inp[i0 + clampIndex(i, from, to)];
    for (; i < Math.min(limTo, sz); i++) {
        let s = 0;
        for (let j = 0; j < 5; j++) s += inp[i0 + clampIndex(i - 2 + j, from, to)] * k[j];
        out[o + i] = (s + 8) >> 4;
    }
    for (; i < sz; i++) out[o + i] = inp[i0 + clampIndex(i, from, to)];
}

const upsampled = (wh: number, angle: number, smooth: boolean): boolean => angle < 40 && wh <= 16 >> (smooth ? 1 : 0);

function upsampleEdge(out: Uint16Array, o: number, hsz: number, inp: Uint16Array, i0: number, from: number, to: number, bitdepthMax: number): void {
    let i: number;
    for (i = 0; i < hsz - 1; i++) {
        out[o + i * 2] = inp[i0 + clampIndex(i, from, to)];
        const s = -inp[i0 + clampIndex(i - 1, from, to)] + 9 * inp[i0 + clampIndex(i, from, to)] + 9 * inp[i0 + clampIndex(i + 1, from, to)] - inp[i0 + clampIndex(i + 2, from, to)];
        const v = (s + 8) >> 4;
        out[o + i * 2 + 1] = v < 0 ? 0 : v > bitdepthMax ? bitdepthMax : v;
    }
    out[o + i * 2] = inp[i0 + clampIndex(i, from, to)];
}

const scratch = new Uint16Array(64 + 64 + 1);

function z1(dst: Uint16Array, d: number, stride: number, width: number, height: number, angle: number, bitdepthMax: number): void {
    const e = edgeBuffer;
    const smooth = !!(angle >> 9 & 1), edgeFilter = !!(angle >> 10);
    angle &= 511;
    let dx = DR_INTRA_DERIVATIVE[angle >> 1];
    let top: Uint16Array, t0: number, maxBase: number;
    const up = edgeFilter && upsampled(width + height, 90 - angle, smooth);
    if (up) {
        upsampleEdge(scratch, 0, width + height, e, EDGE + 1, -1, width + Math.min(width, height), bitdepthMax);
        top = scratch; t0 = 0;
        maxBase = 2 * (width + height) - 2;
        dx <<= 1;
    } else {
        const strength = edgeFilter ? filterStrength(width + height, 90 - angle, smooth) : 0;
        if (strength) {
            filterEdge(scratch, 0, width + height, 0, width + height, e, EDGE + 1, -1, width + Math.min(width, height), strength);
            top = scratch; t0 = 0;
            maxBase = width + height - 1;
        } else {
            top = e; t0 = EDGE + 1;
            maxBase = width + Math.min(width, height) - 1;
        }
    }
    const inc = up ? 2 : 1;
    for (let y = 0, xpos = dx; y < height; y++, d += stride, xpos += dx) {
        const frac = xpos & 0x3e;
        for (let x = 0, base = xpos >> 6; x < width; x++, base += inc) {
            if (base < maxBase) dst[d + x] = (top[t0 + base] * (64 - frac) + top[t0 + base + 1] * frac + 32) >> 6;
            else {
                dst.fill(top[t0 + maxBase], d + x, d + width);
                break;
            }
        }
    }
}

function z2(dst: Uint16Array, d: number, stride: number, width: number, height: number, angle: number, maxWidth: number, maxHeight: number, bitdepthMax: number): void {
    const e = edgeBuffer;
    const smooth = !!(angle >> 9 & 1), edgeFilter = !!(angle >> 10);
    angle &= 511;
    let dy = DR_INTRA_DERIVATIVE[(angle - 90) >> 1];
    let dx = DR_INTRA_DERIVATIVE[(180 - angle) >> 1];
    const upLeft = edgeFilter && upsampled(width + height, 180 - angle, smooth);
    const upAbove = edgeFilter && upsampled(width + height, angle - 90, smooth);
    const s = scratch, tl = 64;

    if (upAbove) {
        upsampleEdge(s, tl, width + 1, e, EDGE, 0, width + 1, bitdepthMax);
        dx <<= 1;
    } else {
        const strength = edgeFilter ? filterStrength(width + height, angle - 90, smooth) : 0;
        if (strength) filterEdge(s, tl + 1, width, 0, maxWidth, e, EDGE + 1, -1, width, strength);
        else s.set(e.subarray(EDGE + 1, EDGE + 1 + width), tl + 1);
    }
    if (upLeft) {
        upsampleEdge(s, tl - height * 2, height + 1, e, EDGE - height, 0, height + 1, bitdepthMax);
        dy <<= 1;
    } else {
        const strength = edgeFilter ? filterStrength(width + height, 180 - angle, smooth) : 0;
        if (strength) filterEdge(s, tl - height, height, height - maxHeight, height, e, EDGE - height, 0, height + 1, strength);
        else s.set(e.subarray(EDGE - height, EDGE), tl - height);
    }
    s[tl] = e[EDGE];

    const incX = upAbove ? 2 : 1;
    const left = tl - (upLeft ? 2 : 1);
    for (let y = 0, xpos = ((upAbove ? 2 : 1) << 6) - dx; y < height; y++, xpos -= dx, d += stride) {
        let baseX = xpos >> 6;
        const fracX = xpos & 0x3e;
        for (let x = 0, ypos = (y << (6 + (upLeft ? 1 : 0))) - dy; x < width; x++, baseX += incX, ypos -= dy) {
            let v: number;
            if (baseX >= 0) v = s[tl + baseX] * (64 - fracX) + s[tl + baseX + 1] * fracX;
            else {
                const baseY = ypos >> 6, fracY = ypos & 0x3e;
                v = s[left - baseY] * (64 - fracY) + s[left - baseY - 1] * fracY;
            }
            dst[d + x] = (v + 32) >> 6;
        }
    }
}

function z3(dst: Uint16Array, d: number, stride: number, width: number, height: number, angle: number, bitdepthMax: number): void {
    const e = edgeBuffer;
    const smooth = !!(angle >> 9 & 1), edgeFilter = !!(angle >> 10);
    angle &= 511;
    let dy = DR_INTRA_DERIVATIVE[(270 - angle) >> 1];
    let left: Uint16Array, l0: number, maxBase: number;
    const up = edgeFilter && upsampled(width + height, angle - 180, smooth);
    if (up) {
        upsampleEdge(scratch, 0, width + height, e, EDGE - (width + height), Math.max(width - height, 0), width + height + 1, bitdepthMax);
        left = scratch; l0 = 2 * (width + height) - 2;
        maxBase = 2 * (width + height) - 2;
        dy <<= 1;
    } else {
        const strength = edgeFilter ? filterStrength(width + height, angle - 180, smooth) : 0;
        if (strength) {
            filterEdge(scratch, 0, width + height, 0, width + height, e, EDGE - (width + height), Math.max(width - height, 0), width + height + 1, strength);
            left = scratch; l0 = width + height - 1;
            maxBase = width + height - 1;
        } else {
            left = e; l0 = EDGE - 1;
            maxBase = height + Math.min(width, height) - 1;
        }
    }
    const inc = up ? 2 : 1;
    for (let x = 0, ypos = dy; x < width; x++, ypos += dy) {
        const frac = ypos & 0x3e;
        for (let y = 0, base = ypos >> 6; y < height; y++, base += inc) {
            if (base < maxBase) dst[d + y * stride + x] = (left[l0 - base] * (64 - frac) + left[l0 - base - 1] * frac + 32) >> 6;
            else {
                for (; y < height; y++) dst[d + y * stride + x] = left[l0 - maxBase];
                break;
            }
        }
    }
}

// recursive filter intra: 4x2 blocks from the 7 pixels above and to the left of each
function filterIntra(dst: Uint16Array, d: number, stride: number, width: number, height: number, filter: number, bitdepthMax: number): void {
    const e = edgeBuffer;
    const taps = filter * 56;
    // the top row comes from the edge buffer for the first two rows, from the block afterwards
    let topArr = e, top = EDGE + 1;
    for (let y = 0; y < height; y += 2) {
        let tlArr = e, tl = EDGE - y;
        let leftArr = e, left = tl - 1, leftStride = -1;
        for (let x = 0; x < width; x += 4) {
            const p0 = tlArr[tl];
            const p1 = topArr[top], p2 = topArr[top + 1], p3 = topArr[top + 2], p4 = topArr[top + 3];
            const p5 = leftArr[left], p6 = leftArr[left + leftStride];
            let ptr = d + x;
            for (let yy = 0, k = 0; yy < 2; yy++, ptr += stride) {
                for (let xx = 0; xx < 4; xx++, k++) {
                    const t = taps + k * 7;
                    const acc = FILTER_INTRA_TAPS[t] * p0 + FILTER_INTRA_TAPS[t + 1] * p1 + FILTER_INTRA_TAPS[t + 2] * p2 +
                        FILTER_INTRA_TAPS[t + 3] * p3 + FILTER_INTRA_TAPS[t + 4] * p4 + FILTER_INTRA_TAPS[t + 5] * p5 +
                        FILTER_INTRA_TAPS[t + 6] * p6;
                    const v = (acc + 8) >> 4;
                    dst[ptr + xx] = v < 0 ? 0 : v > bitdepthMax ? bitdepthMax : v;
                }
            }
            leftArr = dst; left = d + x + 4 - 1; leftStride = stride;
            top += 4;
            tlArr = topArr; tl = top - 1;
        }
        topArr = dst; top = d + stride;
        d += stride * 2;
    }
}

/** Predicts a block with an intra predictor (from prepareEdges) into dst[d..] */
export function predict(mode: number, dst: Uint16Array, d: number, stride: number, width: number, height: number,
    angle: number, maxWidth: number, maxHeight: number, bitdepthMax: number): void {
    const e = edgeBuffer;
    switch (mode) {
        case DC_PRED: case LEFT_DC_PRED: case TOP_DC_PRED: case DC_128_PRED:
            return splat(dst, d, stride, width, height, dcValue(mode, width, height, bitdepthMax));
        case VERT_PRED:
            for (let y = 0; y < height; y++, d += stride) dst.set(e.subarray(EDGE + 1, EDGE + 1 + width), d);
            return;
        case HOR_PRED:
            for (let y = 0; y < height; y++, d += stride) dst.fill(e[EDGE - 1 - y], d, d + width);
            return;
        case PAETH_PRED: {
            const topleft = e[EDGE];
            for (let y = 0; y < height; y++, d += stride) {
                const left = e[EDGE - 1 - y];
                for (let x = 0; x < width; x++) {
                    const top = e[EDGE + 1 + x];
                    const base = left + top - topleft;
                    const ldiff = Math.abs(left - base), tdiff = Math.abs(top - base), tldiff = Math.abs(topleft - base);
                    dst[d + x] = ldiff <= tdiff && ldiff <= tldiff ? left : tdiff <= tldiff ? top : topleft;
                }
            }
            return;
        }
        case SMOOTH_PRED: {
            const right = e[EDGE + width], bottom = e[EDGE - height];
            for (let y = 0; y < height; y++, d += stride) {
                const wv = SM_WEIGHTS[height + y], left = e[EDGE - 1 - y];
                for (let x = 0; x < width; x++) {
                    const wh = SM_WEIGHTS[width + x];
                    dst[d + x] = (wv * e[EDGE + 1 + x] + (256 - wv) * bottom + wh * left + (256 - wh) * right + 256) >> 9;
                }
            }
            return;
        }
        case SMOOTH_V_PRED: {
            const bottom = e[EDGE - height];
            for (let y = 0; y < height; y++, d += stride) {
                const wv = SM_WEIGHTS[height + y];
                for (let x = 0; x < width; x++) dst[d + x] = (wv * e[EDGE + 1 + x] + (256 - wv) * bottom + 128) >> 8;
            }
            return;
        }
        case SMOOTH_H_PRED: {
            const right = e[EDGE + width];
            for (let y = 0; y < height; y++, d += stride) {
                const left = e[EDGE - 1 - y];
                for (let x = 0; x < width; x++) {
                    const wh = SM_WEIGHTS[width + x];
                    dst[d + x] = (wh * left + (256 - wh) * right + 128) >> 8;
                }
            }
            return;
        }
        case Z1_PRED: return z1(dst, d, stride, width, height, angle, bitdepthMax);
        case Z2_PRED: return z2(dst, d, stride, width, height, angle, maxWidth, maxHeight, bitdepthMax);
        case Z3_PRED: return z3(dst, d, stride, width, height, angle, bitdepthMax);
        case FILTER_PRED: return filterIntra(dst, d, stride, width, height, angle & 511, bitdepthMax);
    }
}

/** the chroma from luma AC: the subsampled luma minus its average (the padding repeats the last values) */
export function cflAc(ac: Int16Array, y: Uint16Array, yo: number, stride: number, wPad: number, hPad: number, width: number, height: number, ssHor: number, ssVer: number): void {
    let a = 0, row: number;
    for (row = 0; row < height - 4 * hPad; row++) {
        let x: number;
        for (x = 0; x < width - 4 * wPad; x++) {
            let sum = y[yo + (x << ssHor)];
            if (ssHor) sum += y[yo + x * 2 + 1];
            if (ssVer) {
                sum += y[yo + (x << ssHor) + stride];
                if (ssHor) sum += y[yo + x * 2 + 1 + stride];
            }
            ac[a + x] = sum << (1 + (ssVer ? 0 : 1) + (ssHor ? 0 : 1));
        }
        for (; x < width; x++) ac[a + x] = ac[a + x - 1];
        a += width;
        yo += stride << ssVer;
    }
    for (; row < height; row++, a += width) ac.copyWithin(a, a - width, a);

    const log2 = ctz(width) + ctz(height);
    let sum = (1 << log2) >> 1;
    for (let i = 0; i < width * height; i++) sum += ac[i];
    sum >>= log2;
    for (let i = 0; i < width * height; i++) ac[i] -= sum;
}

/** chroma from luma prediction: the DC (from the edges) plus alpha times the luma AC */
export function cflPredict(mode: number, dst: Uint16Array, d: number, stride: number, width: number, height: number, ac: Int16Array, alpha: number, bitdepthMax: number): void {
    const dc = dcValue(mode, width, height, bitdepthMax);
    for (let y = 0, a = 0; y < height; y++, d += stride) {
        for (let x = 0; x < width; x++, a++) {
            const diff = alpha * ac[a];
            const v = dc + (diff < 0 ? -((-diff + 32) >> 6) : (diff + 32) >> 6);
            dst[d + x] = v < 0 ? 0 : v > bitdepthMax ? bitdepthMax : v;
        }
    }
}
