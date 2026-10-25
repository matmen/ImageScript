/*!
 * Encodes AV1 still pictures (intra frames with reduced still picture headers): the syntax and contexts mirror the
 * decoder's (decode.ts, ported from dav1d: Copyright (c) 2018-2021, VideoLAN and dav1d authors, Copyright (c) 2018, Two
 * Orioles, LLC, BSD-2-Clause License), the reconstruction uses its predictors and inverse transforms, so the encoder's
 * reconstruction is the decoder's output. Partitions (none or split, 64x64 to 8x8), intra modes and transform types
 * are chosen by rate and distortion, coefficients quantized by rate and distortion, the loop filter level (around
 * libaom's guess from the quantizer: Copyright (c) 2016, Alliance for Open Media, BSD-2-Clause License) and the CDEF
 * strengths by the filtered frame's distortion. See THIRD_PARTY_NOTICES.md
 */
import { SymbolEncoder } from './msac-enc.ts';
import { SequenceHeader, FrameHeader, RESTORATION_NONE } from './obu.ts';
import { HeaderWriter, obu, writeSequenceHeader, writeFrameHeader, OBU_FRAME } from './obu-enc.ts';
import { Frame } from './decode.ts';
import {
    CDF, BLOCK_DIMENSIONS, TXFM_DIMENSIONS, MAX_TXFM_SIZE_FOR_BS, AL_PART_CTX, BLOCK_SIZES, PARTITION_TYPE_COUNT, INTRA_MODE_CONTEXT,
    TXTP_FROM_UVMODE, TX_TYPES_PER_SET, LO_CTX_OFFSETS, SKIP_CTX, CFL_ALLOWED_MASK, BL_64X64, BL_8X8,
    PARTITION_NONE, PARTITION_H, PARTITION_V, PARTITION_SPLIT, PARTITION_T_TOP_SPLIT, PARTITION_T_LEFT_SPLIT,
    PARTITION_T_RIGHT_SPLIT, PARTITION_H4, PARTITION_V4, DC_PRED, VERT_PRED, HOR_PRED, VERT_LEFT_PRED, SMOOTH_PRED, SMOOTH_V_PRED,
    SMOOTH_H_PRED, PAETH_PRED, CFL_PRED, TX_4X4, TX_64X64, TX_16X16, RTX_4X8, DCT_DCT, IDTX, WHT_WHT, EDGE_I444_TOP_HAS_RIGHT,
    EDGE_I444_LEFT_HAS_BOTTOM, EDGE_I420_TOP_HAS_RIGHT, EDGE_I420_LEFT_HAS_BOTTOM, EdgeNode, edgeTree, defaultCdfs,
    scan, dequant
} from './tables.ts';
import { prepareEdges, predict, preparedAngle, cflAc, cflPredict, ANGLE_USE_EDGE_FILTER, ANGLE_SMOOTH_EDGE } from './ipred.ts';
import { inverseTransformAdd } from './itx.ts';
import { forwardTransform, forwardWht, pixelEnergy } from './fdct.ts';
import { deblock } from './loopfilter.ts';
import { cdef } from './cdef.ts';

const ADST_DCT = 1, DCT_ADST = 2, ADST_ADST = 3;
const bdim = (bs: number, i: number): number => BLOCK_DIMENSIONS[bs * 4 + i];
const tdim = (tx: number, i: number): number => TXFM_DIMENSIONS[tx * 8 + i];
const W = 0, H = 1, LW = 2, LH = 3, MIN = 4, MAX = 5, CTX = 7;

/** An image to encode: 8-bit planes (Y, and U and V of the layout's size), the layout (0 monochrome, 1 4:2:0, 3 4:4:4) */
export interface AV1Image {
    planes: Uint8Array[];
    width: number;
    height: number;
    layout: number;
    /** color description: primaries, transfer characteristics, matrix coefficients; full range */
    cicp: number[];
}

/** Encoding parameters: the quantizer index (1-255), how hard to search (0-2) */
export interface AV1Params {
    qidx: number;
    effort: number;
}

// a coded block's modes
interface Block {
    skip: number;
    yMode: number;
    yAngle: number;
    uvMode: number;
    uvAngle: number;
    cflAlpha: number[];
    tx: number;
    /** the luma transform type */
    txtp: number;
    uvtx: number;
}

// a partition decision: a block, or the four quarters (null outside the frame)
interface Node {
    bp: number;
    b: Block | null;
    kids: Array<Node | null>;
}

const isDirectional = (mode: number): boolean => mode >= VERT_PRED && mode <= VERT_LEFT_PRED;
const smFlag = (mode: number): number => mode === SMOOTH_PRED || mode === SMOOTH_H_PRED || mode === SMOOTH_V_PRED ? ANGLE_SMOOTH_EDGE : 0;

// the approximate bits of a quantized coefficient magnitude (with its sign)
const coefBits = (q: number): number => q === 0 ? 0.6 : q === 1 ? 2.2 : q === 2 ? 3.4 : q < 15 ? 4.6 + Math.log2(q - 2) : 9 + 2 * Math.log2(q - 14);

const SATD_BLOCK = new Int32Array(16);

class TileEncoder {
    private seq: SequenceHeader;
    private hdr: FrameHeader;
    private ssx: number;
    private ssy: number;
    private cdf!: Uint16Array;
    private w: SymbolEncoder | null = null;
    private bx = 0;
    private by = 0;
    private colStart = 0;
    private colEnd = 0;
    private rowStart = 0;
    private rowEnd = 0;
    // the dequantizers [plane][dc, ac]
    private dq: number[][];
    private lambda: number;

    // above contexts (by absolute 4x4 column) and left ones (by 4x4 row in the superblock)
    private aMode: Uint8Array; private lMode = new Uint8Array(32);
    private aLcoef: Uint8Array; private lLcoef = new Uint8Array(32);
    private aCcoef: Uint8Array[]; private lCcoef = [new Uint8Array(32), new Uint8Array(32)];
    private aSkip: Uint8Array; private lSkip = new Uint8Array(32);
    private aUvmode: Uint8Array; private lUvmode = new Uint8Array(32);
    private aPartition: Uint8Array; private lPartition = new Uint8Array(16);

    private cf = new Int32Array(32 * 32);
    private coefs = new Float64Array(32 * 32);
    private q = new Int32Array(32 * 32);
    private res = new Float64Array(64 * 64);
    private levels = new Uint8Array(36 * 36);
    private rdoKeep = new Float64Array(32 * 32);
    private whtRes = new Int32Array(16);
    private whtOut = new Int32Array(16);
    private lossless: boolean;
    /** per 64x64 block: the CDEF strength index chosen */
    cdefChoice: Int8Array;
    private rdoDrop = new Float64Array(32 * 32);
    private ac = new Int16Array(32 * 32);
    // the bits of the last block's coefficients (estimated), whether it had any
    private bits = 0;
    private coded = false;

    constructor(private f: Frame, private src: Uint16Array[], private params: AV1Params) {
        this.seq = f.seq;
        this.hdr = f.hdr;
        this.ssx = f.ssx;
        this.ssy = f.ssy;
        const n = f.b4Stride + 32;
        this.aMode = new Uint8Array(n);
        this.aLcoef = new Uint8Array(n);
        this.aCcoef = [new Uint8Array(n), new Uint8Array(n)];
        this.aSkip = new Uint8Array(n);
        this.aUvmode = new Uint8Array(n);
        this.aPartition = new Uint8Array(n >> 1);
        this.cdefChoice = new Int8Array(f.cdefIdx.length);
        this.lossless = this.hdr.allLossless;
        const q = this.hdr.quant;
        this.dq = [[dequant(0, q.yac, 0), dequant(0, q.yac, 1)], [dequant(0, q.yac + q.udcDelta, 0), dequant(0, q.yac + q.uacDelta, 1)], [dequant(0, q.yac + q.vdcDelta, 0), dequant(0, q.yac + q.vacDelta, 1)]];
        // (distortion is in squared pixels; the AC quantizer is about 8 times a pixel step)
        const step = this.dq[0][1] / 8;
        this.lambda = 0.08 * step * step;
    }

    private resetAbove(): void {
        this.aUvmode.fill(DC_PRED);
        this.aMode.fill(DC_PRED);
        this.aPartition.fill(0);
        this.aSkip.fill(0);
        this.aLcoef.fill(0x40);
        this.aCcoef[0].fill(0x40);
        this.aCcoef[1].fill(0x40);
    }

    private resetLeft(): void {
        this.lUvmode.fill(DC_PRED);
        this.lMode.fill(DC_PRED);
        this.lPartition.fill(0);
        this.lSkip.fill(0);
        this.lLcoef.fill(0x40);
        this.lCcoef[0].fill(0x40);
        this.lCcoef[1].fill(0x40);
    }

    // the bounds of a tile (in 4 pixel units)
    private tile(tileRow: number, tileCol: number): void {
        const f = this.f, t = this.hdr.tiles;
        this.colStart = t.colStarts[tileCol] << 4;
        this.colEnd = Math.min(t.colStarts[tileCol + 1] << 4, f.bw);
        this.rowStart = t.rowStarts[tileRow] << 4;
        this.rowEnd = Math.min(t.rowStarts[tileRow + 1] << 4, f.bh);
    }

