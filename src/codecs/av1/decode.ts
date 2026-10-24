/*!
 * Decodes the tiles of AV1 intra frames: partitions, modes, palettes, transform sizes, coefficients and the intra
 * reconstruction, ported from dav1d (src/decode.c, src/recon_tmpl.c, src/lf_mask.c). Copyright (c) 2018-2021,
 * VideoLAN and dav1d authors, Copyright (c) 2018, Two Orioles, LLC, BSD-2-Clause License (see THIRD_PARTY_NOTICES.md)
 */

import { SymbolDecoder } from './msac.ts';
import { SequenceHeader, FrameHeader, RESTORATION_NONE, RESTORATION_SWITCHABLE, RESTORATION_WIENER, RESTORATION_SGRPROJ } from './obu.ts';
import {
    CDF, BLOCK_DIMENSIONS, TXFM_DIMENSIONS, MAX_TXFM_SIZE_FOR_BS, AL_PART_CTX, BLOCK_SIZES, PARTITION_TYPE_COUNT,
    INTRA_MODE_CONTEXT, TXTP_FROM_UVMODE, TX_TYPES_PER_SET, FILTER_MODE_TO_Y_MODE, LO_CTX_OFFSETS, SKIP_CTX, TX_TYPE_CLASS,
    SGR_PARAMS, CFL_ALLOWED_MASK, BL_128X128, BL_8X8, BS_128x128, BS_64x64, BS_4x4,
    PARTITION_NONE, PARTITION_H, PARTITION_V, PARTITION_SPLIT, PARTITION_T_TOP_SPLIT, PARTITION_T_BOTTOM_SPLIT,
    PARTITION_T_LEFT_SPLIT, PARTITION_T_RIGHT_SPLIT, PARTITION_H4, PARTITION_V4,
    DC_PRED, VERT_PRED, VERT_LEFT_PRED, SMOOTH_PRED, SMOOTH_V_PRED, SMOOTH_H_PRED, CFL_PRED, FILTER_PRED,
    TX_4X4, TX_64X64, TX_16X16, TX_32X32, RTX_4X8, DCT_DCT, IDTX, WHT_WHT, TX_CLASS_2D, TX_CLASS_H,
    EDGE_ALL_TR_AND_BL, EDGE_ALL_TOP_HAS_RIGHT, EDGE_ALL_LEFT_HAS_BOTTOM, EDGE_I444_TOP_HAS_RIGHT,
    EDGE_I444_LEFT_HAS_BOTTOM, EDGE_I420_TOP_HAS_RIGHT, EDGE_I420_LEFT_HAS_BOTTOM,
    EdgeNode, edgeTree, defaultCdfs, scan, dequant, quantizerMatrix
} from './tables.ts';
import { prepareEdges, predict, preparedAngle, cflAc, cflPredict, ANGLE_USE_EDGE_FILTER, ANGLE_SMOOTH_EDGE } from './ipred.ts';
import { inverseTransformAdd } from './itx.ts';


const bdim = (bs: number, i: number): number => BLOCK_DIMENSIONS[bs * 4 + i];
const tdim = (tx: number, i: number): number => TXFM_DIMENSIONS[tx * 8 + i];
// TxfmInfo fields
const W = 0, H = 1, LW = 2, LH = 3, MIN = 4, MAX = 5, SUB = 6, CTX = 7;

/** A restoration unit's filter: its type, Wiener coefficients, self guided weights */
export interface RestorationUnit {
    type: number;
    filterV: number[];
    filterH: number[];
    sgrWeights: number[];
}

/** The decoded frame: its planes (16 bit, padded), and what the post filters need per 4x4 block */
export class Frame {
    width: number;
    height: number;
    bitdepth: number;
    bitdepthMax: number;
    /** 0: monochrome, 1: 4:2:0, 2: 4:2:2, 3: 4:4:4 (dav1d's layouts) */
    layout: number;
    ssx: number;
    ssy: number;
    planes: Uint16Array[] = [];
    strides: number[] = [];
    /** width and height in 4 pixel units, rounded to 8 pixels (dav1d's bw, bh) */
    bw: number;
    bh: number;
    b4Stride: number;
    /** per 4x4 block: the loop filter levels (4 per block: luma vertical edges, luma horizontal, u, v) */
    lfLevels: Uint8Array;
    /** per 4x4 block: the luma transform size's log2 width and height (in 4 pixel units) */
    txW: Uint8Array;
    txH: Uint8Array;
    /** per chroma 4x4 block: the chroma transform size's log2 width and height */
    uvTxW: Uint8Array;
    uvTxH: Uint8Array;
    /** per 4x4 block: whether it has no coefficients */
    skip: Uint8Array;
    /** per 64x64 block: the CDEF strength index, -1 for none */
    cdefIdx: Int8Array;
    segMap: Uint8Array;
    /** per plane: the restoration units (rows of units) */
    lr: RestorationUnit[][] = [[], [], []];
    lrUnitsW = [0, 0, 0];
    lrUnitsH = [0, 0, 0];
    /** set when the frame of a higher spatial layer couldn't be decoded (it uses inter prediction) */
    incomplete = false;

    constructor(public seq: SequenceHeader, public hdr: FrameHeader) {
        this.width = hdr.width;
        this.height = hdr.height;
        this.bitdepth = seq.bitDepth;
        this.bitdepthMax = (1 << seq.bitDepth) - 1;
        this.layout = seq.monochrome ? 0 : seq.ssx ? seq.ssy ? 1 : 2 : 3;
        this.ssx = seq.ssx;
        this.ssy = seq.ssy;
        this.bw = (hdr.width + 7 >> 3) << 1;
        this.bh = (hdr.height + 7 >> 3) << 1;
        this.b4Stride = this.bw + 31 & ~31;
        const b4Rows = this.bh + 31 & ~31;
        const lumaStride = this.b4Stride * 4, lumaRows = b4Rows * 4;
        for (let p = 0; p < (seq.monochrome ? 1 : 3); p++) {
            const sx = p ? this.ssx : 0, sy = p ? this.ssy : 0;
            this.strides.push(lumaStride >> sx);
            this.planes.push(new Uint16Array((lumaStride >> sx) * (lumaRows >> sy)));
        }
        const n = this.b4Stride * b4Rows;
        this.lfLevels = new Uint8Array(n * 4);
        this.txW = new Uint8Array(n);
        this.txH = new Uint8Array(n);
        this.uvTxW = new Uint8Array(n);
        this.uvTxH = new Uint8Array(n);
        this.skip = new Uint8Array(n);
        this.segMap = new Uint8Array(n);
        this.cdefIdx = new Int8Array((this.b4Stride >> 4) * (b4Rows >> 4)).fill(-1);
    }
}

// per block: what decodeB reads
interface Block {
    segId: number;
    skip: number;
    yMode: number;
    yAngle: number;
    uvMode: number;
    uvAngle: number;
    cflAlpha: number[];
    palSz: number[];
    tx: number;
    uvtx: number;
}

/** the levels of the loop filter (dav1d_calc_lf_values, for intra blocks): [segment][direction] */
function calcLfLevels(hdr: FrameHeader, delta: number[]): number[][] {
    const lf = hdr.loopFilter;
    const out: number[][] = [];
    const value = (base: number, lfDelta: number, segDelta: number): number => {
        const b = Math.min(63, Math.max(0, Math.min(63, Math.max(0, base + lfDelta)) + segDelta));
        if (!lf.modeRefDeltaEnabled) return b;
        return Math.min(63, Math.max(0, b + lf.refDeltas[0] * (1 << (b >= 32 ? 1 : 0))));
    };
    for (let s = 0; s < (hdr.segmentation.enabled ? 8 : 1); s++) {
        if (!lf.levelY[0] && !lf.levelY[1]) {
            out.push([0, 0, 0, 0]);
            continue;
        }
        const seg = hdr.segmentation.enabled ? hdr.segmentation.data[s].deltaLf : [0, 0, 0, 0];
        const multi = hdr.deltaLf.multi;
        out.push([
            value(lf.levelY[0], delta[0], seg[0]),
            value(lf.levelY[1], delta[multi ? 1 : 0], seg[1]),
            lf.levelU ? value(lf.levelU, delta[multi ? 2 : 0], seg[2]) : 0,
            lf.levelV ? value(lf.levelV, delta[multi ? 3 : 0], seg[3]) : 0
        ]);
    }
    return out;
}

/** the dequantizers [segment][plane][dc, ac] for a qindex (init_quant_tables) */
function quantTables(seq: SequenceHeader, hdr: FrameHeader, qidx: number): number[][][] {
    const q = hdr.quant, hbd = seq.bitDepth === 8 ? 0 : seq.bitDepth === 10 ? 1 : 2;
    const clip = (v: number): number => Math.min(255, Math.max(0, v));
    const out: number[][][] = [];
    for (let i = 0; i < (hdr.segmentation.enabled ? 8 : 1); i++) {
        const yac = hdr.segmentation.enabled ? clip(qidx + hdr.segmentation.data[i].deltaQ) : qidx;
        out.push([
            [dequant(hbd, clip(yac + q.ydcDelta), 0), dequant(hbd, yac, 1)],
            [dequant(hbd, clip(yac + q.udcDelta), 0), dequant(hbd, clip(yac + q.uacDelta), 1)],
            [dequant(hbd, clip(yac + q.vdcDelta), 0), dequant(hbd, clip(yac + q.vacDelta), 1)]
        ]);
    }
    return out;
}

const neg_deinterleave = (diff: number, ref: number, max: number): number => {
    if (!ref) return diff;
    if (ref >= max - 1) return max - diff - 1;
    if (2 * ref < max) {
        if (diff <= 2 * ref) return diff & 1 ? ref + (diff + 1 >> 1) : ref - (diff >> 1);
        return diff;
    }
    if (diff <= 2 * (max - ref - 1)) return diff & 1 ? ref + (diff + 1 >> 1) : ref - (diff >> 1);
    return max - (diff + 1);
};

/** Decodes a tile group: its data spans [start, end) and holds the tiles first..last (with their sizes) */
export function decodeTileGroup(decoder: TileDecoder, data: Uint8Array, start: number, end: number, first: number, last: number): void {
    const hdr = decoder.frame.hdr;
    let o = start;
    for (let j = first; j <= last; j++) {
        let size: number;
        if (j === last) size = end - o;
        else {
            size = 0;
            for (let k = 0; k < hdr.tiles.sizeBytes; k++) size += data[o++] * 2 ** (k * 8);
            size++;
            if (o + size > end) throw new Error('AV1: invalid tile size');
        }
        decoder.decodeTile(data, o, o + size, Math.floor(j / hdr.tiles.cols), j % hdr.tiles.cols);
        o += size;
    }
}

/** Decodes tiles (keeping the above contexts of a tile row) */
export class TileDecoder {
    private seq: SequenceHeader;
    private hdr: FrameHeader;
    private msac!: SymbolDecoder;
    private cdf!: Uint16Array;
    private bx = 0;
    private by = 0;
    private colStart = 0;
    private colEnd = 0;
    private rowStart = 0;
    private rowEnd = 0;
    private lastQidx = 0;
    private lastDeltaLf = [0, 0, 0, 0];
    private dq: number[][][];
    private frameDq: number[][][];
    private lfLvl: number[][];
    private frameLfLvl: number[][];
    private lrRef: RestorationUnit[] = [];
    private cdefSb = 0;

    // above contexts (by absolute 4x4 column) and left ones (by 4x4 row in the superblock row)
    private aMode: Uint8Array; private lMode = new Uint8Array(32);
    private aLcoef: Uint8Array; private lLcoef = new Uint8Array(32);
    private aCcoef: Uint8Array[]; private lCcoef = [new Uint8Array(32), new Uint8Array(32)];
    private aSegPred: Uint8Array; private lSegPred = new Uint8Array(32);
    private aSkip: Uint8Array; private lSkip = new Uint8Array(32);
    private aIntra: Uint8Array; private lIntra = new Uint8Array(32);
    private aTxIntra: Int8Array; private lTxIntra = new Int8Array(32);
    private aTx: Int8Array; private lTx = new Int8Array(32);
    private aUvmode: Uint8Array; private lUvmode = new Uint8Array(32);
    private aPalSz: Uint8Array; private lPalSz = new Uint8Array(32);
    private aPalSzUv: Uint8Array; private lPalSzUv = new Uint8Array(32);
    private aPartition: Uint8Array; private lPartition = new Uint8Array(16);
    // palettes of the neighbours: [position][plane][8]
    private aPal: Uint16Array; private lPal = new Uint16Array(32 * 24);

