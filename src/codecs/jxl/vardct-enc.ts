/*!
 * Lossy JPEG XL encoding (VarDCT), like libjxl (lib/jxl/enc_heuristics.cc, enc_group.cc, quantizer.cc,
 * enc_chroma_from_luma.cc, enc_xyb.cc, enc_modular.cc): XYB, the varblocks of libjxl's search (effort 1 and 2; else
 * 8x8 DCTs), a constant quantization field from the distance with libjxl's dead zones, the default matrices and block
 * contexts, chroma from luma per tile (libjxl's fast search), the edge preserving filter. Copyright (c) the JPEG XL
 * Project Authors, BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */
import { runChunks, shared, startThreads, type ChunkTask, type Thread } from '../../util/threads.ts';
import { findPatches } from './patches-enc.ts';
import { BitWriter } from './bit-writer.ts';
import { imageHeader, u32 } from './headers-enc.ts';
import { EntropyCode, Tokens, packSigned } from './entropy-enc.ts';
import { MATree, TreeNode, PRED_GRADIENT, PRED_LEFT, PRED_WEIGHTED, PROP_CHANNEL, PROP_STREAM, PROP_WP_ERROR, channelTokens, fixedTree, streamHeader } from './modular-enc.ts';
import { forwardTransform } from './transforms-enc.ts';
import { initialQuantField } from './aq-enc.ts';
import { chooseVarblocks } from './acs-enc.ts';
import { defaultDequant, MATRIX_INDEX } from './quant.ts';
import { naturalOrder, DEFAULT_CTX_MAP, ORDER_ID, SIZES, single, transposed } from './vardct.ts';

/** Options of the lossy JPEG XL encoder */
export interface VarDCTOptions {
    /** the Butteraugli distance (libjxl's -d): 1 is visually lossless, higher is smaller */
    distance: number;
    /** 0: 8x8 DCTs only (like libjxl's effort 3), 1: libjxl's varblock search (its effort 5), 2: also the 4x8 and AFV transforms */
    effort: number;
    /** at most this many worker threads (1: none) */
    threads: number;
}

// (images below this many pixels encode faster without threads, which take about 0.1 s to start, and the pixels per
// thread beyond 4: more take longer to start than they save; by effort, effort 0 without the varblock search has less
// to run in them; measured with 1-8 threads on 0.25-8 megapixels)
const MIN_THREADED_PIXELS = [1536 << 10, 512 * 512, 384 * 384], PIXELS_PER_THREAD = [1 << 20, 256 << 10, 256 << 10];

// libjxl's opsin absorbance matrix and bias (lib/jxl/cms/opsin_params.h)
const OPSIN = [
    0.30, 0.622, 0.078,
    0.23, 0.692, 0.078,
    0.2434226892454782, 0.2047674442449682, 0.5518098665095535
];
const BIAS = 0.0037930732552754493, CBRT_BIAS = Math.cbrt(BIAS);

// sRGB to linear light
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
    const v = i / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

/** Rows y0 to y1 of the XYB planes of RGBA, padded to whole blocks (by repeating the last column and row) */
function toXYB(rgba: Uint8Array, width: number, height: number, pw: number, [x, y, b]: Float32Array[], y0: number, y1: number): void {
    for (let py = y0; py < y1; py++) {
        const sy = Math.min(py, height - 1);
        for (let px = 0; px < pw; px++) {
            const s = 4 * (sy * width + Math.min(px, width - 1));
            const r = LINEAR[rgba[s]], g = LINEAR[rgba[s + 1]], bl = LINEAR[rgba[s + 2]];
            const l = Math.cbrt(Math.max(OPSIN[0] * r + OPSIN[1] * g + OPSIN[2] * bl + BIAS, 0)) - CBRT_BIAS;
            const m = Math.cbrt(Math.max(OPSIN[3] * r + OPSIN[4] * g + OPSIN[5] * bl + BIAS, 0)) - CBRT_BIAS;
            const s3 = Math.cbrt(Math.max(OPSIN[6] * r + OPSIN[7] * g + OPSIN[8] * bl + BIAS, 0)) - CBRT_BIAS;
            const i = py * pw + px;
            x[i] = 0.5 * (l - m);
            y[i] = 0.5 * (l + m);
            b[i] = s3;
        }
    }
}

