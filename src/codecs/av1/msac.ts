/*!
 * The AV1 symbol decoder (a multi-symbol arithmetic decoder with adapting CDFs), ported from dav1d (src/msac.c).
 * Copyright (c) 2018-2021, VideoLAN and dav1d authors, Copyright (c) 2018, Two Orioles, LLC, BSD-2-Clause License
 * (see THIRD_PARTY_NOTICES.md)
 */

const PROB_SHIFT = 6, MIN_PROB = 4;
// the window is 32 bits wide
const WIN = 32;

/**
 * Decodes symbols of a tile. CDFs are stored inverted (32768 minus the probability) with their adaptation count after
 * the last symbol, like dav1d's
 */
export class SymbolDecoder {
    private pos: number;
    private dif = 0;
    private rng = 0x8000;
    private cnt = -15;

    constructor(private data: Uint8Array, start: number, private end: number, private allowUpdate: boolean) {
        this.pos = start;
        this.refill();
    }

    private refill(): void {
        let c = WIN - this.cnt - 24;
        let dif = this.dif;
        do {
            if (this.pos >= this.end) {
                // past the end the bits are ones
                dif = (dif | ~(~0xff << c)) >>> 0;
                break;
            }
            dif = (dif | (this.data[this.pos++] ^ 0xff) << c) >>> 0;
            c -= 8;
        } while (c >= 0);
        this.dif = dif;
        this.cnt = WIN - c - 24;
    }

    private norm(dif: number, rng: number): void {
        const d = 15 ^ (31 ^ Math.clz32(rng));
        const cnt = this.cnt;
        this.dif = (dif << d) >>> 0;
        this.rng = rng << d;
        this.cnt = cnt - d;
        // (a negative count means the data has ended)
        if (cnt >= 0 && cnt < d) this.refill();
    }

    /** a bit of probability 1/2 */
    bool(): number {
        const r = this.rng;
        let dif = this.dif;
        let v = (r >> 8 << 7) + MIN_PROB;
        const vw = v * 65536;
        const ret = dif >= vw ? 1 : 0;
        if (ret) {
            dif -= vw;
            v = r - v;
        }
        this.norm(dif, v);
        return ret ^ 1;
    }

    /** a bit whose probability of being 1 is f / 32768 (inverted) */
    boolProb(f: number): number {
        const r = this.rng;
        let dif = this.dif;
        let v = ((r >> 8) * (f >> PROB_SHIFT) >> (7 - PROB_SHIFT)) + MIN_PROB;
        const vw = v * 65536;
        const ret = dif >= vw ? 1 : 0;
        if (ret) {
            dif -= vw;
            v = r - v;
        }
        this.norm(dif, v);
        return ret ^ 1;
    }

    /** n bits, most significant first */
    bools(n: number): number {
        let v = 0;
        while (n--) v = v << 1 | this.bool();
        return v;
    }

    /** 0..n-1 */
    uniform(n: number): number {
        const l = 32 - Math.clz32(n);
        const m = (1 << l) - n;
        const v = this.bools(l - 1);
        return v < m ? v : (v << 1) - m + this.bool();
    }

    /** a symbol of the CDF at cdf[o] with n + 1 symbols, adapting it */
    symbol(cdf: Uint16Array, o: number, n: number): number {
        const c = this.dif >>> 16, r = this.rng >> 8;
        let u: number, v = this.rng, val = -1;
        do {
            val++;
            u = v;
            v = r * (cdf[o + val] >> PROB_SHIFT) >> (7 - PROB_SHIFT);
            v += MIN_PROB * (n - val);
        } while (c < v);
        this.norm(this.dif - v * 65536, u - v);

        if (this.allowUpdate) {
            const count = cdf[o + n];
            const rate = 4 + (count >> 4) + (n > 2 ? 1 : 0);
            let i = 0;
            for (; i < val; i++) cdf[o + i] += 32768 - cdf[o + i] >> rate;
            for (; i < n; i++) cdf[o + i] -= cdf[o + i] >> rate;
            cdf[o + n] = count + (count < 32 ? 1 : 0);
        }
        return val;
    }

    /** a bit of the boolean CDF at cdf[o], adapting it */
    boolAdapt(cdf: Uint16Array, o: number): number {
        const bit = this.boolProb(cdf[o]);
        if (this.allowUpdate) {
            const count = cdf[o + 1];
            const rate = 4 + (count >> 4);
            if (bit) cdf[o] += 32768 - cdf[o] >> rate;
            else cdf[o] -= cdf[o] >> rate;
            cdf[o + 1] = count + (count < 32 ? 1 : 0);
        }
        return bit;
    }

    /** a coefficient's high token (3..15): up to four 4-symbol decodes */
    hiTok(cdf: Uint16Array, o: number): number {
        let br = this.symbol(cdf, o, 3);
        let tok = 3 + br;
        if (br === 3) {
            br = this.symbol(cdf, o, 3);
            tok = 6 + br;
            if (br === 3) {
                br = this.symbol(cdf, o, 3);
                tok = 9 + br;
                if (br === 3) tok = 12 + this.symbol(cdf, o, 3);
            }
        }
        return tok;
    }

    /** Exp-Golomb coded value */
    golomb(): number {
        let len = 0;
        while (!this.bool() && len < 32) len++;
        let v = 1;
        while (len--) v = v * 2 + this.bool();
        return v - 1;
    }

    /** dav1d_msac_decode_subexp: a value near ref in 0..n-1 */
    subexp(ref: number, n: number, k: number): number {
        let a = 0;
        if (this.bool()) {
            if (this.bool()) k += this.bool() + 1;
            a = 1 << k;
        }
        const v = this.bools(k) + a;
        return ref * 2 <= n ? inverseRecenter(ref, v) : n - 1 - inverseRecenter(n - 1 - ref, v);
    }

    /** whether more symbols were read than the data has (with some slack, like dav1d's check) */
    get overread(): boolean {
        return this.cnt <= -15;
    }
}

function inverseRecenter(r: number, v: number): number {
    if (v > r << 1) return v;
    return v & 1 ? r - (v + 1 >> 1) : r + (v >> 1);
}