    private pal = new Uint16Array(24);
    private palIdxY = new Uint8Array(64 * 64);
    private palIdxUv = new Uint8Array(64 * 64);
    private palTmp = new Uint8Array(64 * 64);
    private cf = new Int32Array(32 * 32);
    private levels = new Uint8Array(36 * 36);
    private ac = new Int16Array(32 * 32);
    private qm: Array<Array<Uint8Array | null>> = [];

    constructor(public frame: Frame) {
        this.seq = frame.seq;
        this.hdr = frame.hdr;
        const n = frame.b4Stride + 32;
        this.aMode = new Uint8Array(n);
        this.aLcoef = new Uint8Array(n);
        this.aCcoef = [new Uint8Array(n), new Uint8Array(n)];
        this.aSegPred = new Uint8Array(n);
        this.aSkip = new Uint8Array(n);
        this.aIntra = new Uint8Array(n);
        this.aTxIntra = new Int8Array(n);
        this.aTx = new Int8Array(n);
        this.aUvmode = new Uint8Array(n);
        this.aPalSz = new Uint8Array(n);
        this.aPalSzUv = new Uint8Array(n);
        this.aPartition = new Uint8Array(n >> 1);
        this.aPal = new Uint16Array(n * 24);
        this.frameDq = this.dq = quantTables(this.seq, this.hdr, this.hdr.quant.yac);
        this.frameLfLvl = this.lfLvl = calcLfLevels(this.hdr, [0, 0, 0, 0]);
        for (let tx = 0; tx < 19; tx++) {
            const q = this.hdr.quant;
            this.qm.push(q.qm ? [q.qmY, q.qmU, q.qmV].map((level, p) => level < 15 ? quantizerMatrix(level, p ? 1 : 0, tx) : null) : [null, null, null]);
        }
        this.resetAbove(0, n);
        if (this.hdr.allowIntrabc) {
            const size = frame.b4Stride * ((frame.bh + 31 & ~31) + 32);
            this.mvY = new Int16Array(size);
            this.mvX = new Int16Array(size);
            this.mvValid = new Uint8Array(size);
            this.mvBs = new Uint8Array(size);
        }

        // the restoration units of each plane
        for (let p = 0; p < frame.planes.length; p++) {
            const type = this.hdr.restoration.types[p];
            if (type === RESTORATION_NONE) continue;
            const sx = p ? frame.ssx : 0, sy = p ? frame.ssy : 0;
            const size = 1 << this.hdr.restoration.unitSizeLog2[p ? 1 : 0];
            const w = this.hdr.upscaledWidth + sx >> sx, h = frame.height + sy >> sy;
            const cols = Math.max(1, Math.floor((w + (size >> 1)) / size)), rows = Math.max(1, Math.floor((h + (size >> 1)) / size));
            frame.lrUnitsW[p] = cols;
            frame.lrUnitsH[p] = rows;
            for (let i = 0; i < cols * rows; i++) frame.lr[p].push({ type: RESTORATION_NONE, filterV: [3, -7, 15], filterH: [3, -7, 15], sgrWeights: [-32, 31] });
        }
    }

    // resets the above contexts of a tile row
    private resetAbove(from: number, to: number): void {
        this.aIntra.fill(1, from, to);
        this.aUvmode.fill(DC_PRED, from, to);
        this.aMode.fill(DC_PRED, from, to);
        this.aPartition.fill(0, from >> 1, to + 1 >> 1);
        this.aSkip.fill(0, from, to);
        this.aTxIntra.fill(-1, from, to);
        this.aTx.fill(TX_64X64, from, to);
        this.aLcoef.fill(0x40, from, to);
        this.aCcoef[0].fill(0x40, from, to);
        this.aCcoef[1].fill(0x40, from, to);
        this.aSegPred.fill(0, from, to);
        this.aPalSz.fill(0, from, to);
        this.aPalSzUv.fill(0, from, to);
    }

    private resetLeft(): void {
        this.lIntra.fill(1);
        this.lUvmode.fill(DC_PRED);
        this.lMode.fill(DC_PRED);
        this.lPartition.fill(0);
        this.lSkip.fill(0);
        this.lTxIntra.fill(-1);
        this.lTx.fill(TX_64X64);
        this.lLcoef.fill(0x40);
        this.lCcoef[0].fill(0x40);
        this.lCcoef[1].fill(0x40);
        this.lSegPred.fill(0);
        this.lPalSz.fill(0);
        this.lPalSzUv.fill(0);
    }

    private tileRow = -1;

    /** decodes a tile: its data spans [start, end) */
    decodeTile(data: Uint8Array, start: number, end: number, tileRow: number, tileCol: number): void {
        const f = this.frame, hdr = this.hdr, seq = this.seq;
        if (tileRow !== this.tileRow) {
            // every tile row starts with fresh above contexts
            this.tileRow = tileRow;
            this.resetAbove(0, this.aMode.length);
        }
        const sbShift = seq.sb128 ? 5 : 4, sbStep = 1 << sbShift;
        this.colStart = hdr.tiles.colStarts[tileCol] << sbShift;
        this.colEnd = Math.min(hdr.tiles.colStarts[tileCol + 1] << sbShift, f.bw);
        this.rowStart = hdr.tiles.rowStarts[tileRow] << sbShift;
        this.rowEnd = Math.min(hdr.tiles.rowStarts[tileRow + 1] << sbShift, f.bh);
        this.cdf = defaultCdfs(hdr.quant.yac);
        this.msac = new SymbolDecoder(data, start, end, !hdr.disableCdfUpdate);
        this.lastQidx = hdr.quant.yac;
        this.lastDeltaLf = [0, 0, 0, 0];
        this.dq = this.frameDq;
        this.lfLvl = this.frameLfLvl;
        // the reference restoration unit of each plane
        for (let p = 0; p < 3; p++) this.lrRef[p] = { type: RESTORATION_NONE, filterV: [3, -7, 15], filterH: [3, -7, 15], sgrWeights: [-32, 31] };

        const root = edgeTree(seq.sb128);
        for (this.by = this.rowStart; this.by < this.rowEnd; this.by += sbStep) {
            this.resetLeft();
            for (this.bx = this.colStart; this.bx < this.colEnd; this.bx += sbStep) {
                // the CDEF index of the 64x64 blocks of this superblock is read with their first coded block
                this.cdefSb = (this.by >> 4) * (f.b4Stride >> 4) + (this.bx >> 4);
                this.readRestorationUnits();
                this.decodeSb(seq.sb128 ? BL_128X128 : 1, root);
            }
        }
        if (this.msac.overread) throw new Error('AV1: truncated tile data');
    }

    // reads the restoration units that start in this superblock
    private readRestorationUnits(): void {
        const f = this.frame, hdr = this.hdr;
        if (hdr.superresDenominator !== 8 && hdr.restoration.types.some(t => t)) {
            this.readRestorationUnitsSuperres();
            return;
        }
        for (let p = 0; p < f.planes.length; p++) {
            const type = hdr.restoration.types[p];
            if (type === RESTORATION_NONE) continue;
            const sx = p ? f.ssx : 0, sy = p ? f.ssy : 0;
            const sizeLog2 = hdr.restoration.unitSizeLog2[p ? 1 : 0], size = 1 << sizeLog2, mask = size - 1;
            const y = this.by * 4 >> sy, h = f.height + sy >> sy;
            if (y & mask) continue;
            if (y && y + (size >> 1) > h) continue;
            const x = this.bx * 4 >> sx, w = f.width + sx >> sx;
            if (x & mask) continue;
            if (x && x + (size >> 1) > w) continue;
            const unit = f.lr[p][(y >> sizeLog2) * f.lrUnitsW[p] + (x >> sizeLog2)];
            this.readRestorationInfo(unit, p, type);
        }
    }

    // with superres the units are in the upscaled frame: those whose left edge is in this superblock
    private readRestorationUnitsSuperres(): void {
        const f = this.frame, hdr = this.hdr;
        const sbStep = this.seq.sb128 ? 32 : 16;
        for (let p = 0; p < f.planes.length; p++) {
            const type = hdr.restoration.types[p];
            if (type === RESTORATION_NONE) continue;
            const sx = p ? f.ssx : 0, sy = p ? f.ssy : 0;
            const sizeLog2 = hdr.restoration.unitSizeLog2[p ? 1 : 0], size = 1 << sizeLog2;
            const y = this.by * 4 >> sy, h = f.height + sy >> sy;
            if (y & size - 1) continue;
            if (y && y + (size >> 1) > h) continue;
            const d = hdr.superresDenominator;
            const rnd = size * 8 - 1, shift = sizeLog2 + 3;
            const x0 = (4 * this.bx * d >> sx) + rnd >> shift;
            const x1 = (4 * (this.bx + sbStep) * d >> sx) + rnd >> shift;
            for (let x = x0; x < Math.min(x1, f.lrUnitsW[p]); x++) {
                const unit = f.lr[p][(y >> sizeLog2) * f.lrUnitsW[p] + x];
                this.readRestorationInfo(unit, p, type);
            }
        }
    }

    private readRestorationInfo(lr: RestorationUnit, p: number, frameType: number): void {
        const m = this.msac, cdf = this.cdf;
        if (frameType === RESTORATION_SWITCHABLE) {
            const filter = m.symbol(cdf, CDF.restoreSwitchable, 2);
            lr.type = filter ? filter + 1 : RESTORATION_NONE;
        } else {
            const type = m.boolAdapt(cdf, frameType === RESTORATION_WIENER ? CDF.restoreWiener : CDF.restoreSgrproj);
            lr.type = type ? frameType : RESTORATION_NONE;
        }
        const ref = this.lrRef[p];
        if (lr.type === RESTORATION_WIENER) {
            lr.filterV = [
                p ? 0 : m.subexp(ref.filterV[0] + 5, 16, 1) - 5,
                m.subexp(ref.filterV[1] + 23, 32, 2) - 23,
                m.subexp(ref.filterV[2] + 17, 64, 3) - 17
            ];
            lr.filterH = [
                p ? 0 : m.subexp(ref.filterH[0] + 5, 16, 1) - 5,
                m.subexp(ref.filterH[1] + 23, 32, 2) - 23,
                m.subexp(ref.filterH[2] + 17, 64, 3) - 17
            ];
            lr.sgrWeights = ref.sgrWeights.slice();
            this.lrRef[p] = lr;
        } else if (lr.type === RESTORATION_SGRPROJ) {
            const idx = m.bools(4);
            lr.type += idx;
            lr.sgrWeights = [
                SGR_PARAMS[idx * 2] ? m.subexp(ref.sgrWeights[0] + 96, 128, 4) - 96 : 0,
                SGR_PARAMS[idx * 2 + 1] ? m.subexp(ref.sgrWeights[1] + 32, 128, 4) - 32 : 95
            ];
            lr.filterV = ref.filterV.slice();
            lr.filterH = ref.filterH.slice();
            this.lrRef[p] = lr;
        }
    }