    /** Searches the partitions and modes of a tile's superblocks (their reconstruction left in the frame) */
    searchTile(tileRow: number, tileCol: number): Node[] {
        this.tile(tileRow, tileCol);
        const root = edgeTree(false), nodes: Node[] = [];
        this.resetAbove();
        for (this.by = this.rowStart; this.by < this.rowEnd; this.by += 16) {
            this.resetLeft();
            for (this.bx = this.colStart; this.bx < this.colEnd; this.bx += 16) nodes.push(this.search(BL_64X64, root).node);
        }
        return nodes;
    }

    /** Stores what the post filters need of a tile's blocks, marks the 64x64 blocks with coefficients (CDEF index 0) */
    storeTile(tileRow: number, tileCol: number, nodes: Node[]): void {
        this.tile(tileRow, tileCol);
        let i = 0;
        for (this.by = this.rowStart; this.by < this.rowEnd; this.by += 16) {
            for (this.bx = this.colStart; this.bx < this.colEnd; this.bx += 16) this.walk(BL_64X64, nodes[i++]);
        }
    }

    private walk(bl: number, n: Node): void {
        if (n.bp === PARTITION_NONE) {
            const b = n.b as Block, f = this.f;
            this.storeBlock(BLOCK_SIZES[(bl * 10 + PARTITION_NONE) * 2], b);
            if (!b.skip) f.cdefIdx[(this.by >> 4) * (f.b4Stride >> 4) + (this.bx >> 4)] = 0;
            return;
        }
        const hsz = 16 >> bl;
        for (let k = 0; k < 4; k++) {
            if (!n.kids[k]) continue;
            const dx = k & 1 ? hsz : 0, dy = k & 2 ? hsz : 0;
            this.bx += dx;
            this.by += dy;
            this.walk(bl + 1, n.kids[k] as Node);
            this.bx -= dx;
            this.by -= dy;
        }
    }

    /** Writes a tile's superblocks with their partitions and modes (reconstructing them again, the same) */
    writeTile(tileRow: number, tileCol: number, nodes: Node[]): Uint8Array {
        this.tile(tileRow, tileCol);
        const root = edgeTree(false);
        this.cdf = defaultCdfs(this.hdr.quant.yac);
        this.w = new SymbolEncoder(!this.hdr.disableCdfUpdate);
        this.resetAbove();
        let i = 0;
        for (this.by = this.rowStart; this.by < this.rowEnd; this.by += 16) {
            this.resetLeft();
            for (this.bx = this.colStart; this.bx < this.colEnd; this.bx += 16) {
                this.writeSb(BL_64X64, root, nodes[i++]);
            }
        }
        const data = this.w.finish();
        this.w = null;
        return data;
    }

    // ---- the search

    // the partition and modes of a block of level bl (and its cost), its reconstruction left in the frame
    private search(bl: number, node: EdgeNode): { node: Node, cost: number } {
        const f = this.f, hsz = 16 >> bl;
        const haveH = f.bw > this.bx + hsz, haveV = f.bh > this.by + hsz;
        const split = (quarters: number[]): { node: Node, cost: number } => {
            const kids: Array<Node | null> = [null, null, null, null];
            let cost = 0;
            for (const k of quarters) {
                const dx = k & 1 ? hsz : 0, dy = k & 2 ? hsz : 0;
                this.bx += dx;
                this.by += dy;
                const r = this.search(bl + 1, node.split[k]);
                this.bx -= dx;
                this.by -= dy;
                kids[k] = r.node;
                cost += r.cost;
            }
            return { node: { bp: PARTITION_SPLIT, b: null, kids }, cost };
        };
        // (at the frame's edges: split)
        if (!haveH && !haveV) return split([0]);
        if (!haveH) return split([0, 2]);
        if (!haveV) return split([0, 1]);
        const bs = BLOCK_SIZES[(bl * 10 + PARTITION_NONE) * 2];
        if (bl === BL_8X8) {
            const r = this.searchBlock(bs, node.o);
            return { node: { bp: PARTITION_NONE, b: r.b, kids: [] }, cost: r.cost };
        }
        const saved = this.saveArea(bl);
        if (bl <= BL_64X64 + 1) {
            // 64x64 and 32x32: the quarters first, the whole block only if few of them split further (rarely better
            // then; below effort 2)
            const sp = split([0, 1, 2, 3]);
            const deeper = sp.node.kids.filter(k => k && k.bp === PARTITION_SPLIT).length;
            if (this.params.effort < 2 && deeper >= (bl === BL_64X64 ? 2 : 4)) return { node: sp.node, cost: sp.cost + this.lambda * 2 };
            const spArea = this.saveArea(bl), contexts = this.saveContexts(bs);
            this.restoreArea(bl, saved);
            const none = this.searchBlock(bs, node.o);
            if (none.cost + this.lambda < sp.cost + this.lambda * 2) return { node: { bp: PARTITION_NONE, b: none.b, kids: [] }, cost: none.cost + this.lambda };
            this.restoreArea(bl, spArea);
            this.restoreContexts(contexts);
            return { node: sp.node, cost: sp.cost + this.lambda * 2 };
        }
        // 16x16: the whole block first (one without coefficients is rarely worth splitting)
        const none = this.searchBlock(bs, node.o);
        if (none.b.skip && this.params.effort < 2) return { node: { bp: PARTITION_NONE, b: none.b, kids: [] }, cost: none.cost + this.lambda };
        const noneArea = this.saveArea(bl);
        this.restoreArea(bl, saved);
        const sp = split([0, 1, 2, 3]);
        // (the partition symbols: about a bit each)
        if (none.cost + this.lambda < sp.cost + this.lambda * 2) {
            this.restoreArea(bl, noneArea);
            this.modeContexts(bs, none.b);
            return { node: { bp: PARTITION_NONE, b: none.b, kids: [] }, cost: none.cost + this.lambda };
        }
        return { node: sp.node, cost: sp.cost + this.lambda * 2 };
    }

    // the pixels of a block (all planes) at the current position
    private saveArea(bl: number): Uint16Array[] {
        const f = this.f, n = 64 >> (bl - 1);
        return f.planes.map((plane, p) => {
            const sx = p ? this.ssx : 0, sy = p ? this.ssy : 0, stride = f.strides[p];
            const w = n >> sx, h = n >> sy, x0 = this.bx * 4 >> sx, y0 = this.by * 4 >> sy, out = new Uint16Array(w * h);
            for (let y = 0; y < h; y++) out.set(plane.subarray((y0 + y) * stride + x0, (y0 + y) * stride + x0 + w), y * w);
            return out;
        });
    }

    private restoreArea(bl: number, saved: Uint16Array[]): void {
        const f = this.f, n = 64 >> (bl - 1);
        f.planes.forEach((plane, p) => {
            const sx = p ? this.ssx : 0, sy = p ? this.ssy : 0, stride = f.strides[p];
            const w = n >> sx, h = n >> sy, x0 = this.bx * 4 >> sx, y0 = this.by * 4 >> sy;
            for (let y = 0; y < h; y++) plane.set(saved[p].subarray(y * w, y * w + w), (y0 + y) * stride + x0);
        });
    }

