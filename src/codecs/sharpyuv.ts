/*!
 * libwebp's sharp RGB to YUV 4:2:0 conversion (sharpyuv/sharpyuv.c, sharpyuv_dsp.c, sharpyuv_gamma.c), ported for 8
 * bit RGB to 8 bit YUV with the WebP matrix: luma and chroma are chosen iteratively so that the picture upsampled
 * again matches the original better, sharper at color edges than averaging the chroma. Copyright (c) 2022 Google
 * Inc., BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */

const ITERATIONS = 4;
// RGB is 8 bits, the work is done in 10 (2 more bits of precision, sharpyuv's GetPrecisionShift)
const SHIFT = 2, BITS = 10, MAX = (1 << BITS) - 1;

// the gamma curve (libwebp calls it sRGB: Rec. 709's), as 16 bit linear values from 10 bit ones and back by a 513
// entry table
const TO_LINEAR = new Uint32Array(1024 + 2), FROM_LINEAR = new Uint32Array(512 + 2);
{
    const a = 0.09929682680944, thresh = 0.018053968510807, gamma = 1 / 0.45;
    for (let v = 0; v <= 1024; v++) {
        const g = v / 1024;
        TO_LINEAR[v] = Math.trunc((g <= thresh * 4.5 ? g / 4.5 : Math.pow((g + a) / (1 + a), gamma)) * 65536 + 0.5);
    }
    TO_LINEAR[1025] = TO_LINEAR[1024];
    for (let v = 0; v <= 512; v++) {
        const g = v / 512;
        FROM_LINEAR[v] = Math.trunc(65536 * (g <= thresh ? 4.5 * g : (1 + a) * Math.pow(g, 1 / gamma) - a) + 0.5);
    }
    FROM_LINEAR[513] = FROM_LINEAR[512];
}

const toLinear = (v: number): number => TO_LINEAR[v];

function fromLinear(value: number): number {
    const pos = value >>> 7, x = value - (pos << 7);
    const v0 = FROM_LINEAR[pos] >>> 6, v1 = FROM_LINEAR[pos + 1] >>> 6;
    return v0 + (((v1 - v0) * x + 64) >>> 7);
}

// (the values can take more than 32 bits)
const gray = (r: number, g: number, b: number): number => Math.floor((13933 * r + 46871 * g + 4732 * b + 32768) / 65536);
const clip = (v: number): number => v < 0 ? 0 : v > MAX ? MAX : v;

// the gamma compressed luma of a row of R, G and B planes (w each)
function updateW(src: Uint16Array, s: number, dst: Uint16Array, d: number, w: number): void {
    for (let i = 0; i < w; i++) dst[d + i] = fromLinear(gray(toLinear(src[s + i]), toLinear(src[s + w + i]), toLinear(src[s + 2 * w + i])));
}

// the average of 4 gamma compressed values, in linear light
const scaleDown = (a: number, b: number, c: number, d: number): number => fromLinear((toLinear(a) + toLinear(b) + toLinear(c) + toLinear(d) + 2) >> 2);

// the chroma (R, G and B minus their luma) of 2 rows of R, G and B planes (2 uvWidth each) into 3 planes of uvWidth
function updateChroma(src: Uint16Array, s1: number, s2: number, dst: Int16Array, d: number, uvWidth: number): void {
    const w = 2 * uvWidth;
    for (let i = 0; i < uvWidth; i++) {
        const o = 2 * i;
        const r = scaleDown(src[s1 + o], src[s1 + o + 1], src[s2 + o], src[s2 + o + 1]);
        const g = scaleDown(src[s1 + w + o], src[s1 + w + o + 1], src[s2 + w + o], src[s2 + w + o + 1]);
        const b = scaleDown(src[s1 + 2 * w + o], src[s1 + 2 * w + o + 1], src[s2 + 2 * w + o], src[s2 + 2 * w + o + 1]);
        const W = gray(r, g, b);
        dst[d + i] = r - W;
        dst[d + uvWidth + i] = g - W;
        dst[d + 2 * uvWidth + i] = b - W;
    }
}

function storeGray(rgb: Uint16Array, s: number, y: Uint16Array, d: number, w: number): void {
    for (let i = 0; i < w; i++) y[d + i] = gray(rgb[s + i], rgb[s + w + i], rgb[s + 2 * w + i]);
}

// a row of RGBA as R, G and B planes (w each, w even: an odd width's last pixel again), 10 bit
function importRow(rgba: Uint8Array, o: number, width: number, w: number, dst: Uint16Array, d: number): void {
    for (let i = 0; i < width; i++, o += 4) {
        dst[d + i] = rgba[o] << SHIFT;
        dst[d + w + i] = rgba[o + 1] << SHIFT;
        dst[d + 2 * w + i] = rgba[o + 2] << SHIFT;
    }
    if (width & 1) for (let c = 0; c < 3; c++) dst[d + c * w + width] = dst[d + c * w + width - 1];
}

