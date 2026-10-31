/*!
 * VP8 key frame decoder (WebP lossy), following RFC 6386 and its reference decoder (Copyright (c) 2010, 2011 Google
 * Inc., BSD license). The YUV -> RGB conversion and the "fancy" chroma upsampling reproduce libwebp's (Copyright (c)
 * 2010 Google Inc., BSD license), so the output matches libwebp exactly. See THIRD_PARTY_NOTICES.md
 */
import { KF_BMODE_PROBS, COEFF_UPDATE_PROBS, DEFAULT_COEFF_PROBS, DC_QLOOKUP, AC_QLOOKUP, PCAT } from './vp8-tables.ts';
import { MAX_PIXELS, checkPixels } from '../util/limits.ts';
import { littleEndian } from '../util/alpha.ts';

/**
 * Boolean entropy decoder, RFC 6386 section 7
 */
class BoolDecoder {
    private data: Uint8Array;
    private pos: number;
    private end: number;
    private value: number;
    private range = 255;
    private bitCount = 0;

    constructor(data: Uint8Array, start: number, end: number) {
        this.data = data;
        this.end = Math.min(end, data.length);
        this.pos = start;
        this.value = this.next() << 8 | this.next();
    }

    private next(): number {
        // past the end, the stream continues with zeros (like libvpx)
        return this.pos < this.end ? this.data[this.pos++] : (this.pos++, 0);
    }

    read(probability: number): number {
        const split = 1 + ((this.range - 1) * probability >> 8);
        const bigSplit = split << 8;
        let bit: number;
        if (this.value >= bigSplit) {
            bit = 1;
            this.range -= split;
            this.value -= bigSplit;
        } else {
            bit = 0;
            this.range = split;
        }

        if (this.range < 128) {
            const shift = Math.clz32(this.range) - 24;
            this.range <<= shift;
            this.value <<= shift;
            this.bitCount += shift;
            if (this.bitCount >= 8) {
                this.bitCount -= 8;
                this.value |= this.next() << this.bitCount;
            }
        }

        return bit;
    }

    /** unsigned n-bit literal, most significant bit first */
    literal(bits: number): number {
        let v = 0;
        while (bits-- > 0) v = v << 1 | this.read(128);
        return v;
    }

    /** magnitude followed by a sign bit, if the flag is set */
    optionalSigned(bits: number): number {
        if (!this.read(128)) return 0;
        const v = this.literal(bits);
        return this.read(128) ? -v : v;
    }

    /** reads a value through a tree (RFC 6386 section 8.1) */
    tree(tree: Int8Array, probs: ArrayLike<number>, offset = 0): number {
        let i = 0;
        while ((i = tree[i + this.read(probs[offset + (i >> 1)])]) > 0);
        // (| 0: the leaf 0 would be -0, a double, which keeps deoptimizing the callers)
        return -i | 0;
    }

    /** whether the decoder read beyond its data */
    get exhausted(): boolean {
        return this.pos > this.end + 2;
    }
}

// luma (16x16) modes and subblock modes
const DC_PRED = 0, V_PRED = 1, H_PRED = 2, TM_PRED = 3, B_PRED = 4;
const B_DC_PRED = 0, B_TM_PRED = 1, B_VE_PRED = 2, B_HE_PRED = 3, B_LD_PRED = 4, B_RD_PRED = 5, B_VR_PRED = 6, B_VL_PRED = 7, B_HD_PRED = 8, B_HU_PRED = 9;

// trees, RFC 6386 sections 11.2, 11.4, 9.3 (leaves are stored negated, B_DC_PRED/DC_PRED/segment 0 as -0)
const KF_YMODE_TREE = Int8Array.of(-B_PRED, 2, 4, 6, -DC_PRED, -V_PRED, -H_PRED, -TM_PRED);
const KF_YMODE_PROBS = Uint8Array.of(145, 156, 163, 128);
const UV_MODE_TREE = Int8Array.of(-DC_PRED, 2, -V_PRED, 4, -H_PRED, -TM_PRED);
const KF_UV_MODE_PROBS = Uint8Array.of(142, 114, 183);
const BMODE_TREE = Int8Array.of(
    -B_DC_PRED, 2, -B_TM_PRED, 4, -B_VE_PRED, 6, 8, 12, -B_HE_PRED, 10, -B_RD_PRED, -B_VR_PRED, -B_LD_PRED, 14,
    -B_VL_PRED, 16, -B_HD_PRED, -B_HU_PRED
);
const SEGMENT_TREE = Int8Array.of(2, 4, -0, -1, -2, -3);

// subblock mode implied by a 16x16 mode, for the subblock mode contexts
const IMPLIED_BMODE = [B_DC_PRED, B_VE_PRED, B_HE_PRED, B_TM_PRED];

const ZIGZAG = Uint8Array.of(0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15);
const BANDS = Uint8Array.of(0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0);
const CATEGORY_BASE = [5, 7, 11, 19, 35, 67];

// coefficient block types: Y after Y2, Y2, chroma, Y with DC
const TYPE_Y_AC = 0, TYPE_Y2 = 1, TYPE_UV = 2, TYPE_Y = 3;

interface Header {
    width: number;
    height: number;
    filterType: number;
    filterLevel: number;
    sharpness: number;
    lfDeltas: { enabled: boolean, ref: Int32Array, mode: Int32Array };
    segmentation: { enabled: boolean, updateMap: boolean, absolute: boolean, quant: Int32Array, filter: Int32Array, probs: Uint8Array };
    partitions: BoolDecoder[];
    coeffProbs: Uint8Array;
    skipProb: number;
    /** [segment][y1 dc, y1 ac, y2 dc, y2 ac, uv dc, uv ac] */
    quant: Int32Array[];
}

