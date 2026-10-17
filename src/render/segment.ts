// Text segmentation: extended grapheme clusters (UAX #29, Unicode Text Segmentation, revision for Unicode 18:
// https://www.unicode.org/reports/tr29/), written after the specification; it passes GraphemeBreakTest.txt. And the
// script of every character for itemization (Common and Inherited ones take their neighbors' script)

import { graphemeBreak, conjunctBreak, extendedPictographic, script, brackets } from './unicode-data.ts';
import { value, valueIndex } from './unicode.ts';

/** grapheme cluster boundaries: whether a grapheme starts at each index (and at the end, index length) */
export function graphemeBoundaries(codepoints: ArrayLike<number>): Uint8Array {
    const n = codepoints.length, boundaries = new Uint8Array(n + 1);
    if (!n) return boundaries;
    boundaries[0] = boundaries[n] = 1;
    const gcb: string[] = new Array(n), incb: string[] = new Array(n), pictographic = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        gcb[i] = value(graphemeBreak, codepoints[i]);
        incb[i] = value(conjunctBreak, codepoints[i]);
        pictographic[i] = valueIndex(extendedPictographic, codepoints[i]) ? 1 : 0;
    }
    // GB11: whether an Extended_Pictographic Extend* is before, and with ZWJ; GB12/13: the regional indicators before
    let emoji = false, emojiZWJ = false, ri = 0;
    // GB9c: whether a linker is before (with InCB=Extend characters after it)
    let linker = false;
    for (let i = 1; i < n; i++) {
        const a = gcb[i - 1], b = gcb[i];
        // state after the character before
        emojiZWJ = emoji && a === 'ZWJ';
        if (pictographic[i - 1]) emoji = true;
        else if (a !== 'EX') emoji = false;
        ri = a === 'RI' ? ri + 1 : 0;
        if (incb[i - 1] === 'Linker') linker = true;
        else if (incb[i - 1] !== 'Extend') linker = false;

        let boundary: boolean;
        if (a === 'CR' && b === 'LF') boundary = false;
        else if (a === 'CN' || a === 'CR' || a === 'LF' || b === 'CN' || b === 'CR' || b === 'LF') boundary = true;
        else if (a === 'L' && (b === 'L' || b === 'V' || b === 'LV' || b === 'LVT')) boundary = false;
        else if ((a === 'LV' || a === 'V') && (b === 'V' || b === 'T')) boundary = false;
        else if ((a === 'LVT' || a === 'T') && b === 'T') boundary = false;
        else if (b === 'EX' || b === 'ZWJ' || b === 'SM' || a === 'PP') boundary = false;
        else if (linker && incb[i] === 'Consonant') boundary = false;
        else if (emojiZWJ && pictographic[i]) boundary = false;
        else if (a === 'RI' && b === 'RI') boundary = ri % 2 === 0;
        else boundary = true;
        boundaries[i] = boundary ? 1 : 0;
    }
    return boundaries;
}

// paired brackets: opening code point -> closing one
let pairs: Map<number, number> | null = null;
const closingOf = (u: number): number => {
    if (!pairs) {
        pairs = new Map();
        for (let i = 0; i < brackets.length; i += 3) if (brackets[i + 2] === 1) pairs.set(brackets[i], brackets[i + 1]);
    }
    return pairs.get(u) ?? 0;
};

/**
 * The script of every character for shaping: Common (Zyyy) and Inherited (Zinh) characters take the script before
 * them (at the start: after them), paired brackets the script around the opening one
 */
export function scripts(codepoints: ArrayLike<number>): string[] {
    const n = codepoints.length, out: string[] = new Array(n);
    let current = '';
    // open brackets: [closing code point, script at the opening]
    const stack: Array<[number, string]> = [];
    for (let i = 0; i < n; i++) {
        const u = codepoints[i];
        let s = value(script, u);
        if (s === 'Zyyy' || s === 'Zinh' || s === 'Zzzz') {
            const closing = closingOf(u);
            if (closing) {
                if (stack.length >= 64) stack.shift();
                stack.push([closing, current]);
                s = current;
            } else {
                let k = stack.length - 1;
                while (k >= 0 && stack[k][0] !== u && !(u === 0x232a && stack[k][0] === 0x3009) && !(u === 0x3009 && stack[k][0] === 0x232a)) k--;
                if (k >= 0) {
                    s = stack[k][1];
                    stack.length = k;
                } else s = current;
            }
        } else {
            // brackets opened while the script was unknown take the first real one
            if (!current) for (const entry of stack) if (!entry[1]) entry[1] = s;
            current = s;
        }
        out[i] = s;
    }
    // characters before the first real script take it
    const first = out.find(s => s) ?? 'Zyyy';
    for (let i = 0; i < n && !out[i]; i++) out[i] = first;
    for (let i = 0; i < n; i++) if (!out[i]) out[i] = first;
    return out;
}
