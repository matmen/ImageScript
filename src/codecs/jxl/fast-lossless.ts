/*!
 * Lossless JPEG XL encoding, ported from libjxl's fast lossless encoder (lib/jxl/enc_fast_lossless.cc, what cjxl -e 1
 * uses) for 8-bit samples: Modular with the gradient predictor, YCoCg or a palette, prefix codes and runs of zero
 * residuals as LZ77 copies; with libjxl's image header (lib/jxl/headers.cc, fields.cc). Copyright (c) the JPEG XL
 * Project Authors, BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */
import { BitWriter } from './bit-writer.ts';
import { imageHeader } from './headers-enc.ts';

// ---- prefix codes

const NUM_RAW_SYMBOLS = 19, NUM_LZ77 = 33, LZ77_CACHE_SIZE = 32, LZ77_MIN_LENGTH = 7;
const MAX_NUM_SYMBOLS = NUM_LZ77;
// (UpTo8Bits: up to 7 bits per raw symbol, the last one (of runs) up to 10)
const MIN_RAW_LENGTH = new Uint8Array(12), MAX_RAW_LENGTH = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 10]);

const floorLog2 = (v: number): number => 31 - Math.clz32(v);

// [token, extra bits, their count] of a length of LZ77 (the 400 config) and of a residual (000)
function hybridUintLZ77(value: number): [number, number, number] {
    const n = floorLog2(value);
    return value < 16 ? [value, 0, 0] : [16 + n - 4, value - (1 << n), n];
}

function hybridUint000(value: number): [number, number, number] {
    if (!value) return [0, 0, 0];
    const n = floorLog2(value);
    return [n + 1, value - (1 << n), n];
}

function bitReverse(nbits: number, bits: number): number {
    let r = 0;
    for (let i = 0; i < nbits; i++) r |= (bits >> i & 1) << (nbits - 1 - i);
    return r;
}

// canonical codes of code lengths, in two parts (libjxl counts unused symbols as length 0, which changes the codes
// only above their lengths)
function canonicalCode(nbits1: Uint8Array, bits1: Uint16Array, n1: number, nbits2: Uint8Array, bits2: Uint16Array, n2: number): void {
    const counts = new Uint16Array(16), next = new Uint16Array(16);
    for (let i = 0; i < n1; i++) counts[nbits1[i]]++;
    for (let i = 0; i < n2; i++) counts[nbits2[i]]++;
    let code = 0;
    for (let i = 1; i < 16; i++) {
        code = (code + counts[i - 1]) << 1 & 0xffff;
        next[i] = code;
    }
    for (let i = 0; i < n1; i++) bits1[i] = bitReverse(nbits1[i], next[nbits1[i]]++);
    for (let i = 0; i < n2; i++) bits2[i] = bitReverse(nbits2[i], next[nbits2[i]]++);
}

// the code lengths (within the limits, sum of 2^-length 1) minimizing the bits of the frequencies (all nonzero), by
// dynamic programming over the lengths' sums
function codeLengthsNonZero(freqs: number[], minLimit: number[], maxLimit: number[], nbits: Uint8Array): void {
    const n = freqs.length;
    let precision = 0, shortest = 255, sum = 0;
    for (let i = 0; i < n; i++) {
        sum += freqs[i];
        if (minLimit[i] < 1) minLimit[i] = 1;
        precision = Math.max(maxLimit[i], precision);
        shortest = Math.min(minLimit[i], shortest);
    }
    // (as if the shortest were 1)
    precision -= shortest - 1;
    const infinity = sum * precision, width = (1 << precision) + 1;
    const d = new Float64Array(width * (n + 1)).fill(infinity);
    d[0] = 0;
    for (let sym = 0; sym < n; sym++) {
        for (let bits = minLimit[sym]; bits <= maxLimit[sym]; bits++) {
            const delta = 1 << (precision - bits), cost = freqs[sym] * bits, from = sym * width, to = (sym + 1) * width + delta;
            for (let off = 0; off + delta <= 1 << precision; off++) {
                const v = d[from + off] + cost;
                if (v < d[to + off]) d[to + off] = v;
            }
        }
    }
    let off = 1 << precision;
    for (let sym = n - 1; sym >= 0; sym--) {
        for (let bits = minLimit[sym]; bits <= maxLimit[sym]; bits++) {
            const delta = 1 << (precision - bits);
            if (delta <= off && d[(sym + 1) * width + off] === d[sym * width + off - delta] + freqs[sym] * bits) {
                off -= delta;
                nbits[sym] = bits;
                break;
            }
        }
    }
}

