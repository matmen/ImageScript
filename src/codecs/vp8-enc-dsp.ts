/*!
 * The building blocks of libwebp's lossy (VP8) encoder: RGBA to YUV 4:2:0 conversion (src/enc/picture_csp_enc.c,
 * src/enc/picture_tools_enc.c), predictions, transforms, quantization and distortion metrics (src/dsp/enc.c,
 * src/dsp/quant.h), ported so the encoder's decisions are libwebp's. Copyright (c) 2010 Google Inc., BSD-3-Clause
 * License (see THIRD_PARTY_NOTICES.md)
 */
import { littleEndian } from '../util/alpha.ts';

/** the stride of the work buffers */
export const BPS = 32;

// the work buffers' layout: luma at 0, U at 16, V at 24 (16 rows); the predictions buffer holds the 4 intra 16x16
// predictions, the 4 chroma ones (U and V side by side) and the 10 intra 4x4 ones
export const Y_OFF = 0, U_OFF = 16, V_OFF = 24;
export const YUV_SIZE = BPS * 16, PRED_SIZE = 56 * BPS;
export const I16DC16 = 0, I16TM16 = 16, I16VE16 = 16 * BPS, I16HE16 = 16 * BPS + 16;
export const C8DC8 = 32 * BPS, C8TM8 = C8DC8 + 16, C8VE8 = 40 * BPS, C8HE8 = C8VE8 + 16;
export const I4DC4 = 48 * BPS, I4HD4 = I4DC4 + 4 * BPS, I4TMP = I4HD4 + 8;
/** the intra 16x16 and chroma predictions by mode (DC, TM, VE, HE), the intra 4x4 ones (libwebp's order) */
export const I16_MODE_OFFSETS = [I16DC16, I16TM16, I16VE16, I16HE16];
export const UV_MODE_OFFSETS = [C8DC8, C8TM8, C8VE8, C8HE8];
export const I4_MODE_OFFSETS = [I4DC4, I4DC4 + 4, I4DC4 + 8, I4DC4 + 12, I4DC4 + 16, I4DC4 + 20, I4DC4 + 24, I4DC4 + 28, I4HD4, I4HD4 + 4];
/** the 4x4 blocks of luma, then of U and V */
export const SCAN = [
    0, 4, 8, 12, 4 * BPS, 4 * BPS + 4, 4 * BPS + 8, 4 * BPS + 12,
    8 * BPS, 8 * BPS + 4, 8 * BPS + 8, 8 * BPS + 12, 12 * BPS, 12 * BPS + 4, 12 * BPS + 8, 12 * BPS + 12
];
export const SCAN_UV = [0, 4, 4 * BPS, 4 * BPS + 4, 8, 12, 4 * BPS + 8, 4 * BPS + 12];
export const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];

const QFIX = 17;
export const MAX_LEVEL = 2047;

const clip8 = (v: number): number => v < 0 ? 0 : v > 255 ? 255 : v;

// ---- RGBA to YUV 4:2:0 (picture_csp_enc.c: ImportYUVAFromRGBA without dithering)

/** A picture in YUV 4:2:0, with its alpha if it isn't opaque */
export interface YUVPicture {
    width: number;
    height: number;
    y: Uint8Array;
    u: Uint8Array;
    v: Uint8Array;
    a: Uint8Array | null;
    /** the luma (and alpha) stride is the width, this the chroma one */
    uvStride: number;
}

// chroma is averaged in a gamma compressed space (gamma 0.8): 12 bit linear values, a 33 entry table back
const GAMMA_TO_LINEAR = new Uint16Array(256), LINEAR_TO_GAMMA = new Int32Array(33);
for (let v = 0; v <= 255; v++) GAMMA_TO_LINEAR[v] = Math.trunc(Math.pow((1 / 255) * v, 0.8) * 4095 + 0.5);
for (let v = 0; v <= 32; v++) LINEAR_TO_GAMMA[v] = Math.trunc(255 * Math.pow((128 / 4095) * v, 1 / 0.8) + 0.5);
// (1 << 19) / a, for dividing by the sum of 4 alphas
const INV_ALPHA = new Uint32Array(4 * 255 + 1);
for (let a = 1; a <= 4 * 255; a++) INV_ALPHA[a] = Math.floor((1 << 19) / a);

// a linear value (times 4 by the shift) as gamma compressed, times 4
function linearToGamma(base: number, shift: number): number {
    const v = base << shift;
    const pos = v >> 9, x = v & 511;
    return (LINEAR_TO_GAMMA[pos + 1] * x + LINEAR_TO_GAMMA[pos] * (512 - x) + 64) >> 7;
}

// linearToGamma of the sums of 4 linear values
const SUM_TO_GAMMA = new Uint16Array(4 * 4095 + 1);
for (let v = 0; v < SUM_TO_GAMMA.length; v++) SUM_TO_GAMMA[v] = linearToGamma(v, 0);

// (rounded, plus 16 for the limited range)
const rgbToY = (r: number, g: number, b: number): number => (16839 * r + 33059 * g + 6420 * b + 0x8000 + 0x100000) >> 16;
// (of 4 times the values)
const clipUV = (uv: number): number => {
    uv = (uv + (1 << 17) + (128 << 18)) >> 18;
    return uv < 0 ? 0 : uv > 255 ? 255 : uv;
};

// a channel of 2x2 pixels at rgba[o] (step: to the right one, next: to the one below) averaged weighted by alpha
function weighted(rgba: Uint8Array, o: number, step: number, next: number, total: number): number {
    const g = GAMMA_TO_LINEAR, a = o + 3 - (o & 3);
    const sum = rgba[a] * g[rgba[o]] + rgba[a + step] * g[rgba[o + step]] + rgba[a + next] * g[rgba[o + next]] + rgba[a + next + step] * g[rgba[o + next + step]];
    return linearToGamma((sum * INV_ALPHA[total]) >>> 17, 0);
}

/**
 * RGBA as YUV 4:2:0: chroma averaged over 2x2 pixels in a gamma compressed space, weighted by alpha where it's
 * partly transparent; fully transparent 8x8 areas are flattened (and the luma of transparent pixels smoothed) for
 * better compression, like libwebp does unless asked for exact colors
 */
export function rgbaToYUV(rgba: Uint8Array, width: number, height: number): YUVPicture {
    const uvWidth = (width + 1) >> 1, uvHeight = (height + 1) >> 1;
    const y = new Uint8Array(width * height), u = new Uint8Array(uvWidth * uvHeight), v = new Uint8Array(uvWidth * uvHeight);
    let hasAlpha = false;
    for (let i = 3; i < width * height * 4; i += 4) if (rgba[i] !== 255) { hasAlpha = true; break; }
    const a = hasAlpha ? new Uint8Array(width * height) : null;
    const stride = width * 4;

    // (functions per row: optimized after a few rows rather than running a whole image's loop unoptimized)
    if (a) for (let j = 0; j < height; j++) alphaRow(rgba, j * stride, a, j * width, width);
    // (opaque rows as 32-bit words: one load per pixel)
    const words = littleEndian && rgba.byteOffset % 4 === 0 ? new Uint32Array(rgba.buffer, rgba.byteOffset, width * height) : null;
    for (let j = 0; j < uvHeight; j++) {
        const row = 2 * j * stride;
        // (the last row of an odd height: itself again)
        const next = 2 * j + 1 < height ? stride : 0;
        // whether these rows have transparency
        let alphaRows = false;
        if (a) for (let i = row + 3; i < row + next + stride; i += 4) if (rgba[i] !== 255) { alphaRows = true; break; }
        if (words && !alphaRows) {
            pairRow(words, 2 * j * width, next >> 2, y, u, v, j * uvWidth, width);
            continue;
        }
        lumaRow(rgba, row, y, 2 * j * width, width);
        if (next) lumaRow(rgba, row + next, y, (2 * j + 1) * width, width);
        if (alphaRows) chromaRowAlpha(rgba, row, next, u, v, j * uvWidth, width);
        else chromaRow(rgba, row, next, u, v, j * uvWidth, width);
    }
    const picture = { width, height, y, u, v, a, uvStride: uvWidth };
    if (a) cleanupTransparentArea(picture);
    return picture;
}

