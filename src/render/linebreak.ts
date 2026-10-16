// Line breaking opportunities (UAX #14, Unicode Line Breaking Algorithm, https://www.unicode.org/reports/tr14/): the
// rules LB1-LB31 of revision 57, written after the specification; it passes LineBreakTest.txt

import { lineBreak, generalCategory, eastAsianWidth, extendedPictographic } from './unicode-data.ts';
import { value, valueIndex } from './unicode.ts';

/** what may happen before a character */
export const enum Break { None, Allowed, Mandatory }

const DOTTED_CIRCLE = 0x25cc;

/**
 * The break opportunity before every character, and at the end (index codepoints.length, always mandatory)
 */
export function lineBreaks(codepoints: ArrayLike<number>): Uint8Array {
    const n = codepoints.length;
    const breaks = new Uint8Array(n + 1);
    if (!n) return breaks;

    // LB1: resolved classes; LB9-LB10: combining marks after a base take its properties (attached), others are AL
    const cls: string[] = new Array(n), gc: string[] = new Array(n), wide = new Uint8Array(n), pictographicCn = new Uint8Array(n), attached = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const cp = codepoints[i];
        let c = value(lineBreak, cp);
        const g = value(generalCategory, cp);
        if (c === 'AI' || c === 'SG' || c === 'XX') c = 'AL';
        else if (c === 'SA') c = g === 'Mn' || g === 'Mc' ? 'CM' : 'AL';
        else if (c === 'CJ') c = 'NS';
        cls[i] = c;
        gc[i] = g;
        const ea = value(eastAsianWidth, cp);
        wide[i] = ea === 'F' || ea === 'W' || ea === 'H' ? 1 : 0;
        pictographicCn[i] = valueIndex(extendedPictographic, cp) && g === 'Cn' ? 1 : 0;
    }
    const raw = cls.slice();
    for (let i = 0; i < n; i++) {
        if (cls[i] !== 'CM' && cls[i] !== 'ZWJ') continue;
        const base = i > 0 ? i - 1 : -1;
        if (base >= 0 && !['BK', 'CR', 'LF', 'NL', 'SP', 'ZW'].includes(cls[base])) {
            // (the base is the class the previous attached mark took over, too)
            attached[i] = 1;
            cls[i] = cls[base];
            gc[i] = gc[base];
            wide[i] = wide[base];
            pictographicCn[i] = pictographicCn[base];
        } else {
            cls[i] = 'AL';
            gc[i] = 'Lu';
            wide[i] = 0;
            pictographicCn[i] = 0;
        }
    }

    // the character before index i, skipping attached marks (-1 at the start)
    const before = (i: number): number => {
        let j = i - 1;
        while (j >= 0 && attached[j]) j--;
        return j;
    };
    // the character from index i on that isn't an attached mark (n at the end)
    const after = (i: number): number => {
        let j = i;
        while (j < n && attached[j]) j++;
        return j;
    };
    // the character before index i, skipping spaces (and attached marks)
    const beforeSpaces = (i: number): number => {
        let j = before(i);
        while (j >= 0 && cls[j] === 'SP') j = before(j);
        return j;
    };
    const is = (j: number, ...classes: string[]): boolean => j >= 0 && j < n && classes.includes(cls[j]);

    for (let i = 1; i < n; i++) {
        const a = i - 1, b = i;
        const B = cls[b], rawA = raw[a], rawB = raw[b];
        breaks[i] = ((): Break => {
            // LB4-LB6: hard line breaks
            if (rawA === 'BK') return Break.Mandatory;
            if (rawA === 'CR' && rawB === 'LF') return Break.None;
            if (rawA === 'CR' || rawA === 'LF' || rawA === 'NL') return Break.Mandatory;
            if (rawB === 'BK' || rawB === 'CR' || rawB === 'LF' || rawB === 'NL') return Break.None;
            // LB7-LB8a
            if (rawB === 'SP' || rawB === 'ZW') return Break.None;
            if (is(beforeSpaces(b), 'ZW') && raw[beforeSpaces(b)] === 'ZW') return Break.Allowed;
            if (rawA === 'ZWJ') return Break.None;
            // LB9: no break before an attached mark
            if (attached[b]) return Break.None;

            // (from here on, the character before is the base of its marks)
            const p = before(b), P = cls[p];
            // LB11-LB12a
            if (B === 'WJ' || P === 'WJ') return Break.None;
            if (P === 'GL') return Break.None;
            if (B === 'GL' && !['SP', 'HY', 'HH'].includes(P)) return Break.None;
            // LB13
            if (B === 'CL' || B === 'CP' || B === 'EX' || B === 'SY') return Break.None;
            // LB14
            const s = beforeSpaces(b);
            if (is(s, 'OP')) return Break.None;
            // LB15a: an initial quotation mark at the start, after a space, opening punctuation or a quotation mark
            if (is(s, 'QU') && gc[s] === 'Pi') {
                const q = before(s);
                if (q < 0 || ['BK', 'CR', 'LF', 'NL', 'OP', 'QU', 'GL', 'SP', 'ZW'].includes(cls[q])) return Break.None;
            }
            // LB15b: a final quotation mark at the end, before a space, a prohibited break or a quotation mark
            if (B === 'QU' && gc[b] === 'Pf') {
                const q = after(b + 1);
                if (q >= n || ['SP', 'GL', 'WJ', 'CL', 'QU', 'CP', 'EX', 'IS', 'SY', 'BK', 'CR', 'LF', 'NL', 'ZW'].includes(cls[q])) return Break.None;
            }
            // LB15c-LB15d
            if (P === 'SP' && B === 'IS' && is(after(b + 1), 'NU')) return Break.Allowed;
            if (B === 'IS') return Break.None;
            // LB16-LB17
            if (is(s, 'CL', 'CP') && B === 'NS') return Break.None;
            if (is(s, 'B2') && B === 'B2') return Break.None;
            // LB18
            if (P === 'SP') return Break.Allowed;
            // LB19-LB19a: quotation marks
            if (B === 'QU' && gc[b] !== 'Pi') return Break.None;
            if (P === 'QU' && gc[p] !== 'Pf') return Break.None;
            if (B === 'QU') {
                if (!wide[p]) return Break.None;
                const q = after(b + 1);
                if (q >= n || !wide[q]) return Break.None;
            }
            if (P === 'QU') {
                if (!wide[b]) return Break.None;
                const q = before(p);
                if (q < 0 || !wide[q]) return Break.None;
            }
            // LB20
            if (B === 'CB' || P === 'CB') return Break.Allowed;
            // LB20a: a word-initial hyphen
            if ((P === 'HY' || P === 'HH') && (B === 'AL' || B === 'HL')) {
                const q = before(p);
                if (q < 0 || ['BK', 'CR', 'LF', 'NL', 'SP', 'ZW', 'CB', 'GL'].includes(cls[q])) return Break.None;
            }
            // LB21-LB21b
            if (B === 'BA' || B === 'HH' || B === 'HY' || B === 'NS' || P === 'BB') return Break.None;
            if ((P === 'HY' || P === 'HH') && B !== 'HL' && is(before(p), 'HL')) return Break.None;
            if (P === 'SY' && B === 'HL') return Break.None;
            // LB22-LB24
            if (B === 'IN') return Break.None;
            if ((P === 'AL' || P === 'HL') && B === 'NU' || P === 'NU' && (B === 'AL' || B === 'HL')) return Break.None;
            if (P === 'PR' && (B === 'ID' || B === 'EB' || B === 'EM') || (P === 'ID' || P === 'EB' || P === 'EM') && B === 'PO') return Break.None;
            if ((P === 'PR' || P === 'PO') && (B === 'AL' || B === 'HL') || (P === 'AL' || P === 'HL') && (B === 'PR' || B === 'PO')) return Break.None;
            // LB25: numbers
            if (B === 'PO' || B === 'PR' || B === 'NU') {
                // NU (SY | IS)* (CL | CP)? before
                let q = p;
                if (B !== 'NU' && (cls[q] === 'CL' || cls[q] === 'CP')) q = before(q);
                while (is(q, 'SY', 'IS')) q = before(q);
                if (is(q, 'NU')) return Break.None;
            }
            if ((P === 'PO' || P === 'PR') && B === 'OP') {
                const q = after(b + 1);
                if (is(q, 'NU') || is(q, 'IS') && is(after(q + 1), 'NU')) return Break.None;
            }
            if ((P === 'PO' || P === 'PR' || P === 'HY' || P === 'IS') && B === 'NU') return Break.None;
            // LB26-LB27: Korean syllable blocks
            if (P === 'JL' && ['JL', 'JV', 'H2', 'H3'].includes(B)) return Break.None;
            if ((P === 'JV' || P === 'H2') && (B === 'JV' || B === 'JT')) return Break.None;
            if ((P === 'JT' || P === 'H3') && B === 'JT') return Break.None;
            if (['JL', 'JV', 'JT', 'H2', 'H3'].includes(P) && B === 'PO' || P === 'PR' && ['JL', 'JV', 'JT', 'H2', 'H3'].includes(B)) return Break.None;
            // LB28
            if ((P === 'AL' || P === 'HL') && (B === 'AL' || B === 'HL')) return Break.None;
            // LB28a: orthographic syllables of Brahmic scripts
            const aksara = (j: number): boolean => is(j, 'AK', 'AS') || j >= 0 && j < n && codepoints[j] === DOTTED_CIRCLE;
            if (P === 'AP' && aksara(b)) return Break.None;
            if (aksara(p) && (B === 'VF' || B === 'VI')) return Break.None;
            if (P === 'VI' && aksara(before(p)) && (B === 'AK' || codepoints[b] === DOTTED_CIRCLE)) return Break.None;
            if (aksara(p) && aksara(b) && is(after(b + 1), 'VF')) return Break.None;
            // LB29-LB30
            if (P === 'IS' && (B === 'AL' || B === 'HL')) return Break.None;
            if ((P === 'AL' || P === 'HL' || P === 'NU') && B === 'OP' && !wide[b]) return Break.None;
            if (P === 'CP' && !wide[p] && (B === 'AL' || B === 'HL' || B === 'NU')) return Break.None;
            // LB30a: regional indicators pair up
            if (P === 'RI' && B === 'RI') {
                let count = 0;
                for (let q = p; is(q, 'RI'); q = before(q)) count++;
                if (count % 2) return Break.None;
            }
            // LB30b: emoji modifiers
            if (B === 'EM' && (P === 'EB' || pictographicCn[p])) return Break.None;
            // LB31
            return Break.Allowed;
        })();
    }
    // LB3
    breaks[n] = Break.Mandatory;
    return breaks;
}
