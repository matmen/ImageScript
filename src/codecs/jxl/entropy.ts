/*!
 * The JPEG XL entropy decoder: ANS or prefix codes (Brotli's) for tokens, clustered contexts, hybrid integers and
 * LZ77; ported from jxl-oxide (crates/jxl-coding). Copyright (c) Wonwoo Choi, MIT License (see
 * THIRD_PARTY_NOTICES.md)
 */
import { BitReader } from './bits.ts';

/** How the tokens of a cluster become integers (HybridUintConfig) */
interface IntegerConfig {
    splitExponent: number;
    split: number;
    msb: number;
    lsb: number;
}

const log2Ceil1 = (x: number): number => x >= 0x80000000 ? 32 : 32 - Math.clz32(x);

function integerConfig(r: BitReader, logAlphabetSize: number): IntegerConfig {
    const splitExponent = r.bits(log2Ceil1(logAlphabetSize));
    let msb = 0, lsb = 0;
    if (splitExponent !== logAlphabetSize) {
        msb = r.bits(log2Ceil1(splitExponent));
        if (msb > splitExponent) throw new Error('JPEG XL: invalid hybrid integer configuration');
        lsb = r.bits(log2Ceil1(splitExponent - msb));
    }
    if (msb + lsb > splitExponent) throw new Error('JPEG XL: invalid hybrid integer configuration');
    return { splitExponent, split: 1 << splitExponent, msb, lsb };
}

// ---- ANS (alias tables, like libjxl's)

export class AnsHistogram {
    /** per bucket: symbol, cutoff, the symbol's frequency, the alias' offset and frequency */
    readonly symbol: Uint8Array;
    readonly cutoff: Uint16Array;
    readonly freq: Uint16Array;
    readonly offset: Uint16Array;
    readonly aliasFreq: Uint16Array;
    readonly logBucketSize: number;
    readonly single: number;