const clampQ = (q: number): number => q < 0 ? 0 : q > 127 ? 127 : q;

function readHeader(data: Uint8Array): { header: Header, first: BoolDecoder } {
    if (data.length < 10) throw new Error('VP8: truncated header');
    const tag = data[0] | data[1] << 8 | data[2] << 16;
    if (tag & 1) throw new Error('VP8: not a key frame');
    if ((tag >> 1 & 7) > 3) throw new Error('VP8: unknown version');
    const firstSize = tag >>> 5;
    if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new Error('VP8: invalid start code');
    const width = (data[6] | data[7] << 8) & 0x3fff;
    const height = (data[8] | data[9] << 8) & 0x3fff;
    if (!width || !height) throw new Error('VP8: invalid dimensions');
    if (10 + firstSize > data.length) throw new Error('VP8: truncated first partition');

    const d = new BoolDecoder(data, 10, 10 + firstSize);
    d.literal(1); // color space
    d.literal(1); // clamping type, clamping is always done

    const segmentation = { enabled: false, updateMap: false, absolute: false, quant: new Int32Array(4), filter: new Int32Array(4), probs: Uint8Array.of(255, 255, 255) };
    if (d.literal(1)) {
        segmentation.enabled = true;
        segmentation.updateMap = d.literal(1) === 1;
        if (d.literal(1)) {
            segmentation.absolute = d.literal(1) === 1;
            for (let i = 0; i < 4; i++) segmentation.quant[i] = d.optionalSigned(7);
            for (let i = 0; i < 4; i++) segmentation.filter[i] = d.optionalSigned(6);
        }
        if (segmentation.updateMap)
            for (let i = 0; i < 3; i++) segmentation.probs[i] = d.literal(1) ? d.literal(8) : 255;
    }

    const filterType = d.literal(1);
    const filterLevel = d.literal(6);
    const sharpness = d.literal(3);
    const lfDeltas = { enabled: false, ref: new Int32Array(4), mode: new Int32Array(4) };
    if (d.literal(1)) {
        lfDeltas.enabled = true;
        if (d.literal(1)) {
            for (let i = 0; i < 4; i++) if (d.literal(1)) lfDeltas.ref[i] = d.literal(6) * (d.literal(1) ? -1 : 1);
            for (let i = 0; i < 4; i++) if (d.literal(1)) lfDeltas.mode[i] = d.literal(6) * (d.literal(1) ? -1 : 1);
        }
    }

    // DCT token partitions: their sizes (3 bytes each, all but the last) follow the first partition
    const count = 1 << d.literal(2);
    let offset = 10 + firstSize;
    const sizesStart = offset;
    offset += 3 * (count - 1);
    if (offset > data.length) throw new Error('VP8: truncated partitions');
    const partitions: BoolDecoder[] = [];
    for (let i = 0; i < count; i++) {
        const s = sizesStart + 3 * i;
        const size = i < count - 1 ? data[s] | data[s + 1] << 8 | data[s + 2] << 16 : data.length - offset;
        partitions.push(new BoolDecoder(data, offset, offset + size));
        offset += size;
    }

    const base = d.literal(7);
    const y1dc = d.optionalSigned(4), y2dc = d.optionalSigned(4), y2ac = d.optionalSigned(4), uvdc = d.optionalSigned(4), uvac = d.optionalSigned(4);
    const quant: Int32Array[] = [];
    for (let s = 0; s < 4; s++) {
        let q = base;
        if (segmentation.enabled) q = segmentation.absolute ? segmentation.quant[s] : q + segmentation.quant[s];
        const y2acFactor = AC_QLOOKUP[clampQ(q + y2ac)] * 155 / 100 | 0;
        quant.push(Int32Array.of(
            DC_QLOOKUP[clampQ(q + y1dc)],
            AC_QLOOKUP[clampQ(q)],
            DC_QLOOKUP[clampQ(q + y2dc)] * 2,
            y2acFactor < 8 ? 8 : y2acFactor,
            Math.min(132, DC_QLOOKUP[clampQ(q + uvdc)]),
            AC_QLOOKUP[clampQ(q + uvac)]
        ));
    }

    d.literal(1); // refresh entropy probs, irrelevant for a single frame

    const coeffProbs = DEFAULT_COEFF_PROBS.slice();
    for (let i = 0; i < coeffProbs.length; i++)
        if (d.read(COEFF_UPDATE_PROBS[i])) coeffProbs[i] = d.literal(8);

    const skipProb = d.literal(1) ? d.literal(8) : -1;

    return {
        header: { width, height, filterType, filterLevel, sharpness, lfDeltas, segmentation, partitions, coeffProbs, skipProb, quant },
        first: d
    };
}

const clamp255 = (v: number): number => v < 0 ? 0 : v > 255 ? 255 : v;

/**
 * Decodes a VP8 key frame (the payload of a VP8 chunk) into RGBA
 */
