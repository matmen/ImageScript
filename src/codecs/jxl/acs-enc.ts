/*!
 * The varblock types of the lossy JPEG XL encoder: libjxl's AC strategy search (lib/jxl/enc_ac_strategy.cc:
 * EstimateEntropy, FindBest8x8Transform, TryMergeAcs, FindBestFirstLevelDivisionForSquare, ProcessRectACS), per 64x64
 * area: the best 8x8 transform of each block, merged into larger DCTs where they are estimated to cost less.
 * Copyright (c) the JPEG XL Project Authors, BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */
import { runChunks, shared, sharedOf, type ChunkTask, type Thread } from '../../util/threads.ts';
import { forwardTransform } from './transforms-enc.ts';
import { inverseTransform } from './dct.ts';
import { defaultDequant, MATRIX_INDEX } from './quant.ts';
import { SIZES, transposed } from './vardct.ts';
import type { QuantField } from './aq-enc.ts';

const DCT8 = 0, IDENTITY = 1, DCT2X2 = 2, DCT4X4 = 3, DCT16X16 = 4, DCT32X32 = 5, DCT16X8 = 6, DCT8X16 = 7;
const DCT32X16 = 10, DCT16X32 = 11, DCT4X8 = 12, DCT8X4 = 13, DCT64X64 = 18, DCT64X32 = 19, DCT32X64 = 20;
const AFV0 = 14, AFV1 = 15, AFV2 = 16, AFV3 = 17;

/** The varblock search: the image's XYB planes, its quantization field and masking, the distance */
interface Config {
    planes: Float32Array[];
    stride: number;
    bw: number;
    field: QuantField;
    distance: number;
    infoLossMul: number;
    zerosMul: number;
    costDelta: number;
}

const ceilLog2 = (x: number): number => x <= 1 ? 0 : 32 - Math.clz32(x - 1);
const CHANNEL_MUL = [10.2 ** 8, 1, 1.03 ** 8];
// (the scratch buffers: the coefficients of the 3 channels, the errors, the LF)
const scratch = [0, 1, 2].map(() => new Float32Array(64 * 64)), errors = new Float32Array(64 * 64), lfScratch = new Float32Array(64);

// the dequantization matrices of a type (in its coefficients' layout), and their inverses
const dequant = (type: number): Float32Array[] => defaultDequant(MATRIX_INDEX[type])[transposed(type) ? 1 : 0];
const inverses = new Map<number, Float32Array[]>();
function inverseDequant(type: number): Float32Array[] {
    let inv = inverses.get(type);
    if (!inv) inverses.set(type, inv = dequant(type).map(m => Float32Array.from(m, v => 1 / v)));
    return inv;
}

// the estimated cost of a varblock of a type at pixels x, y: its bits (by the square roots of the quantized
// coefficients and the non-zero counts) and the information lost (an 8-norm of the masked errors in pixels)
function estimateEntropy(type: number, entropyMul: number, x: number, y: number, cfg: Config): number {
    const w8 = SIZES[2 * type], h8 = SIZES[2 * type + 1], w = w8 * 8, h = h8 * 8, numBlocks = w8 * h8, size = w * h;
    for (let c = 0; c < 3; c++) forwardTransform(type, cfg.planes[c], y * cfg.stride + x, cfg.stride, scratch[c], lfScratch);
    const qf = cfg.field.quant, bw = cfg.bw, bx = x >> 3, by = y >> 3;
    let quant = 0;
    if (numBlocks === 1) quant = qf[by * bw + bx];
    else if (numBlocks === 2) quant = h8 === 2 ? Math.max(qf[by * bw + bx], qf[(by + 1) * bw + bx]) : Math.max(qf[by * bw + bx], qf[by * bw + bx + 1]);
    else {
        for (let iy = 0; iy < h8; iy++) {
            for (let ix = 0; ix < w8; ix++) {
                const v = qf[(by + iy) * bw + bx + ix] ** 8;
                quant += v * v;
            }
        }
        quant = (quant / numBlocks) ** (1 / 16);
    }
    const matrices = dequant(type), inverses = inverseDequant(type);
    const mask = cfg.field.mask1x1, stride = cfg.stride;
    let entropy = 0, loss = 0;
    for (let c = 0; c < 3; c++) {
        const src = scratch[c], ys = scratch[1], m = matrices[c], im = inverses[c], cmap = c === 2 ? 1 : 0;
        let sqrtSum = 0, nonZeros = 0;
        for (let i = 0; i < size; i++) {
            const v = (src[i] - ys[i] * cmap) * im[i] * quant, r = Math.round(v);
            errors[i] = m[i] * (v - r);
            const q = Math.abs(r);
            sqrtSum += Math.sqrt(q);
            if (q) nonZeros++;
        }
        inverseTransform({ buf: errors, offset: 0, stride: w, w, h }, type);
        let lossc = 0;
        for (let py = 0; py < h; py++) {
            const mo = (y + py) * stride + x;
            for (let px = 0; px < w; px++) {
                const e = Math.abs(mask[mo + px]) * errors[py * w + px], e2 = e * e, e4 = e2 * e2;
                lossc += e4 * e4;
            }
        }
        loss += CHANNEL_MUL[c] * lossc;
        entropy += cfg.costDelta * sqrtSum;
        const nbits = ceilLog2(nonZeros + 1) + 1;
        entropy += cfg.zerosMul * (ceilLog2(nbits + 17) + nbits);
    }
    const lossScalar = (loss / (numBlocks * 64)) ** (1 / 8) * (numBlocks * 64) / quant;
    return entropy * entropyMul + cfg.infoLossMul * lossScalar;
}