    constructor(r: BitReader, logAlphabetSize: number) {
        const tableSize = 1 << logAlphabetSize, logBucketSize = 12 - logAlphabetSize, bucketSize = 1 << logBucketSize;
        this.logBucketSize = logBucketSize;
        const dist = new Uint16Array(tableSize);
        let alphabetSize: number;
        // (one or two symbols, evenly distributed, or the logarithms of the frequencies)
        const small = r.bool(), even = !small && r.bool();
        if (small) {
            const two = r.bool();
            if (two) {
                const v0 = readU8(r), v1 = readU8(r);
                if (v0 === v1) throw new Error('JPEG XL: invalid ANS histogram');
                alphabetSize = Math.max(v0, v1) + 1;
                if (alphabetSize > tableSize) throw new Error('JPEG XL: invalid ANS histogram');
                const p = r.bits(12);
                dist[v0] = p;
                dist[v1] = 4096 - p;
            } else {
                const v = readU8(r);
                alphabetSize = v + 1;
                if (alphabetSize > tableSize) throw new Error('JPEG XL: invalid ANS histogram');
                dist[v] = 4096;
            }
        } else if (even) {
            alphabetSize = readU8(r) + 1;
            if (alphabetSize > tableSize) throw new Error('JPEG XL: invalid ANS histogram');
            const base = Math.floor(4096 / alphabetSize), leftover = 4096 % alphabetSize;
            dist.fill(base + 1, 0, leftover);
            dist.fill(base, leftover, alphabetSize);
        } else {
            let len = 0;
            while (len < 3 && r.bool()) len++;
            const shift = r.bits(len) + (1 << len) - 1;
            if (shift > 13) throw new Error('JPEG XL: invalid ANS histogram');
            alphabetSize = readU8(r) + 3;
            if (alphabetSize > tableSize) throw new Error('JPEG XL: invalid ANS histogram');
            // the logarithms of the frequencies; runs of the previous one (13)
            const repeats: number[] = [];
            let omitLog = -1, omitPos = -1;
            for (let i = 0; i < alphabetSize;) {
                dist[i] = readLogCount(r);
                if (dist[i] === 13) {
                    const count = readU8(r) + 4;
                    if (i + count > alphabetSize) throw new Error('JPEG XL: invalid ANS histogram');
                    repeats.push(i, i + count);
                    i += count;
                    continue;
                }
                if (dist[i] > omitLog) {
                    omitLog = dist[i];
                    omitPos = i;
                }
                i++;
            }
            if (omitPos < 0 || (omitPos + 1 < tableSize && dist[omitPos + 1] === 13)) throw new Error('JPEG XL: invalid ANS histogram');
            let repeat = 0, total = 0, prev = 0;
            for (let i = 0; i < tableSize; i++) {
                if (repeat < repeats.length && repeats[repeat] <= i) {
                    if (repeats[repeat + 1] === i) repeat += 2;
                    else {
                        dist[i] = prev;
                        total += prev;
                        if (total > 4096) throw new Error('JPEG XL: invalid ANS histogram');
                        continue;
                    }
                }
                if (dist[i] === 0 || i === omitPos) {
                    prev = 0;
                    continue;
                }
                if (dist[i] > 1) {
                    const zeros = dist[i] - 1;
                    const bitcount = Math.min(Math.max(shift - ((12 - zeros) >> 1), 0), zeros);
                    dist[i] = (1 << zeros) + (r.bits(bitcount) << (zeros - bitcount));
                }
                prev = dist[i];
                total += dist[i];
                if (total > 4096) throw new Error('JPEG XL: invalid ANS histogram');
            }
            dist[omitPos] = 4096 - total;
        }

        this.symbol = new Uint8Array(tableSize);
        this.cutoff = new Uint16Array(tableSize);
        this.freq = dist;
        this.offset = new Uint16Array(tableSize);
        this.aliasFreq = new Uint16Array(tableSize);
        const single = dist.indexOf(4096);
        this.single = single;
        if (single >= 0) {
            // (every state decodes it)
            for (let i = 0; i < tableSize; i++) {
                this.symbol[i] = single;
                this.offset[i] = bucketSize * i;
                this.aliasFreq[i] = 4096;
            }
            return;
        }
        // the alias table: overfull buckets give their excess to underfull ones
        const cutoff = new Int32Array(tableSize), alias = new Int32Array(tableSize), aliasOffset = new Int32Array(tableSize);
        const under: number[] = [], over: number[] = [];
        for (let i = 0; i < tableSize; i++) {
            cutoff[i] = dist[i];
            alias[i] = i < alphabetSize ? i : 0;
            if (dist[i] < bucketSize) under.push(i);
            else if (dist[i] > bucketSize) over.push(i);
        }
        while (over.length && under.length) {
            const o = over.pop() as number, u = under.pop() as number;
            const by = bucketSize - cutoff[u];
            cutoff[o] -= by;
            alias[u] = o;
            aliasOffset[u] = cutoff[o];
            if (cutoff[o] < bucketSize) under.push(o);
            else if (cutoff[o] > bucketSize) over.push(o);
        }
        for (let i = 0; i < tableSize; i++) {
            if (cutoff[i] === bucketSize) {
                this.symbol[i] = i;
                this.cutoff[i] = bucketSize;
            } else {
                this.symbol[i] = alias[i];
                this.cutoff[i] = cutoff[i];
                this.offset[i] = aliasOffset[i] - cutoff[i];
                this.aliasFreq[i] = dist[alias[i]];
            }
        }
    }
}

function readU8(r: BitReader): number {
    if (!r.bool()) return 0;
    const n = r.bits(3);
    return (1 << n) + r.bits(n);
}

// the logarithm of a frequency (13: a run of the previous one), by a prefix code
function readLogCount(r: BitReader): number {
    switch (r.bits(3)) {
        case 0: return 10;
        case 1:
            for (const v of [4, 0, 11, 13]) if (r.bool()) return v;
            return 12;
        case 2: return 7;
        case 3: return r.bool() ? 1 : 3;
        case 4: return 6;
        case 5: return 8;
        case 6: return 9;
        default: return r.bool() ? 2 : 5;
    }
}

// ---- prefix codes (Brotli's, RFC 7932 3.4 and 3.5)

const MAX_PREFIX_BITS = 15;

class PrefixHistogram {
    /** per code (the next bits, reversed): symbol << 4 | length */
    private table: Uint32Array;
    private bits: number;
    readonly single: number;

    private constructor(table: Uint32Array, bits: number, single: number) {
        this.table = table;
        this.bits = bits;
        this.single = single;
    }