function codeLengths(freqs: ArrayLike<number>, n: number, minLimit: ArrayLike<number>, maxLimit: ArrayLike<number>, nbits: Uint8Array): void {
    const f: number[] = [], lo: number[] = [], hi: number[] = [];
    for (let i = 0; i < n; i++) {
        if (freqs[i]) {
            f.push(freqs[i]);
            lo.push(minLimit[i]);
            hi.push(maxLimit[i]);
        }
    }
    const lengths = new Uint8Array(MAX_NUM_SYMBOLS);
    codeLengthsNonZero(f, lo, hi, lengths);
    for (let i = 0, k = 0; i < n; i++) nbits[i] = freqs[i] ? lengths[k++] : 0;
}

/** The prefix code of a channel: of raw residual tokens, and of runs (LZ77 lengths after a 0) */
class PrefixCode {
    readonly rawNbits = new Uint8Array(NUM_RAW_SYMBOLS);
    readonly rawBits = new Uint16Array(NUM_RAW_SYMBOLS);
    readonly lz77Nbits = new Uint8Array(NUM_LZ77);
    readonly lz77Bits = new Uint16Array(NUM_LZ77);
    // (runs of up to 39)
    readonly cacheNbits = new Uint8Array(LZ77_CACHE_SIZE);
    readonly cacheBits = new Float64Array(LZ77_CACHE_SIZE);
    readonly numRaw: number;

    constructor(rawCounts: Float64Array, lz77Counts: Float64Array) {
        // (the runs merged into one symbol of the first level)
        let numRaw = NUM_RAW_SYMBOLS;
        while (numRaw > 0 && rawCounts[numRaw - 1] === 0) numRaw--;
        this.numRaw = numRaw;
        const level1 = new Float64Array(NUM_RAW_SYMBOLS + 1);
        level1.set(rawCounts.subarray(0, numRaw));
        for (let i = 0; i < NUM_LZ77; i++) level1[numRaw] += lz77Counts[i];
        const level1Nbits = new Uint8Array(NUM_RAW_SYMBOLS + 1);
        codeLengths(level1, numRaw + 1, MIN_RAW_LENGTH, MAX_RAW_LENGTH, level1Nbits);
        let numLz77 = NUM_LZ77;
        while (numLz77 > 0 && lz77Counts[numLz77 - 1] === 0) numLz77--;
        const level2Nbits = new Uint8Array(NUM_LZ77);
        codeLengths(lz77Counts, numLz77, new Uint8Array(NUM_LZ77), new Uint8Array(NUM_LZ77).fill(15 - level1Nbits[numRaw]), level2Nbits);
        this.rawNbits.set(level1Nbits.subarray(0, numRaw));
        for (let i = 0; i < numLz77; i++) this.lz77Nbits[i] = level2Nbits[i] ? level1Nbits[numRaw] + level2Nbits[i] : 0;
        canonicalCode(this.rawNbits, this.rawBits, numRaw, this.lz77Nbits, this.lz77Bits, NUM_LZ77);
        for (let count = 0; count < LZ77_CACHE_SIZE; count++) {
            const [token, bits, nbits] = hybridUintLZ77(count);
            this.cacheNbits[count] = this.lz77Nbits[token] + nbits + this.rawNbits[0];
            this.cacheBits[count] = ((bits << this.lz77Nbits[token] | this.lz77Bits[token]) * 2 ** this.rawNbits[0]) + this.rawBits[0];
        }
    }

