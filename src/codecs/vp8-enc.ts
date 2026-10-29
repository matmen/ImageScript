/*!
 * Lossy WebP (VP8) encoding, ported from libwebp's encoder (src/enc: analysis_enc.c, quant_enc.c, frame_enc.c,
 * iterator_enc.c, cost_enc.c, token_enc.c, tree_enc.c, syntax_enc.c, filter_enc.c, alpha_enc.c; src/utils:
 * bit_writer_utils.c, filters_utils.c, quant_levels_utils.c) with its default settings and any method (effort: 0-2 decide modes by
 * distortion, 3-6 by rate and distortion, 5-6 with trellis quantization), so the output is the same as cwebp's.
 * Copyright (c) 2010 Google Inc., BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */

import {
    BPS, Y_OFF, U_OFF, V_OFF, YUV_SIZE, PRED_SIZE, I16_MODE_OFFSETS, UV_MODE_OFFSETS, I4_MODE_OFFSETS, I4TMP, SCAN, SCAN_UV,
    YUVPicture, Matrix, newMatrix, predLuma16, predChroma8, predLuma4, fTransform, iTransform, fTransformWHT,
    iTransformWHT, sse4x4, sse16, predictionSSEs, tTransform, tDisto4x4, tDisto16x16, isFlat, isFlatSource16, quantizeBlock, histogramAlpha, mean16x4,
    ZIGZAG, MAX_LEVEL
} from './vp8-enc-dsp.ts';
import {
    ENTROPY_COST, LEVEL_FIXED_COSTS, LEVEL_CODES, FIXED_COSTS_I4, BMODES_PROBA, AC_TABLE2, LEVELS_FROM_DELTA
} from './vp8-enc-tables.ts';
import { DEFAULT_COEFF_PROBS, COEFF_UPDATE_PROBS, DC_QLOOKUP, AC_QLOOKUP } from './vp8-tables.ts';
import { base64 } from '../util/bytes.ts';
import * as vp8l from './vp8l.ts';

const NUM_MB_SEGMENTS = 4, NUM_PROBAS = 11, NUM_CTX = 3, NUM_BANDS = 8, NUM_TYPES = 4;
const MAX_VARIABLE_LEVEL = 67;
// (score_t: 64 bit in libwebp, these values stay below 2^53)
const MAX_COST = 2 ** 55;
const RD_DISTO_MULT = 256;
// rate-distortion optimization levels
const RD_OPT_NONE = 0, RD_OPT_BASIC = 1, RD_OPT_TRELLIS = 2, RD_OPT_TRELLIS_ALL = 3;
const WEIGHT_TRELLIS = [30, 27, 19, 11, 27, 24, 17, 10, 19, 17, 12, 8, 11, 10, 8, 6];
const BANDS = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0];
const FIXED_COSTS_UV = [302, 984, 439, 642], FIXED_COSTS_I16 = [663, 919, 872, 919];
const WEIGHT_Y = Int32Array.of(38, 32, 20, 9, 32, 28, 17, 7, 20, 17, 10, 4, 9, 7, 4, 2);
const BIAS_MATRICES = [[96, 110], [96, 108], [110, 115]];
const FREQ_SHARPENING = [0, 30, 60, 90, 30, 60, 90, 90, 60, 90, 90, 90, 90, 90, 90, 90];
const CAT3 = [173, 148, 140], CAT4 = [176, 155, 140, 135], CAT5 = [180, 157, 141, 134, 130];
const CAT6 = [254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129];
// the encoder's configuration (libwebp's defaults)
const SNS_STRENGTH = 50, FILTER_STRENGTH = 60, FILTER_SHARPNESS = 0, SEGMENTS = 4;
const MID_ALPHA = 64, MIN_ALPHA = 30, MAX_ALPHA = 100;
const MAX_DQ_UV = 6, MIN_DQ_UV = -4;
const FLATNESS_LIMIT_I16 = 0, FLATNESS_LIMIT_I4 = 3, FLATNESS_LIMIT_UV = 2, FLATNESS_PENALTY = 140;
const ERROR_DIFFUSION_QUALITY = 98;

const words = (text: string): Uint16Array => {
    const b = base64(text), w = new Uint16Array(b.length >> 1);
    for (let i = 0; i < w.length; i++) w[i] = b[i * 2] | b[i * 2 + 1] << 8;
    return w;
};
let levelFixedCosts: Uint16Array | null = null, fixedCostsI4: Uint16Array | null = null;

const bitCost = (bit: number | boolean, p: number): number => bit ? ENTROPY_COST[255 - p] : ENTROPY_COST[p];
const clip = (v: number, m: number, M: number): number => v < m ? m : v > M ? M : v;

// ---- bit writer (bit_writer_utils.c)

class BitWriter {
    range = 254;
    value = 0;
    run = 0;
    nbBits = -8;
    pos = 0;
    buf = new Uint8Array(1024);

    private flush(): void {
        const s = 8 + this.nbBits;
        const bits = this.value >> s;
        this.value -= bits << s;
        this.nbBits -= 8;
        if ((bits & 0xff) !== 0xff) {
            let pos = this.pos;
            if (pos + this.run + 1 > this.buf.length) {
                const bigger = new Uint8Array(Math.max(2 * this.buf.length, pos + this.run + 1));
                bigger.set(this.buf);
                this.buf = bigger;
            }
            // a carry propagates over the pending 0xff bytes
            if (bits & 0x100 && pos > 0) this.buf[pos - 1]++;
            for (; this.run > 0; this.run--) this.buf[pos++] = bits & 0x100 ? 0 : 0xff;
            this.buf[pos++] = bits & 0xff;
            this.pos = pos;
        } else this.run++;
    }

    putBit(bit: number | boolean, prob: number): boolean {
        const split = (this.range * prob) >> 8;
        if (bit) {
            this.value += split + 1;
            this.range -= split + 1;
        } else this.range = split;
        if (this.range < 127) {
            const shift = 7 - (31 - Math.clz32(this.range + 1));
            this.range = ((this.range + 1) << shift) - 1;
            this.value <<= shift;
            this.nbBits += shift;
            if (this.nbBits > 0) this.flush();
        }
        return !!bit;
    }

    putBitUniform(bit: number | boolean): boolean {
        return this.putBit(bit, 128);
    }

    putBits(value: number, n: number): void {
        for (let mask = 1 << (n - 1); mask; mask >>>= 1) this.putBitUniform(value & mask);
    }

    putSignedBits(value: number, n: number): void {
        if (!this.putBitUniform(value !== 0)) return;
        this.putBits(value < 0 ? (-value << 1) | 1 : value << 1, n + 1);
    }

    finish(): Uint8Array {
        this.putBits(0, 9 - this.nbBits);
        this.nbBits = 0;
        this.flush();
        return this.buf.subarray(0, this.pos);
    }
}

// ---- probabilities and costs (cost_enc.c, tree_enc.c)

const probaIndex = (t: number, b: number, c: number): number => ((t * NUM_BANDS + b) * NUM_CTX + c) * NUM_PROBAS;

class Probas {
    segments = new Uint8Array([255, 255, 255]);
    skipProba = 255;
    useSkipProba = false;
    nbSkip = 0;
    coeffs = Uint8Array.from(DEFAULT_COEFF_PROBS);
    stats = new Uint32Array(NUM_TYPES * NUM_BANDS * NUM_CTX * NUM_PROBAS);
    /** [type][band][ctx][level 0-67] */
    levelCost = new Uint16Array(NUM_TYPES * NUM_BANDS * NUM_CTX * (MAX_VARIABLE_LEVEL + 1));
    /** [type][position 0-15][ctx]: where the level costs of a position are */
    remapped = new Int32Array(NUM_TYPES * 16 * NUM_CTX);
    dirty = true;

    calculateLevelCosts(): void {
        if (!this.dirty) return;
        for (let t = 0; t < NUM_TYPES; t++) {
            for (let b = 0; b < NUM_BANDS; b++) {
                for (let c = 0; c < NUM_CTX; c++) {
                    const p = probaIndex(t, b, c), table = ((t * NUM_BANDS + b) * NUM_CTX + c) * (MAX_VARIABLE_LEVEL + 1);
                    const cost0 = c > 0 ? bitCost(1, this.coeffs[p]) : 0;
                    const costBase = bitCost(1, this.coeffs[p + 1]) + cost0;
                    this.levelCost[table] = bitCost(0, this.coeffs[p + 1]) + cost0;
                    for (let v = 1; v <= MAX_VARIABLE_LEVEL; v++) {
                        let pattern = LEVEL_CODES[(v - 1) * 2], bits = LEVEL_CODES[(v - 1) * 2 + 1], cost = 0;
                        for (let i = 2; pattern; i++, bits >>= 1, pattern >>= 1) if (pattern & 1) cost += bitCost(bits & 1, this.coeffs[p + i]);
                        this.levelCost[table + v] = costBase + cost;
                    }
                }
            }
            for (let n = 0; n < 16; n++) {
                for (let c = 0; c < NUM_CTX; c++) this.remapped[(t * 16 + n) * NUM_CTX + c] = ((t * NUM_BANDS + BANDS[n]) * NUM_CTX + c) * (MAX_VARIABLE_LEVEL + 1);
            }
        }
        this.dirty = false;
    }

    /** sets the probabilities from the statistics where that saves bits; the bits the updates take */
    finalizeTokenProbas(): number {
        let changed = false, size = 0;
        for (let i = 0; i < this.coeffs.length; i++) {
            const stats = this.stats[i];
            const nb = stats & 0xffff, total = stats >>> 16;
            const update = COEFF_UPDATE_PROBS[i], oldP = DEFAULT_COEFF_PROBS[i];
            const newP = nb ? 255 - Math.trunc(nb * 255 / total) : 255;
            const oldCost = branchCost(nb, total, oldP) + bitCost(0, update);
            const newCost = branchCost(nb, total, newP) + bitCost(1, update) + 8 * 256;
            const useNew = oldCost > newCost;
            size += bitCost(useNew, update);
            if (useNew) {
                this.coeffs[i] = newP;
                changed ||= newP !== oldP;
                size += 8 * 256;
            } else this.coeffs[i] = oldP;
        }
        this.dirty = changed;
        return size;
    }
}

const branchCost = (nb: number, total: number, p: number): number => nb * bitCost(1, p) + (total - nb) * bitCost(0, p);

// records a bit in the statistics (counts of ones and of all, halved before they overflow)
function recordStats(bit: number | boolean, stats: Uint32Array, i: number): boolean {
    let p = stats[i];
    if (p >= 0xfffe0000) p = ((p + 1) >>> 1) & 0x7fff7fff;
    stats[i] = p + 0x10000 + (bit ? 1 : 0);
    return !!bit;
}

/** The coefficients of a 4x4 block to code: from first (1 after a luma DC block) to last (-1: none) */
interface Residual {
    first: number;
    last: number;
    coeffs: Int16Array;
    offset: number;
    type: number;
}

function setResidualCoeffs(res: Residual, coeffs: Int16Array, offset: number, nonZero = 1): void {
    res.last = -1;
    // (nonZero: 0 when the quantization found them all zero)
    for (let n = nonZero ? 15 : -1; n >= 0; n--) {
        if (coeffs[offset + n]) {
            res.last = n;
            break;
        }
    }
    res.coeffs = coeffs;
    res.offset = offset;
}

const levelCost = (costs: Uint16Array, table: number, level: number): number =>
    (levelFixedCosts as Uint16Array)[level] + costs[table + (level > MAX_VARIABLE_LEVEL ? MAX_VARIABLE_LEVEL : level)];

function residualCost(probas: Probas, ctx0: number, res: Residual): number {
    let n = res.first;
    const p0 = probas.coeffs[probaIndex(res.type, n, ctx0)];
    const costs = probas.levelCost, remap = probas.remapped, base = res.type * 16;
    let t = remap[(base + n) * NUM_CTX + ctx0];
    let cost = ctx0 === 0 ? bitCost(1, p0) : 0;
    if (res.last < 0) return bitCost(0, p0);
    for (; n < res.last; n++) {
        const v = Math.abs(res.coeffs[res.offset + n]);
        cost += levelCost(costs, t, v);
        t = remap[(base + n + 1) * NUM_CTX + (v >= 2 ? 2 : v)];
    }
    const v = Math.abs(res.coeffs[res.offset + n]);
    cost += levelCost(costs, t, v);
    if (n < 15) cost += bitCost(0, probas.coeffs[probaIndex(res.type, BANDS[n + 1], v === 1 ? 1 : 2)]);
    return cost;
}