// the quantization parameters of a distance (libjxl's InitialQuantDC, ComputeGlobalScaleAndQuant, SetQuantField for
// effort 3's constant field): [global scale, LF quantizer, HF multiplier]
function quantizer(distance: number): [number, number, number] {
    const dcDistance = Math.max(0.5 * distance, Math.min(distance, 0.3 * (distance / 0.3) ** 0.83));
    const quantDc = Math.fround(Math.min(1.095924047623553 / dcDistance, 50));
    const q = Math.fround(0.79 / distance);
    let globalScale = Math.trunc(Math.min(Math.max(65536 * q / 5, 1), 1 << 15));
    const scaledQuantDc = Math.trunc(quantDc * 4096 * 1.6);
    if (globalScale > scaledQuantDc) globalScale = Math.max(scaledQuantDc, 1);
    const inv = 65536 / globalScale;
    const quantLf = Math.trunc(Math.min(quantDc * inv + 0.5, 1 << 16));
    const mul = Math.trunc(Math.max(1, Math.min(q * inv + 0.5, 256)));
    return [globalScale, quantLf, mul];
}

// the default LF dequantization (X, Y, B) and quantization biases
const LF_DEQUANT = [1 / 32, 1 / 4, 1 / 2];
const QUANT_BIAS = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655], QUANT_BIAS_NUMERATOR = 0.145;
// the number of contexts of the default block context map, the coefficients of the largest varblock used
const NUM_BLOCK_CTX = 15, MAX_COEFFS = 64 * 64;
// libjxl's coefficient contexts (lib/jxl/ac_context.h)
const FREQ_CONTEXT = Uint8Array.of(
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 23, 23,
    24, 24, 24, 24, 25, 25, 25, 25, 26, 26, 26, 26, 27, 27, 27, 27, 28, 28, 28, 28, 29, 29, 29, 29, 30, 30, 30, 30
);
const NUM_NONZERO_CONTEXT = Uint8Array.of(
    0, 31, 62, 62, 93, 93, 93, 93, 123, 123, 123, 123, 152, 152, 152, 152, 152, 152, 152, 152, 180, 180, 180, 180, 180, 180, 180, 180,
    180, 180, 180, 180, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206,
    206, 206, 206, 206, 206, 206, 206, 206, 206
);

const ceilLog2 = (x: number): number => x <= 1 ? 0 : 32 - Math.clz32(x - 1);

// libjxl's cutoffs of its fixed trees for the LF
const LF_CUTOFFS = [
    -500, -392, -255, -191, -127, -95, -63, -47, -31, -23, -15, -11, -7, -4, -3, -1, 0, 1, 3, 5, 7, 11, 15, 23, 31, 47, 63, 95,
    127, 191, 255, 392, 500
];

// the global tree: the LF coefficients (streams 1 to numLfGroups) of each channel by libjxl's fixed tree (effort 3: the
// weighted predictor, split by its error), the channels of the HF metadata (CfL, varblock types and multipliers, EPF
// sharpness: mostly constant; streams up to 3 numLfGroups) predicted from the left, alpha (the global stream 0 or the
// pass groups') by the gradient
function globalTree(numLfGroups: number, numPixels: number): MATree {
    const lf = (): TreeNode => fixedTree(PROP_WP_ERROR, LF_CUTOFFS, PRED_WEIGHTED, numPixels);
    const byChannel = (n: number, leaf: () => TreeNode): TreeNode => {
        let node = leaf();
        for (let c = n - 2; c >= 0; c--) node = { property: PROP_CHANNEL, split: c, above: node, below: leaf() };
        return node;
    };
    const hf = byChannel(4, () => ({ predictor: PRED_LEFT })), alpha = (): TreeNode => ({ predictor: PRED_GRADIENT });
    const lfOrAlpha: TreeNode = { property: PROP_STREAM, split: 0, above: byChannel(3, lf), below: alpha() };
    return new MATree({ property: PROP_STREAM, split: 3 * numLfGroups + 16, above: alpha(), below: { property: PROP_STREAM, split: numLfGroups, above: hf, below: lfOrAlpha } });
}