function lumaRow(rgba: Uint8Array, s: number, y: Uint8Array, d: number, width: number): void {
    for (let x = 0; x < width; x++, s += 4) y[d + x] = rgbToY(rgba[s], rgba[s + 1], rgba[s + 2]);
}

function alphaRow(rgba: Uint8Array, s: number, a: Uint8Array, d: number, width: number): void {
    for (let x = 0; x < width; x++, s += 4) a[d + x] = rgba[s + 3];
}

// the luma and chroma of 2 opaque rows of 32-bit pixels (from p, the second next words later; 0: the first again)
function pairRow(words: Uint32Array, p: number, next: number, y: Uint8Array, u: Uint8Array, v: Uint8Array, d: number, width: number): void {
    const g = GAMMA_TO_LINEAR, pairs = width >> 1;
    for (let i = 0; i < pairs; i++, p += 2) {
        const p0 = words[p], p1 = words[p + 1], p2 = words[p + next], p3 = words[p + next + 1];
        const r0 = p0 & 255, g0 = p0 >> 8 & 255, b0 = p0 >> 16 & 255, r1 = p1 & 255, g1 = p1 >> 8 & 255, b1 = p1 >> 16 & 255;
        const r2 = p2 & 255, g2 = p2 >> 8 & 255, b2 = p2 >> 16 & 255, r3 = p3 & 255, g3 = p3 >> 8 & 255, b3 = p3 >> 16 & 255;
        y[p] = rgbToY(r0, g0, b0);
        y[p + 1] = rgbToY(r1, g1, b1);
        if (next) {
            y[p + next] = rgbToY(r2, g2, b2);
            y[p + next + 1] = rgbToY(r3, g3, b3);
        }
        const r = SUM_TO_GAMMA[g[r0] + g[r1] + g[r2] + g[r3]];
        const gr = SUM_TO_GAMMA[g[g0] + g[g1] + g[g2] + g[g3]];
        const b = SUM_TO_GAMMA[g[b0] + g[b1] + g[b2] + g[b3]];
        u[d + i] = clipUV(-9719 * r - 19081 * gr + 28800 * b);
        v[d + i] = clipUV(28800 * r - 24116 * gr - 4684 * b);
    }
    if (width & 1) {
        const p0 = words[p], p2 = words[p + next];
        const r0 = p0 & 255, g0 = p0 >> 8 & 255, b0 = p0 >> 16 & 255, r2 = p2 & 255, g2 = p2 >> 8 & 255, b2 = p2 >> 16 & 255;
        y[p] = rgbToY(r0, g0, b0);
        if (next) y[p + next] = rgbToY(r2, g2, b2);
        const r = linearToGamma(g[r0] + g[r2], 1), gr = linearToGamma(g[g0] + g[g2], 1), b = linearToGamma(g[b0] + g[b2], 1);
        u[d + pairs] = clipUV(-9719 * r - 19081 * gr + 28800 * b);
        v[d + pairs] = clipUV(28800 * r - 24116 * gr - 4684 * b);
    }
}

// the chroma of 2 opaque rows (next: the offset of the second one)
function chromaRow(rgba: Uint8Array, row: number, next: number, u: Uint8Array, v: Uint8Array, d: number, width: number): void {
    const g = GAMMA_TO_LINEAR, pairs = width >> 1;
    let o = row;
    for (let i = 0; i < pairs; i++, o += 8) {
        const r = linearToGamma(g[rgba[o]] + g[rgba[o + 4]] + g[rgba[o + next]] + g[rgba[o + next + 4]], 0);
        const gr = linearToGamma(g[rgba[o + 1]] + g[rgba[o + 5]] + g[rgba[o + next + 1]] + g[rgba[o + next + 5]], 0);
        const b = linearToGamma(g[rgba[o + 2]] + g[rgba[o + 6]] + g[rgba[o + next + 2]] + g[rgba[o + next + 6]], 0);
        u[d + i] = clipUV(-9719 * r - 19081 * gr + 28800 * b);
        v[d + i] = clipUV(28800 * r - 24116 * gr - 4684 * b);
    }
    if (width & 1) {
        const r = linearToGamma(g[rgba[o]] + g[rgba[o + next]], 1);
        const gr = linearToGamma(g[rgba[o + 1]] + g[rgba[o + next + 1]], 1);
        const b = linearToGamma(g[rgba[o + 2]] + g[rgba[o + next + 2]], 1);
        u[d + pairs] = clipUV(-9719 * r - 19081 * gr + 28800 * b);
        v[d + pairs] = clipUV(28800 * r - 24116 * gr - 4684 * b);
    }
}

// the chroma of 2 rows with transparency: averaged weighted by alpha where it's partly transparent
function chromaRowAlpha(rgba: Uint8Array, row: number, next: number, u: Uint8Array, v: Uint8Array, d: number, width: number): void {
    const g = GAMMA_TO_LINEAR, uvWidth = (width + 1) >> 1;
    for (let i = 0; i < uvWidth; i++) {
        const o = row + 8 * i, pair = 2 * i + 1 < width;
        const step = pair ? 4 : 0;
        let r: number, gr: number, b: number;
        const total = pair ? rgba[o + 3] + rgba[o + 7] + rgba[o + next + 3] + rgba[o + next + 7] : 2 * (rgba[o + 3] + rgba[o + next + 3]);
        if (total === 4 * 255 || total === 0) {
            if (pair) {
                r = linearToGamma(g[rgba[o]] + g[rgba[o + 4]] + g[rgba[o + next]] + g[rgba[o + next + 4]], 0);
                gr = linearToGamma(g[rgba[o + 1]] + g[rgba[o + 5]] + g[rgba[o + next + 1]] + g[rgba[o + next + 5]], 0);
                b = linearToGamma(g[rgba[o + 2]] + g[rgba[o + 6]] + g[rgba[o + next + 2]] + g[rgba[o + next + 6]], 0);
            } else {
                r = linearToGamma(g[rgba[o]] + g[rgba[o + next]], 1);
                gr = linearToGamma(g[rgba[o + 1]] + g[rgba[o + next + 1]], 1);
                b = linearToGamma(g[rgba[o + 2]] + g[rgba[o + next + 2]], 1);
            }
        } else {
            r = weighted(rgba, o, step, next, total);
            gr = weighted(rgba, o + 1, step, next, total);
            b = weighted(rgba, o + 2, step, next, total);
        }
        u[d + i] = clipUV(-9719 * r - 19081 * gr + 28800 * b);
        v[d + i] = clipUV(28800 * r - 24116 * gr - 4684 * b);
    }
}

// (picture_tools_enc.c: WebPCleanupTransparentArea) the luma of the transparent pixels of a block becomes the
// average of the others; whether the block is fully transparent
function smoothenBlock(p: YUVPicture, x0: number, y0: number, w: number, h: number): boolean {
    const a = p.a as Uint8Array;
    let sum = 0, count = 0;
    for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
            if (a[y * p.width + x]) {
                count++;
                sum += p.y[y * p.width + x];
            }
        }
    }
    if (count > 0 && count < w * h) {
        const average = Math.floor(sum / count);
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (!a[y * p.width + x]) p.y[y * p.width + x] = average;
    }
    return count === 0;
}

function cleanupTransparentArea(p: YUVPicture): void {
    const { width, height, uvStride } = p;
    const flatten = (plane: Uint8Array, stride: number, x0: number, y0: number, size: number, value: number): void => {
        for (let y = y0; y < y0 + size; y++) plane.fill(value, y * stride + x0, y * stride + x0 + size);
    };
    let y = 0;
    for (; y + 8 <= height; y += 8) {
        // fully transparent blocks take the values of the first of a run
        let reset = true, vy = 0, vu = 0, vv = 0;
        let x = 0;
        for (; x + 8 <= width; x += 8) {
            if (smoothenBlock(p, x, y, 8, 8)) {
                if (reset) {
                    vy = p.y[y * width + x];
                    vu = p.u[(y >> 1) * uvStride + (x >> 1)];
                    vv = p.v[(y >> 1) * uvStride + (x >> 1)];
                    reset = false;
                }
                flatten(p.y, width, x, y, 8, vy);
                flatten(p.u, uvStride, x >> 1, y >> 1, 4, vu);
                flatten(p.v, uvStride, x >> 1, y >> 1, 4, vv);
            } else reset = true;
        }
        if (x < width) smoothenBlock(p, x, y, width - x, 8);
    }
    if (y < height) {
        let x = 0;
        for (; x + 8 <= width; x += 8) smoothenBlock(p, x, y, 8, height - y);
        if (x < width) smoothenBlock(p, x, y, width - x, height - y);
    }
}

