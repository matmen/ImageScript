/*!
 * WebP lossless (VP8L) bitstream, as specified in RFC 9649 ("WebP Image Format") section 3 onwards, including its
 * table of short distance codes. Copyright (c) 2024 IETF Trust and the persons identified as the document authors,
 * Revised BSD License (see THIRD_PARTY_NOTICES.md). The encoder's choice of transforms follows libwebp's entropy
 * analysis (src/enc/vp8l_enc.c, AnalyzeEntropy). Copyright (c) 2012 Google Inc., BSD-3-Clause License
 */

import { ByteWriter } from '../util/bytes.ts';
import { MAX_PIXELS, checkPixels } from '../util/limits.ts';
import { runChunks, shared, type ChunkTask, type Thread } from '../util/threads.ts';

/** decoded VP8L image: ARGB pixels (0xAARRGGBB) */
export interface VP8LImage {
    width: number;
    height: number;
    argb: Uint32Array;
    hasAlpha: boolean;
}

const SIGNATURE = 0x2f;

const enum Transform { PREDICTOR, COLOR, SUBTRACT_GREEN, COLOR_INDEXING }

// order in which the code length code lengths are stored
const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

// the 120 short distance codes as (dx, dy) pairs, RFC 9649 section 4.2.2
const DISTANCE_MAP = Int8Array.of(
    0, 1, 1, 0, 1, 1, -1, 1, 0, 2, 2, 0, 1, 2, -1, 2, 2, 1, -2, 1, 2, 2, -2, 2, 0, 3, 3, 0, 1, 3, -1, 3, 3, 1, -3, 1,
    2, 3, -2, 3, 3, 2, -3, 2, 0, 4, 4, 0, 1, 4, -1, 4, 4, 1, -4, 1, 3, 3, -3, 3, 2, 4, -2, 4, 4, 2, -4, 2, 0, 5,
    3, 4, -3, 4, 4, 3, -4, 3, 5, 0, 1, 5, -1, 5, 5, 1, -5, 1, 2, 5, -2, 5, 5, 2, -5, 2, 4, 4, -4, 4, 3, 5, -3, 5,
    5, 3, -5, 3, 0, 6, 6, 0, 1, 6, -1, 6, 6, 1, -6, 1, 2, 6, -2, 6, 6, 2, -6, 2, 4, 5, -4, 5, 5, 4, -5, 4, 3, 6,
    -3, 6, 6, 3, -6, 3, 0, 7, 7, 0, 1, 7, -1, 7, 5, 5, -5, 5, 7, 1, -7, 1, 4, 6, -4, 6, 6, 4, -6, 4, 2, 7, -2, 7,
    7, 2, -7, 2, 3, 7, -3, 7, 7, 3, -7, 3, 5, 6, -5, 6, 6, 5, -6, 5, 8, 0, 4, 7, -4, 7, 7, 4, -7, 4, 8, 1, 8, 2,
    6, 6, -6, 6, 8, 3, 5, 7, -5, 7, 7, 5, -7, 5, 8, 4, 6, 7, -6, 7, 7, 6, -7, 6, 8, 5, 7, 7, -7, 7, 8, 6, 8, 7
);

const NUM_LITERAL_CODES = 256;
const NUM_LENGTH_CODES = 24;
const NUM_DISTANCE_CODES = 40;

/**
 * LSB-first bit reader
 */
export class BitReader {
    data: Uint8Array;
    pos = 0;
    // bits not consumed yet, the next one is the lowest
    private buffer = 0;
    private count = 0;

    constructor(data: Uint8Array, offset = 0) {
        this.data = data;
        this.pos = offset;
    }

    private fill(): void {
        while (this.count <= 24) {
            const byte = this.pos < this.data.length ? this.data[this.pos] : 0;
            if (this.pos > this.data.length + 8) throw new Error('VP8L: unexpected end of data');
            this.pos++;
            this.buffer |= byte << this.count;
            this.count += 8;
        }
    }

    /** reads up to 24 bits */
    read(bits: number): number {
        if (bits === 0) return 0;
        if (this.count < bits) this.fill();
        const value = this.buffer & (1 << bits) - 1;
        this.buffer >>>= bits;
        this.count -= bits;
        return value;
    }

    /** the next 24 bits without consuming them */
    peek(): number {
        if (this.count < 24) this.fill();
        return this.buffer & 0xffffff;
    }

    skip(bits: number): void {
        this.buffer >>>= bits;
        this.count -= bits;
    }

    /** whether reading went past the end of the data */
    get overrun(): boolean {
        return this.pos - (this.count >> 3) > this.data.length;
    }
}

// two level huffman lookup table: entries are (symbol << 4 | length) for codes up to ROOT_BITS long,
// longer codes point to a second level table ((offset << 4 | bits) with the 0x8000_0000 flag)
const ROOT_BITS = 8;
const SUBTABLE = 0x40000000;

/** canonical prefix code as lookup table */
export interface PrefixCode {
    table: Int32Array;
    /** set if the code has a single symbol (which takes zero bits) */
    single: number;
}

/**
 * Builds a lookup table from code lengths (RFC 9649 section 3.7.2.1.1: canonical codes, read LSB first)
 */
export function buildCode(lengths: ArrayLike<number>, size: number): PrefixCode {
    let nonZero = 0, last = 0, maxLength = 0;
    const counts = new Int32Array(16);
    for (let s = 0; s < size; s++) {
        const l = lengths[s];
        if (l) {
            nonZero++;
            last = s;
            counts[l]++;
            if (l > maxLength) maxLength = l;
        }
    }

    if (nonZero === 0) throw new Error('VP8L: empty prefix code');
    // a single used symbol is coded with zero bits
    if (nonZero === 1) return { table: new Int32Array(0), single: last };

    // first code of each length, checking that the code is complete (the spec requires it)
    const next = new Int32Array(16);
    let code = 0, left = 1;
    for (let l = 1; l <= 15; l++) {
        code = code + counts[l - 1] << 1;
        next[l] = code;
        left = (left << 1) - counts[l];
        if (left < 0) throw new Error('VP8L: invalid prefix code (oversubscribed)');
    }
    if (left !== 0) throw new Error('VP8L: invalid prefix code (incomplete)');

    // codes are consumed LSB first, so the table is indexed by the bit-reversed code
    const reverse = (c: number, len: number): number => {
        let r = 0;
        for (let i = 0; i < len; i++, c >>= 1) r = r << 1 | c & 1;
        return r;
    };

    // size the second level tables: for every root prefix, the longest code below it
    const rootSize = 1 << ROOT_BITS;
    const subBits = new Int32Array(rootSize);
    const symbolCodes = new Int32Array(size);
    for (let s = 0; s < size; s++) {
        const l = lengths[s];
        if (!l) continue;
        const c = reverse(next[l]++, l);
        symbolCodes[s] = c;
        if (l > ROOT_BITS) {
            const root = c & rootSize - 1;
            subBits[root] = Math.max(subBits[root], l - ROOT_BITS);
        }
    }

    let total = rootSize;
    const subOffset = new Int32Array(rootSize);
    for (let r = 0; r < rootSize; r++)
        if (subBits[r]) {
            subOffset[r] = total;
            total += 1 << subBits[r];
        }

    const table = new Int32Array(total);
    for (let r = 0; r < rootSize; r++)
        if (subBits[r]) table[r] = SUBTABLE | subOffset[r] << 4 | subBits[r];

    for (let s = 0; s < size; s++) {
        const l = lengths[s];
        if (!l) continue;
        const c = symbolCodes[s];
        if (l <= ROOT_BITS) {
            for (let i = c; i < rootSize; i += 1 << l) table[i] = s << 4 | l;
        } else {
            const root = c & rootSize - 1;
            const bits = subBits[root];
            const rest = c >> ROOT_BITS, restLength = l - ROOT_BITS;
            for (let i = rest; i < 1 << bits; i += 1 << restLength) table[subOffset[root] + i] = s << 4 | l;
        }
    }

    return { table, single: -1 };
}

/** reads one symbol */
export function readSymbol(reader: BitReader, code: PrefixCode): number {
    if (code.single >= 0) return code.single;
    const bits = reader.peek();
    let entry = code.table[bits & (1 << ROOT_BITS) - 1];
    if (entry & SUBTABLE) {
        const offset = (entry & ~SUBTABLE) >> 4, sub = entry & 15;
        entry = code.table[offset + (bits >> ROOT_BITS & (1 << sub) - 1)];
    }
    reader.skip(entry & 15);
    return entry >> 4;
}