    /** writes the code (as code lengths, themselves prefix coded) */
    writeTo(w: BitWriter): void {
        const counts = new Float64Array(18);
        counts[17] = 3 + 2 * (NUM_LZ77 - 1);
        for (const n of this.rawNbits) counts[n]++;
        for (const n of this.lz77Nbits) counts[n]++;
        const nbits = new Uint8Array(18);
        codeLengths(counts, 18, new Uint8Array(18), new Uint8Array(18).fill(5), nbits);
        // HSKIP 0
        w.write(2, 0);
        // (the code lengths of the code lengths, in Brotli's order)
        const order = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        const lengthNbits = [2, 4, 3, 2, 2, 4], lengthBits = [0, 7, 3, 2, 1, 15];
        let num = 18;
        while (nbits[order[num - 1]] === 0) num--;
        for (let i = 0; i < num; i++) w.write(lengthNbits[nbits[order[i]]], lengthBits[nbits[order[i]]]);
        const bits = new Uint16Array(18);
        canonicalCode(new Uint8Array(0), new Uint16Array(0), 0, nbits, bits, 18);
        for (const n of this.rawNbits) w.write(nbits[n], bits[n]);
        let numLz77 = NUM_LZ77;
        while (this.lz77Nbits[numLz77 - 1] === 0) numLz77--;
        // zeros up to symbol 224 (the first of LZ77): 205 of them, as repeats (code 17)
        w.write(nbits[17], bits[17]);
        w.write(3, 0b010);
        w.write(nbits[17], bits[17]);
        w.write(3, 0b000);
        w.write(nbits[17], bits[17]);
        w.write(3, 0b010);
        for (let i = 0; i < numLz77; i++) w.write(nbits[this.lz77Nbits[i]], bits[this.lz77Nbits[i]]);
    }
}

// ---- residuals

const packSigned = (v: number): number => (v < 0 ? -2 * v - 1 : 2 * v) & 0xffff;

/** What runs and chunks of residuals go to: the encoder, or a counter of their symbols */
interface ChunkSink {
    chunk(run: number, residuals: Uint16Array, skip: number, n: number): void;
    finalize(run: number): void;
}

class ChunkEncoder implements ChunkSink {
    constructor(private readonly code: PrefixCode, private readonly w: BitWriter) { }

    // a run of zeros: a 0, then an LZ77 copy of the rest (at distance 1)
    private rle(count: number): void {
        if (count === 0) return;
        const code = this.code, w = this.w;
        count -= LZ77_MIN_LENGTH + 1;
        if (count < LZ77_CACHE_SIZE) {
            w.write(code.cacheNbits[count], code.cacheBits[count]);
            return;
        }
        const [token, bits, nbits] = hybridUintLZ77(count);
        w.write(code.rawNbits[0], code.rawBits[0]);
        w.write(code.lz77Nbits[token], code.lz77Bits[token]);
        w.write(nbits, bits);
    }

    chunk(run: number, residuals: Uint16Array, skip: number, n: number): void {
        this.rle(run);
        const nbits = this.code.rawNbits, bits = this.code.rawBits, w = this.w;
        for (let i = skip; i < n; i++) {
            // (the token and its extra bits in one write: up to 10 + 10 bits)
            const v = residuals[i], token = 32 - Math.clz32(v), extra = token ? token - 1 : 0;
            w.write(nbits[token] + extra, bits[token] | (v - (token ? 1 << extra : 0)) << nbits[token]);
        }
    }

    finalize(run: number): void {
        this.rle(run);
    }
}

class SampleCollector implements ChunkSink {
    constructor(private readonly raw: Float64Array, private readonly lz77: Float64Array) { }

    chunk(run: number, residuals: Uint16Array, skip: number, n: number): void {
        if (run) {
            this.raw[0]++;
            this.lz77[hybridUintLZ77(run - LZ77_MIN_LENGTH - 1)[0]]++;
        }
        for (let i = skip; i < n; i++) this.raw[32 - Math.clz32(residuals[i])]++;
    }

    // (the last run's length isn't known)
    finalize(): void { }
}

/**
 * The residuals of the gradient predictor of a channel's rows, in chunks: zeros at the start of chunks continue or
 * start runs (of more than 7)
 */
class RowProcessor {
    // (run 0 or more than 7)
    private run = 0;
    private readonly residuals: Uint16Array;

    constructor(private readonly sink: ChunkSink, private readonly chunkSize: number) {
        this.residuals = new Uint16Array(chunkSize);
    }

    // rows with their left, top and top left neighbors at offsets, of n pixels (read up to a whole chunk)
    processRow(row: Int16Array, o: number, left: Int16Array, ol: number, top: Int16Array, ot: number, topleft: Int16Array, otl: number, n: number): void {
        const size = this.chunkSize, residuals = this.residuals;
        for (let x = 0; x < n; x += size) {
            const count = Math.min(size, n - x);
            let prefix = 0;
            for (let i = 0; i < size; i++) {
                const px = row[o + x + i], l = left[ol + x + i], t = top[ot + x + i], tl = topleft[otl + x + i];
                const ac = l - tl, ab = l - t, bc = t - tl;
                const clamp = (ab ^ bc) < 0 ? t : l;
                const pred = (ac ^ bc) < 0 ? ac + t : clamp;
                residuals[i] = packSigned(px - pred);
                if (prefix === i && residuals[i] === 0) prefix++;
            }
            prefix = Math.min(count, prefix);
            if (prefix === count && (this.run > 0 || prefix > LZ77_MIN_LENGTH)) this.run += prefix;
            else if (prefix + this.run > LZ77_MIN_LENGTH) {
                this.sink.chunk(this.run + prefix, residuals, prefix, count);
                this.run = 0;
            } else this.sink.chunk(0, residuals, 0, count);
        }
    }