// the 8x8 transforms tried (their efforts: up to which libjxl speed tier) and their entropy multipliers
const TRANSFORMS_8X8: [number, number, number][] = [
    [DCT8, 9, 0.8], [DCT4X4, 5, 1.08], [DCT2X2, 5, 0.95], [DCT4X8, 4, 0.85931637428340035], [DCT8X4, 4, 0.85931637428340035],
    [IDENTITY, 5, 1.0427542510634957], [AFV0, 4, 0.81779489591359944], [AFV1, 4, 0.81779489591359944], [AFV2, 4, 0.81779489591359944],
    [AFV3, 4, 0.81779489591359944]
];

function best8x8(x: number, y: number, speed: number, cfg: Config): [number, number] {
    let best = Infinity, bestType = DCT8;
    const d = cfg.distance;
    for (const [type, limit, mul] of TRANSFORMS_8X8) {
        if (limit < speed) continue;
        let entropyMul = mul / TRANSFORMS_8X8[0][2];
        if ((type === DCT2X2 || type === IDENTITY) && d < 5) entropyMul -= 0.4 * ((5 - d) / 5) ** 2;
        if (type !== DCT8 && type !== DCT2X2 && type !== IDENTITY && d > 4) entropyMul += 0.5 * (d < 12 ? (12 - 4) / (d - 4) : 1);
        const e = estimateEntropy(type, entropyMul, x, y, cfg);
        if (e < best) {
            best = e;
            bestType = type;
        }
    }
    return [bestType, best];
}

/** The varblock types of an image (a type at each varblock's first block, -1 at the others) */
class Strategy {
    readonly types: Int8Array;

    constructor(readonly bw: number, readonly bh: number, types?: Int8Array) {
        this.types = types ?? new Int8Array(bw * bh);
    }

    set(bx: number, by: number, type: number): void {
        const w8 = SIZES[2 * type], h8 = SIZES[2 * type + 1];
        for (let y = 0; y < h8; y++) for (let x = 0; x < w8; x++) this.types[(by + y) * this.bw + bx + x] = -1;
        this.types[by * this.bw + bx] = type;
    }

    type(bx: number, by: number): number {
        return this.types[by * this.bw + bx];
    }

    // whether a varblock crosses the line between rows y - 1 and y (from x0 to x1)
    crossesHorizontal(x0: number, y: number, x1: number): boolean {
        if (x0 >= this.bw || y >= this.bh || y % 8 === 0) return false;
        x1 = Math.min(x1, this.bw);
        const limit = x0 & ~7;
        while (x0 !== limit && this.type(x0, y) < 0) x0--;
        for (let x = x0; x < x1;) {
            const t = this.type(x, y);
            if (t < 0) return true;
            x += SIZES[2 * t];
        }
        return false;
    }

    // whether a varblock crosses the line between columns x - 1 and x (from y0 to y1)
    crossesVertical(x: number, y0: number, y1: number): boolean {
        if (x >= this.bw || y0 >= this.bh || x % 8 === 0) return false;
        y1 = Math.min(y1, this.bh);
        const limit = y0 & ~7;
        while (y0 !== limit && this.type(x, y0) < 0) y0--;
        for (let y = y0; y < y1;) {
            const t = this.type(x, y);
            if (t < 0) return true;
            y += SIZES[2 * t + 1];
        }
        return false;
    }
}

const square = (blocks: number): number => blocks === 2 ? DCT16X16 : blocks === 4 ? DCT32X32 : DCT64X64;
const verticalSplit = (blocks: number): number => blocks === 2 ? DCT16X8 : blocks === 4 ? DCT32X16 : DCT64X32;
const horizontalSplit = (blocks: number): number => blocks === 2 ? DCT8X16 : blocks === 4 ? DCT16X32 : DCT32X64;