// RFC 9649 section 3.7.2.1: a prefix code is either "simple" (1-2 symbols) or "normal" (code length code)
function readCode(reader: BitReader, alphabetSize: number): PrefixCode {
    const lengths = new Uint8Array(alphabetSize);

    if (reader.read(1)) {
        const count = reader.read(1) + 1;
        const first = reader.read(reader.read(1) ? 8 : 1);
        if (first >= alphabetSize) throw new Error('VP8L: invalid simple prefix code');
        if (count === 1) return { table: new Int32Array(0), single: first };

        const second = reader.read(8);
        if (second >= alphabetSize) throw new Error('VP8L: invalid simple prefix code');
        lengths[first] = 1;
        lengths[second] = 1;
        if (first === second) return { table: new Int32Array(0), single: first };
        return buildCode(lengths, alphabetSize);
    }

    const codeLengthLengths = new Uint8Array(19);
    const count = reader.read(4) + 4;
    if (count > 19) throw new Error('VP8L: invalid code length code');
    for (let i = 0; i < count; i++) codeLengthLengths[CODE_LENGTH_ORDER[i]] = reader.read(3);
    const lengthCode = buildCode(codeLengthLengths, 19);

    let maxSymbol = alphabetSize;
    if (reader.read(1)) {
        const bits = 2 + 2 * reader.read(3);
        maxSymbol = 2 + reader.read(bits);
        if (maxSymbol > alphabetSize) throw new Error('VP8L: invalid max symbol');
    }

    let previous = 8;
    for (let symbol = 0; symbol < alphabetSize;) {
        if (maxSymbol-- === 0) break;
        const length = readSymbol(reader, lengthCode);

        if (length < 16) {
            lengths[symbol++] = length;
            if (length) previous = length;
            continue;
        }

        const repeat = length === 16 ? 3 + reader.read(2) : length === 17 ? 3 + reader.read(3) : 11 + reader.read(7);
        const value = length === 16 ? previous : 0;
        if (symbol + repeat > alphabetSize) throw new Error('VP8L: invalid code lengths');
        lengths.fill(value, symbol, symbol + repeat);
        symbol += repeat;
    }

    return buildCode(lengths, alphabetSize);
}

const subSize = (size: number, bits: number): number => (size + (1 << bits) - 1) >> bits;

// length and distance values: a prefix symbol plus extra bits (RFC 9649 section 3.6.1)
function prefixValue(reader: BitReader, symbol: number): number {
    if (symbol < 4) return symbol + 1;
    const extra = (symbol - 2) >> 1;
    const offset = (2 + (symbol & 1)) << extra;
    return offset + reader.read(extra) + 1;
}

/**
 * Decodes the pixels of an entropy coded image: the main image (with meta prefix codes) or a transform's sub-image
 */
function decodeImage(reader: BitReader, width: number, height: number, isMain: boolean): Uint32Array {
    let cacheBits = 0;
    if (reader.read(1)) {
        cacheBits = reader.read(4);
        if (cacheBits < 1 || cacheBits > 11) throw new Error('VP8L: invalid color cache size');
    }

    let prefixBits = 0, prefixWidth = 1, groupImage: Uint32Array | null = null, groupCount = 1;
    if (isMain && reader.read(1)) {
        prefixBits = reader.read(3) + 2;
        prefixWidth = subSize(width, prefixBits);
        groupImage = decodeImage(reader, prefixWidth, subSize(height, prefixBits), false);
        for (let i = 0; i < groupImage.length; i++) {
            const group = groupImage[i] >> 8 & 0xffff;
            groupImage[i] = group;
            if (group >= groupCount) groupCount = group + 1;
        }
    }

    const cacheSize = cacheBits ? 1 << cacheBits : 0;
    const greenSize = NUM_LITERAL_CODES + NUM_LENGTH_CODES + cacheSize;
    const groups: PrefixCode[][] = [];
    for (let g = 0; g < groupCount; g++)
        groups.push([
            readCode(reader, greenSize),
            readCode(reader, NUM_LITERAL_CODES),
            readCode(reader, NUM_LITERAL_CODES),
            readCode(reader, NUM_LITERAL_CODES),
            readCode(reader, NUM_DISTANCE_CODES)
        ]);

    const total = width * height;
    const pixels = new Uint32Array(total);
    const cache = cacheSize ? new Uint32Array(cacheSize) : null;
    const cacheShift = 32 - cacheBits;
    let cached = 0; // pixels before this index are in the cache already

    const prefixMask = (1 << prefixBits) - 1;
    let group = groups[0];

    for (let i = 0, x = 0, y = 0; i < total;) {
        if (groupImage && (x & prefixMask) === 0) group = groups[groupImage[(y >> prefixBits) * prefixWidth + (x >> prefixBits)]];

        const green = readSymbol(reader, group[0]);
        if (green < NUM_LITERAL_CODES) {
            const red = readSymbol(reader, group[1]);
            const blue = readSymbol(reader, group[2]);
            const alpha = readSymbol(reader, group[3]);
            pixels[i++] = (alpha << 24 | red << 16 | green << 8 | blue) >>> 0;
            if (++x === width) { x = 0; y++; }
        } else if (green < NUM_LITERAL_CODES + NUM_LENGTH_CODES) {
            const length = prefixValue(reader, green - NUM_LITERAL_CODES);
            const distanceSymbol = readSymbol(reader, group[4]);
            let distance = prefixValue(reader, distanceSymbol);
            if (distance > 120) distance -= 120;
            else {
                const dx = DISTANCE_MAP[2 * distance - 2], dy = DISTANCE_MAP[2 * distance - 1];
                distance = Math.max(1, dy * width + dx);
            }

            if (distance > i || i + length > total) throw new Error('VP8L: invalid backward reference');
            for (let k = 0; k < length; k++, i++) pixels[i] = pixels[i - distance];
            x += length;
            while (x >= width) { x -= width; y++; }
            // the prefix group can change within the copied run, it is looked up again at the next block start
            if (groupImage) group = groups[groupImage[(y >> prefixBits) * prefixWidth + (x >> prefixBits)]];
        } else {
            if (!cache) throw new Error('VP8L: invalid color cache symbol');
            // bring the cache up to date before looking anything up in it
            for (; cached < i; cached++) cache[Math.imul(pixels[cached], 0x1e35a7bd) >>> cacheShift] = pixels[cached];
            pixels[i++] = cache[green - NUM_LITERAL_CODES - NUM_LENGTH_CODES];
            if (++x === width) { x = 0; y++; }
        }

        if (reader.overrun) throw new Error('VP8L: unexpected end of data');
    }

    return pixels;
}

const average2 = (a: number, b: number): number => (((a ^ b) & 0xfefefefe) >>> 1) + (a & b) >>> 0;

// per channel (a + b - c) clamped to 0..255
const clamp255 = (v: number): number => v < 0 ? 0 : v > 255 ? 255 : v;

function clampAddSubtractFull(a: number, b: number, c: number): number {
    return (clamp255((a & 255) + (b & 255) - (c & 255))
        | clamp255((a >>> 8 & 255) + (b >>> 8 & 255) - (c >>> 8 & 255)) << 8
        | clamp255((a >>> 16 & 255) + (b >>> 16 & 255) - (c >>> 16 & 255)) << 16
        | clamp255((a >>> 24) + (b >>> 24) - (c >>> 24)) << 24) >>> 0;
}

// per channel a + (a - b) / 2 clamped to 0..255 (C division, truncating)
function clampAddSubtractHalf(a: number, b: number): number {
    const a0 = a & 255, a1 = a >>> 8 & 255, a2 = a >>> 16 & 255, a3 = a >>> 24;
    return (clamp255(a0 + ((a0 - (b & 255)) / 2 | 0))
        | clamp255(a1 + ((a1 - (b >>> 8 & 255)) / 2 | 0)) << 8
        | clamp255(a2 + ((a2 - (b >>> 16 & 255)) / 2 | 0)) << 16
        | clamp255(a3 + ((a3 - (b >>> 24)) / 2 | 0)) << 24) >>> 0;
}