// ---- token buffer (token_enc.c): the bits of the coefficients and their probabilities, coded once the
// probabilities are final

const FIXED_PROBA_BIT = 1 << 14;

class Tokens {
    data = new Uint16Array(1 << 16);
    length = 0;

    add(bit: number | boolean, probaIndex: number, stats: Uint32Array, statsIndex: number): boolean {
        this.push((bit ? 1 << 15 : 0) | probaIndex);
        return recordStats(bit, stats, statsIndex);
    }

    addConstant(bit: number | boolean, proba: number): void {
        this.push((bit ? 1 << 15 : 0) | FIXED_PROBA_BIT | proba);
    }

    private push(token: number): void {
        if (this.length === this.data.length) {
            const bigger = new Uint16Array(this.data.length * 2);
            bigger.set(this.data);
            this.data = bigger;
        }
        this.data[this.length++] = token;
    }

    /**
     * records the coefficients' tokens, and their statistics (cat56: where the choice of category 5 or 6 is counted,
     * the token's own probability by libwebp's VP8RecordCoeffs, that of the category 3/4 choice by its token
     * recording)
     */
    record(ctx: number, res: Residual, stats: Uint32Array, cat56 = 9): boolean {
        const { coeffs, offset, type, last } = res;
        let n = res.first;
        let base = probaIndex(type, n, ctx);
        if (!this.add(last >= 0, base, stats, base)) return false;
        while (n < 16) {
            const c = coeffs[offset + n++];
            const sign = c < 0, v = sign ? -c : c;
            if (!this.add(v !== 0, base + 1, stats, base + 1)) {
                base = probaIndex(type, BANDS[n], 0);
                continue;
            }
            if (!this.add(v > 1, base + 2, stats, base + 2)) base = probaIndex(type, BANDS[n], 1);
            else {
                if (!this.add(v > 4, base + 3, stats, base + 3)) {
                    if (this.add(v !== 2, base + 4, stats, base + 4)) this.add(v === 4, base + 5, stats, base + 5);
                } else if (!this.add(v > 10, base + 6, stats, base + 6)) {
                    if (!this.add(v > 6, base + 7, stats, base + 7)) this.addConstant(v === 6, 159);
                    else {
                        this.addConstant(v >= 9, 165);
                        this.addConstant(!(v & 1), 145);
                    }
                } else {
                    let mask: number, tab: number[], residue = v - 3;
                    // (libwebp records the cat5/6 choice in the statistics of the cat3/4 one)
                    if (residue < 8 << 1) {
                        this.add(0, base + 8, stats, base + 8);
                        this.add(0, base + 9, stats, base + 9);
                        residue -= 8;
                        mask = 1 << 2;
                        tab = CAT3;
                    } else if (residue < 8 << 2) {
                        this.add(0, base + 8, stats, base + 8);
                        this.add(1, base + 9, stats, base + 9);
                        residue -= 8 << 1;
                        mask = 1 << 3;
                        tab = CAT4;
                    } else if (residue < 8 << 3) {
                        this.add(1, base + 8, stats, base + 8);
                        this.add(0, base + 10, stats, base + cat56);
                        residue -= 8 << 2;
                        mask = 1 << 4;
                        tab = CAT5;
                    } else {
                        this.add(1, base + 8, stats, base + 8);
                        this.add(1, base + 10, stats, base + cat56);
                        residue -= 8 << 3;
                        mask = 1 << 10;
                        tab = CAT6;
                    }
                    for (let k = 0; mask; mask >>= 1, k++) this.addConstant(residue & mask, tab[k]);
                }
                base = probaIndex(type, BANDS[n], 2);
            }
            this.addConstant(sign, 128);
            if (n === 16 || !this.add(n <= last, base, stats, base)) return true;
        }
        return true;
    }

    /** codes the tokens (from start to end) with the probabilities */
    emit(bw: BitWriter, probas: Uint8Array, start = 0, end = this.length): void {
        for (let i = start; i < end; i++) {
            const token = this.data[i];
            bw.putBit(token >> 15 & 1, token & FIXED_PROBA_BIT ? token & 0xff : probas[token & 0x3fff]);
        }
    }
}

// ---- segments

interface SegmentInfo {
    y1: Matrix;
    y2: Matrix;
    uv: Matrix;
    /** quantization susceptibility (-127-127), filter susceptibility (0-255) */
    alpha: number;
    beta: number;
    quant: number;
    fstrength: number;
    maxEdge: number;
    minDisto: number;
    lambdaI16: number;
    lambdaI4: number;
    lambdaUv: number;
    lambdaMode: number;
    tlambda: number;
    lambdaTrellisI16: number;
    lambdaTrellisI4: number;
    i4Penalty: number;
}

const newSegment = (): SegmentInfo => ({
    y1: newMatrix(), y2: newMatrix(), uv: newMatrix(), alpha: 0, beta: 0, quant: 0, fstrength: 0, maxEdge: 0, minDisto: 0,
    lambdaI16: 0, lambdaI4: 0, lambdaUv: 0, lambdaMode: 0, tlambda: 0, lambdaTrellisI16: 0, lambdaTrellisI4: 0, i4Penalty: 0
});

function copySegment(dst: SegmentInfo, src: SegmentInfo): void {
    for (const key of ['y1', 'y2', 'uv'] as const) {
        for (const field of ['q', 'iq', 'bias', 'zthresh', 'sharpen'] as const) dst[key][field].set(src[key][field]);
    }
    dst.alpha = src.alpha;
    dst.beta = src.beta;
    dst.quant = src.quant;
    dst.fstrength = src.fstrength;
    dst.maxEdge = src.maxEdge;
    dst.minDisto = src.minDisto;
    dst.lambdaI16 = src.lambdaI16;
    dst.lambdaI4 = src.lambdaI4;
    dst.lambdaUv = src.lambdaUv;
    dst.lambdaMode = src.lambdaMode;
    dst.tlambda = src.tlambda;
    dst.lambdaTrellisI16 = src.lambdaTrellisI16;
    dst.lambdaTrellisI4 = src.lambdaTrellisI4;
    dst.i4Penalty = src.i4Penalty;
}

/** The score of a mode decision: distortion, spectral distortion, header bits, rate; the levels */
class ModeScore {
    D = 0;
    SD = 0;
    H = 0;
    R = 0;
    score = MAX_COST;
    yDcLevels = new Int16Array(16);
    yAcLevels = new Int16Array(16 * 16);
    uvLevels = new Int16Array(8 * 16);
    modeI16 = 0;
    modesI4 = new Uint8Array(16);
    modeUv = 0;
    nz = 0;
    /** the DC errors diffused to the next blocks (U, V: blocks 1, 2, 3) */
    derr = new Int8Array(6);

    init(): void {
        this.D = this.SD = this.H = this.R = this.nz = 0;
        this.score = MAX_COST;
    }

    copyScore(src: ModeScore): void {
        this.D = src.D;
        this.SD = src.SD;
        this.H = src.H;
        this.R = src.R;
        this.nz = src.nz;
        this.score = src.score;
    }

    addScore(src: ModeScore): void {
        this.D += src.D;
        this.SD += src.SD;
        this.H += src.H;
        this.R += src.R;
        this.nz |= src.nz;
        this.score += src.score;
    }

    copyAll(src: ModeScore): void {
        this.copyScore(src);
        this.yDcLevels.set(src.yDcLevels);
        this.yAcLevels.set(src.yAcLevels);
        this.uvLevels.set(src.uvLevels);
        this.modeI16 = src.modeI16;
        this.modesI4.set(src.modesI4);
        this.modeUv = src.modeUv;
        this.derr.set(src.derr);
    }

    setRDScore(lambda: number): void {
        this.score = (this.R + this.H) * lambda + RD_DISTO_MULT * (this.D + this.SD);
    }
}

// ---- the encoder

class Encoder {
    readonly mbW: number;
    readonly mbH: number;
    readonly predsW: number;
    // macroblock infos
    readonly mbType: Uint8Array;
    readonly mbUvMode: Uint8Array;
    readonly mbSkip: Uint8Array;
    readonly mbSegment: Uint8Array;
    readonly mbAlpha: Uint8Array;
    /** the intra 4x4 modes ((4 mb_w + 1) x (4 mb_h + 1), from -1, -1) */
    readonly preds: Uint8Array;
    /** the non-zero bits of the macroblocks above (from -1) */
    readonly nz: Uint32Array;
    readonly yTop: Uint8Array;
    readonly uvTop: Uint8Array;
    /** the diffused DC errors of the blocks above: [mb][u/v][2] */
    readonly topDerr: Int8Array | null;
    readonly dqm = Array.from({ length: NUM_MB_SEGMENTS }, newSegment);
    readonly proba = new Probas();
    readonly tokens = new Tokens();
    readonly parts = new BitWriter();
    numSegments = SEGMENTS;
    updateMap = true;
    segmentSize = 0;
    filterSimple = true;
    filterLevel = 0;
    filterSharpness = 0;
    baseQuant = 0;
    alpha = 0;
    uvAlpha = 0;
    dqUvDc = 0;
    dqUvAc = 0;
    maxI4HeaderBits: number;
    readonly mbHeaderLimit: number;
    readonly rdOpt: number;

    constructor(readonly pic: YUVPicture, readonly quality: number, readonly method: number) {
        this.mbW = (pic.width + 15) >> 4;
        this.mbH = (pic.height + 15) >> 4;
        this.predsW = 4 * this.mbW + 1;
        const count = this.mbW * this.mbH;
        this.mbType = new Uint8Array(count).fill(1);
        this.mbUvMode = new Uint8Array(count);
        this.mbSkip = new Uint8Array(count);
        this.mbSegment = new Uint8Array(count);
        this.mbAlpha = new Uint8Array(count);
        this.preds = new Uint8Array(this.predsW * (4 * this.mbH + 1));
        this.nz = new Uint32Array(this.mbW + 1);
        this.yTop = new Uint8Array(this.mbW * 16);
        this.uvTop = new Uint8Array(this.mbW * 16);
        this.topDerr = quality <= ERROR_DIFFUSION_QUALITY ? new Int8Array(this.mbW * 4) : null;
        this.maxI4HeaderBits = 256 * 16 * 16;
        this.mbHeaderLimit = Math.trunc(256 * 510 * 8 * 1024 / count);
        this.rdOpt = method >= 6 ? RD_OPT_TRELLIS_ALL : method >= 5 ? RD_OPT_TRELLIS : method >= 3 ? RD_OPT_BASIC : RD_OPT_NONE;
    }
}

// ---- the macroblock iterator (iterator_enc.c)

class Iterator {
    x = 0;
    y = 0;
    yuvIn = new Uint8Array(YUV_SIZE);
    /** 32-bit views for copying whole blocks (null: the planes' rows aren't aligned) */
    private inWords = new Uint32Array(this.yuvIn.buffer);
    private yWords: Uint32Array | null = null;
    private uWords: Uint32Array | null = null;
    private vWords: Uint32Array | null = null;
    yuvOut = new Uint8Array(YUV_SIZE);
    yuvOut2 = new Uint8Array(YUV_SIZE);
    yuvP = new Uint8Array(PRED_SIZE);
    /** the index of the macroblock, of its intra 4x4 modes in preds, of its non-zero bits in nz */
    mb = 0;
    preds = 0;
    nzIndex = 1;
    /** the left samples, from the top left one */
    yLeft = new Uint8Array(17);
    uLeft = new Uint8Array(9);
    vLeft = new Uint8Array(9);
    /** the top samples (the encoder's, or the source's while analyzing) */
    yTop: Uint8Array;
    yTopOffset = 0;
    uvTop: Uint8Array;
    uvTopOffset = 0;
    readonly tmp32 = new Uint8Array(32);
    i4 = 0;
    i4Boundary = new Uint8Array(37);
    i4Top = 0;
    topNz = new Int32Array(9);
    leftNz = new Int32Array(9);
    leftDerr = new Int8Array(4);
    countDown = 0;
    doTrellis = false;

    constructor(readonly enc: Encoder) {
        const pic = enc.pic, words = (plane: Uint8Array): Uint32Array => new Uint32Array(plane.buffer, plane.byteOffset, plane.length >> 2);
        if (pic.width % 4 === 0 && pic.y.byteOffset % 4 === 0) this.yWords = words(pic.y);
        if (pic.uvStride % 4 === 0 && pic.u.byteOffset % 4 === 0 && pic.v.byteOffset % 4 === 0) {
            this.uWords = words(pic.u);
            this.vWords = words(pic.v);
        }
        this.yTop = enc.yTop;
        this.uvTop = enc.uvTop;
        this.setRow(0);
        this.countDown = enc.mbW * enc.mbH;
        enc.yTop.fill(127);
        enc.uvTop.fill(127);
        enc.nz.fill(0);
        enc.topDerr?.fill(0);
    }

