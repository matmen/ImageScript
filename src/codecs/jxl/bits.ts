/*!
 * The JPEG XL bit reader and the field types of its headers (ISO/IEC 18181-1), ported from jxl-oxide
 * (crates/jxl-bitstream). Copyright (c) Wonwoo Choi, MIT License (see THIRD_PARTY_NOTICES.md)
 */

/** A U32 field's distribution: a constant, or [offset, bits] */
export type U32Dist = number | [number, number];

/** Reads bits least significant first from d[start..end] */
export class BitReader {
    private buf = 0;
    private n = 0;
    private pos: number;

    constructor(readonly d: Uint8Array, readonly start = 0, readonly end = d.length) {
        this.pos = start;
    }

    /** the bits read so far */
    get bitPosition(): number {
        return (this.pos - this.start) * 8 - this.n;
    }

    // (past the end there are zeros, but reading them is an error)
    private refill(): void {
        while (this.n <= 24) {
            if (this.pos >= this.end) {
                if (this.pos >= this.end + 8) throw new Error('JPEG XL: truncated data');
                this.pos++;
            } else this.buf = (this.buf | this.d[this.pos++] << this.n) >>> 0;
            this.n += 8;
        }
    }

    /** the next n (up to 24) bits, not consumed */
    peek(n: number): number {
        if (this.n < n) this.refill();
        return this.buf & ((1 << n) - 1);
    }

    /** consumes n bits (peeked before) */
    skip(n: number): void {
        this.buf >>>= n;
        this.n -= n;
    }

    /** reads n (up to 32) bits */
    bits(n: number): number {
        if (n > 24) {
            const low = this.bits(16);
            return low + this.bits(n - 16) * 65536;
        }
        if (this.n < n) this.refill();
        const v = this.buf & ((1 << n) - 1);
        this.buf >>>= n;
        this.n -= n;
        return v;
    }

    bool(): boolean {
        return this.bits(1) === 1;
    }

    /** a U32: one of 4 distributions */
    u32(d0: U32Dist, d1: U32Dist, d2: U32Dist, d3: U32Dist): number {
        const sel = this.bits(2);
        const d = sel === 0 ? d0 : sel === 1 ? d1 : sel === 2 ? d2 : d3;
        return typeof d === 'number' ? d : d[0] + this.bits(d[1]);
    }

    u64(): number {
        const sel = this.bits(2);
        if (sel === 0) return 0;
        if (sel === 1) return 1 + this.bits(4);
        if (sel === 2) return 17 + this.bits(8);
        let value = this.bits(12), shift = 12;
        while (this.bool()) {
            if (shift === 60) {
                value += this.bits(4) * 2 ** shift;
                break;
            }
            value += this.bits(8) * 2 ** shift;
            shift += 8;
        }
        if (value > Number.MAX_SAFE_INTEGER) throw new Error('JPEG XL: value too large');
        return value;
    }

    /** an F16 as a number (not infinite or NaN) */
    f16(): number {
        const v = this.bits(16);
        const sign = v & 0x8000 ? -1 : 1, exponent = v >> 10 & 31, mantissa = v & 1023;
        if (exponent === 31) throw new Error('JPEG XL: invalid float');
        if (exponent === 0) return sign * mantissa / 1024 / 16384;
        return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
    }

    enum(): number {
        const v = this.u32(0, 1, [2, 4], [18, 6]);
        if (v > 63) throw new Error('JPEG XL: invalid enum value');
        return v;
    }

    /** skips n bits */
    skipBits(n: number): void {
        while (n > 24) {
            this.bits(24);
            n -= 24;
        }
        this.bits(n);
    }

    /** ZeroPadToByte */
    zeroPadToByte(): void {
        const pad = (8 - this.bitPosition % 8) % 8;
        if (this.bits(pad) !== 0) throw new Error('JPEG XL: non-zero padding');
    }

    /** the byte offset in d after the bits read (at a byte boundary) */
    get bytePosition(): number {
        return this.start + Math.ceil(this.bitPosition / 8);
    }

    /** throws when more bits were read than there are */
    checkEnd(): void {
        if (this.bitPosition > (this.end - this.start) * 8) throw new Error('JPEG XL: truncated data');
    }
}

/** UnpackSigned (of values up to 2^32 - 1) */
export const unpackSigned = (v: number): number => v % 2 ? -(v + 1) / 2 : v / 2;

/** Extensions: skipped */
export function extensions(r: BitReader): void {
    const bits = r.u64();
    let lengths = 0;
    for (let i = 0; i < 64; i++) if (Math.floor(bits / 2 ** i) % 2) lengths += r.u64();
    r.skipBits(lengths);
}
