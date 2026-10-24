/*!
 * JPEG XL's VarDCT: the quantizer and block contexts, LF coefficients, HF metadata (varblock types, multipliers,
 * chroma from luma, EPF sigmas), coefficient orders, HF coefficients, dequantization, chroma from luma, adaptive LF
 * smoothing and the varblocks' inverse transforms; ported from jxl-oxide (crates/jxl-vardct, crates/jxl-frame/src/data,
 * crates/jxl-render/src/vardct). Copyright (c) Wonwoo Choi, MIT License (see THIRD_PARTY_NOTICES.md)
 */
import { BitReader, unpackSigned } from './bits.ts';
import { EntropyDecoder, readClusters, readPermutation } from './entropy.ts';
import { ModularImage, MAConfig, channel, decodeModular } from './modular.ts';
import { FrameHeader, FLAG_SKIP_ADAPTIVE_LF_SMOOTHING } from './frame-header.ts';
import { readDequantMatrices, DequantMatrices, MATRIX_INDEX } from './quant.ts';
import { Block, dct2d, inverseTransform, scaleF } from './dct.ts';

interface BlockContext {
    qfThresholds: number[];
    lfThresholds: number[][];
    ctxMap: Uint8Array;
    numClusters: number;
}

/** The VarDCT parts of LfGlobal */
export interface VarDCTGlobal {
    globalScale: number;
    quantLf: number;
    ctx: BlockContext;
    colourFactor: number;
    baseX: number;
    baseB: number;
    xFactorLf: number;
    bFactorLf: number;
}

const DEFAULT_CTX_MAP = Uint8Array.of(0, 1, 2, 2, 3, 3, 4, 5, 6, 6, 6, 6, 6, 7, 8, 9, 9, 10, 11, 12, 13, 14, 14, 14, 14, 14, 7, 8, 9, 9, 10, 11, 12, 13, 14, 14, 14, 14, 14);

export function readVarDCTGlobal(r: BitReader): VarDCTGlobal {
    const globalScale = r.u32([1, 11], [2049, 11], [4097, 12], [8193, 16]), quantLf = r.u32(16, [1, 5], [1, 8], [1, 16]);
    let ctx: BlockContext;
    if (r.bool()) ctx = { qfThresholds: [], lfThresholds: [[], [], []], ctxMap: DEFAULT_CTX_MAP, numClusters: 15 };
    else {
        let size = 1;
        const lfThresholds: number[][] = [];
        for (let c = 0; c < 3; c++) {
            const n = r.bits(4), t: number[] = [];
            size *= n + 1;
            for (let i = 0; i < n; i++) t.push(unpackSigned(r.u32([0, 4], [16, 8], [272, 16], [65808, 32])));
            lfThresholds.push(t);
        }
        const nq = r.bits(4), qfThresholds: number[] = [];
        size *= nq + 1;
        for (let i = 0; i < nq; i++) qfThresholds.push(1 + r.u32([0, 2], [4, 3], [12, 5], [44, 8]));
        if (size > 64) throw new Error('JPEG XL: too many block contexts');
        const [numClusters, ctxMap] = readClusters(r, size * 39);
        if (numClusters > 16) throw new Error('JPEG XL: too many block context clusters');
        ctx = { qfThresholds, lfThresholds, ctxMap, numClusters };
    }
    let colourFactor = 84, baseX = 0, baseB = 1, xFactorLf = 128, bFactorLf = 128;
    if (!r.bool()) {
        colourFactor = r.u32(84, 256, [2, 8], [258, 16]);
        baseX = r.f16();
        baseB = r.f16();
        xFactorLf = r.bits(8);
        bFactorLf = r.bits(8);
    }
    return { globalScale, quantLf, ctx, colourFactor, baseX, baseB, xFactorLf, bFactorLf };
}

