import { ByteWriter } from '../util/bytes.ts';
import { quantize } from './quantize.ts';
import { MAX_PIXELS, PixelBudget, checkPixels } from '../util/limits.ts';

// ImageScript disposal modes (any, keep, previous, background) <-> GIF disposal methods (unspecified, none, background, previous)
const DISPOSAL_TO_GIF = [0, 1, 3, 2];
const DISPOSAL_FROM_GIF = [0, 1, 3, 2, 0, 0, 0, 0];

const MAX_CODE = 4095;
const UNEXPECTED_END = new Error('GIF: unexpected end of data');

export interface GIFFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Frame delay in centiseconds */
    delay: number;
    /** ImageScript disposal mode (0 any, 1 keep, 2 previous, 3 background) */
    dispose: number;
    /** RGBA pixel data */
    pixels: Uint8Array;
}

export interface GIFData {
    width: number;
    height: number;
    /** -1 loops forever, 0 plays once, n repeats n times */
    loopCount: number;
    frames: GIFFrame[];
}

/** A decoded frame: color indices (in display order) and what they stand for */
export interface DecodedGIFFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Frame delay in centiseconds */
    delay: number;
    /** ImageScript disposal mode (0 any, 1 keep, 2 previous, 3 background) */
    dispose: number;
    indices: Uint8Array;
    /** RGBA of every index as a 32-bit word (indices past the color table are opaque black) */
    colors: Uint32Array;
    /** -1 if none */
    transparentIndex: number;
}

export interface DecodedGIF {
    width: number;
    height: number;
    loopCount: number;
    frames: DecodedGIFFrame[];
}

interface GraphicControl {
    dispose: number;
    delay: number;
    transparentIndex: number;
}

/**
 * Encodes frames into a GIF
 * @param {{width: number, height: number, loopCount?: number, frames: GIFFrame[]}} gif loopCount -1 loops forever, 0 plays once, n repeats n times
 * @param {number} [quality=95] 1-100, scales the palette size (1 = 8 colors, 50 = 55, 90 and above = 256)
 * @return {Uint8Array}
 */
/**
 * @param comments written as comment extensions
 */