    initLeft(): void {
        this.yLeft[0] = this.uLeft[0] = this.vLeft[0] = this.y > 0 ? 129 : 127;
        this.yLeft.fill(129, 1);
        this.uLeft.fill(129, 1);
        this.vLeft.fill(129, 1);
        this.leftNz[8] = 0;
        this.leftDerr.fill(0);
    }

    setRow(y: number): void {
        const enc = this.enc;
        this.x = 0;
        this.y = y;
        this.preds = enc.predsW + 1 + y * 4 * enc.predsW;
        this.nzIndex = 1;
        this.mb = y * enc.mbW;
        this.yTop = enc.yTop;
        this.yTopOffset = 0;
        this.uvTop = enc.uvTop;
        this.uvTopOffset = 0;
        this.initLeft();
    }

    next(): boolean {
        if (++this.x === this.enc.mbW) this.setRow(++this.y);
        else {
            this.preds += 4;
            this.mb++;
            this.nzIndex++;
            this.yTopOffset += 16;
            this.uvTopOffset += 16;
        }
        return --this.countDown > 0;
    }

    /** imports the source samples (and, while analyzing, the source's boundary samples) */
    import(boundary: boolean): void {
        const { x, y } = this;
        const pic = this.enc.pic, stride = pic.width, uvStride = pic.uvStride;
        const ys = y * 16 * stride + x * 16, us = y * 8 * uvStride + x * 8;
        const w = Math.min(pic.width - x * 16, 16), h = Math.min(pic.height - y * 16, 16);
        const uvW = (w + 1) >> 1, uvH = (h + 1) >> 1;
        if (this.yWords && w === 16 && h === 16) copyWords(this.yWords, ys >> 2, stride >> 2, this.inWords, Y_OFF >> 2, 16, 4);
        else importBlock(pic.y, ys, stride, this.yuvIn, Y_OFF, w, h, 16);
        if (this.uWords && this.vWords && uvW === 8 && uvH === 8) {
            copyWords(this.uWords, us >> 2, uvStride >> 2, this.inWords, U_OFF >> 2, 8, 2);
            copyWords(this.vWords, us >> 2, uvStride >> 2, this.inWords, V_OFF >> 2, 8, 2);
        } else {
            importBlock(pic.u, us, uvStride, this.yuvIn, U_OFF, uvW, uvH, 8);
            importBlock(pic.v, us, uvStride, this.yuvIn, V_OFF, uvW, uvH, 8);
        }
        if (!boundary) return;

        if (x === 0) this.initLeft();
        else {
            if (y === 0) this.yLeft[0] = this.uLeft[0] = this.vLeft[0] = 127;
            else {
                this.yLeft[0] = pic.y[ys - 1 - stride];
                this.uLeft[0] = pic.u[us - 1 - uvStride];
                this.vLeft[0] = pic.v[us - 1 - uvStride];
            }
            importLine(pic.y, ys - 1, stride, this.yLeft, 1, h, 16);
            importLine(pic.u, us - 1, uvStride, this.uLeft, 1, uvH, 8);
            importLine(pic.v, us - 1, uvStride, this.vLeft, 1, uvH, 8);
        }
        const tmp = this.tmp32;
        this.yTop = this.uvTop = tmp;
        this.yTopOffset = 0;
        this.uvTopOffset = 16;
        if (y === 0) tmp.fill(127);
        else {
            importLine(pic.y, ys - stride, 1, tmp, 0, w, 16);
            importLine(pic.u, us - uvStride, 1, tmp, 16, uvW, 8);
            importLine(pic.v, us - uvStride, 1, tmp, 24, uvW, 8);
        }
    }

    nzToBytes(): void {
        const tnz = this.enc.nz[this.nzIndex], lnz = this.enc.nz[this.nzIndex - 1];
        const bit = (nz: number, n: number): number => nz >>> n & 1;
        const t = this.topNz, l = this.leftNz;
        t[0] = bit(tnz, 12); t[1] = bit(tnz, 13); t[2] = bit(tnz, 14); t[3] = bit(tnz, 15);
        t[4] = bit(tnz, 18); t[5] = bit(tnz, 19); t[6] = bit(tnz, 22); t[7] = bit(tnz, 23);
        t[8] = bit(tnz, 24);
        l[0] = bit(lnz, 3); l[1] = bit(lnz, 7); l[2] = bit(lnz, 11); l[3] = bit(lnz, 15);
        l[4] = bit(lnz, 17); l[5] = bit(lnz, 19); l[6] = bit(lnz, 21); l[7] = bit(lnz, 23);
    }

    bytesToNz(): void {
        const t = this.topNz, l = this.leftNz;
        this.enc.nz[this.nzIndex] = (t[0] << 12 | t[1] << 13 | t[2] << 14 | t[3] << 15 | t[4] << 18 | t[5] << 19 | t[6] << 22 | t[7] << 23 |
            t[8] << 24 | l[0] << 3 | l[1] << 7 | l[2] << 11 | l[4] << 17 | l[6] << 21) >>> 0;
    }

    saveBoundary(): void {
        const enc = this.enc, out = this.yuvOut;
        if (this.x < enc.mbW - 1) {
            for (let i = 0; i < 16; i++) this.yLeft[1 + i] = out[Y_OFF + 15 + i * BPS];
            for (let i = 0; i < 8; i++) {
                this.uLeft[1 + i] = out[U_OFF + 7 + i * BPS];
                this.vLeft[1 + i] = out[U_OFF + 15 + i * BPS];
            }
            this.yLeft[0] = this.yTop[this.yTopOffset + 15];
            this.uLeft[0] = this.uvTop[this.uvTopOffset + 7];
            this.vLeft[0] = this.uvTop[this.uvTopOffset + 15];
        }
        if (this.y < enc.mbH - 1) {
            for (let i = 0; i < 16; i++) {
                this.yTop[this.yTopOffset + i] = out[Y_OFF + 15 * BPS + i];
                this.uvTop[this.uvTopOffset + i] = out[U_OFF + 7 * BPS + i];
            }
        }
    }

    startI4(): void {
        this.i4 = 0;
        this.i4Top = TOP_LEFT_I4[0];
        const b = this.i4Boundary;
        for (let i = 0; i < 17; i++) b[i] = this.yLeft[16 - i];
        for (let i = 0; i < 16; i++) b[17 + i] = this.yTop[this.yTopOffset + i];
        // the top right samples: the last top one at the right edge
        for (let i = 16; i < 20; i++) b[17 + i] = this.x < this.enc.mbW - 1 ? this.yTop[this.yTopOffset + i] : b[17 + 15];
        this.nzToBytes();
    }

    /** updates the boundary with the reconstructed 4x4 block; false after the last one */
    rotateI4(out: Uint8Array, o: number): boolean {
        const blk = o + SCAN[this.i4], b = this.i4Boundary, top = this.i4Top;
        for (let i = 0; i <= 3; i++) b[top - 4 + i] = out[blk + i + 3 * BPS];
        if ((this.i4 & 3) !== 3) for (let i = 0; i <= 2; i++) b[top + i] = out[blk + 3 + (2 - i) * BPS];
        else for (let i = 0; i <= 3; i++) b[top + i] = b[top + i + 4];
        if (++this.i4 === 16) return false;
        this.i4Top = TOP_LEFT_I4[this.i4];
        return true;
    }

    setIntra16Mode(mode: number): void {
        const p = this.enc.preds, w = this.enc.predsW;
        for (let y = 0, o = this.preds; y < 4; y++, o += w) p[o] = p[o + 1] = p[o + 2] = p[o + 3] = mode;
        this.enc.mbType[this.mb] = 1;
    }

    setIntra4Mode(modes: Uint8Array): void {
        const p = this.enc.preds, w = this.enc.predsW;
        for (let y = 0, o = this.preds; y < 4; y++, o += w) {
            p[o] = modes[y * 4];
            p[o + 1] = modes[y * 4 + 1];
            p[o + 2] = modes[y * 4 + 2];
            p[o + 3] = modes[y * 4 + 3];
        }
        this.enc.mbType[this.mb] = 0;
    }

    swapOut(): void {
        [this.yuvOut, this.yuvOut2] = [this.yuvOut2, this.yuvOut];
    }

    /** (modes: a mask of the modes needed, 1 << mode) */
    makeLuma16Preds(modes = 15): void {
        predLuma16(this.yuvP, this.x ? this.yLeft : null, 1, this.y ? this.yTop : null, this.yTopOffset, modes);
    }

    makeChroma8Preds(modes = 15): void {
        predChroma8(this.yuvP, this.x ? this.uLeft : null, 1, this.x ? this.vLeft : null, 1, this.y ? this.uvTop : null, this.uvTopOffset, modes);
    }

    /** the distortions of the 4 intra 16x16 predictions (without making them) */
    luma16SSEs(out: Float64Array): void {
        predictionSSEs(this.yuvIn, Y_OFF, 16, 1, this.x ? this.yLeft : null, null, 1, this.y ? this.yTop : null, this.yTopOffset, out);
    }

    /** the distortions of the 4 chroma predictions (of U and V) */
    chroma8SSEs(out: Float64Array): void {
        predictionSSEs(this.yuvIn, U_OFF, 8, 2, this.x ? this.uLeft : null, this.x ? this.vLeft : null, 1, this.y ? this.uvTop : null, this.uvTopOffset, out);
    }
}

// where the top left sample of each 4x4 block is in the boundary
const TOP_LEFT_I4 = [17, 21, 25, 29, 13, 17, 21, 25, 9, 13, 17, 21, 5, 9, 13, 17];

function importBlock(src: Uint8Array, s: number, stride: number, dst: Uint8Array, d: number, w: number, h: number, size: number): void {
    if (w === size && h === size) {
        // (a whole block, its rows unrolled)
        if (size === 16) {
            for (let i = 0; i < 16; i++, s += stride, d += BPS) {
                dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
                dst[d + 4] = src[s + 4]; dst[d + 5] = src[s + 5]; dst[d + 6] = src[s + 6]; dst[d + 7] = src[s + 7];
                dst[d + 8] = src[s + 8]; dst[d + 9] = src[s + 9]; dst[d + 10] = src[s + 10]; dst[d + 11] = src[s + 11];
                dst[d + 12] = src[s + 12]; dst[d + 13] = src[s + 13]; dst[d + 14] = src[s + 14]; dst[d + 15] = src[s + 15];
            }
        } else {
            for (let i = 0; i < size; i++, s += stride, d += BPS) {
                dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
                dst[d + 4] = src[s + 4]; dst[d + 5] = src[s + 5]; dst[d + 6] = src[s + 6]; dst[d + 7] = src[s + 7];
            }
        }
        return;
    }
    for (let i = 0; i < h; i++, s += stride, d += BPS) {
        for (let x = 0; x < w; x++) dst[d + x] = src[s + x];
        // (the last column repeated)
        const last = dst[d + w - 1];
        for (let x = w; x < size; x++) dst[d + x] = last;
    }
    for (let i = h; i < size; i++, d += BPS) for (let x = 0; x < size; x++) dst[d + x] = dst[d - BPS + x];
}

// copies rows of 2 or 4 32-bit words (a whole block) into the work buffer
function copyWords(src: Uint32Array, s: number, stride: number, dst: Uint32Array, d: number, rows: number, words: number): void {
    const step = BPS >> 2;
    if (words === 4) {
        for (let i = 0; i < rows; i++, s += stride, d += step) {
            dst[d] = src[s];
            dst[d + 1] = src[s + 1];
            dst[d + 2] = src[s + 2];
            dst[d + 3] = src[s + 3];
        }
    } else {
        for (let i = 0; i < rows; i++, s += stride, d += step) {
            dst[d] = src[s];
            dst[d + 1] = src[s + 1];
        }
    }
}

function importLine(src: Uint8Array, s: number, step: number, dst: Uint8Array, d: number, len: number, total: number): void {
    let i = 0;
    for (; i < len; i++, s += step) dst[d + i] = src[s];
    for (; i < total; i++) dst[d + i] = dst[d + len - 1];
}

// ---- analysis (analysis_enc.c): the susceptibility of each macroblock, segments by it

const dcs = new Uint32Array(16), zeroModes = new Uint8Array(16);

