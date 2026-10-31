/*!
 * The JPEG XL entropy encoder: tokens of contexts as hybrid integers, the contexts clustered (like libjxl's
 * FastClusterHistograms, lib/jxl/enc_cluster.cc), the context map, ANS (libjxl's lib/jxl/enc_ans.cc: the counts
 * normalized and stored, the tokens coded in reverse). Copyright (c) the JPEG XL Project Authors, BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */
import { BitWriter } from './bit-writer.ts';
import { BitReader } from './bits.ts';
import { AnsHistogram } from './entropy.ts';

/** The values of a stream with their contexts */
export class Tokens {
    ctx = new Uint32Array(1024);
    value = new Uint32Array(1024);
    length = 0;

    push(ctx: number, value: number): void {
        if (this.length === this.ctx.length) {
            const ctx = new Uint32Array(this.length * 2), value = new Uint32Array(this.length * 2);
            ctx.set(this.ctx);
            value.set(this.value);
            this.ctx = ctx;
            this.value = value;
        }
        this.ctx[this.length] = ctx;
        this.value[this.length++] = value;
    }
}

/** A signed integer as the unsigned one JPEG XL codes (0, -1, 1, -2, ...: 0, 1, 2, 3, ...) */
export const packSigned = (v: number): number => v < 0 ? -2 * v - 1 : 2 * v;

// the hybrid integer configuration: values below 16 are tokens, larger ones a token of their exponent and top 2 bits
// with the rest as raw bits (libjxl's default, HybridUintConfig(4, 2, 0))
const SPLIT_EXPONENT = 4, MSB = 2, LSB = 0, SPLIT = 1 << SPLIT_EXPONENT;

const token = (v: number): number => {
    if (v < SPLIT) return v;
    const n = 31 - Math.clz32(v), m = v - (1 << n);
    return SPLIT + ((n - SPLIT_EXPONENT) << (MSB + LSB)) + ((m >>> (n - MSB)) << LSB) + (m & ((1 << LSB) - 1));
};

// ---- ANS

const ANS_LOG_TAB_SIZE = 12, ANS_TAB_SIZE = 1 << ANS_LOG_TAB_SIZE, LOG_ALPHABET_SIZE = 8;
const floorLog2 = (v: number): number => 31 - Math.clz32(v);

// the bits of a count's precision (GetPopulationCountPrecision)
const precision = (logcount: number, shift: number): number => Math.max(0, Math.min(logcount, shift - ((ANS_LOG_TAB_SIZE - logcount) >> 1)));

// the step between representable counts around count
function smallestIncrement(count: number, shift: number): number {
    const bits = count === 0 ? -1 : floorLog2(count), drop = bits - precision(bits, shift);
    return drop < 0 ? 1 : 1 << drop;
}

// the counts scaled to the table size, representable with the shift (RebalanceHistogram); the position whose count is
// implied (the largest), or -1
function rebalance(targets: Float64Array, shift: number, minimizeErrorOfSum: boolean, counts: Int32Array): number {
    let sum = 0, sumNonRounded = 0, remainderPos = -1, remainderLog = -1;
    counts.fill(0);
    for (let n = 0; n < targets.length; n++) {
        if (targets[n] > 0 && targets[n] < 1) {
            counts[n] = 1;
            sumNonRounded += targets[n];
            sum++;
        }
    }
    const discount = (ANS_TAB_SIZE - sum) / (ANS_TAB_SIZE - sumNonRounded);
    for (let n = 0; n < targets.length; n++) {
        if (targets[n] < 1) continue;
        sumNonRounded += targets[n];
        let c = Math.trunc(Math.fround(targets[n] * discount));
        if (c === 0) c = 1;
        if (c === ANS_TAB_SIZE) c = ANS_TAB_SIZE - 1;
        const inc = smallestIncrement(c, shift);
        c -= c & (inc - 1);
        const target = minimizeErrorOfSum ? Math.trunc(sumNonRounded) - sum : Math.trunc(targets[n]);
        if (c === 0 || (target >= c + inc / 2 && c + inc < ANS_TAB_SIZE)) c += inc;
        counts[n] = c;
        sum += c;
        const log = floorLog2(c);
        if (log > remainderLog) {
            remainderPos = n;
            remainderLog = log;
        }
    }
    if (remainderPos < 0) return -1;
    counts[remainderPos] -= sum - ANS_TAB_SIZE;
    return counts[remainderPos] > 0 ? remainderPos : -1;
}