// ---- predictions (dsp/enc.c)

function fill(dst: Uint8Array, d: number, value: number, size: number): void {
    for (let j = 0; j < size; j++, d += BPS) for (let x = 0; x < size; x++) dst[d + x] = value;
}

function verticalPred(dst: Uint8Array, d: number, top: Uint8Array | null, t: number, size: number): void {
    if (top) for (let j = 0; j < size; j++, d += BPS) for (let x = 0; x < size; x++) dst[d + x] = top[t + x];
    else fill(dst, d, 127, size);
}

function horizontalPred(dst: Uint8Array, d: number, left: Uint8Array | null, l: number, size: number): void {
    if (left) {
        for (let j = 0; j < size; j++, d += BPS) {
            const v = left[l + j];
            for (let x = 0; x < size; x++) dst[d + x] = v;
        }
    } else fill(dst, d, 129, size);
}

// (left[l - 1] is the top left sample)
function trueMotion(dst: Uint8Array, d: number, left: Uint8Array | null, l: number, top: Uint8Array | null, t: number, size: number): void {
    if (left) {
        if (top) {
            const corner = left[l - 1];
            for (let y = 0; y < size; y++) {
                const base = left[l + y] - corner;
                for (let x = 0; x < size; x++) dst[d + y * BPS + x] = clip8(top[t + x] + base);
            }
        } else horizontalPred(dst, d, left, l, size);
    } else if (top) verticalPred(dst, d, top, t, size);
    else fill(dst, d, 129, size);
}

function dcMode(dst: Uint8Array, d: number, left: Uint8Array | null, l: number, top: Uint8Array | null, t: number, size: number, round: number, shift: number): void {
    let dc = 0;
    if (top) {
        for (let j = 0; j < size; j++) dc += top[t + j];
        if (left) for (let j = 0; j < size; j++) dc += left[l + j];
        else dc += dc;
        dc = (dc + round) >> shift;
    } else if (left) {
        for (let j = 0; j < size; j++) dc += left[l + j];
        dc += dc;
        dc = (dc + round) >> shift;
    } else dc = 0x80;
    fill(dst, d, dc, size);
}

/**
 * The intra 16x16 predictions of the modes in the mask (1 << mode, all by default); left: 16 samples after the top
 * left one, top: 16 samples
 */
export function predLuma16(dst: Uint8Array, left: Uint8Array | null, l: number, top: Uint8Array | null, t: number, modes = 15): void {
    if (modes & 1) dcMode(dst, I16DC16, left, l, top, t, 16, 16, 5);
    if (modes & 2) trueMotion(dst, I16TM16, left, l, top, t, 16);
    if (modes & 4) verticalPred(dst, I16VE16, top, t, 16);
    if (modes & 8) horizontalPred(dst, I16HE16, left, l, 16);
}

/**
 * The chroma predictions of U and V of the modes in the mask (1 << mode, all by default); left: the U samples after
 * their top left one (V's at +16), top: 8 U, 8 V
 */
export function predChroma8(dst: Uint8Array, uLeft: Uint8Array | null, ul: number, vLeft: Uint8Array | null, vl: number, top: Uint8Array | null, t: number, modes = 15): void {
    for (let c = 0; c < 2; c++) {
        const left = c ? vLeft : uLeft, l = c ? vl : ul, tt = t + 8 * c, o = 8 * c;
        if (modes & 1) dcMode(dst, C8DC8 + o, left, l, top, tt, 8, 8, 4);
        if (modes & 2) trueMotion(dst, C8TM8 + o, left, l, top, tt, 8);
        if (modes & 4) verticalPred(dst, C8VE8 + o, top, tt, 8);
        if (modes & 8) horizontalPred(dst, C8HE8 + o, left, l, 8);
    }
}

const avg3 = (a: number, b: number, c: number): number => (a + 2 * b + c + 2) >> 2;
const avg2 = (a: number, b: number): number => (a + b + 1) >> 1;

const rowSums = new Int32Array(16), columnSums = new Int32Array(16);
let sourceSquares = 0, sourceSum = 0;

// the sums of the rows, columns, samples and squares of a block (unrolled)
function sourceSums16(src: Uint8Array, s: number): void {
    let c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0, c6 = 0, c7 = 0, c8 = 0, c9 = 0, c10 = 0, c11 = 0, c12 = 0, c13 = 0, c14 = 0, c15 = 0, squares = 0, sum = 0;
    for (let y = 0, o = s; y < 16; y++, o += BPS) {
        const v0 = src[o], v1 = src[o + 1], v2 = src[o + 2], v3 = src[o + 3], v4 = src[o + 4], v5 = src[o + 5], v6 = src[o + 6], v7 = src[o + 7], v8 = src[o + 8], v9 = src[o + 9], v10 = src[o + 10], v11 = src[o + 11], v12 = src[o + 12], v13 = src[o + 13], v14 = src[o + 14], v15 = src[o + 15];
        const row = v0 + v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9 + v10 + v11 + v12 + v13 + v14 + v15;
        rowSums[y] = row;
        sum += row;
        squares += v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3 + v4 * v4 + v5 * v5 + v6 * v6 + v7 * v7 + v8 * v8 + v9 * v9 + v10 * v10 + v11 * v11 + v12 * v12 + v13 * v13 + v14 * v14 + v15 * v15;
        c0 += v0; c1 += v1; c2 += v2; c3 += v3; c4 += v4; c5 += v5; c6 += v6; c7 += v7; c8 += v8; c9 += v9; c10 += v10; c11 += v11; c12 += v12; c13 += v13; c14 += v14; c15 += v15;
    }
    columnSums[0] = c0; columnSums[1] = c1; columnSums[2] = c2; columnSums[3] = c3; columnSums[4] = c4; columnSums[5] = c5; columnSums[6] = c6; columnSums[7] = c7; columnSums[8] = c8; columnSums[9] = c9; columnSums[10] = c10; columnSums[11] = c11; columnSums[12] = c12; columnSums[13] = c13; columnSums[14] = c14; columnSums[15] = c15;
    sourceSquares = squares;
    sourceSum = sum;
}

function sourceSums8(src: Uint8Array, s: number): void {
    let c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0, c6 = 0, c7 = 0, squares = 0, sum = 0;
    for (let y = 0, o = s; y < 8; y++, o += BPS) {
        const v0 = src[o], v1 = src[o + 1], v2 = src[o + 2], v3 = src[o + 3], v4 = src[o + 4], v5 = src[o + 5], v6 = src[o + 6], v7 = src[o + 7];
        const row = v0 + v1 + v2 + v3 + v4 + v5 + v6 + v7;
        rowSums[y] = row;
        sum += row;
        squares += v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3 + v4 * v4 + v5 * v5 + v6 * v6 + v7 * v7;
        c0 += v0; c1 += v1; c2 += v2; c3 += v3; c4 += v4; c5 += v5; c6 += v6; c7 += v7;
    }
    columnSums[0] = c0; columnSums[1] = c1; columnSums[2] = c2; columnSums[3] = c3; columnSums[4] = c4; columnSums[5] = c5; columnSums[6] = c6; columnSums[7] = c7;
    sourceSquares = squares;
    sourceSum = sum;
}


/**
 * The sums of squared differences of a size x size block (of 1 or 2 planes, 8 apart) to the 4 predictions
 * (DC, TM, VE, HE; like {@link predLuma16} and {@link predChroma8}) into out, without making them: from the block's
 * sums of rows, columns and squares (only TM where it clips needs the samples); left and top as for those, but the
 * planes' tops 8 apart and their lefts given separately
 */
