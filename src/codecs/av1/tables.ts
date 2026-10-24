/*!
 * Constants and tables of the AV1 decoder, ported from dav1d (src/levels.h, src/intra_edge.c, src/qm.c, src/cdf.c).
 * Copyright (c) 2018-2021, VideoLAN and dav1d authors, Copyright (c) 2018, Two Orioles, LLC, BSD-2-Clause License
 * (see THIRD_PARTY_NOTICES.md)
 */

import * as data from './data.ts';
import { base64 } from '../../util/bytes.ts';
import { decompress } from '../zlib.ts';

// block levels and sizes
export const BL_128X128 = 0, BL_64X64 = 1, BL_8X8 = 4;
export const BS_128x128 = 0, BS_64x64 = 3, BS_4x4 = 21;

export const PARTITION_NONE = 0, PARTITION_H = 1, PARTITION_V = 2, PARTITION_SPLIT = 3, PARTITION_T_TOP_SPLIT = 4,
    PARTITION_T_BOTTOM_SPLIT = 5, PARTITION_T_LEFT_SPLIT = 6, PARTITION_T_RIGHT_SPLIT = 7, PARTITION_H4 = 8,
    PARTITION_V4 = 9;

// intra prediction modes (and the ones the predictors are chosen by)
export const DC_PRED = 0, VERT_PRED = 1, HOR_PRED = 2, DIAG_DOWN_LEFT_PRED = 3, VERT_LEFT_PRED = 8, SMOOTH_PRED = 9,
    SMOOTH_V_PRED = 10, SMOOTH_H_PRED = 11, PAETH_PRED = 12, CFL_PRED = 13, FILTER_PRED = 13,
    LEFT_DC_PRED = 3, TOP_DC_PRED = 4, DC_128_PRED = 5, Z1_PRED = 6, Z2_PRED = 7, Z3_PRED = 8;

// transform sizes and types
export const TX_4X4 = 0, TX_8X8 = 1, TX_16X16 = 2, TX_32X32 = 3, TX_64X64 = 4, RTX_4X8 = 5;
export const DCT_DCT = 0, IDTX = 9, WHT_WHT = 16;
export const TX_CLASS_2D = 0, TX_CLASS_H = 1, TX_CLASS_V = 2;

// which neighbouring edges an intra predicted block can use
export const EDGE_I444_TOP_HAS_RIGHT = 1, EDGE_I422_TOP_HAS_RIGHT = 2, EDGE_I420_TOP_HAS_RIGHT = 4,
    EDGE_I444_LEFT_HAS_BOTTOM = 8, EDGE_I422_LEFT_HAS_BOTTOM = 16, EDGE_I420_LEFT_HAS_BOTTOM = 32,
    EDGE_ALL_TOP_HAS_RIGHT = 7, EDGE_ALL_LEFT_HAS_BOTTOM = 56, EDGE_ALL_TR_AND_BL = 63;

export const {
    AL_PART_CTX, BLOCK_SIZES, BLOCK_DIMENSIONS, TXFM_DIMENSIONS, MAX_TXFM_SIZE_FOR_BS, TXTP_FROM_UVMODE,
    PARTITION_TYPE_COUNT, TX_TYPES_PER_SET, FILTER_MODE_TO_Y_MODE, LO_CTX_OFFSETS, SKIP_CTX, TX_TYPE_CLASS,
    INTRA_MODE_CONTEXT, CDEF_DIRECTIONS, SGR_PARAMS, SGR_X_BY_X, SM_WEIGHTS, DR_INTRA_DERIVATIVE, FILTER_INTRA_TAPS,
    RESIZE_FILTER, CDF, SCAN_OFFSETS
} = data;

/** the block sizes chroma from luma is allowed for */
export const CFL_ALLOWED_MASK = (1 << 7) | (1 << 8) | (1 << 9) | (1 << 11) | (1 << 12) | (1 << 13) | (1 << 14) | (1 << 15) |
    (1 << 16) | (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20) | (1 << 21);

let tables: {
    modeCdfs: Uint16Array, coefCdfs: Uint16Array[], scans: Uint16Array, dq: Uint16Array, qm: Uint8Array[][][],
    gaussianSequence: Int16Array
} | null = null;

