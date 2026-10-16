// The Unicode Bidirectional Algorithm (UAX #9, https://www.unicode.org/reports/tr9/): resolved embedding levels of a
// paragraph and the visual order of a line. Written after the specification; it passes BidiTest.txt and
// BidiCharacterTest.txt

import { bidiClass, brackets as bracketData, mirrors as mirrorData } from './unicode-data.ts';
import { valueIndex } from './unicode.ts';

/** Bidi_Class values */
export const enum Bidi { L, R, AL, EN, ES, ET, AN, CS, NSM, BN, B, S, WS, ON, LRE, LRO, RLE, RLO, PDF, LRI, RLI, FSI, PDI }

const NAMES = ['L', 'R', 'AL', 'EN', 'ES', 'ET', 'AN', 'CS', 'NSM', 'BN', 'B', 'S', 'WS', 'ON', 'LRE', 'LRO', 'RLE', 'RLO', 'PDF', 'LRI', 'RLI', 'FSI', 'PDI'];
/** Bidi_Class names (as in the Unicode Character Database) to values */
export const BIDI_CLASSES: Record<string, Bidi> = Object.fromEntries(NAMES.map((name, i) => [name, i]));

// the generated table's value indices -> Bidi
const fromTable = Uint8Array.from(bidiClass.names, name => BIDI_CLASSES[name]);

/** A code point's Bidi_Class */
export function classOf(codepoint: number): Bidi {
    return fromTable[valueIndex(bidiClass, codepoint)];
}

let bracketMap: Map<number, { pair: number, opening: boolean }> | null = null;
let mirrorMap: Map<number, number> | null = null;

/** The mirrored glyph's code point (Bidi_Mirroring_Glyph), or the code point itself */
export function mirror(codepoint: number): number {
    if (!mirrorMap) {
        mirrorMap = new Map();
        for (let i = 0; i < mirrorData.length; i += 2) mirrorMap.set(mirrorData[i], mirrorData[i + 1]);
    }
    return mirrorMap.get(codepoint) ?? codepoint;
}

function bracket(codepoint: number): { pair: number, opening: boolean } | undefined {
    if (!bracketMap) {
        bracketMap = new Map();
        for (let i = 0; i < bracketData.length; i += 3) bracketMap.set(bracketData[i], { pair: bracketData[i + 1], opening: bracketData[i + 2] === 1 });
    }
    return bracketMap.get(codepoint);
}

// canonical equivalents among the brackets (the angle brackets U+2329/U+232A decompose to U+3008/U+3009)
const canonical = (codepoint: number): number => codepoint === 0x2329 ? 0x3008 : codepoint === 0x232a ? 0x3009 : codepoint;

const MAX_DEPTH = 125;
const isIsolateInitiator = (t: Bidi): boolean => t === Bidi.LRI || t === Bidi.RLI || t === Bidi.FSI;
// removed by rule X9
const isRemoved = (t: Bidi): boolean => t === Bidi.BN || t >= Bidi.LRE && t <= Bidi.PDF;

/** a paragraph's resolved levels: -1 for characters removed by rule X9 (embedding controls and boundary neutrals) */
export interface Paragraph {
    level: number;
    levels: Int8Array;
    /** the original Bidi_Class of every character, for the line rules */
    classes: Uint8Array;
}

/**
 * Resolves the embedding levels of a paragraph (rules P2-I2)
 * @param classes the characters' Bidi_Class
 * @param codepoints the characters, for paired brackets (rule N0); without them brackets don't pair
 * @param direction the paragraph level: 0 (left to right), 1 (right to left), or -1 to detect it (rules P2-P3)
 */