export function decode(data: Uint8Array, maxPixels = MAX_PIXELS): { width: number, height: number, pixels: Uint8Array } {
    const { header: h, first: d } = readHeader(data);
    const { width, height } = h;
    checkPixels(width, height, maxPixels);
    const mbw = (width + 15) >> 4, mbh = (height + 15) >> 4;

    // planes with a one pixel border on the top and left (127 above, 129 to the left, as the spec defines)
    const ys = mbw * 16 + 1, cs = mbw * 8 + 1;
    const Y = new Uint8Array(ys * (mbh * 16 + 1));
    const U = new Uint8Array(cs * (mbh * 8 + 1));
    const V = new Uint8Array(cs * (mbh * 8 + 1));
    for (const [plane, stride] of [[Y, ys], [U, cs], [V, cs]] as const) {
        plane.fill(127, 0, stride);
        for (let i = stride; i < plane.length; i += stride) plane[i] = 129;
    }

    // per macroblock info needed by the loop filter
    const mbCount = mbw * mbh;
    const mbSegment = new Uint8Array(mbCount);
    const mbInner = new Uint8Array(mbCount); // filter the inner edges (B_PRED or coefficients present)
    const mbBpred = new Uint8Array(mbCount);

    // contexts: subblock modes above (4 per mb column) and left; non-zero flags above (9 per column) and left
    const aboveModes = new Uint8Array(mbw * 4);
    const leftModes = new Uint8Array(4);
    const aboveNz = new Uint8Array(mbw * 9);
    const leftNz = new Uint8Array(9);

    const coeffs = new Int16Array(25 * 16);
    const bmodes = new Uint8Array(16);
    const edge = new Uint8Array(21); // P, 16 pixels above, 4 above right (luma) / P, 8 above (chroma)
    const left = new Uint8Array(16);

    for (let mby = 0; mby < mbh; mby++) {
        const tokens = h.partitions[mby % h.partitions.length];
        leftModes.fill(B_DC_PRED);
        leftNz.fill(0);

        for (let mbx = 0; mbx < mbw; mbx++) {
            const mb = mby * mbw + mbx;

            // macroblock header (first partition)
            const segment = h.segmentation.updateMap ? d.tree(SEGMENT_TREE, h.segmentation.probs) : 0;
            mbSegment[mb] = segment;
            const skip = h.skipProb >= 0 ? d.read(h.skipProb) : 0;
            const ymode = d.tree(KF_YMODE_TREE, KF_YMODE_PROBS);

            if (ymode === B_PRED) {
                for (let b = 0; b < 16; b++) {
                    const above = b < 4 ? aboveModes[mbx * 4 + b] : bmodes[b - 4];
                    const l = (b & 3) === 0 ? leftModes[b >> 2] : bmodes[b - 1];
                    bmodes[b] = d.tree(BMODE_TREE, KF_BMODE_PROBS, (above * 10 + l) * 9);
                }
            } else bmodes.fill(IMPLIED_BMODE[ymode]);

            for (let i = 0; i < 4; i++) {
                aboveModes[mbx * 4 + i] = bmodes[12 + i];
                leftModes[i] = bmodes[i * 4 + 3];
            }
            const uvmode = d.tree(UV_MODE_TREE, KF_UV_MODE_PROBS);

            // residual data (token partition)
            const hasY2 = ymode !== B_PRED;
            const an = mbx * 9; // above non-zero flags: 0-3 Y, 4-5 U, 6-7 V, 8 Y2
            coeffs.fill(0);
            let nonZero = 0; // bit per block (0-15 Y, 16-23 U/V) with a non-zero coefficient, 24: Y2 AC
            let ac = 0; // bit per block with AC coefficients (the others only add their DC's share to the prediction)

            if (!skip) {
                const q = h.quant[segment];
                if (hasY2) {
                    const ctx = aboveNz[an + 8] + leftNz[8];
                    const n = readCoefficients(tokens, h.coeffProbs, TYPE_Y2, ctx, 0, q[2], q[3], coeffs, 384);
                    aboveNz[an + 8] = leftNz[8] = n > 0 ? 1 : 0;
                    inverseWHT(coeffs, 384, n);
                }

                const type = hasY2 ? TYPE_Y_AC : TYPE_Y, first = hasY2 ? 1 : 0;
                for (let b = 0; b < 16; b++) {
                    const x = b & 3, y = b >> 2;
                    const ctx = aboveNz[an + x] + leftNz[y];
                    const n = readCoefficients(tokens, h.coeffProbs, type, ctx, first, q[0], q[1], coeffs, b * 16);
                    aboveNz[an + x] = leftNz[y] = n > first ? 1 : 0;
                    if (n > first || coeffs[b * 16] !== 0) nonZero |= 1 << b;
                    if (n > 1) ac |= 1 << b;
                }

                for (let b = 16; b < 24; b++) {
                    const plane = b < 20 ? 4 : 6, x = b & 1, y = (b >> 1) & 1;
                    const ctx = aboveNz[an + plane + x] + leftNz[plane + y];
                    const n = readCoefficients(tokens, h.coeffProbs, TYPE_UV, ctx, 0, q[4], q[5], coeffs, b * 16);
                    aboveNz[an + plane + x] = leftNz[plane + y] = n > 0 ? 1 : 0;
                    if (n > 0) nonZero |= 1 << b;
                    if (n > 1) ac |= 1 << b;
                }
            } else {
                // a skipped macroblock has no coefficients, its contexts are cleared (Y2's only if it has one)
                aboveNz.fill(0, an, an + 8);
                leftNz.fill(0, 0, 8);
                if (hasY2) aboveNz[an + 8] = leftNz[8] = 0;
            }

            mbBpred[mb] = ymode === B_PRED ? 1 : 0;
            mbInner[mb] = ymode === B_PRED || nonZero !== 0 ? 1 : 0;

            // prediction and reconstruction
            const yBase = (mby * 16 + 1) * ys + mbx * 16 + 1;
            if (ymode === B_PRED) {
                for (let b = 0; b < 16; b++) {
                    const bx = b & 3, by = b >> 2;
                    const base = yBase + by * 4 * ys + bx * 4;
                    // above row with above-right pixels: blocks on the right edge use the ones of block 3
                    for (let i = 0; i < 5; i++) edge[i] = Y[base - ys - 1 + i];
                    if (bx < 3) for (let i = 5; i < 9; i++) edge[i] = Y[base - ys - 1 + i];
                    else {
                        const top = yBase - ys + 16;
                        for (let i = 5; i < 9; i++)
                            edge[i] = mby === 0 ? 127 : mbx === mbw - 1 ? Y[yBase - ys + 15] : Y[top + i - 5];
                    }
                    for (let i = 0; i < 4; i++) left[i] = Y[base + i * ys - 1];
                    predictSubblock(bmodes[b], edge, left, Y, base, ys);
                    if (nonZero >> b & 1) inverseDCT(coeffs, b * 16, Y, base, ys, ac >> b & 1);
                }
            } else {
                predictBlock(ymode, Y, yBase, ys, 16, mbx, mby);
                for (let b = 0; b < 16; b++)
                    if (nonZero >> b & 1) inverseDCT(coeffs, b * 16, Y, yBase + (b >> 2) * 4 * ys + (b & 3) * 4, ys, ac >> b & 1);
            }

            const cBase = (mby * 8 + 1) * cs + mbx * 8 + 1;
            predictBlock(uvmode, U, cBase, cs, 8, mbx, mby);
            predictBlock(uvmode, V, cBase, cs, 8, mbx, mby);
            for (let b = 16; b < 24; b++) {
                if (!(nonZero >> b & 1)) continue;
                const plane = b < 20 ? U : V, i = b & 3;
                inverseDCT(coeffs, b * 16, plane, cBase + (i >> 1) * 4 * cs + (i & 1) * 4, cs, ac >> b & 1);
            }
        }

        if (tokens.exhausted && d.exhausted) throw new Error('VP8: unexpected end of data');
    }

    // a frame level of 0 disables the filter, whatever the segments say (RFC 6386 section 15)
    if (h.filterLevel) loopFilter(h, Y, U, V, ys, cs, mbw, mbh, mbSegment, mbInner, mbBpred);

    return { width, height, pixels: toRGBA(Y, U, V, ys, cs, width, height) };
}