// the size of varblock types in 8x8 blocks: [width, height]
const SIZES = [
    1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 4, 4, 1, 2, 2, 1, 1, 4, 4, 1, 2, 4, 4, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 8, 8, 4, 8, 8, 4,
    16, 16, 8, 16, 16, 8, 32, 32, 16, 32, 32, 16
];
// the coefficient orders of each type
const ORDER_ID = [0, 1, 1, 1, 2, 3, 4, 4, 5, 5, 6, 6, 1, 1, 1, 1, 1, 1, 7, 8, 8, 9, 10, 10, 11, 12, 12];
const ORDER_SIZES = [[8, 8], [8, 8], [16, 16], [32, 32], [16, 8], [32, 8], [32, 16], [64, 64], [64, 32], [128, 128], [128, 64], [256, 256], [256, 128]];
// (the 8x8 transforms other than the DCT, whose LF is a single coefficient)
const special = (t: number): boolean => (t >= 1 && t <= 3) || (t >= 12 && t <= 17);
// (types whose coefficients are transposed: the DCTs at least as high as wide)
const transposed = (t: number): boolean => !special(t) && SIZES[2 * t + 1] >= SIZES[2 * t];
const single = (t: number): boolean => t === 0 || special(t);

const naturalOrders = new Map<number, Uint16Array>();

/** The natural order of an order's coefficients: x, y pairs (in its wide orientation) */
function naturalOrder(id: number): Uint16Array {
    let o = naturalOrders.get(id);
    if (o) return o;
    const [bw, bh] = ORDER_SIZES[id], yScale = bw / bh, lbw = bw / 8, lbh = bh / 8;
    o = new Uint16Array(2 * bw * bh);
    let i = 0;
    for (; i < lbw * lbh; i++) {
        o[2 * i] = i % lbw;
        o[2 * i + 1] = Math.floor(i / lbw);
    }
    for (let dist = 1; dist < 2 * bw; dist++) {
        const margin = Math.max(dist - bw, 0);
        for (let order = margin; order < dist - margin; order++) {
            const x = dist % 2 ? order : dist - 1 - order, y = dist % 2 ? dist - 1 - order : order;
            if (x < lbw && y < lbw) continue;
            if (y % yScale) continue;
            o[2 * i] = x;
            o[2 * i + 1] = y / yScale;
            i++;
        }
    }
    naturalOrders.set(id, o);
    return o;
}

interface HfPass {
    /** per order and channel (X, Y, B): the coefficients' x, y pairs */
    orders: Uint16Array[][];
    dist: EntropyDecoder;
}

const ceilLog2 = (x: number): number => x <= 1 ? 0 : 32 - Math.clz32(x - 1);

// the shifts of the (X, Y, B) channels by the frame's chroma subsampling
function chromaShifts(up: number[]): { h: number[], v: number[], anyH: boolean, anyV: boolean } {
    const anyH = up.some(u => u === 1 || u === 2), anyV = up.some(u => u === 1 || u === 3);
    return { h: up.map(u => anyH && (u === 0 || u === 3) ? 1 : 0), v: up.map(u => anyV && (u === 0 || u === 2) ? 1 : 0), anyH, anyV };
}

/** The VarDCT state of a frame: what its LF groups, HfGlobal and pass groups give, then the rendered XYB */
export class VarDCT {
    /** the frame's size in blocks (even if chroma is subsampled) */
    readonly bw: number;
    readonly bh: number;
    /** the chroma subsampling shifts of X, Y, B */
    readonly hs: number[];
    readonly vs: number[];
    private readonly subsampled: boolean;
    /** per block: the varblock type of top left blocks (-1 elsewhere), multipliers, EPF sigmas */
    private readonly type: Int8Array;
    private readonly hfMul: Int32Array;
    readonly sigma: Float32Array;
    private readonly xFromY: Int32Array;
    private readonly bFromY: Int32Array;
    private readonly tilesPerRow: number;
    /** the quantized and dequantized LF (X, Y, B), per block */
    private readonly lfQuant: Int32Array[];
    private readonly lf: Float32Array[];
    private readonly coeffs: Int32Array[];
    private matrices: DequantMatrices | null = null;
    private numPresets = 1;
    private passes: HfPass[] = [];
    private hasLfQuant = false;

