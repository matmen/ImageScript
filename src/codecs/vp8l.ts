/*!
 * WebP lossless (VP8L) bitstream, as specified in RFC 9649 ("WebP Image Format") section 3 onwards, including its
 * table of short distance codes. Copyright (c) 2024 IETF Trust and the persons identified as the document authors,
 * Revised BSD License (see THIRD_PARTY_NOTICES.md)
 */

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
function clampAddSubtractFull(a: number, b: number, c: number): number {
    let out = 0;
    for (let shift = 0; shift < 32; shift += 8) {
        const v = (a >>> shift & 255) + (b >>> shift & 255) - (c >>> shift & 255);
        out |= (v < 0 ? 0 : v > 255 ? 255 : v) << shift;
    }
    return out >>> 0;
}

// per channel a + (a - b) / 2 clamped to 0..255 (C division, truncating)
function clampAddSubtractHalf(a: number, b: number): number {
    let out = 0;
    for (let shift = 0; shift < 32; shift += 8) {
        const ac = a >>> shift & 255, d = ac - (b >>> shift & 255);
        const v = ac + (d / 2 | 0);
        out |= (v < 0 ? 0 : v > 255 ? 255 : v) << shift;
    }
    return out >>> 0;
}

function select(l: number, t: number, tl: number): number {
    let pl = 0, pt = 0;
    for (let shift = 0; shift < 32; shift += 8) {
        const lc = l >>> shift & 255, tc = t >>> shift & 255, tlc = tl >>> shift & 255;
        // distance of the estimate (l + t - tl) to l and to t
        pl += Math.abs(tc - tlc);
        pt += Math.abs(lc - tlc);
    }
    return pl < pt ? l : t;
}

// adds two ARGB pixels per channel, modulo 256
const addPixels = (a: number, b: number): number => ((a & 0xff00ff00) + (b & 0xff00ff00) & 0xff00ff00 | (a & 0x00ff00ff) + (b & 0x00ff00ff) & 0x00ff00ff) >>> 0;