export function encode({ width, height, loopCount = -1, frames }: Omit<GIFData, 'loopCount'> & { loopCount?: number }, quality = 95, comments: Uint8Array[] = []): Uint8Array {
    // frames that restore the background have a transparent index: decoders like Pillow and ffmpeg restore to it
    // (browsers to transparent), otherwise to the background color. So does the first frame then: Pillow decides by it
    // whether the animation has transparency at all
    const restores = frames.some(frame => frame.dispose === 3);
    const parts = [header(width, height, loopCount, comments)];
    for (const [i, frame] of frames.entries()) parts.push(encodeFrame(frame, quality, frame.dispose === 3 || (i === 0 && restores)));
    parts.push(new Uint8Array([0x3b]));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

/** A GIF's header: the screen descriptor, the loop count, comments */
export function header(width: number, height: number, loopCount: number, comments: Uint8Array[]): Uint8Array {
    const out = new GIFWriter();

    out.bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a
    out.u16(width);
    out.u16(height);
    out.bytes(0x00, 0x00, 0x00); // no global color table, background 0, no aspect ratio

    if (loopCount !== 0) {
        out.bytes(0x21, 0xff, 0x0b);
        out.string('NETSCAPE2.0');
        out.bytes(0x03, 0x01);
        out.u16(loopCount === -1 ? 0 : loopCount);
        out.bytes(0x00);
    }

    for (const comment of comments) {
        out.bytes(0x21, 0xfe);
        writeSubBlocks(out, comment);
    }
    return out.finish();
}

/** A frame (its graphic control extension, image descriptor, color table and pixels), with a transparent index if asked */
export function encodeFrame(frame: GIFFrame, quality: number, transparent: boolean): Uint8Array {
    const out = new GIFWriter();
    const { palette, indices, transparentIndex } = quantize(frame.pixels, frame.width, { quality, transparent });
    const entries = palette.length / 3;
    const bits = Math.max(1, Math.ceil(Math.log2(entries)));

    // graphic control extension
    out.bytes(0x21, 0xf9, 0x04);
    out.bytes(DISPOSAL_TO_GIF[frame.dispose] << 2 | (transparentIndex === -1 ? 0 : 1));
    out.u16(Math.min(0xffff, Math.max(0, Math.round(frame.delay))));
    out.bytes(transparentIndex === -1 ? 0 : transparentIndex, 0x00);

    // image descriptor with local color table
    out.bytes(0x2c);
    out.u16(frame.x);
    out.u16(frame.y);
    out.u16(frame.width);
    out.u16(frame.height);
    out.bytes(0x80 | bits - 1);

    const table = new Uint8Array(3 << bits);
    table.set(palette);
    out.array(table);

    const minCodeSize = Math.max(2, bits);
    out.bytes(minCodeSize);
    writeSubBlocks(out, lzwEncode(indices, minCodeSize));
    return out.finish();
}

function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
    const out = new GIFWriter(indices.length);
    const clear = 1 << minCodeSize;
    const eoi = clear + 1;

    // dictionary keyed by (prefix code << 8 | next index)
    const dictionary = new Int16Array(4096 * 256);

    let codeSize = 0, next = 0, buffer = 0, bufferBits = 0;
    const emit = (code: number): void => {
        buffer |= code << bufferBits;
        bufferBits += codeSize;
        while (bufferBits >= 8) {
            out.byte(buffer & 0xff);
            buffer >>>= 8;
            bufferBits -= 8;
        }
    };

    const reset = () => {
        dictionary.fill(0);
        codeSize = minCodeSize + 1;
        next = eoi + 1;
    };

    reset();
    emit(clear);
    if (!indices.length) {
        emit(eoi);
        if (bufferBits) out.byte(buffer & 0xff);
        return out.finish();
    }

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const index = indices[i];
        const key = prefix << 8 | index;
        const code = dictionary[key];

        if (code) {
            prefix = code;
            continue;
        }

        emit(prefix);

        if (next <= MAX_CODE) {
            dictionary[key] = next;
            if (next === 1 << codeSize && codeSize < 12) codeSize++;
            next++;
        } else {
            emit(clear);
            reset();
        }

        prefix = index;
    }

    emit(prefix);
    emit(eoi);
    if (bufferBits) out.byte(buffer & 0xff);

    return out.finish();
}

function writeSubBlocks(out: GIFWriter, data: Uint8Array): void {
    for (let i = 0; i < data.length; i += 255) {
        const block = data.subarray(i, i + 255);
        out.byte(block.length);
        out.array(block);
    }

    out.byte(0x00);
}

/**
 * Decodes a GIF into its individual (uncomposited) frames, zero-sized images are skipped
 * @param {Uint8Array} data
 * @param {boolean} [onlyFirstFrame=false]
 * @return {{width: number, height: number, loopCount: number, frames: GIFFrame[]}}
 */
