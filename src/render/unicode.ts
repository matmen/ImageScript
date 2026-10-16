// Unicode character properties from the generated tables (src/render/unicode-data.ts), decoded when first used

import type { EncodedProperty } from './unicode-data.ts';

/** a decoded property: ranges of code points (start, end inclusive) and the index of their value */
interface Ranges {
    starts: Uint32Array;
    ends: Uint32Array;
    values: Uint8Array;
}

const decoded = new WeakMap<EncodedProperty, Ranges>();

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(text: string): Uint8Array {
    const digits = new Uint8Array(128);
    for (let i = 0; i < 64; i++) digits[ALPHABET.charCodeAt(i)] = i;
    const length = text.replace(/=+$/, '').length;
    const out = new Uint8Array(length * 3 >> 2);
    for (let i = 0, o = 0, bits = 0, value = 0; i < length; i++) {
        value = value << 6 | digits[text.charCodeAt(i)];
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = value >> bits & 255;
        }
    }
    return out;
}

function decode(property: EncodedProperty): Ranges {
    let ranges = decoded.get(property);
    if (ranges) return ranges;

    const bytes = base64(property.data);
    const numbers: number[] = [];
    for (let i = 0, value = 0, shift = 1; i < bytes.length; i++) {
        value += (bytes[i] & 127) * shift;
        if (bytes[i] & 128) shift *= 128;
        else {
            numbers.push(value);
            value = 0;
            shift = 1;
        }
    }

    // (gap to the previous range, length - 1, value) per range
    const count = numbers.length / 3;
    ranges = { starts: new Uint32Array(count), ends: new Uint32Array(count), values: new Uint8Array(count) };
    for (let i = 0, next = 0; i < count; i++) {
        const start = next + numbers[i * 3];
        ranges.starts[i] = start;
        ranges.ends[i] = start + numbers[i * 3 + 1];
        ranges.values[i] = numbers[i * 3 + 2];
        next = ranges.ends[i] + 1;
    }
    decoded.set(property, ranges);
    return ranges;
}

/** The index of a code point's value in the property's names (0 is the default) */
export function valueIndex(property: EncodedProperty, codepoint: number): number {
    const { starts, ends, values } = decode(property);
    let lo = 0, hi = starts.length - 1;
    while (lo <= hi) {
        const mid = lo + hi >> 1;
        if (ends[mid] < codepoint) lo = mid + 1;
        else if (starts[mid] > codepoint) hi = mid - 1;
        else return values[mid];
    }
    return 0;
}

/** A code point's value of the property (its short name, as in the Unicode Character Database) */
export function value(property: EncodedProperty, codepoint: number): string {
    return property.names[valueIndex(property, codepoint)];
}