function select(l: number, t: number, tl: number): number {
    const tl0 = tl & 255, tl1 = tl >>> 8 & 255, tl2 = tl >>> 16 & 255, tl3 = tl >>> 24;
    // distance of the estimate (l + t - tl) to l and to t
    const pl = Math.abs((t & 255) - tl0) + Math.abs((t >>> 8 & 255) - tl1) + Math.abs((t >>> 16 & 255) - tl2) + Math.abs((t >>> 24) - tl3);
    const pt = Math.abs((l & 255) - tl0) + Math.abs((l >>> 8 & 255) - tl1) + Math.abs((l >>> 16 & 255) - tl2) + Math.abs((l >>> 24) - tl3);
    return pl < pt ? l : t;
}

// adds two ARGB pixels per channel, modulo 256
const addPixels = (a: number, b: number): number => ((a & 0xff00ff00) + (b & 0xff00ff00) & 0xff00ff00 | (a & 0x00ff00ff) + (b & 0x00ff00ff) & 0x00ff00ff) >>> 0;

// predictions of `n` pixels from index i on (not in the first row or column) into out, from the pixels in p; with
// out === p, every pixel is the residual plus its prediction from the pixels already restored (decoding)
function predictRun(mode: number, p: Uint32Array, i: number, n: number, width: number, out: Uint32Array, o: number): void {
    const restore = out === p;
    const end = i + n;
    // the switch runs once per run instead of once per pixel
    switch (mode) {
        case 1: for (; i < end; i++, o++) out[o] = restore ? addPixels(p[i], p[i - 1]) : p[i - 1]; return;
        case 2: for (; i < end; i++, o++) out[o] = restore ? addPixels(p[i], p[i - width]) : p[i - width]; return;
        case 3: for (; i < end; i++, o++) out[o] = restore ? addPixels(p[i], p[i - width + 1]) : p[i - width + 1]; return;
        case 4: for (; i < end; i++, o++) out[o] = restore ? addPixels(p[i], p[i - width - 1]) : p[i - width - 1]; return;
        case 5: for (; i < end; i++, o++) { const v = average2(average2(p[i - 1], p[i - width + 1]), p[i - width]); out[o] = restore ? addPixels(p[i], v) : v; } return;
        case 6: for (; i < end; i++, o++) { const v = average2(p[i - 1], p[i - width - 1]); out[o] = restore ? addPixels(p[i], v) : v; } return;
        case 7: for (; i < end; i++, o++) { const v = average2(p[i - 1], p[i - width]); out[o] = restore ? addPixels(p[i], v) : v; } return;
        case 8: for (; i < end; i++, o++) { const v = average2(p[i - width - 1], p[i - width]); out[o] = restore ? addPixels(p[i], v) : v; } return;
        case 9: for (; i < end; i++, o++) { const v = average2(p[i - width], p[i - width + 1]); out[o] = restore ? addPixels(p[i], v) : v; } return;
        case 10: for (; i < end; i++, o++) { const v = average2(average2(p[i - 1], p[i - width - 1]), average2(p[i - width], p[i - width + 1])); out[o] = restore ? addPixels(p[i], v) : v; } return;
        case 11: for (; i < end; i++, o++) { const v = select(p[i - 1], p[i - width], p[i - width - 1]); out[o] = restore ? addPixels(p[i], v) : v; } return;
        case 12: for (; i < end; i++, o++) { const v = clampAddSubtractFull(p[i - 1], p[i - width], p[i - width - 1]); out[o] = restore ? addPixels(p[i], v) : v; } return;
        case 13: for (; i < end; i++, o++) { const v = clampAddSubtractHalf(average2(p[i - 1], p[i - width]), p[i - width - 1]); out[o] = restore ? addPixels(p[i], v) : v; } return;
        // mode 0, and modes 14 and 15 (not defined, libwebp predicts black like mode 0)
        default: for (; i < end; i++, o++) out[o] = restore ? addPixels(p[i], 0xff000000) : 0xff000000;
    }
}

function inversePredictor(p: Uint32Array, width: number, height: number, bits: number, modes: Uint32Array): void {
    const blocksPerRow = subSize(width, bits);

    // top left pixel: black, rest of the first row: left
    p[0] = addPixels(p[0], 0xff000000);
    for (let x = 1; x < width; x++) p[x] = addPixels(p[x], p[x - 1]);

    for (let y = 1; y < height; y++) {
        const row = y * width;
        // first column: top
        p[row] = addPixels(p[row], p[row - width]);
        const modeRow = (y >> bits) * blocksPerRow;
        for (let x = 1; x < width;) {
            const end = Math.min(width, (x >> bits) + 1 << bits);
            predictRun(modes[modeRow + (x >> bits)] >> 8 & 15, p, row + x, end - x, width, p, row + x);
            x = end;
        }
    }
}

// (t * c) >> 5 with both as signed 8 bit values
const colorDelta = (t: number, c: number): number => ((t << 24 >> 24) * (c << 24 >> 24)) >> 5;

function inverseColorTransform(p: Uint32Array, width: number, height: number, bits: number, elements: Uint32Array): void {
    const blocksPerRow = subSize(width, bits);
    for (let y = 0; y < height; y++) {
        const elementRow = (y >> bits) * blocksPerRow;
        for (let x = 0; x < width; x++) {
            const e = elements[elementRow + (x >> bits)];
            const greenToRed = e & 255, greenToBlue = e >> 8 & 255, redToBlue = e >> 16 & 255;
            const i = y * width + x, argb = p[i];
            const green = argb >> 8 & 255;
            const red = (argb >> 16) + colorDelta(greenToRed, green) & 255;
            const blue = (argb & 255) + colorDelta(greenToBlue, green) + colorDelta(redToBlue, red) & 255;
            p[i] = (argb & 0xff00ff00 | red << 16 | blue) >>> 0;
        }
    }
}

function addGreen(p: Uint32Array): void {
    for (let i = 0; i < p.length; i++) {
        const argb = p[i], green = argb >> 8 & 255;
        const redBlue = (argb & 0x00ff00ff) + (green << 16 | green) & 0x00ff00ff;
        p[i] = (argb & 0xff00ff00 | redBlue) >>> 0;
    }
}

function inverseColorIndexing(packed: Uint32Array, packedWidth: number, width: number, height: number, bits: number, palette: Uint32Array): Uint32Array {
    const out = new Uint32Array(width * height);
    const lookup = (index: number): number => index < palette.length ? palette[index] : 0;

    if (bits === 0) {
        for (let i = 0; i < out.length; i++) out[i] = lookup(packed[i] >> 8 & 255);
        return out;
    }

    const perByte = 1 << bits, bitsPerIndex = 8 >> bits, mask = (1 << bitsPerIndex) - 1;
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const green = packed[y * packedWidth + (x >> bits)] >> 8 & 255;
            out[y * width + x] = lookup(green >> (x & perByte - 1) * bitsPerIndex & mask);
        }

    return out;
}

interface TransformData {
    type: Transform;
    width: number;
    bits: number;
    data: Uint32Array;
}

/**
 * Reads the VP8L header (signature, dimensions)
 */
export function readHeader(data: Uint8Array): { width: number, height: number, hasAlpha: boolean } {
    if (data.length < 5 || data[0] !== SIGNATURE) throw new Error('VP8L: invalid signature');
    const reader = new BitReader(data, 1);
    const width = reader.read(14) + 1;
    const height = reader.read(14) + 1;
    const hasAlpha = reader.read(1) === 1;
    if (reader.read(3) !== 0) throw new Error('VP8L: unsupported version');
    return { width, height, hasAlpha };
}

/**
 * Decodes a VP8L bitstream (the payload of a VP8L chunk)
 */
export function decode(data: Uint8Array, maxPixels = MAX_PIXELS): VP8LImage {
    const { width, height, hasAlpha } = readHeader(data);
    checkPixels(width, height, maxPixels);
    const reader = new BitReader(data, 5);
    return { width, height, hasAlpha, argb: decodeStream(reader, width, height) };
}

/**
 * Decodes transforms and the main image from the bit reader (used by the ALPH chunk too, which has no header)
 */
