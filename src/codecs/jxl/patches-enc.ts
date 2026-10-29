/*!
 * JPEG XL patches for the lossy encoder: text-like features of screenshots stored once in a reference frame and added
 * where they repeat, ported from libjxl (lib/jxl/enc_patch_dictionary.cc: FindTextLikePatches, FindBestPatchDictionary,
 * PatchDictionaryEncoder; enc_modular.cc: the XYB quantization of Modular frames). Copyright (c) the JPEG XL Project
 * Authors, BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */

import { BitWriter } from './bit-writer.ts';
import { Tokens, EntropyCode, packSigned } from './entropy-enc.ts';
import { MATree, TreeNode, channelTokens, streamHeader, PRED_GRADIENT, PROP_CHANNEL } from './modular-enc.ts';
import { u32 } from './headers-enc.ts';

// XYB: how patch pixels are quantized for comparing them, and how colors' differences are weighted
const DEQUANT = [0.01615, 0.08875, 0.1922], WEIGHTS = [30, 3, 1];
const PATCH_SIDE = 4, EXTRA_SIDE = 4, MAX_PATCH_SIZE = 32, DISTANCE_LIMIT = 50;
const SIMILAR = 0.8, VERY_SIMILAR = 0.03, HAS_SIMILAR = 0.03, MIN_PEAK = 2, HAS_SIMILAR_RADIUS = 2, MIN_MAX_PATCH_SIZE = 20;
/** the reference frame patches are saved in */
const REFERENCE = 3;

interface Candidate {
    w: number;
    h: number;
    /** the pixels minus the background color, per channel */
    fpixels: Float32Array[];
    /** quantized (int8 like libjxl's), what makes two the same */
    key: string;
    positions: Array<[number, number]>;
}

/** Patches found in an image: its reference frame and the dictionary its frame adds them with */
export interface Patches {
    /** the reference frame: its header, TOC and section, byte aligned */
    frame: BitWriter;
    /** writes the dictionary (at the start of the frame's LfGlobal) */
    writeDictionary(w: BitWriter): void;
}

// a half precision float's bits, rounded to the nearest
function f16(v: number): number {
    const f = new Float32Array(1), u = new Uint32Array(f.buffer);
    f[0] = v;
    const x = u[0], sign = x >>> 16 & 0x8000, e = (x >>> 23 & 255) - 127 + 15;
    let m = x & 0x7fffff;
    if (e <= 0) return sign;
    if (e >= 31) return sign | 0x7bff;
    m += 0x1000;
    if (m & 0x800000) return e + 1 >= 31 ? sign | 0x7bff : sign | (e + 1) << 10;
    return sign | e << 10 | m >> 13;
}

function fromF16(bits: number): number {
    const e = bits >> 10 & 31, m = bits & 1023, s = bits & 0x8000 ? -1 : 1;
    return e === 0 ? s * m / 1024 / 16384 : s * (1 + m / 1024) * 2 ** (e - 15);
}