export function predictionSSEs(src: Uint8Array, s: number, size: number, planes: number, left0: Uint8Array | null, left1: Uint8Array | null, l: number, top: Uint8Array | null, t: number, out: Float64Array): void {
    out.fill(0);
    const n = size * size, shift = size === 16 ? 5 : 4;
    for (let c = 0; c < planes; c++, s += 8, t += 8) {
        const left = c ? left1 : left0;
        if (size === 16) sourceSums16(src, s);
        else sourceSums8(src, s);
        const squares = sourceSquares, sum = sourceSum;
        const fill = (v: number): number => squares - 2 * v * sum + n * v * v;
        // (V: sum over the columns of (s - top)^2; H likewise over the rows)
        let topSum = 0, topSquares = 0, topCross = 0, leftSum = 0, leftSquares = 0, leftCross = 0;
        if (top) {
            for (let x = 0; x < size; x++) {
                const v = top[t + x];
                topSum += v;
                topSquares += v * v;
                topCross += v * columnSums[x];
            }
        }
        if (left) {
            for (let y = 0; y < size; y++) {
                const v = left[l + y];
                leftSum += v;
                leftSquares += v * v;
                leftCross += v * rowSums[y];
            }
        }
        const vertical = top ? squares - 2 * topCross + size * topSquares : fill(127);
        const horizontal = left ? squares - 2 * leftCross + size * leftSquares : fill(129);
        let dc: number;
        if (top) dc = (left ? topSum + leftSum : 2 * topSum) + size >> shift;
        else if (left) dc = 2 * leftSum + size >> shift;
        else dc = 0x80;
        let tm: number;
        if (left && top) {
            // top + left - corner: separable unless it clips
            const corner = left[l - 1];
            let tMin = 255, tMax = 0, bMin = 255, bMax = -255, bSum = 0, bSquares = 0, bCross = 0;
            for (let x = 0; x < size; x++) {
                const v = top[t + x];
                if (v < tMin) tMin = v;
                if (v > tMax) tMax = v;
            }
            for (let y = 0; y < size; y++) {
                const b = left[l + y] - corner;
                if (b < bMin) bMin = b;
                if (b > bMax) bMax = b;
                bSum += b;
                bSquares += b * b;
                bCross += b * rowSums[y];
            }
            if (tMin + bMin >= 0 && tMax + bMax <= 255) {
                tm = squares - 2 * topCross - 2 * bCross + size * topSquares + 2 * topSum * bSum + size * bSquares;
            } else {
                tm = 0;
                for (let y = 0, o = s; y < size; y++, o += BPS) {
                    const b = left[l + y] - corner;
                    for (let x = 0; x < size; x++) {
                        const d = src[o + x] - clip8(top[t + x] + b);
                        tm += d * d;
                    }
                }
            }
        } else tm = left ? horizontal : top ? vertical : fill(129);
        out[0] += fill(dc);
        out[1] += tm;
        out[2] += vertical;
        out[3] += horizontal;
    }
}

/** The 10 intra 4x4 predictions; top[t - 5..t - 2]: left (bottom up), top[t - 1]: top left, top[t..t + 7]: top */
export function predLuma4(dst: Uint8Array, top: Uint8Array, t: number): void {
    const X = top[t - 1], I = top[t - 2], J = top[t - 3], K = top[t - 4], L = top[t - 5];
    const A = top[t], B = top[t + 1], C = top[t + 2], D = top[t + 3], E = top[t + 4], F = top[t + 5], G = top[t + 6], H = top[t + 7];
    const R0 = 0, R1 = BPS, R2 = 2 * BPS, R3 = 3 * BPS;
    // DC
    const dc = (4 + A + B + C + D + I + J + K + L) >> 3;
    for (let y = 0, o = I4DC4; y < 4; y++, o += BPS) dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = dc;
    // TM
    for (let y = 0; y < 4; y++) {
        const base = top[t - 2 - y] - X, o = I4DC4 + 4 + y * BPS;
        dst[o] = clip8(A + base);
        dst[o + 1] = clip8(B + base);
        dst[o + 2] = clip8(C + base);
        dst[o + 3] = clip8(D + base);
    }
    // VE
    let o = I4DC4 + 8;
    const v0 = avg3(X, A, B), v1 = avg3(A, B, C), v2 = avg3(B, C, D), v3 = avg3(C, D, E);
    for (let y = 0; y < 4; y++, o += BPS) {
        dst[o] = v0;
        dst[o + 1] = v1;
        dst[o + 2] = v2;
        dst[o + 3] = v3;
    }
    // HE
    o = I4DC4 + 12;
    const he0 = avg3(X, I, J), he1 = avg3(I, J, K), he2 = avg3(J, K, L), he3 = avg3(K, L, L);
    dst[o + R0] = dst[o + R0 + 1] = dst[o + R0 + 2] = dst[o + R0 + 3] = he0;
    dst[o + R1] = dst[o + R1 + 1] = dst[o + R1 + 2] = dst[o + R1 + 3] = he1;
    dst[o + R2] = dst[o + R2 + 1] = dst[o + R2 + 2] = dst[o + R2 + 3] = he2;
    dst[o + R3] = dst[o + R3 + 1] = dst[o + R3 + 2] = dst[o + R3 + 3] = he3;
    // RD
    o = I4DC4 + 16;
    const xij = avg3(X, I, J), ijk = avg3(I, J, K), axi = avg3(A, X, I), bax = avg3(B, A, X);
    dst[o + R3] = avg3(J, K, L);
    dst[o + R2] = dst[o + R3 + 1] = ijk;
    dst[o + R1] = dst[o + R2 + 1] = dst[o + R3 + 2] = xij;
    dst[o] = dst[o + R1 + 1] = dst[o + R2 + 2] = dst[o + R3 + 3] = axi;
    dst[o + 1] = dst[o + R1 + 2] = dst[o + R2 + 3] = bax;
    dst[o + 2] = dst[o + R1 + 3] = avg3(C, B, A);
    dst[o + 3] = avg3(D, C, B);
    // VR
    o = I4DC4 + 20;
    dst[o] = dst[o + R2 + 1] = avg2(X, A);
    dst[o + 1] = dst[o + R2 + 2] = avg2(A, B);
    dst[o + 2] = dst[o + R2 + 3] = avg2(B, C);
    dst[o + 3] = avg2(C, D);
    dst[o + R3] = avg3(K, J, I);
    dst[o + R2] = avg3(J, I, X);
    dst[o + R1] = dst[o + R3 + 1] = axi;
    dst[o + R1 + 1] = dst[o + R3 + 2] = avg3(X, A, B);
    dst[o + R1 + 2] = dst[o + R3 + 3] = avg3(A, B, C);
    dst[o + R1 + 3] = avg3(B, C, D);
    // LD
    o = I4DC4 + 24;
    const bcd = avg3(B, C, D), cde = avg3(C, D, E), def = avg3(D, E, F), efg = avg3(E, F, G);
    dst[o] = avg3(A, B, C);
    dst[o + 1] = dst[o + R1] = bcd;
    dst[o + 2] = dst[o + R1 + 1] = dst[o + R2] = cde;
    dst[o + 3] = dst[o + R1 + 2] = dst[o + R2 + 1] = dst[o + R3] = def;
    dst[o + R1 + 3] = dst[o + R2 + 2] = dst[o + R3 + 1] = efg;
    dst[o + R2 + 3] = dst[o + R3 + 2] = avg3(F, G, H);
    dst[o + R3 + 3] = avg3(G, H, H);
    // VL
    o = I4DC4 + 28;
    dst[o] = avg2(A, B);
    dst[o + 1] = dst[o + R2] = avg2(B, C);
    dst[o + 2] = dst[o + R2 + 1] = avg2(C, D);
    dst[o + 3] = dst[o + R2 + 2] = avg2(D, E);
    dst[o + R1] = avg3(A, B, C);
    dst[o + R1 + 1] = dst[o + R3] = bcd;
    dst[o + R1 + 2] = dst[o + R3 + 1] = cde;
    dst[o + R1 + 3] = dst[o + R3 + 2] = def;
    dst[o + R2 + 3] = efg;
    dst[o + R3 + 3] = avg3(F, G, H);
    // HD
    o = I4HD4;
    const jix = avg3(J, I, X), kji = avg3(K, J, I);
    dst[o] = dst[o + R1 + 2] = avg2(I, X);
    dst[o + R1] = dst[o + R2 + 2] = avg2(J, I);
    dst[o + R2] = dst[o + R3 + 2] = avg2(K, J);
    dst[o + R3] = avg2(L, K);
    dst[o + 3] = avg3(A, B, C);
    dst[o + 2] = avg3(X, A, B);
    dst[o + 1] = dst[o + R1 + 3] = axi;
    dst[o + R1 + 1] = dst[o + R2 + 3] = jix;
    dst[o + R2 + 1] = dst[o + R3 + 3] = kji;
    dst[o + R3 + 1] = avg3(L, K, J);
    // HU
    o = I4HD4 + 4;
    dst[o] = avg2(I, J);
    dst[o + 2] = dst[o + R1] = avg2(J, K);
    dst[o + R1 + 2] = dst[o + R2] = avg2(K, L);
    dst[o + 1] = ijk;
    dst[o + 3] = dst[o + R1 + 1] = avg3(J, K, L);
    dst[o + R1 + 3] = dst[o + R2 + 1] = avg3(K, L, L);
    dst[o + R2 + 3] = dst[o + R2 + 2] = dst[o + R3] = dst[o + R3 + 1] = dst[o + R3 + 2] = dst[o + R3 + 3] = L;
}