const inverses = new Map<number, Float32Array[]>();
// the inverse dequantization matrices of a type (in its coefficients' layout)
function inverseMatrices(type: number): Float32Array[] {
    let inv = inverses.get(type);
    if (!inv) inverses.set(type, inv = defaultDequant(MATRIX_INDEX[type])[transposed(type) ? 1 : 0].map(m => Float32Array.from(m, v => 1 / v)));
    return inv;
}

/**
 * libjxl's chroma from luma of each tile of 8x8 blocks in the row of tiles at block row ty (lib/jxl/enc_chroma_from_luma.cc,
 * its fast search): the multipliers of Y for X and B (in 1/84) by least squares on the HF coefficients (of the row's
 * blocks), weighted by the quantization, a bit towards zero
 */
function chromaFromLuma(raw: Float32Array[], types: Int8Array, muls: Int32Array, pw: number, bw: number, bh: number, globalScale: number, xFromY: Int32Array, bFromY: Int32Array, ty: number): void {
    const tilesPerRow = Math.ceil(bw / 8);
    for (let tx = 0; tx < bw; tx += 8) {
        const sums = [0, 0, 0, 0];
        let num = 0;
        for (let by = ty; by < Math.min(ty + 8, bh); by++) {
            for (let bx = tx; bx < Math.min(tx + 8, bw); bx++) {
                const type = types[by * bw + bx];
                if (type < 0) continue;
                const w8 = SIZES[2 * type], h8 = SIZES[2 * type + 1], w = w8 * 8, h = h8 * 8, o = (by - ty) * 8 * pw + bx * 8, one = single(type);
                const inv = inverseMatrices(type), q = globalScale / 65536 * 128 * muls[by * bw + bx];
                num += w * h;
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        if (one ? x === 0 && y === 0 : x < w8 && y < h8) continue;
                        const k = y * w + x, yv = raw[1][o + y * pw + x];
                        for (let c = 0; c < 2; c++) {
                            const ch = c ? 2 : 0, qm = q * inv[ch][k], base = c;
                            const a = yv * qm / 84, b = base * yv * qm - raw[ch][o + y * pw + x] * qm;
                            sums[2 * c] += a * a;
                            sums[2 * c + 1] += a * b;
                        }
                    }
                }
            }
        }
        const factor = (aa: number, ab: number): number => {
            if (!num) return 0;
            let x = -ab / (aa + num * 1e-9 * 0.5);
            x = x >= 2.6 ? x - 2.6 : x <= -2.6 ? x + 2.6 : 0;
            return Math.max(-128, Math.min(127, Math.round(x)));
        };
        const t = (ty >> 3) * tilesPerRow + (tx >> 3);
        xFromY[t] = factor(sums[0], sums[1]);
        bFromY[t] = factor(sums[2], sums[3]);
    }
}

/** The XYB planes of bands of 64 rows of RGBA (see toXYB) */
export interface XYBTask extends ChunkTask {
    rgba: Uint8Array;
    width: number;
    height: number;
    pw: number;
    planes: Float32Array[];
}

/** The XYB planes of a band of 64 rows (the chunk) */
export function xybChunks({ rgba, width, height, pw, planes }: XYBTask): (chunk: number) => void {
    const ph = planes[0].length / pw;
    return band => toXYB(rgba, width, height, pw, planes, band * 64, Math.min(ph, band * 64 + 64));
}

/** The coefficients of rows of 64x64 areas, which hold whole varblocks (see encodeVarDCT) */
export interface CoefficientTask extends ChunkTask {
    planes: Float32Array[];
    pw: number;
    bw: number;
    bh: number;
    types: Int8Array;
    muls: Int32Array;
    globalScale: number;
    qmMul: number[];
    /** whether to search chroma from luma (else X 0, B 1) */
    cfl: boolean;
    // the results: the LF of the blocks (X, Y, B), the CfL tiles' multipliers, the quantized HF coefficients (in the
    // planes' layout)
    lfValues: Float32Array[];
    xFromY: Int32Array;
    bFromY: Int32Array;
    hf: Int32Array[];
}