// the packed tables, unpacked the first time they're needed
function load(): NonNullable<typeof tables> {
    if (tables) return tables;
    const at = data.PACKED_AT;
    const blob = decompress(base64(data.PACKED), at.size[1]);
    const bytes = ([offset, size]: number[]): Uint8Array => blob.subarray(offset, offset + size);
    // (little endian)
    const words = ([offset, size]: number[]): Uint16Array => {
        const w = new Uint16Array(size >> 1);
        for (let i = 0; i < w.length; i++) w[i] = blob[offset + i * 2] | blob[offset + i * 2 + 1] << 8;
        return w;
    };
    return tables = {
        modeCdfs: words(at.modeCdfs),
        coefCdfs: [at.coefCdfs0, at.coefCdfs1, at.coefCdfs2, at.coefCdfs3].map(words),
        scans: words(at.scans),
        dq: words(at.dq),
        qm: buildQm(bytes(at.qm)),
        gaussianSequence: new Int16Array(words(at.gaussianSequence))
    };
}

/** dav1d_gaussian_sequence: the film grain's gaussian noise */
export function gaussianSequence(): Int16Array {
    return load().gaussianSequence;
}

/** a new CDF context with the default CDFs of the quantizer category of qidx */
export function defaultCdfs(qidx: number): Uint16Array {
    const t = load();
    const cdf = new Uint16Array(CDF.size);
    cdf.set(t.modeCdfs);
    cdf.set(t.coefCdfs[(qidx > 20 ? 1 : 0) + (qidx > 60 ? 1 : 0) + (qidx > 120 ? 1 : 0)], t.modeCdfs.length);
    return cdf;
}

/** the scan of a (2D) transform size */
export function scan(tx: number): Uint16Array {
    const t = load();
    const w = Math.min(TXFM_DIMENSIONS[tx * 8] * 4, 32), h = Math.min(TXFM_DIMENSIONS[tx * 8 + 1] * 4, 32);
    return t.scans.subarray(SCAN_OFFSETS[tx], SCAN_OFFSETS[tx] + w * h);
}

/** a dequantizer: bit depth index (0: 8, 1: 10, 2: 12), qindex, DC (0) or AC (1) */
export function dequant(hbd: number, qidx: number, ac: number): number {
    return load().dq[(hbd * 256 + qidx) * 2 + ac];
}

/** the quantizer matrix of a level (0-14), luma (0) or chroma (1), transform size (like dav1d's, coefficients transposed) */
export function quantizerMatrix(level: number, chroma: number, tx: number): Uint8Array {
    return load().qm[level][chroma][tx];
}

// dav1d_init_qm_tables: the rectangular matrices are subsampled and transposed from the 32x16 and 32x32 ones
function buildQm(src: Uint8Array): Uint8Array[][][] {
    const subsample = (s: Uint8Array, o: number, h: number, hstep: number, vstep: number): Uint8Array => {
        const out: number[] = [];
        for (let y = 0; y < h; y += vstep) for (let x = 0; x < 32; x += hstep) out.push(s[o + y * 32 + x]);
        return Uint8Array.from(out);
    };
    const transpose = (s: Uint8Array, w: number, h: number): Uint8Array => {
        const d = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[x * h + y] = s[y * w + x];
        return d;
    };
    const result: Uint8Array[][][] = [];
    for (let i = 0; i < 15; i++) {
        const level: Uint8Array[][] = [];
        for (let j = 0; j < 2; j++) {
            const t32x16 = src.subarray((i * 2 + j) * 512, (i * 2 + j + 1) * 512);
            // the 32x32 matrix is symmetric, stored as its lower triangle
            const tri = src.subarray(15 * 2 * 512 + (i * 2 + j) * 528);
            const t32x32 = new Uint8Array(1024);
            for (let y = 0, o = 0; y < 32; y++) for (let x = 0; x <= y; x++, o++) t32x32[y * 32 + x] = t32x32[x * 32 + y] = tri[o];
            const t4x4 = subsample(t32x32, 32 * 3 + 3, 32, 8, 8);
            const t8x4 = subsample(t32x16, 32 + 1, 16, 4, 4);
            const t8x8 = subsample(t32x32, 32 + 1, 32, 4, 4);
            const t16x4 = subsample(t32x16, 32, 16, 2, 4);
            const t16x8 = subsample(t32x16, 0, 16, 2, 2);
            const t16x16 = subsample(t32x32, 0, 32, 2, 2);
            const t32x8 = subsample(t32x16, 0, 16, 1, 2);
            const t4x8 = transpose(t8x4, 8, 4), t4x16 = transpose(t16x4, 16, 4), t8x16 = transpose(t16x8, 16, 8);
            const t8x32 = transpose(t32x8, 32, 8), t16x32 = transpose(t32x16, 32, 16);
            // indexed by transform size: the width and height swapped, coefficients are stored transposed
            const byTx: Uint8Array[] = [];
            byTx[TX_4X4] = t4x4; byTx[TX_8X8] = t8x8; byTx[TX_16X16] = t16x16; byTx[TX_32X32] = t32x32;
            byTx[TX_64X64] = t32x32;
            byTx[5] = t8x4; byTx[6] = t4x8; // 4x8, 8x4
            byTx[7] = t16x8; byTx[8] = t8x16; // 8x16, 16x8
            byTx[9] = t32x16; byTx[10] = t16x32; // 16x32, 32x16
            byTx[11] = t32x32; byTx[12] = t32x32; // 32x64, 64x32
            byTx[13] = t16x4; byTx[14] = t4x16; // 4x16, 16x4
            byTx[15] = t32x8; byTx[16] = t8x32; // 8x32, 32x8
            byTx[17] = t32x16; byTx[18] = t16x32; // 16x64, 64x16
            level.push(byTx);
        }
        result.push(level);
    }
    return result;
}