/**
 * Reads one block's tokens (RFC 6386 section 13), dequantizing into out[offset + zigzag position]
 * @return the position after the last decoded token (index of the end of block)
 */
function readCoefficients(d: BoolDecoder, probs: Uint8Array, type: number, ctx: number, first: number, dcFactor: number, acFactor: number, out: Int16Array, offset: number): number {
    let i = first;
    let p = ((type * 8 + BANDS[i]) * 3 + ctx) * 11;
    let previousZero = false;

    for (; i < 16; i++) {
        if (!previousZero && !d.read(probs[p])) return i; // end of block

        if (!d.read(probs[p + 1])) {
            // zero, the next token can't be the end of block
            previousZero = true;
            p = ((type * 8 + BANDS[i + 1]) * 3) * 11;
            continue;
        }

        let v: number;
        if (!d.read(probs[p + 2])) v = 1;
        else if (!d.read(probs[p + 3])) v = d.read(probs[p + 4]) ? 3 + d.read(probs[p + 5]) : 2;
        else {
            let category: number;
            if (!d.read(probs[p + 6])) category = d.read(probs[p + 7]);
            else if (!d.read(probs[p + 8])) category = 2 + d.read(probs[p + 9]);
            else category = 4 + d.read(probs[p + 10]);

            const extra = PCAT[category];
            let e = 0;
            for (let k = 0; k < extra.length; k++) e = e << 1 | d.read(extra[k]);
            v = CATEGORY_BASE[category] + e;
        }

        if (d.read(128)) v = -v;
        out[offset + ZIGZAG[i]] = v * (i > 0 ? acFactor : dcFactor);
        previousZero = false;
        p = ((type * 8 + BANDS[i + 1]) * 3 + (v === 1 || v === -1 ? 1 : 2)) * 11;
    }

    return 16;
}

// inverse Walsh-Hadamard transform of the Y2 block (RFC 6386 section 14.3), the results become the Y blocks' DCs
function inverseWHT(c: Int16Array, offset: number, count: number): void {
    const out = new Int32Array(16);
    if (count > 1) {
        for (let i = 0; i < 4; i++) {
            const a1 = c[offset + i] + c[offset + 12 + i];
            const b1 = c[offset + 4 + i] + c[offset + 8 + i];
            const c1 = c[offset + 4 + i] - c[offset + 8 + i];
            const d1 = c[offset + i] - c[offset + 12 + i];
            out[i] = a1 + b1;
            out[4 + i] = c1 + d1;
            out[8 + i] = a1 - b1;
            out[12 + i] = d1 - c1;
        }
        for (let i = 0; i < 4; i++) {
            const r = i * 4;
            const a1 = out[r] + out[r + 3];
            const b1 = out[r + 1] + out[r + 2];
            const c1 = out[r + 1] - out[r + 2];
            const d1 = out[r] - out[r + 3];
            out[r] = a1 + b1 + 3 >> 3;
            out[r + 1] = c1 + d1 + 3 >> 3;
            out[r + 2] = a1 - b1 + 3 >> 3;
            out[r + 3] = d1 - c1 + 3 >> 3;
        }
    } else out.fill(c[offset] + 3 >> 3);

    for (let b = 0; b < 16; b++) c[b * 16] = out[b];
}