/** libjxl's FindTextLikePatches: repeated small features on flat backgrounds of screenshot-like areas */
function candidates(planes: Float32Array[], stride: number, width: number, height: number): Candidate[] {
    const [p0, p1, p2] = planes;
    const at = (c: number, x: number, y: number): number => planes[c][y * stride + x];
    const same = (x1: number, y1: number, x2: number, y2: number): boolean => {
        const i = y1 * stride + x1, j = y2 * stride + x2;
        return Math.abs(p0[i] - p0[j]) <= 1e-4 && Math.abs(p1[i] - p1[j]) <= 1e-4 && Math.abs(p2[i] - p2[j]) <= 1e-4;
    };
    // (the weighted difference of two colors: of planes a at index i and planes b at index j)
    const similar = (a: Float32Array[], i: number, b: Float32Array[], j: number, threshold: number): boolean =>
        Math.abs(a[0][i] - b[0][j]) * WEIGHTS[0] + Math.abs(a[1][i] - b[1][j]) * WEIGHTS[1] + Math.abs(a[2][i] - b[2][j]) * WEIGHTS[2] <= threshold;

    // naturally aligned 4x4 squares of one color with mostly the same color around them
    const sw = Math.ceil(width / PATCH_SIDE), screenshot = new Uint8Array(sw * Math.ceil(height / PATCH_SIDE));
    let any = false;
    for (let by = 0; by < Math.floor(height / PATCH_SIDE); by++) {
        for (let bx = 0; bx < Math.floor(width / PATCH_SIDE); bx++) {
            const x0 = bx * PATCH_SIDE, y0 = by * PATCH_SIDE;
            let allSame = true;
            for (let iy = 0; iy < PATCH_SIDE && allSame; iy++) for (let ix = 0; ix < PATCH_SIDE; ix++) if (!same(x0 + ix, y0 + iy, x0, y0)) { allSame = false; break; }
            if (!allSame) continue;
            let n = 0, nSame = 0;
            for (let iy = -EXTRA_SIDE; iy < EXTRA_SIDE + PATCH_SIDE; iy++) {
                for (let ix = -EXTRA_SIDE; ix < EXTRA_SIDE + PATCH_SIDE; ix++) {
                    const x = x0 + ix, y = y0 + iy;
                    if (x < 0 || x >= width || y < 0 || y >= height) continue;
                    n++;
                    if (same(x, y, x0, y0)) nSame++;
                }
            }
            if (nSame * 8 < n * 7) continue;
            screenshot[by * sw + bx] = 1;
            any = true;
        }
    }
    if (!any) return [];

    // the background: pixels similar enough to a screenshot-like area nearby, grown from them
    // (a pixel is queued once: the first source that reaches it is the one libjxl's queue would take too)
    const isBackground = new Uint8Array(width * height), queued = new Uint8Array(width * height), background = [0, 1, 2].map(() => new Float32Array(width * height));
    const queue = new Int32Array(width * height * 4);
    let end = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!screenshot[(y / PATCH_SIDE | 0) * sw + (x / PATCH_SIDE | 0)]) continue;
            queue[end++] = x; queue[end++] = y; queue[end++] = x; queue[end++] = y;
            queued[y * width + x] = 1;
        }
    }
    for (let q = 0; q < end; q += 4) {
        const cx = queue[q], cy = queue[q + 1], sx = queue[q + 2], sy = queue[q + 3];
        isBackground[cy * width + cx] = 1;
        for (let c = 0; c < 3; c++) background[c][cy * width + cx] = at(c, sx, sy);
        const src = sy * stride + sx;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const nx = cx + dx, ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height || Math.abs(nx - sx) + Math.abs(ny - sy) > DISTANCE_LIMIT) continue;
                const i = ny * width + nx;
                if (!queued[i] && similar(planes, src, planes, ny * stride + nx, SIMILAR) && (!screenshot[(ny / PATCH_SIDE | 0) * sw + (nx / PATCH_SIDE | 0)] || same(sx, sy, nx, ny))) {
                    queued[i] = 1;
                    queue[end++] = nx; queue[end++] = ny; queue[end++] = sx; queue[end++] = sy;
                }
            }
        }
    }

    // small connected components outside the background, bordered by one background color
    const visited = new Uint8Array(width * height), found: Candidate[] = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (isBackground[y * width + x] || visited[y * width + x]) continue;
            const stack = [x, y];
            let minX = x, maxX = x, minY = y, maxY = y, reference = -1, allSimilar = true;
            while (stack.length) {
                const cy = stack.pop() as number, cx = stack.pop() as number;
                if (visited[cy * width + cx]) continue;
                visited[cy * width + cx] = 1;
                minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (!dx && !dy) continue;
                        const nx = cx + dx, ny = cy + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        const i = ny * width + nx;
                        if (!isBackground[i]) {
                            if (!visited[i]) stack.push(nx, ny);
                        }
                        else if (reference < 0) reference = i;
                        else if (!similar(background, i, background, reference, VERY_SIMILAR)) allSimilar = false;
                    }
                }
            }
            if (reference < 0 || !allSimilar || maxX - minX >= MAX_PATCH_SIZE || maxY - minY >= MAX_PATCH_SIZE) continue;
            const ref = [background[0][reference], background[1][reference], background[2][reference]];
            let hasSimilar = false;
            for (let iy = Math.max(minY - HAS_SIMILAR_RADIUS, 0); iy < Math.min(maxY + HAS_SIMILAR_RADIUS + 1, height) && !hasSimilar; iy++)
                for (let ix = Math.max(minX - HAS_SIMILAR_RADIUS, 0); ix < Math.min(maxX + HAS_SIMILAR_RADIUS + 1, width); ix++)
                    if (similar(background, reference, planes, iy * stride + ix, HAS_SIMILAR)) { hasSimilar = true; break; }
            if (!hasSimilar) continue;

            const w = maxX - minX + 1, h = maxY - minY + 1;
            const fpixels = [0, 1, 2].map(() => new Float32Array(w * h)), quantized = new Int8Array(3 * w * h);
            let peak = 0;
            for (const c of [1, 0, 2]) {
                for (let iy = 0; iy < h; iy++) {
                    for (let ix = 0; ix < w; ix++) {
                        const v = fpixels[c][iy * w + ix] = at(c, minX + ix, minY + iy) - ref[c];
                        const q = Math.trunc(Math.fround(v) / DEQUANT[c]);
                        quantized[c * w * h + iy * w + ix] = q;
                        peak = Math.max(peak, Math.abs(q));
                    }
                }
            }
            if (peak < MIN_PEAK) continue;
            found.push({ w, h, fpixels, key: `${w}x${h}:${quantized.join(',')}`, positions: [[minX, minY]] });
        }
    }

    // the ones occurring at least twice, unless all of them are tiny
    const unique = new Map<string, Candidate>();
    for (const c of found) {
        const u = unique.get(c.key);
        if (u) u.positions.push(...c.positions);
        else unique.set(c.key, c);
    }
    const repeated = [...unique.values()].filter(c => c.positions.length >= 2);
    if (!repeated.length || Math.max(...repeated.map(c => c.w * c.h)) < MIN_MAX_PATCH_SIZE) return [];
    return repeated;
}