    static singleSymbol(symbol: number): PrefixHistogram {
        return new PrefixHistogram(Uint32Array.of(symbol << 4), 0, symbol);
    }

    /** canonical codes of the lengths, as a table of 2^(the longest) entries */
    static fromLengths(lengths: Uint8Array): PrefixHistogram {
        let maxLen = 0;
        for (const l of lengths) if (l > maxLen) maxLen = l;
        const counts = new Int32Array(maxLen + 1);
        for (const l of lengths) if (l) counts[l]++;
        // the first code of each length (counts[0] stays 0: unused symbols take no codes)
        const next = new Int32Array(maxLen + 1);
        for (let len = 1, code = 0; len <= maxLen; len++) {
            code = (code + counts[len - 1]) << 1;
            next[len] = code;
        }
        const size = 1 << maxLen, table = new Uint32Array(size);
        let filled = 0;
        for (let sym = 0; sym < lengths.length; sym++) {
            const len = lengths[sym];
            if (!len) continue;
            const code = next[len]++;
            if (code >= 1 << len) throw new Error('JPEG XL: invalid prefix code');
            // (reversed, the bits are read from the least significant)
            let rev = 0;
            for (let i = 0; i < len; i++) rev |= (code >> i & 1) << (len - 1 - i);
            for (let i = rev; i < size; i += 1 << len) table[i] = sym << 4 | len;
            filled += size >> len;
        }
        if (filled !== size) throw new Error('JPEG XL: invalid prefix code');
        return new PrefixHistogram(table, maxLen, -1);
    }

    static parse(r: BitReader, alphabetSize: number): PrefixHistogram {
        if (alphabetSize === 1) return PrefixHistogram.singleSymbol(0);
        const hskip = r.bits(2);
        return hskip === 1 ? PrefixHistogram.parseSimple(r, alphabetSize) : PrefixHistogram.parseComplex(r, alphabetSize, hskip);
    }

    private static parseSimple(r: BitReader, alphabetSize: number): PrefixHistogram {
        const alphabetBits = alphabetSize <= 1 ? 0 : 32 - Math.clz32(alphabetSize - 1);
        const nsym = r.bits(2) + 1;
        const syms: number[] = [];
        for (let i = 0; i < nsym; i++) syms.push(r.bits(alphabetBits));
        for (const s of syms) if (s >= alphabetSize) throw new Error('JPEG XL: invalid prefix code');
        if (nsym === 1) return PrefixHistogram.singleSymbol(syms[0]);
        const lengths = new Uint8Array(alphabetSize);
        const lens = nsym === 2 ? [1, 1] : nsym === 3 ? [1, 2, 2] : r.bool() ? [1, 2, 3, 3] : [2, 2, 2, 2];
        for (let i = 0; i < nsym; i++) {
            if (lengths[syms[i]]) throw new Error('JPEG XL: invalid prefix code');
            lengths[syms[i]] = lens[i];
        }
        return PrefixHistogram.fromLengths(lengths);
    }