function analyze(enc: Encoder): void {
    const alphas = new Int32Array(256);
    let alpha = 0, uvAlpha = 0;
    const it = new Iterator(enc);
    do {
        it.import(true);
        enc.mbType[it.mb] = 1;
        it.setIntra16Mode(0);
        enc.mbSkip[it.mb] = 0;
        enc.mbSegment[it.mb] = 0;
        let bestAlpha = -1;
        if (enc.method <= 1) {
            // only intra 16x16 (DC) or intra 4x4 (DC) by how much the 4x4 blocks' means vary
            bestAlpha = 0;
            const threshold = 8 + Math.trunc((17 - 8) * Math.trunc(enc.quality) / 100);
            for (let k = 0; k < 16; k += 4) mean16x4(it.yuvIn, Y_OFF + k * BPS, dcs, k);
            let m = 0, m2 = 0;
            for (let k = 0; k < 16; k++) {
                m += dcs[k];
                m2 += dcs[k] * dcs[k];
            }
            if (threshold * m2 < m * m) it.setIntra16Mode(0);
            else it.setIntra4Mode(zeroModes);
        } else {
            // the luma prediction with the highest susceptibility of DC and TM
            // (DC and TM)
            it.makeLuma16Preds(3);
            let bestMode = 0;
            for (let mode = 0; mode < 2; mode++) {
                const a = histogramAlpha(it.yuvIn, Y_OFF, it.yuvP, I16_MODE_OFFSETS[mode], 0, 16);
                if (a > bestAlpha) {
                    bestAlpha = a;
                    bestMode = mode;
                }
            }
            it.setIntra16Mode(bestMode);
        }
        // chroma: the mode with the smallest
        it.makeChroma8Preds(3);
        let bestUvAlpha = -1, smallest = 0, bestUvMode = 0;
        for (let mode = 0; mode < 2; mode++) {
            const a = histogramAlpha(it.yuvIn, U_OFF, it.yuvP, UV_MODE_OFFSETS[mode], 16, 24);
            if (a > bestUvAlpha) bestUvAlpha = a;
            if (mode === 0 || a < smallest) {
                smallest = a;
                bestUvMode = mode;
            }
        }
        enc.mbUvMode[it.mb] = bestUvMode;
        const mixed = clip(255 - ((3 * bestAlpha + bestUvAlpha + 2) >> 2), 0, 255);
        alphas[mixed]++;
        enc.mbAlpha[it.mb] = mixed;
        alpha += mixed;
        uvAlpha += bestUvAlpha;
    } while (it.next());
    const total = enc.mbW * enc.mbH;
    enc.alpha = Math.trunc(alpha / total);
    enc.uvAlpha = Math.trunc(uvAlpha / total);
    assignSegments(enc, alphas);
}

// k-means of the susceptibilities into the segments
function assignSegments(enc: Encoder, alphas: Int32Array): void {
    const nb = Math.min(enc.numSegments, NUM_MB_SEGMENTS);
    const centers = new Int32Array(NUM_MB_SEGMENTS), map = new Int32Array(256);
    const accum = new Int32Array(NUM_MB_SEGMENTS), distAccum = new Int32Array(NUM_MB_SEGMENTS);
    let minA = 0, maxA = 255;
    while (minA <= 255 && alphas[minA] === 0) minA++;
    while (maxA > minA && alphas[maxA] === 0) maxA--;
    const range = maxA - minA;
    for (let k = 0, n = 1; k < nb; k++, n += 2) centers[k] = minA + Math.trunc(n * range / (2 * nb));
    let weightedAverage = 0;
    for (let k = 0; k < 6; k++) {
        accum.fill(0);
        distAccum.fill(0);
        let n = 0;
        for (let a = minA; a <= maxA; a++) {
            if (alphas[a]) {
                while (n + 1 < nb && Math.abs(a - centers[n + 1]) < Math.abs(a - centers[n])) n++;
                map[a] = n;
                distAccum[n] += a * alphas[a];
                accum[n] += alphas[a];
            }
        }
        let displaced = 0, totalWeight = 0;
        weightedAverage = 0;
        for (let i = 0; i < nb; i++) {
            if (accum[i]) {
                const center = Math.trunc((distAccum[i] + Math.trunc(accum[i] / 2)) / accum[i]);
                displaced += Math.abs(centers[i] - center);
                centers[i] = center;
                weightedAverage += center * accum[i];
                totalWeight += accum[i];
            }
        }
        weightedAverage = Math.trunc((weightedAverage + Math.trunc(totalWeight / 2)) / totalWeight);
        if (displaced < 5) break;
    }
    for (let i = 0; i < enc.mbW * enc.mbH; i++) {
        const a = enc.mbAlpha[i];
        enc.mbSegment[i] = map[a];
        enc.mbAlpha[i] = centers[map[a]];
    }
    // the segments' susceptibilities
    let min = centers[0], max = centers[0];
    if (nb > 1) {
        for (let n = 0; n < nb; n++) {
            if (min > centers[n]) min = centers[n];
            if (max < centers[n]) max = centers[n];
        }
    }
    if (max === min) max = min + 1;
    for (let n = 0; n < nb; n++) {
        enc.dqm[n].alpha = clip(Math.trunc(255 * (centers[n] - weightedAverage) / (max - min)), -127, 127);
        enc.dqm[n].beta = clip(Math.trunc(255 * (centers[n] - min) / (max - min)), 0, 255);
    }
}

// ---- quantization parameters (quant_enc.c)

function filterStrengthFromDelta(sharpness: number, delta: number): number {
    return LEVELS_FROM_DELTA[sharpness * 64 + (delta < 64 ? delta : 63)];
}

// the matrix's reciprocals, biases and thresholds; the average quantizer
function expandMatrix(m: Matrix, type: number): number {
    for (let i = 0; i < 2; i++) {
        m.iq[i] = Math.trunc((1 << 17) / m.q[i]);
        m.bias[i] = BIAS_MATRICES[type][i > 0 ? 1 : 0] << 9;
        m.zthresh[i] = Math.trunc(((1 << 17) - 1 - m.bias[i]) / m.iq[i]);
    }
    for (let i = 2; i < 16; i++) {
        m.q[i] = m.q[1];
        m.iq[i] = m.iq[1];
        m.bias[i] = m.bias[1];
        m.zthresh[i] = m.zthresh[1];
    }
    let sum = 0;
    for (let i = 0; i < 16; i++) {
        m.sharpen[i] = type === 0 ? (FREQ_SHARPENING[i] * m.q[i]) >> 11 : 0;
        sum += m.q[i];
    }
    return (sum + 8) >> 4;
}

function setupMatrices(enc: Encoder): void {
    for (let i = 0; i < enc.numSegments; i++) {
        const m = enc.dqm[i], q = m.quant;
        m.y1.q[0] = DC_QLOOKUP[clip(q, 0, 127)];
        m.y1.q[1] = AC_QLOOKUP[clip(q, 0, 127)];
        m.y2.q[0] = DC_QLOOKUP[clip(q, 0, 127)] * 2;
        m.y2.q[1] = AC_TABLE2[clip(q, 0, 127)];
        m.uv.q[0] = DC_QLOOKUP[clip(q + enc.dqUvDc, 0, 117)];
        m.uv.q[1] = AC_QLOOKUP[clip(q + enc.dqUvAc, 0, 127)];
        const qI4 = expandMatrix(m.y1, 0), qI16 = expandMatrix(m.y2, 1), qUv = expandMatrix(m.uv, 2);
        m.lambdaI4 = Math.max(1, (3 * qI4 * qI4) >> 7);
        m.lambdaI16 = Math.max(1, 3 * qI16 * qI16);
        m.lambdaUv = Math.max(1, (3 * qUv * qUv) >> 6);
        m.lambdaMode = Math.max(1, (qI4 * qI4) >> 7);
        m.tlambda = Math.max(1, ((enc.method >= 4 ? SNS_STRENGTH : 0) * qI4) >> 5);
        m.lambdaTrellisI4 = Math.max(1, (7 * qI4 * qI4) >> 3);
        m.lambdaTrellisI16 = Math.max(1, (qI16 * qI16) >> 2);
        m.minDisto = 20 * m.y1.q[0];
        m.maxEdge = 0;
        m.i4Penalty = 1000 * qI4 * qI4;
    }
}

function setSegmentParams(enc: Encoder, quality: number): void {
    const amp = 0.9 * SNS_STRENGTH / 100 / 128;
    const c = quality / 100;
    // the file size roughly scales with the quantizer cubed: a JPEG like quality (75 is good) to a compression
    const cBase = Math.pow(c < 0.75 ? c * (2 / 3) : 2 * c - 1, 1 / 3);
    for (let i = 0; i < enc.numSegments; i++) {
        // denser segments are quantized more
        const expn = 1 - amp * enc.dqm[i].alpha;
        enc.dqm[i].quant = clip(Math.trunc(127 * (1 - Math.pow(cBase, expn))), 0, 127);
    }
    enc.baseQuant = enc.dqm[0].quant;
    for (let i = enc.numSegments; i < NUM_MB_SEGMENTS; i++) enc.dqm[i].quant = enc.baseQuant;

    let dqUvAc = Math.trunc((enc.uvAlpha - MID_ALPHA) * (MAX_DQ_UV - MIN_DQ_UV) / (MAX_ALPHA - MIN_ALPHA));
    dqUvAc = Math.trunc(dqUvAc * SNS_STRENGTH / 100);
    enc.dqUvAc = clip(dqUvAc, MIN_DQ_UV, MAX_DQ_UV);
    enc.dqUvDc = clip(Math.trunc(-4 * SNS_STRENGTH / 100), -15, 15);

    // filter strengths
    const level0 = 5 * FILTER_STRENGTH;
    for (let i = 0; i < NUM_MB_SEGMENTS; i++) {
        const m = enc.dqm[i];
        const qstep = AC_QLOOKUP[clip(m.quant, 0, 127)] >> 2;
        const f = Math.trunc(filterStrengthFromDelta(enc.filterSharpness, qstep) * level0 / (256 + m.beta));
        m.fstrength = f < 2 ? 0 : f > 63 ? 63 : f;
    }
    enc.filterLevel = enc.dqm[0].fstrength;
    enc.filterSimple = false;
    enc.filterSharpness = FILTER_SHARPNESS;

    if (enc.numSegments > 1) simplifySegments(enc);
    setupMatrices(enc);
}

// merges segments with the same quantizer and filter strength
function simplifySegments(enc: Encoder): void {
    const map = [0, 1, 2, 3];
    const num = Math.min(enc.numSegments, NUM_MB_SEGMENTS);
    let final = 1;
    for (let s1 = 1; s1 < num; s1++) {
        const S1 = enc.dqm[s1];
        let s2 = 0, found = false;
        for (; s2 < final; s2++) {
            const S2 = enc.dqm[s2];
            if (S1.quant === S2.quant && S1.fstrength === S2.fstrength) {
                found = true;
                break;
            }
        }
        map[s1] = s2;
        if (!found) {
            if (final !== s1) copySegment(enc.dqm[final], enc.dqm[s1]);
            final++;
        }
    }
    if (final < num) {
        for (let i = 0; i < enc.mbW * enc.mbH; i++) enc.mbSegment[i] = map[enc.mbSegment[i]];
        enc.numSegments = final;
        for (let i = final; i < num; i++) copySegment(enc.dqm[i], enc.dqm[final - 1]);
    }
}

function setSegmentProbas(enc: Encoder): void {
    const p = [0, 0, 0, 0];
    for (let i = 0; i < enc.mbW * enc.mbH; i++) p[enc.mbSegment[i]]++;
    if (enc.numSegments > 1) {
        const getProba = (a: number, b: number): number => a + b === 0 ? 255 : Math.trunc((255 * a + Math.trunc((a + b) / 2)) / (a + b));
        const probas = enc.proba.segments;
        probas[0] = getProba(p[0] + p[1], p[2] + p[3]);
        probas[1] = getProba(p[0], p[1]);
        probas[2] = getProba(p[2], p[3]);
        enc.updateMap = probas[0] !== 255 || probas[1] !== 255 || probas[2] !== 255;
        if (!enc.updateMap) enc.mbSegment.fill(0);
        enc.segmentSize = p[0] * (bitCost(0, probas[0]) + bitCost(0, probas[1])) + p[1] * (bitCost(0, probas[0]) + bitCost(1, probas[1])) +
            p[2] * (bitCost(1, probas[0]) + bitCost(0, probas[2])) + p[3] * (bitCost(1, probas[0]) + bitCost(1, probas[2]));
    } else {
        enc.updateMap = false;
        enc.segmentSize = 0;
    }
}

// ---- mode decisions (quant_enc.c, cost_enc.c)

