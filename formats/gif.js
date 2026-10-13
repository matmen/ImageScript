'use strict';
const { quantize } = require('./quantize.js');

// ImageScript disposal modes (any, keep, previous, background) <-> GIF disposal methods (unspecified, none, background, previous)
const DISPOSAL_TO_GIF = [0, 1, 3, 2];
const DISPOSAL_FROM_GIF = [0, 1, 3, 2, 0, 0, 0, 0];

const MAX_CODE = 4095;
const UNEXPECTED_END = new Error('GIF: unexpected end of data');

/**
 * @typedef {Object} GIFFrame
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} delay Frame delay in centiseconds
 * @property {number} dispose ImageScript disposal mode (0 any, 1 keep, 2 previous, 3 background)
 * @property {Uint8Array} pixels RGBA pixel data
 */

/**
 * Encodes frames into a GIF
 * @param {{width: number, height: number, loopCount?: number, frames: GIFFrame[]}} gif loopCount -1 loops forever, 0 plays once, n repeats n times
 * @param {number} [quality=95] 1-100, scales the palette size (1 = 8 colors, 50 = 55, 90 and above = 256)
 * @return {Uint8Array}
 */
function encode({ width, height, loopCount = -1, frames }, quality = 95) {
    const out = new ByteWriter();

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

    for (const frame of frames) {
        const { palette, indices, transparentIndex } = quantize(frame.pixels, frame.width, { quality });
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
    }

    out.bytes(0x3b);
    return out.finish();
}

function lzwEncode(indices, minCodeSize) {
    const out = new ByteWriter(indices.length);
    const clear = 1 << minCodeSize;
    const eoi = clear + 1;

    // dictionary keyed by (prefix code << 8 | next index)
    const dictionary = new Int16Array(4096 * 256);

    let codeSize, next, buffer = 0, bufferBits = 0;
    const emit = code => {
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

function writeSubBlocks(out, data) {
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
function decode(data, onlyFirstFrame = false) {
    const reader = new ByteReader(data);

    const signature = reader.string(6);
    if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('GIF: invalid signature');

    const width = reader.u16();
    const height = reader.u16();
    const flags = reader.u8();
    reader.skip(2); // background color index, aspect ratio

    const globalTable = flags & 0x80 ? reader.slice(3 << (flags & 7) + 1) : null;

    const frames = [];
    let loopCount = 0;
    let control = null;

    try {
        parse();
    } catch (err) {
        // truncated files keep every frame decoded so far, like browsers do
        if (err !== UNEXPECTED_END) throw err;
    }

    return { width, height, loopCount, frames };

    function parse() {
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
            const indices = lzwDecode(compressed, minCodeSize, fw * fh);

            const { dispose = 0, delay = 0, transparentIndex = -1 } = control || {};
            control = null;
            if (!fw || !fh) continue;

            const pixels = new Uint8Array(fw * fh * 4);
            const rows = interlaced ? interlacedRows(fh) : null;

            for (let row = 0; row < fh; row++) {
                const targetRow = rows ? rows[row] : row;

                for (let column = 0; column < fw; column++) {
                    const index = indices[row * fw + column];
                    if (index === transparentIndex) continue;

                    const o = (targetRow * fw + column) * 4;
                    if (table && index * 3 + 2 < table.length) {
                        pixels[o] = table[index * 3];
                        pixels[o + 1] = table[index * 3 + 1];
                        pixels[o + 2] = table[index * 3 + 2];
                    }
                    pixels[o + 3] = 0xff;
                }
            }

            frames.push({ x, y, width: fw, height: fh, delay, dispose, pixels });
            if (onlyFirstFrame) break;
        }
    }
}

// maps the n-th stored row of an interlaced image to its actual row
function interlacedRows(height) {
    const rows = [];
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]])
        for (let y = start; y < height; y += step) rows.push(y);
    return rows;
}

function lzwDecode(data, minCodeSize, pixelCount) {
    const output = new Uint8Array(pixelCount);
    if (minCodeSize < 1 || minCodeSize > 11) return output;

    const clear = 1 << minCodeSize;
    const eoi = clear + 1;

    // each code is stored as (prefix code, suffix byte, first byte, length)
    const prefix = new Uint16Array(4096);
    const suffix = new Uint8Array(4096);
    const first = new Uint8Array(4096);
    const lengths = new Uint16Array(4096);
    for (let i = 0; i < clear; i++) {
        suffix[i] = first[i] = i;
        lengths[i] = 1;
    }

    let codeSize = minCodeSize + 1;
    let next = eoi + 1;
    let previous = -1;
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

        let entry;
        if (code < next) entry = code;
        else if (code === next && previous !== -1) entry = previous;
        else break; // invalid code

        if (previous === -1 && code >= clear) break;

        // write the string for `entry`, backwards from its end
        const length = lengths[entry];
        const end = Math.min(out + length, pixelCount);
        let c = entry;
        for (let i = out + length - 1; i >= out; i--) {
            if (i < end) output[i] = suffix[c];
            c = prefix[c];
        }

        let written = end - out;
        if (code === next) {
            // KwKwK case: the new string is previous + first byte of previous
            if (out + length < pixelCount) {
                output[out + length] = first[previous];
                written++;
            }
        }
        out += written;

        if (previous !== -1 && next <= MAX_CODE) {
            prefix[next] = previous;
            suffix[next] = first[code === next ? previous : code];
            first[next] = first[previous];
            lengths[next] = lengths[previous] + 1;
            next++;
            if (next === 1 << codeSize && codeSize < 12) codeSize++;
        }

        previous = code;
    }

    return output;
}

function readSubBlocks(reader) {
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

function skipSubBlocks(reader) {
    for (let length; reader.offset < reader.data.length && (length = reader.u8());) reader.skip(length);
}

class ByteReader {
    constructor(data) {
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

    skip(length) {
        this.offset += length;
    }

    slice(length) {
        const slice = this.data.subarray(this.offset, this.offset + length);
        this.offset += length;
        return slice;
    }

    string(length) {
        return String.fromCharCode(...this.slice(length));
    }
}

class ByteWriter {
    constructor(capacity = 1024) {
        this.buffer = new Uint8Array(Math.max(16, capacity));
        this.length = 0;
    }

    reserve(size) {
        if (this.length + size <= this.buffer.length) return;
        const buffer = new Uint8Array(Math.max(this.buffer.length * 2, this.length + size));
        buffer.set(this.buffer.subarray(0, this.length));
        this.buffer = buffer;
    }

    byte(value) {
        this.reserve(1);
        this.buffer[this.length++] = value;
    }

    bytes(...values) {
        for (const value of values) this.byte(value);
    }

    u16(value) {
        this.byte(value & 0xff);
        this.byte(value >> 8 & 0xff);
    }

    string(value) {
        for (let i = 0; i < value.length; i++) this.byte(value.charCodeAt(i));
    }

    array(values) {
        this.reserve(values.length);
        this.buffer.set(values, this.length);
        this.length += values.length;
    }

    finish() {
        return this.buffer.slice(0, this.length);
    }
}

module.exports = { encode, decode };