export function decodeStream(reader: BitReader, width: number, height: number): Uint32Array {
    const transforms: TransformData[] = [];
    let codedWidth = width;
    const seen = new Set<Transform>();

    while (reader.read(1)) {
        const type: Transform = reader.read(2);
        if (seen.has(type)) throw new Error('VP8L: transform used twice');
        seen.add(type);

        if (type === Transform.PREDICTOR || type === Transform.COLOR) {
            const bits = reader.read(3) + 2;
            const data = decodeImage(reader, subSize(codedWidth, bits), subSize(height, bits), false);
            transforms.push({ type, width: codedWidth, bits, data });
        } else if (type === Transform.SUBTRACT_GREEN) {
            transforms.push({ type, width: codedWidth, bits: 0, data: new Uint32Array(0) });
        } else {
            const size = reader.read(8) + 1;
            const palette = decodeImage(reader, size, 1, false);
            // the palette is stored as differences to the previous entry
            for (let i = 1; i < size; i++) palette[i] = addPixels(palette[i], palette[i - 1]);
            const bits = size <= 2 ? 3 : size <= 4 ? 2 : size <= 16 ? 1 : 0;
            transforms.push({ type, width: codedWidth, bits, data: palette });
            codedWidth = subSize(codedWidth, bits);
        }
    }

    let pixels = decodeImage(reader, codedWidth, height, true);

    for (let t = transforms.length - 1; t >= 0; t--) {
        const { type, width: w, bits, data } = transforms[t];
        if (type === Transform.PREDICTOR) inversePredictor(pixels, w, height, bits, data);
        else if (type === Transform.COLOR) inverseColorTransform(pixels, w, height, bits, data);
        else if (type === Transform.SUBTRACT_GREEN) addGreen(pixels);
        else pixels = inverseColorIndexing(pixels, subSize(w, bits), w, height, bits, data);
    }

    return pixels;
}

// ---------------------------------------------------------------------------
// encoder
// ---------------------------------------------------------------------------

/**
 * LSB-first bit writer
 */
class BitWriter extends ByteWriter {
    private bits = 0;
    private count = 0;

    constructor() {
        super(1 << 16);
    }

    write(value: number, size: number): void {
        while (size > 0) {
            const take = Math.min(size, 24 - this.count);
            this.bits |= (value & (1 << take) - 1) << this.count;
            this.count += take;
            value >>>= take;
            size -= take;
            while (this.count >= 8) {
                this.byte(this.bits & 255);
                this.bits >>>= 8;
                this.count -= 8;
            }
        }
    }

    override finish(): Uint8Array {
        if (this.count > 0) this.write(0, 8 - this.count);
        return super.finish();
    }
}

/**
 * Huffman code lengths for the given symbol counts, limited to maxLength bits
 */
function codeLengths(counts: ArrayLike<number>, maxLength: number): Uint8Array {
    const size = counts.length;
    const lengths = new Uint8Array(size);
    let freq = Array.from(counts);

    for (; ;) {
        const used: number[] = [];
        for (let s = 0; s < size; s++) if (freq[s] > 0) used.push(s);
        if (used.length === 0) return lengths;
        if (used.length === 1) {
            lengths[used[0]] = 1;
            return lengths;
        }

        // two queue huffman construction over the sorted leaves
        used.sort((a, b) => freq[a] - freq[b] || a - b);
        const n = used.length;
        const weight = new Float64Array(2 * n), parent = new Int32Array(2 * n);
        for (let i = 0; i < n; i++) weight[i] = freq[used[i]];
        let leaf = 0, node = n, next = n;
        const pick = (): number => {
            if (leaf < n && (node >= next || weight[leaf] <= weight[node])) return leaf++;
            return node++;
        };
        for (; next < 2 * n - 1; next++) {
            const a = pick(), b = pick();
            weight[next] = weight[a] + weight[b];
            parent[a] = parent[b] = next;
        }

        let longest = 0;
        const depth = new Int32Array(2 * n);
        for (let i = 2 * n - 3; i >= 0; i--) depth[i] = depth[parent[i]] + 1;
        for (let i = 0; i < n; i++) {
            lengths[used[i]] = depth[i];
            if (depth[i] > longest) longest = depth[i];
        }
        if (longest <= maxLength) return lengths;

        // too deep: flatten the distribution and try again
        lengths.fill(0);
        freq = freq.map(f => f > 0 ? (f >> 1) + 1 : 0);
    }
}

/** canonical codes (LSB-first, i.e. bit-reversed) for the given lengths */
function canonicalCodes(lengths: Uint8Array): Uint16Array {
    const counts = new Int32Array(16), next = new Int32Array(16);
    for (const l of lengths) if (l) counts[l]++;
    let code = 0;
    for (let l = 1; l <= 15; l++) {
        code = code + counts[l - 1] << 1;
        next[l] = code;
    }
    const codes = new Uint16Array(lengths.length);
    for (let s = 0; s < lengths.length; s++) {
        const l = lengths[s];
        if (!l) continue;
        let c = next[l]++, r = 0;
        for (let i = 0; i < l; i++, c >>= 1) r = r << 1 | c & 1;
        codes[s] = r;
    }
    return codes;
}

interface Code {
    lengths: Uint8Array;
    codes: Uint16Array;
}

function buildEncodeCode(counts: ArrayLike<number>, maxLength = 15): Code {
    const lengths = codeLengths(counts, maxLength);
    return { lengths, codes: canonicalCodes(lengths) };
}

const writeSymbol = (w: BitWriter, code: Code, symbol: number): void => {
    const l = code.lengths[symbol];
    // a code with a single used symbol has length 1 here but is written as a zero bit code
    if (l && code.codes.length) w.write(code.codes[symbol], l);
};

/**
 * Writes a prefix code (RFC 9649 section 3.7.2.1) and returns the code to write symbols with
 */
function writeCode(w: BitWriter, counts: ArrayLike<number>): Code {
    const used: number[] = [];
    for (let s = 0; s < counts.length; s++) if (counts[s] > 0) used.push(s);

    // simple codes: up to two symbols below 256; a single symbol takes zero bits
    if (used.length <= 2 && used.every(s => s < 256)) {
        const symbols = used.length ? used : [0];
        w.write(1, 1);
        w.write(symbols.length - 1, 1);
        if (symbols[0] <= 1) {
            w.write(0, 1);
            w.write(symbols[0], 1);
        } else {
            w.write(1, 1);
            w.write(symbols[0], 8);
        }
        if (symbols.length === 2) w.write(symbols[1], 8);

        const lengths = new Uint8Array(counts.length);
        if (symbols.length === 1) return { lengths, codes: new Uint16Array(0) };
        lengths[symbols[0]] = lengths[symbols[1]] = 1;
        return { lengths, codes: canonicalCodes(lengths) };
    }

    // a single symbol >= 256 can't be a simple code, a normal code with one non-zero length takes zero bits per symbol
    // too (then the code length 1 it gets is only transmitted)
    const code = buildEncodeCode(counts);

    // run length encode the code lengths: 16 repeats the previous non-zero length, 17/18 are runs of zeros
    const tokens: number[] = [], extras: number[] = [];
    const lengths = code.lengths;
    let previous = 8;
    for (let i = 0; i < lengths.length;) {
        const l = lengths[i];
        let run = 1;
        while (i + run < lengths.length && lengths[i + run] === l) run++;

        if (l === 0) {
            let left = run;
            while (left > 0) {
                if (left < 3) { tokens.push(0); extras.push(0); left--; }
                else if (left <= 10) { tokens.push(17); extras.push(left - 3); left = 0; }
                else { const n = Math.min(left, 138); tokens.push(18); extras.push(n - 11); left -= n; }
            }
        } else {
            let left = run;
            if (l !== previous) { tokens.push(l); extras.push(0); left--; previous = l; }
            while (left > 0) {
                if (left < 3) { tokens.push(l); extras.push(0); left--; }
                else { const n = Math.min(left, 6); tokens.push(16); extras.push(n - 3); left -= n; }
            }
        }
        i += run;
    }

    const lengthCounts = new Int32Array(19);
    for (const t of tokens) lengthCounts[t]++;
    const lengthCode = buildEncodeCode(lengthCounts, 7);
    // the code length code needs two used symbols too, unless only one is used (then it takes zero bits)
    let lengthCodeLengths = lengthCode.lengths;
    if (lengthCodeLengths.filter(l => l).length === 1) {
        // a single code length symbol: give it a sibling so the code is complete
        lengthCodeLengths = lengthCodeLengths.slice();
        const only = lengthCodeLengths.findIndex(l => l !== 0);
        lengthCodeLengths[only] = 1;
        lengthCodeLengths[only === 0 ? 1 : 0] = 1;
    }
    const lengthCodes = canonicalCodes(lengthCodeLengths);

    let count = 19;
    while (count > 4 && lengthCodeLengths[CODE_LENGTH_ORDER[count - 1]] === 0) count--;
    w.write(0, 1); // normal code
    w.write(count - 4, 4);
    for (let i = 0; i < count; i++) w.write(lengthCodeLengths[CODE_LENGTH_ORDER[i]], 3);
    w.write(0, 1); // max_symbol: the whole alphabet

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        w.write(lengthCodes[t], lengthCodeLengths[t]);
        if (t === 16) w.write(extras[i], 2);
        else if (t === 17) w.write(extras[i], 3);
        else if (t === 18) w.write(extras[i], 7);
    }

    return used.length === 1 ? { lengths: code.lengths, codes: new Uint16Array(0) } : code;
}