const tmpLevels = new Int16Array(16), tmp16 = new Int16Array(16 * 16), dcTmp = new Int16Array(16), tmpUv = new Int16Array(8 * 16);
const residual: Residual = { first: 0, last: -1, coeffs: tmpLevels, offset: 0, type: 0 };

function costLuma16(it: Iterator, rd: ModeScore): number {
    const proba = it.enc.proba;
    it.nzToBytes();
    let R = 0;
    residual.first = 0;
    residual.type = 1;
    setResidualCoeffs(residual, rd.yDcLevels, 0);
    R += residualCost(proba, it.topNz[8] + it.leftNz[8], residual);
    residual.first = 1;
    residual.type = 0;
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            setResidualCoeffs(residual, rd.yAcLevels, (x + y * 4) * 16);
            R += residualCost(proba, it.topNz[x] + it.leftNz[y], residual);
            it.topNz[x] = it.leftNz[y] = residual.last >= 0 ? 1 : 0;
        }
    }
    return R;
}

function costLuma4(it: Iterator, levels: Int16Array): number {
    residual.first = 0;
    residual.type = 3;
    setResidualCoeffs(residual, levels, 0);
    return residualCost(it.enc.proba, it.topNz[it.i4 & 3] + it.leftNz[it.i4 >> 2], residual);
}

function costUv(it: Iterator, rd: ModeScore): number {
    it.nzToBytes();
    let R = 0;
    residual.first = 0;
    residual.type = 2;
    for (let ch = 0; ch <= 2; ch += 2) {
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 2; x++) {
                setResidualCoeffs(residual, rd.uvLevels, (ch * 2 + x + y * 2) * 16);
                R += residualCost(it.enc.proba, it.topNz[4 + ch + x] + it.leftNz[4 + ch + y], residual);
                it.topNz[4 + ch + x] = it.leftNz[4 + ch + y] = residual.last >= 0 ? 1 : 0;
            }
        }
    }
    return R;
}

// ---- trellis quantization (quant_enc.c): for each coefficient the rounded level or one more, the combination
// with the best rate-distortion score

const TYPE_I16_AC = 0, TYPE_I4_AC = 3;
// the nodes: [position][level - level0: 0, 1] best previous node, sign, level
const nodePrev = new Int8Array(32), nodeSign = new Uint8Array(32), nodeLevel = new Int16Array(32);
// the score states of the current and previous position: score, level costs (where)
const ssScore = new Float64Array(4), ssCosts = new Int32Array(4);

function trellisQuantize(enc: Encoder, input: Int16Array, i: number, out: Int16Array, o: number, ctx0: number, type: number, m: Matrix, lambda: number): number {
    const proba = enc.proba, costs = proba.levelCost, remap = proba.remapped, base = type * 16;
    const first = type === TYPE_I16_AC ? 1 : 0;
    // (positions past the last one keep the costs of the last)
    const costsAt = (n: number, ctx: number): number => remap[(base + Math.min(n, 15)) * NUM_CTX + ctx];
    let cur = 0, prev = 2;
    const best = [-1, -1, -1];
    let last = first - 1;
    const thresh = Math.trunc(m.q[1] * m.q[1] / 4);
    const lastProba = proba.coeffs[probaIndex(type, BANDS[first], ctx0)];
    for (let n = 15; n >= first; n--) {
        const j = ZIGZAG[n];
        if (input[i + j] * input[i + j] > thresh) {
            last = n;
            break;
        }
    }
    if (last < 15) last++;
    // skipping the block is the score to beat
    let bestScore = bitCost(0, lastProba) * lambda;
    for (let k = 0; k < 2; k++) {
        ssScore[cur + k] = (ctx0 === 0 ? bitCost(1, lastProba) : 0) * lambda;
        ssCosts[cur + k] = costsAt(first, ctx0);
    }
    for (let n = first; n <= last; n++) {
        const j = ZIGZAG[n];
        const Q = m.q[j], iQ = m.iq[j];
        const sign = input[i + j] < 0 ? 1 : 0;
        const coeff0 = (sign ? -input[i + j] : input[i + j]) + m.sharpen[j];
        let level0 = (coeff0 * iQ) >>> 17;
        let threshLevel = (coeff0 * iQ + (0x80 << 9)) >>> 17;
        if (threshLevel > MAX_LEVEL) threshLevel = MAX_LEVEL;
        if (level0 > MAX_LEVEL) level0 = MAX_LEVEL;
        [cur, prev] = [prev, cur];
        for (let k = 0; k < 2; k++) {
            const level = level0 + k;
            const ctx = level > 2 ? 2 : level;
            const band = BANDS[n + 1];
            ssCosts[cur + k] = costsAt(n + 1, ctx);
            if (level < 0 || level > threshLevel) {
                ssScore[cur + k] = MAX_COST;
                continue;
            }
            // the change in distortion of coding this level
            const newError = coeff0 - level * Q;
            const baseScore = RD_DISTO_MULT * WEIGHT_TRELLIS[j] * (newError * newError - coeff0 * coeff0);
            // the best predecessor
            let bestCur = ssScore[prev] + levelCost(costs, ssCosts[prev], level) * lambda, bestPrev = 0;
            const score1 = ssScore[prev + 1] + levelCost(costs, ssCosts[prev + 1], level) * lambda;
            if (score1 < bestCur) {
                bestCur = score1;
                bestPrev = 1;
            }
            bestCur += baseScore;
            const node = n * 2 + k;
            nodeSign[node] = sign;
            nodeLevel[node] = level;
            nodePrev[node] = bestPrev;
            ssScore[cur + k] = bestCur;
            // the best terminal node
            if (level !== 0 && bestCur < bestScore) {
                const score = bestCur + (n < 15 ? bitCost(0, proba.coeffs[probaIndex(type, band, ctx)]) : 0) * lambda;
                if (score < bestScore) {
                    bestScore = score;
                    best[0] = n;
                    best[1] = k;
                    best[2] = bestPrev;
                }
            }
        }
    }
    // (an intra 16x16 block's DC is kept)
    input.fill(0, i + first, i + 16);
    out.fill(0, o + first, o + 16);
    if (best[0] === -1) return 0;
    let nz = 0, node = best[1];
    nodePrev[best[0] * 2 + node] = best[2];
    for (let n = best[0]; n >= first; n--) {
        const index = n * 2 + node, j = ZIGZAG[n];
        out[o + n] = nodeSign[index] ? -nodeLevel[index] : nodeLevel[index];
        nz |= nodeLevel[index];
        input[i + j] = out[o + n] * m.q[j];
        node = nodePrev[index];
    }
    return nz !== 0 ? 1 : 0;
}

function reconstructIntra16(it: Iterator, rd: ModeScore, out: Uint8Array, o: number, mode: number): number {
    const dqm = it.enc.dqm[it.enc.mbSegment[it.mb]];
    const ref = it.yuvP, r = I16_MODE_OFFSETS[mode], src = it.yuvIn;
    let nz = 0;
    for (let n = 0; n < 16; n++) fTransform(src, Y_OFF + SCAN[n], ref, r + SCAN[n], tmp16, n * 16);
    fTransformWHT(tmp16, dcTmp);
    nz |= (quantizeBlock(dcTmp, 0, rd.yDcLevels, 0, dqm.y2) ? 1 : 0) << 24;
    if (it.doTrellis) {
        it.nzToBytes();
        for (let y = 0, n = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++, n++) {
                const nonZero = trellisQuantize(it.enc, tmp16, n * 16, rd.yAcLevels, n * 16, it.topNz[x] + it.leftNz[y], TYPE_I16_AC, dqm.y1, dqm.lambdaTrellisI16);
                it.topNz[x] = it.leftNz[y] = nonZero;
                rd.yAcLevels[n * 16] = 0;
                nz |= nonZero << n;
            }
        }
    } else {
        for (let n = 0; n < 16; n++) {
            // (the DCs are coded separately)
            tmp16[n * 16] = 0;
            nz |= (quantizeBlock(tmp16, n * 16, rd.yAcLevels, n * 16, dqm.y1) ? 1 : 0) << n;
        }
    }
    iTransformWHT(dcTmp, tmp16);
    for (let n = 0; n < 16; n += 2) iTransform(ref, r + SCAN[n], tmp16, n * 16, out, o + SCAN[n], true);
    return nz;
}

function reconstructIntra4(it: Iterator, levels: Int16Array, lo: number, src: Uint8Array, s: number, out: Uint8Array, o: number, mode: number): number {
    const dqm = it.enc.dqm[it.enc.mbSegment[it.mb]];
    const r = I4_MODE_OFFSETS[mode];
    fTransform(src, s, it.yuvP, r, tmpLevels, 0);
    const nz = it.doTrellis ? trellisQuantize(it.enc, tmpLevels, 0, levels, lo, it.topNz[it.i4 & 3] + it.leftNz[it.i4 >> 2], TYPE_I4_AC, dqm.y1, dqm.lambdaTrellisI4)
        : quantizeBlock(tmpLevels, 0, levels, lo, dqm.y1) ? 1 : 0;
    // (without levels, the block is the prediction)
    if (nz) iTransform(it.yuvP, r, tmpLevels, 0, out, o, false);
    else {
        const p = it.yuvP;
        for (let k = 0; k < 4 * BPS; k += BPS) {
            out[o + k] = p[r + k];
            out[o + k + 1] = p[r + k + 1];
            out[o + k + 2] = p[r + k + 2];
            out[o + k + 3] = p[r + k + 3];
        }
    }
    return nz;
}

// quantizes a DC (in place), returning the error (halved)
function quantizeSingle(v: Int16Array, i: number, m: Matrix): number {
    let V = v[i];
    const sign = V < 0;
    if (sign) V = -V;
    if (V > m.zthresh[0]) {
        const qV = ((V * m.iq[0] + m.bias[0]) >>> 17) * m.q[0];
        const err = V - qV;
        v[i] = sign ? -qV : qV;
        return (sign ? -err : err) >> 1;
    }
    v[i] = 0;
    return (sign ? -V : V) >> 1;
}

// diffuses the DC quantization errors of chroma from the blocks above and left
function correctDcValues(it: Iterator, m: Matrix, tmp: Int16Array, rd: ModeScore): void {
    const top = it.enc.topDerr as Int8Array, t = it.x * 4, left = it.leftDerr;
    for (let ch = 0; ch <= 1; ch++) {
        const c = ch * 4 * 16;
        tmp[c] += (7 * top[t + ch * 2] + 8 * left[ch * 2]) >> 3;
        const err0 = quantizeSingle(tmp, c, m);
        tmp[c + 16] += (7 * top[t + ch * 2 + 1] + 8 * err0) >> 3;
        const err1 = quantizeSingle(tmp, c + 16, m);
        tmp[c + 32] += (7 * err0 + 8 * left[ch * 2 + 1]) >> 3;
        const err2 = quantizeSingle(tmp, c + 32, m);
        tmp[c + 48] += (7 * err1 + 8 * err2) >> 3;
        const err3 = quantizeSingle(tmp, c + 48, m);
        rd.derr[ch * 3] = err1;
        rd.derr[ch * 3 + 1] = err2;
        rd.derr[ch * 3 + 2] = err3;
    }
}

function storeDiffusionErrors(it: Iterator, rd: ModeScore): void {
    const top = it.enc.topDerr as Int8Array, t = it.x * 4, left = it.leftDerr;
    for (let ch = 0; ch <= 1; ch++) {
        left[ch * 2] = rd.derr[ch * 3];
        left[ch * 2 + 1] = (3 * rd.derr[ch * 3 + 2]) >> 2;
        top[t + ch * 2] = rd.derr[ch * 3 + 1];
        top[t + ch * 2 + 1] = rd.derr[ch * 3 + 2] - left[ch * 2 + 1];
    }
}

function reconstructUv(it: Iterator, rd: ModeScore, out: Uint8Array, o: number, mode: number): number {
    const dqm = it.enc.dqm[it.enc.mbSegment[it.mb]];
    const r = UV_MODE_OFFSETS[mode];
    let nz = 0;
    for (let n = 0; n < 8; n++) fTransform(it.yuvIn, U_OFF + SCAN_UV[n], it.yuvP, r + SCAN_UV[n], tmpUv, n * 16);
    if (it.enc.topDerr) correctDcValues(it, dqm.uv, tmpUv, rd);
    for (let n = 0; n < 8; n++) nz |= (quantizeBlock(tmpUv, n * 16, rd.uvLevels, n * 16, dqm.uv) ? 1 : 0) << n;
    for (let n = 0; n < 8; n += 2) iTransform(it.yuvP, r + SCAN_UV[n], tmpUv, n * 16, out, o + SCAN_UV[n], true);
    return nz << 16;
}