export function resolve(classes: ArrayLike<Bidi>, codepoints: ArrayLike<number> | null, direction = -1): Paragraph {
    const n = classes.length;
    const original = Uint8Array.from(classes);
    const types = Uint8Array.from(classes);

    // BD9: the PDI matching every isolate initiator (-1 if none), and the initiator of every matched PDI
    const matching = new Int32Array(n).fill(-1);
    {
        const open: number[] = [];
        for (let i = 0; i < n; i++) {
            if (isIsolateInitiator(original[i])) open.push(i);
            else if (original[i] === Bidi.PDI && open.length) matching[open.pop() as number] = i;
            else if (original[i] === Bidi.B) open.length = 0;
        }
    }

    // P2-P3: the first strong character, skipping isolates; -1 if there is none
    const firstStrong = (start: number, end: number): number => {
        for (let i = start; i < end; i++) {
            const t = original[i];
            if (t === Bidi.L) return 0;
            if (t === Bidi.R || t === Bidi.AL) return 1;
            if (isIsolateInitiator(t)) {
                if (matching[i] < 0) return -1;
                i = matching[i];
            } else if (t === Bidi.B) return -1;
        }
        return -1;
    };
    const paragraphLevel = direction >= 0 ? direction : Math.max(0, firstStrong(0, n));

    // X1-X8: explicit levels and directions
    const levels = new Int8Array(n);
    const stack: Array<{ level: number, override: number, isolate: boolean }> = [{ level: paragraphLevel, override: -1, isolate: false }];
    let overflowIsolates = 0, overflowEmbeddings = 0, validIsolates = 0;
    for (let i = 0; i < n; i++) {
        const t = original[i], top = stack[stack.length - 1];
        switch (t) {
            case Bidi.RLE: case Bidi.LRE: case Bidi.RLO: case Bidi.LRO: {
                const rtl = t === Bidi.RLE || t === Bidi.RLO;
                const level = rtl ? top.level + 1 | 1 : top.level + 2 & ~1;
                if (level <= MAX_DEPTH && !overflowIsolates && !overflowEmbeddings)
                    stack.push({ level, override: t === Bidi.RLO ? Bidi.R : t === Bidi.LRO ? Bidi.L : -1, isolate: false });
                else if (!overflowIsolates) overflowEmbeddings++;
                levels[i] = top.level;
                break;
            }
            case Bidi.RLI: case Bidi.LRI: case Bidi.FSI: {
                levels[i] = top.level;
                if (top.override >= 0) types[i] = top.override;
                const rtl = t === Bidi.RLI || t === Bidi.FSI && firstStrong(i + 1, matching[i] >= 0 ? matching[i] : n) === 1;
                const level = rtl ? top.level + 1 | 1 : top.level + 2 & ~1;
                if (level <= MAX_DEPTH && !overflowIsolates && !overflowEmbeddings) {
                    validIsolates++;
                    stack.push({ level, override: -1, isolate: true });
                } else overflowIsolates++;
                break;
            }
            case Bidi.PDI:
                if (overflowIsolates) overflowIsolates--;
                else if (validIsolates) {
                    overflowEmbeddings = 0;
                    while (!stack[stack.length - 1].isolate) stack.pop();
                    stack.pop();
                    validIsolates--;
                }
                levels[i] = stack[stack.length - 1].level;
                if (stack[stack.length - 1].override >= 0) types[i] = stack[stack.length - 1].override;
                break;
            case Bidi.PDF:
                if (overflowIsolates) {
                    // nothing
                } else if (overflowEmbeddings) overflowEmbeddings--;
                else if (!top.isolate && stack.length > 1) stack.pop();
                levels[i] = top.level;
                break;
            case Bidi.B:
                levels[i] = paragraphLevel;
                break;
            case Bidi.BN:
                levels[i] = top.level;
                break;
            default:
                levels[i] = top.level;
                if (top.override >= 0) types[i] = top.override;
        }
    }

    // X10: isolating run sequences of the level runs (characters removed by X9 left out), chained from isolate
    // initiators to their matching PDIs
    const runs: number[][] = [];
    {
        let run: number[] = [];
        for (let i = 0; i < n; i++) {
            if (isRemoved(original[i])) continue;
            if (run.length && levels[i] !== levels[run[run.length - 1]]) {
                runs.push(run);
                run = [];
            }
            run.push(i);
        }
        if (run.length) runs.push(run);
    }
    const matched = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (matching[i] >= 0) matched[matching[i]] = 1;
    const runOf = new Int32Array(n).fill(-1);
    runs.forEach((run, r) => runOf[run[0]] = r);
    const sequences: number[][] = [];
    for (const run of runs) {
        // runs starting with a matched PDI continue the sequence of their initiator
        const first = run[0];
        if (original[first] === Bidi.PDI && matched[first]) continue;
        const sequence = [...run];
        for (let last = sequence[sequence.length - 1]; isIsolateInitiator(original[last]) && matching[last] >= 0;) {
            const next = runOf[matching[last]];
            if (next < 0) break;
            sequence.push(...runs[next]);
            last = sequence[sequence.length - 1];
        }
        sequences.push(sequence);
    }

    // sos and eos come from the embedding levels of the neighbors (before rules I1-I2 raise any of them)
    const embeddingLevels = levels.slice();
    const levelOfNeighbor = (index: number, step: number): number => {
        for (let i = index + step; i >= 0 && i < n; i += step) if (!isRemoved(original[i])) return embeddingLevels[i];
        return paragraphLevel;
    };

    for (const sequence of sequences) {
        const level = embeddingLevels[sequence[0]], m = sequence.length;
        const embedding = level & 1 ? Bidi.R : Bidi.L;
        const first = sequence[0], last = sequence[m - 1];
        const sos = Math.max(level, levelOfNeighbor(first, -1)) & 1 ? Bidi.R : Bidi.L;
        const eos = Math.max(level, isIsolateInitiator(original[last]) ? paragraphLevel : levelOfNeighbor(last, 1)) & 1 ? Bidi.R : Bidi.L;
        const t = sequence.map(i => types[i]);

        // W1: NSM takes the type of the character before it (ON after isolate controls, sos at the start)
        for (let k = 0; k < m; k++)
            if (t[k] === Bidi.NSM) t[k] = k === 0 ? sos : isIsolateInitiator(t[k - 1]) || t[k - 1] === Bidi.PDI ? Bidi.ON : t[k - 1];
        // W2: EN after AL (as the last strong type) becomes AN; W3: AL becomes R
        for (let k = 0, strong = sos; k < m; k++) {
            if (t[k] === Bidi.L || t[k] === Bidi.R || t[k] === Bidi.AL) strong = t[k];
            else if (t[k] === Bidi.EN && strong === Bidi.AL) t[k] = Bidi.AN;
        }
        for (let k = 0; k < m; k++) if (t[k] === Bidi.AL) t[k] = Bidi.R;
        // W4: a single ES between ENs, a single CS between numbers of the same type
        for (let k = 1; k + 1 < m; k++) {
            if (t[k] === Bidi.ES && t[k - 1] === Bidi.EN && t[k + 1] === Bidi.EN) t[k] = Bidi.EN;
            else if (t[k] === Bidi.CS && (t[k - 1] === Bidi.EN || t[k - 1] === Bidi.AN) && t[k + 1] === t[k - 1]) t[k] = t[k - 1];
        }
        // W5: ETs next to ENs become EN
        for (let k = 0; k < m; k++) {
            if (t[k] !== Bidi.ET) continue;
            let end = k;
            while (end < m && t[end] === Bidi.ET) end++;
            if (k > 0 && t[k - 1] === Bidi.EN || end < m && t[end] === Bidi.EN) for (let j = k; j < end; j++) t[j] = Bidi.EN;
            k = end - 1;
        }
        // W6: other separators and terminators become ON
        for (let k = 0; k < m; k++) if (t[k] === Bidi.ES || t[k] === Bidi.ET || t[k] === Bidi.CS) t[k] = Bidi.ON;
        // W7: EN after L (as the last strong type) becomes L
        for (let k = 0, strong = sos; k < m; k++) {
            if (t[k] === Bidi.L || t[k] === Bidi.R) strong = t[k];
            else if (t[k] === Bidi.EN && strong === Bidi.L) t[k] = Bidi.L;
        }

        // N0: paired brackets take the embedding direction, or the other one if their content and context have it
        if (codepoints) {
            const pairs: Array<[number, number]> = [];
            const open: Array<{ k: number, pair: number }> = [];
            for (let k = 0; k < m; k++) {
                if (t[k] !== Bidi.ON) continue;
                const cp = codepoints[sequence[k]], b = bracket(cp);
                if (!b) continue;
                if (b.opening) {
                    // BD16: at most 63 nested openings, the rest of the sequence isn't paired then
                    if (open.length === 63) break;
                    open.push({ k, pair: canonical(b.pair) });
                } else {
                    for (let j = open.length - 1; j >= 0; j--)
                        if (open[j].pair === canonical(cp)) {
                            pairs.push([open[j].k, k]);
                            open.length = j;
                            break;
                        }
                }
            }
            pairs.sort((a, b) => a[0] - b[0]);
            const strongOf = (type: number): number => type === Bidi.L ? Bidi.L : type === Bidi.R || type === Bidi.EN || type === Bidi.AN ? Bidi.R : -1;
            for (const [o, c] of pairs) {
                let inside = -1;
                for (let k = o + 1; k < c; k++) {
                    const s = strongOf(t[k]);
                    if (s === embedding) { inside = embedding; break; }
                    if (s >= 0) inside = s;
                }
                if (inside < 0) continue;
                let resolved = embedding;
                if (inside !== embedding) {
                    let before = sos;
                    for (let k = o - 1; k >= 0; k--) {
                        const s = strongOf(t[k]);
                        if (s >= 0) { before = s; break; }
                    }
                    resolved = before === inside ? inside : embedding;
                }
                t[o] = t[c] = resolved;
                // NSMs following a bracket that changed take its type too
                for (const b of [o, c]) for (let k = b + 1; k < m && original[sequence[k]] === Bidi.NSM; k++) t[k] = resolved;
            }
        }

        // N1-N2: neutrals between strong types of the same direction take it, others the embedding direction
        const isNeutral = (type: number): boolean => type === Bidi.B || type === Bidi.S || type === Bidi.WS || type === Bidi.ON || isIsolateInitiator(type) || type === Bidi.PDI;
        for (let k = 0; k < m; k++) {
            if (!isNeutral(t[k])) continue;
            let end = k;
            while (end < m && isNeutral(t[end])) end++;
            const before = k === 0 ? sos : t[k - 1] === Bidi.L ? Bidi.L : Bidi.R;
            const after = end === m ? eos : t[end] === Bidi.L ? Bidi.L : Bidi.R;
            const resolved = before === after ? before : embedding;
            for (let j = k; j < end; j++) t[j] = resolved;
            k = end - 1;
        }

        // I1-I2: levels by the resolved types
        for (let k = 0; k < m; k++) {
            const i = sequence[k];
            if (level & 1) {
                if (t[k] === Bidi.L || t[k] === Bidi.EN || t[k] === Bidi.AN) levels[i]++;
            } else if (t[k] === Bidi.R) levels[i]++;
            else if (t[k] === Bidi.AN || t[k] === Bidi.EN) levels[i] += 2;
        }
    }

    for (let i = 0; i < n; i++) if (isRemoved(original[i])) levels[i] = -1;
    return { level: paragraphLevel, levels, classes: original };
}