    // the modes of a block (by rate and distortion), its reconstruction left in the frame
    private searchBlock(bs: number, edgeFlags: number): { b: Block, cost: number } {
        const f = this.f, layout = f.layout;
        const lw4 = bdim(bs, 2), lh4 = bdim(bs, 3);
        const b: Block = {
            skip: 0, yMode: DC_PRED, yAngle: 0, uvMode: DC_PRED, uvAngle: 0, cflAlpha: [0, 0],
            tx: this.lossless ? TX_4X4 : MAX_TXFM_SIZE_FOR_BS[bs * 4], txtp: this.lossless ? WHT_WHT : DCT_DCT,
            uvtx: this.lossless ? TX_4X4 : MAX_TXFM_SIZE_FOR_BS[bs * 4 + layout]
        };
        const lambda = this.lambda, sadLambda = Math.sqrt(lambda);
        const angles = lw4 + lh4 >= 2 && this.params.effort > 1 ? [-3, -2, -1, 0, 1, 2, 3] : [0];

        // luma: the predictions' SATD first, then the best few coded
        const candidates: Array<{ mode: number, angle: number, est: number }> = [];
        for (let mode = DC_PRED; mode <= PAETH_PRED; mode++) {
            for (const angle of isDirectional(mode) ? angles : [0]) {
                b.yMode = mode;
                b.yAngle = angle;
                this.predictLuma(bs, edgeFlags, b);
                candidates.push({ mode, angle, est: this.satd(0, bs) + sadLambda * (mode === DC_PRED ? 2 : 4.5 + (isDirectional(mode) && lw4 + lh4 >= 2 ? 1.5 : 0)) });
            }
        }
        candidates.sort((x, y) => x.est - y.est);
        // (the best one's reconstruction kept)
        let best = Infinity, bestMode = candidates[0], dist = 0, bits = 0, coded = false, kept: Uint16Array | null = null, bestTx = DCT_DCT;
        // (below effort 2 only those about as good as the best)
        const close = this.params.effort < 2 ? 1.1 : Infinity;
        const tries = candidates.slice(0, [1, 2, 3][this.params.effort]).filter(c => c.est <= candidates[0].est * close);
        for (const [i, c] of tries.entries()) {
            b.yMode = c.mode;
            b.yAngle = c.angle;
            const d = this.codeLuma(bs, edgeFlags, b);
            const cost = d + lambda * (this.bits + (c.mode === DC_PRED ? 2 : 4.5));
            if (cost < best) {
                best = cost;
                bestMode = c;
                dist = d;
                bits = this.bits;
                coded = this.coded;
                if (i < tries.length - 1) kept = this.savePlane(0, bs);
                else kept = null;
            }
        }
        b.yMode = bestMode.mode;
        b.yAngle = bestMode.angle;
        if (kept) this.restorePlane(0, bs, kept);
        // the transform type (signaled up to 16x16; of the 2D ones): ADST combinations, identity
        if (tdim(b.tx, MAX) <= TX_16X16 && this.params.effort && coded && !this.lossless) {
            // (the type's symbol: about 1 bit for DCT, 2.5 for the others)
            let keptTx = this.savePlane(0, bs), bestTxCost = best + lambda;
            for (const txtp of [ADST_ADST, ADST_DCT, DCT_ADST, IDTX]) {
                b.txtp = txtp;
                const d = this.codeLuma(bs, edgeFlags, b);
                const cost = d + lambda * (this.bits + 2.5 + (b.yMode === DC_PRED ? 2 : 4.5));
                if (cost < bestTxCost) {
                    bestTxCost = cost;
                    dist = d;
                    bits = this.bits + 1.5;
                    coded = this.coded;
                    keptTx = this.savePlane(0, bs);
                    bestTx = txtp;
                }
            }
            b.txtp = bestTx;
            this.restorePlane(0, bs, keptTx);
        }

        if (layout) {
            // chroma: the same with chroma from luma
            const cflAllowed = this.cflAllowed(bs);
            const uvCandidates: Array<{ mode: number, angle: number, alpha: number[], est: number }> = [];
            for (let mode = DC_PRED; mode <= (cflAllowed ? CFL_PRED : PAETH_PRED); mode++) {
                if (mode === CFL_PRED) {
                    const alpha = this.cflAlphas(bs, b);
                    // (both zero isn't allowed)
                    if (!alpha[0] && !alpha[1]) continue;
                    b.uvMode = CFL_PRED;
                    b.cflAlpha = alpha;
                    this.predictChroma(bs, edgeFlags, b);
                    uvCandidates.push({ mode, angle: 0, alpha, est: this.satd(1, bs) + this.satd(2, bs) + sadLambda * 7 });
                    continue;
                }
                // (below effort 2: the modes that predict chroma best most often)
                if (this.params.effort < 2 && mode !== b.yMode && mode !== DC_PRED && mode !== VERT_PRED && mode !== HOR_PRED && mode !== SMOOTH_PRED && mode !== PAETH_PRED) continue;
                b.uvMode = mode;
                b.uvAngle = 0;
                this.predictChroma(bs, edgeFlags, b);
                uvCandidates.push({ mode, angle: 0, alpha: [0, 0], est: this.satd(1, bs) + this.satd(2, bs) + sadLambda * (mode === DC_PRED ? 1.5 : 4) });
            }
            uvCandidates.sort((x, y) => x.est - y.est);
            let bestUv = Infinity, bestUvMode = uvCandidates[0], uvDist = 0, uvBits = 0, uvCoded = false, keptUv: Uint16Array[] | null = null;
            const uvClose = this.params.effort < 2 ? 1.2 : Infinity;
            const uvTries = uvCandidates.slice(0, [1, 2, 2][this.params.effort]).filter(c => c.est <= uvCandidates[0].est * uvClose);
            for (const [i, c] of uvTries.entries()) {
                b.uvMode = c.mode;
                b.uvAngle = c.angle;
                b.cflAlpha = c.alpha;
                const d = this.codeChroma(bs, edgeFlags, b);
                const cost = d + lambda * (this.bits + (c.mode === DC_PRED ? 1.5 : 4));
                if (cost < bestUv) {
                    bestUv = cost;
                    bestUvMode = c;
                    uvDist = d;
                    uvBits = this.bits;
                    uvCoded = this.coded;
                    keptUv = i < uvTries.length - 1 ? [this.savePlane(1, bs), this.savePlane(2, bs)] : null;
                }
            }
            b.uvMode = bestUvMode.mode;
            b.uvAngle = bestUvMode.angle;
            b.cflAlpha = bestUvMode.alpha;
            if (keptUv) {
                this.restorePlane(1, bs, keptUv[0]);
                this.restorePlane(2, bs, keptUv[1]);
            }
            dist += uvDist;
            bits += uvBits;
            coded ||= uvCoded;
        }
        b.skip = coded ? 0 : 1;
        this.modeContexts(bs, b);
        return { b, cost: dist + lambda * (bits + 1 + 3) };
    }

    // the mode contexts of a block (the smooth modes of the neighbours change the edges' filters)
    private modeContexts(bs: number, b: Block): void {
        const bx4 = this.bx, by4 = this.by & 31, aw = 1 << bdim(bs, 2), lh = 1 << bdim(bs, 3);
        this.aMode.fill(b.yMode, bx4, bx4 + aw);
        this.lMode.fill(b.yMode, by4, by4 + lh);
        if (this.f.layout) {
            const cbx4 = bx4 >> this.ssx, cby4 = by4 >> this.ssy;
            this.aUvmode.fill(b.uvMode, cbx4, cbx4 + (bdim(bs, 0) + this.ssx >> this.ssx));
            this.lUvmode.fill(b.uvMode, cby4, cby4 + (bdim(bs, 1) + this.ssy >> this.ssy));
        }
    }

    // the mode contexts of a block's area
    private saveContexts(bs: number): Uint8Array[] {
        const bx4 = this.bx, by4 = this.by & 31, aw = bdim(bs, 0), lh = bdim(bs, 1);
        const cbx4 = bx4 >> this.ssx, cby4 = by4 >> this.ssy, cw = aw + this.ssx >> this.ssx, ch = lh + this.ssy >> this.ssy;
        return [this.aMode.slice(bx4, bx4 + aw), this.lMode.slice(by4, by4 + lh), this.aUvmode.slice(cbx4, cbx4 + cw), this.lUvmode.slice(cby4, cby4 + ch)];
    }

    private restoreContexts(c: Uint8Array[]): void {
        const bx4 = this.bx, by4 = this.by & 31, cbx4 = bx4 >> this.ssx, cby4 = by4 >> this.ssy;
        this.aMode.set(c[0], bx4);
        this.lMode.set(c[1], by4);
        this.aUvmode.set(c[2], cbx4);
        this.lUvmode.set(c[3], cby4);
    }

    // whether chroma from luma is allowed (of lossless blocks only with 4x4 chroma)
    private cflAllowed(bs: number): boolean {
        if (!this.lossless) return !!(CFL_ALLOWED_MASK & 1 << bs);
        return (bdim(bs, 0) + this.ssx >> this.ssx) === 1 && (bdim(bs, 1) + this.ssy >> this.ssy) === 1;
    }

    // a plane's pixels of a block
    private savePlane(p: number, bs: number): Uint16Array {
        const f = this.f, sx = p ? this.ssx : 0, sy = p ? this.ssy : 0, stride = f.strides[p];
        const w = bdim(bs, 0) * 4 >> sx, h = bdim(bs, 1) * 4 >> sy, o = (this.by * 4 >> sy) * stride + (this.bx * 4 >> sx);
        const out = new Uint16Array(w * h);
        for (let y = 0; y < h; y++) out.set(f.planes[p].subarray(o + y * stride, o + y * stride + w), y * w);
        return out;
    }

    private restorePlane(p: number, bs: number, saved: Uint16Array): void {
        const f = this.f, sx = p ? this.ssx : 0, sy = p ? this.ssy : 0, stride = f.strides[p];
        const w = bdim(bs, 0) * 4 >> sx, h = bdim(bs, 1) * 4 >> sy, o = (this.by * 4 >> sy) * stride + (this.bx * 4 >> sx);
        for (let y = 0; y < h; y++) f.planes[p].set(saved.subarray(y * w, y * w + w), o + y * stride);
    }

    // the sum of absolute 4x4 Hadamard transformed differences of a plane's prediction (in the frame) and the source
    private satd(p: number, bs: number): number {
        const f = this.f, sx = p ? this.ssx : 0, sy = p ? this.ssy : 0, stride = f.strides[p];
        const w = bdim(bs, 0) * 4 >> sx, h = bdim(bs, 1) * 4 >> sy, x0 = this.bx * 4 >> sx, y0 = this.by * 4 >> sy;
        const pred = f.planes[p], src = this.src[p], d = SATD_BLOCK;
        let sum = 0;
        for (let by = 0; by < h; by += 4) {
            for (let bx = 0; bx < w; bx += 4) {
                for (let y = 0; y < 4; y++) {
                    const o = (y0 + by + y) * stride + x0 + bx;
                    for (let x = 0; x < 4; x++) d[y * 4 + x] = src[o + x] - pred[o + x];
                }
                for (let y = 0; y < 4; y++) {
                    const a = d[y * 4] + d[y * 4 + 1], b = d[y * 4] - d[y * 4 + 1], c = d[y * 4 + 2] + d[y * 4 + 3], e = d[y * 4 + 2] - d[y * 4 + 3];
                    d[y * 4] = a + c; d[y * 4 + 1] = b + e; d[y * 4 + 2] = a - c; d[y * 4 + 3] = b - e;
                }
                for (let x = 0; x < 4; x++) {
                    const a = d[x] + d[4 + x], b = d[x] - d[4 + x], c = d[8 + x] + d[12 + x], e = d[8 + x] - d[12 + x];
                    sum += Math.abs(a + c) + Math.abs(b + e) + Math.abs(a - c) + Math.abs(b - e);
                }
            }
        }
        // (the 4x4 Hadamard transform is 4 times as large as orthonormal)
        return sum / 4;
    }