// ---- transforms


/** Adds the inverse transform of in[i..i + 16] (and of the next 4x4 block, at in[i + 16..]) to ref, into dst */
export function iTransform(ref: Uint8Array, r: number, input: Int16Array, i: number, dst: Uint8Array, d: number, two: boolean): void {
    for (let n = 0; n < (two ? 2 : 1); n++, r += 4, i += 16, d += 4) {
        // (blocks with only a DC, or nothing, add the same to every sample)
        let ac = 0;
        for (let k = 1; k < 16; k++) ac |= input[i + k];
        if (!ac) {
            const dc = (input[i] + 4) >> 3;
            for (let k = 0; k < 4; k++) {
                const o = k * BPS;
                dst[d + o] = clip8(ref[r + o] + dc);
                dst[d + o + 1] = clip8(ref[r + o + 1] + dc);
                dst[d + o + 2] = clip8(ref[r + o + 2] + dc);
                dst[d + o + 3] = clip8(ref[r + o + 3] + dc);
            }
            continue;
        }
        // (columns, then rows; unrolled)
        const p0 = input[i + 0], q0 = input[i + 4], u0 = input[i + 8], w0 = input[i + 12];
        const a0 = p0 + u0, b0 = p0 - u0;
        const c0 = ((q0 * 35468) >> 16) - (((w0 * 20091) >> 16) + w0), e0 = (((q0 * 20091) >> 16) + q0) + ((w0 * 35468) >> 16);
        const v00 = a0 + e0, v01 = b0 + c0, v02 = b0 - c0, v03 = a0 - e0;
        const p1 = input[i + 1], q1 = input[i + 5], u1 = input[i + 9], w1 = input[i + 13];
        const a1 = p1 + u1, b1 = p1 - u1;
        const c1 = ((q1 * 35468) >> 16) - (((w1 * 20091) >> 16) + w1), e1 = (((q1 * 20091) >> 16) + q1) + ((w1 * 35468) >> 16);
        const v10 = a1 + e1, v11 = b1 + c1, v12 = b1 - c1, v13 = a1 - e1;
        const p2 = input[i + 2], q2 = input[i + 6], u2 = input[i + 10], w2 = input[i + 14];
        const a2 = p2 + u2, b2 = p2 - u2;
        const c2 = ((q2 * 35468) >> 16) - (((w2 * 20091) >> 16) + w2), e2 = (((q2 * 20091) >> 16) + q2) + ((w2 * 35468) >> 16);
        const v20 = a2 + e2, v21 = b2 + c2, v22 = b2 - c2, v23 = a2 - e2;
        const p3 = input[i + 3], q3 = input[i + 7], u3 = input[i + 11], w3 = input[i + 15];
        const a3 = p3 + u3, b3 = p3 - u3;
        const c3 = ((q3 * 35468) >> 16) - (((w3 * 20091) >> 16) + w3), e3 = (((q3 * 20091) >> 16) + q3) + ((w3 * 35468) >> 16);
        const v30 = a3 + e3, v31 = b3 + c3, v32 = b3 - c3, v33 = a3 - e3;
        {
            const dc = v00 + 4;
            const a = dc + v20, b = dc - v20;
            const c = ((v10 * 35468) >> 16) - (((v30 * 20091) >> 16) + v30), e = (((v10 * 20091) >> 16) + v10) + ((v30 * 35468) >> 16);
            dst[d] = clip8(ref[r] + ((a + e) >> 3));
            dst[d + 1] = clip8(ref[r + 1] + ((b + c) >> 3));
            dst[d + 2] = clip8(ref[r + 2] + ((b - c) >> 3));
            dst[d + 3] = clip8(ref[r + 3] + ((a - e) >> 3));
        }
        {
            const dc = v01 + 4;
            const a = dc + v21, b = dc - v21;
            const c = ((v11 * 35468) >> 16) - (((v31 * 20091) >> 16) + v31), e = (((v11 * 20091) >> 16) + v11) + ((v31 * 35468) >> 16);
            dst[d + 1 * BPS] = clip8(ref[r + 1 * BPS] + ((a + e) >> 3));
            dst[d + 1 * BPS + 1] = clip8(ref[r + 1 * BPS + 1] + ((b + c) >> 3));
            dst[d + 1 * BPS + 2] = clip8(ref[r + 1 * BPS + 2] + ((b - c) >> 3));
            dst[d + 1 * BPS + 3] = clip8(ref[r + 1 * BPS + 3] + ((a - e) >> 3));
        }
        {
            const dc = v02 + 4;
            const a = dc + v22, b = dc - v22;
            const c = ((v12 * 35468) >> 16) - (((v32 * 20091) >> 16) + v32), e = (((v12 * 20091) >> 16) + v12) + ((v32 * 35468) >> 16);
            dst[d + 2 * BPS] = clip8(ref[r + 2 * BPS] + ((a + e) >> 3));
            dst[d + 2 * BPS + 1] = clip8(ref[r + 2 * BPS + 1] + ((b + c) >> 3));
            dst[d + 2 * BPS + 2] = clip8(ref[r + 2 * BPS + 2] + ((b - c) >> 3));
            dst[d + 2 * BPS + 3] = clip8(ref[r + 2 * BPS + 3] + ((a - e) >> 3));
        }
        {
            const dc = v03 + 4;
            const a = dc + v23, b = dc - v23;
            const c = ((v13 * 35468) >> 16) - (((v33 * 20091) >> 16) + v33), e = (((v13 * 20091) >> 16) + v13) + ((v33 * 35468) >> 16);
            dst[d + 3 * BPS] = clip8(ref[r + 3 * BPS] + ((a + e) >> 3));
            dst[d + 3 * BPS + 1] = clip8(ref[r + 3 * BPS + 1] + ((b + c) >> 3));
            dst[d + 3 * BPS + 2] = clip8(ref[r + 3 * BPS + 2] + ((b - c) >> 3));
            dst[d + 3 * BPS + 3] = clip8(ref[r + 3 * BPS + 3] + ((a - e) >> 3));
        }
    }
}