// the best of a square of blocks x blocks, its halves (as two rectangles of each orientation) or what is there
function bestDivision(blocks: number, allowSquare: boolean, bx: number, by: number, cx: number, cy: number, cfg: Config, s: Strategy, mulJxK: number, mulJxJ: number, est: Float32Array): void {
    const half = blocks / 2, jxk = verticalSplit(blocks), kxj = horizontalSplit(blocks), jxj = square(blocks);
    const x = bx + cx, y = by + cy;
    if (s.crossesHorizontal(x, y, x + blocks) || s.crossesHorizontal(x, y + blocks, x + blocks) || s.crossesVertical(x, y, y + blocks) || s.crossesVertical(x + blocks, y, y + blocks)) return;
    const allowJxK = !s.crossesVertical(x + half, y, y + blocks), allowKxJ = !s.crossesHorizontal(x, y + half, x + blocks);
    const e = [[0, 0], [0, 0]];
    for (let dy = 0; dy < blocks; dy++) for (let dx = 0; dx < blocks; dx++) e[Math.floor(dy / half)][Math.floor(dx / half)] += est[(cy + dy) * 8 + cx + dx];
    let jxkLeft = Infinity, jxkRight = Infinity, kxjTop = Infinity, kxjBottom = Infinity, jxjCost = Infinity;
    if (allowJxK) {
        if (s.type(x, y) !== jxk) jxkLeft = estimateEntropy(jxk, mulJxK, x * 8, y * 8, cfg);
        if (s.type(x + half, y) !== jxk) jxkRight = estimateEntropy(jxk, mulJxK, (x + half) * 8, y * 8, cfg);
    }
    if (allowKxJ) {
        if (s.type(x, y) !== kxj) kxjTop = estimateEntropy(kxj, mulJxK, x * 8, y * 8, cfg);
        if (s.type(x, y + half) !== kxj) kxjBottom = estimateEntropy(kxj, mulJxK, x * 8, (y + half) * 8, cfg);
    }
    if (allowSquare) jxjCost = estimateEntropy(jxj, mulJxJ, x * 8, y * 8, cfg);
    const costJxN = Math.min(jxkLeft, e[0][0] + e[1][0]) + Math.min(jxkRight, e[0][1] + e[1][1]);
    const costNxJ = Math.min(kxjTop, e[0][0] + e[0][1]) + Math.min(kxjBottom, e[1][0] + e[1][1]);
    const setEntropy = (ex: number, ey: number, type: number, entropy: number): void => {
        for (let dy = 0; dy < SIZES[2 * type + 1]; dy++) for (let dx = 0; dx < SIZES[2 * type]; dx++) est[(ey + dy) * 8 + ex + dx] = 0;
        est[ey * 8 + ex] = entropy;
    };
    if (jxjCost < costJxN && jxjCost < costNxJ) {
        s.set(x, y, jxj);
        setEntropy(cx, cy, jxj, jxjCost);
    } else if (costJxN < costNxJ) {
        if (jxkLeft < e[0][0] + e[1][0]) {
            s.set(x, y, jxk);
            setEntropy(cx, cy, jxk, jxkLeft);
        }
        if (jxkRight < e[0][1] + e[1][1]) {
            s.set(x + half, y, jxk);
            setEntropy(cx + half, cy, jxk, jxkRight);
        }
    } else {
        if (kxjTop < e[0][0] + e[0][1]) {
            s.set(x, y, kxj);
            setEntropy(cx, cy, kxj, kxjTop);
        }
        if (kxjBottom < e[1][0] + e[1][1]) {
            s.set(x, y + half, kxj);
            setEntropy(cx, cy + half, kxj, kxjBottom);
        }
    }
}

// a larger transform where it costs less than what it covers (and doesn't overlap ones of the same or a higher priority)
function tryMerge(type: number, bx: number, by: number, cx: number, cy: number, cfg: Config, s: Strategy, mul: number, prio: number, priority: Uint8Array, est: Float32Array): void {
    const w8 = SIZES[2 * type], h8 = SIZES[2 * type + 1];
    let current = 0;
    for (let iy = 0; iy < h8; iy++) {
        for (let ix = 0; ix < w8; ix++) {
            if (priority[(cy + iy) * 8 + cx + ix] >= prio) return;
            current += est[(cy + iy) * 8 + cx + ix];
        }
    }
    const candidate = estimateEntropy(type, mul, (bx + cx) * 8, (by + cy) * 8, cfg);
    if (candidate >= current) return;
    for (let iy = 0; iy < h8; iy++) {
        for (let ix = 0; ix < w8; ix++) {
            est[(cy + iy) * 8 + cx + ix] = 0;
            priority[(cy + iy) * 8 + cx + ix] = prio;
        }
    }
    s.set(bx + cx, by + cy, type);
    est[cy * 8 + cx] = candidate;
}

