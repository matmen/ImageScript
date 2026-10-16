// glyph substitution (GSUB) with the features browsers apply by default: composition (emoji sequences, flags,
// keycaps), ligatures and contextual alternates. Script and language systems aren't told apart, every record of these
// features applies (like the kerning of GPOS)

import { Font, parseCoverage, parseClassDef } from './font.ts';

const FEATURES = new Set(['ccmp', 'rlig', 'liga', 'clig', 'calt']);

/** glyphs being shaped, with the index of the character each one came from (a ligature: its first) */
export interface GlyphBuffer {
    glyphs: number[];
    clusters: number[];
}

// a subtable applied at index i: the index to continue at, -1 if it doesn't apply there
type Subtable = (buffer: GlyphBuffer, i: number) => number;

interface Lookup {
    subtables: Subtable[];
    /** whether the lookup flags skip the glyph */
    skip: (glyph: number) => boolean;
    /** whether a subtable can start at the glyph */
    starts: (glyph: number) => boolean;
}

// a glyph test in a context: a glyph id, a class or a coverage
type Matcher = (glyph: number) => boolean;

/**
 * The font's substitutions as a function that rewrites a glyph buffer, null if the font has none
 */
export function parseGSUB(font: Font): ((buffer: GlyphBuffer) => void) | null {
    const gsub = font.tables.GSUB?.offset;
    if (gsub === undefined) return null;
    const featureList = gsub + font.u16(gsub + 6), lookupList = gsub + font.u16(gsub + 8);
    const lookupCount = font.u16(lookupList);

    const indices = new Set<number>();
    for (let i = 0, count = font.u16(featureList); i < count; i++) {
        const record = featureList + 2 + i * 6;
        const tag = String.fromCharCode(font.u8(record), font.u8(record + 1), font.u8(record + 2), font.u8(record + 3));
        if (!FEATURES.has(tag)) continue;
        const feature = featureList + font.u16(record + 4);
        for (let j = 0, n = font.u16(feature + 2); j < n; j++) {
            const index = font.u16(feature + 4 + j * 2);
            if (index < lookupCount) indices.add(index);
        }
    }
    if (!indices.size) return null;

    // glyph classes (1 base, 2 ligature, 3 mark) and mark attachment classes for the lookup flags
    const gdef = font.tables.GDEF?.offset;
    const glyphClass = gdef !== undefined && font.u16(gdef + 4) ? parseClassDef(font, gdef + font.u16(gdef + 4)) : () => 0;
    const markClass = gdef !== undefined && font.u16(gdef + 10) ? parseClassDef(font, gdef + font.u16(gdef + 10)) : () => 0;

    // lookups are parsed when first used, contextual ones can call any lookup
    const lookups = new Map<number, Lookup>();
    const lookup = (index: number): Lookup | null => {
        if (index >= lookupCount) return null;
        let l = lookups.get(index);
        if (!l) {
            const offset = lookupList + font.u16(lookupList + 2 + index * 2);
            const type = font.u16(offset), flag = font.u16(offset + 2);
            const skip = skipper(flag, glyphClass, markClass);
            // a glyph no subtable covers first is passed over without trying them (memoized per glyph: 0 unknown,
            // 1 no, 2 yes)
            const covers: Matcher[] = [], memo = new Uint8Array(font.numGlyphs);
            const starts = (glyph: number): boolean => {
                if (glyph >= memo.length) return covers.some(c => c(glyph));
                if (!memo[glyph]) memo[glyph] = covers.some(c => c(glyph)) ? 2 : 1;
                return memo[glyph] === 2;
            };
            l = { subtables: [], skip, starts };
            lookups.set(index, l);
            for (let i = 0, count = font.u16(offset + 4); i < count; i++) {
                const subtableOffset = offset + font.u16(offset + 6 + i * 2);
                const subtable = parseSubtable(font, type, subtableOffset, l, applyNested);
                if (!subtable) continue;
                l.subtables.push(subtable);
                covers.push(firstCoverage(font, type, subtableOffset));
            }
        }
        return l;
    };

    // a lookup called from a context applies once, at the given index
    function applyNested(buffer: GlyphBuffer, index: number, i: number): void {
        const l = lookup(index);
        if (!l || i >= buffer.glyphs.length || l.skip(buffer.glyphs[i]) || !l.starts(buffer.glyphs[i])) return;
        for (const subtable of l.subtables) if (subtable(buffer, i) >= 0) return;
    }

    const order = [...indices].sort((a, b) => a - b);
    return buffer => {
        // every lookup goes over the whole buffer, in the order of the lookup list
        for (const index of order) {
            const l = lookup(index);
            if (!l) continue;
            for (let i = 0; i < buffer.glyphs.length;) {
                let next = -1;
                const glyph = buffer.glyphs[i];
                if (l.starts(glyph) && !l.skip(glyph)) for (const subtable of l.subtables) if ((next = subtable(buffer, i)) >= 0) break;
                i = next >= 0 ? next : i + 1;
            }
        }
    };
}