export function decode(data: Uint8Array, onlyFirstFrame = false, maxPixels = MAX_PIXELS): DecodedGIF {
    const reader = new ByteReader(data);

    const signature = reader.string(6);
    if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('GIF: invalid signature');

    const width = reader.u16();
    const height = reader.u16();
    const flags = reader.u8();
    reader.skip(2); // background color index, aspect ratio

    const globalTable = flags & 0x80 ? reader.slice(3 << (flags & 7) + 1) : null;

    const frames: DecodedGIFFrame[] = [];
    let loopCount = 0;
    let control: GraphicControl | null = null;
    // the frames' color indices, and later a canvas per frame
    const budget = new PixelBudget(maxPixels);

    try {
        parse();
    } catch (err) {
        // truncated files keep every frame decoded so far, like browsers do
        if (err !== UNEXPECTED_END) throw err;
    }

    checkPixels(width, height, maxPixels, Math.max(1, frames.length));
    return { width, height, loopCount, frames };

    function parse(): void {
        while (reader.offset < data.length) {
            const block = reader.u8();

            if (block === 0x3b) break; // trailer

            if (block === 0x21) {
                const label = reader.u8();

                if (label === 0xf9) {
                    const size = reader.u8();
                    const packed = reader.u8();
                    control = {
                        dispose: DISPOSAL_FROM_GIF[packed >> 2 & 7],
                        delay: reader.u16(),
                        transparentIndex: packed & 1 ? reader.u8() : (reader.skip(1), -1)
                    };
                    reader.skip(size - 4);
                    skipSubBlocks(reader);
                } else if (label === 0xff) {
                    const size = reader.u8();
                    const id = reader.string(size);

                    if (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') {
                        // sub-block 1 holds the loop count
                        for (let length; (length = reader.u8());) {
                            const sub = reader.slice(length);
                            if (sub[0] === 1 && length >= 3) {
                                const count = sub[1] | sub[2] << 8;
                                loopCount = count === 0 ? -1 : count;
                            }
                        }
                    } else skipSubBlocks(reader);
                } else skipSubBlocks(reader);

                continue;
            }

            if (block !== 0x2c) {
                // unknown block, stop gracefully with whatever frames were decoded
                if (frames.length) break;
                throw new Error(`GIF: unknown block type 0x${block.toString(16)}`);
            }

            const x = reader.u16();
            const y = reader.u16();
            const fw = reader.u16();
            const fh = reader.u16();
            const descriptor = reader.u8();
            const localTable = descriptor & 0x80 ? reader.slice(3 << (descriptor & 7) + 1) : null;
            const interlaced = !!(descriptor & 0x40);
            const table = localTable || globalTable;

            const minCodeSize = reader.u8();
            const compressed = readSubBlocks(reader);
            budget.take(fw, fh);
            const indices = lzwDecode(compressed, minCodeSize, fw * fh);

            const { dispose = 0, delay = 0, transparentIndex = -1 } = control || {};
            control = null;
            if (!fw || !fh) continue;

            // the RGBA value of every index: indices past the color table are opaque black (the transparent one is
            // skipped when compositing)
            const colors = new Uint32Array(256), bytes = new Uint8Array(colors.buffer);
            for (let index = 0; index < 256; index++) {
                if (table && index * 3 + 2 < table.length) bytes.set(table.subarray(index * 3, index * 3 + 3), index * 4);
                bytes[index * 4 + 3] = 0xff;
            }

            let ordered = indices;
            if (interlaced) {
                const rows = interlacedRows(fh);
                ordered = new Uint8Array(indices.length);
                for (let row = 0; row < fh; row++) ordered.set(indices.subarray(row * fw, (row + 1) * fw), rows[row] * fw);
            }

            frames.push({ x, y, width: fw, height: fh, delay, dispose, indices: ordered, colors, transparentIndex });
            if (onlyFirstFrame) break;
        }
    }
}

/**
 * Composites decoded frames onto the logical screen, applying their disposal modes
 * @return full screen RGBA frames
 */
export function composite({ width, height, frames }: DecodedGIF): Array<{ pixels: Uint8Array, delay: number }> {
    const canvas = new Uint32Array(width * height);
    const output = [];

    for (const frame of frames) {
        const previous = frame.dispose === 2 ? canvas.slice() : null;
        const { indices, colors, transparentIndex } = frame;

        // clip the frame to the logical screen
        const x0 = Math.min(frame.x, width), x1 = Math.min(frame.x + frame.width, width);
        const y0 = Math.min(frame.y, height), y1 = Math.min(frame.y + frame.height, height);

        for (let y = y0; y < y1; y++) {
            const srcRow = (y - frame.y) * frame.width - frame.x;
            const dstRow = y * width;

            if (transparentIndex < 0) for (let x = x0; x < x1; x++) canvas[dstRow + x] = colors[indices[srcRow + x]];
            else for (let x = x0; x < x1; x++) {
                const index = indices[srcRow + x];
                if (index !== transparentIndex) canvas[dstRow + x] = colors[index];
            }
        }

        output.push({ pixels: new Uint8Array(canvas.slice().buffer), delay: frame.delay });

        if (frame.dispose === 3) {
            for (let y = y0; y < y1; y++) canvas.fill(0, y * width + x0, y * width + x1);
        } else if (previous) canvas.set(previous);
    }

    // a GIF without image data still describes a (transparent) canvas
    if (!output.length) output.push({ pixels: new Uint8Array(width * height * 4), delay: 0 });
    return output;
}