    private decodeSb(bl: number, node: EdgeNode): void {
        const f = this.frame;
        const hsz = 16 >> bl;
        const haveH = f.bw > this.bx + hsz, haveV = f.bh > this.by + hsz;
        if (!haveH && !haveV) return this.decodeSb(bl + 1, node.split[0]);

        const bx8 = this.bx >> 1, by8 = (this.by & 31) >> 1;
        const ctx = (this.aPartition[bx8] >> (4 - bl) & 1) + ((this.lPartition[by8] >> (4 - bl) & 1) << 1);
        const pc = CDF.partition + (bl * 4 + ctx) * 16;
        const cdf = this.cdf;
        let bp: number;

        if (haveH && haveV) {
            bp = this.msac.symbol(cdf, pc, PARTITION_TYPE_COUNT[bl]);
            if (f.layout === 2 && (bp === PARTITION_V || bp === PARTITION_V4 || bp === PARTITION_T_LEFT_SPLIT || bp === PARTITION_T_RIGHT_SPLIT)) throw new Error('AV1: invalid partition');
            const b = (i: number): number => BLOCK_SIZES[(bl * 10 + bp) * 2 + i];
            switch (bp) {
                case PARTITION_NONE:
                    this.decodeB(b(0), node.o);
                    break;
                case PARTITION_H:
                    this.decodeB(b(0), node.h[0]);
                    this.by += hsz;
                    this.decodeB(b(0), node.h[1]);
                    this.by -= hsz;
                    break;
                case PARTITION_V:
                    this.decodeB(b(0), node.v[0]);
                    this.bx += hsz;
                    this.decodeB(b(0), node.v[1]);
                    this.bx -= hsz;
                    break;
                case PARTITION_SPLIT:
                    if (bl === BL_8X8) {
                        this.decodeB(BS_4x4, EDGE_ALL_TR_AND_BL);
                        this.bx++;
                        this.decodeB(BS_4x4, node.tip[0]);
                        this.bx--;
                        this.by++;
                        this.decodeB(BS_4x4, node.tip[1]);
                        this.bx++;
                        this.decodeB(BS_4x4, node.tip[2]);
                        this.bx--;
                        this.by--;
                    } else {
                        this.decodeSb(bl + 1, node.split[0]);
                        this.bx += hsz;
                        this.decodeSb(bl + 1, node.split[1]);
                        this.bx -= hsz;
                        this.by += hsz;
                        this.decodeSb(bl + 1, node.split[2]);
                        this.bx += hsz;
                        this.decodeSb(bl + 1, node.split[3]);
                        this.bx -= hsz;
                        this.by -= hsz;
                    }
                    break;
                case PARTITION_T_TOP_SPLIT:
                    this.decodeB(b(0), EDGE_ALL_TR_AND_BL);
                    this.bx += hsz;
                    this.decodeB(b(0), node.v[1]);
                    this.bx -= hsz;
                    this.by += hsz;
                    this.decodeB(b(1), node.h[1]);
                    this.by -= hsz;
                    break;
                case PARTITION_T_BOTTOM_SPLIT:
                    this.decodeB(b(0), node.h[0]);
                    this.by += hsz;
                    this.decodeB(b(1), node.v[0]);
                    this.bx += hsz;
                    this.decodeB(b(1), 0);
                    this.bx -= hsz;
                    this.by -= hsz;
                    break;
                case PARTITION_T_LEFT_SPLIT:
                    this.decodeB(b(0), EDGE_ALL_TR_AND_BL);
                    this.by += hsz;
                    this.decodeB(b(0), node.h[1]);
                    this.by -= hsz;
                    this.bx += hsz;
                    this.decodeB(b(1), node.v[1]);
                    this.bx -= hsz;
                    break;
                case PARTITION_T_RIGHT_SPLIT:
                    this.decodeB(b(0), node.v[0]);
                    this.bx += hsz;
                    this.decodeB(b(1), node.h[0]);
                    this.by += hsz;
                    this.decodeB(b(1), 0);
                    this.by -= hsz;
                    this.bx -= hsz;
                    break;
                case PARTITION_H4:
                    this.decodeB(b(0), node.h[0]);
                    this.by += hsz >> 1;
                    this.decodeB(b(0), node.h4);
                    this.by += hsz >> 1;
                    this.decodeB(b(0), EDGE_ALL_LEFT_HAS_BOTTOM);
                    this.by += hsz >> 1;
                    if (this.by < f.bh) this.decodeB(b(0), node.h[1]);
                    this.by -= hsz * 3 >> 1;
                    break;
                case PARTITION_V4:
                    this.decodeB(b(0), node.v[0]);
                    this.bx += hsz >> 1;
                    this.decodeB(b(0), node.v4);
                    this.bx += hsz >> 1;
                    this.decodeB(b(0), EDGE_ALL_TOP_HAS_RIGHT);
                    this.bx += hsz >> 1;
                    if (this.bx < f.bw) this.decodeB(b(0), node.v[1]);
                    this.bx -= hsz * 3 >> 1;
                    break;
            }
        } else if (haveH) {
            // gather_top_partition_prob: split or horizontal
            let prob = cdf[pc + PARTITION_V - 1] - cdf[pc + PARTITION_T_TOP_SPLIT];
            prob += cdf[pc + PARTITION_T_LEFT_SPLIT - 1];
            if (bl !== BL_128X128) prob += cdf[pc + PARTITION_V4 - 1] - cdf[pc + PARTITION_T_RIGHT_SPLIT];
            const split = this.msac.boolProb(prob);
            if (split) {
                bp = PARTITION_SPLIT;
                this.decodeSb(bl + 1, node.split[0]);
                this.bx += hsz;
                this.decodeSb(bl + 1, node.split[1]);
                this.bx -= hsz;
            } else {
                bp = PARTITION_H;
                this.decodeB(BLOCK_SIZES[(bl * 10 + PARTITION_H) * 2], node.h[0]);
            }
        } else {
            // gather_left_partition_prob: split or vertical
            let prob = cdf[pc + PARTITION_H - 1] - cdf[pc + PARTITION_H];
            prob += cdf[pc + PARTITION_SPLIT - 1] - cdf[pc + PARTITION_T_LEFT_SPLIT];
            if (bl !== BL_128X128) prob += cdf[pc + PARTITION_H4 - 1] - cdf[pc + PARTITION_H4];
            const split = this.msac.boolProb(prob);
            if (f.layout === 2 && !split) throw new Error('AV1: invalid partition');
            if (split) {
                bp = PARTITION_SPLIT;
                this.decodeSb(bl + 1, node.split[0]);
                this.by += hsz;
                this.decodeSb(bl + 1, node.split[2]);
                this.by -= hsz;
            } else {
                bp = PARTITION_V;
                this.decodeB(BLOCK_SIZES[(bl * 10 + PARTITION_V) * 2], node.v[0]);
            }
        }

        if (bp !== PARTITION_SPLIT || bl === BL_8X8) {
            this.aPartition.fill(AL_PART_CTX[bl * 10 + bp], bx8, bx8 + hsz);
            this.lPartition.fill(AL_PART_CTX[50 + bl * 10 + bp], by8, by8 + hsz);
        }
    }

    private decodeB(bs: number, edgeFlags: number): void {
        const f = this.frame, hdr = this.hdr, seq = this.seq, m = this.msac, cdf = this.cdf;
        const bx = this.bx, by = this.by, bx4 = bx, by4 = by & 31;
        const ssx = f.ssx, ssy = f.ssy;
        const cbx4 = bx4 >> ssx, cby4 = by4 >> ssy;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1), lw4 = bdim(bs, 2), lh4 = bdim(bs, 3);
        const w4 = Math.min(bw4, f.bw - bx), h4 = Math.min(bh4, f.bh - by);
        const cbw4 = bw4 + ssx >> ssx, cbh4 = bh4 + ssy >> ssy;
        const haveLeft = bx > this.colStart, haveTop = by > this.rowStart;
        const hasChroma = f.layout !== 0 && (bw4 > ssx || !!(bx & 1)) && (bh4 > ssy || !!(by & 1));

        const b: Block = { segId: 0, skip: 0, yMode: 0, yAngle: 0, uvMode: 0, uvAngle: 0, cflAlpha: [0, 0], palSz: [0, 0], tx: 0, uvtx: 0 };
        const segmentation = hdr.segmentation;
        let seg = null as null | typeof segmentation.data[0];
        const readSegId = (): void => {
            // predicted from the neighbours' segments
            const map = f.segMap, s = f.b4Stride, o = by * s + bx;
            let segCtx: number, pred: number;
            if (haveLeft && haveTop) {
                const l = map[o - 1], a = map[o - s], al = map[o - s - 1];
                segCtx = l === a && al === l ? 2 : l === a || al === l || a === al ? 1 : 0;
                pred = a === al ? a : l;
            } else {
                segCtx = 0;
                pred = haveLeft ? map[o - 1] : haveTop ? map[o - s] : 0;
            }
            if (b.skip && !segmentation.preskip) b.segId = pred;
            else {
                const diff = m.symbol(cdf, CDF.segId + segCtx * 8, 7);
                b.segId = neg_deinterleave(diff, pred, segmentation.lastActiveSegId + 1);
                if (b.segId > segmentation.lastActiveSegId) b.segId = 0;
            }
            if (b.segId >= 8) b.segId = 0;
        };
        if (segmentation.enabled && segmentation.preskip) {
            readSegId();
            seg = segmentation.data[b.segId];
        }

        // skip
        if (seg?.skip) b.skip = 1;
        else {
            b.skip = m.boolAdapt(cdf, CDF.skip + (this.aSkip[bx4] + this.lSkip[by4]) * 2);
        }

        if (segmentation.enabled && !segmentation.preskip) readSegId();

        // cdef index, read with the first coded block of each 64x64 block
        if (!b.skip) {
            const idx = seq.sb128 ? this.cdefSb + (bx >> 4 & 1) + (by >> 4 & 1) * (f.b4Stride >> 4) : this.cdefSb;
            if (f.cdefIdx[idx] === -1) {
                const v = m.bools(hdr.cdef.bits);
                f.cdefIdx[idx] = v;
                const stride = f.b4Stride >> 4;
                if (bw4 > 16) f.cdefIdx[idx + 1] = v;
                if (bh4 > 16) f.cdefIdx[idx + stride] = v;
                if (bw4 === 32 && bh4 === 32) f.cdefIdx[idx + stride + 1] = v;
            }
        }

        // delta q and lf, at the start of each superblock
        const sbMask = seq.sb128 ? 31 : 15;
        if (!(bx & sbMask) && !(by & sbMask)) {
            const prevQidx = this.lastQidx;
            const prevDeltaLf = this.lastDeltaLf.join();
            if (hdr.deltaQ.present && (bs !== (seq.sb128 ? BS_128x128 : BS_64x64) || !b.skip)) {
                const readDelta = (o: number): number => {
                    let d = m.symbol(cdf, o, 3);
                    if (d === 3) {
                        const n = 1 + m.bools(3);
                        d = m.bools(n) + 1 + (1 << n);
                    }
                    return d;
                };
                let deltaQ = readDelta(CDF.deltaQ);
                if (deltaQ) {
                    if (m.bool()) deltaQ = -deltaQ;
                    deltaQ *= 1 << hdr.deltaQ.resLog2;
                }
                this.lastQidx = Math.min(255, Math.max(1, this.lastQidx + deltaQ));
                if (hdr.deltaLf.present) {
                    const n = hdr.deltaLf.multi ? f.layout ? 4 : 2 : 1;
                    for (let i = 0; i < n; i++) {
                        let d = readDelta(CDF.deltaLf + (i + (hdr.deltaLf.multi ? 1 : 0)) * 4);
                        if (d) {
                            if (m.bool()) d = -d;
                            d *= 1 << hdr.deltaLf.resLog2;
                        }
                        this.lastDeltaLf[i] = Math.min(63, Math.max(-63, this.lastDeltaLf[i] + d));
                    }
                }
            }
            if (this.lastQidx === hdr.quant.yac) this.dq = this.frameDq;
            else if (this.lastQidx !== prevQidx) this.dq = quantTables(seq, hdr, this.lastQidx);
            if (this.lastDeltaLf.every(v => !v)) this.lfLvl = this.frameLfLvl;
            else if (this.lastDeltaLf.join() !== prevDeltaLf) this.lfLvl = calcLfLevels(hdr, this.lastDeltaLf);
        }

        if (hdr.allowIntrabc && m.boolAdapt(cdf, CDF.intrabc)) {
            this.intrabcBlock(bs, edgeFlags, b, hasChroma);
            this.storeBlock(bs, b, hasChroma);
            return;
        }