// prefix symbol and extra bits of a length or distance value (>= 1)
function prefixEncode(value: number): { symbol: number, bits: number, extra: number } {
    const d = value - 1;
    if (d < 4) return { symbol: d, bits: 0, extra: 0 };
    const h = 31 - Math.clz32(d);
    const second = d >> h - 1 & 1;
    return { symbol: 2 * h + second, bits: h - 1, extra: d & (1 << h - 1) - 1 };
}

// encoded stream symbols: literals (argb), backward references, cache hits
const enum Op { LITERAL, COPY, CACHE }

interface Stream {
    ops: Uint8Array;
    values: Uint32Array; // argb, length, cache index
    distances: Uint32Array; // distance codes for copies
    count: number;
}

/**
 * Finds backward references (hash chains over pixel pairs; a match is put off by a pixel if the next one starts a
 * longer one)
 */
function tokenize(pixels: Uint32Array, width: number): Stream {
    const n = pixels.length;
    const ops = new Uint8Array(n), values = new Uint32Array(n), distances = new Uint32Array(n);
    let count = 0;

    // distance codes of the 120 short 2D distances for this width
    const shortCodes = new Map<number, number>();
    for (let c = 119; c >= 0; c--) {
        const d = DISTANCE_MAP[2 * c + 1] * width + DISTANCE_MAP[2 * c];
        if (d >= 1) shortCodes.set(d, c + 1);
    }
    const distanceCode = (d: number): number => shortCodes.get(d) ?? d + 120;

    // distances are coded with at most 20 bits (minus the 120 short codes)
    const HASH_BITS = 15, CHAIN = 24, MAX_LENGTH = 4096, MIN_LENGTH = 3, WINDOW = (1 << 20) - 120;
    const head = new Int32Array(1 << HASH_BITS).fill(-1);
    const chain = new Int32Array(n);
    // hashes of the pixel pairs starting at every index (but the last)
    const hashes = new Int32Array(n);
    for (let i = 0; i + 1 < n; i++) hashes[i] = Math.imul(Math.imul(pixels[i], 0x1e35a7bd) ^ pixels[i + 1], 0x9e3779b1) >>> 32 - HASH_BITS;
    let inserted = 0;
    const insertUpTo = (end: number): void => {
        for (; inserted < end && inserted + 1 < n; inserted++) {
            const h = hashes[inserted];
            chain[inserted] = head[h];
            head[h] = inserted;
        }
        if (inserted < end) inserted = end;
    };
    const matchLength = (i: number, j: number): number => {
        const max = Math.min(MAX_LENGTH, n - i);
        let l = 0;
        while (l < max && pixels[i + l] === pixels[j + l]) l++;
        return l;
    };
    // the longest match at i (of the chains' pixels before it): [length, distance]
    let bestLength = 0, bestDistance = 0;
    const find = (i: number): void => {
        bestLength = 0;
        bestDistance = 0;
        // the pixel to the left and the one above are the cheapest references
        if (i >= 1) {
            const l = matchLength(i, i - 1);
            if (l > bestLength) { bestLength = l; bestDistance = 1; }
        }
        if (width <= i) {
            const l = matchLength(i, i - width);
            if (l > bestLength) { bestLength = l; bestDistance = width; }
        }
        if (i + 1 < n && bestLength < MAX_LENGTH) {
            for (let j = head[hashes[i]], k = 0; j >= 0 && k < CHAIN && i - j <= WINDOW; j = chain[j], k++) {
                // the chain goes from near to far: a candidate no closer than the best one only wins by being
                // longer, which it can't be if it differs right after the best length
                if (i - j >= bestDistance && (i + bestLength >= n || pixels[j + bestLength] !== pixels[i + bestLength])) continue;
                const l = matchLength(i, j);
                // longer, or as long and closer
                if (l > bestLength || l === bestLength && l > 0 && i - j < bestDistance) { bestLength = l; bestDistance = i - j; }
                if (l === MAX_LENGTH) break;
            }
        }
    };

    for (let i = 0; i < n;) {
        insertUpTo(i);
        find(i);
        if (bestLength >= MIN_LENGTH && bestLength < MAX_LENGTH && i + 1 < n) {
            // (lazily: a literal first if the next pixel starts a match longer by more than one)
            const length = bestLength, distance = bestDistance;
            insertUpTo(i + 1);
            find(i + 1);
            if (bestLength > length + 1) {
                ops[count] = Op.LITERAL;
                values[count++] = pixels[i++];
                continue;
            }
            bestLength = length;
            bestDistance = distance;
        }
        if (bestLength >= MIN_LENGTH) {
            ops[count] = Op.COPY;
            values[count] = bestLength;
            distances[count++] = distanceCode(bestDistance);
            i += bestLength;
            continue;
        }
        ops[count] = Op.LITERAL;
        values[count++] = pixels[i++];
    }

    return { ops, values, distances, count };
}

// the stream with color cache hits instead of the literals that are in the cache (of every pixel before them)
function withCache(stream: Stream, pixels: Uint32Array, bits: number): Stream {
    if (!bits) return stream;
    const { ops, values, distances, count } = stream;
    const out = { ops: ops.slice(0, count), values: values.slice(0, count), distances, count };
    const cache = new Uint32Array(1 << bits), shift = 32 - bits;
    for (let k = 0, i = 0; k < count; k++) {
        if (ops[k] === Op.COPY) {
            for (const end = i + values[k]; i < end; i++) cache[Math.imul(pixels[i], 0x1e35a7bd) >>> shift] = pixels[i];
            continue;
        }
        const argb = pixels[i++], key = Math.imul(argb, 0x1e35a7bd) >>> shift;
        if (cache[key] === argb) {
            out.ops[k] = Op.CACHE;
            out.values[k] = key;
        }
        cache[key] = argb;
    }
    return out;
}

// the histograms of a stream's symbols (green with lengths and cache indices, red, blue, alpha, distances)
function histograms(stream: Stream, cacheBits: number): Int32Array[] {
    const greenSize = NUM_LITERAL_CODES + NUM_LENGTH_CODES + (cacheBits ? 1 << cacheBits : 0);
    const counts = [new Int32Array(greenSize), new Int32Array(256), new Int32Array(256), new Int32Array(256), new Int32Array(NUM_DISTANCE_CODES)];
    const { ops, values, distances, count } = stream;
    for (let k = 0; k < count; k++) {
        const v = values[k];
        if (ops[k] === Op.LITERAL) {
            counts[0][v >> 8 & 255]++;
            counts[1][v >> 16 & 255]++;
            counts[2][v & 255]++;
            counts[3][v >>> 24]++;
        } else if (ops[k] === Op.COPY) {
            counts[0][NUM_LITERAL_CODES + prefixEncode(v).symbol]++;
            counts[4][prefixEncode(distances[k]).symbol]++;
        } else counts[0][NUM_LITERAL_CODES + NUM_LENGTH_CODES + v]++;
    }
    return counts;
}