// the RGB of 2 rows (into out at o1 and o2) from their luma and the chroma upsampled (cur, the rows' chroma, with
// prev and next, the rows above and below): sharpyuv's InterpolateTwoRows
function interpolateTwoRows(bestY: Uint16Array, y: number, uv: Int16Array, prev: number, cur: number, next: number, w: number, out: Uint16Array, o1: number, o2: number): void {
    const uvWidth = w >> 1, len = (w - 1) >> 1;
    const filter2 = (a: number, b: number, w0: number): number => clip(((a * 3 + b + 2) >> 2) + w0);
    const filterRow = (a: number, b: number, by: number, o: number): void => {
        for (let i = 0; i < len; i++, a++, b++) {
            const v0 = (uv[a] * 9 + uv[a + 1] * 3 + uv[b] * 3 + uv[b + 1] + 8) >> 4;
            const v1 = (uv[a + 1] * 9 + uv[a] * 3 + uv[b + 1] * 3 + uv[b] + 8) >> 4;
            out[o + 2 * i] = clip(bestY[by + 2 * i] + v0);
            out[o + 2 * i + 1] = clip(bestY[by + 2 * i + 1] + v1);
        }
    };
    for (let k = 0; k < 3; k++) {
        out[o1] = filter2(uv[cur], uv[prev], bestY[y]);
        out[o2] = filter2(uv[cur], uv[next], bestY[y + w]);
        filterRow(cur, prev, y + 1, o1 + 1);
        filterRow(cur, next, y + w + 1, o2 + 1);
        if (!(w & 1)) {
            out[o1 + w - 1] = filter2(uv[cur + uvWidth - 1], uv[prev + uvWidth - 1], bestY[y + w - 1]);
            out[o2 + w - 1] = filter2(uv[cur + uvWidth - 1], uv[next + uvWidth - 1], bestY[y + 2 * w - 1]);
        }
        o1 += w;
        o2 += w;
        prev += uvWidth;
        cur += uvWidth;
        next += uvWidth;
    }
}

// the WebP matrix (limited range Rec. 601) for 10 bit RGB: Y, U and V of R, G and B, rounded
const yuv = (r: number, g: number, b: number, c0: number, c1: number, c2: number, offset: number): number =>
    (c0 * r + c1 * g + c2 * b + (offset << 18) + (1 << 17)) >> 18;
const clip8 = (v: number): number => v < 0 ? 0 : v > 255 ? 255 : v;

/**
 * The luma and chroma of RGBA pixels (their alpha isn't used) by libwebp's sharp conversion (at least 4x4 pixels, as
 * libwebp uses it): y has width x height values, u and v (width + 1) / 2 x (height + 1) / 2
 */
export function sharpYUV(rgba: Uint8Array, width: number, height: number, y: Uint8Array, u: Uint8Array, v: Uint8Array): void {
    const w = (width + 1) & ~1, h = (height + 1) & ~1, uvWidth = w >> 1, uvHeight = h >> 1;
    const tmp = new Uint16Array(w * 6), bestY = new Uint16Array(w * h), targetY = new Uint16Array(w * h), bestRGBY = new Uint16Array(w * 2);
    const bestUV = new Int16Array(uvWidth * 3 * uvHeight), targetUV = new Int16Array(uvWidth * 3 * uvHeight), bestRGBUV = new Int16Array(uvWidth * 3);
    const stride = width * 4;

    // the start: luma of the original, chroma averaged in linear light
    for (let j = 0, uvRow = 0; j < height; j += 2, uvRow += 3 * uvWidth) {
        importRow(rgba, j * stride, width, w, tmp, 0);
        if (j < height - 1) importRow(rgba, (j + 1) * stride, width, w, tmp, 3 * w);
        else tmp.copyWithin(3 * w, 0, 3 * w);
        storeGray(tmp, 0, bestY, j * w, w);
        storeGray(tmp, 3 * w, bestY, (j + 1) * w, w);
        updateW(tmp, 0, targetY, j * w, w);
        updateW(tmp, 3 * w, targetY, (j + 1) * w, w);
        updateChroma(tmp, 0, 3 * w, targetUV, uvRow, uvWidth);
        bestUV.set(targetUV.subarray(uvRow, uvRow + 3 * uvWidth), uvRow);
    }

    // the luma and chroma move by how much the upsampled picture's differ from the target's
    const threshold = Math.trunc(3 * w * h);
    let previousSum = Infinity;
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        let cur = 0, prev = 0, sum = 0;
        for (let j = 0; j < h; j += 2) {
            const next = cur + (j < h - 2 ? 3 * uvWidth : 0);
            interpolateTwoRows(bestY, j * w, bestUV, prev, cur, next, w, tmp, 0, 3 * w);
            prev = cur;
            cur = next;
            updateW(tmp, 0, bestRGBY, 0, w);
            updateW(tmp, 3 * w, bestRGBY, w, w);
            updateChroma(tmp, 0, 3 * w, bestRGBUV, 0, uvWidth);
            for (let i = 0; i < 2 * w; i++) {
                const diff = targetY[j * w + i] - bestRGBY[i];
                bestY[j * w + i] = clip(bestY[j * w + i] + diff);
                sum += Math.abs(diff);
            }
            const uvRow = (j >> 1) * 3 * uvWidth;
            for (let i = 0; i < 3 * uvWidth; i++) bestUV[uvRow + i] += targetUV[uvRow + i] - bestRGBUV[i];
        }
        if (iteration > 0 && (sum < threshold || sum > previousSum)) break;
        previousSum = sum;
    }

    // to YUV
    for (let j = 0; j < height; j++) {
        const uvRow = (j >> 1) * 3 * uvWidth;
        for (let i = 0; i < width; i++) {
            const W = bestY[j * w + i], o = uvRow + (i >> 1);
            const r = bestUV[o] + W, g = bestUV[o + uvWidth] + W, b = bestUV[o + 2 * uvWidth] + W;
            y[j * width + i] = clip8(yuv(r, g, b, 16839, 33059, 6420, 16));
        }
    }
    for (let j = 0; j < uvHeight; j++)
        for (let i = 0; i < uvWidth; i++) {
            const o = j * 3 * uvWidth + i;
            const r = bestUV[o], g = bestUV[o + uvWidth], b = bestUV[o + 2 * uvWidth];
            u[j * uvWidth + i] = clip8(yuv(r, g, b, -9719, -19081, 28800, 128));
            v[j * uvWidth + i] = clip8(yuv(r, g, b, 28800, -24116, -4684, 128));
        }
}