function storeU8(w: BitWriter, n: number): void {
    if (n === 0) w.write(1, 0);
    else {
        const nbits = floorLog2(n);
        w.write(1, 1);
        w.write(3, nbits);
        w.write(nbits, n - (1 << nbits));
    }
}

// the static code of log counts (13: a run of the previous count)
const LOG_COUNT_NBITS = [5, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 6, 7, 7], LOG_COUNT_BITS = [17, 11, 15, 3, 9, 7, 4, 2, 5, 6, 0, 33, 1, 65];

// writes normalized counts (EncodeCounts): small (1-2 symbols) or their log counts, run length coded, and precisions
function writeCounts(w: BitWriter, counts: Int32Array, omitPos: number, shift: number, symbols: number[]): void {
    const size = counts.length;
    if (symbols.length <= 2) {
        w.write(1, 1);
        w.write(1, Math.max(symbols.length, 1) - 1);
        for (const s of symbols.length ? symbols : [0]) storeU8(w, s);
        if (symbols.length === 2) w.write(ANS_LOG_TAB_SIZE, counts[symbols[0]]);
        return;
    }
    w.write(1, 0);
    w.write(1, 0);
    // (runs of the same count, not across the implied one)
    const same = new Int32Array(size);
    let last = 0;
    for (let i = 1; i < size; i++) {
        if (counts[i] !== counts[last] || i + 1 === size || i - last >= 255 || i === omitPos || i === omitPos + 1) {
            same[last] = i - last;
            last = i + 1;
        }
    }
    let length = 0, omitLog = 0;
    const logcounts = new Int32Array(size);
    for (let i = 0; i < size; i++) {
        if (i === omitPos) length = i + 1;
        else if (counts[i] > 0) {
            logcounts[i] = floorLog2(counts[i]) + 1;
            length = i + 1;
            omitLog = Math.max(omitLog, i < omitPos ? logcounts[i] + 1 : logcounts[i]);
        }
    }
    logcounts[omitPos] = omitLog;
    // the shift, Elias gamma like
    const log = floorLog2(shift + 1);
    w.write(log, (1 << log) - 1);
    if (log !== floorLog2(ANS_LOG_TAB_SIZE + 1)) w.write(1, 0);
    w.write(log, ((1 << log) - 1) & (shift + 1));
    storeU8(w, length - 3);
    const MIN_REPS = 4, REP = ANS_LOG_TAB_SIZE + 1;
    for (let i = 0; i < length; i++) {
        if (i > 0 && same[i - 1] > MIN_REPS) {
            w.write(LOG_COUNT_NBITS[REP], LOG_COUNT_BITS[REP]);
            storeU8(w, same[i - 1] - MIN_REPS - 1);
            i += same[i - 1] - 2;
            continue;
        }
        w.write(LOG_COUNT_NBITS[logcounts[i]], LOG_COUNT_BITS[logcounts[i]]);
    }
    for (let i = 0; i < length; i++) {
        if (i > 0 && same[i - 1] > MIN_REPS) {
            i += same[i - 1] - 2;
            continue;
        }
        if (logcounts[i] > 1 && i !== omitPos) {
            const bitcount = precision(logcounts[i] - 1, shift), drop = logcounts[i] - 1 - bitcount;
            w.write(bitcount, (counts[i] >> drop) - (1 << bitcount));
        }
    }
}

/** An ANS distribution of an alphabet: its stored form, frequencies and the state of each symbol's slots */
class AnsCode {
    private readonly stored: BitWriter;
    readonly freq: Int32Array;
    /** per symbol: the table slots of its frequency */
    readonly reverse: Int32Array[];