        // the luma mode, its angle
        b.yMode = m.symbol(cdf, CDF.kfYMode + (INTRA_MODE_CONTEXT[this.aMode[bx4]] * 5 + INTRA_MODE_CONTEXT[this.lMode[by4]]) * 16, 12);
        if (lw4 + lh4 >= 2 && b.yMode >= VERT_PRED && b.yMode <= VERT_LEFT_PRED) b.yAngle = m.symbol(cdf, CDF.angleDelta + (b.yMode - VERT_PRED) * 8, 6) - 3;

        const lossless = hdr.segmentation.lossless[b.segId];
        if (hasChroma) {
            const cflAllowed = lossless ? cbw4 === 1 && cbh4 === 1 : !!(CFL_ALLOWED_MASK & 1 << bs);
            b.uvMode = m.symbol(cdf, CDF.uvMode + ((cflAllowed ? 1 : 0) * 13 + b.yMode) * 16, cflAllowed ? 13 : 12);
            if (b.uvMode === CFL_PRED) {
                const sign = m.symbol(cdf, CDF.cflSign, 7) + 1;
                const signU = sign * 0x56 >> 8, signV = sign - signU * 3;
                if (signU) {
                    const ctx = (signU === 2 ? 3 : 0) + signV;
                    b.cflAlpha[0] = m.symbol(cdf, CDF.cflAlpha + ctx * 16, 15) + 1;
                    if (signU === 1) b.cflAlpha[0] = -b.cflAlpha[0];
                }
                if (signV) {
                    const ctx = (signV === 2 ? 3 : 0) + signU;
                    b.cflAlpha[1] = m.symbol(cdf, CDF.cflAlpha + ctx * 16, 15) + 1;
                    if (signV === 1) b.cflAlpha[1] = -b.cflAlpha[1];
                }
            } else if (lw4 + lh4 >= 2 && b.uvMode >= VERT_PRED && b.uvMode <= VERT_LEFT_PRED) {
                b.uvAngle = m.symbol(cdf, CDF.angleDelta + (b.uvMode - VERT_PRED) * 8, 6) - 3;
            }
        }

        // palettes
        if (hdr.allowScreenContentTools && Math.max(bw4, bh4) <= 16 && bw4 + bh4 >= 4) {
            const szCtx = lw4 + lh4 - 2;
            if (b.yMode === DC_PRED) {
                const palCtx = (this.aPalSz[bx4] > 0 ? 1 : 0) + (this.lPalSz[by4] > 0 ? 1 : 0);
                if (m.boolAdapt(cdf, CDF.palY + (szCtx * 3 + palCtx) * 2)) this.readPalPlane(b, 0, szCtx, bx4, by4);
            }
            if (hasChroma && b.uvMode === DC_PRED) {
                if (m.boolAdapt(cdf, CDF.palUv + (b.palSz[0] > 0 ? 2 : 0))) this.readPalUv(b, szCtx, bx4, by4);
            }
        }

        if (b.yMode === DC_PRED && !b.palSz[0] && Math.max(lw4, lh4) <= 3 && seq.filterIntra) {
            if (m.boolAdapt(cdf, CDF.useFilterIntra + bs * 2)) {
                b.yMode = FILTER_PRED;
                b.yAngle = m.symbol(cdf, CDF.filterIntra, 4);
            }
        }

        if (b.palSz[0]) this.readPalIndices(this.palIdxY, b.palSz[0], 0, w4, h4, bw4, bh4);
        if (hasChroma && b.palSz[1]) {
            const cw4 = w4 + ssx >> ssx, ch4 = h4 + ssy >> ssy;
            this.readPalIndices(this.palIdxUv, b.palSz[1], 1, cw4, ch4, cbw4, cbh4);
        }

        // transform size
        let tx: number;
        if (lossless) {
            tx = b.uvtx = TX_4X4;
        } else {
            tx = MAX_TXFM_SIZE_FOR_BS[bs * 4];
            b.uvtx = MAX_TXFM_SIZE_FOR_BS[bs * 4 + f.layout];
            if (hdr.txMode === 2 && tdim(tx, MAX) > TX_4X4) {
                const tctx = (this.lTxIntra[by4] >= tdim(tx, LH) ? 1 : 0) + (this.aTxIntra[bx4] >= tdim(tx, LW) ? 1 : 0);
                let depth = m.symbol(cdf, CDF.txSize + ((tdim(tx, MAX) - 1) * 3 + tctx) * 4, Math.min(tdim(tx, MAX), 2));
                while (depth--) tx = tdim(tx, SUB);
            }
        }
        b.tx = tx;

        this.reconIntra(bs, edgeFlags, b, hasChroma);

        this.storeBlock(bs, b, hasChroma);