// [type, priority, entropy multiplier] of the merges
const MERGES: [number, number, number][] = [
    [DCT16X8, 2, 1.25], [DCT8X16, 2, 1.25], [DCT16X32, 4, 1.5], [DCT32X16, 4, 1.5], [DCT64X32, 6, 2.26], [DCT32X64, 6, 2.26]
];

// the types of a 64x64 area (bx, by: its first block; w, h: its size in blocks)
function processRect(bx: number, by: number, w: number, h: number, speed: number, cfg: Config, s: Strategy): void {
    const est = new Float32Array(64), priority = new Uint8Array(64);
    const mul8x8 = 1 - 0.4 / (cfg.distance + 1.4);
    for (let iy = 0; iy < h; iy++) {
        for (let ix = 0; ix < w; ix++) {
            const [type, entropy] = best8x8(8 * (bx + ix), 8 * (by + iy), speed, cfg);
            s.set(bx + ix, by + iy, type);
            est[iy * 8 + ix] = entropy * mul8x8;
        }
    }
    for (const [type, prio, mul] of MERGES) {
        const w8 = SIZES[2 * type], h8 = SIZES[2 * type + 1];
        for (let cy = 0; cy + h8 - 1 < h; cy += h8) {
            for (let cx = 0; cx + w8 - 1 < w; cx += w8) {
                if (cy + 7 < h && cx + 7 < w) {
                    if (type === DCT32X64) {
                        if ((cy | cx) % 8 === 0) bestDivision(8, true, bx, by, cx, cy, cfg, s, mul, 2.26, est);
                        continue;
                    } else if (type === DCT64X32) continue;
                }
                if ((type === DCT16X32 && cy % 4 !== 0) || (type === DCT32X16 && cx % 4 !== 0)) continue;
                if (cy + 3 < h && cx + 3 < w) {
                    if (type === DCT16X32) {
                        if ((cy | cx) % 4 === 0) bestDivision(4, true, bx, by, cx, cy, cfg, s, mul, 1.5, est);
                        continue;
                    } else if (type === DCT32X16) continue;
                }
                if ((type === DCT16X32 && cy % 4 !== 0) || (type === DCT32X16 && cx % 4 !== 0)) continue;
                if (cy + 1 < h && cx + 1 < w) {
                    if (type === DCT8X16) {
                        if ((cy | cx) % 2 === 0) bestDivision(2, true, bx, by, cx, cy, cfg, s, mul, 1.35, est);
                        continue;
                    } else if (type === DCT16X8) continue;
                }
                if ((type === DCT8X16 && cy % 2 === 1) || (type === DCT16X8 && cx % 2 === 1)) continue;
                tryMerge(type, bx, by, cx, cy, cfg, s, mul, prio, priority, est);
            }
        }
    }
}

/**
 * The varblock types of an image (XYB planes of whole blocks, rows stride apart): libjxl's search at a speed tier (5:
 * its effort 5, 4: also the 4x8 and AFV transforms)
 */
export async function chooseVarblocks(planes: Float32Array[], stride: number, bw: number, bh: number, field: QuantField, distance: number, speed: number, threads: Thread[] | null): Promise<Int8Array> {
    const types = new Int8Array(threads ? new SharedArrayBuffer(bw * bh) : new ArrayBuffer(bw * bh));
    const task: VarblockTask = {
        task: 'jxl-varblocks', stride, bw, bh, distance, speed, types,
        planes: threads ? planes.map(sharedOf) : planes,
        field: threads ? { quant: shared(field.quant), mask: shared(field.mask), mask1x1: sharedOf(field.mask1x1) } : field,
    };
    // (a row of 64x64 areas each, independent of the others)
    await runChunks(threads, task, Math.ceil(bh / 8), varblockChunks(task));
    return types;
}

/** The varblock search of rows of 64x64 areas (see chooseVarblocks) */
export interface VarblockTask extends ChunkTask {
    planes: Float32Array[];
    stride: number;
    bw: number;
    bh: number;
    field: QuantField;
    distance: number;
    speed: number;
    types: Int8Array;
}

/** The search of a row of 64x64 areas (the chunk), its types set */
export function varblockChunks({ planes, stride, bw, bh, field, distance, speed, types }: VarblockTask): (chunk: number) => void {
    const ratio = (distance + 0.13731742964354549) / (1 + 0.13731742964354549);
    const cfg: Config = {
        planes, stride, bw, field, distance,
        infoLossMul: 1.2 * ratio ** 0.33677806662454718,
        zerosMul: 9.3089059022677905 * ratio ** 0.50990926717963703,
        costDelta: 10.833273317067883 * ratio ** 0.36702940662370243
    };
    const s = new Strategy(bw, bh, types);
    return row => {
        const by = row * 8;
        for (let bx = 0; bx < bw; bx += 8) processRect(bx, by, Math.min(8, bw - bx), Math.min(8, bh - by), speed, cfg, s);
    };
}