/**
 * The coefficients of a row of 64x64 areas (the chunk): the varblocks' transforms, chroma from luma per tile, the HF
 * coefficients quantized (Y, then X and B less the dequantized Y by the tile's factors)
 */
export function coefficientChunks({ planes, pw, bw, bh, types, muls, globalScale, qmMul, cfl, lfValues, xFromY, bFromY, hf }: CoefficientTask): (chunk: number) => void {
    const tilesPerRow = Math.ceil(bw / 8);
    // (the row's coefficients, in the planes' layout)
    const raw = [0, 1, 2].map(() => new Float32Array(pw * 64));
    const coeffs = new Float32Array(MAX_COEFFS), lfBlock = new Float32Array(MAX_COEFFS / 64), yDequant = new Float32Array(MAX_COEFFS);
    return row => {
        const ty = row * 8, rows = Math.min(8, bh - ty);
        for (let by = ty; by < ty + rows; by++) {
            for (let bx = 0; bx < bw; bx++) {
                const type = types[by * bw + bx];
                if (type < 0) continue;
                const w8 = SIZES[2 * type], h8 = SIZES[2 * type + 1], w = w8 * 8, h = h8 * 8, o = (by - ty) * 8 * pw + bx * 8;
                for (let c = 0; c < 3; c++) {
                    forwardTransform(type, planes[c], by * 8 * pw + bx * 8, pw, coeffs, lfBlock);
                    for (let y = 0; y < h; y++) raw[c].set(coeffs.subarray(y * w, (y + 1) * w), o + y * pw);
                    for (let y = 0; y < h8; y++) for (let x = 0; x < w8; x++) lfValues[c][(by + y) * bw + bx + x] = lfBlock[y * w8 + x];
                }
            }
        }
        if (cfl) chromaFromLuma(raw, types, muls, pw, bw, bh, globalScale, xFromY, bFromY, ty);

        for (let by = ty; by < ty + rows; by++) {
            for (let bx = 0; bx < bw; bx++) {
                const bi = by * bw + bx, type = types[bi];
                if (type < 0) continue;
                const w8 = SIZES[2 * type], h8 = SIZES[2 * type + 1], w = w8 * 8, h = h8 * 8, o = (by - ty) * 8 * pw + bx * 8, go = by * 8 * pw + bx * 8;
                const tile = row * tilesPerRow + (bx >> 3), k0s = [xFromY[tile] / 84, 0, 1 + bFromY[tile] / 84];
                const [m0, m1] = defaultDequant(MATRIX_INDEX[type]), matrices = transposed(type) ? m1 : m0;
                const hfStep = 65536 / (globalScale * muls[bi]), one = single(type);
                for (const c of [1, 0, 2]) {
                    const src = raw[c], m = matrices[c], out = hf[c], k0 = k0s[c];
                    const thresholds = c === 1 ? [0.56, 0.62, 0.62, 0.62] : [0.58, 0.62, 0.62, 0.62];
                    if (c !== 1 && w8 * h8 >= 4) for (let i = 0; i < 4; i++) thresholds[i] = Math.max(0.5, thresholds[i] - 0.00744 * w8 * h8);
                    const scale = qmMul[c] / hfStep;
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            const k = y * w + x;
                            // (not the lowest frequencies: the LF)
                            if (one ? k === 0 : x < w8 && y < h8) continue;
                            const v = (c === 1 ? src[o + y * pw + x] : src[o + y * pw + x] - k0 * yDequant[k]) / m[k] * scale;
                            const q = Math.abs(v) >= thresholds[(y >= h / 2 ? 2 : 0) + (x >= w / 2 ? 1 : 0)] ? Math.round(v) : 0;
                            out[go + y * pw + x] = q;
                            if (c === 1) {
                                const d = q === 0 ? 0 : Math.abs(q) <= 1 ? q * QUANT_BIAS[1] : q - QUANT_BIAS_NUMERATOR / q;
                                yDequant[k] = d * m[k] * hfStep;
                            }
                        }
                    }
                }
            }
        }
    };
}

/** The tokens of the pass groups' HF coefficients (see encodeVarDCT) */
export interface HFTokenTask extends ChunkTask {
    types: Int8Array;
    hf: Int32Array[];
    pw: number;
    bw: number;
    bh: number;
    groupsPerRow: number;
}