    private static parseComplex(r: BitReader, alphabetSize: number, hskip: number): PrefixHistogram {
        const ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        const clLengths = new Uint8Array(18);
        let space = 0, nonZero = 0, nonZeroSym = 0;
        for (let i = hskip; i < 18; i++) {
            // (a fixed prefix code of the code length code lengths)
            const base = r.u32(0, 4, 3, 8);
            const len = base === 8 ? r.bool() ? r.bool() ? 5 : 1 : 2 : base;
            clLengths[ORDER[i]] = len;
            if (len) {
                nonZero++;
                nonZeroSym = ORDER[i];
                space += 32 >> len;
                if (space === 32) break;
                if (space > 32) throw new Error('JPEG XL: invalid prefix code');
            }
        }
        let clCode: PrefixHistogram;
        if (nonZero === 1) clCode = PrefixHistogram.singleSymbol(nonZeroSym);
        else if (space !== 32) throw new Error('JPEG XL: invalid prefix code');
        else clCode = PrefixHistogram.fromLengths(clLengths);

        const lengths = new Uint8Array(alphabetSize);
        let total = 0, prevSym = 8, lastNonZero = 8, lastRepeat = 0, repeat = 0, repeatSym = 0;
        for (let i = 0; i < alphabetSize; i++) {
            if (repeat > 0) {
                lengths[i] = repeatSym;
                repeat--;
            } else {
                const sym = clCode.read(r);
                if (sym < 16) {
                    if (sym) {
                        lengths[i] = sym;
                        lastNonZero = sym;
                    }
                } else {
                    // repeats of the last non-zero length (16) or of zero (17); successive ones multiply
                    const extra = sym === 16 ? 2 : 3;
                    repeat = r.bits(extra) + 3;
                    if (prevSym === sym) {
                        repeat += lastRepeat * (sym === 16 ? 3 : 7) - (sym === 16 ? 8 : 16);
                        lastRepeat += repeat;
                    } else lastRepeat = repeat;
                    repeatSym = sym === 16 ? lastNonZero : 0;
                    lengths[i] = repeatSym;
                    repeat--;
                }
                prevSym = sym;
            }
            if (lengths[i]) {
                total += 1 << (MAX_PREFIX_BITS - lengths[i]);
                if (total > 1 << MAX_PREFIX_BITS) throw new Error('JPEG XL: invalid prefix code');
                if (total === 1 << MAX_PREFIX_BITS && repeat === 0) break;
            }
        }
        if (total !== 1 << MAX_PREFIX_BITS || repeat > 0) throw new Error('JPEG XL: invalid prefix code');
        return PrefixHistogram.fromLengths(lengths);
    }

    read(r: BitReader): number {
        const e = this.table[this.bits ? r.peek(this.bits) : 0];
        r.skip(e & 15);
        return e >>> 4;
    }
}

// ---- the decoder

// the distances of LZ77 copies near the current position in a 2D image: [dx, dy] of the first 120 distance tokens
const SPECIAL_DISTANCES = [
    0, 1, 1, 0, 1, 1, -1, 1, 0, 2, 2, 0, 1, 2, -1, 2, 2, 1, -2, 1, 2, 2, -2, 2, 0, 3, 3, 0, 1, 3, -1, 3, 3, 1, -3, 1, 2, 3,
    -2, 3, 3, 2, -3, 2, 0, 4, 4, 0, 1, 4, -1, 4, 4, 1, -4, 1, 3, 3, -3, 3, 2, 4, -2, 4, 4, 2, -4, 2, 0, 5, 3, 4, -3, 4, 4,
    3, -4, 3, 5, 0, 1, 5, -1, 5, 5, 1, -5, 1, 2, 5, -2, 5, 5, 2, -5, 2, 4, 4, -4, 4, 3, 5, -3, 5, 5, 3, -5, 3, 0, 6, 6, 0,
    1, 6, -1, 6, 6, 1, -6, 1, 2, 6, -2, 6, 6, 2, -6, 2, 4, 5, -4, 5, 5, 4, -5, 4, 3, 6, -3, 6, 6, 3, -6, 3, 0, 7, 7, 0, 1,
    7, -1, 7, 5, 5, -5, 5, 7, 1, -7, 1, 4, 6, -4, 6, 6, 4, -6, 4, 2, 7, -2, 7, 7, 2, -7, 2, 3, 7, -3, 7, 7, 3, -7, 3, 5, 6,
    -5, 6, 6, 5, -6, 5, 8, 0, 4, 7, -4, 7, 7, 4, -7, 4, 8, 1, 8, 2, 6, 6, -6, 6, 8, 3, 5, 7, -5, 7, 7, 5, -7, 5, 8, 4, 6,
    7, -6, 7, 7, 6, -7, 6, 8, 5, 7, 7, -7, 7, 8, 6, 8, 7
];

const WINDOW_MASK = (1 << 20) - 1;

/** Decodes the integers of entropy coded streams: by context (clustered), with LZ77 */
export class EntropyDecoder {
    /** the cluster of each context */
    readonly clusters: Uint8Array;
    private configs: IntegerConfig[];
    private ans: AnsHistogram[] | null = null;
    private prefix: PrefixHistogram[] | null = null;
    private state = 0;
    private initial = true;
    // LZ77
    private lz77 = false;
    private minSymbol = 0;
    private minLength = 0;
    private lenConfig: IntegerConfig | null = null;
    private window: Uint32Array | null = null;
    private toCopy = 0;
    private copyPos = 0;
    private decoded = 0;