    constructor(private readonly f: FrameHeader, private readonly g: VarDCTGlobal, private readonly lfDequant: number[], private readonly bitDepth: number) {
        const s = chromaShifts(f.jpegUpsampling);
        this.hs = s.h;
        this.vs = s.v;
        this.subsampled = s.anyH || s.anyV;
        let bw = Math.ceil(f.sampleWidth / 8), bh = Math.ceil(f.sampleHeight / 8);
        if (s.anyH) bw = Math.ceil(bw / 2) * 2;
        if (s.anyV) bh = Math.ceil(bh / 2) * 2;
        this.bw = bw;
        this.bh = bh;
        this.type = new Int8Array(bw * bh).fill(-2);
        this.hfMul = new Int32Array(bw * bh);
        this.sigma = new Float32Array(bw * bh);
        this.tilesPerRow = Math.ceil(bw / 8);
        this.xFromY = new Int32Array(this.tilesPerRow * Math.ceil(bh / 8));
        this.bFromY = new Int32Array(this.tilesPerRow * Math.ceil(bh / 8));
        this.lfQuant = [0, 1, 2].map(c => new Int32Array((bw >> this.hs[c]) * (bh >> this.vs[c])));
        this.lf = [0, 1, 2].map(c => new Float32Array((bw >> this.hs[c]) * (bh >> this.vs[c])));
        this.coeffs = [0, 1, 2].map(c => new Int32Array((bw >> this.hs[c]) * (bh >> this.vs[c]) * 64));
    }

    // the blocks of LF group g: [x0, y0, width, height] (in blocks)
    private lfGroupBlocks(g: number): number[] {
        const dim = this.f.groupDim, x0 = (g % this.f.lfGroupsPerRow) * dim, y0 = Math.floor(g / this.f.lfGroupsPerRow) * dim;
        let w = Math.ceil(Math.min(dim * 8, this.f.sampleWidth - x0 * 8) / 8), h = Math.ceil(Math.min(dim * 8, this.f.sampleHeight - y0 * 8) / 8);
        if (this.subsampled) {
            if (this.hs.some(Boolean)) w = Math.ceil(w / 2) * 2;
            if (this.vs.some(Boolean)) h = Math.ceil(h / 2) * 2;
        }
        return [x0, y0, w, h];
    }

    /** the LF coefficients of LF group g */
    readLfCoefficients(r: BitReader, g: number, tree: MAConfig | null): void {
        const extraPrecision = r.bits(2);
        const [x0, y0, w, h] = this.lfGroupBlocks(g);
        const size = (c: number): [number, number] => [this.hs[c] ? Math.ceil(w / 2) : w, this.vs[c] ? Math.ceil(h / 2) : h];
        // (Y, X, B)
        const order = [1, 0, 2];
        const image = new ModularImage(order.map(c => channel(...size(c), this.hs[c], this.vs[c])), this.bitDepth);
        decodeModular(r, image, 1 + g, tree, Infinity, true);
        const scale = 2 ** (9 - extraPrecision) / (this.g.globalScale * this.g.quantLf);
        order.forEach((c, i) => {
            const src = image.channels[i], q = this.lfQuant[c], lf = this.lf[c], stride = this.bw >> this.hs[c];
            const ox = x0 >> this.hs[c], oy = y0 >> this.vs[c], m = this.lfDequant[c] * scale;
            for (let y = 0; y < src.h; y++) {
                for (let x = 0; x < src.w; x++) {
                    const v = src.data[y * src.w + x];
                    q[(oy + y) * stride + ox + x] = v;
                    lf[(oy + y) * stride + ox + x] = v * m;
                }
            }
        });
        this.hasLfQuant = true;
    }