// the color cache size (0-10 bits) whose literals and hits are estimated to take the fewest bits: the caches of
// every size in one pass (the lengths and distances are the same for each)
function bestCacheBits(stream: Stream, pixels: Uint32Array): number {
    const { ops, values, count } = stream;
    const caches = Array.from({ length: 11 }, (_, b) => new Uint32Array(1 << b));
    const literals = Array.from({ length: 11 }, () => [0, 1, 2, 3].map(() => new Float64Array(256)));
    const hits = Array.from({ length: 11 }, (_, b) => new Float64Array(1 << b));
    for (let k = 0, i = 0; k < count; k++) {
        if (ops[k] === Op.COPY) {
            for (const end = i + values[k]; i < end; i++) {
                const p = pixels[i], h = Math.imul(p, 0x1e35a7bd);
                for (let b = 1; b <= 10; b++) caches[b][h >>> 32 - b] = p;
            }
            continue;
        }
        const p = pixels[i++], h = Math.imul(p, 0x1e35a7bd);
        // (no cache: every literal is one)
        const l0 = literals[0];
        l0[0][p >> 8 & 255]++;
        l0[1][p >> 16 & 255]++;
        l0[2][p & 255]++;
        l0[3][p >>> 24]++;
        for (let b = 1; b <= 10; b++) {
            const key = h >>> 32 - b, cache = caches[b];
            if (cache[key] === p) hits[b][key]++;
            else {
                const l = literals[b];
                l[0][p >> 8 & 255]++;
                l[1][p >> 16 & 255]++;
                l[2][p & 255]++;
                l[3][p >>> 24]++;
                cache[key] = p;
            }
        }
    }
    // (the green code also has the lengths: the same for each size, left out)
    const bitsOf = (h: ArrayLike<number>, total: number): number => {
        let bits = 0;
        for (let i = 0; i < h.length; i++) if (h[i]) bits += 5 - h[i] * Math.log2(h[i] / total);
        return bits;
    };
    let best = 0, bestBits = Infinity;
    for (let b = 0; b <= 10; b++) {
        const l = literals[b];
        let n = 0;
        for (let i = 0; i < 256; i++) n += l[0][i];
        let hitCount = 0;
        for (let i = 0; i < hits[b].length; i++) hitCount += hits[b][i];
        const green = n + hitCount;
        let bits = bitsOf(l[1], n) + bitsOf(l[2], n) + bitsOf(l[3], n);
        // (green: the literals' and the hits' symbols share a code)
        for (let i = 0; i < 256; i++) if (l[0][i]) bits += 5 - l[0][i] * Math.log2(l[0][i] / green);
        if (b) for (let i = 0; i < hits[b].length; i++) if (hits[b][i]) bits += 5 - hits[b][i] * Math.log2(hits[b][i] / green);
        if (bits < bestBits) {
            bestBits = bits;
            best = b;
        }
    }
    return best;
}

// the estimated bits of histograms (their entropies, about 5 bits per symbol used for the codes)
function entropyBits(counts: Int32Array[]): number {
    let bits = 0;
    for (const c of counts) {
        let total = 0;
        for (let i = 0; i < c.length; i++) total += c[i];
        for (let i = 0; i < c.length; i++) if (c[i]) bits += 5 - c[i] * Math.log2(c[i] / total);
    }
    return bits;
}

// the symbols of a token (green with lengths and cache indices, red, blue, alpha, distance; -1: none)
function tokenSymbols(stream: Stream, k: number, out: Int32Array): void {
    const v = stream.values[k], op = stream.ops[k];
    out[1] = out[2] = out[3] = out[4] = -1;
    if (op === Op.LITERAL) {
        out[0] = v >> 8 & 255;
        out[1] = v >> 16 & 255;
        out[2] = v & 255;
        out[3] = v >>> 24;
    } else if (op === Op.COPY) {
        out[0] = NUM_LITERAL_CODES + prefixEncode(v).symbol;
        out[4] = prefixEncode(stream.distances[k]).symbol;
    } else out[0] = NUM_LITERAL_CODES + NUM_LENGTH_CODES + v;
}

/**
 * The prefix groups of an image's blocks (2^bits pixels square), clustered by their symbols (k-means by the bits the
 * clusters' codes would take, from the blocks farthest apart); [groups of the blocks, their histograms], or null if a
 * single group is estimated to be no worse
 */
async function prefixGroups(stream: Stream, width: number, height: number, cacheBits: number, bits: number, threads: Thread[] | null): Promise<[Int32Array, Int32Array[][], number] | null> {
    const bw = subSize(width, bits), bh = subSize(height, bits), nb = bw * bh;
    const greenSize = NUM_LITERAL_CODES + NUM_LENGTH_CODES + (cacheBits ? 1 << cacheBits : 0);
    const sizes = [greenSize, 256, 256, 256, NUM_DISTANCE_CODES], offsets = [0, greenSize, greenSize + 256, greenSize + 512, greenSize + 768];
    const total = greenSize + 768 + NUM_DISTANCE_CODES;
    // each block's histogram (sparse: symbol, count; of green, red, blue, alpha, distances one after the other): the
    // symbols keyed by block and sorted
    const syms = new Int32Array(5), keys: number[] = [];
    for (let k = 0, i = 0; k < stream.count; k++) {
        const x = i % width, y = (i / width) | 0, blk = (y >> bits) * bw + (x >> bits);
        tokenSymbols(stream, k, syms);
        for (let c = 0; c < 5; c++) if (syms[c] >= 0) keys.push(blk * total + offsets[c] + syms[c]);
        i += stream.ops[k] === Op.COPY ? stream.values[k] : 1;
    }
    const sorted = Int32Array.from(keys).sort();
    const starts = new Int32Array(nb + 1), sparse: number[] = [];
    let blk = 0;
    for (let e = 0; e < sorted.length;) {
        const key = sorted[e], b = Math.floor(key / total);
        while (blk < b) starts[++blk] = sparse.length;
        let n = 0;
        while (e < sorted.length && sorted[e] === key) {
            n++;
            e++;
        }
        sparse.push(key - b * total, n);
    }
    // (the last block with symbols and those after it end here)
    while (blk < nb) starts[++blk] = sparse.length;
    // (the blocks' histograms in shared memory, for threads)
    const array = <T>(Type: new (buffer: ArrayBufferLike) => T, bytes: number, length: number): T =>
        new Type(threads ? new SharedArrayBuffer(bytes * length) : new ArrayBuffer(bytes * length));
    const entries = array(Float64Array, 8, sparse.length);
    entries.set(sparse);
    const sharedStarts = threads ? shared(starts) : starts;
    // the bits of a block coded with a cluster's (smoothed) probabilities
    const logs = (cl: Float64Array): Float64Array => {
        const t = totals(cl), out = new Float64Array(total);
        for (let c = 0; c < 5; c++) {
            const o = offsets[c], d = t[c] + 0.5 * sizes[c];
            for (let s = 0; s < sizes[c]; s++) out[o + s] = -Math.log2((cl[o + s] + 0.5) / d);
        }
        return out;
    };
    const totals = (cl: Float64Array): Float64Array => Float64Array.from(offsets, (o, c) => {
        let t = 0;
        for (let s = 0; s < sizes[c]; s++) t += cl[o + s];
        return t;
    });
    // a cluster's entropy and the bits of its codes (about 5 per symbol used)
    const clusterBits = (cl: Float64Array): number => {
        let b = 0;
        const t = totals(cl);
        for (let c = 0; c < 5; c++) {
            for (let s = 0; s < sizes[c]; s++) {
                const n = cl[offsets[c] + s];
                if (n) b += 5 - n * Math.log2(n / t[c]);
            }
        }
        return b;
    };
    const used = Int32Array.from(Array.from({ length: nb }, (_, i) => i).filter(i => starts[i + 1] > starts[i]));
    const sharedUsed = threads ? shared(used) : used;
    // the bits of the used blocks with a cluster's probabilities, or the nearest cluster of each (see costChunks)
    const costs = array(Float64Array, 8, used.length), nearest = array(Int32Array, 4, used.length);
    const blockCosts = async (logs: Float64Array[]): Promise<void> => {
        const task: CostTask = { task: 'vp8l-costs', entries, starts: sharedStarts, used: sharedUsed, logs, costs, nearest };
        await runChunks(threads, task, Math.ceil(used.length / COST_BLOCKS), costChunks(task));
    };
    const single = new Float64Array(total);
    for (const blk of used) for (let e = starts[blk]; e < starts[blk + 1]; e += 2) single[entries[e]] += entries[e + 1];
    let bestBits = clusterBits(single), best: [Int32Array, Float64Array[]] | null = null;
    const assign = new Int32Array(nb);
    for (const k of [4, 8, 16]) {
        if (k > used.length) break;
        // (the farthest-first centers)
        const blockHistogram = (blk: number): Float64Array => {
            const h = new Float64Array(total);
            for (let e = starts[blk]; e < starts[blk + 1]; e += 2) h[entries[e]] = entries[e + 1];
            return h;
        };
        const centers: Float64Array[] = [blockHistogram(used[0])];
        const dist = new Float64Array(nb).fill(Infinity);
        while (centers.length < k) {
            await blockCosts([logs(centers[centers.length - 1])]);
            let far = -1;
            for (let u = 0; u < used.length; u++) {
                const blk = used[u];
                dist[blk] = Math.min(dist[blk], costs[u]);
                if (far < 0 || dist[blk] > dist[far]) far = blk;
            }
            centers.push(blockHistogram(far));
        }
        let clusters = centers;
        for (let iter = 0; iter < 3; iter++) {
            await blockCosts(clusters.map(logs));
            for (let u = 0; u < used.length; u++) assign[used[u]] = nearest[u];
            clusters = clusters.map(() => new Float64Array(total));
            for (const blk of used) {
                const cl = clusters[assign[blk]];
                for (let e = starts[blk]; e < starts[blk + 1]; e += 2) cl[entries[e]] += entries[e + 1];
            }
        }
        // (the groups used, renumbered; their entropy image about a bit per block)
        const remap = new Int32Array(k).fill(-1), kept: Float64Array[] = [];
        for (const blk of used) if (remap[assign[blk]] < 0) { remap[assign[blk]] = kept.length; kept.push(clusters[assign[blk]]); }
        const groups = new Int32Array(nb);
        for (const blk of used) groups[blk] = remap[assign[blk]];
        const b = kept.reduce((sum, cl) => sum + clusterBits(cl), 0) + nb;
        if (b < bestBits) {
            bestBits = b;
            best = [groups, kept];
        } else break;
    }
    if (!best) return null;
    const [groups, kept] = best;
    return [groups, kept.map(cl => sizes.map((size, c) => Int32Array.from(cl.subarray(offsets[c], offsets[c] + size)))), bestBits];
}