// maps the n-th stored row of an interlaced image to its actual row
function interlacedRows(height: number): number[] {
    const rows = [];
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]])
        for (let y = start; y < height; y += step) rows.push(y);
    return rows;
}

function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
    const output = new Uint8Array(pixelCount);
    if (minCodeSize < 1 || minCodeSize > 11) return output;

    const clear = 1 << minCodeSize;
    const eoi = clear + 1;

    // the string of a code is in the output already (where it was written, then the next code's first byte): codes
    // are stored as its position and length there, and decoded by copying (the codes below clear are single bytes)
    const positions = new Int32Array(4096);
    const lengths = new Uint16Array(4096).fill(1, 0, clear);

    let codeSize = minCodeSize + 1;
    let next = eoi + 1;
    let previous = -1, previousOut = 0;
    let buffer = 0, bufferBits = 0, position = 0, out = 0;

    while (out < pixelCount) {
        while (bufferBits < codeSize) {
            if (position >= data.length) return output; // truncated data, leave the remainder at index 0
            buffer |= data[position++] << bufferBits;
            bufferBits += 8;
        }

        const code = buffer & (1 << codeSize) - 1;
        buffer >>>= codeSize;
        bufferBits -= codeSize;

        if (code === clear) {
            codeSize = minCodeSize + 1;
            next = eoi + 1;
            previous = -1;
            continue;
        }

        if (code === eoi) break;
        if (code > next || (code === next && previous === -1)) break; // invalid code
        if (previous === -1 && code >= clear) break;

        const start = out;
        if (code < clear) output[out++] = code;
        else {
            // KwKwK: a code not in the table yet is the previous string and its first byte, which is the byte just
            // after it, about to be written (copyWithin would read it before)
            const kwk = code === next;
            const from = kwk ? previousOut : positions[code];
            const length = kwk ? lengths[previous] + 1 : lengths[code];
            // (a string running past the image: only its start is written)
            const count = Math.min(length, pixelCount - out) - (kwk ? 1 : 0);
            if (count < 16) for (let i = 0; i < count; i++) output[out + i] = output[from + i];
            else output.copyWithin(out, from, from + count);
            if (kwk && out + count < pixelCount) output[out + count] = output[from];
            out = Math.min(out + length, pixelCount);
        }

        if (previous !== -1 && next <= MAX_CODE) {
            positions[next] = previousOut;
            lengths[next] = lengths[previous] + 1;
            next++;
            if (next === 1 << codeSize && codeSize < 12) codeSize++;
        }

        previous = code;
        previousOut = start;
    }

    return output;
}

function readSubBlocks(reader: ByteReader): Uint8Array {
    const blocks = [];
    let total = 0;

    for (let length; reader.offset < reader.data.length && (length = reader.u8());) {
        const block = reader.slice(length);
        blocks.push(block);
        total += block.length;
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const block of blocks) {
        out.set(block, offset);
        offset += block.length;
    }

    return out;
}

function skipSubBlocks(reader: ByteReader): void {
    for (let length; reader.offset < reader.data.length && (length = reader.u8());) reader.skip(length);
}

class ByteReader {
    data: Uint8Array;
    offset: number;

    constructor(data: Uint8Array) {
        this.data = data;
        this.offset = 0;
    }

    u8() {
        if (this.offset >= this.data.length) throw UNEXPECTED_END;
        return this.data[this.offset++];
    }

    u16() {
        return this.u8() | this.u8() << 8;
    }

    skip(length: number): void {
        this.offset += length;
    }

    slice(length: number): Uint8Array {
        const slice = this.data.subarray(this.offset, this.offset + length);
        this.offset += length;
        return slice;
    }

    string(length: number): string {
        return String.fromCharCode(...this.slice(length));
    }
}

// GIF data: little endian 16-bit values and ASCII strings
class GIFWriter extends ByteWriter {
    u16(value: number): void {
        this.bytes(value & 0xff, value >> 8 & 0xff);
    }

    string(value: string): void {
        for (let i = 0; i < value.length; i++) this.byte(value.charCodeAt(i));
    }
}