// inverse DCT (RFC 6386 section 14.4), added to the prediction in place
const tmp = new Int32Array(16);

function inverseDCT(c: Int16Array, offset: number, dst: Uint8Array, base: number, stride: number, ac: number): void {
    // (a DC alone adds the same to every pixel, what the full transform gives too)
    if (!ac) {
        const dc = c[offset] + 4 >> 3;
        for (let o = base, end = base + 4 * stride; o < end; o += stride) {
            dst[o] = clamp255(dst[o] + dc);
            dst[o + 1] = clamp255(dst[o + 1] + dc);
            dst[o + 2] = clamp255(dst[o + 2] + dc);
            dst[o + 3] = clamp255(dst[o + 3] + dc);
        }
        return;
    }

    for (let i = 0; i < 4; i++) {
        const i0 = c[offset + i], i4 = c[offset + 4 + i], i8 = c[offset + 8 + i], i12 = c[offset + 12 + i];
        const a1 = i0 + i8, b1 = i0 - i8;
        let t1 = i4 * 35468 >> 16, t2 = i12 + (i12 * 20091 >> 16);
        const c1 = t1 - t2;
        t1 = i4 + (i4 * 20091 >> 16);
        t2 = i12 * 35468 >> 16;
        const d1 = t1 + t2;
        tmp[i] = a1 + d1;
        tmp[12 + i] = a1 - d1;
        tmp[4 + i] = b1 + c1;
        tmp[8 + i] = b1 - c1;
    }
    for (let i = 0; i < 4; i++) {
        const r = i * 4;
        const i0 = tmp[r], i1 = tmp[r + 1], i2 = tmp[r + 2], i3 = tmp[r + 3];
        const a1 = i0 + i2, b1 = i0 - i2;
        let t1 = i1 * 35468 >> 16, t2 = i3 + (i3 * 20091 >> 16);
        const c1 = t1 - t2;
        t1 = i1 + (i1 * 20091 >> 16);
        t2 = i3 * 35468 >> 16;
        const d1 = t1 + t2;
        const o = base + i * stride;
        dst[o] = clamp255(dst[o] + (a1 + d1 + 4 >> 3));
        dst[o + 3] = clamp255(dst[o + 3] + (a1 - d1 + 4 >> 3));
        dst[o + 1] = clamp255(dst[o + 1] + (b1 + c1 + 4 >> 3));
        dst[o + 2] = clamp255(dst[o + 2] + (b1 - c1 + 4 >> 3));
    }
}

// 16x16 luma or 8x8 chroma prediction (RFC 6386 sections 12.2, 12.3)
function predictBlock(mode: number, p: Uint8Array, base: number, stride: number, size: number, mbx: number, mby: number): void {
    const above = base - stride;
    if (mode === DC_PRED) {
        const shift = size === 16 ? 3 : 2;
        let sum = 0, count = 0;
        // (the edges above and left that exist)
        if (mby > 0) {
            for (let i = 0; i < size; i++) sum += p[above + i];
            count++;
        }
        if (mbx > 0) {
            for (let i = 0; i < size; i++) sum += p[base + i * stride - 1];
            count++;
        }
        const v = count === 0 ? 128 : sum + (1 << shift + count - 1) >> shift + count;
        // (rows by loops: for 8 or 16 bytes, fill and copyWithin cost more than they do)
        for (let y = 0; y < size; y++)
            for (let row = base + y * stride, x = 0; x < size; x++) p[row + x] = v;
    } else if (mode === V_PRED) {
        for (let y = 0; y < size; y++)
            for (let row = base + y * stride, x = 0; x < size; x++) p[row + x] = p[above + x];
    } else if (mode === H_PRED) {
        for (let y = 0; y < size; y++) {
            const row = base + y * stride, v = p[row - 1];
            for (let x = 0; x < size; x++) p[row + x] = v;
        }
    } else {
        const corner = p[above - 1];
        for (let y = 0; y < size; y++) {
            const row = base + y * stride, l = p[row - 1] - corner;
            for (let x = 0; x < size; x++) p[row + x] = clamp255(l + p[above + x]);
        }
    }
}

const avg3 = (x: number, y: number, z: number): number => x + 2 * y + z + 2 >> 2;
const avg2 = (x: number, y: number): number => x + y + 1 >> 1;

// 4x4 subblock prediction (RFC 6386 section 12.3); edge = P, A[0..7], left = L[0..3]; writes into the plane
const B = new Uint8Array(16);