    constructor(r: BitReader, numDist: number, allowLz77 = true) {
        this.lz77 = r.bool();
        if (this.lz77) {
            if (!allowLz77) throw new Error('JPEG XL: LZ77 is not allowed here');
            this.minSymbol = r.u32(224, 512, 4096, [8, 15]);
            this.minLength = r.u32(3, 4, [5, 2], [9, 8]);
            this.lenConfig = integerConfig(r, 8);
            numDist++;
        }
        const [numClusters, clusters] = readClusters(r, numDist);
        this.clusters = clusters;
        const usePrefix = r.bool();
        const logAlphabetSize = usePrefix ? 15 : r.bits(2) + 5;
        this.configs = [];
        for (let i = 0; i < numClusters; i++) this.configs.push(integerConfig(r, logAlphabetSize));
        if (usePrefix) {
            const counts: number[] = [];
            for (let i = 0; i < numClusters; i++) {
                let count = 1;
                if (r.bool()) {
                    const n = r.bits(4);
                    count = 1 + (1 << n) + r.bits(n);
                }
                if (count > 1 << 15) throw new Error('JPEG XL: invalid prefix code');
                counts.push(count);
            }
            this.prefix = counts.map(count => PrefixHistogram.parse(r, count));
        } else {
            this.ans = [];
            for (let i = 0; i < numClusters; i++) this.ans.push(new AnsHistogram(r, logAlphabetSize));
        }
    }

    /** a decoder of the same distributions at the start of a stream */
    fork(): EntropyDecoder {
        const d = Object.create(EntropyDecoder.prototype) as EntropyDecoder;
        Object.assign(d, this, { state: 0, initial: true, window: null, toCopy: 0, copyPos: 0, decoded: 0 });
        return d;
    }

    /** reads the initial ANS state (which the first read does otherwise) */
    begin(r: BitReader): void {
        if (this.ans) {
            this.state = r.bits(32);
            this.initial = false;
        }
    }

    /** checks the final ANS state (after begin) */
    finish(): void {
        if (this.ans && this.state !== 0x130000) throw new Error('JPEG XL: invalid ANS stream');
    }

    /** the symbol a cluster always gives (and its integer), or -1 */
    singleToken(cluster: number): number {
        if (this.lz77) return -1;
        const s = this.ans ? this.ans[cluster].single : (this.prefix as PrefixHistogram[])[cluster].single;
        return s >= 0 && s < this.configs[cluster].split ? s : -1;
    }

    private symbol(r: BitReader, cluster: number): number {
        if (this.prefix) return this.prefix[cluster].read(r);
        if (this.initial) {
            this.state = r.bits(32);
            this.initial = false;
        }
        const h = (this.ans as AnsHistogram[])[cluster];
        const state = this.state, index = state & 0xfff;
        const i = index >> h.logBucketSize, pos = index & ((1 << h.logBucketSize) - 1);
        let symbol: number, freq: number, offset: number;
        if (pos < h.cutoff[i]) {
            symbol = i;
            freq = h.freq[i];
            offset = pos;
        } else {
            symbol = h.symbol[i];
            freq = h.aliasFreq[i];
            offset = h.offset[i] + pos;
        }
        let next = (state >>> 12) * freq + offset;
        if (next < 65536) next = (next * 65536 + r.bits(16)) >>> 0;
        this.state = next;
        return symbol;
    }

    // the integer of a token
    private uint(r: BitReader, config: IntegerConfig, token: number): number {
        if (token < config.split) return token;
        const inToken = config.msb + config.lsb;
        const n = (config.splitExponent - inToken + ((token - config.split) >>> inToken)) & 31;
        const low = token & ((1 << config.lsb) - 1);
        const high = (token >>> config.lsb) & ((1 << config.msb) - 1) | 1 << config.msb;
        // (in integers while it fits in 31 bits)
        if (n + config.msb + config.lsb < 31) return ((high << n | r.bits(n)) << config.lsb) | low;
        return ((high * 2 ** n + r.bits(n)) * 2 ** config.lsb + low) >>> 0;
    }

    /** reads an integer of a context (distMultiplier: the image's width, for LZ77 distances in 2D) */
    read(r: BitReader, ctx: number, distMultiplier = 0): number {
        return this.readClustered(r, this.clusters[ctx], distMultiplier);
    }