    // the CFL alphas (per chroma plane) that predict the source best, from the reconstructed luma
    private cflAlphas(bs: number, b: Block): number[] {
        const f = this.f, ssx = this.ssx, ssy = this.ssy, stride = f.strides[0];
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1);
        const w4 = Math.min(bw4, f.bw - this.bx), h4 = Math.min(bh4, f.bh - this.by);
        const cbw4 = bw4 + ssx >> ssx, cbh4 = bh4 + ssy >> ssy, cw4 = w4 + ssx >> ssx, ch4 = h4 + ssy >> ssy;
        const tw = tdim(b.tx, W), th = tdim(b.tx, H);
        const yo = 4 * (this.bx & ~ssx) + 4 * (this.by & ~ssy) * stride;
        const furthestR = ((cw4 << ssx) + tw - 1) & ~(tw - 1), furthestB = ((ch4 << ssy) + th - 1) & ~(th - 1);
        cflAc(this.ac, f.planes[0], yo, stride, cbw4 - (furthestR >> ssx), cbh4 - (furthestB >> ssy), cbw4 * 4, cbh4 * 4, ssx, ssy);
        const alphas = [0, 0], w = cbw4 * 4, h = cbh4 * 4, cstride = f.strides[1];
        const x0 = this.bx * 4 >> ssx, y0 = this.by * 4 >> ssy;
        for (let pl = 0; pl < 2; pl++) {
            // the least squares slope of the source (minus its mean) over the AC (in 1/8 steps: alpha * ac / 64)
            const src = this.src[1 + pl];
            let mean = 0;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mean += src[(y0 + y) * cstride + x0 + x];
            mean /= w * h;
            let sxy = 0, sxx = 0;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const a = this.ac[y * w + x];
                    sxy += a * (src[(y0 + y) * cstride + x0 + x] - mean);
                    sxx += a * a;
                }
            }
            alphas[pl] = sxx ? Math.max(-16, Math.min(16, Math.round(sxy / sxx * 64 / 8))) : 0;
        }
        return alphas;
    }

    // ---- reconstruction (and, while writing, the coefficients)

    // the luma prediction of a block whose transform is the whole block
    private predictLuma(bs: number, edgeFlags: number, b: Block): void {
        this.codeLuma(bs, edgeFlags, b, true);
    }

    private predictChroma(bs: number, edgeFlags: number, b: Block): void {
        this.codeChroma(bs, edgeFlags, b, true);
    }

    // predicts and codes a block's luma (only predicts: predictOnly), returns the squared error
    private codeLuma(bs: number, edgeFlags: number, b: Block, predictOnly = false): number {
        const f = this.f, seq = this.seq;
        const bx = this.bx, by = this.by, bx4 = bx, by4 = by & 31;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1);
        const w4 = Math.min(bw4, f.bw - bx), h4 = Math.min(bh4, f.bh - by);
        const tx = b.tx, tw = tdim(tx, W), th = tdim(tx, H);
        const filterFlag = seq.intraEdgeFilter ? ANGLE_USE_EDGE_FILTER : 0;
        const pic = f.planes[0], stride = f.strides[0];
        let dist = 0;
        this.bits = 0;
        this.coded = false;
        for (let initY = 0; initY < h4; initY += 16) {
            const subH4 = Math.min(h4, 16 + initY);
            for (let initX = 0; initX < w4; initX += 16) {
                const intraFlags = smFlag(this.aMode[bx4]) | smFlag(this.lMode[by4]) | filterFlag;
                const sbHasTr = initX + 16 < w4 ? 1 : initY ? 0 : edgeFlags & EDGE_I444_TOP_HAS_RIGHT;
                const sbHasBl = initX ? 0 : initY + 16 < h4 ? 1 : edgeFlags & EDGE_I444_LEFT_HAS_BOTTOM;
                const subW4 = Math.min(w4, initX + 16);
                for (let y = initY; y < subH4; y += th) {
                    const ty = by + y;
                    let d = 4 * (ty * stride + bx + initX);
                    for (let x = initX; x < subW4; x += tw, d += 4 * tw) {
                        const tx4 = bx + x;
                        const flags = (((y > initY || !sbHasTr) && x + tw >= subW4) ? 0 : EDGE_I444_TOP_HAS_RIGHT) |
                            ((x > initX || (!sbHasBl && y + th >= subH4)) ? 0 : EDGE_I444_LEFT_HAS_BOTTOM);
                        const mode = prepareEdges(tx4, tx4 > this.colStart, ty, ty > this.rowStart, this.colEnd, this.rowEnd, flags,
                            pic, d, stride, b.yMode, b.yAngle, tw, th, seq.intraEdgeFilter, f.bitdepth);
                        predict(mode, pic, d, stride, tw * 4, th * 4, preparedAngle | intraFlags, 4 * f.bw - 4 * tx4, 4 * f.bh - 4 * ty, f.bitdepthMax);
                        if (predictOnly) continue;
                        dist += this.codeTx(0, d, stride, tx, b.txtp, b, bs, this.aLcoef, bx4 + x, this.lLcoef, by4 + y,
                            Math.min(tw, f.bw - tx4), Math.min(th, f.bh - ty), 4 * tx4, 4 * ty);
                    }
                }
            }
        }
        return dist;
    }

    // predicts and codes a block's chroma planes, returns the squared error
    private codeChroma(bs: number, edgeFlags: number, b: Block, predictOnly = false): number {
        const f = this.f, seq = this.seq, ssx = this.ssx, ssy = this.ssy;
        const bx = this.bx, by = this.by, bx4 = bx, by4 = by & 31;
        const cbx4 = bx4 >> ssx, cby4 = by4 >> ssy;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1);
        const w4 = Math.min(bw4, f.bw - bx), h4 = Math.min(bh4, f.bh - by);
        const cw4 = w4 + ssx >> ssx, ch4 = h4 + ssy >> ssy, cbw4 = bw4 + ssx >> ssx, cbh4 = bh4 + ssy >> ssy;
        const tx = b.tx, uvtx = b.uvtx, tw = tdim(tx, W), th = tdim(tx, H), uvtw = tdim(uvtx, W), uvth = tdim(uvtx, H);
        const filterFlag = seq.intraEdgeFilter ? ANGLE_USE_EDGE_FILTER : 0;
        const stride = f.strides[0], cstride = f.strides[1];
        let dist = 0;
        this.bits = 0;
        this.coded = false;
        for (let initY = 0; initY < h4; initY += 16) {
            const subCh4 = Math.min(ch4, initY + 16 >> ssy);
            for (let initX = 0; initX < w4; initX += 16) {
                if (b.uvMode === CFL_PRED) {
                    const yo = 4 * (bx & ~ssx) + 4 * (by & ~ssy) * stride;
                    const furthestR = ((cw4 << ssx) + tw - 1) & ~(tw - 1), furthestB = ((ch4 << ssy) + th - 1) & ~(th - 1);
                    cflAc(this.ac, f.planes[0], yo, stride, cbw4 - (furthestR >> ssx), cbh4 - (furthestB >> ssy), cbw4 * 4, cbh4 * 4, ssx, ssy);
                    const uvOff = 4 * ((bx >> ssx) + (by >> ssy) * cstride);
                    for (let pl = 0; pl < 2; pl++) {
                        if (!b.cflAlpha[pl]) continue;
                        const xpos = bx >> ssx, ypos = by >> ssy;
                        const mode = prepareEdges(xpos, xpos > this.colStart >> ssx, ypos, ypos > this.rowStart >> ssy,
                            this.colEnd >> ssx, this.rowEnd >> ssy, 0, f.planes[1 + pl], uvOff, cstride, DC_PRED, 0, uvtw, uvth, false, f.bitdepth);
                        cflPredict(mode, f.planes[1 + pl], uvOff, cstride, uvtw * 4, uvth * 4, this.ac, b.cflAlpha[pl], f.bitdepthMax);
                    }
                }
                const smUv = smFlag(this.aUvmode[cbx4]) | smFlag(this.lUvmode[cby4]);
                const edge = f.layout === 1 ? [EDGE_I420_TOP_HAS_RIGHT, EDGE_I420_LEFT_HAS_BOTTOM] : [1, 8];
                const uvSbHasTr = (initX + 16 >> ssx) < cw4 ? 1 : initY ? 0 : edgeFlags & edge[0];
                const uvSbHasBl = initX ? 0 : (initY + 16 >> ssy) < ch4 ? 1 : edgeFlags & edge[1];
                const subCw4 = Math.min(cw4, initX + 16 >> ssx);
                const txtp = this.lossless ? WHT_WHT : tdim(uvtx, MAX) + 1 >= TX_64X64 ? DCT_DCT : TXTP_FROM_UVMODE[b.uvMode];
                for (let pl = 0; pl < 2; pl++) {
                    const plane = f.planes[1 + pl];
                    const aC = this.aCcoef[pl], lC = this.lCcoef[pl];
                    for (let y = initY >> ssy, tyl = by + initY; y < subCh4; y += uvth, tyl += uvth << ssy) {
                        let d = 4 * ((tyl >> ssy) * cstride + (bx + initX >> ssx));
                        for (let x = initX >> ssx, txl = bx + initX; x < subCw4; x += uvtw, txl += uvtw << ssx, d += uvtw * 4) {
                            if (!(b.uvMode === CFL_PRED && b.cflAlpha[pl])) {
                                const flags = (((y > (initY >> ssy) || !uvSbHasTr) && x + uvtw >= subCw4) ? 0 : EDGE_I444_TOP_HAS_RIGHT) |
                                    ((x > (initX >> ssx) || (!uvSbHasBl && y + uvth >= subCh4)) ? 0 : EDGE_I444_LEFT_HAS_BOTTOM);
                                const uvMode = b.uvMode === CFL_PRED ? DC_PRED : b.uvMode;
                                const xpos = txl >> ssx, ypos = tyl >> ssy;
                                const mode = prepareEdges(xpos, xpos > this.colStart >> ssx, ypos, ypos > this.rowStart >> ssy,
                                    this.colEnd >> ssx, this.rowEnd >> ssy, flags, plane, d, cstride, uvMode, b.uvAngle, uvtw, uvth,
                                    seq.intraEdgeFilter, f.bitdepth);
                                predict(mode, plane, d, cstride, uvtw * 4, uvth * 4, preparedAngle | filterFlag | smUv,
                                    (4 * f.bw + ssx - 4 * (txl & ~ssx)) >> ssx, (4 * f.bh + ssy - 4 * (tyl & ~ssy)) >> ssy, f.bitdepthMax);
                            }
                            if (predictOnly) continue;
                            const ctw = Math.min(uvtw, (f.bw - txl + ssx) >> ssx), cth = Math.min(uvth, (f.bh - tyl + ssy) >> ssy);
                            dist += this.codeTx(1 + pl, d, cstride, uvtx, txtp, b, bs, aC, cbx4 + x, lC, cby4 + y, ctw, cth, 4 * txl >> ssx, 4 * tyl >> ssy);
                        }
                    }
                }
            }
        }
        return dist;
    }

    /**
     * Transforms, quantizes and reconstructs a transform block (writing its coefficients while writing; skipped
     * blocks only reconstruct their prediction); updates the coefficient contexts (ctw, cth: their extent within the
     * frame). Returns the squared error within the image
     */
    private codeTx(plane: number, d: number, stride: number, tx: number, txtp: number, b: Block, bs: number,
        aArr: Uint8Array, a: number, lArr: Uint8Array, l: number, ctw: number, cth: number, px: number, py: number): number {
        const f = this.f, pic = f.planes[plane], src = this.src[plane];
        const w = tdim(tx, W) * 4, h = tdim(tx, H) * 4, sw = Math.min(w, 32), sh = Math.min(h, 32);
        const sx = plane ? this.ssx : 0, sy = plane ? this.ssy : 0;
        // (the visible part)
        const vw = Math.max(0, Math.min(w, (f.width + sx >> sx) - px)), vh = Math.max(0, Math.min(h, (f.height + sy >> sy) - py));
        let eob = -1;
        if (!(this.w && b.skip)) {
            const res = this.res, coefs = this.coefs, q = this.q;
            let sse = 0;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const e = res[y * w + x] = src[d + y * stride + x] - pic[d + y * stride + x];
                    sse += e * e;
                }
            }
            if (this.lossless) eob = this.whtCoefs(res, q);
            else if (sse < this.zeroBound(plane, tx)) eob = -1;
            else {
                forwardTransform(res, tx, txtp, coefs);
                eob = this.quantize(plane, tx, txtp, coefs, q, sw * sh);
            }
            if (eob >= 0) this.coded = true;
            if (this.w) this.writeCoefs(aArr, a, lArr, l, tx, txtp, bs, b, plane, eob, ctw, cth);
            else this.bits += this.estimateBits(tx, q, eob);
            if (eob >= 0) {
                this.dequantize(plane, tx, txtp, q, eob);
                inverseTransformAdd(pic, d, stride, this.cf, eob, tx, txtp, f.bitdepthMax);
            }
        } else {
            aArr.fill(0x40, a, a + tdim(tx, W));
            lArr.fill(0x40, l, l + tdim(tx, H));
        }
        let dist = 0;
        for (let y = 0; y < vh; y++) {
            for (let x = 0; x < vw; x++) {
                const e = src[d + y * stride + x] - pic[d + y * stride + x];
                dist += e * e;
            }
        }
        return dist;
    }

    // the squared error of residuals below which all of a transform's coefficients round to zero (their squares, in
    // quantizer steps, add up to less than a quarter; with a margin for the basis' uneven energies)
    private zeroBound(plane: number, tx: number): number {
        const step = Math.min(this.dq[plane][0], this.dq[plane][1]) / 2 ** Math.max(0, tdim(tx, CTX) - 2);
        return 0.2 * pixelEnergy(tx) * step * step;
    }

    // the coefficients of a lossless block (exact: q[rc] in the decoder's layout), the end of block
    private whtCoefs(res: Float64Array, q: Int32Array): number {
        const r = this.whtRes, out = this.whtOut;
        for (let i = 0; i < 16; i++) r[i] = res[i];
        forwardWht(r, out);
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) q[x * 4 + y] = out[y * 4 + x];
        const order = scan(TX_4X4);
        let eob = -1;
        for (let i = 0; i < 16; i++) if (q[order[i]]) eob = i;
        return eob;
    }

    /**
     * Quantizes the coefficients into q (q[rc]) by rate and distortion: each value or the one below, then the end of
     * block with the least cost. Returns the end of block (the scan index of the last nonzero one), -1 for none
     */
    private quantize(plane: number, tx: number, txtp: number, coefs: Float64Array, q: Int32Array, n: number): number {
        const dqShift = Math.max(0, tdim(tx, CTX) - 2), [dcq, acq] = this.dq[plane];
        const order = scan(tx), energy = pixelEnergy(tx), lambda = this.lambda;
        const keep = this.rdoKeep, drop = this.rdoDrop;
        void txtp;
        let last = -1;
        for (let i = 0; i < n; i++) {
            const rc = order[i], step = (rc ? acq : dcq) / 2 ** dqShift, v = Math.abs(coefs[rc]) / step;
            const e = energy * step * step;
            let m = Math.floor(v + 0.5);
            if (m) {
                // (or the value below)
                const dm = v - m, dl = v - m + 1;
                if (e * dl * dl + lambda * coefBits(m - 1) < e * dm * dm + lambda * coefBits(m)) m--;
            }
            q[rc] = coefs[rc] < 0 ? -m : m;
            // the costs of position i with its value and dropped (zero)
            keep[i] = e * (v - m) * (v - m) + lambda * coefBits(m);
            drop[i] = e * v * v;
            if (m) last = i;
        }
        if (last < 0) return -1;
        // the end of block: the costs up to each nonzero position, the rest dropped
        let best = 0, bestEob = -1, prefix = 0;
        for (let i = 0; i < n; i++) best += drop[i];
        best += lambda;
        let rest = best - lambda;
        for (let i = 0; i <= last; i++) {
            prefix += keep[i];
            rest -= drop[i];
            if (!q[order[i]]) continue;
            const cost = prefix + rest + lambda * (2 + 1.5 * Math.log2(i + 2));
            if (cost < best) {
                best = cost;
                bestEob = i;
            }
        }
        for (let i = bestEob + 1; i <= last; i++) q[order[i]] = 0;
        return bestEob;
    }

    // the coefficients the decoder dequantizes (cf: for the inverse transform)
    private dequantize(plane: number, tx: number, txtp: number, q: Int32Array, eob: number): void {
        const dqShift = Math.max(0, tdim(tx, CTX) - 2), [dcq, acq] = this.dq[plane];
        const cfMax = (128 << 8) - 1, order = scan(tx), cf = this.cf;
        void txtp;
        for (let i = 0; i <= eob; i++) {
            const rc = order[i], v = q[rc];
            if (!v) {
                cf[rc] = 0;
                continue;
            }
            const m = Math.abs(v), dq = rc ? acq : dcq;
            let c: number;
            if (m >= 15) c = Math.min((dq * m & 0xffffff) >> dqShift, cfMax + (v < 0 ? 1 : 0));
            else c = (dq * m) >> dqShift;
            cf[rc] = v < 0 ? -c : c;
        }
    }

    private estimateBits(tx: number, q: Int32Array, eob: number): number {
        if (eob < 0) return 1;
        const order = scan(tx);
        let bits = 2 + 1.5 * Math.log2(eob + 2);
        for (let i = 0; i <= eob; i++) bits += coefBits(Math.abs(q[order[i]]));
        return bits;
    }

    // ---- writing

    private writeSb(bl: number, node: EdgeNode, n: Node): void {
        const f = this.f, w = this.w as SymbolEncoder, cdf = this.cdf;
        const hsz = 16 >> bl;
        const haveH = f.bw > this.bx + hsz, haveV = f.bh > this.by + hsz;
        if (!haveH && !haveV) return this.writeSb(bl + 1, node.split[0], n.kids[0] as Node);
        const bx8 = this.bx >> 1, by8 = (this.by & 31) >> 1;
        const ctx = (this.aPartition[bx8] >> (4 - bl) & 1) + ((this.lPartition[by8] >> (4 - bl) & 1) << 1);
        const pc = CDF.partition + (bl * 4 + ctx) * 16;
        const bp = n.bp;
        const quarter = (k: number): void => {
            const dx = k & 1 ? hsz : 0, dy = k & 2 ? hsz : 0;
            this.bx += dx;
            this.by += dy;
            this.writeSb(bl + 1, node.split[k], n.kids[k] as Node);
            this.bx -= dx;
            this.by -= dy;
        };
        if (haveH && haveV) {
            w.symbol(cdf, pc, PARTITION_TYPE_COUNT[bl], bp);
            if (bp === PARTITION_NONE) this.writeB(BLOCK_SIZES[(bl * 10 + bp) * 2], node.o, n.b as Block);
            else for (let k = 0; k < 4; k++) quarter(k);
        } else if (haveH) {
            // split or horizontal, by the gathered probabilities (always split)
            let prob = cdf[pc + PARTITION_V - 1] - cdf[pc + PARTITION_T_TOP_SPLIT];
            prob += cdf[pc + PARTITION_T_LEFT_SPLIT - 1];
            prob += cdf[pc + PARTITION_V4 - 1] - cdf[pc + PARTITION_T_RIGHT_SPLIT];
            w.boolProb(prob, 1);
            quarter(0);
            quarter(1);
        } else {
            let prob = cdf[pc + PARTITION_H - 1] - cdf[pc + PARTITION_H];
            prob += cdf[pc + PARTITION_SPLIT - 1] - cdf[pc + PARTITION_T_LEFT_SPLIT];
            prob += cdf[pc + PARTITION_H4 - 1] - cdf[pc + PARTITION_H4];
            w.boolProb(prob, 1);
            quarter(0);
            quarter(2);
        }
        const p = haveH && haveV ? bp : PARTITION_SPLIT;
        if (p !== PARTITION_SPLIT || bl === BL_8X8) {
            this.aPartition.fill(AL_PART_CTX[bl * 10 + p], bx8, bx8 + hsz);
            this.lPartition.fill(AL_PART_CTX[50 + bl * 10 + p], by8, by8 + hsz);
        }
    }

    private writeB(bs: number, edgeFlags: number, b: Block): void {
        const f = this.f, w = this.w as SymbolEncoder, cdf = this.cdf;
        const bx = this.bx, by = this.by, bx4 = bx, by4 = by & 31;
        const ssx = this.ssx, ssy = this.ssy;
        const cbx4 = bx4 >> ssx, cby4 = by4 >> ssy;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1), lw4 = bdim(bs, 2), lh4 = bdim(bs, 3);
        const cbw4 = bw4 + ssx >> ssx, cbh4 = bh4 + ssy >> ssy;
        const hasChroma = f.layout !== 0;

        w.boolAdapt(cdf, CDF.skip + (this.aSkip[bx4] + this.lSkip[by4]) * 2, b.skip);
        // the CDEF strength of the 64x64 block, with its first coded block
        if (!b.skip) {
            const idx = (by >> 4) * (f.b4Stride >> 4) + (bx >> 4);
            if (f.cdefIdx[idx] === -1) {
                f.cdefIdx[idx] = this.cdefChoice[idx];
                w.bools(this.hdr.cdef.bits, this.cdefChoice[idx]);
            }
        }
        w.symbol(cdf, CDF.kfYMode + (INTRA_MODE_CONTEXT[this.aMode[bx4]] * 5 + INTRA_MODE_CONTEXT[this.lMode[by4]]) * 16, 12, b.yMode);
        if (lw4 + lh4 >= 2 && isDirectional(b.yMode)) w.symbol(cdf, CDF.angleDelta + (b.yMode - VERT_PRED) * 8, 6, b.yAngle + 3);
        if (hasChroma) {
            const cflAllowed = this.cflAllowed(bs);
            w.symbol(cdf, CDF.uvMode + ((cflAllowed ? 1 : 0) * 13 + b.yMode) * 16, cflAllowed ? 13 : 12, b.uvMode);
            if (b.uvMode === CFL_PRED) {
                // the signs (both zero isn't allowed), then the magnitudes
                const signU = b.cflAlpha[0] ? b.cflAlpha[0] < 0 ? 1 : 2 : 0, signV = b.cflAlpha[1] ? b.cflAlpha[1] < 0 ? 1 : 2 : 0;
                w.symbol(cdf, CDF.cflSign, 7, signU * 3 + signV - 1);
                if (signU) w.symbol(cdf, CDF.cflAlpha + ((signU === 2 ? 3 : 0) + signV) * 16, 15, Math.abs(b.cflAlpha[0]) - 1);
                if (signV) w.symbol(cdf, CDF.cflAlpha + ((signV === 2 ? 3 : 0) + signU) * 16, 15, Math.abs(b.cflAlpha[1]) - 1);
            } else if (lw4 + lh4 >= 2 && isDirectional(b.uvMode)) {
                w.symbol(cdf, CDF.angleDelta + (b.uvMode - VERT_PRED) * 8, 6, b.uvAngle + 3);
            }
        }

        this.codeLuma(bs, edgeFlags, b);
        if (hasChroma) this.codeChroma(bs, edgeFlags, b);
        this.storeBlock(bs, b);

        const aw = 1 << lw4, lh = 1 << lh4;
        this.aMode.fill(b.yMode, bx4, bx4 + aw); this.lMode.fill(b.yMode, by4, by4 + lh);
        this.aSkip.fill(b.skip, bx4, bx4 + aw); this.lSkip.fill(b.skip, by4, by4 + lh);
        if (hasChroma) {
            this.aUvmode.fill(b.uvMode, cbx4, cbx4 + cbw4);
            this.lUvmode.fill(b.uvMode, cby4, cby4 + cbh4);
        }
    }

    // what the post filters need (like the decoder's storeBlock)
    private storeBlock(bs: number, b: Block): void {
        const f = this.f, bx = this.bx, by = this.by, ssx = this.ssx, ssy = this.ssy;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1);
        const w4 = Math.min(bw4, f.bw - bx), h4 = Math.min(bh4, f.bh - by);
        const lf = this.hdr.loopFilter, lvl = [lf.levelY[0], lf.levelY[1], lf.levelU, lf.levelV];
        const s4 = f.b4Stride;
        for (let y = 0; y < h4; y++) {
            for (let x = 0; x < w4; x++) {
                const o = (by + y) * s4 + bx + x;
                f.lfLevels.set(lvl, o * 4);
                f.txW[o] = tdim(b.tx, LW);
                f.txH[o] = tdim(b.tx, LH);
                f.skip[o] = b.skip;
            }
        }
        if (f.layout) {
            const cx = bx >> ssx, cy = by >> ssy, cw4 = w4 + ssx >> ssx, ch4 = h4 + ssy >> ssy;
            for (let y = 0; y < ch4; y++) {
                for (let x = 0; x < cw4; x++) {
                    const o = (cy + y) * s4 + cx + x;
                    f.uvTxW[o] = tdim(b.uvtx, LW);
                    f.uvTxH[o] = tdim(b.uvtx, LH);
                }
            }
        }
    }

    // the coefficients of a transform block (eob: the scan index of the last nonzero one, -1 for none), like
    // decodeCoefs reads them; updates the contexts
    private writeCoefs(aArr: Uint8Array, a: number, lArr: Uint8Array, l: number, tx: number, txtp: number, bs: number, b: Block,
        plane: number, eob: number, ctw: number, cth: number): void {
        const w = this.w as SymbolEncoder, cdf = this.cdf, f = this.f, q = this.q;
        const chroma = plane ? 1 : 0;
        const tlw = tdim(tx, LW), tlh = tdim(tx, LH), tctx = tdim(tx, CTX), tmin = tdim(tx, MIN), tmax = tdim(tx, MAX);
        let sctx: number;
        const aw = 1 << tlw, lh = 1 << tlh;
        if (chroma) {
            const bl2 = bdim(bs, 2), bl3 = bdim(bs, 3);
            const notOneBlk = bl2 - (bl2 && f.ssx ? 1 : 0) > tlw || bl3 - (bl3 && f.ssy ? 1 : 0) > tlh;
            let ca = 0, cl = 0;
            for (let i = 0; i < aw; i++) if (aArr[a + i] !== 0x40) { ca = 1; break; }
            for (let i = 0; i < lh; i++) if (lArr[l + i] !== 0x40) { cl = 1; break; }
            sctx = 7 + (notOneBlk ? 3 : 0) + ca + cl;
        } else if (bdim(bs, 2) === tlw && bdim(bs, 3) === tlh) {
            sctx = 0;
        } else {
            let la = 0, ll = 0;
            for (let i = 0; i < aw; i++) la |= aArr[a + i];
            for (let i = 0; i < lh; i++) ll |= lArr[l + i];
            sctx = SKIP_CTX[Math.min(la & 0x3f, 4) * 5 + Math.min(ll & 0x3f, 4)];
        }
        w.boolAdapt(cdf, CDF.coefSkip + (tctx * 13 + sctx) * 2, eob < 0 ? 1 : 0);
        if (eob < 0) {
            aArr.fill(0x40, a, a + ctw);
            lArr.fill(0x40, l, l + cth);
            return;
        }

        // the transform type (luma: signaled up to 16x16)
        if (!chroma && tmax + 1 < TX_64X64 && !this.lossless) {
            if (tmin === TX_16X16) w.symbol(cdf, CDF.txtpIntra2 + (tmin * 13 + b.yMode) * 8, 4, TX_TYPES_PER_SET.indexOf(txtp));
            else w.symbol(cdf, CDF.txtpIntra1 + (tmin * 13 + b.yMode) * 8, 6, TX_TYPES_PER_SET.indexOf(txtp, 5) - 5);
        }

        // end of block
        const slw = Math.min(tlw, 3), slh = Math.min(tlh, 3), tx2d = slw + slh;
        const eobBin = eob < 2 ? eob : 32 - Math.clz32(eob);
        const binCdf = [CDF.eobBin16, CDF.eobBin32, CDF.eobBin64, CDF.eobBin128, CDF.eobBin256, CDF.eobBin512, CDF.eobBin1024][tx2d];
        const binCtx = tx2d < 4 ? chroma * 2 * 8 : tx2d === 4 ? chroma * 2 * 16 : chroma * 16;
        w.symbol(cdf, binCdf + binCtx, 4 + tx2d, eobBin);
        if (eobBin > 1) {
            w.boolAdapt(cdf, CDF.eobHiBit + ((tctx * 2 + chroma) * 11 + eobBin) * 2, eob >> (eobBin - 2) & 1);
            w.bools(eobBin - 2, eob & ((1 << (eobBin - 2)) - 1));
        }

        const levels = this.levels, order = scan(tx);
        const eobCdf = CDF.eobBaseTok + (tctx * 2 + chroma) * 16;
        const hiCdf = CDF.brTok + (Math.min(tctx, 3) * 2 + chroma) * 84;
        const tokOf = (v: number): number => Math.min(Math.abs(v), 15);
        if (eob) {
            const loCdf = CDF.baseTok + (tctx * 2 + chroma) * 164;
            const nonsquare = tx >= RTX_4X8 ? 1 : 0, offsets = (nonsquare + (tx & nonsquare)) * 25;
            const stride = 4 << slh, shift = slh + 2, mask = (4 << slh) - 1;
            levels.fill(0, 0, stride * ((4 << slw) + 2));
            let hiMag = 0;
            const loCtx = (lv: number, x: number, y: number): number => {
                let mg = levels[lv + 1] + levels[lv + stride];
                mg += levels[lv + stride + 1];
                hiMag = mg;
                mg += levels[lv + 2] + levels[lv + 2 * stride];
                const off = LO_CTX_OFFSETS[offsets + Math.min(y, 4) * 5 + Math.min(x, 4)];
                return off + (mg > 512 ? 4 : mg + 64 >> 7);
            };
            // the last one
            let rc = order[eob], x = rc >> shift, y = rc & mask;
            let tok = tokOf(q[rc]);
            const ctx = 1 + (eob > 2 << tx2d ? 1 : 0) + (eob > 4 << tx2d ? 1 : 0);
            w.symbol(cdf, eobCdf + ctx * 4, 2, Math.min(tok, 3) - 1);
            if (tok >= 3) w.hiTok(cdf, hiCdf + ((x | y) > 1 ? 14 : 7) * 4, tok);
            levels[x * stride + y] = tok >= 3 ? tok + (3 << 6) : tok * 0x41;
            for (let i = eob - 1; i > 0; i--) {
                rc = order[i];
                x = rc >> shift;
                y = rc & mask;
                const lv = x * stride + y;
                const c = loCtx(lv, x, y);
                tok = tokOf(q[rc]);
                w.symbol(cdf, loCdf + c * 4, 3, Math.min(tok, 3));
                if (tok >= 3) {
                    const mag = hiMag & 63;
                    w.hiTok(cdf, hiCdf + (((y | x) > 1 ? 14 : 7) + (mag > 12 ? 6 : mag + 1 >> 1)) * 4, tok);
                    levels[lv] = tok + (3 << 6);
                } else levels[lv] = tok * 0x41;
            }
            // dc
            tok = tokOf(q[0]);
            w.symbol(cdf, loCdf, 3, Math.min(tok, 3));
            if (tok >= 3) {
                const mag = levels[1] + levels[stride] + levels[stride + 1] & 63;
                w.hiTok(cdf, hiCdf + (mag > 12 ? 6 : mag + 1 >> 1) * 4, tok);
            }
        } else {
            const tok = tokOf(q[0]);
            w.symbol(cdf, eobCdf, 2, Math.min(tok, 3) - 1);
            if (tok >= 3) w.hiTok(cdf, hiCdf, tok);
        }

        // signs and the rest of large values: the DC first, then in scan order
        let culLevel = 0, dcSignLevel = 1 << 6;
        if (q[0]) {
            let sctx2 = 0;
            for (let i = 0; i < aw; i++) sctx2 += aArr[a + i] >> 6;
            for (let i = 0; i < lh; i++) sctx2 += lArr[l + i] >> 6;
            sctx2 -= aw + lh;
            const dcSignCtx = (sctx2 !== 0 ? 1 : 0) + (sctx2 > 0 ? 1 : 0);
            const sign = q[0] < 0 ? 1 : 0;
            w.boolAdapt(cdf, CDF.dcSign + (chroma * 3 + dcSignCtx) * 2, sign);
            dcSignLevel = sign ? 0 : 2 << 6;
            if (Math.abs(q[0]) >= 15) w.golomb(Math.abs(q[0]) - 15);
            culLevel = Math.abs(q[0]);
        }
        for (let i = 1; i <= eob; i++) {
            const v = q[order[i]];
            if (!v) continue;
            w.bool(v < 0 ? 1 : 0);
            if (Math.abs(v) >= 15) w.golomb(Math.abs(v) - 15);
            culLevel += Math.abs(v);
        }
        const resCtx = Math.min(culLevel, 63) | dcSignLevel;
        aArr.fill(resCtx, a, a + ctw);
        lArr.fill(resCtx, l, l + cth);
    }
}