    finalize(): void {
        this.sink.finalize(this.run);
    }
}

// rows of a group's channels (two each, alternating), padded on both sides by 32
const PADDING = 32, ROW = 256 + 2 * PADDING;

/** The channels (YCoCg, then alpha) of an area of the image, through its row processors (from row yskip) */
function processArea(px: Uint8Array, stride: number, numChans: number, x0: number, y0: number, xs: number, yskip: number, ys: number, processors: RowProcessor[]): void {
    const rows = Array.from({ length: numChans }, () => [new Int16Array(ROW), new Int16Array(ROW)]);
    for (let y = 0; y < ys; y++) {
        const cur = rows.map(r => r[y & 1]), prev = rows.map(r => r[(y + 1) & 1]);
        let i = (y0 + y) * stride + x0 * numChans;
        for (let x = PADDING; x < PADDING + xs; x++, i += numChans) {
            if (numChans < 3) {
                cur[0][x] = px[i];
                if (numChans === 2) cur[1][x] = px[i + 1];
                continue;
            }
            const r = px[i], g = px[i + 1], b = px[i + 2];
            const co = r - b, tmp = b + (co >> 1), cg = g - tmp;
            cur[0][x] = tmp + (cg >> 1);
            cur[1][x] = co;
            cur[2][x] = cg;
            if (numChans === 4) cur[3][x] = px[i + 3];
        }
        // (x = -1 is the pixel above, the top left of x = 0 too)
        for (let c = 0; c < numChans; c++) {
            cur[c][PADDING - 1] = y > 0 ? prev[c][PADDING] : 0;
            prev[c][PADDING - 1] = y > 0 ? prev[c][PADDING] : 0;
        }
        if (y < yskip) continue;
        for (let c = 0; c < numChans; c++) {
            // (in the first row, the top and top left are the left)
            const top = y === 0 ? cur[c] : prev[c];
            processors[c].processRow(cur[c], PADDING, cur[c], PADDING - 1, top, y === 0 ? PADDING - 1 : PADDING, top, PADDING - 1, xs);
        }
    }
    for (let c = 0; c < numChans; c++) processors[c].finalize();
}

// ---- palettes

const HASH_SIZE = 1 << 16, MAX_COLORS = 512;
const pixelHash = (p: number): number => Math.imul(p, 2654435761) >>> 16;
const pixelAt = (px: Uint8Array, i: number, numChans: number): number => {
    let p = 0;
    for (let c = 0; c < numChans; c++) p |= px[i + c] << (8 * c);
    return p >>> 0;
};

/** The palette indices of an area, through a row processor (every row: unlike processArea, libjxl skips none) */
function processAreaPalette(px: Uint8Array, stride: number, numChans: number, x0: number, y0: number, xs: number, ys: number, lookup: Int16Array, processor: RowProcessor): void {
    const rows = [new Int16Array(ROW), new Int16Array(ROW)];
    for (let y = 0; y < ys; y++) {
        const cur = rows[y & 1], prev = rows[(y + 1) & 1];
        for (let x = 0, i = (y0 + y) * stride + x0 * numChans; x < xs; x++, i += numChans) cur[PADDING + x] = lookup[pixelHash(pixelAt(px, i, numChans))];
        cur[PADDING - 1] = y > 0 ? prev[PADDING] : 0;
        prev[PADDING - 1] = y > 0 ? prev[PADDING] : 0;
        const top = y === 0 ? cur : prev;
        processor.processRow(cur, PADDING, cur, PADDING - 1, top, y === 0 ? PADDING - 1 : PADDING, top, PADDING - 1, xs);
    }
    processor.finalize();
}