    constructor(histogram: Float64Array) {
        const size = histogram.length;
        let total = 0;
        const symbols: number[] = [];
        for (let i = 0; i < size; i++) {
            total += histogram[i];
            if (histogram[i] > 0) symbols.push(i);
        }
        // the cheapest of a flat distribution and the shifts (stored size and coded bits)
        let best = new BitWriter();
        if (symbols.length <= 1) {
            const c = new Int32Array(size);
            c[symbols[0] ?? 0] = ANS_TAB_SIZE;
            writeCounts(best, c, -1, 0, symbols);
        } else {
            best.write(1, 0);
            best.write(1, 1);
            storeU8(best, size - 1);
            let bestCost = best.size + total * Math.max(Math.log2(size), 0);
            const targets = Float64Array.from(histogram.subarray(0, symbols[symbols.length - 1] + 1), v => Math.fround(Math.fround(ANS_TAB_SIZE / total) * v));
            const counts = new Int32Array(targets.length);
            for (let shift = 0; shift <= ANS_LOG_TAB_SIZE; shift++) {
                let omit = rebalance(targets, shift, false, counts);
                if (omit < 0) omit = rebalance(targets, shift, true, counts);
                if (omit < 0) continue;
                const full = new Int32Array(size);
                full.set(counts);
                const w = new BitWriter();
                writeCounts(w, full, omit, shift, symbols);
                let cost = w.size;
                for (const s of symbols) cost += histogram[s] * Math.max(0, ANS_LOG_TAB_SIZE - Math.log2(full[s]));
                if (cost < bestCost) {
                    bestCost = cost;
                    best = w;
                }
            }
        }
        this.stored = best;
        // (the decoder's view of it: its alias table maps the slots)
        const bytes = new BitWriter();
        bytes.append(best);
        bytes.write(32, 0);
        const h = new AnsHistogram(new BitReader(bytes.bytes(), 0, bytes.length), LOG_ALPHABET_SIZE);
        this.freq = Int32Array.from(h.freq);
        this.reverse = Array.from(this.freq, f => new Int32Array(f));
        const bucket = 1 << h.logBucketSize;
        for (let i = 0; i < ANS_TAB_SIZE; i++) {
            const b = i >> h.logBucketSize, pos = i & (bucket - 1);
            if (pos < h.cutoff[b]) this.reverse[b][pos] = i;
            else this.reverse[h.symbol[b]][h.offset[b] + pos] = i;
        }
    }

    write(w: BitWriter): void {
        w.append(this.stored);
    }
}

// the bits of a histogram coded optimally (its entropy), with a rough cost per symbol for the code itself
function cost(h: Float64Array, total: number): number {
    if (total === 0) return 0;
    let bits = 0, used = 0;
    for (let i = 0; i < h.length; i++) {
        if (!h[i]) continue;
        bits -= h[i] * Math.log2(h[i] / total);
        used++;
    }
    return bits + 3 * used;
}

/** Options of the entropy code */
export interface EntropyOptions {
    /** at most this many clusters (up to 255) */
    maxClusters?: number;
}

/** The entropy code of streams that share it: clustered contexts and their ANS distributions */
export class EntropyCode {
    private readonly ctxMap: Uint8Array;
    private readonly ans: AnsCode[];

    constructor(streams: Tokens[], readonly numContexts: number, { maxClusters = 64 }: EntropyOptions = {}) {
        // the histograms of the contexts' tokens
        let alphabet = 1;
        for (const t of streams) {
            for (let i = 0; i < t.length; i++) {
                const tk = token(t.value[i]);
                if (tk + 1 > alphabet) alphabet = tk + 1;
            }
        }
        const hist = Array.from({ length: numContexts }, () => new Float64Array(alphabet)), totals = new Float64Array(numContexts);
        for (const t of streams) {
            for (let i = 0; i < t.length; i++) {
                hist[t.ctx[i]][token(t.value[i])]++;
                totals[t.ctx[i]]++;
            }
        }
        this.ctxMap = new Uint8Array(numContexts);
        const clusters = cluster(hist, totals, Math.min(maxClusters, 255, numContexts), this.ctxMap).map(h => {
            let size = h.length;
            while (size > 1 && h[size - 1] === 0) size--;
            return h.subarray(0, size);
        });
        this.ans = clusters.map(h => new AnsCode(h));
    }

    /** writes the code: no LZ77, the context map, ANS (not prefix codes), the configurations and distributions */
    writeHeader(w: BitWriter): void {
        w.write(1, 0);
        const n = this.ans.length;
        writeContextMap(w, this.ctxMap, n);
        w.write(1, 0);
        w.write(2, LOG_ALPHABET_SIZE - 5);
        for (let i = 0; i < n; i++) {
            // (the hybrid integer configuration)
            w.write(4, SPLIT_EXPONENT);
            w.write(3, MSB);
            w.write(32 - Math.clz32(SPLIT_EXPONENT - MSB), LSB);
        }
        for (const c of this.ans) c.write(w);
    }