/**
 * The tokens of a pass group's HF coefficients (the chunk): per varblock and channel the non-zero count (predicted by
 * the blocks above and left), then the coefficients in their order up to the last non-zero one
 */
export function hfTokenChunks({ types, hf, pw, bw, bh, groupsPerRow }: HFTokenTask): (chunk: number) => Pick<Tokens, 'ctx' | 'value' | 'length'> {
    return g => {
        const bx0 = (g % groupsPerRow) * 32, by0 = Math.floor(g / groupsPerRow) * 32;
        const gw = Math.min(32, bw - bx0), gh = Math.min(32, bh - by0), t = new Tokens();
        const nonZeros = [0, 1, 2].map(() => new Uint32Array(gw));
        for (let y = 0; y < gh; y++) {
            for (let x = 0; x < gw; x++) {
                const type = types[(by0 + y) * bw + bx0 + x];
                if (type < 0) continue;
                const w8 = SIZES[2 * type], numBlocks = w8 * SIZES[2 * type + 1], log = 31 - Math.clz32(numBlocks);
                const orderId = ORDER_ID[type], order = naturalOrder(orderId), n = order.length / 2, tr = transposed(type);
                const o = (by0 + y) * 8 * pw + (bx0 + x) * 8;
                const at = (i: number): number => tr ? o + order[2 * i] * pw + order[2 * i + 1] : o + order[2 * i + 1] * pw + order[2 * i];
                for (let k = 0; k < 3; k++) {
                    const c = [1, 0, 2][k], q = hf[c], nz = nonZeros[c], blockCtx = DEFAULT_CTX_MAP[k * 13 + orderId];
                    let count = 0;
                    for (let i = numBlocks; i < n; i++) if (q[at(i)]) count++;
                    const predicted = y === 0 ? (x === 0 ? 32 : nz[x - 1]) : x === 0 ? nz[x] : (nz[x] + nz[x - 1] + 1) >> 1;
                    t.push(blockCtx + (predicted >= 8 ? 4 + (predicted >> 1) : predicted) * NUM_BLOCK_CTX, count);
                    const value = (count + numBlocks - 1) >> log;
                    for (let dx = 0; dx < w8; dx++) nz[x + dx] = value;
                    let prevNonZero = count <= numBlocks * 4 ? 1 : 0;
                    const ctxBase = blockCtx * 458 + 37 * NUM_BLOCK_CTX;
                    for (let i = numBlocks; i < n && count > 0; i++) {
                        const v = q[at(i)];
                        t.push(ctxBase + (NUM_NONZERO_CONTEXT[(count - 1) >> log] + FREQ_CONTEXT[(i - numBlocks) >> log]) * 2 + prevNonZero, packSigned(v));
                        prevNonZero = v ? 1 : 0;
                        if (v) count--;
                    }
                }
            }
        }
        // (just the tokens: a thread posts them)
        return { ctx: t.ctx.slice(0, t.length), value: t.value.slice(0, t.length), length: t.length };
    };
}

/** Encodes RGBA pixels as a lossy JPEG XL codestream, alpha (if the image has transparency) losslessly */
export async function encodeVarDCT(rgba: Uint8Array, width: number, height: number, options: VarDCTOptions): Promise<Uint8Array> {
    if (width < 1 || height < 1) throw new RangeError('JPEG XL: dimensions must be at least 1');
    // threads for the XYB planes, the quantization field, the varblock search, the coefficients and their tokens, if
    // they start (the same files). Started first, they load while the work begins here
    const n = Math.min(options.threads, Math.ceil(height / 64), Math.max(4, Math.floor(width * height / PIXELS_PER_THREAD[options.effort])));
    const pool = { threads: n > 1 && width * height >= MIN_THREADED_PIXELS[options.effort] ? startThreads(n) : null };
    try {
        return await encode(rgba, width, height, options, pool);
    } finally {
        if (pool.threads) for (const t of pool.threads) t.terminate();
    }
}