    /** the HF metadata of LF group g */
    readHfMetadata(r: BitReader, g: number, tree: MAConfig | null): void {
        const [x0, y0, w, h] = this.lfGroupBlocks(g);
        const nbBlocks = 1 + r.bits(ceilLog2(w * h));
        const tw = Math.ceil(w / 8), th = Math.ceil(h / 8);
        const image = new ModularImage([channel(tw, th), channel(tw, th), channel(nbBlocks, 2), channel(w, h)], this.bitDepth);
        decodeModular(r, image, 1 + 2 * this.f.numLfGroups + g, tree, Infinity, true);
        const [xFromY, bFromY, info, sharpness] = image.channels;
        for (let y = 0; y < th; y++) {
            for (let x = 0; x < tw; x++) {
                const i = (y0 / 8 + y) * this.tilesPerRow + x0 / 8 + x;
                this.xFromY[i] = xFromY.data[y * tw + x];
                this.bFromY[i] = bFromY.data[y * tw + x];
            }
        }
        const epf = this.f.epf, sigmaBase = epf ? epf.quantMul * 65536 / this.g.globalScale : 0;
        const bw = this.bw;
        let k = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (this.type[(y0 + y) * bw + x0 + x] !== -2) continue;
                if (k >= nbBlocks) throw new Error('JPEG XL: the varblocks don\'t fill the LF group');
                const type = info.data[k], mul = info.data[nbBlocks + k] + 1;
                k++;
                if (type < 0 || type > 26) throw new Error('JPEG XL: invalid varblock type');
                if (mul <= 0) throw new Error('JPEG XL: invalid HF multiplier');
                const dw = SIZES[2 * type], dh = SIZES[2 * type + 1];
                if ((x % 32) + dw > 32 || (y % 32) + dh > 32) throw new Error('JPEG XL: a varblock across groups');
                if (x + dw > w || y + dh > h) throw new Error('JPEG XL: a varblock beyond its LF group');
                for (let dy = 0; dy < dh; dy++) {
                    for (let dx = 0; dx < dw; dx++) {
                        const i = (y0 + y + dy) * bw + x0 + x + dx;
                        if (this.type[i] !== -2) throw new Error('JPEG XL: overlapping varblocks');
                        this.type[i] = dx || dy ? -1 : type;
                        if (epf) {
                            const s = sharpness.data[(y + dy) * w + x + dx];
                            if (s < 0 || s > 7) throw new Error('JPEG XL: invalid EPF sharpness');
                            this.sigma[i] = sigmaBase / mul * epf.sharpLut[s];
                        }
                    }
                }
                this.hfMul[(y0 + y) * bw + x0 + x] = mul;
            }
        }
    }

    /** HfGlobal: the dequantization matrices, the HF presets and passes (their orders and distributions) */
    readHfGlobal(r: BitReader, tree: MAConfig | null): void {
        this.matrices = readDequantMatrices(r, this.bitDepth, 1 + 3 * this.f.numLfGroups, tree);
        this.numPresets = r.bits(ceilLog2(this.f.numGroups)) + 1;
        for (let p = 0; p < this.f.numPasses; p++) {
            let used = r.u32(0x5f, 0x13, 0, [0, 13]);
            const orders: Uint16Array[][] = [];
            const dec = used ? new EntropyDecoder(r, 8) : null;
            dec?.begin(r);
            for (let id = 0; id < 13; id++, used >>= 1) {
                const natural = naturalOrder(id);
                if (!(used & 1) || !dec) {
                    orders.push([natural, natural, natural]);
                    continue;
                }
                const [bw, bh] = ORDER_SIZES[id], size = bw * bh;
                const perChannel: Uint16Array[] = [];
                for (let c = 0; c < 3; c++) {
                    const perm = readPermutation(r, dec, size, size / 64), o = new Uint16Array(2 * size);
                    perm.forEach((v, i) => {
                        o[2 * i] = natural[2 * v];
                        o[2 * i + 1] = natural[2 * v + 1];
                    });
                    perChannel.push(o);
                }
                orders.push(perChannel);
            }
            dec?.finish();
            this.passes.push({ orders, dist: new EntropyDecoder(r, 495 * this.numPresets * this.g.ctx.numClusters) });
        }
    }

    /** the HF coefficients of a pass group */
    readPassGroup(r: BitReader, pass: number, group: number): void {
        const f = this.f, ctx = this.g.ctx, hp = this.passes[pass];
        const gdim = f.groupDim / 8, bx0 = (group % f.groupsPerRow) * gdim, by0 = Math.floor(group / f.groupsPerRow) * gdim;
        const width = Math.min(gdim, this.bw - bx0), height = Math.min(gdim, this.bh - by0);
        const shift = f.passShift[pass] ?? 0;
        const hfp = r.bits(ceilLog2(this.numPresets));
        if (hfp >= this.numPresets) throw new Error('JPEG XL: invalid HF preset');
        const nc = ctx.numClusters, ctxSize = 495 * nc;
        const dist = hp.dist.fork(), clusters = dist.clusters.subarray(ctxSize * hfp, ctxSize * (hfp + 1));
        dist.begin(r);
        const lfMul = (ctx.lfThresholds[0].length + 1) * (ctx.lfThresholds[1].length + 1) * (ctx.lfThresholds[2].length + 1);
        const hfMul = ctx.qfThresholds.length + 1;
        const hs = this.hs, vs = this.vs, bw = this.bw;
        // the non-zero counts of the blocks above (and left), per channel
        const nonZeros = [0, 1, 2].map(c => new Uint32Array(hs[c] ? Math.ceil(width / 2) : width));
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const bi = (by0 + y) * bw + bx0 + x, type = this.type[bi];
                if (type < 0) continue;
                const qf = this.hfMul[bi];
                const w8 = SIZES[2 * type], h8 = SIZES[2 * type + 1], numBlocks = w8 * h8, numBlocksLog = 31 - Math.clz32(numBlocks);
                const orderId = ORDER_ID[type];
                let lfIdx = 0;
                if (this.hasLfQuant) {
                    for (const c of [0, 2, 1]) {
                        const t = ctx.lfThresholds[c];
                        lfIdx *= t.length + 1;
                        const q = this.lfQuant[c][((by0 + y) >> vs[c]) * (bw >> hs[c]) + ((bx0 + x) >> hs[c])];
                        for (const th of t) if (q > th) lfIdx++;
                    }
                }
                let hfIdx = 0;
                for (const th of ctx.qfThresholds) if (qf > th) hfIdx++;
                for (let k = 0; k < 3; k++) {
                    const c = [1, 0, 2][k];
                    const sx = x >> hs[c], sy = y >> vs[c];
                    if (hs[c] || vs[c]) {
                        if (sx << hs[c] !== x || sy << vs[c] !== y) continue;
                        if (this.type[(by0 + sy) * bw + bx0 + sx] < 0) continue;
                    }
                    const blockCtx = ctx.ctxMap[((k * 13 + orderId) * hfMul + hfIdx) * lfMul + lfIdx];
                    const nz = nonZeros[c];
                    const predicted = sy === 0 ? (sx === 0 ? 32 : nz[sx - 1]) : sx === 0 ? nz[sx] : (nz[sx] + nz[sx - 1] + 1) >> 1;
                    const nzCtx = blockCtx + (predicted >= 8 ? 4 + (predicted >> 1) : predicted) * nc;
                    let count = dist.readClustered(r, clusters[nzCtx]);
                    if (count > 63 << numBlocksLog) throw new Error('JPEG XL: too many non-zero coefficients');
                    const value = (count + numBlocks - 1) >> numBlocksLog;
                    for (let dx = 0; dx < w8; dx++) nz[sx + dx] = value;
                    if (!count) continue;
                    const out = this.coeffs[c], stride = (bw >> hs[c]) * 8;
                    const base = (((by0 >> vs[c]) + sy) * 8) * stride + ((bx0 >> hs[c]) + sx) * 8;
                    const order = hp.orders[orderId][c], tr = transposed(type);
                    let prevNonZero = count <= numBlocks * 4 ? 1 : 0;
                    const ctxBase = blockCtx * 458 + 37 * nc, n = order.length / 2;
                    for (let i = numBlocks; i < n; i++) {
                        const cctx = (NUM_NONZERO_CONTEXT[(count - 1) >> numBlocksLog] + FREQ_CONTEXT[(i - numBlocks) >> numBlocksLog]) * 2 + prevNonZero;
                        if (cctx >= 458) throw new Error('JPEG XL: too many zero coefficients');
                        const u = dist.readClustered(r, clusters[ctxBase + cctx]);
                        if (u === 0) {
                            prevNonZero = 0;
                            continue;
                        }
                        let dx = order[2 * i], dy = order[2 * i + 1];
                        if (tr) [dx, dy] = [dy, dx];
                        out[base + dy * stride + dx] += unpackSigned(u) * 2 ** shift;
                        prevNonZero = 1;
                        if (--count === 0) break;
                    }
                }
            }
        }
        dist.finish();
    }

    /** the XYB planes (of the color sample size); lfFrame: the LF from an LF frame */
    render(quantBias: number[], quantBiasNumerator: number, lfFrame: Float32Array[] | null): Float32Array[] {
        const f = this.f, g = this.g, bw = this.bw, bh = this.bh, hs = this.hs, vs = this.vs;
        let lf = this.lf;
        if (lfFrame) lf = lfFrame;
        else {
            if (!this.subsampled) {
                const kx = g.baseX + (g.xFactorLf - 128) / g.colourFactor, kb = g.baseB + (g.bFactorLf - 128) / g.colourFactor;
                const [x, y, b] = lf;
                for (let i = 0; i < y.length; i++) {
                    x[i] += kx * y[i];
                    b[i] += kb * y[i];
                }
            }
            if (!(f.flags & FLAG_SKIP_ADAPTIVE_LF_SMOOTHING)) {
                const sc = 512 / (g.globalScale * g.quantLf);
                lf = smoothLf(lf, [0, 1, 2].map(c => bw >> hs[c]), [0, 1, 2].map(c => bh >> vs[c]), this.lfDequant.map(m => m * sc), hs, vs);
            }
        }
        // dequantization
        const m = this.matrices as DequantMatrices;
        const qmScale = [0.8 ** (f.xqmScale - 2), 1, 0.8 ** (f.bqmScale - 2)];
        const planes = [0, 1, 2].map(c => new Float32Array(this.coeffs[c].length));
        for (let c = 0; c < 3; c++) {
            const q = this.coeffs[c], out = planes[c], stride = (bw >> hs[c]) * 8, bias = quantBias[c];
            this.forEachVarblock(c, (sbx, sby, type, mul) => {
                const w = SIZES[2 * type] * 8, h = SIZES[2 * type + 1] * 8, idx = MATRIX_INDEX[type];
                const matrix = transposed(type) ? m.transposed[idx][c] : m.matrices[idx][c];
                const k = 65536 / (g.globalScale * mul) * qmScale[c];
                for (let y = 0; y < h; y++) {
                    const o = (sby * 8 + y) * stride + sbx * 8;
                    for (let x = 0; x < w; x++) {
                        let v = q[o + x];
                        if (v === 0) continue;
                        v = Math.abs(v) <= 1 ? v * bias : v - quantBiasNumerator / v;
                        out[o + x] = v * matrix[y * w + x] * k;
                    }
                }
            });
        }
        // chroma from luma, per 64x64 tile
        if (!this.subsampled) {
            const [x, y, b] = planes, stride = bw * 8;
            for (let py = 0; py < bh * 8; py++) {
                for (let tx = 0; tx < this.tilesPerRow; tx++) {
                    const t = (py >> 6) * this.tilesPerRow + tx;
                    const kx = g.baseX + this.xFromY[t] / g.colourFactor, kb = g.baseB + this.bFromY[t] / g.colourFactor;
                    const end = Math.min(tx * 64 + 64, stride);
                    for (let px = tx * 64, i = py * stride + px; px < end; px++, i++) {
                        x[i] += kx * y[i];
                        b[i] += kb * y[i];
                    }
                }
            }
        }
        // the transforms, with the LF
        for (let c = 0; c < 3; c++) {
            const out = planes[c], stride = (bw >> hs[c]) * 8, lfc = lf[c], lfStride = bw >> hs[c];
            this.forEachVarblock(c, (sbx, sby, type) => {
                const w8 = SIZES[2 * type], h8 = SIZES[2 * type + 1];
                const llf: Block = { buf: out, offset: sby * 8 * stride + sbx * 8, stride, w: w8, h: h8 };
                if (single(type)) out[llf.offset] = lfc[sby * lfStride + sbx];
                else {
                    for (let y = 0; y < h8; y++) for (let x = 0; x < w8; x++) out[llf.offset + y * stride + x] = lfc[(sby + y) * lfStride + sbx + x];
                    dct2d(llf, false);
                    const lw = 31 - Math.clz32(w8), lh = 31 - Math.clz32(h8);
                    for (let y = 0; y < h8; y++) for (let x = 0; x < w8; x++) out[llf.offset + y * stride + x] /= scaleF(y, 5 - lh) * scaleF(x, 5 - lw);
                }
                inverseTransform({ buf: out, offset: llf.offset, stride, w: w8 * 8, h: h8 * 8 }, type);
            });
        }
        return planes;
    }

    /** the planes' stride (the width of channel c) */
    stride(c: number): number {
        return (this.bw >> this.hs[c]) * 8;
    }

    // calls fn with the varblocks of channel c (at their block coordinates in the channel)
    private forEachVarblock(c: number, fn: (sbx: number, sby: number, type: number, mul: number) => void): void {
        const bw = this.bw, hs = this.hs[c], vs = this.vs[c], gdim = this.f.groupDim / 8;
        for (let by = 0; by < this.bh; by++) {
            for (let bx = 0; bx < bw; bx++) {
                const type = this.type[by * bw + bx];
                if (type < 0) continue;
                if (hs || vs) {
                    // (subsampled: the blocks at even positions in a group, where the group's shifted block is one too)
                    const gx = bx - bx % gdim, gy = by - by % gdim, lx = bx - gx, ly = by - gy;
                    if ((lx >> hs) << hs !== lx || (ly >> vs) << vs !== ly) continue;
                    if (this.type[(gy + (ly >> vs)) * bw + gx + (lx >> hs)] < 0) continue;
                }
                fn(bx >> hs, by >> vs, type, this.hfMul[by * bw + bx]);
            }
        }
    }
}