const rdTmp = new ModeScore();
// the weighted spectra of the source's 4x4 luma blocks
const sourceSpectra = new Int32Array(16);

function pickBestIntra16(it: Iterator, rd: ModeScore): void {
    const enc = it.enc, dqm = enc.dqm[enc.mbSegment[it.mb]];
    const lambda = dqm.lambdaI16, tlambda = dqm.tlambda;
    let rdCur = rdTmp, rdBest = rd;
    let flat = isFlatSource16(it.yuvIn, Y_OFF);
    if (tlambda) for (let n = 0; n < 16; n++) sourceSpectra[n] = tTransform(it.yuvIn, Y_OFF + SCAN[n], WEIGHT_Y);
    rd.modeI16 = -1;
    for (let mode = 0; mode < 4; mode++) {
        const dst = it.yuvOut2;
        rdCur.modeI16 = mode;
        rdCur.nz = reconstructIntra16(it, rdCur, dst, Y_OFF, mode);
        rdCur.D = sse16(it.yuvIn, Y_OFF, dst, Y_OFF, 16);
        rdCur.H = FIXED_COSTS_I16[mode];
        // a very flat block: emphasis on low distortion
        if (flat) flat = isFlat(rdCur.yAcLevels, 0, 16, FLATNESS_LIMIT_I16);
        if (flat) rdCur.D *= 2;
        // (modes that can't beat the best without texture distortion and rate are skipped before them)
        rdCur.SD = rdCur.R = 0;
        rdCur.setRDScore(lambda);
        if (mode > 0 && rdCur.score >= rdBest.score) continue;
        rdCur.SD = tlambda ? (tlambda * tDisto16x16(sourceSpectra, dst, Y_OFF, WEIGHT_Y) + 128) >> 8 : 0;
        if (flat) rdCur.SD *= 2;
        rdCur.R = costLuma16(it, rdCur);
        rdCur.setRDScore(lambda);
        if (mode === 0 || rdCur.score < rdBest.score) {
            const swap = rdCur;
            rdCur = rdBest;
            rdBest = swap;
            it.swapOut();
        }
    }
    if (rdBest !== rd) rd.copyAll(rdBest);
    rd.setRDScore(dqm.lambdaMode);
    it.setIntra16Mode(rd.modeI16);
    // blocky (only DCs) with a high distortion: the filter strength should smooth these
    if ((rd.nz & 0x100ffff) === 0x1000000 && rd.D > dqm.minDisto) {
        const max = Math.max(Math.abs(rd.yDcLevels[1]), Math.abs(rd.yDcLevels[2]), Math.abs(rd.yDcLevels[4]));
        if (max > dqm.maxEdge) dqm.maxEdge = max;
    }
}

const rdI4 = new ModeScore(), rdTmpI4 = new ModeScore(), rdBestI4 = new ModeScore();

function costModesI4(it: Iterator, modes: Uint8Array): number {
    const enc = it.enc, x = it.i4 & 3, y = it.i4 >> 2;
    const left = x === 0 ? enc.preds[it.preds + y * enc.predsW - 1] : modes[it.i4 - 1];
    const top = y === 0 ? enc.preds[it.preds - enc.predsW + x] : modes[it.i4 - 4];
    return (top * 10 + left) * 10;
}

function pickBestIntra4(it: Iterator, rd: ModeScore): boolean {
    const enc = it.enc, dqm = enc.dqm[enc.mbSegment[it.mb]];
    const lambda = dqm.lambdaI4, tlambda = dqm.tlambda;
    const costs = fixedCostsI4 as Uint16Array;
    let totalHeaderBits = 0;
    if (enc.maxI4HeaderBits === 0) return false;
    const best = rdBestI4;
    best.init();
    best.H = 211;
    best.setRDScore(dqm.lambdaMode);
    it.startI4();
    do {
        const src = Y_OFF + SCAN[it.i4];
        const modeCosts = costModesI4(it, rd.modesI4);
        let bestMode = -1;
        // the best block, and a scratch one to try modes in (they're swapped)
        let bestBlock = it.yuvOut2, bb = Y_OFF + SCAN[it.i4];
        let tmpDst = it.yuvP, td = I4TMP;
        rdI4.init();
        predLuma4(it.yuvP, it.i4Boundary, it.i4Top);
        const spectrum = tlambda ? tTransform(it.yuvIn, src, WEIGHT_Y) : 0;
        for (let mode = 0; mode < 10; mode++) {
            const r = rdTmpI4;
            // (the score only grows from the header bits on: modes that can't beat the best are skipped as early as
            // possible, which doesn't change the choice)
            r.H = costs[modeCosts + mode];
            if (bestMode >= 0 && r.H * lambda >= rdI4.score) continue;
            r.nz = reconstructIntra4(it, tmpLevels2, 0, it.yuvIn, src, tmpDst, td, mode) << it.i4;
            r.D = sse4x4(it.yuvIn, src, tmpDst, td);
            // flat areas shouldn't be predicted by complex modes
            r.R = mode > 0 && isFlat(tmpLevels2, 0, 1, FLATNESS_LIMIT_I4) ? FLATNESS_PENALTY : 0;
            r.SD = 0;
            r.setRDScore(lambda);
            if (bestMode >= 0 && r.score >= rdI4.score) continue;
            r.SD = tlambda ? (tlambda * tDisto4x4(spectrum, tmpDst, td, WEIGHT_Y) + 128) >> 8 : 0;
            r.setRDScore(lambda);
            if (bestMode >= 0 && r.score >= rdI4.score) continue;
            r.R += costLuma4(it, tmpLevels2);
            r.setRDScore(lambda);
            if (bestMode < 0 || r.score < rdI4.score) {
                rdI4.copyScore(r);
                bestMode = mode;
                const swap = tmpDst, swapOffset = td;
                tmpDst = bestBlock;
                td = bb;
                bestBlock = swap;
                bb = swapOffset;
                best.yAcLevels.set(tmpLevels2, it.i4 * 16);
            }
        }
        rdI4.setRDScore(dqm.lambdaMode);
        best.addScore(rdI4);
        if (best.score >= rd.score) return false;
        totalHeaderBits += rdI4.H;
        if (totalHeaderBits > enc.maxI4HeaderBits) return false;
        const target = Y_OFF + SCAN[it.i4];
        if (bestBlock !== it.yuvOut2 || bb !== target) {
            const out2 = it.yuvOut2;
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) out2[target + y * BPS + x] = bestBlock[bb + y * BPS + x];
            }
        }
        rd.modesI4[it.i4] = bestMode;
        it.topNz[it.i4 & 3] = it.leftNz[it.i4 >> 2] = rdI4.nz ? 1 : 0;
    } while (it.rotateI4(it.yuvOut2, Y_OFF));
    rd.copyScore(best);
    it.setIntra4Mode(rd.modesI4);
    it.swapOut();
    rd.yAcLevels.set(best.yAcLevels);
    return true;
}

const tmpLevels2 = new Int16Array(16);
const rdUv = new ModeScore(), rdBestUv = new ModeScore();

function pickBestUv(it: Iterator, rd: ModeScore): void {
    const enc = it.enc, dqm = enc.dqm[enc.mbSegment[it.mb]];
    const lambda = dqm.lambdaUv;
    const dst0 = it.yuvOut;
    let tmpDst = it.yuvOut2, dst = dst0;
    rd.modeUv = -1;
    rdBestUv.init();
    for (let mode = 0; mode < 4; mode++) {
        const r = rdUv;
        r.nz = reconstructUv(it, r, tmpDst, U_OFF, mode);
        r.D = sse16(it.yuvIn, U_OFF, tmpDst, U_OFF, 8);
        r.SD = 0;
        r.H = FIXED_COSTS_UV[mode];
        r.R = mode > 0 && isFlat(r.uvLevels, 0, 8, FLATNESS_LIMIT_UV) ? FLATNESS_PENALTY * 8 : 0;
        // (modes that can't beat the best without their rate are skipped before it)
        r.setRDScore(lambda);
        if (mode > 0 && r.score >= rdBestUv.score) continue;
        r.R += costUv(it, r);
        r.setRDScore(lambda);
        if (mode === 0 || r.score < rdBestUv.score) {
            rdBestUv.copyScore(r);
            rd.modeUv = mode;
            rd.uvLevels.set(r.uvLevels);
            if (enc.topDerr) rd.derr.set(r.derr);
            const swap = dst;
            dst = tmpDst;
            tmpDst = swap;
        }
    }
    enc.mbUvMode[it.mb] = rd.modeUv;
    rd.addScore(rdBestUv);
    if (dst !== dst0) for (let y = 0; y < 8; y++) dst0.set(dst.subarray(U_OFF + y * BPS, U_OFF + y * BPS + 16), U_OFF + y * BPS);
    if (enc.topDerr) storeDiffusionErrors(it, rd);
}

// quantizes and reconstructs with the modes decided
function simpleQuantize(it: Iterator, rd: ModeScore): void {
    const enc = it.enc;
    let nz = 0;
    if (enc.mbType[it.mb] === 1) nz = reconstructIntra16(it, rd, it.yuvOut, Y_OFF, enc.preds[it.preds]);
    else {
        it.startI4();
        do {
            const mode = enc.preds[it.preds + (it.i4 & 3) + (it.i4 >> 2) * enc.predsW];
            const o = Y_OFF + SCAN[it.i4];
            predLuma4(it.yuvP, it.i4Boundary, it.i4Top);
            nz |= reconstructIntra4(it, rd.yAcLevels, it.i4 * 16, it.yuvIn, o, it.yuvOut, o, mode) << it.i4;
        } while (it.rotateI4(it.yuvOut, Y_OFF));
    }
    nz |= reconstructUv(it, rd, it.yuvOut, U_OFF, enc.mbUvMode[it.mb]);
    rd.nz = nz;
}

const modeSSEs = new Float64Array(4);

// picks the modes by distortion only (and a rough cost of the modes), quantizes and reconstructs
function refineUsingDistortion(it: Iterator, tryBoth: boolean, refineUv: boolean, rd: ModeScore): void {
    const enc = it.enc, dqm = enc.dqm[enc.mbSegment[it.mb]];
    const costs = fixedCostsI4 as Uint16Array;
    let bestScore = MAX_COST, nz = 0;
    let i16 = tryBoth || enc.mbType[it.mb] === 1;
    let scoreI4 = dqm.i4Penalty, i4Bits = 0;
    const bitLimit = tryBoth ? enc.mbHeaderLimit : MAX_COST;
    if (i16) {
        let bestMode = -1;
        it.luma16SSEs(modeSSEs);
        for (let mode = 0; mode < 4; mode++) {
            if (mode > 0 && FIXED_COSTS_I16[mode] > bitLimit) continue;
            const score = modeSSEs[mode] * RD_DISTO_MULT + FIXED_COSTS_I16[mode] * 106;
            if (score < bestScore) {
                bestMode = mode;
                bestScore = score;
            }
        }
        // (no checkerboard resonance from the borders)
        if ((it.x === 0 || it.y === 0) && isFlatSource16(it.yuvIn, Y_OFF)) {
            bestMode = it.x === 0 ? 0 : 2;
            tryBoth = false;
        }
        it.setIntra16Mode(bestMode);
    }
    if (tryBoth || !i16) {
        // the rate of intra 4x4 is accounted for by a constant penalty
        i16 = false;
        it.startI4();
        do {
            let bestI4Mode = -1, bestI4Score = MAX_COST;
            const src = Y_OFF + SCAN[it.i4];
            const modeCosts = costModesI4(it, rd.modesI4);
            predLuma4(it.yuvP, it.i4Boundary, it.i4Top);
            for (let mode = 0; mode < 10; mode++) {
                const score = sse4x4(it.yuvIn, src, it.yuvP, I4_MODE_OFFSETS[mode]) * RD_DISTO_MULT + costs[modeCosts + mode] * 11;
                if (score < bestI4Score) {
                    bestI4Mode = mode;
                    bestI4Score = score;
                }
            }
            i4Bits += costs[modeCosts + bestI4Mode];
            rd.modesI4[it.i4] = bestI4Mode;
            scoreI4 += bestI4Score;
            if (scoreI4 >= bestScore || i4Bits > bitLimit) {
                // intra 4x4 won't be better
                i16 = true;
                break;
            }
            nz |= reconstructIntra4(it, rd.yAcLevels, it.i4 * 16, it.yuvIn, src, it.yuvOut2, src, bestI4Mode) << it.i4;
        } while (it.rotateI4(it.yuvOut2, Y_OFF));
    }
    if (!i16) {
        it.setIntra4Mode(rd.modesI4);
        it.swapOut();
        bestScore = scoreI4;
    } else {
        // (only the prediction used)
        it.makeLuma16Preds(1 << enc.preds[it.preds]);
        nz = reconstructIntra16(it, rd, it.yuvOut, Y_OFF, enc.preds[it.preds]);
    }

    if (refineUv) {
        let bestMode = -1, bestUvScore = MAX_COST;
        it.chroma8SSEs(modeSSEs);
        for (let mode = 0; mode < 4; mode++) {
            const score = modeSSEs[mode] * RD_DISTO_MULT + FIXED_COSTS_UV[mode] * 120;
            if (score < bestUvScore) {
                bestMode = mode;
                bestUvScore = score;
            }
        }
        enc.mbUvMode[it.mb] = bestMode;
    }
    it.makeChroma8Preds(1 << enc.mbUvMode[it.mb]);
    nz |= reconstructUv(it, rd, it.yuvOut, U_OFF, enc.mbUvMode[it.mb]);
    rd.nz = nz;
    rd.score = bestScore;
}