/**
 * The levels of a line of a paragraph (rule L1: separators, and whitespace and isolate controls before them and at the
 * end of the line, take the paragraph level), removed characters keep -1
 */
export function lineLevels(paragraph: Paragraph, start: number, end: number): Int8Array {
    const levels = paragraph.levels.slice(start, end), classes = paragraph.classes;
    const trailing = (t: Bidi): boolean => t === Bidi.WS || isIsolateInitiator(t) || t === Bidi.PDI || isRemoved(t);
    for (let i = end - 1, atEnd = true; i >= start; i--) {
        const t = classes[i];
        if (t === Bidi.S || t === Bidi.B) {
            levels[i - start] = paragraph.level;
            atEnd = true;
        } else if (atEnd && trailing(t)) {
            if (!isRemoved(t)) levels[i - start] = paragraph.level;
        } else atEnd = false;
    }
    return levels;
}

/**
 * The visual order of a line (rule L2): indices into it from left to right, characters removed by X9 left out
 */
export function visualOrder(levels: ArrayLike<number>): number[] {
    const order: number[] = [];
    for (let i = 0; i < levels.length; i++) if (levels[i] >= 0) order.push(i);
    let highest = 0, lowestOdd = Infinity;
    for (const i of order) {
        highest = Math.max(highest, levels[i]);
        if (levels[i] & 1) lowestOdd = Math.min(lowestOdd, levels[i]);
    }
    // from the highest level down to the lowest odd one, reverse every run at that level or higher
    for (let level = highest; level >= lowestOdd; level--)
        for (let k = 0; k < order.length; k++) {
            if (levels[order[k]] < level) continue;
            let end = k;
            while (end < order.length && levels[order[end]] >= level) end++;
            order.splice(k, end - k, ...order.slice(k, end).reverse());
            k = end - 1;
        }
    return order;
}