function predictSubblock(mode: number, edge: Uint8Array, L: Uint8Array, p: Uint8Array, base: number, stride: number): void {
    const P = edge[0];
    const A0 = edge[1], A1 = edge[2], A2 = edge[3], A3 = edge[4], A4 = edge[5], A5 = edge[6], A6 = edge[7], A7 = edge[8];
    const L0 = L[0], L1 = L[1], L2 = L[2], L3 = L[3];
    // E = L3, L2, L1, L0, P, A0..A3 (the edge from bottom left to top right)

    switch (mode) {
        case B_DC_PRED:
            B.fill(A0 + A1 + A2 + A3 + L0 + L1 + L2 + L3 + 4 >> 3);
            break;
        case B_TM_PRED:
            for (let r = 0; r < 4; r++) {
                const l = L[r] - P;
                B[r * 4] = clamp255(l + A0);
                B[r * 4 + 1] = clamp255(l + A1);
                B[r * 4 + 2] = clamp255(l + A2);
                B[r * 4 + 3] = clamp255(l + A3);
            }
            break;
        case B_VE_PRED: {
            const v0 = avg3(P, A0, A1), v1 = avg3(A0, A1, A2), v2 = avg3(A1, A2, A3), v3 = avg3(A2, A3, A4);
            for (let r = 0; r < 16; r += 4) { B[r] = v0; B[r + 1] = v1; B[r + 2] = v2; B[r + 3] = v3; }
            break;
        }
        case B_HE_PRED:
            B.fill(avg3(P, L0, L1), 0, 4);
            B.fill(avg3(L0, L1, L2), 4, 8);
            B.fill(avg3(L1, L2, L3), 8, 12);
            B.fill(avg3(L2, L3, L3), 12, 16);
            break;
        case B_LD_PRED:
            B[0] = avg3(A0, A1, A2);
            B[1] = B[4] = avg3(A1, A2, A3);
            B[2] = B[5] = B[8] = avg3(A2, A3, A4);
            B[3] = B[6] = B[9] = B[12] = avg3(A3, A4, A5);
            B[7] = B[10] = B[13] = avg3(A4, A5, A6);
            B[11] = B[14] = avg3(A5, A6, A7);
            B[15] = avg3(A6, A7, A7);
            break;
        case B_RD_PRED:
            B[12] = avg3(L3, L2, L1);
            B[13] = B[8] = avg3(L2, L1, L0);
            B[14] = B[9] = B[4] = avg3(L1, L0, P);
            B[15] = B[10] = B[5] = B[0] = avg3(L0, P, A0);
            B[11] = B[6] = B[1] = avg3(P, A0, A1);
            B[7] = B[2] = avg3(A0, A1, A2);
            B[3] = avg3(A1, A2, A3);
            break;
        case B_VR_PRED:
            B[12] = avg3(L2, L1, L0);
            B[8] = avg3(L1, L0, P);
            B[13] = B[4] = avg3(L0, P, A0);
            B[9] = B[0] = avg2(P, A0);
            B[14] = B[5] = avg3(P, A0, A1);
            B[10] = B[1] = avg2(A0, A1);
            B[15] = B[6] = avg3(A0, A1, A2);
            B[11] = B[2] = avg2(A1, A2);
            B[7] = avg3(A1, A2, A3);
            B[3] = avg2(A2, A3);
            break;
        case B_VL_PRED:
            B[0] = avg2(A0, A1);
            B[4] = avg3(A0, A1, A2);
            B[8] = B[1] = avg2(A1, A2);
            B[5] = B[12] = avg3(A1, A2, A3);
            B[9] = B[2] = avg2(A2, A3);
            B[13] = B[6] = avg3(A2, A3, A4);
            B[10] = B[3] = avg2(A3, A4);
            B[14] = B[7] = avg3(A3, A4, A5);
            B[11] = avg3(A4, A5, A6);
            B[15] = avg3(A5, A6, A7);
            break;
        case B_HD_PRED:
            B[12] = avg2(L3, L2);
            B[13] = avg3(L3, L2, L1);
            B[8] = B[14] = avg2(L2, L1);
            B[9] = B[15] = avg3(L2, L1, L0);
            B[10] = B[4] = avg2(L1, L0);
            B[11] = B[5] = avg3(L1, L0, P);
            B[6] = B[0] = avg2(L0, P);
            B[7] = B[1] = avg3(L0, P, A0);
            B[2] = avg3(P, A0, A1);
            B[3] = avg3(A0, A1, A2);
            break;
        case B_HU_PRED:
            B[0] = avg2(L0, L1);
            B[1] = avg3(L0, L1, L2);
            B[2] = B[4] = avg2(L1, L2);
            B[3] = B[5] = avg3(L1, L2, L3);
            B[6] = B[8] = avg2(L2, L3);
            B[7] = B[9] = avg3(L2, L3, L3);
            B[10] = B[11] = B[12] = B[13] = B[14] = B[15] = L3;
            break;
    }

    for (let r = 0; r < 4; r++) {
        const o = base + r * stride, b = r * 4;
        p[o] = B[b]; p[o + 1] = B[b + 1]; p[o + 2] = B[b + 2]; p[o + 3] = B[b + 3];
    }
}

// loop filter (RFC 6386 section 15), applied to the whole frame after reconstruction

const s8 = (v: number): number => v < -128 ? -128 : v > 127 ? 127 : v;

// common_adjust: moves p0 and q0 closer; returns the filter value a
function commonAdjust(p: Uint8Array, i: number, step: number, outerTaps: boolean): number {
    const p1 = p[i - 2 * step] - 128, p0 = p[i - step] - 128, q0 = p[i] - 128, q1 = p[i + step] - 128;
    let a = s8((outerTaps ? s8(p1 - q1) : 0) + 3 * (q0 - p0));
    const b = s8(a + 3) >> 3;
    a = s8(a + 4) >> 3;
    p[i] = s8(q0 - a) + 128;
    p[i - step] = s8(p0 + b) + 128;
    return a;
}

const edgeOk = (p: Uint8Array, i: number, step: number, limit: number): boolean =>
    Math.abs(p[i - step] - p[i]) * 2 + (Math.abs(p[i - 2 * step] - p[i + step]) >> 1) <= limit;

/**
 * Filters the segments across an edge: `count` positions starting at i, each `along` apart, pixels `step` apart
 */