// (the used blocks of a chunk of the clusters' costs)
const COST_BLOCKS = 1024;

/** The bits of blocks with clusters' probabilities (see prefixGroups) */
export interface CostTask extends ChunkTask {
    /** the blocks' sparse histograms (symbol, count), each from starts[block] to starts[block + 1] */
    entries: Float64Array;
    starts: Int32Array;
    used: Int32Array;
    /** the clusters' bits per symbol */
    logs: Float64Array[];
    // the results: with one cluster each used block's bits, else its nearest cluster
    costs: Float64Array;
    nearest: Int32Array;
}

/** The costs of COST_BLOCKS used blocks (the chunk) */
export function costChunks({ entries, starts, used, logs, costs, nearest }: CostTask): (chunk: number) => void {
    const cost = (blk: number, log: Float64Array): number => {
        let bitsSum = 0;
        for (let e = starts[blk]; e < starts[blk + 1]; e += 2) bitsSum += entries[e + 1] * log[entries[e]];
        return bitsSum;
    };
    return chunk => {
        for (let u = chunk * COST_BLOCKS; u < Math.min(used.length, (chunk + 1) * COST_BLOCKS); u++) {
            const blk = used[u];
            if (logs.length === 1) {
                costs[u] = cost(blk, logs[0]);
                continue;
            }
            let bc = 0, bv = Infinity;
            for (let j = 0; j < logs.length; j++) {
                const v = cost(blk, logs[j]);
                if (v < bv) { bv = v; bc = j; }
            }
            nearest[u] = bc;
        }
    };
}

/**
 * Writes an entropy coded image (main image with prefix groups per block, or a transform's sub-image with one): with
 * the color cache size (none, or 1-10 bits) and groups whose symbols are estimated to take the fewest bits
 */
async function writeImage(w: BitWriter, pixels: Uint32Array, width: number, isMain: boolean, threads: Thread[] | null = null): Promise<void> {
    const tokens = tokenize(pixels, width);
    const cacheBits = isMain ? bestCacheBits(tokens, pixels) : 0;
    const stream = withCache(tokens, pixels, cacheBits), counts = histograms(stream, cacheBits);
    const best = entropyBits(counts);
    const height = pixels.length / width;
    // (the groups of blocks of 16 pixels)
    let groups: Int32Array | null = null, groupCounts: Int32Array[][] = [counts], prefixBits = 0;
    if (isMain && pixels.length > 4096) {
        const r = await prefixGroups(stream, width, height, cacheBits, 4, threads);
        if (r && r[2] < best) {
            [groups, groupCounts] = r;
            prefixBits = 4;
        }
    }

    if (cacheBits) {
        w.write(1, 1);
        w.write(cacheBits, 4);
    } else w.write(0, 1);
    if (isMain) {
        // (the groups: an image of their indices in red and green)
        w.write(groups ? 1 : 0, 1);
        if (groups) {
            w.write(prefixBits - 2, 3);
            await writeImage(w, Uint32Array.from(groups, g => g << 8), subSize(width, prefixBits), false);
        }
    }

    const { ops, values, distances, count } = stream;
    const codes = groupCounts.map(g => g.map(c => writeCode(w, c)));
    const bw = subSize(width, prefixBits);
    let group = codes[0];
    for (let k = 0, i = 0; k < count; k++) {
        if (groups) {
            const x = i % width, y = (i / width) | 0;
            group = codes[groups[(y >> prefixBits) * bw + (x >> prefixBits)]];
        }
        const v = values[k];
        if (ops[k] === Op.LITERAL) {
            writeSymbol(w, group[0], v >> 8 & 255);
            writeSymbol(w, group[1], v >> 16 & 255);
            writeSymbol(w, group[2], v & 255);
            writeSymbol(w, group[3], v >>> 24);
            i++;
        } else if (ops[k] === Op.COPY) {
            const length = prefixEncode(v), distance = prefixEncode(distances[k]);
            writeSymbol(w, group[0], NUM_LITERAL_CODES + length.symbol);
            w.write(length.extra, length.bits);
            writeSymbol(w, group[4], distance.symbol);
            w.write(distance.extra, distance.bits);
            i += v;
        } else {
            writeSymbol(w, group[0], NUM_LITERAL_CODES + NUM_LENGTH_CODES + v);
            i++;
        }
    }
}

// subtracts two ARGB pixels per channel, modulo 256
const subPixels = (a: number, b: number): number => ((a | 0x00ff00ff) - (b & 0xff00ff00) & 0xff00ff00 | (a | 0xff00ff00) - (b & 0x00ff00ff) & 0x00ff00ff) >>> 0;

// distance of a residual byte to zero (as a signed byte)
const BYTE_COST = Uint8Array.from({ length: 256 }, (_, c) => c < 128 ? c : 256 - c);

// cost estimate of a residual: sum of the channels' distances to zero
const residualCost = (r: number): number => BYTE_COST[r & 255] + BYTE_COST[r >>> 8 & 255] + BYTE_COST[r >>> 16 & 255] + BYTE_COST[r >>> 24];

/**
 * libwebp's entropy analysis (AnalyzeEntropy): which of the pixels and their differences to the pixel left of them,
 * each with green subtracted from red and blue or not, take the fewest bits (the predictor with the cost of its
 * sub-image of 2^bits blocks); pixels repeating the left or upper one are left out, backward references take them
 */
function analyze(argb: Uint32Array, width: number, height: number, bits: number): { predict: boolean, subtractGreen: boolean } {
    // the histograms: alpha, red, green, blue of the pixels (0-3) and of the differences (4-7), red and blue less green
    // of the pixels (8, 9) and of the differences (10, 11)
    const h = Array.from({ length: 12 }, () => new Uint32Array(256));
    let prev = argb[0];
    for (let i = 0; i < argb.length; i++) {
        const p = argb[i], d = subPixels(p, prev);
        prev = p;
        if (d === 0 || (i >= width && p === argb[i - width])) continue;
        h[0][p >>> 24]++;
        h[1][p >> 16 & 255]++;
        h[2][p >> 8 & 255]++;
        h[3][p & 255]++;
        h[4][d >>> 24]++;
        h[5][d >> 16 & 255]++;
        h[6][d >> 8 & 255]++;
        h[7][d & 255]++;
        h[8][(p >> 16) - (p >> 8) & 255]++;
        h[9][p - (p >> 8) & 255]++;
        h[10][(d >> 16) - (d >> 8) & 255]++;
        h[11][d - (d >> 8) & 255]++;
    }
    // (one zero for the differences: comparing with 0 removes them too well)
    for (const k of [4, 5, 6, 7, 10, 11]) h[k][0]++;
    const bitsOf = (counts: Uint32Array): number => {
        let total = 0, sum = 0;
        for (const n of counts) total += n;
        for (const n of counts) if (n) sum += n * Math.log2(total / n);
        return sum;
    };
    const e = h.map(bitsOf), blocks = subSize(width, bits) * subSize(height, bits);
    const entropy = [
        e[0] + e[1] + e[2] + e[3], e[4] + e[5] + e[6] + e[7] + blocks * Math.log2(14),
        e[0] + e[8] + e[2] + e[9], e[4] + e[10] + e[6] + e[11] + blocks * Math.log2(24),
    ];
    const best = entropy.indexOf(Math.min(...entropy));
    return { predict: best === 1 || best === 3, subtractGreen: best >= 2 };
}