function predict(mode: number, p: Uint32Array, i: number, width: number): number {
    const l = p[i - 1], t = p[i - width], tl = p[i - width - 1], tr = p[i - width + 1];
    switch (mode) {
        case 0: return 0xff000000;
        case 1: return l;
        case 2: return t;
        case 3: return tr;
        case 4: return tl;
        case 5: return average2(average2(l, tr), t);
        case 6: return average2(l, tl);
        case 7: return average2(l, t);
        case 8: return average2(tl, t);
        case 9: return average2(t, tr);
        case 10: return average2(average2(l, tl), average2(t, tr));
        case 11: return select(l, t, tl);
        case 12: return clampAddSubtractFull(l, t, tl);
        case 13: return clampAddSubtractHalf(average2(l, t), tl);
        default: return 0xff000000; // modes 14 and 15 aren't defined, libwebp predicts black like mode 0
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
        for (let x = 1; x < width; x++) {
            const mode = modes[modeRow + (x >> bits)] >> 8 & 15;
            const i = row + x;
            p[i] = addPixels(p[i], predict(mode, p, i, width));
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
export function decode(data: Uint8Array): VP8LImage {
    const { width, height, hasAlpha } = readHeader(data);
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
        const type = reader.read(2) as Transform;
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
class BitWriter {
    private bytes = new Uint8Array(1 << 16);
    private length = 0;
    private buffer = 0;
    private count = 0;

    write(value: number, bits: number): void {
        while (bits > 0) {
            const take = Math.min(bits, 24 - this.count);
            this.buffer |= (value & (1 << take) - 1) << this.count;
            this.count += take;
            value >>>= take;
            bits -= take;
            while (this.count >= 8) {
                if (this.length === this.bytes.length) {
                    const grown = new Uint8Array(this.bytes.length * 2);
                    grown.set(this.bytes);
                    this.bytes = grown;
                }
                this.bytes[this.length++] = this.buffer & 255;
                this.buffer >>>= 8;
                this.count -= 8;
            }
        }
    }

    finish(): Uint8Array {
        if (this.count > 0) this.write(0, 8 - this.count);
        return this.bytes.slice(0, this.length);
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

    const code = buildEncodeCode(counts);
    // a normal code needs at least two symbols with non-zero length, which is given here

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

    return code;
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
 * Finds backward references (greedy, hash chains over pixel pairs) and color cache hits
 */
function tokenize(pixels: Uint32Array, width: number, cacheBits: number): Stream {
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
    const hash = (i: number): number => Math.imul(Math.imul(pixels[i], 0x1e35a7bd) ^ pixels[i + 1], 0x9e3779b1) >>> 32 - HASH_BITS;
    const insert = (i: number): void => {
        if (i + 1 >= n) return;
        const h = hash(i);
        chain[i] = head[h];
        head[h] = i;
    };
    const matchLength = (i: number, j: number): number => {
        const max = Math.min(MAX_LENGTH, n - i);
        let l = 0;
        while (l < max && pixels[i + l] === pixels[j + l]) l++;
        return l;
    };

    const cache = cacheBits ? new Uint32Array(1 << cacheBits) : null;
    const cacheShift = 32 - cacheBits;
    let cached = 0;

    for (let i = 0; i < n;) {
        let bestLength = 0, bestDistance = 0;

        // the pixel to the left and the one above are the cheapest references
        for (const d of [1, width]) {
            if (d > i) continue;
            const l = matchLength(i, i - d);
            if (l > bestLength) { bestLength = l; bestDistance = d; }
        }
        if (i + 1 < n && bestLength < MAX_LENGTH) {
            for (let j = head[hash(i)], k = 0; j >= 0 && k < CHAIN && i - j <= WINDOW; j = chain[j], k++) {
                const l = matchLength(i, j);
                // longer, or as long and closer
                if (l > bestLength || l === bestLength && l > 0 && i - j < bestDistance) { bestLength = l; bestDistance = i - j; }
                if (l === MAX_LENGTH) break;
            }
        }

        if (bestLength >= MIN_LENGTH) {
            ops[count] = Op.COPY;
            values[count] = bestLength;
            distances[count++] = distanceCode(bestDistance);
            for (let k = 0; k < bestLength; k++) insert(i + k);
            i += bestLength;
            continue;
        }

        const argb = pixels[i];
        if (cache) {
            for (; cached < i; cached++) cache[Math.imul(pixels[cached], 0x1e35a7bd) >>> cacheShift] = pixels[cached];
            const key = Math.imul(argb, 0x1e35a7bd) >>> cacheShift;
            if (cache[key] === argb) {
                ops[count] = Op.CACHE;
                values[count++] = key;
                insert(i++);
                continue;
            }
        }
        ops[count] = Op.LITERAL;
        values[count++] = argb;
        insert(i++);
    }

    return { ops, values, distances, count };
}

/**
 * Writes an entropy coded image (main image with a single prefix group, or a transform's sub-image)
 */
function writeImage(w: BitWriter, pixels: Uint32Array, width: number, isMain: boolean): void {
    // the color cache pays off for photos, sub-images are tiny
    const cacheBits = isMain && pixels.length > 4096 ? 10 : 0;
    const stream = tokenize(pixels, width, cacheBits);

    if (cacheBits) {
        w.write(1, 1);
        w.write(cacheBits, 4);
    } else w.write(0, 1);
    if (isMain) w.write(0, 1); // no meta prefix codes

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

    const codes = counts.map(c => writeCode(w, c));
    for (let k = 0; k < count; k++) {
        const v = values[k];
        if (ops[k] === Op.LITERAL) {
            writeSymbol(w, codes[0], v >> 8 & 255);
            writeSymbol(w, codes[1], v >> 16 & 255);
            writeSymbol(w, codes[2], v & 255);
            writeSymbol(w, codes[3], v >>> 24);
        } else if (ops[k] === Op.COPY) {
            const length = prefixEncode(v), distance = prefixEncode(distances[k]);
            writeSymbol(w, codes[0], NUM_LITERAL_CODES + length.symbol);
            w.write(length.extra, length.bits);
            writeSymbol(w, codes[4], distance.symbol);
            w.write(distance.extra, distance.bits);
        } else writeSymbol(w, codes[0], NUM_LITERAL_CODES + NUM_LENGTH_CODES + v);
    }
}

// subtracts two ARGB pixels per channel, modulo 256
const subPixels = (a: number, b: number): number => ((a | 0x00ff00ff) - (b & 0xff00ff00) & 0xff00ff00 | (a | 0xff00ff00) - (b & 0x00ff00ff) & 0x00ff00ff) >>> 0;

// cost estimate of a residual: sum of the channels' distances to zero (as signed bytes)
function residualCost(r: number): number {
    let cost = 0;
    for (let shift = 0; shift < 32; shift += 8) {
        const c = r >>> shift & 255;
        cost += c < 128 ? c : 256 - c;
    }
    return cost;
}

/**
 * Picks a predictor per block and replaces the pixels with their residuals
 * @return the sub-image of modes
 */
function applyPredictor(p: Uint32Array, width: number, height: number, bits: number): Uint32Array {
    const blocksX = subSize(width, bits), blocksY = subSize(height, bits);
    const modes = new Uint32Array(blocksX * blocksY);
    const size = 1 << bits;

    // predictions use the original pixels, so modes are chosen and residuals computed on a copy
    const src = p.slice();
    const predictAt = (mode: number, i: number, x: number, y: number): number =>
        y === 0 ? (x === 0 ? 0xff000000 : src[i - 1]) : x === 0 ? src[i - width] : predict(mode, src, i, width);

    for (let by = 0; by < blocksY; by++)
        for (let bx = 0; bx < blocksX; bx++) {
            let best = 0, bestCost = Infinity;
            const x0 = bx * size, y0 = by * size, x1 = Math.min(width, x0 + size), y1 = Math.min(height, y0 + size);
            for (let mode = 0; mode < 14; mode++) {
                let cost = 0;
                for (let y = y0; y < y1 && cost < bestCost; y++)
                    for (let x = x0; x < x1; x++) {
                        const i = y * width + x;
                        cost += residualCost(subPixels(src[i], predictAt(mode, i, x, y)));
                    }
                if (cost < bestCost) { bestCost = cost; best = mode; }
            }
            modes[by * blocksX + bx] = (0xff000000 | best << 8) >>> 0;
            for (let y = y0; y < y1; y++)
                for (let x = x0; x < x1; x++) {
                    const i = y * width + x;
                    p[i] = subPixels(src[i], predictAt(best, i, x, y));
                }
        }

    return modes;
}

/**
 * Encodes ARGB pixels into a VP8L bitstream (the payload of a VP8L chunk)
 */
export function encode(argb: Uint32Array, width: number, height: number): Uint8Array {
    if (width < 1 || height < 1 || width > 16384 || height > 16384) throw new RangeError('VP8L: dimensions must be 1-16384');
    const w = new BitWriter();
    let hasAlpha = false;
    for (let i = 0; i < argb.length; i++) if (argb[i] >>> 24 !== 255) { hasAlpha = true; break; }

    w.write(SIGNATURE, 8);
    w.write(width - 1, 14);
    w.write(height - 1, 14);
    w.write(hasAlpha ? 1 : 0, 1);
    w.write(0, 3);

    // up to 256 colors: a palette, with several pixels packed per byte for up to 16 colors
    const colors = new Map<number, number>();
    for (let i = 0; i < argb.length && colors.size <= 256; i++) if (!colors.has(argb[i])) colors.set(argb[i], colors.size);

    let pixels: Uint32Array, codedWidth = width;
    if (colors.size <= 256) {
        // sorted palettes delta-code better
        const palette = Uint32Array.from([...colors.keys()].sort((a, b) => a - b));
        palette.forEach((c, i) => colors.set(c, i));
        const bits = palette.length <= 2 ? 3 : palette.length <= 4 ? 2 : palette.length <= 16 ? 1 : 0;

        w.write(1, 1);
        w.write(Transform.COLOR_INDEXING, 2);
        w.write(palette.length - 1, 8);
        const deltas = palette.slice();
        for (let i = palette.length - 1; i > 0; i--) deltas[i] = subPixels(palette[i], palette[i - 1]);
        writeImage(w, deltas, palette.length, false);

        codedWidth = subSize(width, bits);
        pixels = new Uint32Array(codedWidth * height);
        const perPixel = 8 >> bits;
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                const o = y * codedWidth + (x >> bits);
                pixels[o] = (pixels[o] | 0xff000000 | (colors.get(argb[y * width + x]) as number) << 8 + (x & (1 << bits) - 1) * perPixel) >>> 0;
            }
    } else {
        pixels = argb.slice();
        w.write(1, 1);
        w.write(Transform.SUBTRACT_GREEN, 2);
        for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i], green = p >> 8 & 255;
            // the set bits between red and blue absorb blue's borrow
            pixels[i] = (p & 0xff00ff00 | (p | 0x0000ff00) - (green << 16 | green) & 0x00ff00ff) >>> 0;
        }

        const bits = 4;
        w.write(1, 1);
        w.write(Transform.PREDICTOR, 2);
        w.write(bits - 2, 3);
        const modes = applyPredictor(pixels, width, height, bits);
        writeImage(w, modes, subSize(width, bits), false);
    }

    w.write(0, 1); // no more transforms
    writeImage(w, pixels, codedWidth, true);
    return w.finish();
}