/**
 * Finds the patches of an image (XYB planes), subtracts them (as they decode) from the planes, and encodes their
 * reference frame (Modular, its XYB quantized for the distance like libjxl's, lossless with the gradient predictor)
 * @returns null without patches
 */
export function findPatches(planes: Float32Array[], stride: number, width: number, height: number, distance: number, numExtra: number): Patches | null {
    const info = candidates(planes, stride, width, height);
    if (!info.length) return null;

    // bin packing: larger patches first, into the first free spot of a frame that grows until all fit
    info.sort((a, b) => b.w * b.h - a.w * a.h);
    let total = 0, maxW = 0, maxH = 0;
    for (const p of info) {
        total += p.w * p.h;
        maxW = Math.max(maxW, p.w);
        maxH = Math.max(maxH, p.h);
    }
    let refW = Math.max(maxW, Math.sqrt(total)), refH = Math.max(maxH, Math.sqrt(total));
    let spots: Array<[number, number]> = [], usedH = 0;
    for (; ;) {
        refW = Math.floor(refW * 1.05 + 1);
        refH = Math.floor(refH * 1.05 + 1);
        const occupied = new Uint8Array(refW * refH);
        spots = [];
        usedH = 0;
        let ok = true;
        for (const p of info) {
            let spot: [number, number] | null = null;
            for (let y0 = 0; y0 + p.h <= refH && !spot; y0++) {
                for (let x0 = 0; x0 + p.w <= refW;) {
                    let blocked = -1;
                    for (let y = y0; y < y0 + p.h && blocked < 0; y++) for (let x = x0; x < x0 + p.w; x++) if (occupied[y * refW + x]) { blocked = x; break; }
                    if (blocked < 0) { spot = [x0, y0]; break; }
                    x0 = blocked + 1;
                }
            }
            if (!spot) { ok = false; break; }
            for (let y = spot[1]; y < spot[1] + p.h; y++) occupied.fill(1, y * refW + spot[0], y * refW + spot[0] + p.w);
            spots.push(spot);
            usedH = Math.max(usedH, spot[1] + p.h);
        }
        if (ok) break;
    }
    refH = usedH;
    // (the reference frame is a single Modular group)
    if (refW > 1024 || refH > 1024) return null;

    // the reference frame's channels: Y, X and B - Y, quantized by libjxl's factors for the distance (through the LF
    // dequantization's half floats, so they decode to what is subtracted)
    const factors = [65536 / (1 + 23 * distance), 4096 / (1 + 14 * distance), 4096 / (1 + 14 * distance)];
    const lfBits = factors.map(f => f16(128 / f)), steps = lfBits.map(b => fromF16(b) / 128);
    const n = refW * refH, ints = [0, 1, 2].map(() => new Int32Array(n)), decoded = [0, 1, 2].map(() => new Float32Array(n));
    info.forEach((p, k) => {
        const [x0, y0] = spots[k];
        for (let y = 0; y < p.h; y++) {
            for (let x = 0; x < p.w; x++) {
                const i = (y0 + y) * refW + x0 + x, j = y * p.w + x;
                for (let c = 0; c < 3; c++) ints[c][i] = Math.round(p.fpixels[c][j] / steps[c]);
                for (let c = 0; c < 3; c++) decoded[c][i] = Math.fround(ints[c][i] * steps[c]);
            }
        }
    });
    // (subtracted where they're added)
    info.forEach((p, k) => {
        const [x0, y0] = spots[k];
        for (const [px, py] of p.positions)
            for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) for (let c = 0; c < 3; c++) planes[c][(py + y) * stride + px + x] -= decoded[c][(y0 + y) * refW + x0 + x];
    });

    // the reference frame: Modular, reference only, cropped to its size, saved before the color transform
    const frame = new BitWriter();
    frame.write(1, 0);
    frame.write(2, 2);
    frame.write(1, 1);
    frame.write(2, 0);
    frame.write(2, 0);
    for (let e = 0; e < numExtra; e++) frame.write(2, 0);
    frame.write(2, 3);
    frame.write(1, 1);
    const sizes: [number, number][] = [[8, 0], [11, 256], [14, 2304], [30, 18688]];
    u32(frame, refW, sizes);
    u32(frame, refH, sizes);
    frame.write(2, REFERENCE);
    frame.write(1, 1);
    // no name, the loop filter: no Gaborish or EPF; no extensions
    u32(frame, 0, [[0, 0], [4, 0], [5, 16], [10, 48]]);
    frame.write(1, 0);
    frame.write(1, 0);
    frame.write(2, 0);
    frame.write(2, 0);
    frame.write(2, 0);

    // its single section: LfGlobal with the LF dequantization, the global tree (a gradient leaf per channel) and the
    // image (Y, X, B - Y, empty extra channels)
    const section = new BitWriter();
    section.write(1, 0);
    for (const b of [lfBits[0], lfBits[1], lfBits[2]]) section.write(16, b);
    const channels = [ints[1], ints[0], ints[2].map((v, i) => v - ints[1][i])];
    for (let e = 0; e < numExtra; e++) channels.push(new Int32Array(n));
    let root: TreeNode = { predictor: PRED_GRADIENT };
    for (let c = channels.length - 2; c >= 0; c--) root = { property: PROP_CHANNEL, split: c, above: root, below: { predictor: PRED_GRADIENT } };
    const tree = new MATree(root), tokens = new Tokens();
    channels.forEach((data, c) => channelTokens(tokens, tree, data, refW, refH, c, 0));
    const code = new EntropyCode([tokens], tree.numLeaves);
    section.write(1, 1);
    tree.write(section);
    code.writeHeader(section);
    streamHeader(section);
    code.writeTokens(section, tokens);
    section.zeroPadToByte();
    frame.write(1, 0);
    frame.zeroPadToByte();
    u32(frame, section.length, [[10, 0], [14, 1024], [22, 17408], [30, 4211712]]);
    frame.zeroPadToByte();
    frame.append(section);

    // the dictionary: per patch its place in the reference frame and where it's added (kAdd for the color, kNone for
    // the extra channels)
    const dictionary = new Tokens();
    dictionary.push(0, info.length);
    info.forEach((p, k) => {
        dictionary.push(1, REFERENCE);
        dictionary.push(3, spots[k][0]);
        dictionary.push(3, spots[k][1]);
        dictionary.push(2, p.w - 1);
        dictionary.push(2, p.h - 1);
        dictionary.push(7, p.positions.length - 1);
        p.positions.forEach(([x, y], i) => {
            if (i) {
                dictionary.push(6, packSigned(x - p.positions[i - 1][0]));
                dictionary.push(6, packSigned(y - p.positions[i - 1][1]));
            } else {
                dictionary.push(4, x);
                dictionary.push(4, y);
            }
            dictionary.push(5, 2);
            for (let e = 0; e < numExtra; e++) dictionary.push(5, 0);
        });
    });
    const dictionaryCode = new EntropyCode([dictionary], 10);
    return {
        frame,
        writeDictionary: (w: BitWriter): void => {
            dictionaryCode.writeHeader(w);
            dictionaryCode.writeTokens(w, dictionary);
        },
    };
}