async function encode(rgba: Uint8Array, width: number, height: number, { distance, effort }: VarDCTOptions, pool: { threads: Thread[] | null }): Promise<Uint8Array> {
    const bw = Math.ceil(width / 8), bh = Math.ceil(height / 8), pw = bw * 8;
    // (a stage in the threads; if they fail, like workers whose module can't be loaded, it and the rest run here)
    const parallel = async <R>(run: (threads: Thread[] | null) => Promise<R>): Promise<R> => {
        if (pool.threads) {
            try {
                return await run(pool.threads);
            } catch {
                for (const t of pool.threads) t.terminate();
                pool.threads = null;
            }
        }
        return run(null);
    };
    // (arrays the threads write to: in shared memory)
    const threaded = !!pool.threads;
    const array = <T>(Type: new (buffer: ArrayBufferLike) => T, bytes: number, length: number): T =>
        new Type(threaded ? new SharedArrayBuffer(bytes * length) : new ArrayBuffer(bytes * length));

    const planes = [0, 1, 2].map(() => array(Float32Array, 4, pw * bh * 8));
    {
        const task: XYBTask = { task: 'jxl-xyb', rgba: threaded ? shared(rgba) : rgba, width, height, pw, planes };
        await parallel(t => runChunks(t, task, bh + 7 >> 3, xybChunks(task)));
    }
    let alpha: Int32Array | null = null;
    for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] === 255) continue;
        alpha = new Int32Array(width * height);
        for (let k = 0; k < alpha.length; k++) alpha[k] = rgba[4 * k + 3];
        break;
    }

    const [globalScale, quantLf, mul] = quantizer(distance);
    // (X's multiplier: libjxl's x_qm_scale 3 up to distance 2.5, then one more per step)
    const xqmScale = 3 + [2.5, 5.5, 9.5].filter(t => distance > t).length, bqmScale = 2;
    const qmMul = [1.25 ** (xqmScale - 2), 1, 1.25 ** (bqmScale - 2)];
    const epfIters = [0.7, 1.5, 4].filter(t => distance >= t).length;
    const lfStep = LF_DEQUANT.map(m => m * 512 / (globalScale * quantLf));

    // the varblocks: a type at each one's first block (-1 elsewhere; 8x8 DCTs at effort 0, else by libjxl's search,
    // with the masking of its quantization field: of 0.62 times the distance, like libjxl's without Gaborish), their
    // HF multipliers
    // patches at effort 2: text-like features of screenshots stored once (subtracted from the planes here)
    const patches = effort >= 2 ? findPatches(planes, pw, width, height, distance, alpha ? 1 : 0) : null;
    let types: Int8Array = array(Int8Array, 1, bw * bh);
    if (effort) {
        const field = await parallel(t => initialQuantField(distance * 0.62, planes, pw, bh * 8, 0.725 / (distance * 0.62), t));
        types = await parallel(t => chooseVarblocks(planes, pw, bw, bh, field, distance, effort === 1 ? 5 : 4, t));
    }
    const muls = array(Int32Array, 4, bw * bh).fill(mul);

    // the coefficients: the LF of the blocks, chroma from luma per tile of 8x8 blocks (at effort 0 X 0, B 1), the
    // quantized HF
    const tilesPerRow = Math.ceil(bw / 8), tileRows = Math.ceil(bh / 8);
    const coefficients: CoefficientTask = {
        task: 'jxl-coefficients', planes, pw, bw, bh, types, muls, globalScale, qmMul, cfl: effort > 0,
        lfValues: [0, 1, 2].map(() => array(Float32Array, 4, bw * bh)),
        xFromY: array(Int32Array, 4, tilesPerRow * tileRows), bFromY: array(Int32Array, 4, tilesPerRow * tileRows),
        hf: [0, 1, 2].map(() => array(Int32Array, 4, pw * bh * 8)),
    };
    await parallel(t => runChunks(t, coefficients, tileRows, coefficientChunks(coefficients)));
    const { lfValues, xFromY, bFromY, hf } = coefficients;
    const lf = [0, 1, 2].map(() => new Int32Array(bw * bh));
    for (let i = 0; i < bw * bh; i++) {
        const ly = Math.round(lfValues[1][i] / lfStep[1]);
        lf[1][i] = ly;
        lf[0][i] = Math.round(lfValues[0][i] / lfStep[0]);
        lf[2][i] = Math.round((lfValues[2][i] - ly * lfStep[1]) / lfStep[2]);
    }

    // the frame's structure: groups of 256 pixels, LF groups of 2048
    const groupsPerRow = Math.ceil(width / 256), numGroups = groupsPerRow * Math.ceil(height / 256);
    const lfGroupsPerRow = Math.ceil(width / 2048), numLfGroups = lfGroupsPerRow * Math.ceil(height / 2048);
    const tree = globalTree(numLfGroups, 3 * bw * bh);

    // the LF groups' Modular data: the LF coefficients (Y, X, B), then the HF metadata
    const lfTokens: Tokens[] = [], numVarblocks: number[] = [];
    const lfGroupBlocks = (g: number): number[] => {
        const x0 = (g % lfGroupsPerRow) * 256, y0 = Math.floor(g / lfGroupsPerRow) * 256;
        return [x0, y0, Math.min(256, bw - x0), Math.min(256, bh - y0)];
    };
    const crop = (src: Int32Array, x0: number, y0: number, w: number, h: number, stride: number): Int32Array => {
        const out = new Int32Array(w * h);
        for (let y = 0; y < h; y++) out.set(src.subarray((y0 + y) * stride + x0, (y0 + y) * stride + x0 + w), y * w);
        return out;
    };
    for (let g = 0; g < numLfGroups; g++) {
        const [x0, y0, w, h] = lfGroupBlocks(g), t = new Tokens();
        [1, 0, 2].forEach((c, i) => channelTokens(t, tree, crop(lf[c], x0, y0, w, h, bw), w, h, i, 1 + g));
        lfTokens.push(t);
        // (the CfL tiles, the varblocks' types and multipliers, sharpness 4)
        const m = new Tokens(), tw = Math.ceil(w / 8), th = Math.ceil(h / 8), stream = 1 + 2 * numLfGroups + g;
        channelTokens(m, tree, crop(xFromY, x0 / 8, y0 / 8, tw, th, tilesPerRow), tw, th, 0, stream);
        channelTokens(m, tree, crop(bFromY, x0 / 8, y0 / 8, tw, th, tilesPerRow), tw, th, 1, stream);
        const blocks: number[] = [];
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (types[y * bw + x] >= 0) blocks.push(y * bw + x);
        const info = new Int32Array(2 * blocks.length);
        blocks.forEach((bi, k) => {
            info[k] = types[bi];
            info[blocks.length + k] = muls[bi] - 1;
        });
        numVarblocks.push(blocks.length);
        channelTokens(m, tree, info, blocks.length, 2, 2, stream);
        channelTokens(m, tree, new Int32Array(w * h).fill(4), w, h, 3, stream);
        lfTokens.push(m);
    }
    // alpha: in the global stream if it fits into a group, else in the pass groups' streams
    const alphaTokens: Tokens[] = [];
    if (alpha && numGroups === 1) {
        const t = new Tokens();
        channelTokens(t, tree, alpha, width, height, 0, 0);
        alphaTokens.push(t);
    } else if (alpha) {
        for (let g = 0; g < numGroups; g++) {
            const x0 = (g % groupsPerRow) * 256, y0 = Math.floor(g / groupsPerRow) * 256, w = Math.min(256, width - x0), h = Math.min(256, height - y0);
            const t = new Tokens();
            channelTokens(t, tree, crop(alpha, x0, y0, w, h, width), w, h, 0, 1 + 3 * numLfGroups + 17 + g);
            alphaTokens.push(t);
        }
    }
    const modularCode = new EntropyCode([...lfTokens, ...alphaTokens], tree.numLeaves);

    // the pass groups' HF coefficients
    const tokens: HFTokenTask = { task: 'jxl-hf-tokens', types, hf, pw, bw, bh, groupsPerRow };
    const hfTokens = (await parallel(t => runChunks(t, tokens, numGroups, hfTokenChunks(tokens)))).map(r => Object.assign(new Tokens(), r));
    const hfCode = new EntropyCode(hfTokens, 495 * NUM_BLOCK_CTX);

    // the sections: LfGlobal, the LF groups, HfGlobal, the pass groups
    const sections: BitWriter[] = [];
    {
        const w = new BitWriter();
        patches?.writeDictionary(w);
        // default LF dequantization, the quantizer, the default block contexts and chroma from luma
        w.write(1, 1);
        u32(w, globalScale, [[11, 1], [11, 2049], [12, 4097], [16, 8193]]);
        u32(w, quantLf, [[0, 16], [5, 1], [8, 1], [16, 1]]);
        w.write(1, 1);
        w.write(1, 1);
        // the global tree and its code
        w.write(1, 1);
        tree.write(w);
        modularCode.writeHeader(w);
        // the global Modular image (alpha), if there is
        if (alpha) {
            streamHeader(w);
            if (numGroups === 1) modularCode.writeTokens(w, alphaTokens[0]);
        }
        sections.push(w);
    }
    for (let g = 0; g < numLfGroups; g++) {
        const w = new BitWriter(), [, , gw, gh] = lfGroupBlocks(g);
        // no extra LF precision
        w.write(2, 0);
        streamHeader(w);
        modularCode.writeTokens(w, lfTokens[2 * g]);
        w.write(ceilLog2(gw * gh), numVarblocks[g] - 1);
        streamHeader(w);
        modularCode.writeTokens(w, lfTokens[2 * g + 1]);
        sections.push(w);
    }
    {
        const w = new BitWriter();
        // default matrices, one HF preset, natural orders, the coefficients' code
        w.write(1, 1);
        w.write(ceilLog2(numGroups), 0);
        w.write(2, 2);
        hfCode.writeHeader(w);
        sections.push(w);
    }
    for (let g = 0; g < numGroups; g++) {
        const w = new BitWriter();
        hfCode.writeTokens(w, hfTokens[g]);
        if (alpha && numGroups > 1) {
            streamHeader(w);
            modularCode.writeTokens(w, alphaTokens[g]);
        }
        sections.push(w);
    }

    // the image header, the frame header, the TOC, the sections
    const out = new BitWriter();
    imageHeader(out, width, height, alpha ? 4 : 3, true);
    if (patches) out.append(patches.frame);
    frameHeader(out, xqmScale, bqmScale, epfIters, alpha !== null, !!patches);
    if (numGroups === 1) {
        // (a single section: all of them one after the other)
        const all = new BitWriter();
        for (const s of sections) all.append(s);
        sections.length = 0;
        sections.push(all);
    }
    for (const s of sections) s.zeroPadToByte();
    out.write(1, 0);
    out.zeroPadToByte();
    for (const s of sections) u32(out, s.length, [[10, 0], [14, 1024], [22, 17408], [30, 4211712]]);
    out.zeroPadToByte();
    const total = out.length + sections.reduce((n, s) => n + s.length, 0), bytes = new Uint8Array(total);
    bytes.set(out.bytes());
    let at = out.length;
    for (const s of sections) {
        bytes.set(s.bytes(), at);
        at += s.length;
    }
    return bytes;
}

// a regular VarDCT frame: no flags, one pass, replacing (alpha too), the last one; no Gaborish, EPF iterations
function frameHeader(w: BitWriter, xqmScale: number, bqmScale: number, epfIters: number, alpha: boolean, patches: boolean): void {
    w.write(1, 0);
    w.write(2, 0);
    w.write(1, 0);
    // (the flags: patches is 2)
    if (patches) {
        w.write(2, 1);
        w.write(4, 1);
    } else w.write(2, 0);
    w.write(2, 0);
    if (alpha) w.write(2, 0);
    w.write(3, xqmScale);
    w.write(3, bqmScale);
    w.write(2, 0);
    w.write(1, 0);
    w.write(2, 0);
    if (alpha) w.write(2, 0);
    w.write(1, 1);
    w.write(2, 0);
    // the loop filter: not the default, no Gaborish, the EPF iterations (default parameters), no extensions
    w.write(1, 0);
    w.write(1, 0);
    w.write(2, epfIters);
    if (epfIters) {
        w.write(1, 0);
        w.write(1, 0);
        w.write(1, 0);
    }
    w.write(2, 0);
    w.write(2, 0);
}
