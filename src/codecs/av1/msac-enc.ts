/*!
 * The AV1 symbol encoder (a multi-symbol arithmetic coder with adapting CDFs), ported from libaom
 * (aom_dsp/entenc.c: od_ec_encode_q15, od_ec_enc_normalize, od_ec_enc_done). Copyright (c) 2001-2016, Alliance for Open
 * Media, BSD-2-Clause License (see THIRD_PARTY_NOTICES.md)
 */

const PROB_SHIFT = 6, MIN_PROB = 4;

/**
 * Encodes symbols of a tile with the CDFs SymbolDecoder reads them with (inverted, with their adaptation count after
 * the last symbol), adapting them the same way
 */
export class SymbolEncoder {
    // bytes before carry propagation (up to 16 bits each)
    private buf: number[] = [];
    private low = 0;
    private rng = 0x8000;
    private cnt = -9;

    constructor(private allowUpdate = true) { }

    // the interval [fl, fh) (inverted CDF values) of symbol s of n + 1
    private encode(fl: number, fh: number, s: number, n: number): void {
        let l = this.low, r = this.rng;
        const v = ((r >> 8) * (fh >> PROB_SHIFT) >> (7 - PROB_SHIFT)) + MIN_PROB * (n - s);
        if (fl < 32768) {
            const u = ((r >> 8) * (fl >> PROB_SHIFT) >> (7 - PROB_SHIFT)) + MIN_PROB * (n - s + 1);
            l += r - u;
            r = u - v;
        } else r -= v;
        this.normalize(l, r);
    }

    private normalize(low: number, rng: number): void {
        let c = this.cnt;
        const d = 16 - (32 - Math.clz32(rng));
        let s = c + d;
        if (s >= 0) {
            c += 16;
            let m = 2 ** c - 1;
            if (s >= 8) {
                this.buf.push(Math.floor(low / 2 ** c));
                low %= m + 1;
                c -= 8;
                m = (m + 1) / 256 - 1;
            }
            this.buf.push(Math.floor(low / 2 ** c));
            s = c + d - 24;
            low %= m + 1;
        }
        this.low = low * 2 ** d;
        this.rng = rng << d;
        this.cnt = s;
    }

    /** symbol val of the CDF at cdf[o] with n + 1 symbols, adapting it */
    symbol(cdf: Uint16Array, o: number, n: number, val: number): void {
        // (cdf[o + n] is the count: the last symbol ends at 0)
        this.encode(val ? cdf[o + val - 1] : 32768, val === n ? 0 : cdf[o + val], val, n);
        if (this.allowUpdate) {
            const count = cdf[o + n];
            const rate = 4 + (count >> 4) + (n > 2 ? 1 : 0);
            let i = 0;
            for (; i < val; i++) cdf[o + i] += 32768 - cdf[o + i] >> rate;
            for (; i < n; i++) cdf[o + i] -= cdf[o + i] >> rate;
            cdf[o + n] = count + (count < 32 ? 1 : 0);
        }
    }

    /** a bit of the boolean CDF at cdf[o], adapting it */
    boolAdapt(cdf: Uint16Array, o: number, bit: number): void {
        this.symbol(cdf, o, 1, bit);
    }

    /** a bit whose probability of being 1 is f / 32768 (inverted) */
    boolProb(f: number, bit: number): void {
        this.encode(bit ? f : 32768, bit ? 0 : f, bit, 1);
    }

    /** a bit of probability 1/2 */
    bool(bit: number): void {
        this.boolProb(16384, bit);
    }

    /** the n low bits of v, most significant first */
    bools(n: number, v: number): void {
        while (n--) this.bool(v >> n & 1);
    }

    /** a value below n with the fewest bits (one more for the larger ones) */
    uniform(n: number, v: number): void {
        const l = 32 - Math.clz32(n), m = (1 << l) - n;
        if (v < m) this.bools(l - 1, v);
        else {
            this.bools(l - 1, v + m >> 1);
            this.bool(v + m & 1);
        }
    }

    /** a coefficient's high token (3..15): up to four 4-symbol encodes */
    hiTok(cdf: Uint16Array, o: number, tok: number): void {
        for (let base = 3; ; base += 3) {
            const br = Math.min(tok - base, 3);
            this.symbol(cdf, o, 3, br);
            if (br < 3 || base === 12) return;
        }
    }

    /** an Exp-Golomb coded value */
    golomb(v: number): void {
        const x = v + 1, len = 31 - Math.clz32(x);
        for (let i = 0; i < len; i++) this.bool(0);
        this.bool(1);
        for (let i = len - 1; i >= 0; i--) this.bool(x >> i & 1);
    }

    /** the coded bytes (with the bits that end the data unambiguously) */
    finish(): Uint8Array {
        const buf = this.buf.slice();
        let c = this.cnt, s = c + 10;
        const m = 0x3fff;
        // (l + m) rounded down to a multiple of m + 1, with bit 14 set
        let e = Math.floor((this.low + m) / (m + 1)) * (m + 1);
        if (Math.floor(e / (m + 1)) % 2 === 0) e += m + 1;
        if (s > 0) {
            let n = 2 ** (c + 16);
            do {
                buf.push(Math.floor(e / 2 ** (c + 16)));
                e %= n;
                s -= 8;
                c -= 8;
                n /= 256;
            } while (s > 0);
        }
        // carry propagation
        const out = new Uint8Array(buf.length);
        let carry = 0;
        for (let i = buf.length - 1; i >= 0; i--) {
            carry += buf[i];
            out[i] = carry & 0xff;
            carry >>= 8;
        }
        return out;
    }
}