/** The forward transform of src - ref (4x4) into out[o..o + 16] (rows, then columns; unrolled) */
export function fTransform(src: Uint8Array, s: number, ref: Uint8Array, r: number, out: Int16Array, o: number): void {
    const d00 = src[s] - ref[r], d01 = src[s + 1] - ref[r + 1], d02 = src[s + 2] - ref[r + 2], d03 = src[s + 3] - ref[r + 3];
    const a00 = d00 + d03, a01 = d01 + d02, a02 = d01 - d02, a03 = d00 - d03;
    const t00 = (a00 + a01) * 8, t01 = (a02 * 2217 + a03 * 5352 + 1812) >> 9, t02 = (a00 - a01) * 8, t03 = (a03 * 2217 - a02 * 5352 + 937) >> 9;
    const d10 = src[s + 1 * BPS] - ref[r + 1 * BPS], d11 = src[s + 1 * BPS + 1] - ref[r + 1 * BPS + 1], d12 = src[s + 1 * BPS + 2] - ref[r + 1 * BPS + 2], d13 = src[s + 1 * BPS + 3] - ref[r + 1 * BPS + 3];
    const a10 = d10 + d13, a11 = d11 + d12, a12 = d11 - d12, a13 = d10 - d13;
    const t10 = (a10 + a11) * 8, t11 = (a12 * 2217 + a13 * 5352 + 1812) >> 9, t12 = (a10 - a11) * 8, t13 = (a13 * 2217 - a12 * 5352 + 937) >> 9;
    const d20 = src[s + 2 * BPS] - ref[r + 2 * BPS], d21 = src[s + 2 * BPS + 1] - ref[r + 2 * BPS + 1], d22 = src[s + 2 * BPS + 2] - ref[r + 2 * BPS + 2], d23 = src[s + 2 * BPS + 3] - ref[r + 2 * BPS + 3];
    const a20 = d20 + d23, a21 = d21 + d22, a22 = d21 - d22, a23 = d20 - d23;
    const t20 = (a20 + a21) * 8, t21 = (a22 * 2217 + a23 * 5352 + 1812) >> 9, t22 = (a20 - a21) * 8, t23 = (a23 * 2217 - a22 * 5352 + 937) >> 9;
    const d30 = src[s + 3 * BPS] - ref[r + 3 * BPS], d31 = src[s + 3 * BPS + 1] - ref[r + 3 * BPS + 1], d32 = src[s + 3 * BPS + 2] - ref[r + 3 * BPS + 2], d33 = src[s + 3 * BPS + 3] - ref[r + 3 * BPS + 3];
    const a30 = d30 + d33, a31 = d31 + d32, a32 = d31 - d32, a33 = d30 - d33;
    const t30 = (a30 + a31) * 8, t31 = (a32 * 2217 + a33 * 5352 + 1812) >> 9, t32 = (a30 - a31) * 8, t33 = (a33 * 2217 - a32 * 5352 + 937) >> 9;
    const b00 = t00 + t30, b01 = t10 + t20, b02 = t10 - t20, b03 = t00 - t30;
    out[o + 0] = (b00 + b01 + 7) >> 4;
    out[o + 4] = ((b02 * 2217 + b03 * 5352 + 12000) >> 16) + (b03 !== 0 ? 1 : 0);
    out[o + 8] = (b00 - b01 + 7) >> 4;
    out[o + 12] = (b03 * 2217 - b02 * 5352 + 51000) >> 16;
    const b10 = t01 + t31, b11 = t11 + t21, b12 = t11 - t21, b13 = t01 - t31;
    out[o + 1] = (b10 + b11 + 7) >> 4;
    out[o + 5] = ((b12 * 2217 + b13 * 5352 + 12000) >> 16) + (b13 !== 0 ? 1 : 0);
    out[o + 9] = (b10 - b11 + 7) >> 4;
    out[o + 13] = (b13 * 2217 - b12 * 5352 + 51000) >> 16;
    const b20 = t02 + t32, b21 = t12 + t22, b22 = t12 - t22, b23 = t02 - t32;
    out[o + 2] = (b20 + b21 + 7) >> 4;
    out[o + 6] = ((b22 * 2217 + b23 * 5352 + 12000) >> 16) + (b23 !== 0 ? 1 : 0);
    out[o + 10] = (b20 - b21 + 7) >> 4;
    out[o + 14] = (b23 * 2217 - b22 * 5352 + 51000) >> 16;
    const b30 = t03 + t33, b31 = t13 + t23, b32 = t13 - t23, b33 = t03 - t33;
    out[o + 3] = (b30 + b31 + 7) >> 4;
    out[o + 7] = ((b32 * 2217 + b33 * 5352 + 12000) >> 16) + (b33 !== 0 ? 1 : 0);
    out[o + 11] = (b30 - b31 + 7) >> 4;
    out[o + 15] = (b33 * 2217 - b32 * 5352 + 51000) >> 16;
}

// the bin of a coefficient in the histograms (/8, up to 31)
const bin = (c: number): number => {
    const v = (c < 0 ? -c : c) >> 3;
    return v < 31 ? v : 31;
};

/**
 * Adds the forward transform of src - ref (4x4) to a histogram of {@link bin}s (as {@link fTransform}, unrolled), but
 * returns the count of bin 0 (most of them; not added there one by one, which would wait on each other)
 */
function fTransformHistogram(src: Uint8Array, s: number, ref: Uint8Array, r: number, dist: Int32Array): number {
    const d00 = src[s] - ref[r], d01 = src[s + 1] - ref[r + 1], d02 = src[s + 2] - ref[r + 2], d03 = src[s + 3] - ref[r + 3];
    const a00 = d00 + d03, a01 = d01 + d02, a02 = d01 - d02, a03 = d00 - d03;
    const t00 = (a00 + a01) * 8, t01 = (a02 * 2217 + a03 * 5352 + 1812) >> 9, t02 = (a00 - a01) * 8, t03 = (a03 * 2217 - a02 * 5352 + 937) >> 9;
    const d10 = src[s + 1 * BPS] - ref[r + 1 * BPS], d11 = src[s + 1 * BPS + 1] - ref[r + 1 * BPS + 1], d12 = src[s + 1 * BPS + 2] - ref[r + 1 * BPS + 2], d13 = src[s + 1 * BPS + 3] - ref[r + 1 * BPS + 3];
    const a10 = d10 + d13, a11 = d11 + d12, a12 = d11 - d12, a13 = d10 - d13;
    const t10 = (a10 + a11) * 8, t11 = (a12 * 2217 + a13 * 5352 + 1812) >> 9, t12 = (a10 - a11) * 8, t13 = (a13 * 2217 - a12 * 5352 + 937) >> 9;
    const d20 = src[s + 2 * BPS] - ref[r + 2 * BPS], d21 = src[s + 2 * BPS + 1] - ref[r + 2 * BPS + 1], d22 = src[s + 2 * BPS + 2] - ref[r + 2 * BPS + 2], d23 = src[s + 2 * BPS + 3] - ref[r + 2 * BPS + 3];
    const a20 = d20 + d23, a21 = d21 + d22, a22 = d21 - d22, a23 = d20 - d23;
    const t20 = (a20 + a21) * 8, t21 = (a22 * 2217 + a23 * 5352 + 1812) >> 9, t22 = (a20 - a21) * 8, t23 = (a23 * 2217 - a22 * 5352 + 937) >> 9;
    const d30 = src[s + 3 * BPS] - ref[r + 3 * BPS], d31 = src[s + 3 * BPS + 1] - ref[r + 3 * BPS + 1], d32 = src[s + 3 * BPS + 2] - ref[r + 3 * BPS + 2], d33 = src[s + 3 * BPS + 3] - ref[r + 3 * BPS + 3];
    const a30 = d30 + d33, a31 = d31 + d32, a32 = d31 - d32, a33 = d30 - d33;
    const t30 = (a30 + a31) * 8, t31 = (a32 * 2217 + a33 * 5352 + 1812) >> 9, t32 = (a30 - a31) * 8, t33 = (a33 * 2217 - a32 * 5352 + 937) >> 9;
    const b00 = t00 + t30, b01 = t10 + t20, b02 = t10 - t20, b03 = t00 - t30;
    const c0 = (b00 + b01 + 7) >> 4;
    const c4 = ((b02 * 2217 + b03 * 5352 + 12000) >> 16) + (b03 !== 0 ? 1 : 0);
    const c8 = (b00 - b01 + 7) >> 4;
    const c12 = (b03 * 2217 - b02 * 5352 + 51000) >> 16;
    const b10 = t01 + t31, b11 = t11 + t21, b12 = t11 - t21, b13 = t01 - t31;
    const c1 = (b10 + b11 + 7) >> 4;
    const c5 = ((b12 * 2217 + b13 * 5352 + 12000) >> 16) + (b13 !== 0 ? 1 : 0);
    const c9 = (b10 - b11 + 7) >> 4;
    const c13 = (b13 * 2217 - b12 * 5352 + 51000) >> 16;
    const b20 = t02 + t32, b21 = t12 + t22, b22 = t12 - t22, b23 = t02 - t32;
    const c2 = (b20 + b21 + 7) >> 4;
    const c6 = ((b22 * 2217 + b23 * 5352 + 12000) >> 16) + (b23 !== 0 ? 1 : 0);
    const c10 = (b20 - b21 + 7) >> 4;
    const c14 = (b23 * 2217 - b22 * 5352 + 51000) >> 16;
    const b30 = t03 + t33, b31 = t13 + t23, b32 = t13 - t23, b33 = t03 - t33;
    const c3 = (b30 + b31 + 7) >> 4;
    const c7 = ((b32 * 2217 + b33 * 5352 + 12000) >> 16) + (b33 !== 0 ? 1 : 0);
    const c11 = (b30 - b31 + 7) >> 4;
    const c15 = (b33 * 2217 - b32 * 5352 + 51000) >> 16;
    let zeros = 0;
    if (c0 > -8 && c0 < 8) zeros++;
    else dist[bin(c0)]++;
    if (c1 > -8 && c1 < 8) zeros++;
    else dist[bin(c1)]++;
    if (c2 > -8 && c2 < 8) zeros++;
    else dist[bin(c2)]++;
    if (c3 > -8 && c3 < 8) zeros++;
    else dist[bin(c3)]++;
    if (c4 > -8 && c4 < 8) zeros++;
    else dist[bin(c4)]++;
    if (c5 > -8 && c5 < 8) zeros++;
    else dist[bin(c5)]++;
    if (c6 > -8 && c6 < 8) zeros++;
    else dist[bin(c6)]++;
    if (c7 > -8 && c7 < 8) zeros++;
    else dist[bin(c7)]++;
    if (c8 > -8 && c8 < 8) zeros++;
    else dist[bin(c8)]++;
    if (c9 > -8 && c9 < 8) zeros++;
    else dist[bin(c9)]++;
    if (c10 > -8 && c10 < 8) zeros++;
    else dist[bin(c10)]++;
    if (c11 > -8 && c11 < 8) zeros++;
    else dist[bin(c11)]++;
    if (c12 > -8 && c12 < 8) zeros++;
    else dist[bin(c12)]++;
    if (c13 > -8 && c13 < 8) zeros++;
    else dist[bin(c13)]++;
    if (c14 > -8 && c14 < 8) zeros++;
    else dist[bin(c14)]++;
    if (c15 > -8 && c15 < 8) zeros++;
    else dist[bin(c15)]++;
    return zeros;
}