// which glyphs a lookup's flags skip: bases, ligatures, marks (all or those of another attachment class)
function skipper(flag: number, glyphClass: (glyph: number) => number, markClass: (glyph: number) => number): (glyph: number) => boolean {
    const attachment = flag >> 8;
    if (!(flag & 0xe) && !attachment) return () => false;
    return glyph => {
        const c = glyphClass(glyph);
        if (c === 1) return (flag & 2) !== 0;
        if (c === 2) return (flag & 4) !== 0;
        if (c === 3) return (flag & 8) !== 0 || attachment !== 0 && markClass(glyph) !== attachment;
        return false;
    };
}

// the next / previous index the lookup doesn't skip, -1 at the end
function next(buffer: GlyphBuffer, i: number, l: Lookup): number {
    for (i++; i < buffer.glyphs.length; i++) if (!l.skip(buffer.glyphs[i])) return i;
    return -1;
}

function previous(buffer: GlyphBuffer, i: number, l: Lookup): number {
    for (i--; i >= 0; i--) if (!l.skip(buffer.glyphs[i])) return i;
    return -1;
}

// the glyphs a subtable can start at: its coverage, or the first input coverage of format 3 contexts
function firstCoverage(font: Font, type: number, offset: number): Matcher {
    if (type === 7) return firstCoverage(font, font.u16(offset + 2), offset + font.u32(offset + 4));
    let coverage = offset + font.u16(offset + 2);
    if (type === 5 && font.u16(offset) === 3) coverage = offset + font.u16(offset + 6);
    else if (type === 6 && font.u16(offset) === 3) coverage = offset + font.u16(offset + 6 + font.u16(offset + 2) * 2);
    const covered = parseCoverage(font, coverage);
    return glyph => covered(glyph) >= 0;
}

function parseSubtable(font: Font, type: number, offset: number, l: Lookup, nested: (buffer: GlyphBuffer, lookup: number, i: number) => void): Subtable | null {
    const format = font.u16(offset);
    switch (type) {
        // single: a glyph for another
        case 1: {
            const coverage = parseCoverage(font, offset + font.u16(offset + 2));
            if (format === 1) {
                const delta = font.i16(offset + 4);
                return (buffer, i) => {
                    if (coverage(buffer.glyphs[i]) < 0) return -1;
                    buffer.glyphs[i] = buffer.glyphs[i] + delta & 0xffff;
                    return i + 1;
                };
            }
            return (buffer, i) => {
                const k = coverage(buffer.glyphs[i]);
                if (k < 0) return -1;
                buffer.glyphs[i] = font.u16(offset + 6 + k * 2);
                return i + 1;
            };
        }

        // multiple: a glyph for a sequence (empty ones delete it)
        case 2: {
            const coverage = parseCoverage(font, offset + font.u16(offset + 2));
            return (buffer, i) => {
                const k = coverage(buffer.glyphs[i]);
                if (k < 0) return -1;
                const sequence = offset + font.u16(offset + 6 + k * 2), count = font.u16(sequence);
                const glyphs = Array.from({ length: count }, (_, j) => font.u16(sequence + 2 + j * 2));
                buffer.glyphs.splice(i, 1, ...glyphs);
                buffer.clusters.splice(i, 1, ...glyphs.map(() => buffer.clusters[i]));
                return i + count;
            };
        }

        // ligature: a sequence for a glyph, the first ligature of the set that matches
        case 4: {
            const coverage = parseCoverage(font, offset + font.u16(offset + 2));
            return (buffer, i) => {
                const k = coverage(buffer.glyphs[i]);
                if (k < 0) return -1;
                const set = offset + font.u16(offset + 6 + k * 2);
                for (let j = 0, count = font.u16(set); j < count; j++) {
                    const ligature = set + font.u16(set + 2 + j * 2), components = font.u16(ligature + 2);
                    const positions = [i];
                    for (let c = 1, p = i; c < components; c++) {
                        p = next(buffer, p, l);
                        if (p < 0 || buffer.glyphs[p] !== font.u16(ligature + 2 + c * 2)) break;
                        positions.push(p);
                    }
                    if (positions.length !== components) continue;

                    buffer.glyphs[i] = font.u16(ligature);
                    for (let c = positions.length - 1; c > 0; c--) {
                        buffer.glyphs.splice(positions[c], 1);
                        buffer.clusters.splice(positions[c], 1);
                    }
                    return i + 1;
                }
                return -1;
            };
        }

        // contextual and chained contextual: lookups applied to a matched sequence
        case 5:
        case 6:
            return parseContext(font, type === 6, offset, l, nested);

        // extension: a subtable of another type behind a 32-bit offset
        case 7:
            return parseSubtable(font, font.u16(offset + 2), offset + font.u32(offset + 4), l, nested);

        default:
            return null;
    }
}