// libjxl's palette order: by luma (times alpha), in float
function paletteKey(p: number, numChans: number): number {
    const f = Math.fround, a = [p & 0xff, p >>> 8 & 0xff, p >>> 16 & 0xff, p >>> 24];
    const luma = f(f(f(f(f(0.299) * a[0]) + f(f(0.587) * a[1])) + f(f(0.114) * a[2])) + f(0.01));
    return numChans === 4 ? f(luma * a[3]) : luma;
}

/**
 * Sorts like libstdc++'s std::sort (introsort: median of three quicksort, heapsort beyond a depth, insertion sort of
 * the last 16), so that equal keys end up in the same order as libjxl's
 */
function stdSort(a: Uint32Array, n: number, less: (x: number, y: number) => boolean): void {
    const swap = (i: number, j: number): void => {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
    };
    const pushHeap = (first: number, hole: number, top: number, value: number): void => {
        let parent = Math.trunc((hole - 1) / 2);
        while (hole > top && less(a[first + parent], value)) {
            a[first + hole] = a[first + parent];
            hole = parent;
            parent = Math.trunc((hole - 1) / 2);
        }
        a[first + hole] = value;
    };
    const adjustHeap = (first: number, hole: number, len: number, value: number): void => {
        const top = hole;
        let child = hole;
        while (child < Math.trunc((len - 1) / 2)) {
            child = 2 * (child + 1);
            if (less(a[first + child], a[first + child - 1])) child--;
            a[first + hole] = a[first + child];
            hole = child;
        }
        if ((len & 1) === 0 && child === Math.trunc((len - 2) / 2)) {
            child = 2 * (child + 1);
            a[first + hole] = a[first + child - 1];
            hole = child - 1;
        }
        pushHeap(first, hole, top, value);
    };
    const heapSort = (first: number, last: number): void => {
        const len = last - first;
        if (len >= 2) {
            for (let parent = Math.trunc((len - 2) / 2); ; parent--) {
                adjustHeap(first, parent, len, a[first + parent]);
                if (parent === 0) break;
            }
        }
        while (last - first > 1) {
            last--;
            const value = a[last];
            a[last] = a[first];
            adjustHeap(first, 0, last - first, value);
        }
    };
    const medianToFirst = (result: number, x: number, y: number, z: number): void => {
        if (less(a[x], a[y])) {
            if (less(a[y], a[z])) swap(result, y);
            else if (less(a[x], a[z])) swap(result, z);
            else swap(result, x);
        } else if (less(a[x], a[z])) swap(result, x);
        else if (less(a[y], a[z])) swap(result, z);
        else swap(result, y);
    };
    const partition = (first: number, last: number, pivot: number): number => {
        for (; ;) {
            while (less(a[first], a[pivot])) first++;
            last--;
            while (less(a[pivot], a[last])) last--;
            if (!(first < last)) return first;
            swap(first, last);
            first++;
        }
    };
    const introsort = (first: number, last: number, depth: number): void => {
        while (last - first > 16) {
            if (depth === 0) {
                heapSort(first, last);
                return;
            }
            depth--;
            medianToFirst(first, first + 1, first + Math.trunc((last - first) / 2), last - 1);
            const cut = partition(first + 1, last, first);
            introsort(cut, last, depth);
            last = cut;
        }
    };
    const linearInsert = (last: number): void => {
        const value = a[last];
        let next = last - 1;
        while (less(value, a[next])) {
            a[last] = a[next];
            last = next;
            next--;
        }
        a[last] = value;
    };
    const insertionSort = (first: number, last: number): void => {
        for (let i = first + 1; i < last; i++) {
            if (less(a[i], a[first])) {
                const value = a[i];
                a.copyWithin(first + 1, first, i);
                a[first] = value;
            } else linearInsert(i);
        }
    };
    if (n < 2) return;
    introsort(0, n, 2 * floorLog2(n));
    if (n > 16) {
        insertionSort(0, 16);
        for (let i = 16; i < n; i++) linearInsert(i);
    } else insertionSort(0, n);
}

// ---- the frame

// the beginnings of the TOC's size buckets, and their sizes in bits
const GROUP_SIZE_OFFSET = [0, 1024, 17408, 4211712], TOC_BITS = [12, 16, 24, 32];
const tocBucket = (size: number): number => {
    let bucket = 0;
    while (bucket < 3 && size >= GROUP_SIZE_OFFSET[bucket + 1]) bucket++;
    return bucket;
};