const ftmp = new Int32Array(16);

/** The forward Walsh-Hadamard transform of the DCs of 16 4x4 blocks (in[0], in[16], ...) */
export function fTransformWHT(input: Int16Array, out: Int16Array): void {
    for (let i = 0, o = 0; i < 4; i++, o += 64) {
        const a0 = input[o] + input[o + 32], a1 = input[o + 16] + input[o + 48];
        const a2 = input[o + 16] - input[o + 48], a3 = input[o] - input[o + 32];
        ftmp[i * 4] = a0 + a1;
        ftmp[i * 4 + 1] = a3 + a2;
        ftmp[i * 4 + 2] = a3 - a2;
        ftmp[i * 4 + 3] = a0 - a1;
    }
    for (let i = 0; i < 4; i++) {
        const a0 = ftmp[i] + ftmp[8 + i], a1 = ftmp[4 + i] + ftmp[12 + i], a2 = ftmp[4 + i] - ftmp[12 + i], a3 = ftmp[i] - ftmp[8 + i];
        out[i] = (a0 + a1) >> 1;
        out[4 + i] = (a3 + a2) >> 1;
        out[8 + i] = (a3 - a2) >> 1;
        out[12 + i] = (a0 - a1) >> 1;
    }
}

/** The inverse Walsh-Hadamard transform: the DCs of the 16 4x4 blocks (out[0], out[16], ...) */
export function iTransformWHT(input: Int16Array, out: Int16Array): void {
    for (let i = 0; i < 4; i++) {
        const a0 = input[i] + input[12 + i], a1 = input[4 + i] + input[8 + i];
        const a2 = input[4 + i] - input[8 + i], a3 = input[i] - input[12 + i];
        ftmp[i] = a0 + a1;
        ftmp[8 + i] = a0 - a1;
        ftmp[4 + i] = a3 + a2;
        ftmp[12 + i] = a3 - a2;
    }
    for (let i = 0, o = 0; i < 4; i++, o += 64) {
        const dc = ftmp[i * 4] + 3;
        const a0 = dc + ftmp[i * 4 + 3], a1 = ftmp[i * 4 + 1] + ftmp[i * 4 + 2];
        const a2 = ftmp[i * 4 + 1] - ftmp[i * 4 + 2], a3 = dc - ftmp[i * 4 + 3];
        out[o] = (a0 + a1) >> 3;
        out[o + 16] = (a3 + a2) >> 3;
        out[o + 32] = (a0 - a1) >> 3;
        out[o + 48] = (a3 - a2) >> 3;
    }
}

// ---- metrics

/** The sum of squared differences of a 4x4 block (unrolled) */
export function sse4x4(a: Uint8Array, ao: number, b: Uint8Array, bo: number): number {
    const d00 = a[ao] - b[bo], d01 = a[ao + 1] - b[bo + 1], d02 = a[ao + 2] - b[bo + 2], d03 = a[ao + 3] - b[bo + 3];
    const d10 = a[ao + 1 * BPS] - b[bo + 1 * BPS], d11 = a[ao + 1 * BPS + 1] - b[bo + 1 * BPS + 1], d12 = a[ao + 1 * BPS + 2] - b[bo + 1 * BPS + 2], d13 = a[ao + 1 * BPS + 3] - b[bo + 1 * BPS + 3];
    const d20 = a[ao + 2 * BPS] - b[bo + 2 * BPS], d21 = a[ao + 2 * BPS + 1] - b[bo + 2 * BPS + 1], d22 = a[ao + 2 * BPS + 2] - b[bo + 2 * BPS + 2], d23 = a[ao + 2 * BPS + 3] - b[bo + 2 * BPS + 3];
    const d30 = a[ao + 3 * BPS] - b[bo + 3 * BPS], d31 = a[ao + 3 * BPS + 1] - b[bo + 3 * BPS + 1], d32 = a[ao + 3 * BPS + 2] - b[bo + 3 * BPS + 2], d33 = a[ao + 3 * BPS + 3] - b[bo + 3 * BPS + 3];
    return d00 * d00 + d01 * d01 + d02 * d02 + d03 * d03 + d10 * d10 + d11 * d11 + d12 * d12 + d13 * d13 + d20 * d20 + d21 * d21 + d22 * d22 + d23 * d23 + d30 * d30 + d31 * d31 + d32 * d32 + d33 * d33;
}

/** The sum of squared differences of a 16 x h block */
export function sse16(a: Uint8Array, ao: number, b: Uint8Array, bo: number, h: number): number {
    let count = 0;
    for (let y = 0; y < h; y++, ao += BPS, bo += BPS) {
        const d0 = a[ao] - b[bo], d1 = a[ao + 1] - b[bo + 1], d2 = a[ao + 2] - b[bo + 2], d3 = a[ao + 3] - b[bo + 3],
            d4 = a[ao + 4] - b[bo + 4], d5 = a[ao + 5] - b[bo + 5], d6 = a[ao + 6] - b[bo + 6], d7 = a[ao + 7] - b[bo + 7],
            d8 = a[ao + 8] - b[bo + 8], d9 = a[ao + 9] - b[bo + 9], d10 = a[ao + 10] - b[bo + 10], d11 = a[ao + 11] - b[bo + 11],
            d12 = a[ao + 12] - b[bo + 12], d13 = a[ao + 13] - b[bo + 13], d14 = a[ao + 14] - b[bo + 14], d15 = a[ao + 15] - b[bo + 15];
        count += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3 + d4 * d4 + d5 * d5 + d6 * d6 + d7 * d7 + d8 * d8 + d9 * d9 + d10 * d10 + d11 * d11 + d12 * d12 + d13 * d13 + d14 * d14 + d15 * d15;
    }
    return count;
}