interface Rule {
    backtrack: Matcher[];
    input: Matcher[];
    lookahead: Matcher[];
    /** (sequence index, lookup index) pairs */
    records: number[];
}

function parseContext(font: Font, chained: boolean, offset: number, l: Lookup, nested: (buffer: GlyphBuffer, lookup: number, i: number) => void): Subtable | null {
    const format = font.u16(offset);
    const records = (o: number, count: number): number[] => Array.from({ length: count * 2 }, (_, j) => font.u16(o + j * 2));
    const glyphs = (o: number, count: number): Matcher[] => Array.from({ length: count }, (_, j) => {
        const id = font.u16(o + j * 2);
        return (glyph: number) => glyph === id;
    });

    // rules of format 1 (glyphs) and 2 (classes) sets: [backtrack,] input after the first, [lookahead,] records
    const rule = (o: number, matchers: (o: number, count: number, part: number) => Matcher[]): Rule => {
        if (!chained) {
            const inputCount = font.u16(o), recordCount = font.u16(o + 2);
            return { backtrack: [], input: matchers(o + 4, inputCount - 1, 1), lookahead: [], records: records(o + 4 + (inputCount - 1) * 2, recordCount) };
        }
        const backtrackCount = font.u16(o);
        const backtrack = matchers(o + 2, backtrackCount, 0);
        let p = o + 2 + backtrackCount * 2;
        const inputCount = font.u16(p);
        const input = matchers(p + 2, inputCount - 1, 1);
        p += 2 + (inputCount - 1) * 2;
        const lookaheadCount = font.u16(p);
        const lookahead = matchers(p + 2, lookaheadCount, 2);
        p += 2 + lookaheadCount * 2;
        return { backtrack, input, lookahead, records: records(p + 2, font.u16(p)) };
    };
    const ruleSet = (set: number, matchers: (o: number, count: number, part: number) => Matcher[]): Rule[] =>
        Array.from({ length: font.u16(set) }, (_, j) => rule(set + font.u16(set + 2 + j * 2), matchers));

    if (format === 1 || format === 2) {
        const coverage = parseCoverage(font, offset + font.u16(offset + 2));
        let classes: Array<(glyph: number) => number> = [];
        let setCount: number, sets: number;
        if (format === 1) {
            setCount = font.u16(offset + 4);
            sets = offset + 6;
        } else if (!chained) {
            const classDef = parseClassDef(font, offset + font.u16(offset + 4));
            classes = [classDef, classDef, classDef];
            setCount = font.u16(offset + 6);
            sets = offset + 8;
        } else {
            classes = [0, 1, 2].map(k => parseClassDef(font, offset + font.u16(offset + 4 + k * 2)));
            setCount = font.u16(offset + 10);
            sets = offset + 12;
        }
        // format 2 rules hold classes of the backtrack (0), input (1) or lookahead (2) class definition
        const matchers = format === 1 ? glyphs : (o: number, count: number, part: number): Matcher[] => Array.from({ length: count }, (_, j) => {
            const value = font.u16(o + j * 2), classOf = classes[part];
            return (glyph: number) => classOf(glyph) === value;
        });

        const cache = new Map<number, Rule[]>();
        return (buffer, i) => {
            const glyph = buffer.glyphs[i];
            if (coverage(glyph) < 0) return -1;
            // sets by coverage index (format 1) or by the input class of the first glyph (format 2)
            const k = format === 1 ? coverage(glyph) : classes[1](glyph);
            if (k >= setCount || !font.u16(sets + k * 2)) return -1;
            let rules = cache.get(k);
            if (!rules) cache.set(k, rules = ruleSet(offset + font.u16(sets + k * 2), matchers));
            for (const r of rules) {
                const end = applyRule(buffer, i, r, l, nested);
                if (end >= 0) return end;
            }
            return -1;
        };
    }

    if (format === 3) {
        const coverages = (o: number, count: number): Matcher[] => Array.from({ length: count }, (_, j) => {
            const coverage = parseCoverage(font, offset + font.u16(o + j * 2));
            return (glyph: number) => coverage(glyph) >= 0;
        });
        let r: Rule;
        if (!chained) {
            const inputCount = font.u16(offset + 2), recordCount = font.u16(offset + 4);
            const input = coverages(offset + 6, inputCount);
            r = { backtrack: [], input: input.slice(1), lookahead: [], records: records(offset + 6 + inputCount * 2, recordCount) };
            const first = input[0];
            return (buffer, i) => first(buffer.glyphs[i]) ? applyRule(buffer, i, r, l, nested) : -1;
        }
        const backtrackCount = font.u16(offset + 2);
        const backtrack = coverages(offset + 4, backtrackCount);
        let p = offset + 4 + backtrackCount * 2;
        const inputCount = font.u16(p);
        const input = coverages(p + 2, inputCount);
        p += 2 + inputCount * 2;
        const lookaheadCount = font.u16(p);
        const lookahead = coverages(p + 2, lookaheadCount);
        p += 2 + lookaheadCount * 2;
        r = { backtrack, input: input.slice(1), lookahead, records: records(p + 2, font.u16(p)) };
        const first = input[0];
        return (buffer, i) => first(buffer.glyphs[i]) ? applyRule(buffer, i, r, l, nested) : -1;
    }

    return null;
}