    /** writes the tokens of a stream */
    writeTokens(w: BitWriter, t: Tokens): void {
        const map = this.ctxMap;
        // ANS: the tokens in reverse, the 16 bits of each renormalization read after the token's symbol (before its
        // raw bits); the final state first
        const codes = this.ans, n = t.length, chunks = new Int32Array(n);
        let state = 0x130000;
        for (let i = n - 1; i >= 0; i--) {
            const code = codes[map[t.ctx[i]]], tk = token(t.value[i]), freq = code.freq[tk];
            chunks[i] = -1;
            if (state >>> 20 >= freq) {
                chunks[i] = state & 0xffff;
                state >>>= 16;
            }
            const v = Math.floor(state / freq);
            state = v * ANS_TAB_SIZE + code.reverse[tk][state - v * freq];
        }
        w.write(32, state);
        for (let i = 0; i < n; i++) {
            if (chunks[i] >= 0) w.write(16, chunks[i]);
            const v = t.value[i];
            if (v >= SPLIT) {
                const nbits = 31 - Math.clz32(v) - MSB - LSB;
                w.write(nbits, (v >>> LSB) & ((1 << nbits) - 1));
            }
        }
    }
}

// clusters the histograms (into ctxMap), returns the clusters' histograms: the largest one first, then while one
// costs much more apart from every cluster (by the bits merging it would add), it becomes a cluster too
function cluster(hist: Float64Array[], totals: Float64Array, max: number, ctxMap: Uint8Array): Float64Array[] {
    const n = hist.length, alphabet = hist[0].length;
    const own = hist.map((h, i) => cost(h, totals[i]));
    const merged = (a: Float64Array, ta: number, b: Float64Array, tb: number): number => {
        let bits = 0, used = 0;
        const total = ta + tb;
        for (let i = 0; i < alphabet; i++) {
            const v = a[i] + b[i];
            if (!v) continue;
            bits -= v * Math.log2(v / total);
            used++;
        }
        return bits + 3 * used;
    };
    let first = -1;
    for (let i = 0; i < n; i++) if (totals[i] && (first < 0 || totals[i] > totals[first])) first = i;
    if (first < 0) return [new Float64Array(1)];
    const centers = [first], dist = new Float64Array(n).fill(Infinity), assign = new Int32Array(n);
    for (; ;) {
        const c = centers[centers.length - 1];
        let far = -1;
        for (let i = 0; i < n; i++) {
            if (!totals[i]) continue;
            const d = merged(hist[i], totals[i], hist[c], totals[c]) - own[i] - own[c];
            if (d < dist[i]) {
                dist[i] = d;
                assign[i] = centers.length - 1;
            }
            if (far < 0 || dist[i] > dist[far]) far = i;
        }
        // (a cluster pays off when merging would cost more than a code of its own)
        if (centers.length >= max || far < 0 || dist[far] < 64) break;
        centers.push(far);
    }
    // (every center in its own cluster, so that none is empty)
    centers.forEach((c, i) => assign[c] = i);
    const out = centers.map(() => new Float64Array(alphabet));
    for (let i = 0; i < n; i++) {
        ctxMap[i] = assign[i];
        if (!totals[i]) continue;
        const h = out[assign[i]];
        for (let k = 0; k < alphabet; k++) h[k] += hist[i][k];
    }
    return out;
}

/** Writes the cluster of each context (the context map) */
function writeContextMap(w: BitWriter, ctxMap: Uint8Array, numClusters: number): void {
    if (ctxMap.length === 1) return;
    const bits = numClusters <= 1 ? 0 : 32 - Math.clz32(numClusters - 1);
    // simple (fixed bits per context) or entropy coded, with move to front if that's smaller
    const simple = bits <= 3 ? 3 + bits * ctxMap.length : Infinity;
    const coded = (mtf: boolean): BitWriter => {
        const t = new Tokens();
        const order = new Uint8Array(256).map((_, i) => i);
        for (const c of ctxMap) {
            if (!mtf) {
                t.push(0, c);
                continue;
            }
            const index = order.indexOf(c);
            t.push(0, index);
            order.copyWithin(1, 0, index);
            order[0] = c;
        }
        const code = new EntropyCode([t], 1);
        const out = new BitWriter();
        out.write(1, 0);
        out.write(1, mtf ? 1 : 0);
        code.writeHeader(out);
        code.writeTokens(out, t);
        return out;
    };
    const a = coded(false), b = coded(true), best = a.size <= b.size ? a : b;
    if (simple <= best.size) {
        w.write(1, 1);
        w.write(2, bits);
        for (const c of ctxMap) w.write(bits, c);
    } else w.append(best);
}