// the level (seq_level_idx) of a picture size: 4.0, 5.0, 6.0 or unconstrained
function level(width: number, height: number): number {
    const area = width * height;
    if (area <= 2228224 && width <= 4096 && height <= 2176) return 8;
    if (area <= 8912896 && width <= 8192 && height <= 4352) return 12;
    if (area <= 35651584 && width <= 16384 && height <= 8704) return 16;
    return 31;
}

/** Encodes an image as an AV1 still picture: a sequence header OBU and a frame OBU */
export function encodeAV1(image: AV1Image, params: AV1Params): Uint8Array {
    const { width, height, layout } = image;
    const bitsFor = (v: number): number => Math.max(1, 32 - Math.clz32(v - 1));
    const seq = {
        profile: layout === 3 ? 1 : 0, reducedStillPicture: true, maxWidth: width, maxHeight: height,
        widthBits: bitsFor(width), heightBits: bitsFor(height), frameIdBits: 0, deltaFrameIdBits: 0,
        decoderModelInfo: false, equalPictureInterval: false, bufferRemovalDelayLength: 0, framePresentationDelayLength: 0,
        operatingPoints: [{ idc: 0, decoderModel: false }], sb128: false, filterIntra: false, intraEdgeFilter: true,
        screenContentTools: 2, forceIntegerMv: 2, orderHintBits: 0, superres: false, cdef: true, restoration: false,
        bitDepth: 8, monochrome: layout === 0, colorPrimaries: image.cicp[0], transferCharacteristics: image.cicp[1],
        matrixCoefficients: image.cicp[2], fullRange: true, ssx: layout === 1 ? 1 : 0, ssy: layout === 1 ? 1 : 0,
        separateUvDeltaQ: false, filmGrain: false
    } satisfies SequenceHeader;
    // tiles: as few as allowed (at most 4096 pixels wide, 4096 x 2304 pixels large)
    const sbw = width + 63 >> 6, sbh = height + 63 >> 6;
    const tileLog2 = (size: number, target: number): number => {
        let k = 0;
        while (size << k < target) k++;
        return k;
    };
    const log2Cols = tileLog2(64, sbw), log2Rows = Math.max(tileLog2(2304, sbw * sbh) - log2Cols, 0);
    const colStarts: number[] = [], rowStarts: number[] = [];
    for (let x = 0; x < sbw; x += 1 + (sbw - 1 >> log2Cols)) colStarts.push(x);
    for (let y = 0; y < sbh; y += 1 + (sbh - 1 >> log2Rows)) rowStarts.push(y);
    const cols = colStarts.length, rows = rowStarts.length;
    colStarts.push(sbw);
    rowStarts.push(sbh);
    const qidx = params.qidx;
    const hdr: FrameHeader = {
        showExistingFrame: false, existingFrameIdx: 0, frameType: 0, showFrame: true, refreshFrameFlags: 0xff,
        disableCdfUpdate: false, allowScreenContentTools: false, allowIntrabc: false, width, upscaledWidth: width, height,
        superresDenominator: 8,
        tiles: { cols, rows, log2Cols, log2Rows, colStarts, rowStarts, contextUpdateId: 0, sizeBytes: 4 },
        quant: { yac: qidx, ydcDelta: 0, udcDelta: 0, uacDelta: 0, vdcDelta: 0, vacDelta: 0, qm: false, qmY: 15, qmU: 15, qmV: 15 },
        segmentation: { enabled: false, updateMap: false, data: [], preskip: false, lastActiveSegId: -1, qidx: new Array<number>(8).fill(qidx), lossless: new Array<boolean>(8).fill(!qidx) },
        allLossless: !qidx,
        deltaQ: { present: false, resLog2: 0 },
        deltaLf: { present: false, resLog2: 0, multi: false },
        loopFilter: { levelY: [0, 0], levelU: 0, levelV: 0, sharpness: 0, modeRefDeltaEnabled: false, refDeltas: [1, 0, 0, 0, -1, 0, -1, -1], modeDeltas: [0, 0] },
        cdef: { damping: 3, bits: 0, yStrengths: [0], uvStrengths: [0] },
        restoration: { types: [RESTORATION_NONE, RESTORATION_NONE, RESTORATION_NONE], unitSizeLog2: [8, 8] },
        txMode: qidx ? 1 : 0, reducedTxSet: false, filmGrain: null
    };
    const f = new Frame(seq, hdr);
    // the source in the frame's layout, the edges repeated up to the 8 pixel aligned size
    const src = f.planes.map((plane, p) => {
        const sx = p && layout === 1 ? 1 : 0, w = width + sx >> sx, h = height + sx >> sx, stride = f.strides[p];
        const pw = f.bw * 4 >> sx, ph = f.bh * 4 >> sx, out = new Uint16Array(plane.length), inp = image.planes[p];
        for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) out[y * stride + x] = inp[Math.min(y, h - 1) * w + Math.min(x, w - 1)];
        return out;
    });

    const encoder = new TileEncoder(f, src, params);
    // the searches, then the filters (with the whole frame reconstructed), then the tiles written
    const nodes: Node[][] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) nodes.push(encoder.searchTile(r, c));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) encoder.storeTile(r, c, nodes[r * cols + c]);
    // (lossless frames aren't filtered)
    if (qidx) chooseFilters(f, src, qidx, params.effort, encoder.cdefChoice);
    f.cdefIdx.fill(-1);
    const tiles: Uint8Array[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tiles.push(encoder.writeTile(r, c, nodes[r * cols + c]));

    const w = new HeaderWriter();
    writeFrameHeader(w, seq, hdr);
    w.align();
    if (cols * rows > 1) w.bit(0);
    w.align();
    const head = w.data();
    let size = head.length;
    for (let i = 0; i < tiles.length; i++) size += tiles[i].length + (i < tiles.length - 1 ? 4 : 0);
    const payload = new Uint8Array(size);
    payload.set(head);
    let o = head.length;
    for (let i = 0; i < tiles.length; i++) {
        if (i < tiles.length - 1) {
            const n = tiles[i].length - 1;
            payload.set([n & 0xff, n >> 8 & 0xff, n >> 16 & 0xff, n >>> 24], o);
            o += 4;
        }
        payload.set(tiles[i], o);
        o += tiles[i].length;
    }
    const seqObu = writeSequenceHeader(seq, level(width, height)), frameObu = obu(OBU_FRAME, payload);
    const out = new Uint8Array(seqObu.length + frameObu.length);
    out.set(seqObu);
    out.set(frameObu, seqObu.length);
    return out;
}