/**
 * Picks a predictor per block and replaces the pixels with their residuals
 * @return the sub-image of modes
 */
async function applyPredictor(p: Uint32Array, width: number, height: number, bits: number, threads: Thread[] | null): Promise<Uint32Array> {
    const blocksX = subSize(width, bits), blocksY = subSize(height, bits);
    // predictions use the original pixels, so modes are chosen and residuals computed on a copy (in shared memory with
    // p, for threads)
    const task: PredictorTask = {
        task: 'vp8l-predictor', p, src: threads ? shared(p) : p.slice(), width, height, bits,
        modes: new Uint32Array(threads ? new SharedArrayBuffer(4 * blocksX * blocksY) : new ArrayBuffer(4 * blocksX * blocksY)),
    };
    await runChunks(threads, task, Math.ceil(blocksY / PREDICTOR_ROWS), predictorChunks(task));
    return task.modes;
}

// (the rows of blocks of a chunk of the predictor search)
const PREDICTOR_ROWS = 4;

/** The predictor search of rows of blocks (see applyPredictor) */
export interface PredictorTask extends ChunkTask {
    p: Uint32Array;
    src: Uint32Array;
    modes: Uint32Array;
    width: number;
    height: number;
    bits: number;
}

/** The predictors of PREDICTOR_ROWS rows of blocks (the chunk), the residuals of their pixels */
export function predictorChunks({ p, src, modes, width, height, bits }: PredictorTask): (chunk: number) => void {
    const blocksX = subSize(width, bits), blocksY = subSize(height, bits), size = 1 << bits;
    // (a block's rows are predicted into `predicted`: the first row from the left, the first column from the top,
    // whatever the mode)
    const predicted = new Uint32Array(size);
    const predictRow = (mode: number, x0: number, x1: number, y: number): void => {
        const row = y * width;
        if (y === 0) {
            for (let x = x0; x < x1; x++) predicted[x - x0] = x === 0 ? 0xff000000 : src[row + x - 1];
            return;
        }
        let x = x0;
        if (x === 0) predicted[x++] = src[row - width];
        predictRun(mode, src, row + x, x1 - x, width, predicted, x - x0);
    };
    return chunk => {
        for (let by = chunk * PREDICTOR_ROWS; by < Math.min(blocksY, (chunk + 1) * PREDICTOR_ROWS); by++)
            for (let bx = 0; bx < blocksX; bx++) {
                let best = 0, bestCost = Infinity;
                const x0 = bx * size, y0 = by * size, x1 = Math.min(width, x0 + size), y1 = Math.min(height, y0 + size);
                for (let mode = 0; mode < 14; mode++) {
                    let cost = 0;
                    for (let y = y0; y < y1 && cost < bestCost; y++) {
                        predictRow(mode, x0, x1, y);
                        for (let x = x0, i = y * width + x0; x < x1; x++, i++) cost += residualCost(subPixels(src[i], predicted[x - x0]));
                    }
                    if (cost < bestCost) { bestCost = cost; best = mode; }
                }
                modes[by * blocksX + bx] = (0xff000000 | best << 8) >>> 0;
                for (let y = y0; y < y1; y++) {
                    predictRow(best, x0, x1, y);
                    for (let x = x0, i = y * width + x0; x < x1; x++, i++) p[i] = subPixels(src[i], predicted[x - x0]);
                }
            }
    };
}

/**
 * Encodes ARGB pixels into a VP8L bitstream (the payload of a VP8L chunk): with a palette for up to 256 colors, unless
 * predicting them compresses better (smooth gradients, like alpha)
 */
export async function encode(argb: Uint32Array, width: number, height: number, threads: Thread[] | null = null): Promise<Uint8Array> {
    if (width < 1 || height < 1 || width > 16384 || height > 16384) throw new RangeError('VP8L: dimensions must be 1-16384');
    const colors = new Map<number, number>();
    for (let i = 0; i < argb.length && colors.size <= 256; i++) if (!colors.has(argb[i])) colors.set(argb[i], colors.size);
    if (colors.size > 256) return encodeWith(argb, width, height, null, threads);
    const indexed = await encodeWith(argb, width, height, colors, threads);
    // (few colors: their packed indices win)
    if (colors.size <= 16) return indexed;
    const predicted = await encodeWith(argb, width, height, null, threads);
    return predicted.length < indexed.length ? predicted : indexed;
}

// the bitstream with a palette (the colors' indices) or with the green subtracted and predicted (the predictors and
// prefix groups searched in threads, if there are)
async function encodeWith(argb: Uint32Array, width: number, height: number, colors: Map<number, number> | null, threads: Thread[] | null): Promise<Uint8Array> {
    const w = new BitWriter();
    let hasAlpha = false;
    for (let i = 0; i < argb.length; i++) if (argb[i] >>> 24 !== 255) { hasAlpha = true; break; }

    w.write(SIGNATURE, 8);
    w.write(width - 1, 14);
    w.write(height - 1, 14);
    w.write(hasAlpha ? 1 : 0, 1);
    w.write(0, 3);

    let pixels: Uint32Array, codedWidth = width;
    if (colors) {
        // (a palette, with several pixels packed per byte for up to 16 colors; sorted palettes delta-code better)
        const palette = Uint32Array.from([...colors.keys()].sort((a, b) => a - b));
        palette.forEach((c, i) => colors.set(c, i));
        const bits = palette.length <= 2 ? 3 : palette.length <= 4 ? 2 : palette.length <= 16 ? 1 : 0;
        w.write(1, 1);
        w.write(Transform.COLOR_INDEXING, 2);
        w.write(palette.length - 1, 8);
        const deltas = palette.slice();
        for (let i = palette.length - 1; i > 0; i--) deltas[i] = subPixels(palette[i], palette[i - 1]);
        await writeImage(w, deltas, palette.length, false);

        codedWidth = subSize(width, bits);
        pixels = new Uint32Array(codedWidth * height);
        const perPixel = 8 >> bits;
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                const o = y * codedWidth + (x >> bits);
                pixels[o] = (pixels[o] | 0xff000000 | (colors.get(argb[y * width + x]) as number) << 8 + (x & (1 << bits) - 1) * perPixel) >>> 0;
            }
    } else {
        pixels = threads ? shared(argb) : argb.slice();
        // (subtracting green: not if red and blue are zero, like alpha planes', it would copy green into them)
        let redBlue = false;
        for (let i = 0; i < pixels.length && !redBlue; i++) if (pixels[i] & 0x00ff00ff) redBlue = true;
        // (and the predictor and subtracting green only where they're estimated to pay off: graphics with flat areas
        // and repeated parts compress better without the predictor)
        const { predict, subtractGreen } = analyze(argb, width, height, 4);
        if (redBlue && subtractGreen) {
            w.write(1, 1);
            w.write(Transform.SUBTRACT_GREEN, 2);
            for (let i = 0; i < pixels.length; i++) {
                const p = pixels[i], green = p >> 8 & 255;
                // the set bits between red and blue absorb blue's borrow
                pixels[i] = (p & 0xff00ff00 | (p | 0x0000ff00) - (green << 16 | green) & 0x00ff00ff) >>> 0;
            }
        }

        const bits = 4;
        if (predict) {
            w.write(1, 1);
            w.write(Transform.PREDICTOR, 2);
            w.write(bits - 2, 3);
            const modes = await applyPredictor(pixels, width, height, bits, threads);
            await writeImage(w, modes, subSize(width, bits), false);
        }
    }

    w.write(0, 1); // no more transforms
    await writeImage(w, pixels, codedWidth, true, threads);
    return w.finish();
}