/** A node of the tree of which edges the blocks of a superblock have (dav1d's intra edge tree) */
export interface EdgeNode {
    o: number;
    h: number[];
    v: number[];
    h4: number;
    v4: number;
    /** branches: the four quarters; tips (8x8): the edge flags of the 4x4 blocks */
    split: EdgeNode[];
    tip: number[];
}

function initEdges(bl: number, flags: number): EdgeNode {
    const node: EdgeNode = { o: flags, h: [flags | EDGE_ALL_LEFT_HAS_BOTTOM, 0], v: [flags | EDGE_ALL_TOP_HAS_RIGHT, 0], h4: 0, v4: 0, split: [], tip: [] };
    if (bl === BL_8X8) {
        node.h[1] = flags & (EDGE_ALL_LEFT_HAS_BOTTOM | EDGE_I420_TOP_HAS_RIGHT);
        node.v[1] = flags & (EDGE_ALL_TOP_HAS_RIGHT | EDGE_I420_LEFT_HAS_BOTTOM | EDGE_I422_LEFT_HAS_BOTTOM);
        node.tip = [
            flags & EDGE_ALL_TOP_HAS_RIGHT | EDGE_I422_LEFT_HAS_BOTTOM,
            flags | EDGE_I444_TOP_HAS_RIGHT,
            flags & (EDGE_I420_TOP_HAS_RIGHT | EDGE_I420_LEFT_HAS_BOTTOM | EDGE_I422_LEFT_HAS_BOTTOM)
        ];
    } else {
        node.h[1] = flags & EDGE_ALL_LEFT_HAS_BOTTOM;
        node.v[1] = flags & EDGE_ALL_TOP_HAS_RIGHT;
        node.h4 = EDGE_ALL_LEFT_HAS_BOTTOM;
        node.v4 = EDGE_ALL_TOP_HAS_RIGHT;
        if (bl === 3) {
            node.h4 |= flags & EDGE_I420_TOP_HAS_RIGHT;
            node.v4 |= flags & (EDGE_I420_LEFT_HAS_BOTTOM | EDGE_I422_LEFT_HAS_BOTTOM);
        }
    }
    return node;
}

function initModeNode(bl: number, topHasRight: boolean, leftHasBottom: boolean): EdgeNode {
    const node = initEdges(bl, (topHasRight ? EDGE_ALL_TOP_HAS_RIGHT : 0) | (leftHasBottom ? EDGE_ALL_LEFT_HAS_BOTTOM : 0));
    for (let n = 0; n < 4; n++) {
        const tr = !(n === 3 || n === 1 && !topHasRight), lb = n === 0 || n === 2 && leftHasBottom;
        node.split.push(bl === 3
            ? initEdges(bl + 1, (tr ? EDGE_ALL_TOP_HAS_RIGHT : 0) | (lb ? EDGE_ALL_LEFT_HAS_BOTTOM : 0))
            : initModeNode(bl + 1, tr, lb));
    }
    return node;
}

let edgeTrees: EdgeNode[] | null = null;

/** the edge tree of 128x128 (sb128) or 64x64 superblocks */
export function edgeTree(sb128: boolean): EdgeNode {
    edgeTrees ??= [initModeNode(BL_128X128, true, false), initModeNode(BL_64X64, true, false)];
    return edgeTrees[sb128 ? 0 : 1];
}
