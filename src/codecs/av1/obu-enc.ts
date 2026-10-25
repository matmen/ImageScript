/*!
 * Writes AV1 open bitstream units of still pictures: the sequence header and the frame header of reduced still picture
 * headers (the syntax of the AV1 specification, mirroring obu.ts)
 */
import { SequenceHeader, FrameHeader } from './obu.ts';

/** Bits of a header, most significant first */
export class HeaderWriter {
    private bytes: number[] = [];
    private bitCount = 0;

    bit(v: number): void {
        if (!(this.bitCount & 7)) this.bytes.push(0);
        if (v) this.bytes[this.bytes.length - 1] |= 0x80 >> (this.bitCount & 7);
        this.bitCount++;
    }

    bits(n: number, v: number): void {
        for (let i = n - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1);
    }

    /** su(1 + n) */
    sbits(n: number, v: number): void {
        this.bits(n + 1, v < 0 ? v + 2 ** (n + 1) : v);
    }

    /** trailing bits: a one, zeros up to the byte boundary */
    trailing(): void {
        this.bit(1);
        while (this.bitCount & 7) this.bit(0);
    }

    align(): void {
        while (this.bitCount & 7) this.bit(0);
    }

    data(): Uint8Array {
        return Uint8Array.from(this.bytes);
    }
}

export const OBU_SEQUENCE_HEADER = 1, OBU_FRAME = 6;

/** An OBU of a type with its size (leb128) */
export function obu(type: number, payload: Uint8Array): Uint8Array {
    const size: number[] = [];
    let n = payload.length;
    do {
        size.push(n & 0x7f | (n >= 0x80 ? 0x80 : 0));
        n = Math.floor(n / 128);
    } while (n);
    const out = new Uint8Array(1 + size.length + payload.length);
    out[0] = type << 3 | 2;
    out.set(size, 1);
    out.set(payload, 1 + size.length);
    return out;
}

/** The sequence header of a still picture with a reduced header: level, size, tools, color config */
export function writeSequenceHeader(seq: SequenceHeader, level: number): Uint8Array {
    const w = new HeaderWriter();
    w.bits(3, seq.profile);
    // still picture, reduced header
    w.bit(1);
    w.bit(1);
    w.bits(5, level);
    w.bits(4, seq.widthBits - 1);
    w.bits(4, seq.heightBits - 1);
    w.bits(seq.widthBits, seq.maxWidth - 1);
    w.bits(seq.heightBits, seq.maxHeight - 1);
    w.bit(+seq.sb128);
    w.bit(+seq.filterIntra);
    w.bit(+seq.intraEdgeFilter);
    w.bit(+seq.superres);
    w.bit(+seq.cdef);
    w.bit(+seq.restoration);
    // color config: 8 bits (high bitdepth: 0), monochrome (not in profile 1), the color description
    w.bit(0);
    if (seq.profile !== 1) w.bit(+seq.monochrome);
    w.bit(1);
    w.bits(8, seq.colorPrimaries);
    w.bits(8, seq.transferCharacteristics);
    w.bits(8, seq.matrixCoefficients);
    // (sRGB: 4:4:4, full range, not coded)
    const srgb = !seq.monochrome && seq.colorPrimaries === 1 && seq.transferCharacteristics === 13 && !seq.matrixCoefficients;
    if (!srgb) w.bit(+seq.fullRange);
    // (4:2:0 of profile 0: the chroma sample position, unknown)
    if (!seq.monochrome && seq.ssx && seq.ssy) w.bits(2, 0);
    if (!seq.monochrome) w.bit(+seq.separateUvDeltaQ);
    w.bit(+seq.filmGrain);
    w.trailing();
    return obu(OBU_SEQUENCE_HEADER, w.data());
}

/**
 * The frame header of a still picture (reduced header: a shown key frame of the sequence's size); the tile group
 * follows it in a frame OBU
 */
export function writeFrameHeader(w: HeaderWriter, seq: SequenceHeader, hdr: FrameHeader): void {
    w.bit(+hdr.disableCdfUpdate);
    // allow screen content tools (the sequence leaves it to the frame)
    w.bit(+hdr.allowScreenContentTools);
    if (hdr.allowScreenContentTools) w.bit(0);
    // (no superres in the sequence) no render size
    w.bit(0);
    if (hdr.allowScreenContentTools) w.bit(+hdr.allowIntrabc);

    // tiles: uniform, as few as allowed (cols, rows: the log2 increments stop)
    const t = hdr.tiles;
    w.bit(1);
    const sbw = hdr.width + 63 >> 6, sbh = hdr.height + 63 >> 6;
    const tileLog2 = (size: number, target: number): number => {
        let k = 0;
        while (size << k < target) k++;
        return k;
    };
    const minLog2Cols = tileLog2(64, sbw), maxLog2Cols = tileLog2(1, Math.min(sbw, 64)), maxLog2Rows = tileLog2(1, Math.min(sbh, 64));
    const minLog2Tiles = Math.max(tileLog2(4096 * 2304 >> 12, sbw * sbh), minLog2Cols);
    for (let i = minLog2Cols; i < maxLog2Cols; i++) {
        w.bit(i < t.log2Cols ? 1 : 0);
        if (i >= t.log2Cols) break;
    }
    for (let i = Math.max(minLog2Tiles - t.log2Cols, 0); i < maxLog2Rows; i++) {
        w.bit(i < t.log2Rows ? 1 : 0);
        if (i >= t.log2Rows) break;
    }
    if (t.log2Cols || t.log2Rows) {
        w.bits(t.log2Cols + t.log2Rows, t.contextUpdateId);
        w.bits(2, t.sizeBytes - 1);
    }

    // quantization
    const q = hdr.quant;
    const delta = (v: number): void => {
        w.bit(v ? 1 : 0);
        if (v) w.sbits(6, v);
    };
    w.bits(8, q.yac);
    delta(q.ydcDelta);
    if (!seq.monochrome) {
        if (seq.separateUvDeltaQ) w.bit(0);
        delta(q.udcDelta);
        delta(q.uacDelta);
    }
    w.bit(0); // no quantizer matrices
    w.bit(0); // no segmentation
    if (q.yac) w.bit(0); // no delta q

    // loop filter (deltas disabled)
    if (!hdr.allLossless) {
        const lf = hdr.loopFilter;
        w.bits(6, lf.levelY[0]);
        w.bits(6, lf.levelY[1]);
        if (!seq.monochrome && (lf.levelY[0] || lf.levelY[1])) {
            w.bits(6, lf.levelU);
            w.bits(6, lf.levelV);
        }
        w.bits(3, lf.sharpness);
        w.bit(0);
        // cdef
        if (seq.cdef) {
            const c = hdr.cdef;
            w.bits(2, c.damping - 3);
            w.bits(2, c.bits);
            for (let i = 0; i < 1 << c.bits; i++) {
                w.bits(6, c.yStrengths[i]);
                if (!seq.monochrome) w.bits(6, c.uvStrengths[i]);
            }
        }
        // transform mode: select or the largest
        w.bit(hdr.txMode === 2 ? 1 : 0);
    }
    w.bit(+hdr.reducedTxSet);
}