        // contexts
        const yModeNofilt = b.yMode === FILTER_PRED ? DC_PRED : b.yMode;
        const aw = 1 << lw4, lh = 1 << lh4;
        this.aTxIntra.fill(tdim(tx, LW), bx4, bx4 + aw); this.lTxIntra.fill(tdim(tx, LH), by4, by4 + lh);
        this.aTx.fill(tdim(tx, LW), bx4, bx4 + aw); this.lTx.fill(tdim(tx, LH), by4, by4 + lh);
        this.aMode.fill(yModeNofilt, bx4, bx4 + aw); this.lMode.fill(yModeNofilt, by4, by4 + lh);
        this.aPalSz.fill(b.palSz[0], bx4, bx4 + aw); this.lPalSz.fill(b.palSz[0], by4, by4 + lh);
        this.aSegPred.fill(0, bx4, bx4 + aw); this.lSegPred.fill(0, by4, by4 + lh);
        this.aIntra.fill(1, bx4, bx4 + aw); this.lIntra.fill(1, by4, by4 + lh);
        this.aSkip.fill(b.skip, bx4, bx4 + aw); this.lSkip.fill(b.skip, by4, by4 + lh);
        // (luma coordinates for the chroma palette size, like libaom)
        this.aPalSzUv.fill(hasChroma ? b.palSz[1] : 0, bx4, bx4 + aw); this.lPalSzUv.fill(hasChroma ? b.palSz[1] : 0, by4, by4 + lh);
        if (b.palSz[0]) {
            for (let x = 0; x < bw4; x++) this.aPal.set(this.pal.subarray(0, 8), (bx4 + x) * 24);
            for (let y = 0; y < bh4; y++) this.lPal.set(this.pal.subarray(0, 8), (by4 + y) * 24);
        }
        if (hasChroma) {
            this.aUvmode.fill(b.uvMode, cbx4, cbx4 + cbw4);
            this.lUvmode.fill(b.uvMode, cby4, cby4 + cbh4);
            if (b.palSz[1]) {
                for (let pl = 1; pl <= 2; pl++) {
                    for (let x = 0; x < bw4; x++) this.aPal.set(this.pal.subarray(pl * 8, pl * 8 + 8), (bx4 + x) * 24 + pl * 8);
                    for (let y = 0; y < bh4; y++) this.lPal.set(this.pal.subarray(pl * 8, pl * 8 + 8), (by4 + y) * 24 + pl * 8);
                }
            }
        }
        if (hdr.allowIntrabc) this.splatMv(bs, -1, 0, 0);
    }

    // what the post filters need, the segment map
    private storeBlock(bs: number, b: Block, hasChroma: boolean): void {
        const f = this.frame, bx = this.bx, by = this.by, ssx = f.ssx, ssy = f.ssy;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1);
        const w4 = Math.min(bw4, f.bw - bx), h4 = Math.min(bh4, f.bh - by);
        const tx = b.tx;
        const lvl = this.lfLvl[b.segId];
        const s4 = f.b4Stride;
        for (let y = 0; y < h4; y++) {
            for (let x = 0; x < w4; x++) {
                const o = (by + y) * s4 + bx + x;
                f.lfLevels.set(lvl, o * 4);
                f.txW[o] = tdim(tx, LW);
                f.txH[o] = tdim(tx, LH);
                f.skip[o] = b.skip;
            }
        }
        if (hasChroma) {
            const cx = bx >> ssx, cy = by >> ssy, cw4 = w4 + ssx >> ssx, ch4 = h4 + ssy >> ssy;
            for (let y = 0; y < ch4; y++) {
                for (let x = 0; x < cw4; x++) {
                    const o = (cy + y) * s4 + cx + x;
                    f.uvTxW[o] = tdim(b.uvtx, LW);
                    f.uvTxH[o] = tdim(b.uvtx, LH);
                }
            }
        }

        if (this.hdr.segmentation.enabled) {
            for (let y = 0; y < bh4 && by + y < f.bh; y++) f.segMap.fill(b.segId, (by + y) * s4 + bx, (by + y) * s4 + bx + bw4);
        }
    }

    // ---- intra block copy: a block copied from the decoded part of the frame

    // per 4x4 block of the frame: the motion vector (in 1/8 pixels; intra blocks: none) and the block size
    private mvY: Int16Array | null = null;
    private mvX: Int16Array | null = null;
    private mvValid: Uint8Array | null = null;
    private mvBs: Uint8Array | null = null;
    private txSplit = [0, 0];
    private maxYtx = 0;
    private txtpMap = new Uint8Array(32 * 32);

    // stores a block's motion vector (valid: -1 for intra blocks)
    private splatMv(bs: number, valid: number, y: number, x: number): void {
        const f = this.frame, s4 = f.b4Stride;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1);
        for (let r = 0; r < bh4; r++) {
            const o = (this.by + r) * s4 + this.bx;
            (this.mvY as Int16Array).fill(y, o, o + bw4);
            (this.mvX as Int16Array).fill(x, o, o + bw4);
            (this.mvValid as Uint8Array).fill(valid > 0 ? 1 : 0, o, o + bw4);
            (this.mvBs as Uint8Array).fill(bs, o, o + bw4);
        }
    }

    // dav1d_refmvs_find for intra block copy (reference 0, only spatial candidates): the best two motion vectors
    private findMvs(bs: number, edgeFlags: number): number[][] {
        const f = this.frame, s4 = f.b4Stride;
        const by4 = this.by, bx4 = this.bx;
        const iw4 = f.width + 3 >> 2, ih4 = f.height + 3 >> 2;
        const colStart = this.colStart, colEnd = Math.min(this.colEnd, iw4), rowStart = this.rowStart, rowEnd = Math.min(this.rowEnd, ih4);
        const bw4 = bdim(bs, 0), w4 = Math.min(Math.min(bw4, 16), colEnd - bx4);
        const bh4 = bdim(bs, 1), h4 = Math.min(Math.min(bh4, 16), rowEnd - by4);
        const valid = this.mvValid as Uint8Array, mvY = this.mvY as Int16Array, mvX = this.mvX as Int16Array, mvBs = this.mvBs as Uint8Array;
        const stack: Array<{ y: number, x: number, weight: number }> = [];
        const add = (o: number, weight: number): void => {
            if (!valid[o]) return;
            const y = mvY[o], x = mvX[o];
            for (const c of stack) {
                if (c.y === y && c.x === x) {
                    c.weight += weight;
                    return;
                }
            }
            if (stack.length < 8) stack.push({ y, x, weight });
        };
        const scanRow = (row: number, col: number, maxRows: number, step: number): number => {
            const o = row * s4 + col;
            const firstBw4 = bdim(mvBs[o], 0);
            let len = Math.max(step, Math.min(bw4, firstBw4));
            if (bw4 <= firstBw4) {
                const weight = bw4 === 1 ? 2 : Math.max(2, Math.min(2 * maxRows, bdim(mvBs[o], 1)));
                add(o, len * weight);
                return weight >> 1;
            }
            for (let x = 0; ;) {
                add(o + x, len * 2);
                x += len;
                if (x >= w4) return 1;
                len = Math.max(step, bdim(mvBs[o + x], 0));
            }
        };
        const scanCol = (row: number, col: number, maxCols: number, step: number): number => {
            const o = row * s4 + col;
            const firstBh4 = bdim(mvBs[o], 1);
            let len = Math.max(step, Math.min(bh4, firstBh4));
            if (bh4 <= firstBh4) {
                const weight = bh4 === 1 ? 2 : Math.max(2, Math.min(2 * maxCols, bdim(mvBs[o], 0)));
                add(o, len * weight);
                return weight >> 1;
            }
            for (let y = 0; ;) {
                add(o + y * s4, len * 2);
                y += len;
                if (y >= h4) return 1;
                len = Math.max(step, bdim(mvBs[o + y * s4], 1));
            }
        };

        const NONE = 0xffffffff;
        let maxRows = 0, nRows = NONE;
        if (by4 > rowStart) {
            maxRows = Math.min((by4 - rowStart + 1) >> 1, 2 + (bh4 > 1 ? 1 : 0));
            nRows = scanRow(by4 - 1, bx4, maxRows, bw4 >= 16 ? 4 : 1);
        }
        let maxCols = 0, nCols = NONE;
        if (bx4 > colStart) {
            maxCols = Math.min((bx4 - colStart + 1) >> 1, 2 + (bw4 > 1 ? 1 : 0));
            nCols = scanCol(by4, bx4 - 1, maxCols, bh4 >= 16 ? 4 : 1);
        }
        if (nRows !== NONE && edgeFlags & EDGE_I444_TOP_HAS_RIGHT && Math.max(bw4, bh4) <= 16 && bw4 + bx4 < colEnd) add((by4 - 1) * s4 + bx4 + bw4, 4);
        const nearest = stack.length;
        for (const c of stack) c.weight += 640;
        // top left, if both the row above and the column to the left were scanned
        if (nRows !== NONE && nCols !== NONE) add((by4 - 1) * s4 + bx4 - 1, 4);
        for (let n = 2; n <= 3; n++) {
            if (nRows !== NONE && n > nRows && n <= maxRows) {
                nRows += scanRow(((by4 - 2 * n + 1) | 1), bx4 | 1, 1 + maxRows - n, bw4 >= 16 ? 4 : 2);
            }
            if (nCols !== NONE && n > nCols && n <= maxCols) {
                nCols += scanCol(by4 | 1, (bx4 - n * 2 + 1) | 1, 1 + maxCols - n, bh4 >= 16 ? 4 : 2);
            }
        }
        // sorting: the nearest ones, then the others, by weight (stable bubble sort like dav1d's)
        const sort = (from: number, to: number): void => {
            let len = to;
            while (len > from) {
                let last = from;
                for (let n = from + 1; n < len; n++) {
                    if (stack[n - 1].weight < stack[n].weight) {
                        [stack[n - 1], stack[n]] = [stack[n], stack[n - 1]];
                        last = n;
                    }
                }
                len = last;
            }
        };
        sort(0, nearest);
        sort(nearest, stack.length);
        const left = -(bx4 + bw4 + 4) * 32, right = (iw4 - bx4 + 4) * 32;
        const top = -(by4 + bh4 + 4) * 32, bottom = (ih4 - by4 + 4) * 32;
        const out = stack.map(c => [Math.min(bottom, Math.max(top, c.y)), Math.min(right, Math.max(left, c.x))]);
        while (out.length < 2) out.push([0, 0]);
        return out;
    }

    private readMvComponent(comp: number): number {
        const m = this.msac, cdf = this.cdf;
        const sign = m.boolAdapt(cdf, comp ? CDF.mvSign1 : CDF.mvSign0);
        const cl = m.symbol(cdf, comp ? CDF.mvClasses1 : CDF.mvClasses0, 10);
        let up: number;
        if (!cl) up = m.boolAdapt(cdf, comp ? CDF.mvClass01 : CDF.mvClass00);
        else {
            up = 1 << cl;
            for (let n = 0; n < cl; n++) up |= m.boolAdapt(cdf, (comp ? CDF.mvClassN1 : CDF.mvClassN0) + n * 2) << n;
        }
        // integer vectors: the fraction is all ones
        const diff = (up << 3 | 7) + 1;
        return sign ? -diff : diff;
    }

    private intrabcBlock(bs: number, edgeFlags: number, b: Block, hasChroma: boolean): void {
        const f = this.frame, seq = this.seq, m = this.msac, cdf = this.cdf;
        const bx = this.bx, by = this.by, bx4 = bx, by4 = by & 31;
        const ssx = f.ssx, ssy = f.ssy;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1);
        const sb128 = seq.sb128 ? 1 : 0;

        const stack = this.findMvs(bs, edgeFlags);
        let [mvy, mvx] = stack[0][0] || stack[0][1] ? stack[0] : stack[1][0] || stack[1][1] ? stack[1] : [0, 0];
        if (!mvy && !mvx) {
            if (by - (16 << sb128) < this.rowStart) {
                mvy = 0;
                mvx = -(512 << sb128) - 2048;
            } else {
                mvy = -(512 << sb128);
                mvx = 0;
            }
        }
        const joint = m.symbol(cdf, CDF.mvJoint, 3);
        if (joint & 2) mvy += this.readMvComponent(0);
        if (joint & 1) mvx += this.readMvComponent(1);

        // clipped into the decoded part of the tile
        let borderLeft = this.colStart * 4, borderTop = this.rowStart * 4;
        if (hasChroma) {
            if (bw4 < 2 && ssx) borderLeft += 4;
            if (bh4 < 2 && ssy) borderTop += 4;
        }
        let srcLeft = bx * 4 + (mvx >> 3), srcTop = by * 4 + (mvy >> 3);
        let srcRight = srcLeft + bw4 * 4, srcBottom = srcTop + bh4 * 4;
        const borderRight = ((this.colEnd + (bw4 - 1)) & ~(bw4 - 1)) * 4;
        if (srcLeft < borderLeft) {
            srcRight += borderLeft - srcLeft;
            srcLeft = borderLeft;
        } else if (srcRight > borderRight) {
            srcLeft -= srcRight - borderRight;
            srcRight = borderRight;
        }
        if (srcTop < borderTop) {
            srcBottom += borderTop - srcTop;
            srcTop = borderTop;
        }
        const sbx = (bx >> (4 + sb128)) << (6 + sb128), sby = (by >> (4 + sb128)) << (6 + sb128), sbSize = 1 << (6 + sb128);
        if (srcBottom > sby && srcRight > sbx) {
            if (srcTop - borderTop >= srcBottom - sby) {
                srcTop -= srcBottom - sby;
                srcBottom = sby;
            } else if (srcLeft - borderLeft >= srcRight - sbx) {
                srcLeft -= srcRight - sbx;
                srcRight = sbx;
            }
        }
        if (srcBottom > sby + sbSize) {
            srcTop -= srcBottom - (sby + sbSize);
            srcBottom = sby + sbSize;
        }
        if (srcBottom > sby && srcRight > sbx) throw new Error('AV1: invalid intra block copy vector');
        mvx = (srcLeft - bx * 4) * 8;
        mvy = (srcTop - by * 4) * 8;

        this.readVartxTree(b, bs);
        b.tx = this.maxYtx;
        this.reconInter(bs, b, hasChroma, mvy, mvx);
        this.splatMv(bs, 1, mvy, mvx);

        // contexts
        const aw = 1 << bdim(bs, 2), lh = 1 << bdim(bs, 3);
        this.aTxIntra.fill(bdim(bs, 2), bx4, bx4 + aw); this.lTxIntra.fill(bdim(bs, 3), by4, by4 + lh);
        this.aMode.fill(DC_PRED, bx4, bx4 + aw); this.lMode.fill(DC_PRED, by4, by4 + lh);
        this.aPalSz.fill(0, bx4, bx4 + aw); this.lPalSz.fill(0, by4, by4 + lh);
        this.aPalSzUv.fill(0, bx4, bx4 + aw); this.lPalSzUv.fill(0, by4, by4 + lh);
        this.aSegPred.fill(0, bx4, bx4 + aw); this.lSegPred.fill(0, by4, by4 + lh);
        this.aIntra.fill(0, bx4, bx4 + aw); this.lIntra.fill(0, by4, by4 + lh);
        this.aSkip.fill(b.skip, bx4, bx4 + aw); this.lSkip.fill(b.skip, by4, by4 + lh);
        if (hasChroma) {
            const cbx4 = bx4 >> ssx, cby4 = by4 >> ssy, cbw4 = bw4 + ssx >> ssx, cbh4 = bh4 + ssy >> ssy;
            this.aUvmode.fill(DC_PRED, cbx4, cbx4 + cbw4);
            this.lUvmode.fill(DC_PRED, cby4, cby4 + cbh4);
        }
    }

    // the transform sizes of an inter block: the largest, or a tree of splits (read_vartx_tree)
    private readVartxTree(b: Block, bs: number): void {
        const f = this.frame, hdr = this.hdr;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1), lw = bdim(bs, 2), lh = bdim(bs, 3);
        const bx4 = this.bx, by4 = this.by & 31;
        this.txSplit = [0, 0];
        this.maxYtx = MAX_TXFM_SIZE_FOR_BS[bs * 4];
        if (!b.skip && (hdr.segmentation.lossless[b.segId] || this.maxYtx === TX_4X4)) {
            this.maxYtx = b.uvtx = TX_4X4;
            if (hdr.txMode === 2) {
                this.aTx.fill(TX_4X4, bx4, bx4 + (1 << lw));
                this.lTx.fill(TX_4X4, by4, by4 + (1 << lh));
            }
        } else if (hdr.txMode !== 2 || b.skip) {
            if (hdr.txMode === 2) {
                this.aTx.fill(lw, bx4, bx4 + (1 << lw));
                this.lTx.fill(lh, by4, by4 + (1 << lh));
            }
            b.uvtx = MAX_TXFM_SIZE_FOR_BS[bs * 4 + f.layout];
        } else {
            const ytx = this.maxYtx, tw = tdim(ytx, W), th = tdim(ytx, H);
            for (let y = 0, yOff = 0; y < bh4; y += th, yOff++) {
                for (let x = 0, xOff = 0; x < bw4; x += tw, xOff++) {
                    this.readTxTree(ytx, 0, xOff, yOff);
                    this.bx += tw;
                }
                this.bx -= bw4 + tw - 1 & ~(tw - 1);
                this.by += th;
            }
            this.by -= bh4 + th - 1 & ~(th - 1);
            b.uvtx = MAX_TXFM_SIZE_FOR_BS[bs * 4 + f.layout];
        }
    }

    private readTxTree(from: number, depth: number, xOff: number, yOff: number): void {
        const f = this.frame, m = this.msac;
        const bx4 = this.bx, by4 = this.by & 31;
        const txw = tdim(from, LW), txh = tdim(from, LH);
        let split = 0;
        if (depth < 2 && from > TX_4X4) {
            const cat = 2 * (TX_64X64 - tdim(from, MAX)) - depth;
            const a = this.aTx[bx4] < txw ? 1 : 0, l = this.lTx[by4] < txh ? 1 : 0;
            split = m.boolAdapt(this.cdf, CDF.txPart + (cat * 3 + a + l) * 2);
            if (split) this.txSplit[depth] |= 1 << (yOff * 4 + xOff);
        }
        if (split && tdim(from, MAX) > 1) {
            const sub = tdim(from, SUB), sw = tdim(sub, W), sh = tdim(sub, H);
            this.readTxTree(sub, depth + 1, xOff * 2, yOff * 2);
            this.bx += sw;
            if (tdim(from, W) >= tdim(from, H) && this.bx < f.bw) this.readTxTree(sub, depth + 1, xOff * 2 + 1, yOff * 2);
            this.bx -= sw;
            this.by += sh;
            if (tdim(from, H) >= tdim(from, W) && this.by < f.bh) {
                this.readTxTree(sub, depth + 1, xOff * 2, yOff * 2 + 1);
                this.bx += sw;
                if (tdim(from, W) >= tdim(from, H) && this.bx < f.bw) this.readTxTree(sub, depth + 1, xOff * 2 + 1, yOff * 2 + 1);
                this.bx -= sw;
            }
            this.by -= sh;
        } else {
            this.aTx.fill(split ? TX_4X4 : txw, bx4, bx4 + (1 << tdim(from, LW)));
            this.lTx.fill(split ? TX_4X4 : txh, by4, by4 + (1 << tdim(from, LH)));
        }
    }

    // copies (bilinear for chroma's subpixel positions) a block of the plane from mv (1/8 pixels) away
    private mc(plane: number, w4: number, h4: number, bx: number, by: number, mvy: number, mvx: number): void {
        const f = this.frame, ssx = plane ? f.ssx : 0, ssy = plane ? f.ssy : 0;
        const hMul = 4 >> ssx, vMul = 4 >> ssy;
        const mx = mvx & (15 >> (ssx ? 0 : 1)), my = mvy & (15 >> (ssy ? 0 : 1));
        const dx = bx * hMul + (mvx >> (3 + ssx)), dy = by * vMul + (mvy >> (3 + ssy));
        const w = (f.bw * 4) >> ssx, h = (f.bh * 4) >> ssy;
        const pic = f.planes[plane], stride = f.strides[plane];
        const bw = w4 * hMul, bh = h4 * vMul;
        const fx = mx << (ssx ? 0 : 1), fy = my << (ssy ? 0 : 1);
        const at = (x: number, y: number): number => pic[Math.min(h - 1, Math.max(0, y)) * stride + Math.min(w - 1, Math.max(0, x))];
        const ib = f.bitdepth === 12 ? 2 : 4, rnd = (1 << ib) >> 1, max = f.bitdepthMax;
        const clip = (v: number): number => v < 0 ? 0 : v > max ? max : v;
        const out = new Uint16Array(bw * bh);
        for (let y = 0; y < bh; y++) {
            for (let x = 0; x < bw; x++) {
                const sx = dx + x, sy = dy + y;
                let v: number;
                if (fx && fy) {
                    const h0 = 16 * at(sx, sy) + fx * (at(sx + 1, sy) - at(sx, sy)) + ((1 << (4 - ib)) >> 1) >> (4 - ib);
                    const h1 = 16 * at(sx, sy + 1) + fx * (at(sx + 1, sy + 1) - at(sx, sy + 1)) + ((1 << (4 - ib)) >> 1) >> (4 - ib);
                    v = clip((16 * h0 + fy * (h1 - h0) + ((1 << (4 + ib)) >> 1)) >> (4 + ib));
                } else if (fx) {
                    const p = 16 * at(sx, sy) + fx * (at(sx + 1, sy) - at(sx, sy)) + ((1 << (4 - ib)) >> 1) >> (4 - ib);
                    v = clip((p + rnd) >> ib);
                } else if (fy) {
                    v = clip((16 * at(sx, sy) + fy * (at(sx, sy + 1) - at(sx, sy)) + 8) >> 4);
                } else v = at(sx, sy);
                out[y * bw + x] = v;
            }
        }
        for (let y = 0; y < bh; y++) pic.set(out.subarray(y * bw, (y + 1) * bw), (by * vMul + y) * stride + bx * hMul);
    }

    private reconInter(bs: number, b: Block, hasChroma: boolean, mvy: number, mvx: number): void {
        const f = this.frame, ssx = f.ssx, ssy = f.ssy;
        const bx = this.bx, by = this.by, bx4 = bx, by4 = by & 31;
        const cbx4 = bx4 >> ssx, cby4 = by4 >> ssy;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1);
        const w4 = Math.min(bw4, f.bw - bx), h4 = Math.min(bh4, f.bh - by);
        const cbw4 = bw4 + ssx >> ssx, cbh4 = bh4 + ssy >> ssy;

        this.mc(0, bw4, bh4, bx, by, mvy, mvx);
        if (hasChroma) {
            for (let pl = 1; pl < 3; pl++) {
                this.mc(pl, bw4 << (bw4 === ssx ? 1 : 0), bh4 << (bh4 === ssy ? 1 : 0), bx & ~ssx, by & ~ssy, mvy, mvx);
            }
        }

        if (b.skip) {
            this.aLcoef.fill(0x40, bx4, bx4 + (1 << bdim(bs, 2)));
            this.lLcoef.fill(0x40, by4, by4 + (1 << bdim(bs, 3)));
            if (hasChroma) {
                const cw = 1 << (31 - Math.clz32(cbw4)), ch = 1 << (31 - Math.clz32(cbh4));
                for (let pl = 0; pl < 2; pl++) {
                    this.aCcoef[pl].fill(0x40, cbx4, cbx4 + cw);
                    this.lCcoef[pl].fill(0x40, cby4, cby4 + ch);
                }
            }
            return;
        }

        const ytx = this.maxYtx, ytw = tdim(ytx, W), yth = tdim(ytx, H);
        const uvtx = b.uvtx, uvtw = tdim(uvtx, W), uvth = tdim(uvtx, H);
        const cw4 = w4 + ssx >> ssx, ch4 = h4 + ssy >> ssy;
        const stride = f.strides[0], cstride = f.strides[1];
        for (let initY = 0; initY < bh4; initY += 16) {
            for (let initX = 0; initX < bw4; initX += 16) {
                let yOff = initY ? 1 : 0;
                for (let y = initY; y < Math.min(h4, initY + 16); y += yth, yOff++) {
                    let xOff = initX ? 1 : 0;
                    for (let x = initX; x < Math.min(w4, initX + 16); x += ytw, xOff++) {
                        this.bx = bx + x;
                        this.by = by + y;
                        this.readCoefTree(bs, b, ytx, 0, xOff, yOff, 4 * ((by + y) * stride + bx + x));
                    }
                }
                this.bx = bx;
                this.by = by;
                if (!hasChroma) continue;
                for (let pl = 0; pl < 2; pl++) {
                    const plane = f.planes[1 + pl];
                    for (let y = initY >> ssy; y < Math.min(ch4, (initY + 16) >> ssy); y += uvth) {
                        for (let x = initX >> ssx; x < Math.min(cw4, (initX + 16) >> ssx); x += uvtw) {
                            const tbx = bx + (x << ssx), tby = by + (y << ssy);
                            this.txtp = this.txtpMap[((by4 + (y << ssy)) & 31) * 32 + ((bx4 + (x << ssx)) & 31)];
                            const eob = this.decodeCoefs(this.aCcoef[pl], cbx4 + x, this.lCcoef[pl], cby4 + y, uvtx, bs, b, 1 + pl, false);
                            const ctw = Math.min(uvtw, (f.bw - tbx + ssx) >> ssx), cth = Math.min(uvth, (f.bh - tby + ssy) >> ssy);
                            this.aCcoef[pl].fill(this.resCtx, cbx4 + x, cbx4 + x + ctw);
                            this.lCcoef[pl].fill(this.resCtx, cby4 + y, cby4 + y + cth);
                            if (eob >= 0) inverseTransformAdd(plane, 4 * (((by >> ssy) + y) * cstride + (bx >> ssx) + x), cstride, this.cf, eob, uvtx, this.txtp, f.bitdepthMax);
                        }
                    }
                }
            }
        }
    }

    private readCoefTree(bs: number, b: Block, ytx: number, depth: number, xOff: number, yOff: number, dst: number): void {
        const f = this.frame;
        const tw = tdim(ytx, W), th = tdim(ytx, H);
        if (depth < 2 && this.txSplit[depth] && this.txSplit[depth] & 1 << (yOff * 4 + xOff)) {
            const sub = tdim(ytx, SUB), sw = tdim(sub, W), sh = tdim(sub, H);
            const stride = f.strides[0];
            this.readCoefTree(bs, b, sub, depth + 1, xOff * 2, yOff * 2, dst);
            this.bx += sw;
            if (tw >= th && this.bx < f.bw) this.readCoefTree(bs, b, sub, depth + 1, xOff * 2 + 1, yOff * 2, dst + 4 * sw);
            this.bx -= sw;
            this.by += sh;
            if (th >= tw && this.by < f.bh) {
                const d2 = dst + 4 * sh * stride;
                this.readCoefTree(bs, b, sub, depth + 1, xOff * 2, yOff * 2 + 1, d2);
                this.bx += sw;
                if (tw >= th && this.bx < f.bw) this.readCoefTree(bs, b, sub, depth + 1, xOff * 2 + 1, yOff * 2 + 1, d2 + 4 * sw);
                this.bx -= sw;
            }
            this.by -= sh;
            return;
        }
        const bx4 = this.bx, by4 = this.by & 31;
        const eob = this.decodeCoefs(this.aLcoef, bx4, this.lLcoef, by4, ytx, bs, b, 0, false);
        this.aLcoef.fill(this.resCtx, bx4, bx4 + Math.min(tw, f.bw - this.bx));
        this.lLcoef.fill(this.resCtx, by4, by4 + Math.min(th, f.bh - this.by));
        for (let y = 0; y < th; y++) this.txtpMap.fill(this.txtp, ((by4 + y) & 31) * 32 + (bx4 & 31), ((by4 + y) & 31) * 32 + (bx4 & 31) + Math.min(1 << tdim(ytx, LW), 16));
        if (eob >= 0) inverseTransformAdd(f.planes[0], dst, f.strides[0], this.cf, eob, ytx, this.txtp, f.bitdepthMax);
    }

    private readPalPlane(b: Block, pl: number, szCtx: number, bx4: number, by4: number): void {
        const m = this.msac, f = this.frame;
        const palSz = b.palSz[pl] = m.symbol(this.cdf, CDF.palSize + (pl * 7 + szCtx) * 8, 6) + 2;
        const cache: number[] = [], used: number[] = [];
        let lCache = pl ? this.lPalSzUv[by4] : this.lPalSz[by4];
        // the above palette isn't used across 64x64 boundaries
        let aCache = by4 & 15 ? pl ? this.aPalSzUv[bx4] : this.aPalSz[bx4] : 0;
        let l = by4 * 24 + pl * 8, a = bx4 * 24 + pl * 8;
        const L = this.lPal, A = this.aPal;
        const push = (v: number): void => {
            if (!cache.length || cache[cache.length - 1] !== v) cache.push(v);
        };
        while (lCache && aCache) {
            if (L[l] < A[a]) {
                push(L[l++]);
                lCache--;
            } else {
                if (A[a] === L[l]) { l++; lCache--; }
                push(A[a++]);
                aCache--;
            }
        }
        while (lCache-- > 0) push(L[l++]);
        while (aCache-- > 0) push(A[a++]);

        for (let n = 0; n < cache.length && used.length < palSz; n++) if (m.bool()) used.push(cache[n]);
        const pal = this.pal, o = pl * 8;
        let i = used.length;
        if (i < palSz) {
            const bpc = f.bitdepth;
            let prev = pal[o + i++] = m.bools(bpc);
            if (i < palSz) {
                let bits = bpc - 3 + m.bools(2);
                const max = (1 << bpc) - 1, minus = pl ? 0 : 1;
                do {
                    const delta = m.bools(bits);
                    prev = pal[o + i++] = Math.min(prev + delta + minus, max);
                    if (prev + minus >= max) {
                        for (; i < palSz; i++) pal[o + i] = max;
                        break;
                    }
                    bits = Math.min(bits, 1 + (31 - Math.clz32(max - prev - minus)));
                } while (i < palSz);
            }
            // merge the cached and the new entries
            const merged: number[] = [];
            let n = 0, k = used.length;
            for (i = 0; i < palSz; i++) {
                if (n < used.length && (k >= palSz || used[n] <= pal[o + k])) merged.push(used[n++]);
                else merged.push(pal[o + k++]);
            }
            pal.set(merged, o);
        } else pal.set(used, o);
    }

    private readPalUv(b: Block, szCtx: number, bx4: number, by4: number): void {
        this.readPalPlane(b, 1, szCtx, bx4, by4);
        const m = this.msac, pal = this.pal, bpc = this.frame.bitdepth;
        if (m.bool()) {
            const bits = bpc - 4 + m.bools(2);
            let prev = pal[16] = m.bools(bpc);
            const max = (1 << bpc) - 1;
            for (let i = 1; i < b.palSz[1]; i++) {
                let delta = m.bools(bits);
                if (delta && m.bool()) delta = -delta;
                prev = pal[16 + i] = prev + delta & max;
            }
        } else {
            for (let i = 0; i < b.palSz[1]; i++) pal[16 + i] = m.bools(bpc);
        }
    }

    // the color indices of a palette block, in wavefront order; the parts outside the frame repeat the last column/row
    private readPalIndices(out: Uint8Array, palSz: number, pl: number, w4: number, h4: number, bw4: number, bh4: number): void {
        const m = this.msac, cdf = this.cdf, stride = bw4 * 4, t = this.palTmp;
        t[0] = m.uniform(palSz);
        const order = [0, 0, 0, 0, 0, 0, 0, 0];
        for (let i = 1; i < 4 * (w4 + h4) - 1; i++) {
            const first = Math.min(i, w4 * 4 - 1), last = Math.max(0, i - h4 * 4 + 1);
            for (let j = first; j >= last; j--) {
                const p = (i - j) * stride + j;
                const haveTop = i - j > 0, haveLeft = j > 0;
                let ctx: number, n = 0, mask = 0;
                const add = (v: number): void => { order[n++] = v; mask |= 1 << v; };
                if (!haveLeft) { ctx = 0; add(t[p - stride]); }
                else if (!haveTop) { ctx = 0; add(t[p - 1]); }
                else {
                    const l = t[p - 1], tp = t[p - stride], tl = t[p - stride - 1];
                    const sameTL = tp === l, sameTTl = tp === tl, sameLTl = l === tl;
                    if (sameTL && sameTTl && sameLTl) { ctx = 4; add(tp); }
                    else if (sameTL) { ctx = 3; add(tp); add(tl); }
                    else if (sameTTl || sameLTl) { ctx = 2; add(tl); add(sameTTl ? l : tp); }
                    else { ctx = 1; add(Math.min(tp, l)); add(Math.max(tp, l)); add(tl); }
                }
                for (let bit = 0; bit < 8; bit++) if (!(mask & 1 << bit)) order[n++] = bit;
                const idx = m.symbol(cdf, CDF.colorMap + ((pl * 7 + palSz - 2) * 5 + ctx) * 8, palSz - 1);
                t[p] = order[idx];
            }
        }
        // pal_idx_finish
        const w = w4 * 4, h = h4 * 4, bw = bw4 * 4, bh = bh4 * 4;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) out[y * bw + x] = t[y * stride + x];
            out.fill(t[y * stride + w - 1], y * bw + w, y * bw + bw);
        }
        for (let y = h; y < bh; y++) out.copyWithin(y * bw, (h - 1) * bw, h * bw);
    }

    // the coefficients of a transform block into this.cf; returns eob (-1: none), sets txtp and the context
    private txtp = 0;
    private resCtx = 0;

    private decodeCoefs(aArr: Uint8Array, a: number, lArr: Uint8Array, l: number, tx: number, bs: number, b: Block, plane: number, intra = true): number {
        const m = this.msac, cdf = this.cdf, f = this.frame, hdr = this.hdr;
        const chroma = plane ? 1 : 0;
        const lossless = hdr.segmentation.lossless[b.segId];
        const tlw = tdim(tx, LW), tlh = tdim(tx, LH), tctx = tdim(tx, CTX), tmin = tdim(tx, MIN), tmax = tdim(tx, MAX);

        // whether the block has coefficients
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
        if (m.boolAdapt(cdf, CDF.coefSkip + (tctx * 13 + sctx) * 2)) {
            this.resCtx = 0x40;
            this.txtp = lossless ? WHT_WHT : DCT_DCT;
            return -1;
        }

        // transform type
        let txtp: number;
        if (lossless) txtp = WHT_WHT;
        else if (tmax + (intra ? 1 : 0) >= TX_64X64) txtp = DCT_DCT;
        else if (chroma) {
            if (intra) txtp = TXTP_FROM_UVMODE[b.uvMode];
            else {
                // get_uv_inter_txtp: from the luma transform type
                const y = this.txtp;
                if (tmax === TX_32X32) txtp = y === IDTX ? IDTX : DCT_DCT;
                else if (tmin === TX_16X16 && (1 << y & (1 << 15 | 1 << 14 | 1 << 13 | 1 << 12))) txtp = DCT_DCT;
                else txtp = y;
            }
        } else if (!hdr.segmentation.qidx[b.segId]) txtp = DCT_DCT;
        else if (!intra) {
            if (hdr.reducedTxSet || tmax === TX_32X32) txtp = m.boolAdapt(cdf, CDF.txtpInter3 + tmin * 2) ? DCT_DCT : IDTX;
            else if (tmin === TX_16X16) txtp = TX_TYPES_PER_SET[m.symbol(cdf, CDF.txtpInter2, 11) + 12];
            else txtp = TX_TYPES_PER_SET[m.symbol(cdf, CDF.txtpInter1 + tmin * 16, 15) + 24];
        } else {
            const yModeNofilt = b.yMode === FILTER_PRED ? FILTER_MODE_TO_Y_MODE[b.yAngle] : b.yMode;
            if (hdr.reducedTxSet || tmin === TX_16X16) txtp = TX_TYPES_PER_SET[m.symbol(cdf, CDF.txtpIntra2 + (tmin * 13 + yModeNofilt) * 8, 4)];
            else txtp = TX_TYPES_PER_SET[m.symbol(cdf, CDF.txtpIntra1 + (tmin * 13 + yModeNofilt) * 8, 6) + 5];
        }
        this.txtp = txtp;

        // end of block
        const slw = Math.min(tlw, 3), slh = Math.min(tlh, 3);
        const tx2d = slw + slh;
        const txClass = TX_TYPE_CLASS[txtp];
        const is1d = txClass !== TX_CLASS_2D ? 1 : 0;
        let eobBin: number;
        switch (tx2d) {
            case 0: eobBin = m.symbol(cdf, CDF.eobBin16 + (chroma * 2 + is1d) * 8, 4); break;
            case 1: eobBin = m.symbol(cdf, CDF.eobBin32 + (chroma * 2 + is1d) * 8, 5); break;
            case 2: eobBin = m.symbol(cdf, CDF.eobBin64 + (chroma * 2 + is1d) * 8, 6); break;
            case 3: eobBin = m.symbol(cdf, CDF.eobBin128 + (chroma * 2 + is1d) * 8, 7); break;
            case 4: eobBin = m.symbol(cdf, CDF.eobBin256 + (chroma * 2 + is1d) * 16, 8); break;
            case 5: eobBin = m.symbol(cdf, CDF.eobBin512 + chroma * 16, 9); break;
            default: eobBin = m.symbol(cdf, CDF.eobBin1024 + chroma * 16, 10); break;
        }
        let eob: number;
        if (eobBin > 1) {
            const hi = m.boolAdapt(cdf, CDF.eobHiBit + ((tctx * 2 + chroma) * 11 + eobBin) * 2);
            eob = (hi | 2) << (eobBin - 2) | m.bools(eobBin - 2);
        } else eob = eobBin;

        const cf = this.cf, levels = this.levels;
        const eobCdf = CDF.eobBaseTok + (tctx * 2 + chroma) * 16;
        const hiCdf = CDF.brTok + (Math.min(tctx, 3) * 2 + chroma) * 84;
        let rc: number, dcTok: number;

        if (eob) {
            const loCdf = CDF.baseTok + (tctx * 2 + chroma) * 164;
            let ctx = 1 + (eob > 2 << tx2d ? 1 : 0) + (eob > 4 << tx2d ? 1 : 0);
            const eobTok = m.symbol(cdf, eobCdf + ctx * 4, 2);
            let tok = eobTok + 1;
            let levelTok = tok * 0x41;
            let mag = 0;

            let scanTable: Uint16Array | null = null, stride: number, shift: number, shift2: number, mask: number, offsets = 0;
            if (txClass === TX_CLASS_2D) {
                const nonsquare = tx >= RTX_4X8 ? 1 : 0;
                offsets = (nonsquare + (tx & nonsquare)) * 25;
                scanTable = scan(tx);
                stride = 4 << slh; shift = slh + 2; shift2 = 0; mask = (4 << slh) - 1;
                levels.fill(0, 0, stride * ((4 << slw) + 2));
            } else if (txClass === TX_CLASS_H) {
                stride = 16; shift = slh + 2; shift2 = 0; mask = (4 << slh) - 1;
                levels.fill(0, 0, stride * ((4 << slh) + 2));
            } else {
                stride = 16; shift = slw + 2; shift2 = slh + 2; mask = (4 << slw) - 1;
                levels.fill(0, 0, stride * ((4 << slw) + 2));
            }

            // get_lo_ctx: the context from the levels around, and the sum of the nearest (hiMag)
            let hiMag = 0;
            const loCtx = (lv: number, x: number, y: number): number => {
                let mg = levels[lv + 1] + levels[lv + stride];
                let off: number;
                if (txClass === TX_CLASS_2D) {
                    mg += levels[lv + stride + 1];
                    hiMag = mg;
                    mg += levels[lv + 2] + levels[lv + 2 * stride];
                    off = LO_CTX_OFFSETS[offsets + Math.min(y, 4) * 5 + Math.min(x, 4)];
                } else {
                    mg += levels[lv + 2];
                    hiMag = mg;
                    mg += levels[lv + 3] + levels[lv + 4];
                    off = 26 + (y > 1 ? 10 : y * 5);
                }
                return off + (mg > 512 ? 4 : mg + 64 >> 7);
            };
            const position = (i: number): [number, number, number] => {
                if (txClass === TX_CLASS_2D) {
                    const r = (scanTable as Uint16Array)[i];
                    return [r, r >> shift, r & mask];
                }
                const x = i & mask, y = i >> shift;
                return [txClass === TX_CLASS_H ? i : x << shift2 | y, x, y];
            };

            const [r, x, y] = position(eob);
            rc = r;
            if (eobTok === 2) {
                ctx = (txClass === TX_CLASS_2D ? (x | y) > 1 : y !== 0) ? 14 : 7;
                tok = m.hiTok(cdf, hiCdf + ctx * 4);
                levelTok = tok + (3 << 6);
            }
            cf[rc] = tok << 11;
            levels[x * stride + y] = levelTok;
            for (let i = eob - 1; i > 0; i--) {
                const [rcI, xi, yi0] = position(i);
                const lv = xi * stride + yi0;
                ctx = loCtx(lv, xi, yi0);
                const yi = txClass === TX_CLASS_2D ? yi0 | xi : yi0;
                tok = m.symbol(cdf, loCdf + ctx * 4, 3);
                if (tok === 3) {
                    mag = hiMag & 63;
                    ctx = (yi > (txClass === TX_CLASS_2D ? 1 : 0) ? 14 : 7) + (mag > 12 ? 6 : mag + 1 >> 1);
                    tok = m.hiTok(cdf, hiCdf + ctx * 4);
                    levels[lv] = tok + (3 << 6);
                    cf[rcI] = tok << 11 | rc;
                    rc = rcI;
                } else {
                    levels[lv] = tok * 0x41;
                    if (tok) {
                        cf[rcI] = tok << 11 | rc;
                        rc = rcI;
                    } else cf[rcI] = 0;
                }
            }
            // dc
            ctx = txClass === TX_CLASS_2D ? 0 : loCtx(0, 0, 0);
            dcTok = m.symbol(cdf, loCdf + ctx * 4, 3);
            if (dcTok === 3) {
                if (txClass === TX_CLASS_2D) hiMag = levels[1] + levels[stride] + levels[stride + 1];
                mag = hiMag & 63;
                ctx = mag > 12 ? 6 : mag + 1 >> 1;
                dcTok = m.hiTok(cdf, hiCdf + ctx * 4);
            }
        } else {
            const tokBr = m.symbol(cdf, eobCdf, 2);
            dcTok = 1 + tokBr;
            if (tokBr === 2) dcTok = m.hiTok(cdf, hiCdf);
            rc = 0;
        }

        // residuals and signs
        const dq = this.dq[b.segId][plane];
        const qm = txtp < IDTX ? this.qm[tx][plane] : null;
        const dqShift = Math.max(0, tctx - 2);
        const cfMax = (128 << (f.bitdepth === 8 ? 8 : f.bitdepth)) - 1;
        let culLevel: number, dcSignLevel: number;
        if (!dcTok) {
            culLevel = 0;
            dcSignLevel = 1 << 6;
        } else {
            let sctx2 = 0;
            for (let i = 0; i < aw; i++) sctx2 += aArr[a + i] >> 6;
            for (let i = 0; i < lh; i++) sctx2 += lArr[l + i] >> 6;
            sctx2 -= aw + lh;
            const dcSignCtx = (sctx2 !== 0 ? 1 : 0) + (sctx2 > 0 ? 1 : 0);
            const dcSign = m.boolAdapt(cdf, CDF.dcSign + (chroma * 3 + dcSignCtx) * 2);
            let dcDq = dq[0];
            dcSignLevel = (dcSign - 1) & (2 << 6);
            if (qm) dcDq = (dcDq * qm[0] + 16) >> 5;
            if (dcTok === 15) {
                dcTok = m.golomb() + 15 & 0xfffff;
                dcDq = (dcDq * dcTok & 0xffffff) >> dqShift;
                dcDq = Math.min(dcDq, cfMax + dcSign);
            } else {
                dcDq = (dcDq * dcTok) >> dqShift;
                if (qm) dcDq = Math.min(dcDq, cfMax + dcSign);
            }
            culLevel = dcTok;
            cf[0] = dcSign ? -dcDq : dcDq;
        }
        if (rc) {
            const acDq = dq[1];
            do {
                const sign = m.bool();
                const rcTok = cf[rc];
                let tok: number, d = qm ? (acDq * qm[rc] + 16) >> 5 : acDq;
                if (rcTok >= 15 << 11) {
                    tok = m.golomb() + 15 & 0xfffff;
                    d = (d * tok & 0xffffff) >> dqShift;
                    d = Math.min(d, cfMax + sign);
                } else {
                    tok = rcTok >> 11;
                    d = (d * tok) >> dqShift;
                    if (qm) d = Math.min(d, cfMax + sign);
                }
                culLevel += tok;
                cf[rc] = sign ? -d : d;
                rc = rcTok & 0x3ff;
            } while (rc);
        }
        this.resCtx = Math.min(culLevel, 63) | dcSignLevel;
        return eob;
    }

    private reconIntra(bs: number, edgeFlags: number, b: Block, hasChroma: boolean): void {
        const f = this.frame, seq = this.seq;
        const bx = this.bx, by = this.by, bx4 = bx, by4 = by & 31;
        const ssx = f.ssx, ssy = f.ssy;
        const cbx4 = bx4 >> ssx, cby4 = by4 >> ssy;
        const bw4 = bdim(bs, 0), bh4 = bdim(bs, 1);
        const w4 = Math.min(bw4, f.bw - bx), h4 = Math.min(bh4, f.bh - by);
        const cw4 = w4 + ssx >> ssx, ch4 = h4 + ssy >> ssy;
        const cbw4 = bw4 + ssx >> ssx, cbh4 = bh4 + ssy >> ssy;
        const tx = b.tx, uvtx = b.uvtx;
        const tw = tdim(tx, W), th = tdim(tx, H), uvtw = tdim(uvtx, W), uvth = tdim(uvtx, H);
        const filterFlag = seq.intraEdgeFilter ? ANGLE_USE_EDGE_FILTER : 0;
        const bdMax = f.bitdepthMax;
        const pic = f.planes[0], stride = f.strides[0];
        const smFlag = (mode: number): number => mode === SMOOTH_PRED || mode === SMOOTH_H_PRED || mode === SMOOTH_V_PRED ? ANGLE_SMOOTH_EDGE : 0;

        for (let initY = 0; initY < h4; initY += 16) {
            const subH4 = Math.min(h4, 16 + initY);
            const subCh4 = Math.min(ch4, initY + 16 >> ssy);
            for (let initX = 0; initX < w4; initX += 16) {
                if (b.palSz[0]) {
                    const d = 4 * (by * stride + bx), bw = bw4 * 4;
                    for (let y = 0; y < bh4 * 4; y++) for (let x = 0; x < bw; x++) pic[d + y * stride + x] = this.pal[this.palIdxY[y * bw + x]];
                }
                const intraFlags = (this.aIntra[bx4] ? smFlag(this.aMode[bx4]) : 0) | (this.lIntra[by4] ? smFlag(this.lMode[by4]) : 0) | filterFlag;
                const sbHasTr = initX + 16 < w4 ? 1 : initY ? 0 : edgeFlags & EDGE_I444_TOP_HAS_RIGHT;
                const sbHasBl = initX ? 0 : initY + 16 < h4 ? 1 : edgeFlags & EDGE_I444_LEFT_HAS_BOTTOM;
                const subW4 = Math.min(w4, initX + 16);
                for (let y = initY; y < subH4; y += th) {
                    const ty = by + y;
                    let d = 4 * (ty * stride + bx + initX);
                    for (let x = initX; x < subW4; x += tw, d += 4 * tw) {
                        const tx4 = bx + x;
                        if (!b.palSz[0]) {
                            const flags = (((y > initY || !sbHasTr) && x + tw >= subW4) ? 0 : EDGE_I444_TOP_HAS_RIGHT) |
                                ((x > initX || (!sbHasBl && y + th >= subH4)) ? 0 : EDGE_I444_LEFT_HAS_BOTTOM);
                            const mode = prepareEdges(tx4, tx4 > this.colStart, ty, ty > this.rowStart, this.colEnd, this.rowEnd, flags,
                                pic, d, stride, b.yMode, b.yAngle, tw, th, seq.intraEdgeFilter, f.bitdepth);
                            predict(mode, pic, d, stride, tw * 4, th * 4, preparedAngle | intraFlags, 4 * f.bw - 4 * tx4, 4 * f.bh - 4 * ty, bdMax);
                        }
                        if (!b.skip) {
                            const eob = this.decodeCoefs(this.aLcoef, bx4 + x, this.lLcoef, by4 + y, tx, bs, b, 0);
                            this.aLcoef.fill(this.resCtx, bx4 + x, bx4 + x + Math.min(tw, f.bw - tx4));
                            this.lLcoef.fill(this.resCtx, by4 + y, by4 + y + Math.min(th, f.bh - ty));
                            if (eob >= 0) inverseTransformAdd(pic, d, stride, this.cf, eob, tx, this.txtp, bdMax);
                        } else {
                            this.aLcoef.fill(0x40, bx4 + x, bx4 + x + tw);
                            this.lLcoef.fill(0x40, by4 + y, by4 + y + th);
                        }
                    }
                }

                if (!hasChroma) continue;
                const cstride = f.strides[1];

                if (b.uvMode === CFL_PRED) {
                    const yo = 4 * (bx & ~ssx) + 4 * (by & ~ssy) * stride;
                    const furthestR = ((cw4 << ssx) + tw - 1) & ~(tw - 1);
                    const furthestB = ((ch4 << ssy) + th - 1) & ~(th - 1);
                    cflAc(this.ac, pic, yo, stride, cbw4 - (furthestR >> ssx), cbh4 - (furthestB >> ssy), cbw4 * 4, cbh4 * 4, ssx, ssy);
                    const uvOff = 4 * ((bx >> ssx) + (by >> ssy) * cstride);
                    for (let pl = 0; pl < 2; pl++) {
                        if (!b.cflAlpha[pl]) continue;
                        const xpos = bx >> ssx, ypos = by >> ssy;
                        const mode = prepareEdges(xpos, xpos > this.colStart >> ssx, ypos, ypos > this.rowStart >> ssy,
                            this.colEnd >> ssx, this.rowEnd >> ssy, 0, f.planes[1 + pl], uvOff, cstride, DC_PRED, 0, uvtw, uvth, false, f.bitdepth);
                        cflPredict(mode, f.planes[1 + pl], uvOff, cstride, uvtw * 4, uvth * 4, this.ac, b.cflAlpha[pl], bdMax);
                    }
                } else if (b.palSz[1]) {
                    const uvOff = 4 * ((bx >> ssx) + (by >> ssy) * cstride), bw = cbw4 * 4;
                    for (let pl = 1; pl <= 2; pl++) {
                        const plane = f.planes[pl];
                        for (let y = 0; y < cbh4 * 4; y++) for (let x = 0; x < bw; x++) plane[uvOff + y * cstride + x] = this.pal[pl * 8 + this.palIdxUv[y * bw + x]];
                    }
                }

                const smUv = smFlag(this.aUvmode[cbx4]) | smFlag(this.lUvmode[cby4]);
                const edge = f.layout === 1 ? [EDGE_I420_TOP_HAS_RIGHT, EDGE_I420_LEFT_HAS_BOTTOM] : f.layout === 2 ? [2, 16] : [1, 8];
                const uvSbHasTr = (initX + 16 >> ssx) < cw4 ? 1 : initY ? 0 : edgeFlags & edge[0];
                const uvSbHasBl = initX ? 0 : (initY + 16 >> ssy) < ch4 ? 1 : edgeFlags & edge[1];
                const subCw4 = Math.min(cw4, initX + 16 >> ssx);
                for (let pl = 0; pl < 2; pl++) {
                    const plane = f.planes[1 + pl];
                    const aC = this.aCcoef[pl], lC = this.lCcoef[pl];
                    for (let y = initY >> ssy, tyl = by + initY; y < subCh4; y += uvth, tyl += uvth << ssy) {
                        let d = 4 * ((tyl >> ssy) * cstride + (bx + initX >> ssx));
                        for (let x = initX >> ssx, txl = bx + initX; x < subCw4; x += uvtw, txl += uvtw << ssx, d += uvtw * 4) {
                            if (!(b.uvMode === CFL_PRED && b.cflAlpha[pl]) && !b.palSz[1]) {
                                const flags = (((y > (initY >> ssy) || !uvSbHasTr) && x + uvtw >= subCw4) ? 0 : EDGE_I444_TOP_HAS_RIGHT) |
                                    ((x > (initX >> ssx) || (!uvSbHasBl && y + uvth >= subCh4)) ? 0 : EDGE_I444_LEFT_HAS_BOTTOM);
                                const uvMode = b.uvMode === CFL_PRED ? DC_PRED : b.uvMode;
                                const xpos = txl >> ssx, ypos = tyl >> ssy;
                                const mode = prepareEdges(xpos, xpos > this.colStart >> ssx, ypos, ypos > this.rowStart >> ssy,
                                    this.colEnd >> ssx, this.rowEnd >> ssy, flags, plane, d, cstride, uvMode, b.uvAngle, uvtw, uvth,
                                    seq.intraEdgeFilter, f.bitdepth);
                                predict(mode, plane, d, cstride, uvtw * 4, uvth * 4, preparedAngle | filterFlag | smUv,
                                    (4 * f.bw + ssx - 4 * (txl & ~ssx)) >> ssx, (4 * f.bh + ssy - 4 * (tyl & ~ssy)) >> ssy, bdMax);
                            }
                            if (!b.skip) {
                                const eob = this.decodeCoefs(aC, cbx4 + x, lC, cby4 + y, uvtx, bs, b, 1 + pl);
                                const ctw = Math.min(uvtw, (f.bw - txl + ssx) >> ssx);
                                const cth = Math.min(uvth, (f.bh - tyl + ssy) >> ssy);
                                aC.fill(this.resCtx, cbx4 + x, cbx4 + x + ctw);
                                lC.fill(this.resCtx, cby4 + y, cby4 + y + cth);
                                if (eob >= 0) inverseTransformAdd(plane, d, cstride, this.cf, eob, uvtx, this.txtp, bdMax);
                            } else {
                                aC.fill(0x40, cbx4 + x, cbx4 + x + uvtw);
                                lC.fill(0x40, cby4 + y, cby4 + y + uvth);
                            }
                        }
                    }
                }
            }
        }
    }
}