    readClustered(r: BitReader, cluster: number, distMultiplier = 0): number {
        if (!this.lz77) return this.uint(r, this.configs[cluster], this.symbol(r, cluster));
        // (small, so that it's inlined: the rest of a copy, else readLz77)
        if (this.toCopy === 0) return this.readLz77(r, cluster, distMultiplier);
        const window = this.window as Uint32Array, v = window[this.copyPos++ & WINDOW_MASK];
        this.toCopy--;
        window[this.decoded++ & WINDOW_MASK] = v;
        return v;
    }

    // a value or the start of a copy, with LZ77
    private readLz77(r: BitReader, cluster: number, distMultiplier: number): number {
        const window = this.window ??= new Uint32Array(1 << 20);
        let v: number;
        const token = this.symbol(r, cluster);
        if (token >= this.minSymbol) {
            if (this.decoded === 0) throw new Error('JPEG XL: LZ77 copy before any value');
            const distCluster = this.clusters[this.clusters.length - 1];
            this.toCopy = this.uint(r, this.lenConfig as IntegerConfig, token - this.minSymbol) + this.minLength;
            let distance = this.uint(r, this.configs[distCluster], this.symbol(r, distCluster));
            if (distMultiplier) {
                if (distance < 120) distance = Math.max(SPECIAL_DISTANCES[distance * 2] + distMultiplier * SPECIAL_DISTANCES[distance * 2 + 1] - 1, 0);
                else distance -= 120;
            }
            distance = Math.min(Math.min(distance, WINDOW_MASK) + 1, this.decoded);
            this.copyPos = this.decoded - distance;
            v = window[this.copyPos++ & WINDOW_MASK];
            this.toCopy--;
        } else v = this.uint(r, this.configs[cluster], token);
        window[this.decoded++ & WINDOW_MASK] = v;
        return v;
    }
}

/** Reads the clusters of numDist distributions: [the number of clusters, the cluster of each] */
export function readClusters(r: BitReader, numDist: number): [number, Uint8Array] {
    if (numDist === 1) return [1, new Uint8Array(1)];
    const clusters = new Uint8Array(numDist);
    if (r.bool()) {
        const bits = r.bits(2);
        for (let i = 0; i < numDist; i++) clusters[i] = r.bits(bits);
    } else {
        const mtf = r.bool();
        const dec = new EntropyDecoder(r, 1, numDist > 2);
        dec.begin(r);
        for (let i = 0; i < numDist; i++) {
            const v = dec.read(r, 0);
            if (v > 255) throw new Error('JPEG XL: invalid cluster');
            clusters[i] = v;
        }
        dec.finish();
        if (mtf) {
            const map = new Uint8Array(256).map((_, i) => i);
            for (let i = 0; i < numDist; i++) {
                const index = clusters[i], v = map[index];
                clusters[i] = v;
                map.copyWithin(1, 0, index);
                map[0] = v;
            }
        }
    }
    let max = 0;
    for (const c of clusters) if (c > max) max = c;
    const used = new Uint8Array(max + 1);
    for (const c of clusters) used[c] = 1;
    if (used.includes(0)) throw new Error('JPEG XL: clusters with a hole');
    return [max + 1, clusters];
}

/** Reads a permutation of size entries (the first skip unchanged) */
export function readPermutation(r: BitReader, dec: EntropyDecoder, size: number, skip: number): number[] {
    const ctx = (x: number): number => Math.min(log2Ceil1(x), 7);
    const end = dec.read(r, ctx(size));
    if (end > size - skip) throw new Error('JPEG XL: invalid permutation');
    const lehmer: number[] = [];
    let prev = 0;
    for (let i = 0; i < end; i++) {
        const v = dec.read(r, ctx(prev));
        if (v >= size - skip - i) throw new Error('JPEG XL: invalid permutation');
        lehmer.push(v);
        prev = v;
    }
    const rest: number[] = [];
    for (let i = skip; i < size; i++) rest.push(i);
    const out: number[] = [];
    for (let i = 0; i < skip; i++) out.push(i);
    for (const v of lehmer) out.push(rest.splice(v, 1)[0]);
    return out.concat(rest);
}