/** The weighted sum of the absolute Hadamard transform coefficients of a 4x4 block (rows, then columns; unrolled) */
export function tTransform(input: Uint8Array, i: number, w: ArrayLike<number>): number {
    const r00 = input[i], r01 = input[i + 1], r02 = input[i + 2], r03 = input[i + 3];
    const a00 = r00 + r02, a01 = r01 + r03, a02 = r01 - r03, a03 = r00 - r02;
    const h00 = a00 + a01, h01 = a03 + a02, h02 = a03 - a02, h03 = a00 - a01;
    const r10 = input[i + 1 * BPS], r11 = input[i + 1 * BPS + 1], r12 = input[i + 1 * BPS + 2], r13 = input[i + 1 * BPS + 3];
    const a10 = r10 + r12, a11 = r11 + r13, a12 = r11 - r13, a13 = r10 - r12;
    const h10 = a10 + a11, h11 = a13 + a12, h12 = a13 - a12, h13 = a10 - a11;
    const r20 = input[i + 2 * BPS], r21 = input[i + 2 * BPS + 1], r22 = input[i + 2 * BPS + 2], r23 = input[i + 2 * BPS + 3];
    const a20 = r20 + r22, a21 = r21 + r23, a22 = r21 - r23, a23 = r20 - r22;
    const h20 = a20 + a21, h21 = a23 + a22, h22 = a23 - a22, h23 = a20 - a21;
    const r30 = input[i + 3 * BPS], r31 = input[i + 3 * BPS + 1], r32 = input[i + 3 * BPS + 2], r33 = input[i + 3 * BPS + 3];
    const a30 = r30 + r32, a31 = r31 + r33, a32 = r31 - r33, a33 = r30 - r32;
    const h30 = a30 + a31, h31 = a33 + a32, h32 = a33 - a32, h33 = a30 - a31;
    const b00 = h00 + h20, b01 = h10 + h30, b02 = h10 - h30, b03 = h00 - h20;
    const b10 = h01 + h21, b11 = h11 + h31, b12 = h11 - h31, b13 = h01 - h21;
    const b20 = h02 + h22, b21 = h12 + h32, b22 = h12 - h32, b23 = h02 - h22;
    const b30 = h03 + h23, b31 = h13 + h33, b32 = h13 - h33, b33 = h03 - h23;
    return w[0] * Math.abs(b00 + b01) + w[4] * Math.abs(b03 + b02) + w[8] * Math.abs(b03 - b02) + w[12] * Math.abs(b00 - b01) +
        w[1] * Math.abs(b10 + b11) + w[5] * Math.abs(b13 + b12) + w[9] * Math.abs(b13 - b12) + w[13] * Math.abs(b10 - b11) +
        w[2] * Math.abs(b20 + b21) + w[6] * Math.abs(b23 + b22) + w[10] * Math.abs(b23 - b22) + w[14] * Math.abs(b20 - b21) +
        w[3] * Math.abs(b30 + b31) + w[7] * Math.abs(b33 + b32) + w[11] * Math.abs(b33 - b32) + w[15] * Math.abs(b30 - b31);
}

/**
 * The texture distortion of a 4x4 block: how different its weighted spectrum is from the source's (its
 * {@link tTransform})
 */
export function tDisto4x4(source: number, b: Uint8Array, bo: number, w: ArrayLike<number>): number {
    return Math.abs(tTransform(b, bo, w) - source) >> 5;
}

/** The texture distortion of a 16x16 block (sources: the 4x4 blocks' {@link tTransform}s) */
export function tDisto16x16(sources: Int32Array, b: Uint8Array, bo: number, w: ArrayLike<number>): number {
    let d = 0;
    for (let n = 0; n < 16; n++) d += tDisto4x4(sources[n], b, bo + SCAN[n], w);
    return d;
}

/** Whether a 16x16 block is a single color */
export function isFlatSource16(src: Uint8Array, s: number): boolean {
    const v = src[s];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (src[s + y * BPS + x] !== v) return false;
    return true;
}

/** Whether num blocks of levels have at most thresh non-zero AC levels */
export function isFlat(levels: Int16Array, l: number, num: number, thresh: number): boolean {
    let score = 0;
    for (; num > 0; num--, l += 16) {
        for (let i = 1; i < 16; i++) {
            if (levels[l + i]) score++;
            if (score > thresh) return false;
        }
    }
    return true;
}

// ---- quantization

/** A quantizer matrix: steps, reciprocals, rounding biases, zero thresholds and sharpening */
export interface Matrix {
    q: Uint16Array;
    iq: Uint16Array;
    bias: Uint32Array;
    zthresh: Uint32Array;
    sharpen: Uint16Array;
}

export const newMatrix = (): Matrix => ({
    q: new Uint16Array(16), iq: new Uint16Array(16), bias: new Uint32Array(16), zthresh: new Uint32Array(16), sharpen: new Uint16Array(16)
});

/** Quantizes a 4x4 block (in: the coefficients, replaced by the dequantized ones; out: the levels in zigzag order) */
export function quantizeBlock(input: Int16Array, i: number, out: Int16Array, o: number, m: Matrix): boolean {
    let nz = 0;
    const sharpen = m.sharpen;
    {
        // the DC
        const c = input[i], sign = c < 0;
        const coeff = (sign ? -c : c) + sharpen[0];
        if (coeff > m.zthresh[0]) {
            let level = (coeff * m.iq[0] + m.bias[0]) >>> QFIX;
            if (level > MAX_LEVEL) level = MAX_LEVEL;
            if (sign) level = -level;
            input[i] = level * m.q[0];
            out[o] = level;
            nz |= level;
        } else out[o] = input[i] = 0;
    }
    // (the AC coefficients share their quantizer)
    const q = m.q[1], iq = m.iq[1], bias = m.bias[1], zthresh = m.zthresh[1];
    for (let n = 1; n < 16; n++) {
        const j = ZIGZAG[n];
        const c = input[i + j], sign = c < 0;
        const coeff = (sign ? -c : c) + sharpen[j];
        if (coeff > zthresh) {
            let level = (coeff * iq + bias) >>> QFIX;
            if (level > MAX_LEVEL) level = MAX_LEVEL;
            if (sign) level = -level;
            input[i + j] = level * q;
            out[o + n] = level;
            nz |= level;
        } else out[o + n] = input[i + j] = 0;
    }
    return nz !== 0;
}

/** The sums of the 4 4x4 blocks of a 16x4 row */
export function mean16x4(src: Uint8Array, s: number, dc: Uint32Array, d: number): void {
    for (let k = 0; k < 4; k++, s += 4) {
        let sum = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sum += src[s + x + y * BPS];
        dc[d + k] = sum;
    }
}

const distribution = new Int32Array(32);
// the 4x4 blocks of luma, U and V (relative to U for those)
const DSP_SCAN = [...SCAN, 0, 4, 4 * BPS, 4 * BPS + 4, 8, 12, 4 * BPS + 8, 4 * BPS + 12];

/**
 * The susceptibility of blocks (start to end of luma 0-15, then U and V 16-23) to a prediction: from the histogram of
 * their transform coefficients (/8, up to 31), the last bin used relative to the most frequent (0-510)
 */
export function histogramAlpha(ref: Uint8Array, r: number, pred: Uint8Array, p: number, start: number, end: number): number {
    distribution.fill(0);
    let zeros = 0;
    for (let j = start; j < end; j++) {
        zeros += fTransformHistogram(ref, r + DSP_SCAN[j], pred, p + DSP_SCAN[j], distribution);
    }
    distribution[0] += zeros;
    let max = 0, last = 1;
    for (let k = 0; k <= 31; k++) {
        if (distribution[k] > 0) {
            if (distribution[k] > max) max = distribution[k];
            last = k;
        }
    }
    return max > 1 ? Math.trunc(510 * last / max) : 0;
}