function filterEdge(p: Uint8Array, i: number, along: number, step: number, count: number, macroblock: boolean, edgeLimit: number, interior: number, hevThreshold: number): void {
    for (let k = 0; k < count; k++, i += along) {
        const p3 = p[i - 4 * step], p2 = p[i - 3 * step], p1 = p[i - 2 * step], p0 = p[i - step];
        const q0 = p[i], q1 = p[i + step], q2 = p[i + 2 * step], q3 = p[i + 3 * step];

        // filter_yes: edge difference and interior differences within their limits
        if (Math.abs(p0 - q0) * 2 + (Math.abs(p1 - q1) >> 1) > edgeLimit
            || Math.abs(p3 - p2) > interior || Math.abs(p2 - p1) > interior || Math.abs(p1 - p0) > interior
            || Math.abs(q3 - q2) > interior || Math.abs(q2 - q1) > interior || Math.abs(q1 - q0) > interior) continue;

        const hev = Math.abs(p1 - p0) > hevThreshold || Math.abs(q1 - q0) > hevThreshold;
        if (macroblock) {
            if (hev) {
                commonAdjust(p, i, step, true);
                continue;
            }
            const w = s8(s8(p1 - q1) + 3 * (q0 - p0));
            let a = s8(27 * w + 63 >> 7);
            p[i] = s8(q0 - 128 - a) + 128;
            p[i - step] = s8(p0 - 128 + a) + 128;
            a = s8(18 * w + 63 >> 7);
            p[i + step] = s8(q1 - 128 - a) + 128;
            p[i - 2 * step] = s8(p1 - 128 + a) + 128;
            a = s8(9 * w + 63 >> 7);
            p[i + 2 * step] = s8(q2 - 128 - a) + 128;
            p[i - 3 * step] = s8(p2 - 128 + a) + 128;
        } else {
            const a = commonAdjust(p, i, step, hev) + 1 >> 1;
            if (!hev) {
                p[i + step] = s8(q1 - 128 - a) + 128;
                p[i - 2 * step] = s8(p1 - 128 + a) + 128;
            }
        }
    }
}

function filterEdgeSimple(p: Uint8Array, i: number, along: number, step: number, count: number, limit: number): void {
    for (let k = 0; k < count; k++, i += along)
        if (edgeOk(p, i, step, limit)) commonAdjust(p, i, step, true);
}

function loopFilter(h: Header, Y: Uint8Array, U: Uint8Array, V: Uint8Array, ys: number, cs: number, mbw: number, mbh: number, segments: Uint8Array, inner: Uint8Array, bpred: Uint8Array): void {
    for (let mby = 0; mby < mbh; mby++)
        for (let mbx = 0; mbx < mbw; mbx++) {
            const mb = mby * mbw + mbx;

            let level = h.filterLevel;
            if (h.segmentation.enabled) {
                level = h.segmentation.filter[segments[mb]];
                if (!h.segmentation.absolute) level += h.filterLevel;
            }
            if (h.lfDeltas.enabled) {
                level += h.lfDeltas.ref[0]; // intra frame
                if (bpred[mb]) level += h.lfDeltas.mode[0];
            }
            level = level < 0 ? 0 : level > 63 ? 63 : level;
            if (level === 0) continue;

            let interior = level;
            if (h.sharpness) {
                interior >>= h.sharpness > 4 ? 2 : 1;
                if (interior > 9 - h.sharpness) interior = 9 - h.sharpness;
            }
            if (!interior) interior = 1;
            const hevThreshold = level >= 40 ? 2 : level >= 15 ? 1 : 0;
            const mbLimit = (level + 2) * 2 + interior, subLimit = level * 2 + interior;
            const filterInner = inner[mb] === 1;

            const y0 = (mby * 16 + 1) * ys + mbx * 16 + 1;
            if (h.filterType === 1) {
                // simple filter: luma only
                if (mbx > 0) filterEdgeSimple(Y, y0, ys, 1, 16, mbLimit);
                if (filterInner) for (let x = 4; x < 16; x += 4) filterEdgeSimple(Y, y0 + x, ys, 1, 16, subLimit);
                if (mby > 0) filterEdgeSimple(Y, y0, 1, ys, 16, mbLimit);
                if (filterInner) for (let y = 4; y < 16; y += 4) filterEdgeSimple(Y, y0 + y * ys, 1, ys, 16, subLimit);
                continue;
            }

            const c0 = (mby * 8 + 1) * cs + mbx * 8 + 1;
            if (mbx > 0) {
                filterEdge(Y, y0, ys, 1, 16, true, mbLimit, interior, hevThreshold);
                filterEdge(U, c0, cs, 1, 8, true, mbLimit, interior, hevThreshold);
                filterEdge(V, c0, cs, 1, 8, true, mbLimit, interior, hevThreshold);
            }
            if (filterInner) {
                for (let x = 4; x < 16; x += 4) filterEdge(Y, y0 + x, ys, 1, 16, false, subLimit, interior, hevThreshold);
                filterEdge(U, c0 + 4, cs, 1, 8, false, subLimit, interior, hevThreshold);
                filterEdge(V, c0 + 4, cs, 1, 8, false, subLimit, interior, hevThreshold);
            }
            if (mby > 0) {
                filterEdge(Y, y0, 1, ys, 16, true, mbLimit, interior, hevThreshold);
                filterEdge(U, c0, 1, cs, 8, true, mbLimit, interior, hevThreshold);
                filterEdge(V, c0, 1, cs, 8, true, mbLimit, interior, hevThreshold);
            }
            if (filterInner) {
                for (let y = 4; y < 16; y += 4) filterEdge(Y, y0 + y * ys, 1, ys, 16, false, subLimit, interior, hevThreshold);
                filterEdge(U, c0 + 4 * cs, 1, cs, 8, false, subLimit, interior, hevThreshold);
                filterEdge(V, c0 + 4 * cs, 1, cs, 8, false, subLimit, interior, hevThreshold);
            }
        }
}