// matches a rule at i (its first input glyph already matched) and applies its lookups: the index after the input
// sequence, -1 if the rule doesn't match
function applyRule(buffer: GlyphBuffer, i: number, r: Rule, l: Lookup, nested: (buffer: GlyphBuffer, lookup: number, i: number) => void): number {
    const positions = [i];
    for (let k = 0, p = i; k < r.input.length; k++) {
        p = next(buffer, p, l);
        if (p < 0 || !r.input[k](buffer.glyphs[p])) return -1;
        positions.push(p);
    }
    for (let k = 0, p = i; k < r.backtrack.length; k++) {
        p = previous(buffer, p, l);
        if (p < 0 || !r.backtrack[k](buffer.glyphs[p])) return -1;
    }
    for (let k = 0, p = positions[positions.length - 1]; k < r.lookahead.length; k++) {
        p = next(buffer, p, l);
        if (p < 0 || !r.lookahead[k](buffer.glyphs[p])) return -1;
    }

    // the lookups can change the length, the positions after the changed one move along
    let end = positions[positions.length - 1] + 1;
    for (let k = 0; k < r.records.length; k += 2) {
        const sequenceIndex = r.records[k];
        if (sequenceIndex >= positions.length) continue;
        const at = positions[sequenceIndex], before = buffer.glyphs.length;
        nested(buffer, r.records[k + 1], at);
        const delta = buffer.glyphs.length - before;
        if (delta) {
            for (let j = sequenceIndex + 1; j < positions.length; j++) positions[j] += delta;
            end += delta;
        }
    }
    return end;
}
