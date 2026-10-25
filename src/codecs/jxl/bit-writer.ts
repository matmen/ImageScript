/*!
 * The bit writer of the JPEG XL encoders, ported with the fast lossless encoder from libjxl
 * (lib/jxl/enc_fast_lossless.cc). Copyright (c) the JPEG XL Project Authors, BSD-3-Clause License (see
 * THIRD_PARTY_NOTICES.md)
 */

/** Bits in LSB first order, growing as needed */
export class BitWriter {
    data = new Uint8Array(256);
    length = 0;
    private buf = 0;
    /** the bits in buf (less than 8 between writes) */
    bits = 0;

    /** writes the low count (up to 32) bits of v */
    write(count: number, v: number): void {
        if (count > 24) {
            this.write(16, v & 0xffff);
            this.write(count - 16, Math.floor(v / 65536));
            return;
        }
        if (this.length + 4 > this.data.length) {
            const data = new Uint8Array(this.data.length * 2);
            data.set(this.data);
            this.data = data;
        }
        this.buf |= v << this.bits;
        this.bits += count;
        while (this.bits >= 8) {
            this.data[this.length++] = this.buf & 0xff;
            this.buf >>>= 8;
            this.bits -= 8;
        }
    }

    zeroPadToByte(): void {
        if (this.bits) this.write(8 - this.bits, 0);
    }

    /** the size in bits */
    get size(): number {
        return this.length * 8 + this.bits;
    }

    /** appends another writer's bits */
    append(w: BitWriter): void {
        for (let i = 0; i < w.length; i++) this.write(8, w.data[i]);
        if (w.bits) this.write(w.bits, w.buf);
    }

    bytes(): Uint8Array {
        return this.data.subarray(0, this.length);
    }
}
