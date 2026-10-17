// Unicode character properties from the generated tables (src/render/unicode-data.ts), decoded when first used

import type { EncodedProperty } from './unicode-data.ts';

/** a decoded property: ranges of code points (start, end inclusive) and the index of their value */
interface Ranges {
    starts: Uint32Array;
    ends: Uint32Array;
    values: Uint8Array;
}

const decoded = new WeakMap<EncodedProperty, Ranges>();

// base64 is decoded natively: Uint8Array.fromBase64 where available, atob everywhere else (browsers, Node, Deno, Bun)
declare const atob: (data: string) => string;
const fromBase64 = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }).fromBase64;

function base64(text: string): Uint8Array {
    if (fromBase64) return fromBase64(text);
    const binary = atob(text), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function decode(property: EncodedProperty): Ranges {
    let ranges = decoded.get(property);
    if (ranges) return ranges;

    const numbers = varints(property.data);

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

/** a list of numbers stored as base64 varints (see scripts/unicode.js) */
export function varints(data: string): number[] {
    const bytes = base64(data), numbers: number[] = [];
    for (let i = 0, value = 0, shift = 1; i < bytes.length; i++) {
        value += (bytes[i] & 127) * shift;
        if (bytes[i] & 128) shift *= 128;
        else {
            numbers.push(value);
            value = 0;
            shift = 1;
        }
    }
    return numbers;
}