/** picks the best modes and quantizes; whether the macroblock has no coefficients */
function decimate(it: Iterator, rd: ModeScore, rdOpt: number): boolean {
    const method = it.enc.method;
    rd.init();
    if (rdOpt > RD_OPT_NONE) {
        it.makeLuma16Preds();
        it.makeChroma8Preds();
        it.doTrellis = rdOpt >= RD_OPT_TRELLIS_ALL;
        pickBestIntra16(it, rd);
        if (method >= 2) pickBestIntra4(it, rd);
        pickBestUv(it, rd);
        // trellis for the final decision only
        if (rdOpt === RD_OPT_TRELLIS) {
            it.doTrellis = true;
            simpleQuantize(it, rd);
        }
    } else {
        // (the analysis decided intra 16x16 or 4x4, methods 2 and up reconsider; method 0 keeps the chroma mode; the
        // predictions are made as needed)
        refineUsingDistortion(it, method >= 2, method >= 1, rd);
    }
    const skipped = rd.nz === 0;
    it.enc.mbSkip[it.mb] = skipped ? 1 : 0;
    return skipped;
}

function recordTokens(it: Iterator, rd: ModeScore): void {
    const enc = it.enc, stats = enc.proba.stats, tokens = enc.tokens;
    it.nzToBytes();
    if (enc.mbType[it.mb] === 1) {
        residual.first = 0;
        residual.type = 1;
        setResidualCoeffs(residual, rd.yDcLevels, 0);
        it.topNz[8] = it.leftNz[8] = tokens.record(it.topNz[8] + it.leftNz[8], residual, stats) && residual.last >= 0 ? 1 : 0;
        residual.first = 1;
        residual.type = 0;
    } else {
        residual.first = 0;
        residual.type = 3;
    }
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            setResidualCoeffs(residual, rd.yAcLevels, (x + y * 4) * 16);
            it.topNz[x] = it.leftNz[y] = tokens.record(it.topNz[x] + it.leftNz[y], residual, stats) && residual.last >= 0 ? 1 : 0;
        }
    }
    residual.first = 0;
    residual.type = 2;
    for (let ch = 0; ch <= 2; ch += 2) {
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 2; x++) {
                setResidualCoeffs(residual, rd.uvLevels, (ch * 2 + x + y * 2) * 16);
                it.topNz[4 + ch + x] = it.leftNz[4 + ch + y] =
                    tokens.record(it.topNz[4 + ch + x] + it.leftNz[4 + ch + y], residual, stats) && residual.last >= 0 ? 1 : 0;
            }
        }
    }
    it.bytesToNz();
}

// ---- the coding loop (frame_enc.c: VP8EncTokenLoop with a single pass)

// the size of partition 0 (in 1/256 bits) that leaves 2 KiB of the 512 KiB it may take
const PARTITION0_SIZE_LIMIT = ((1 << 19) - 2048) * 2048;

function tokenLoop(enc: Encoder): void {
    const maxCount = Math.max((enc.mbW * enc.mbH) >> 3, 96);
    const quality = Math.fround(enc.quality);
    for (; ;) {
        let sizeP0 = 0, cnt = maxCount;
        const it = new Iterator(enc);
        setSegmentParams(enc, quality);
        setSegmentProbas(enc);
        enc.proba.calculateLevelCosts();
        enc.proba.nbSkip = 0;
        enc.proba.stats.fill(0);
        enc.tokens.length = 0;
        const rd = new ModeScore();
        do {
            it.import(false);
            if (--cnt < 0) {
                enc.proba.finalizeTokenProbas();
                enc.proba.calculateLevelCosts();
                cnt = maxCount;
            }
            decimate(it, rd, enc.rdOpt);
            recordTokens(it, rd);
            sizeP0 += rd.H;
            it.saveBoundary();
        } while (it.next());
        sizeP0 += enc.segmentSize;
        // partition 0 (the modes) would be too large: limit the bits of intra 4x4 modes, start over
        if (enc.maxI4HeaderBits > 0 && sizeP0 > PARTITION0_SIZE_LIMIT) {
            enc.maxI4HeaderBits >>= 1;
            continue;
        }
        break;
    }
    enc.proba.finalizeTokenProbas();
    enc.tokens.emit(enc.parts, enc.proba.coeffs);
    adjustFilterStrength(enc);
}

// ---- methods 0-2 (frame_enc.c: VP8EncLoop): a pass collecting statistics, then the coefficients are coded directly
// (and skipped macroblocks signalled)

// codes the coefficients with the current probabilities
function putCoeffs(bw: BitWriter, probas: Uint8Array, ctx: number, res: Residual): number {
    let n = res.first;
    let p = probaIndex(res.type, n, ctx);
    if (!bw.putBit(res.last >= 0, probas[p])) return 0;
    while (n < 16) {
        const c = res.coeffs[res.offset + n++];
        const sign = c < 0;
        let v = sign ? -c : c;
        if (!bw.putBit(v !== 0, probas[p + 1])) {
            p = probaIndex(res.type, BANDS[n], 0);
            continue;
        }
        if (!bw.putBit(v > 1, probas[p + 2])) p = probaIndex(res.type, BANDS[n], 1);
        else {
            if (!bw.putBit(v > 4, probas[p + 3])) {
                if (bw.putBit(v !== 2, probas[p + 4])) bw.putBit(v === 4, probas[p + 5]);
            } else if (!bw.putBit(v > 10, probas[p + 6])) {
                if (!bw.putBit(v > 6, probas[p + 7])) bw.putBit(v === 6, 159);
                else {
                    bw.putBit(v >= 9, 165);
                    bw.putBit(!(v & 1), 145);
                }
            } else {
                let mask: number, tab: number[];
                if (v < 3 + (8 << 1)) {
                    bw.putBit(0, probas[p + 8]);
                    bw.putBit(0, probas[p + 9]);
                    v -= 3 + 8;
                    mask = 1 << 2;
                    tab = CAT3;
                } else if (v < 3 + (8 << 2)) {
                    bw.putBit(0, probas[p + 8]);
                    bw.putBit(1, probas[p + 9]);
                    v -= 3 + (8 << 1);
                    mask = 1 << 3;
                    tab = CAT4;
                } else if (v < 3 + (8 << 3)) {
                    bw.putBit(1, probas[p + 8]);
                    bw.putBit(0, probas[p + 10]);
                    v -= 3 + (8 << 2);
                    mask = 1 << 4;
                    tab = CAT5;
                } else {
                    bw.putBit(1, probas[p + 8]);
                    bw.putBit(1, probas[p + 10]);
                    v -= 3 + (8 << 3);
                    mask = 1 << 10;
                    tab = CAT6;
                }
                for (let k = 0; mask; mask >>= 1, k++) bw.putBit(v & mask, tab[k]);
            }
            p = probaIndex(res.type, BANDS[n], 2);
        }
        bw.putBitUniform(sign);
        if (n === 16 || !bw.putBit(n <= res.last, probas[p])) return 1;
    }
    return 1;
}

// codes (code) or records (stats) the coefficients of a macroblock
function residuals(it: Iterator, rd: ModeScore, code: (ctx: number, res: Residual) => number): void {
    const enc = it.enc, nz = rd.nz;
    it.nzToBytes();
    if (enc.mbType[it.mb] === 1) {
        residual.first = 0;
        residual.type = 1;
        setResidualCoeffs(residual, rd.yDcLevels, 0, nz >> 24 & 1);
        it.topNz[8] = it.leftNz[8] = code(it.topNz[8] + it.leftNz[8], residual);
        residual.first = 1;
        residual.type = 0;
    } else {
        residual.first = 0;
        residual.type = 3;
    }
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            setResidualCoeffs(residual, rd.yAcLevels, (x + y * 4) * 16, nz >> (x + y * 4) & 1);
            it.topNz[x] = it.leftNz[y] = code(it.topNz[x] + it.leftNz[y], residual);
        }
    }
    residual.first = 0;
    residual.type = 2;
    for (let ch = 0; ch <= 2; ch += 2) {
        for (let y = 0; y < 2; y++) {
            for (let x = 0; x < 2; x++) {
                setResidualCoeffs(residual, rd.uvLevels, (ch * 2 + x + y * 2) * 16, nz >> (16 + ch * 2 + x + y * 2) & 1);
                it.topNz[4 + ch + x] = it.leftNz[4 + ch + y] = code(it.topNz[4 + ch + x] + it.leftNz[4 + ch + y], residual);
            }
        }
    }
    it.bytesToNz();
}

function finalizeSkipProba(enc: Encoder): void {
    const proba = enc.proba, total = enc.mbW * enc.mbH;
    proba.skipProba = Math.trunc((total - proba.nbSkip) * 255 / total);
    proba.useSkipProba = proba.skipProba < 250;
}

function encodeLoop(enc: Encoder): void {
    const quality = Math.fround(enc.quality);
    const rd = new ModeScore();
    const stats = enc.proba.stats, tokens = enc.tokens, total = enc.mbW * enc.mbH;
    // the modes and coefficients don't depend on the probabilities: the macroblocks of the statistics are recorded as
    // tokens (with the statistics libwebp's VP8RecordCoeffs counts), to code them once the probabilities are known
    // instead of again
    const starts = new Uint32Array(total + 1);
    const record = (ctx: number, res: Residual): number => tokens.record(ctx, res, stats, 10) ? 1 : 0;
    // the statistics: of a quarter of the macroblocks (method 0, at least 50)
    stats.fill(0);
    let collected = true, it: Iterator, recorded: number, more: boolean;
    for (; ;) {
        let count = total;
        if (enc.method === 0) count = count > 200 ? count >> 2 : 50;
        it = new Iterator(enc);
        setSegmentParams(enc, quality);
        setSegmentProbas(enc);
        enc.proba.nbSkip = 0;
        tokens.length = 0;
        recorded = 0;
        let sizeP0 = 0;
        do {
            it.import(false);
            if (decimate(it, rd, RD_OPT_NONE)) enc.proba.nbSkip++;
            starts[recorded++] = tokens.length;
            residuals(it, rd, record);
            sizeP0 += rd.H;
            it.saveBoundary();
        } while ((more = it.next()) && --count > 0);
        starts[recorded] = tokens.length;
        sizeP0 += enc.segmentSize;
        // (libwebp stops without updating the probabilities when partition 0 seems empty)
        if (sizeP0 === 0) {
            collected = false;
            break;
        }
        if (enc.maxI4HeaderBits > 0 && sizeP0 > PARTITION0_SIZE_LIMIT) {
            enc.maxI4HeaderBits >>= 1;
            continue;
        }
        break;
    }
    if (collected) {
        finalizeSkipProba(enc);
        enc.proba.finalizeTokenProbas();
    }

    // (no level costs: these methods decide by distortion)
    const bw = enc.parts, probas = enc.proba.coeffs, skip = enc.proba.useSkipProba;
    for (let mb = 0; mb < recorded; mb++) if (!skip || !enc.mbSkip[mb]) tokens.emit(bw, probas, starts[mb], starts[mb + 1]);
    tokens.length = 0;
    // the rest, continuing from the statistics' last macroblock
    const code = (ctx: number, res: Residual): number => putCoeffs(bw, probas, ctx, res);
    if (more) {
        do {
            it.import(false);
            if (!decimate(it, rd, enc.rdOpt) || !skip) residuals(it, rd, code);
            else if (enc.mbType[it.mb] === 1) {
                // a skipped macroblock: its non-zero bits are reset
                enc.nz[it.nzIndex] = 0;
                it.leftNz[8] = 0;
            } else enc.nz[it.nzIndex] &= 1 << 24;
            it.saveBoundary();
        } while (it.next());
    }
    adjustFilterStrength(enc);
}