// the squared error of the frame's planes, per 64x64 block: luma, chroma (lengths: the 64x64 blocks)
function blockErrors(f: Frame, planes: Uint16Array[], src: Uint16Array[], ey: Float64Array, euv: Float64Array): void {
    const s64 = f.b4Stride >> 4;
    ey.fill(0);
    euv.fill(0);
    planes.forEach((plane, p) => {
        const sx = p ? f.ssx : 0, sy = p ? f.ssy : 0, w = f.width + sx >> sx, h = f.height + sy >> sy, stride = f.strides[p];
        const out = p ? euv : ey;
        for (let y = 0; y < h; y++) {
            const row = (y << sy >> 6) * s64;
            for (let x = 0; x < w; x++) {
                const d = plane[y * stride + x] - src[p][y * stride + x];
                out[row + (x << sx >> 6)] += d * d;
            }
        }
    });
}

const sum = (a: Float64Array): number => a.reduce((s, v) => s + v, 0);

/**
 * Chooses the loop filter level (around libaom's guess from the quantizer) and the CDEF strengths (a set of up to 8,
 * one per 64x64 block) by the squared error after filtering
 */
function chooseFilters(f: Frame, src: Uint16Array[], qidx: number, effort: number, choice: Int8Array): void {
    const hdr = f.hdr, q = dequant(0, qidx, 1), n = f.cdefIdx.length;
    const recon = f.planes.map(p => p.slice());
    const ey = new Float64Array(n), euv = new Float64Array(n);
    const setLevel = (level: number): void => {
        hdr.loopFilter.levelY = [level, level];
        hdr.loopFilter.levelU = hdr.loopFilter.levelV = level;
        for (let i = 0; i < f.lfLevels.length; i += 4) f.lfLevels.set([level, level, level, level], i);
    };
    // the loop filter
    const guess = Math.max(0, Math.min(63, (q * 20723 + 1015158 + (1 << 17) >> 18) - 4));
    let bestLevel = guess, bestError = Infinity;
    for (const level of [[guess], [guess - 4, guess, guess + 4], [guess - 6, guess - 3, guess, guess + 3, guess + 6]][effort]) {
        if (level < 0 || level > 63) continue;
        setLevel(level);
        f.planes = recon.map(p => p.slice());
        deblock(f);
        blockErrors(f, f.planes, src, ey, euv);
        const e = sum(ey) + sum(euv);
        if (e < bestError) {
            bestError = e;
            bestLevel = level;
        }
    }
    setLevel(bestLevel);
    f.planes = recon.map(p => p.slice());
    deblock(f);
    const deblocked = f.planes;

    // CDEF: each candidate strength's errors per 64x64 block (luma, chroma), of the blocks with coefficients
    const strengths = [[0, 5, 9, 17, 33], [0, 1, 4, 5, 9, 17, 33, 61], [0, 1, 4, 5, 8, 9, 13, 17, 25, 33, 41, 61]][effort];
    const errY = strengths.map(() => new Float64Array(n)), errUv = strengths.map(() => new Float64Array(n));
    const coded = Array.from(f.cdefIdx, i => i >= 0), dirs = new Int32Array(f.b4Stride * (f.bh + 1)).fill(-1);
    strengths.forEach((strength, k) => {
        hdr.cdef.yStrengths = [strength];
        hdr.cdef.uvStrengths = [strength];
        f.planes = deblocked.map(p => p.slice());
        f.cdefIdx.set(Int8Array.from(coded, c => c ? 0 : -1));
        if (strength) cdef(f, deblocked, dirs);
        blockErrors(f, f.planes, src, errY[k], errUv[k]);
    });
    // a set of (luma, chroma) strength pairs, added greedily; the size with the least error and signaling
    const lambda = 0.08 * (q / 8) ** 2, blocks = coded.filter(c => c).length;
    const pairs: number[][] = [];
    for (let y = 0; y < strengths.length; y++) for (let u = 0; u < strengths.length; u++) pairs.push([y, u]);
    const costOf = (set: number[][]): number => {
        let e = 0;
        for (let i = 0; i < n; i++) {
            if (!coded[i]) continue;
            let m = Infinity;
            for (const [y, u] of set) m = Math.min(m, errY[y][i] + errUv[u][i]);
            e += m;
        }
        return e;
    };
    let set: number[][] = [], best: number[][] = [[0, 0]], bestCost = Infinity;
    for (let bits = 0; bits <= (effort ? 3 : 1); bits++) {
        while (set.length < 1 << bits) {
            let add = pairs[0], addCost = Infinity;
            for (const pair of pairs) {
                const c = costOf([...set, pair]);
                if (c < addCost) {
                    addCost = c;
                    add = pair;
                }
            }
            set = [...set, add];
        }
        const cost = costOf(set) + lambda * (bits * blocks + 12 * set.length);
        if (cost < bestCost) {
            bestCost = cost;
            best = set.slice();
        }
    }
    hdr.cdef.bits = Math.log2(best.length);
    hdr.cdef.yStrengths = best.map(([y]) => strengths[y]);
    hdr.cdef.uvStrengths = best.map(([, u]) => strengths[u]);
    for (let i = 0; i < n; i++) {
        let m = Infinity;
        best.forEach(([y, u], k) => {
            const e = errY[y][i] + errUv[u][i];
            if (e < m) {
                m = e;
                choice[i] = k;
            }
        });
    }
    f.planes = recon;
}