// libwebp's YUV -> RGB (BT.601, 14 bit fixed point)
const multHi = (v: number, coeff: number): number => v * coeff >> 8;
const clip8 = (v: number): number => (v & ~16383) === 0 ? v >> 6 : v < 0 ? 0 : 255;

// a pixel as a 32-bit word (little endian: red is the low byte)
function yuvToWord(y: number, u: number, v: number): number {
    const yy = multHi(y, 19077);
    return (clip8(yy + multHi(v, 26149) - 14234) | clip8(yy - multHi(u, 6419) - multHi(v, 13320) + 8708) << 8
        | clip8(yy + multHi(u, 33050) - 17685) << 16 | 0xff000000) >>> 0;
}

/**
 * Converts to RGBA with libwebp's "fancy" upsampling: chroma is interpolated from the four nearest samples
 * (9-3-3-1 weights), working on pairs of output rows that lie between two chroma rows
 */
function toRGBA(Y: Uint8Array, U: Uint8Array, V: Uint8Array, ys: number, cs: number, width: number, height: number): Uint8Array {
    const out = new Uint32Array(width * height);
    const yRow = (y: number): number => (y + 1) * ys + 1;
    const cRow = (y: number): number => (y + 1) * cs + 1;
    const lastChroma = (height + 1 >> 1) - 1;

    // first row: mirrors the chroma row at the boundary
    upsamplePair(Y, U, V, yRow(0), -1, cRow(0), cRow(0), out, 0, -1, width);
    // rows 2k - 1 and 2k lie between chroma rows k - 1 and k
    for (let y = 1; y + 1 < height; y += 2) {
        const k = y + 1 >> 1;
        upsamplePair(Y, U, V, yRow(y), yRow(y + 1), cRow(k - 1), cRow(k), out, y * width, (y + 1) * width, width);
    }
    // the last row of an even height picture
    if (!(height & 1)) upsamplePair(Y, U, V, yRow(height - 1), -1, cRow(lastChroma), cRow(lastChroma), out, (height - 1) * width, -1, width);

    // (the words hold red in their low byte: elsewhere than on little endian machines, the bytes are taken from them)
    if (littleEndian) return new Uint8Array(out.buffer);
    const bytes = new Uint8Array(out.length * 4);
    for (let i = 0, o = 0; i < out.length; i++, o += 4) {
        const w = out[i];
        bytes[o] = w & 0xff;
        bytes[o + 1] = w >> 8 & 0xff;
        bytes[o + 2] = w >> 16 & 0xff;
        bytes[o + 3] = w >>> 24;
    }
    return bytes;
}

// one pair of rows: top is nearer to the chroma row "top", bottom nearer to "current" (no bottom row if -1)
function upsamplePair(Y: Uint8Array, U: Uint8Array, V: Uint8Array, topY: number, bottomY: number, topC: number, curC: number, out: Uint32Array, topOut: number, bottomOut: number, width: number): void {
    let tlu = U[topC], tlv = V[topC], lu = U[curC], lv = V[curC];
    out[topOut] = yuvToWord(Y[topY], 3 * tlu + lu + 2 >> 2, 3 * tlv + lv + 2 >> 2);
    if (bottomY >= 0) out[bottomOut] = yuvToWord(Y[bottomY], 3 * lu + tlu + 2 >> 2, 3 * lv + tlv + 2 >> 2);

    const pairs = width - 1 >> 1;
    for (let x = 1; x <= pairs; x++) {
        const tu = U[topC + x], tv = V[topC + x], u = U[curC + x], v = V[curC + x];
        const avgU = tlu + tu + lu + u + 8, avgV = tlv + tv + lv + v + 8;
        const d12u = avgU + 2 * (tu + lu) >> 3, d03u = avgU + 2 * (tlu + u) >> 3;
        const d12v = avgV + 2 * (tv + lv) >> 3, d03v = avgV + 2 * (tlv + v) >> 3;

        out[topOut + 2 * x - 1] = yuvToWord(Y[topY + 2 * x - 1], d12u + tlu >> 1, d12v + tlv >> 1);
        out[topOut + 2 * x] = yuvToWord(Y[topY + 2 * x], d03u + tu >> 1, d03v + tv >> 1);
        if (bottomY >= 0) {
            out[bottomOut + 2 * x - 1] = yuvToWord(Y[bottomY + 2 * x - 1], d03u + lu >> 1, d03v + lv >> 1);
            out[bottomOut + 2 * x] = yuvToWord(Y[bottomY + 2 * x], d12u + u >> 1, d12v + v >> 1);
        }
        tlu = tu; tlv = tv; lu = u; lv = v;
    }

    if (!(width & 1)) {
        const x = width - 1;
        out[topOut + x] = yuvToWord(Y[topY + x], 3 * tlu + lu + 2 >> 2, 3 * tlv + lv + 2 >> 2);
        if (bottomY >= 0) out[bottomOut + x] = yuvToWord(Y[bottomY + x], 3 * lu + tlu + 2 >> 2, 3 * lv + tlv + 2 >> 2);
    }
}