// the filter strength that smooths blocky macroblocks
function adjustFilterStrength(enc: Encoder): void {
    let maxLevel = 0;
    for (let s = 0; s < NUM_MB_SEGMENTS; s++) {
        const m = enc.dqm[s];
        const level = filterStrengthFromDelta(enc.filterSharpness, (m.maxEdge * m.y2.q[1]) >> 3);
        if (level > m.fstrength) m.fstrength = level;
        if (maxLevel < m.fstrength) maxLevel = m.fstrength;
    }
    enc.filterLevel = maxLevel;
}

// ---- the bitstream (syntax_enc.c, tree_enc.c)

const B_TM_PRED = 1, B_VE_PRED = 2, B_HE_PRED = 3, B_RD_PRED = 4, B_LD_PRED = 6, B_VL_PRED = 7, B_HD_PRED = 8;
const TM_PRED = 1, V_PRED = 2, H_PRED = 3;

function putI4Mode(bw: BitWriter, mode: number, p: number): void {
    const prob = BMODES_PROBA;
    if (bw.putBit(mode !== 0, prob[p])) {
        if (bw.putBit(mode !== B_TM_PRED, prob[p + 1])) {
            if (bw.putBit(mode !== B_VE_PRED, prob[p + 2])) {
                if (!bw.putBit(mode >= B_LD_PRED, prob[p + 3])) {
                    if (bw.putBit(mode !== B_HE_PRED, prob[p + 4])) bw.putBit(mode !== B_RD_PRED, prob[p + 5]);
                } else if (bw.putBit(mode !== B_LD_PRED, prob[p + 6])) {
                    if (bw.putBit(mode !== B_VL_PRED, prob[p + 7])) bw.putBit(mode !== B_HD_PRED, prob[p + 8]);
                }
            }
        }
    }
}

function codeIntraModes(enc: Encoder, bw: BitWriter): void {
    const w = enc.predsW;
    for (let my = 0; my < enc.mbH; my++) {
        for (let mx = 0; mx < enc.mbW; mx++) {
            const mb = my * enc.mbW + mx, preds = w + 1 + my * 4 * w + mx * 4;
            if (enc.updateMap) {
                const s = enc.mbSegment[mb], p = enc.proba.segments;
                bw.putBit(s & 1, p[bw.putBit(s >= 2, p[0]) ? 2 : 1]);
            }
            if (enc.proba.useSkipProba) bw.putBit(enc.mbSkip[mb], enc.proba.skipProba);
            if (bw.putBit(enc.mbType[mb] !== 0, 145)) {
                const mode = enc.preds[preds];
                if (bw.putBit(mode === TM_PRED || mode === H_PRED, 156)) bw.putBit(mode === TM_PRED, 128);
                else bw.putBit(mode === V_PRED, 163);
            } else {
                for (let y = 0; y < 4; y++) {
                    let left = enc.preds[preds + y * w - 1];
                    for (let x = 0; x < 4; x++) {
                        const top = enc.preds[preds + (y - 1) * w + x], mode = enc.preds[preds + y * w + x];
                        putI4Mode(bw, mode, (top * 10 + left) * 9);
                        left = mode;
                    }
                }
            }
            const uv = enc.mbUvMode[mb];
            if (bw.putBit(uv !== 0, 142)) {
                if (bw.putBit(uv !== V_PRED, 114)) bw.putBit(uv !== H_PRED, 183);
            }
        }
    }
}

function partition0(enc: Encoder): Uint8Array {
    const bw = new BitWriter();
    bw.putBitUniform(0); // color space
    bw.putBitUniform(0); // clamping type
    // segments: absolute quantizers and filter strengths, the map's probabilities
    if (bw.putBitUniform(enc.numSegments > 1)) {
        bw.putBitUniform(enc.updateMap);
        bw.putBitUniform(1);
        bw.putBitUniform(1);
        for (let s = 0; s < NUM_MB_SEGMENTS; s++) bw.putSignedBits(enc.dqm[s].quant, 7);
        for (let s = 0; s < NUM_MB_SEGMENTS; s++) bw.putSignedBits(enc.dqm[s].fstrength, 6);
        if (enc.updateMap) {
            for (let s = 0; s < 3; s++) if (bw.putBitUniform(enc.proba.segments[s] !== 255)) bw.putBits(enc.proba.segments[s], 8);
        }
    }
    // the loop filter (no mode deltas)
    bw.putBitUniform(enc.filterSimple);
    bw.putBits(enc.filterLevel, 6);
    bw.putBits(enc.filterSharpness, 3);
    bw.putBitUniform(0);
    bw.putBits(0, 2); // 1 token partition
    bw.putBits(enc.baseQuant, 7);
    bw.putSignedBits(0, 4);
    bw.putSignedBits(0, 4);
    bw.putSignedBits(0, 4);
    bw.putSignedBits(enc.dqUvDc, 4);
    bw.putSignedBits(enc.dqUvAc, 4);
    bw.putBitUniform(0); // no probability refresh
    for (let i = 0; i < enc.proba.coeffs.length; i++) {
        const p = enc.proba.coeffs[i];
        if (bw.putBit(p !== DEFAULT_COEFF_PROBS[i], COEFF_UPDATE_PROBS[i])) bw.putBits(p, 8);
    }
    if (bw.putBitUniform(enc.proba.useSkipProba)) bw.putBits(enc.proba.skipProba, 8);
    codeIntraModes(enc, bw);
    return bw.finish();
}

// ---- alpha (alpha_enc.c): losslessly compressed, predicted by the filter that seems best, its levels reduced below
// quality 100

// reduces the alpha values to as many levels (quant_levels_utils.c's QuantizeLevels): k-means from uniformly spread
// levels, the lowest and highest values staying
function quantizeLevels(a: Uint8Array, levels: number): void {
    const freq = new Int32Array(256), qLevel = new Int32Array(256), invQLevel = new Float64Array(256);
    let minS = 255, maxS = 0, levelsIn = 0;
    for (let n = 0; n < a.length; n++) {
        const v = a[n];
        if (!freq[v]) levelsIn++;
        if (v < minS) minS = v;
        if (v > maxS) maxS = v;
        freq[v]++;
    }
    if (levelsIn <= levels) return;

    for (let i = 0; i < levels; i++) invQLevel[i] = minS + (maxS - minS) * i / (levels - 1);
    qLevel[maxS] = levels - 1;

    const threshold = 1e-4 * a.length;
    const qSum = new Float64Array(256), qCount = new Float64Array(256);
    let lastErr = 1e38;
    for (let iter = 0; iter < 6; iter++) {
        qSum.fill(0);
        qCount.fill(0);
        for (let s = minS, slot = 0; s <= maxS; s++) {
            while (slot < levels - 1 && 2 * s > invQLevel[slot] + invQLevel[slot + 1]) slot++;
            if (freq[s] > 0) {
                qSum[slot] += s * freq[s];
                qCount[slot] += freq[s];
            }
            qLevel[s] = slot;
        }
        for (let slot = 1; slot < levels - 1; slot++) if (qCount[slot] > 0) invQLevel[slot] = qSum[slot] / qCount[slot];

        let err = 0;
        for (let s = minS; s <= maxS; s++) {
            const e = s - invQLevel[qLevel[s]];
            err += freq[s] * e * e;
        }
        if (lastErr - err < threshold) break;
        lastErr = err;
    }

    const map = new Uint8Array(256);
    for (let s = minS; s <= maxS; s++) map[s] = Math.trunc(invQLevel[qLevel[s]] + 0.5);
    for (let n = 0; n < a.length; n++) a[n] = map[a[n]];
}

// predicts each sample (filter 1: from the left one, 2: from the one above, 3: from the gradient), the residues
function filterAlpha(a: Uint8Array, width: number, height: number, filter: number): Uint8Array {
    const out = new Uint8Array(a.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            let pred: number;
            if (x === 0 && y === 0) pred = 0;
            else if (y === 0) pred = a[i - 1];
            else if (x === 0) pred = a[i - width];
            else if (filter === 1) pred = a[i - 1];
            else if (filter === 2) pred = a[i - width];
            else pred = clip(a[i - 1] + a[i - width] - a[i - width - 1], 0, 255);
            out[i] = (a[i] - pred) & 255;
        }
    }
    return out;
}

// the filter whose residues spread least (on every other sample)
function estimateBestFilter(a: Uint8Array, width: number, height: number): number {
    const bins = [new Uint8Array(16), new Uint8Array(16), new Uint8Array(16), new Uint8Array(16)];
    for (let j = 2; j < height - 1; j += 2) {
        const p = j * width;
        let mean = a[p];
        for (let i = 2; i < width - 1; i += 2) {
            const v = a[p + i];
            bins[0][Math.abs(v - mean) >> 4] = 1;
            bins[1][Math.abs(v - a[p + i - 1]) >> 4] = 1;
            bins[2][Math.abs(v - a[p + i - width]) >> 4] = 1;
            bins[3][Math.abs(v - clip(a[p + i - 1] + a[p + i - width] - a[p + i - width - 1], 0, 255)) >> 4] = 1;
            mean = (3 * mean + v + 2) >> 2;
        }
    }
    let best = 0, bestScore = 0x7fffffff;
    for (let f = 0; f < 4; f++) {
        let score = 0;
        for (let i = 0; i < 16; i++) if (bins[f][i]) score += i;
        if (score < bestScore) {
            bestScore = score;
            best = f;
        }
    }
    return best;
}

/**
 * The ALPH chunk's payload: the alpha plane, losslessly compressed (or not, if that's smaller), with fewer levels below
 * quality 100 (libwebp's alpha_quality: 2-16 levels up to 70, 16-256 above)
 */
export function encodeAlpha(a: Uint8Array, width: number, height: number, method = 4, quality = 100): Uint8Array {
    const reduce = quality < 100;
    if (reduce) {
        a = a.slice();
        quantizeLevels(a, quality <= 70 ? 2 + Math.trunc(quality / 5) : 16 + (quality - 70) * 8);
    }
    let colors = 0;
    const seen = new Uint8Array(256);
    for (let i = 0; i < a.length; i++) if (!seen[a[i]]) { seen[a[i]] = 1; colors++; }
    // (no filter is tried too for many colors, and by the slower methods)
    const filters = new Set([colors <= 16 ? 0 : estimateBestFilter(a, width, height)]);
    if (method > 3 || colors > 192) filters.add(0);
    let best: Uint8Array | null = null;
    for (const filter of [...filters].sort()) {
        const data = filter ? filterAlpha(a, width, height, filter) : a;
        const argb = new Uint32Array(a.length);
        for (let i = 0; i < a.length; i++) argb[i] = data[i] << 8;
        // (the VP8L stream after its 5 byte header)
        let stream = vp8l.encode(argb, width, height).subarray(5), method = 1;
        if (stream.length > a.length) {
            stream = data;
            method = 0;
        }
        const out = new Uint8Array(1 + stream.length);
        // (and whether the levels were reduced: decoders may smooth them)
        out[0] = method | filter << 2 | (reduce ? 1 << 4 : 0);
        out.set(stream, 1);
        if (!best || out.length < best.length) best = out;
    }
    return best as Uint8Array;
}

/**
 * Encodes a YUV 4:2:0 picture into a VP8 key frame like libwebp does with its default settings (quality 0-100) and a
 * method (0-6, faster to smaller)
 * @returns the VP8 chunk's payload
 */
export function encodeVP8(pic: YUVPicture, quality: number, method = 4): Uint8Array {
    levelFixedCosts ??= words(LEVEL_FIXED_COSTS);
    fixedCostsI4 ??= words(FIXED_COSTS_I4);
    const enc = new Encoder(pic, quality, method);
    analyze(enc);
    // methods 3 and up record the tokens to code them once their probabilities are known
    if (enc.rdOpt >= RD_OPT_BASIC) tokenLoop(enc);
    else encodeLoop(enc);
    const p0 = partition0(enc), tokens = enc.parts.finish();

    const out = new Uint8Array(10 + p0.length + tokens.length);
    // key frame, profile 0 (the normal loop filter), shown, the size of partition 0
    const bits = 0 | 0 << 1 | 1 << 4 | p0.length << 5;
    out[0] = bits & 255;
    out[1] = bits >> 8 & 255;
    out[2] = bits >> 16 & 255;
    out.set([0x9d, 0x01, 0x2a, pic.width & 255, pic.width >> 8, pic.height & 255, pic.height >> 8], 3);
    out.set(p0, 10);
    out.set(tokens, 10 + p0.length);
    return out;
}
