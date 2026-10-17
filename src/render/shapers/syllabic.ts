/*!
 * Helpers of the syllabic shapers, ported from HarfBuzz (hb-ot-shaper-syllabic.cc, hb-ot-shaper-vowel-constraints.cc)
 * Copyright © 2021 Behdad Esfahbod, © 2018 Google, Inc., Old MIT license (see THIRD_PARTY_NOTICES.md and
 * licenses/HarfBuzz.txt)
 */

import { Buffer, GlyphInfo, UnicodeProps } from '../buffer.ts';
import { ShapeFont, scriptOf } from '../shape.ts';
import { vowelConstraints } from '../unicode-data.ts';

/** the end of the syllable starting at start */
export function nextSyllable(buffer: Buffer, start: number): number {
    const info = buffer.info;
    if (start >= info.length) return info.length;
    const syllable = info[start].syllable;
    while (++start < info.length && syllable === info[start].syllable);
    return start;
}

/** calls f for each syllable's range */
export function forEachSyllable(buffer: Buffer, f: (start: number, end: number) => void): void {
    for (let start = 0, end = buffer.len ? nextSyllable(buffer, 0) : 0; start < buffer.len; start = end, end = nextSyllable(buffer, start)) f(start, end);
}

/** inserts a dotted circle into broken syllables (after a repha), true if any were */
export function insertDottedCircles(font: ShapeFont, buffer: Buffer, brokenType: number, category: number, repha: number, position: number): boolean {
    if (!buffer.hasBrokenSyllable) return false;
    const glyph = font.glyph(0x25cc);
    if (!glyph) return false;
    buffer.clearOutput();
    buffer.idx = 0;
    let last = 0;
    while (buffer.idx < buffer.len && buffer.successful) {
        const syllable = buffer.cur().syllable;
        if (last !== syllable && (syllable & 0x0f) === brokenType) {
            last = syllable;
            const info = new GlyphInfo();
            info.codepoint = glyph;
            info.category = category;
            if (position !== -1) info.position = position;
            info.cluster = buffer.cur().cluster;
            info.mask = buffer.cur().mask;
            info.syllable = syllable;
            if (repha !== -1)
                while (buffer.idx < buffer.len && buffer.successful && last === buffer.cur().syllable && buffer.cur().category === repha) buffer.nextGlyph();
            buffer.outputInfo(info);
        } else buffer.nextGlyph();
    }
    buffer.sync();
    return true;
}

// the prohibited vowel sequences by script, decoded when first used (where one is a prefix of another, the shorter one)
let constraints: Map<string, number[][]> | null = null;
function constraintsOf(script: string): number[][] {
    if (!constraints) {
        constraints = new Map();
        for (const sequence of vowelConstraints) {
            const s = scriptOf(sequence[0]);
            let list = constraints.get(s);
            if (!list) constraints.set(s, list = []);
            list.push(sequence);
        }
        for (const list of constraints.values()) list.sort((a, b) => a.length - b.length);
    }
    return constraints.get(script) ?? [];
}

/** inserts dotted circles into vowel sequences that look like another vowel (from the USE specification) */
export function vowelConstraintsPreprocess(buffer: Buffer): void {
    const list = constraintsOf(buffer.script);
    if (!list.length) return;
    buffer.clearOutput();
    const count = buffer.len;
    for (buffer.idx = 0; buffer.idx + 1 < count && buffer.successful;) {
        let matched: number[] | null = null;
        for (const sequence of list) {
            if (buffer.idx + sequence.length > count) continue;
            let k = 0;
            while (k < sequence.length && buffer.info[buffer.idx + k].codepoint === sequence[k]) k++;
            if (k === sequence.length) {
                matched = sequence;
                break;
            }
        }
        if (!matched) {
            buffer.nextGlyph();
            continue;
        }
        // a dotted circle before the sequence's last character
        for (let k = 0; k < matched.length - 1; k++) buffer.nextGlyph();
        const circle = buffer.outputGlyph(0x25cc);
        circle.unicodeProps &= ~UnicodeProps.CONTINUATION;
        buffer.nextGlyph();
    }
    buffer.sync();
}