const FREQ_CONTEXT = Uint8Array.of(
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 23, 23,
    24, 24, 24, 24, 25, 25, 25, 25, 26, 26, 26, 26, 27, 27, 27, 27, 28, 28, 28, 28, 29, 29, 29, 29, 30, 30, 30, 30
);
const NUM_NONZERO_CONTEXT = Uint8Array.of(
    0, 31, 62, 62, 93, 93, 93, 93, 123, 123, 123, 123, 152, 152, 152, 152, 152, 152, 152, 152, 180, 180, 180, 180, 180, 180, 180, 180,
    180, 180, 180, 180, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206,
    206, 206, 206, 206, 206, 206, 206, 206, 206
);

const W_SELF = 0.052262735, W_SIDE = 0.2034514, W_DIAG = 0.03348292;

// adaptive LF smoothing: weighted averages where the LF is smooth enough (by its quantization); w, h, shifts per channel
function smoothLf(lf: Float32Array[], w: number[], h: number[], factors: number[], hs: number[], vs: number[]): Float32Array[] {
    const subsampled = hs.some(Boolean) || vs.some(Boolean);
    const W = Math.max(...w), H = Math.max(...h);
    if (W <= 2 || H <= 2 || w.some(v => v <= 2) || h.some(v => v <= 2)) return lf;
    const out = lf.map(c => c.slice());
    // the weighted averages of the interior
    const wa = lf.map((src, c) => {
        const cw = w[c], a = new Float32Array(cw * h[c]);
        for (let y = 1; y < h[c] - 1; y++) {
            for (let x = 1; x < cw - 1; x++) {
                const i = y * cw + x;
                a[i] = src[i] * W_SELF + (src[i - 1] + src[i + 1] + src[i - cw] + src[i + cw]) * W_SIDE + (src[i - cw - 1] + src[i - cw + 1] + src[i + cw - 1] + src[i + cw + 1]) * W_DIAG;
            }
        }
        return a;
    });
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const cx = [0, 1, 2].map(c => x >> hs[c]), cy = [0, 1, 2].map(c => y >> vs[c]);
            if (subsampled && [0, 1, 2].some(c => cx[c] === 0 || cx[c] === w[c] - 1 || cy[c] === 0 || cy[c] === h[c] - 1)) continue;
            let gap = 0.5;
            for (let c = 0; c < 3; c++) {
                const i = cy[c] * w[c] + cx[c];
                gap = Math.max(gap, Math.abs(wa[c][i] - lf[c][i]) / factors[c]);
            }
            const scale = Math.max(3 - 4 * gap, 0);
            for (let c = 0; c < 3; c++) {
                if (subsampled && ((cy[c] << vs[c]) !== y || (cx[c] << hs[c]) !== x)) continue;
                const i = cy[c] * w[c] + cx[c];
                out[c][i] = (wa[c][i] - lf[c][i]) * scale + lf[c][i];
            }
        }
    }
    return out;
}