// the start of the global section: the tree (a leaf per channel, all gradient), LZ77, the context map and the codes
function dcGlobalCommon(w: BitWriter, codes: PrefixCode[]): void {
    // default LF dequantization, a global tree and histograms, no LZ77 for the tree
    w.write(1, 1);
    w.write(1, 1);
    w.write(1, 0);
    // the tree's histograms: one context, a simple prefix code of 4 symbols
    w.write(1, 1);
    w.write(2, 0);
    w.write(1, 1);
    w.write(4, 0);
    w.write(6, 0b100011);
    w.write(2, 1);
    w.write(2, 3);
    w.write(2, 0);
    w.write(2, 1);
    w.write(2, 2);
    w.write(2, 3);
    w.write(1, 0);
    const symbolBits = [0b00, 0b10, 0b001, 0b101, 0b0011, 0b0111], symbolNbits = [2, 2, 3, 3, 4, 4];
    for (const v of [1, 2, 1, 4, 1, 0, 0, 5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 5, 0, 0, 0]) w.write(symbolNbits[v], symbolBits[v]);
    // LZ77 (from symbol 224, at least 7 long, lengths as 400 hybrid uints)
    w.write(1, 1);
    w.write(2, 0);
    w.write(4, 0b1010);
    w.write(4, 4);
    w.write(3, 0);
    w.write(3, 0);
    // the context map: a context per channel, the distances first
    w.write(1, 1);
    w.write(2, 3);
    for (const v of [4, 3, 2, 1, 0]) w.write(3, v);
    // prefix codes, 000 hybrid uints
    w.write(1, 1);
    w.write(4, 0);
    for (let i = 0; i < 4; i++) w.write(4, 0);
    // alphabet sizes: 2 distances (only 1 is used), 512 symbols
    w.write(5, 0b00001);
    for (let i = 0; i < 4; i++) {
        w.write(1, 1);
        w.write(4, 8);
        w.write(8, 256);
    }
    // the distances' code: a single symbol
    w.write(2, 1);
    w.write(2, 0);
    w.write(1, 1);
    for (const code of codes) code.writeTo(w);
    // the global modular image: the global tree, default weighted predictor
    w.write(1, 1);
    w.write(1, 1);
}

/**
 * Encodes RGBA pixels as a lossless JPEG XL codestream: grey if every pixel is, with alpha if one isn't opaque; byte for
 * byte what cjxl -e 1 writes on CPUs with AVX2 or NEON (libjxl's chunks of 16 pixels)
 */
export function encodeRGBA(rgba: Uint8Array, width: number, height: number): Uint8Array {
    if (width < 1 || height < 1) throw new RangeError('JPEG XL: dimensions must be at least 1');
    const n = width * height;
    let grey = true, opaque = true;
    for (let i = 0; i < 4 * n && (grey || opaque); i += 4) {
        if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) grey = false;
        if (rgba[i + 3] !== 255) opaque = false;
    }
    const numChans = (grey ? 1 : 3) + (opaque ? 0 : 1);
    if (numChans === 4) return encode(rgba, width, height, 4);
    const px = new Uint8Array(n * numChans);
    for (let i = 0, o = 0; i < 4 * n; i += 4) {
        px[o++] = rgba[i];
        if (!grey) {
            px[o++] = rgba[i + 1];
            px[o++] = rgba[i + 2];
        }
        if (!opaque) px[o++] = rgba[i + 3];
    }
    return encode(px, width, height, numChans);
}

/** Encodes 8-bit samples of 1-4 channels (grey, grey and alpha, RGB, RGBA) as a JPEG XL codestream */
export function encode(px: Uint8Array, width: number, height: number, numChans: number, chunkSize = 16): Uint8Array {
    const stride = width * numChans;
    // ---- a palette, if the colors (with black) are at most 512 and their hashes don't collide
    const palette = new Uint32Array(HASH_SIZE), lookup = new Int16Array(HASH_SIZE);
    let collided = false;
    for (let y = 0; y < height && !collided; y++) {
        for (let x = 0, i = y * stride; x < width; x++, i += numChans) {
            const p = pixelAt(px, i, numChans), h = pixelHash(p);
            if (palette[h] !== 0 && palette[h] !== p) {
                collided = true;
                break;
            }
            palette[h] = p;
        }
    }
    let pcolors = 0, entries = 0;
    if (!collided) {
        // (black is always there)
        pcolors = 1;
        let color = false, minG = 255, maxG = 0;
        for (let k = 0; k < HASH_SIZE; k++) {
            const p = palette[k];
            if (p === 0) continue;
            palette[entries++] = p;
            const g = p >>> 8 & 0xff;
            if ((p & 0xff) !== g || (p & 0xff) !== (p >>> 16 & 0xff)) color = true;
            minG = Math.min(minG, g);
            maxG = Math.max(maxG, g);
            if (entries + pcolors > MAX_COLORS) {
                collided = true;
                break;
            }
        }
        // (not for grey images without many holes)
        if (!color && maxG - minG < Math.fround(entries * Math.fround(1.4))) collided = true;
    }
    if (!collided) {
        stdSort(palette, entries, (a, b) => paletteKey(a, numChans) < paletteKey(b, numChans));
        for (let k = 0; k < entries; k++) lookup[pixelHash(palette[k])] = pcolors++;
    }

    // ---- the codes, from samples of every group's middle rows
    const groupsX = Math.ceil(width / 256), groupsY = Math.ceil(height / 256), oneGroup = groupsX === 1 && groupsY === 1;
    const dcGroups = Math.ceil(width / 2048) * Math.ceil(height / 2048);
    const rawCounts = Array.from({ length: 4 }, () => new Float64Array(NUM_RAW_SYMBOLS));
    const lz77Counts = Array.from({ length: 4 }, () => new Float64Array(NUM_LZ77));
    for (let gy = 0; gy < groupsY; gy++) {
        for (let gx = 0; gx < groupsX; gx++) {
            const x0 = gx * 256, y0 = gy * 256, xs = Math.min(width - x0, 256), ys = Math.min(height - y0, 256);
            // (effort 2)
            const rows = Math.floor(4 * ys / 256), begin = Math.floor(Math.max(0, ys - rows) / 2), count = Math.min(rows, ys - begin);
            const xMax = Math.floor(xs / chunkSize) * chunkSize;
            if (collided) {
                const collectors = Array.from({ length: numChans }, (_, c) => new RowProcessor(new SampleCollector(rawCounts[c], lz77Counts[c]), chunkSize));
                processArea(px, stride, numChans, x0, y0 + begin, xMax, 1, 1 + count, collectors);
            } else {
                const c = oneGroup ? 1 : 0;
                processAreaPalette(px, stride, numChans, x0, y0 + begin, xMax, 1 + count, lookup, new RowProcessor(new SampleCollector(rawCounts[c], lz77Counts[c]), chunkSize));
            }
        }
    }
    const baseRaw = [3843, 852, 1270, 1214, 1014, 727, 481, 300, 159, 51, 5, 1, 1, 1, 1, 1, 1, 1, 1];
    // (residuals gain a bit by YCoCg; libjxl counts every palette as large)
    const numSymbols = numChans > 2 || !collided ? 11 : 10;
    for (let i = numSymbols; i < NUM_RAW_SYMBOLS; i++) baseRaw[i] = 0;
    for (let c = 0; c < 4; c++) for (let i = 0; i < NUM_RAW_SYMBOLS; i++) rawCounts[c][i] = rawCounts[c][i] * 256 + baseRaw[i];
    if (!collided) {
        // (every palette index can be coded; the tokens only of the palette itself get a bad code)
        const token = hybridUint000(packSigned(pcolors - 1))[0];
        for (let i = 0; i < token + 1; i++) rawCounts[0][i] = Math.max(rawCounts[0][i], 1);
        for (let i = token + 1; i < 10; i++) rawCounts[0][i] = 1;
    }
    const baseLz77 = [29, 27, 25, 23, 21, 21, 19, 18, 21, 17, 16, 15, 15, 14, 13, 13, 137, 98, 61, 34, 1, 1, 1, 1, 1, 1, 1, 1];
    for (let c = 0; c < 4; c++) for (let i = 0; i < NUM_LZ77; i++) lz77Counts[c][i] = lz77Counts[c][i] * 256 + (baseLz77[i] ?? 0);
    const codes = [0, 1, 2, 3].map(c => new PrefixCode(rawCounts[c], lz77Counts[c]));

    // ---- the sections: the global one (with the first group's channel 0 if there's one group), DC groups (empty),
    // AC global (empty), the groups' channels
    const numSections = oneGroup ? 1 : 2 + dcGroups + groupsX * groupsY;
    const sections: BitWriter[][] = Array.from({ length: numSections }, () => [new BitWriter(), new BitWriter(), new BitWriter(), new BitWriter()]);
    const global = sections[0][0];
    dcGlobalCommon(global, codes);
    if (collided) {
        // YCoCg (an RCT from channel 0)
        if (numChans > 2) {
            global.write(2, 0b01);
            global.write(2, 0b00);
            global.write(5, 0);
            global.write(2, 0b00);
        } else global.write(2, 0b00);
    } else {
        global.write(2, 0b01);
        global.write(2, 0b01);
        global.write(5, 0);
        if (numChans === 1) global.write(2, 0b00);
        else if (numChans === 3) global.write(2, 0b01);
        else if (numChans === 4) global.write(2, 0b10);
        else {
            global.write(2, 0b11);
            global.write(13, numChans - 1);
        }
        if (pcolors < 256) {
            global.write(2, 0b00);
            global.write(8, pcolors);
        } else {
            global.write(2, 0b01);
            global.write(10, pcolors - 256);
        }
        // no deltas, zero predictor
        global.write(2, 0b00);
        global.write(4, 0);
        // the palette: a row per channel (black first)
        const p = Array.from({ length: 4 }, () => new Int16Array(32 + 1024));
        for (let i = 0; i < pcolors; i++) for (let c = 0; c < 4; c++) p[c][17 + i] = palette[i] >>> (8 * c) & 0xff;
        const processor = new RowProcessor(new ChunkEncoder(codes[0], global), chunkSize);
        p[0][15] = 0;
        processor.processRow(p[0], 16, p[0], 15, p[0], 15, p[0], 15, pcolors);
        for (let c = 1; c < 4; c++) {
            p[c][15] = p[c - 1][16];
            p[c - 1][15] = p[c - 1][16];
            if (numChans > c) processor.processRow(p[c], 16, p[c], 15, p[c - 1], 16, p[c - 1], 15, pcolors);
        }
        processor.finalize();
    }
    if (!oneGroup) global.zeroPadToByte();
    for (let g = 0; g < groupsX * groupsY; g++) {
        const x0 = g % groupsX * 256, y0 = Math.floor(g / groupsX) * 256, xs = Math.min(width - x0, 256), ys = Math.min(height - y0, 256);
        const out = sections[oneGroup ? 0 : 2 + dcGroups + g];
        if (!oneGroup) {
            // the group's modular image: the global tree, default weighted predictor, no transforms
            out[0].write(1, 1);
            out[0].write(1, 1);
            out[0].write(2, 0b00);
        }
        if (collided) {
            const encoders = Array.from({ length: numChans }, (_, c) => new RowProcessor(new ChunkEncoder(codes[c], out[c]), chunkSize));
            processArea(px, stride, numChans, x0, y0, xs, 0, ys, encoders);
        } else processAreaPalette(px, stride, numChans, x0, y0, xs, ys, lookup, new RowProcessor(new ChunkEncoder(codes[oneGroup ? 1 : 0], out[0]), chunkSize));
    }

    // ---- the codestream: the headers, the frame header with the table of contents, the sections
    const w = new BitWriter();
    imageHeader(w, width, height, numChans);
    frameHeader(w, numChans === 2 || numChans === 4);
    const sizes = sections.map(s => Math.ceil(s.reduce((sum, c) => sum + c.size, 0) / 8));
    for (const size of sizes) {
        const bucket = tocBucket(size);
        w.write(2, bucket);
        w.write(TOC_BITS[bucket] - 2, size - GROUP_SIZE_OFFSET[bucket]);
    }
    w.zeroPadToByte();
    for (const section of sections) {
        for (let c = 0; c < numChans; c++) w.append(section[c]);
        w.zeroPadToByte();
    }
    return w.bytes().slice();
}

// ---- headers

// a regular modular frame: one pass, no filters, replacing, the last one
function frameHeader(w: BitWriter, alpha: boolean): void {
    w.write(1, 0);
    w.write(2, 0b00);
    w.write(1, 1);
    w.write(2, 0b00);
    w.write(1, 0);
    w.write(2, 0b00);
    if (alpha) w.write(2, 0b00);
    w.write(2, 0b01);
    w.write(2, 0b00);
    w.write(1, 0);
    w.write(2, 0b00);
    if (alpha) w.write(2, 0b00);
    w.write(1, 1);
    w.write(2, 0b00);
    w.write(1, 0);
    w.write(1, 0);
    w.write(2, 0);
    w.write(2, 0b00);
    w.write(2, 0b00);
    // no TOC permutation
    w.write(1, 0);
    w.zeroPadToByte();
}
