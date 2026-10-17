/*!
 * OpenType layout (GDEF, GSUB, GPOS and their feature map), ported from HarfBuzz (hb-ot-layout*, hb-ot-map*,
 * OT/Layout/GSUB/*, OT/Layout/GPOS/*)
 * Copyright © 2007,2008,2009,2010 Red Hat, Inc., © 2010,2012,2013 Google, Inc., Old MIT license (see
 * THIRD_PARTY_NOTICES.md and licenses/HarfBuzz.txt)
 */

import { Font, parseCoverage, parseClassDef } from './font.ts';
import {
    Buffer, GlyphInfo, GlyphProps, Direction, allocateLigId, generalCategory, setGeneralCategory, isDefaultIgnorable, isHidden, isZWJ, isZWNJ, isMarkGlyph,
    isBaseGlyph, isLigature, ligId, ligComp, ligNumComps, ligNumCompsInLigation, setLigPropsForLigature, setLigPropsForMark, isMultiplied, Category,
} from './buffer.ts';
import type { Plan, ShapeFont } from './shape.ts';

export const enum LookupFlag {
    RightToLeft = 0x01,
    IgnoreBaseGlyphs = 0x02,
    IgnoreLigatures = 0x04,
    IgnoreMarks = 0x08,
    IgnoreFlags = 0x0e,
    UseMarkFilteringSet = 0x10,
    MarkAttachmentType = 0xff00,
}

export const enum AttachType { NONE = 0, MARK = 1, CURSIVE = 2 }

const MAX_NESTING_LEVEL = 64;
const MAX_CONTEXT_LENGTH = 64;

const tagAt = (font: Font, offset: number): string =>
    String.fromCharCode(font.u8(offset), font.u8(offset + 1), font.u8(offset + 2), font.u8(offset + 3));

// a set membership test: a coverage turned into a boolean
const covered = (font: Font, offset: number): (glyph: number) => boolean => {
    const coverage = parseCoverage(font, offset);
    return glyph => coverage(glyph) >= 0;
};

/** glyph classes and mark sets */
export class GDEF {
    readonly hasGlyphClasses: boolean;
    private glyphClass: (glyph: number) => number = () => 0;
    private markAttachClass: (glyph: number) => number = () => 0;
    private markSets: Array<(glyph: number) => boolean> = [];
    private cache = new Map<number, number>();

    constructor(font: Font) {
        const gdef = font.tables.GDEF?.offset;
        this.hasGlyphClasses = gdef !== undefined && font.u16(gdef + 4) !== 0;
        if (gdef === undefined) return;
        if (font.u16(gdef + 4)) this.glyphClass = parseClassDef(font, gdef + font.u16(gdef + 4));
        if (font.u16(gdef + 10)) this.markAttachClass = parseClassDef(font, gdef + font.u16(gdef + 10));
        const version = font.u32(gdef);
        if (version >= 0x00010002 && font.u16(gdef + 12)) {
            const sets = gdef + font.u16(gdef + 12);
            for (let i = 0, count = font.u16(sets + 2); i < count; i++) this.markSets.push(covered(font, sets + font.u32(sets + 4 + i * 4)));
        }
    }

    glyphProps(glyph: number): number {
        let props = this.cache.get(glyph);
        if (props !== undefined) return props;
        switch (this.glyphClass(glyph)) {
            case 1: props = GlyphProps.BASE; break;
            case 2: props = GlyphProps.LIGATURE; break;
            case 3: props = GlyphProps.MARK | this.markAttachClass(glyph) << 8; break;
            default: props = 0;
        }
        this.cache.set(glyph, props);
        return props;
    }

    markSetCovers(set: number, glyph: number): boolean {
        return this.markSets[set](glyph);
    }

    sanitizeLookupProps(props: number): number {
        if (props & LookupFlag.UseMarkFilteringSet && props >>> 16 >= this.markSets.length) props &= ~LookupFlag.UseMarkFilteringSet;
        return props;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// lookup application

// a subtable applied at the buffer's position: whether it applied
type Subtable = (c: ApplyContext) => boolean;

// a parsed subtable: how it applies, the glyphs it starts at, and whether it would substitute a whole glyph sequence
interface Parsed {
    apply: Subtable;
    coverage: (glyph: number) => boolean;
    would?: (glyphs: number[], zeroContext: boolean) => boolean;
}

export interface Lookup {
    type: number;
    /** whether a subtable would substitute exactly these glyphs (hb_ot_layout_lookup_would_substitute) */
    would: (glyphs: number[], zeroContext: boolean) => boolean;
    props: number;
    subtables: Subtable[];
    /** whether any subtable can apply at the glyph */
    covers: (glyph: number) => boolean;
    reverse: boolean;
}

type MatchFunc = (info: GlyphInfo, value: number) => boolean;

const enum MayMatch { NO, YES, MAYBE }
const enum MaySkip { NO, YES, MAYBE }
const enum Match { MATCH, NOT_MATCH, SKIP }

class SkippingIterator {
    idx = 0;
    end = 0;
    lookupProps = 0;
    mask = -1;
    ignoreZWNJ = false;
    ignoreZWJ = false;
    ignoreHidden = false;
    perSyllable = false;
    syllable = 0;
    matchFunc: MatchFunc | null = null;
    data: ArrayLike<number> | null = null;
    dataIndex = 0;

    constructor(private c: ApplyContext, private contextMatch: boolean) {}

    init(): void {
        const c = this.c;
        this.end = c.buffer.len;
        this.matchFunc = null;
        this.data = null;
        this.lookupProps = c.lookupProps;
        this.ignoreZWNJ = c.tableIndex === 1 || this.contextMatch && c.autoZWNJ;
        this.ignoreZWJ = this.contextMatch || c.autoZWJ;
        this.ignoreHidden = c.tableIndex === 1;
        this.mask = this.contextMatch ? -1 : c.lookupMask;
        this.perSyllable = c.tableIndex === 0 && c.perSyllable;
        this.syllable = 0;
    }

    setMatchFunc(func: MatchFunc | null, data: ArrayLike<number> | null): void {
        this.matchFunc = func;
        this.data = data;
        this.dataIndex = 0;
    }

    reset(start: number): void {
        this.idx = start;
        this.end = this.c.buffer.len;
        this.syllable = this.c.buffer.cur().syllable;
    }

    resetBack(start: number): void {
        this.idx = start;
        this.syllable = this.c.buffer.cur().syllable;
    }

    resetFast(start: number): void {
        this.idx = start;
    }

    maySkip(info: GlyphInfo): MaySkip {
        if (!this.c.checkGlyphProperty(info, this.lookupProps)) return MaySkip.YES;
        if (isDefaultIgnorable(info) && (this.ignoreZWNJ || !isZWNJ(info)) && (this.ignoreZWJ || !isZWJ(info)) && (this.ignoreHidden || !isHidden(info)))
            return MaySkip.MAYBE;
        return MaySkip.NO;
    }

    private mayMatch(info: GlyphInfo): MayMatch {
        if (!(info.mask & this.mask) || this.perSyllable && this.syllable && this.syllable !== info.syllable) return MayMatch.NO;
        if (this.matchFunc) return this.matchFunc(info, this.data ? this.data[this.dataIndex] : 0) ? MayMatch.YES : MayMatch.NO;
        return MayMatch.MAYBE;
    }

    match(info: GlyphInfo): Match {
        const skip = this.maySkip(info);
        if (skip === MaySkip.YES) return Match.SKIP;
        const match = this.mayMatch(info);
        if (match === MayMatch.YES || match === MayMatch.MAYBE && skip === MaySkip.NO) return Match.MATCH;
        if (skip === MaySkip.NO) return Match.NOT_MATCH;
        return Match.SKIP;
    }

    next(): boolean {
        const info = this.c.buffer.info;
        const stop = this.end - 1;
        while (this.idx < stop) {
            this.idx++;
            const m = this.match(info[this.idx]);
            if (m === Match.MATCH) {
                this.dataIndex++;
                return true;
            }
            if (m === Match.NOT_MATCH) return false;
        }
        return false;
    }

    prev(): boolean {
        const buffer = this.c.buffer, info = buffer.haveOutput ? buffer.outInfo : buffer.info;
        while (this.idx > 0) {
            this.idx--;
            const m = this.match(info[this.idx]);
            if (m === Match.MATCH) {
                this.dataIndex++;
                return true;
            }
            if (m === Match.NOT_MATCH) return false;
        }
        return false;
    }
}

export class ApplyContext {
    lookupMask = 1;
    lookupIndex = -1;
    lookupProps = 0;
    nestingLevelLeft = MAX_NESTING_LEVEL;
    autoZWNJ = true;
    autoZWJ = true;
    perSyllable = false;
    random = false;
    /** the syllable substituted glyphs get, -1 to keep theirs */
    newSyllables = -1;
    lastBase = -1;
    lastBaseUntil = 0;
    matchPositions: number[] = [];
    readonly iterInput: SkippingIterator;
    readonly iterContext: SkippingIterator;
    readonly direction: Direction;
    randomState = 1;

    constructor(readonly tableIndex: 0 | 1, readonly table: LayoutTable | null, readonly buffer: Buffer, readonly gdef: GDEF) {
        this.direction = buffer.direction;
        this.iterInput = new SkippingIterator(this, false);
        this.iterContext = new SkippingIterator(this, true);
        this.initIters();
    }

    initIters(): void {
        this.iterInput.init();
        this.iterContext.init();
    }

    setLookupProps(props: number): void {
        this.lookupProps = this.gdef.sanitizeLookupProps(props);
        this.initIters();
    }

    randomNumber(): number {
        this.randomState = this.randomState * 48271 % 2147483647;
        return this.randomState;
    }

    recurse(lookupIndex: number): boolean {
        if (!this.nestingLevelLeft) {
            this.buffer.successful = false;
            return false;
        }
        if (--this.buffer.maxOps < 0) {
            this.buffer.successful = false;
            return false;
        }
        const l = this.table && this.table.lookup(lookupIndex);
        if (!l) return false;
        this.nestingLevelLeft--;
        const savedProps = this.lookupProps, savedIndex = this.lookupIndex, savedPositions = this.matchPositions;
        this.lookupIndex = lookupIndex;
        this.setLookupProps(l.props);
        this.matchPositions = [];
        let applied = false;
        for (const subtable of l.subtables) if (subtable(this)) {
            applied = true;
            break;
        }
        this.lookupIndex = savedIndex;
        this.setLookupProps(savedProps);
        this.matchPositions = savedPositions;
        this.nestingLevelLeft++;
        return applied;
    }

    private matchPropertiesMark(info: GlyphInfo, glyphProps: number, matchProps: number): boolean {
        if (matchProps & LookupFlag.UseMarkFilteringSet) return this.gdef.markSetCovers(matchProps >>> 16, info.codepoint);
        if (matchProps & LookupFlag.MarkAttachmentType) return (matchProps & LookupFlag.MarkAttachmentType) === (glyphProps & LookupFlag.MarkAttachmentType);
        return true;
    }

    checkGlyphProperty(info: GlyphInfo, matchProps: number): boolean {
        const glyphProps = info.glyphProps;
        if (glyphProps & matchProps & LookupFlag.IgnoreFlags) return false;
        if (glyphProps & GlyphProps.MARK) return this.matchPropertiesMark(info, glyphProps, matchProps);
        return true;
    }

    private setGlyphClass(glyph: number, classGuess = 0, ligature = false, component = false): void {
        const cur = this.buffer.cur();
        if (this.newSyllables !== -1) cur.syllable = this.newSyllables;
        let props = cur.glyphProps | GlyphProps.SUBSTITUTED;
        if (ligature) props = (props | GlyphProps.LIGATED) & ~GlyphProps.MULTIPLIED;
        if (component) props |= GlyphProps.MULTIPLIED;
        if (this.gdef.hasGlyphClasses) cur.glyphProps = props & GlyphProps.PRESERVE | this.gdef.glyphProps(glyph);
        else if (classGuess) cur.glyphProps = props & GlyphProps.PRESERVE | classGuess;
        else cur.glyphProps = props;
    }

    replaceGlyph(glyph: number): void {
        this.setGlyphClass(glyph);
        this.buffer.replaceGlyph(glyph);
    }

    replaceGlyphInplace(glyph: number): void {
        this.setGlyphClass(glyph);
        this.buffer.cur().codepoint = glyph;
    }

    replaceGlyphWithLigature(glyph: number, classGuess: number): void {
        this.setGlyphClass(glyph, classGuess, true);
        this.buffer.replaceGlyph(glyph);
    }

    outputGlyphForComponent(glyph: number, classGuess: number): void {
        this.setGlyphClass(glyph, classGuess, false, true);
        this.buffer.outputGlyph(glyph);
    }
}

// matches the input sequence after the current glyph (count includes it), the end in endPosition[0]
function matchInput(c: ApplyContext, count: number, input: ArrayLike<number> | null, match: MatchFunc | null, end: number[], totalComponents?: number[]): boolean {
    const buffer = c.buffer;
    if (count === 1) {
        end[0] = buffer.idx + 1;
        c.matchPositions[0] = buffer.idx;
        if (totalComponents) totalComponents[0] = ligNumComps(buffer.cur());
        return true;
    }
    if (count > MAX_CONTEXT_LENGTH) return false;

    const it = c.iterInput;
    it.reset(buffer.idx);
    it.setMatchFunc(match, input);

    let total = 0;
    const firstLigId = ligId(buffer.cur()), firstLigComp = ligComp(buffer.cur());
    // 0 not checked, 1 may not skip, 2 may skip
    let ligbase = 0;

    for (let i = 1; i < count; i++) {
        if (!it.next()) {
            end[0] = it.idx + 1;
            return false;
        }
        c.matchPositions[i] = it.idx;
        const info = buffer.info[it.idx];
        const thisLigId = ligId(info), thisLigComp = ligComp(info);

        if (firstLigId && firstLigComp) {
            // components attached to a ligature component must all be attached to that one
            if (firstLigId !== thisLigId || firstLigComp !== thisLigComp) {
                if (!ligbase) {
                    let found = false, j = buffer.outLen;
                    const out = buffer.outInfo;
                    while (j && ligId(out[j - 1]) === firstLigId) {
                        if (ligComp(out[j - 1]) === 0) {
                            j--;
                            found = true;
                            break;
                        }
                        j--;
                    }
                    ligbase = found && it.maySkip(out[j]) === MaySkip.YES ? 2 : 1;
                }
                if (ligbase === 1) return false;
            }
        } else if (thisLigId && thisLigComp && thisLigId !== firstLigId) return false;

        total += ligNumCompsInLigation(info);
    }

    end[0] = it.idx + 1;
    if (totalComponents) totalComponents[0] = total + ligNumComps(buffer.cur());
    c.matchPositions[0] = buffer.idx;
    return true;
}

function ligateInput(c: ApplyContext, count: number, matchEnd: number, ligGlyph: number, totalComponents: number): void {
    const buffer = c.buffer, positions = c.matchPositions;
    buffer.mergeClusters(buffer.idx, matchEnd);

    let isBaseLigature = isBaseGlyph(buffer.info[positions[0]]), isMarkLigature = isMarkGlyph(buffer.info[positions[0]]);
    for (let i = 1; i < count; i++) if (!isMarkGlyph(buffer.info[positions[i]])) {
        isBaseLigature = isMarkLigature = false;
        break;
    }
    const ligature = !isBaseLigature && !isMarkLigature;

    const klass = ligature ? GlyphProps.LIGATURE : 0;
    const id = ligature ? allocateLigId(buffer) : 0;
    let lastLigId = ligId(buffer.cur());
    let lastNumComponents = ligNumComps(buffer.cur());
    let componentsSoFar = lastNumComponents;

    if (ligature) {
        setLigPropsForLigature(buffer.cur(), id, totalComponents);
        if (generalCategory(buffer.cur()) === Category.Mn) setGeneralCategory(buffer.cur(), Category.Lo);
    }
    c.replaceGlyphWithLigature(ligGlyph, klass);

    for (let i = 1; i < count; i++) {
        while (buffer.idx < positions[i] && buffer.successful) {
            if (ligature) {
                let thisComp = ligComp(buffer.cur());
                if (!thisComp) thisComp = lastNumComponents;
                setLigPropsForMark(buffer.cur(), id, componentsSoFar - lastNumComponents + Math.min(thisComp, lastNumComponents));
            }
            buffer.nextGlyph();
        }
        lastLigId = ligId(buffer.cur());
        lastNumComponents = ligNumCompsInLigation(buffer.cur());
        componentsSoFar += lastNumComponents;
        // the component is deleted
        buffer.skipGlyph();
    }

    if (!isMarkLigature && lastLigId) {
        // marks following the ligature move to the new ligature's components
        for (let i = buffer.idx; i < buffer.len; i++) {
            const info = buffer.info[i];
            if (lastLigId !== ligId(info)) break;
            const thisComp = ligComp(info);
            if (!thisComp) break;
            setLigPropsForMark(info, id, componentsSoFar - lastNumComponents + Math.min(thisComp, lastNumComponents));
        }
    }
}

function matchBacktrack(c: ApplyContext, count: number, backtrack: ArrayLike<number>, match: MatchFunc): boolean {
    if (!count) return true;
    const it = c.iterContext;
    it.resetBack(c.buffer.backtrackLen());
    it.setMatchFunc(match, backtrack);
    for (let i = 0; i < count; i++) if (!it.prev()) return false;
    return true;
}

function matchLookahead(c: ApplyContext, count: number, lookahead: ArrayLike<number>, match: MatchFunc, start: number): boolean {
    if (!count) return true;
    const it = c.iterContext;
    it.reset(start - 1);
    it.setMatchFunc(match, lookahead);
    for (let i = 0; i < count; i++) if (!it.next()) return false;
    return true;
}

// applies the (sequence index, lookup index) records to the matched input
function applyLookup(c: ApplyContext, count: number, records: ArrayLike<number>, matchEnd: number): void {
    const buffer = c.buffer, positions = c.matchPositions;
    // positions are relative to the output from here on
    const bl = buffer.backtrackLen();
    let end = bl + matchEnd - buffer.idx;
    const delta0 = bl - buffer.idx;
    for (let j = 0; j < count; j++) positions[j] += delta0;

    for (let i = 0; i < records.length && buffer.successful; i += 2) {
        const idx = records[i];
        if (idx >= count) continue;
        const origLen = buffer.backtrackLen() + buffer.lookaheadLen();
        // (earlier lookups can have deleted many glyphs)
        if (positions[idx] >= origLen) continue;
        if (!buffer.moveTo(positions[idx])) break;
        if (buffer.maxOps <= 0) break;

        if (!c.recurse(records[i + 1])) continue;

        const newLen = buffer.backtrackLen() + buffer.lookaheadLen();
        let delta = newLen - origLen;
        if (!delta) continue;

        // the length changed: glyphs were added after the position, or removed after it
        end += delta;
        if (end < positions[idx]) {
            delta += positions[idx] - end;
            end = positions[idx];
        }

        let next = idx + 1;
        if (delta > 0) {
            if (delta + count > MAX_CONTEXT_LENGTH) break;
        } else {
            delta = Math.max(delta, next - count);
            next -= delta;
        }

        // shift
        positions.copyWithin(next + delta, next, count);
        if (positions.length > count + delta) positions.length = Math.max(count + delta, 0);
        next += delta;
        count += delta;
        for (let j = idx + 1; j < next; j++) positions[j] = positions[j - 1] + 1;
        for (; next < count; next++) positions[next] += delta;
    }
    buffer.moveTo(end);
}

// ---------------------------------------------------------------------------------------------------------------------
// the GSUB/GPOS tables

const matchGlyph: MatchFunc = (info, value) => info.codepoint === value;

interface Rule {
    backtrack: number[];
    input: number[];
    lookahead: number[];
    records: number[];
}

/** a GSUB or GPOS table */
export class LayoutTable {
    private scriptList = 0;
    private featureList = 0;
    private lookupList = 0;
    readonly lookupCount: number = 0;
    private lookups = new Map<number, Lookup | null>();
    /** feature tables substituted by the feature variations that apply at the default instance */
    private substitutions = new Map<number, number>();

    constructor(readonly font: Font, readonly tag: 'GSUB' | 'GPOS', readonly offset: number) {
        const f = font;
        this.scriptList = offset + f.u16(offset + 4);
        this.featureList = offset + f.u16(offset + 6);
        this.lookupList = offset + f.u16(offset + 8);
        this.lookupCount = f.u16(this.lookupList);
        if (f.u16(offset + 2) >= 1 && f.u16(offset) === 1 && f.u32(offset + 10)) this.featureVariations(offset + f.u32(offset + 10));
    }

    // the first feature variation record whose conditions hold with all axes at their defaults
    private featureVariations(table: number): void {
        const f = this.font;
        for (let i = 0, count = f.u32(table + 4); i < count; i++) {
            const record = table + 8 + i * 8;
            const conditions = f.u32(record), substitution = f.u32(record + 4);
            let matches = true;
            if (conditions) {
                const set = table + conditions;
                for (let j = 0, n = f.u16(set); j < n && matches; j++) {
                    const condition = set + f.u32(set + 2 + j * 4);
                    // format 1: an axis range (F2DOT14), the default coordinate is 0
                    if (f.u16(condition) !== 1) matches = false;
                    else matches = f.i16(condition + 4) <= 0 && 0 <= f.i16(condition + 6);
                }
            }
            if (!matches) continue;
            if (substitution) {
                const s = table + substitution;
                for (let j = 0, n = f.u16(s + 4); j < n; j++)
                    this.substitutions.set(f.u16(s + 6 + j * 6), s + f.u32(s + 8 + j * 6));
            }
            return;
        }
    }

    findScript(tag: string): number {
        const f = this.font;
        for (let i = 0, count = f.u16(this.scriptList); i < count; i++)
            if (tagAt(f, this.scriptList + 2 + i * 6) === tag) return i;
        return -1;
    }

    /** the LangSys table of a script for the language tag 'dflt' or else the script's default, 0 if none */
    langSys(script: number): number {
        if (script < 0) return 0;
        const f = this.font;
        const s = this.scriptList + f.u16(this.scriptList + 2 + script * 6 + 4);
        for (let i = 0, count = f.u16(s + 2); i < count; i++)
            if (tagAt(f, s + 4 + i * 6) === 'dflt') return s + f.u16(s + 4 + i * 6 + 4);
        return f.u16(s) ? s + f.u16(s) : 0;
    }

    /** the required feature index (-1 if none) and the features of a LangSys: tag -> index, earlier ones win */
    langSysFeatures(langSys: number): { required: number, features: Map<string, number> } {
        const features = new Map<string, number>();
        if (!langSys) return { required: -1, features };
        const f = this.font;
        const required = f.u16(langSys + 2);
        const count = f.u16(langSys + 4);
        for (let i = count; i; i--) {
            const index = f.u16(langSys + 6 + (i - 1) * 2);
            features.set(this.featureTag(index), index);
        }
        return { required: required === 0xffff ? -1 : required, features };
    }

    featureTag(index: number): string {
        return tagAt(this.font, this.featureList + 2 + index * 6);
    }

    /** a feature found under any script */
    findFeature(tag: string): number {
        const f = this.font;
        for (let i = 0, count = f.u16(this.featureList); i < count; i++) if (this.featureTag(i) === tag) return i;
        return -1;
    }

    featureLookups(index: number): number[] {
        const f = this.font;
        if (index < 0 || index >= f.u16(this.featureList)) return [];
        const feature = this.substitutions.get(index) ?? this.featureList + f.u16(this.featureList + 2 + index * 6 + 4);
        return Array.from({ length: f.u16(feature + 2) }, (_, j) => f.u16(feature + 4 + j * 2));
    }

    lookup(index: number): Lookup | null {
        if (index >= this.lookupCount) return null;
        let l = this.lookups.get(index);
        if (l !== undefined) return l;
        const f = this.font;
        const offset = this.lookupList + f.u16(this.lookupList + 2 + index * 2);
        const lookupType = f.u16(offset), flag = f.u16(offset + 2), count = f.u16(offset + 4);
        const props = flag & LookupFlag.UseMarkFilteringSet ? flag + (f.u16(offset + 6 + count * 2) << 16) : flag;
        const subtables: Subtable[] = [], coverages: Array<(glyph: number) => boolean> = [], woulds: Array<Parsed['would']> = [];
        // extension subtables resolve to their type
        const extension = this.tag === 'GSUB' ? 7 : 9;
        let type = lookupType;
        for (let i = 0; i < count; i++) {
            let subtable = offset + f.u16(offset + 6 + i * 2);
            if (lookupType === extension) {
                type = f.u16(subtable + 2);
                subtable += f.u32(subtable + 4);
            }
            const parsed = this.tag === 'GSUB' ? this.gsubSubtable(type, subtable) : this.gposSubtable(type, subtable);
            if (!parsed) continue;
            subtables.push(parsed.apply);
            coverages.push(parsed.coverage);
            woulds.push(parsed.would);
        }
        const memo = new Map<number, boolean>();
        const covers = (glyph: number): boolean => {
            let v = memo.get(glyph);
            if (v === undefined) memo.set(glyph, v = coverages.some(c => c(glyph)));
            return v;
        };
        const would = (glyphs: number[], zeroContext: boolean): boolean =>
            glyphs.length > 0 && covers(glyphs[0]) && woulds.some(w => w !== undefined && w(glyphs, zeroContext));
        l = { type, props, subtables, covers, would, reverse: this.tag === 'GSUB' && type === 8 };
        this.lookups.set(index, l);
        return l;
    }

    // contexts: matchers per class definition or coverage, and the rules
    private context(offset: number, chained: boolean): Parsed | null {
        const f = this.font, format = f.u16(offset);
        const records = (o: number, count: number): number[] => Array.from({ length: count * 2 }, (_, j) => f.u16(o + j * 2));
        const values = (o: number, count: number): number[] => Array.from({ length: count }, (_, j) => f.u16(o + j * 2));

        const rule = (o: number): Rule => {
            if (!chained) {
                const inputCount = f.u16(o), recordCount = f.u16(o + 2);
                return { backtrack: [], input: values(o + 4, inputCount ? inputCount - 1 : 0), lookahead: [], records: records(o + 4 + Math.max(0, inputCount - 1) * 2, recordCount) };
            }
            const backtrackCount = f.u16(o);
            const backtrack = values(o + 2, backtrackCount);
            let p = o + 2 + backtrackCount * 2;
            const inputCount = f.u16(p);
            const input = values(p + 2, inputCount ? inputCount - 1 : 0);
            p += 2 + Math.max(0, inputCount - 1) * 2;
            const lookaheadCount = f.u16(p);
            const lookahead = values(p + 2, lookaheadCount);
            p += 2 + lookaheadCount * 2;
            return { backtrack, input, lookahead, records: records(p + 2, f.u16(p)) };
        };

        // whether the rule's input is exactly the glyphs (without context when zeroContext)
        const wouldRule = (glyphs: number[], zeroContext: boolean, r: Rule, match: MatchFunc): boolean => {
            if (zeroContext && (r.backtrack.length || r.lookahead.length)) return false;
            if (glyphs.length !== r.input.length + 1) return false;
            for (let i = 1; i < glyphs.length; i++) {
                const info = new GlyphInfo();
                info.codepoint = glyphs[i];
                if (!match(info, r.input[i - 1])) return false;
            }
            return true;
        };

        const applyRule = (c: ApplyContext, r: Rule, match: [MatchFunc, MatchFunc, MatchFunc]): boolean => {
            const inputCount = r.input.length + 1, end = [0];
            if (inputCount > MAX_CONTEXT_LENGTH) return false;
            if (!chained) {
                if (!matchInput(c, inputCount, r.input, match[1], end)) return false;
                applyLookup(c, inputCount, r.records, end[0]);
                return true;
            }
            if (!(matchInput(c, inputCount, r.input, match[1], end) && matchLookahead(c, r.lookahead.length, r.lookahead, match[2], end[0]))) return false;
            if (!matchBacktrack(c, r.backtrack.length, r.backtrack, match[0])) return false;
            applyLookup(c, inputCount, r.records, end[0]);
            return true;
        };

        if (format === 1 || format === 2) {
            const coverage = parseCoverage(f, offset + f.u16(offset + 2));
            let classes: Array<(glyph: number) => number>, setCount: number, sets: number;
            if (format === 1) {
                classes = [];
                setCount = f.u16(offset + 4);
                sets = offset + 6;
            } else if (!chained) {
                const classDef = parseClassDef(f, offset + f.u16(offset + 4));
                classes = [classDef, classDef, classDef];
                setCount = f.u16(offset + 6);
                sets = offset + 8;
            } else {
                classes = [0, 1, 2].map(k => f.u16(offset + 4 + k * 2) ? parseClassDef(f, offset + f.u16(offset + 4 + k * 2)) : () => 0);
                setCount = f.u16(offset + 10);
                sets = offset + 12;
            }
            const match: [MatchFunc, MatchFunc, MatchFunc] = format === 1 ? [matchGlyph, matchGlyph, matchGlyph]
                : [0, 1, 2].map(k => (info: GlyphInfo, value: number) => classes[k](info.codepoint) === value) as [MatchFunc, MatchFunc, MatchFunc];
            const cache = new Map<number, Rule[]>();
            const rulesOf = (k: number): Rule[] => {
                if (k >= setCount || !f.u16(sets + k * 2)) return [];
                let rules = cache.get(k);
                if (!rules) {
                    const set = offset + f.u16(sets + k * 2);
                    cache.set(k, rules = Array.from({ length: f.u16(set) }, (_, j) => rule(set + f.u16(set + 2 + j * 2))));
                }
                return rules;
            };
            return {
                coverage: glyph => coverage(glyph) >= 0,
                apply: c => {
                    const glyph = c.buffer.cur().codepoint, index = coverage(glyph);
                    if (index < 0) return false;
                    for (const r of rulesOf(format === 1 ? index : classes[1](glyph))) if (applyRule(c, r, match)) return true;
                    return false;
                },
                would: (glyphs, zeroContext) => {
                    const index = coverage(glyphs[0]);
                    if (format === 1 && index < 0) return false;
                    return rulesOf(format === 1 ? index : classes[1](glyphs[0])).some(r => wouldRule(glyphs, zeroContext, r, match[1]));
                },
            };
        }

        if (format === 3) {
            // coverages as offsets, matched by index into a list of tests
            const tests: Array<(glyph: number) => boolean> = [];
            const coverages = (o: number, count: number): number[] => Array.from({ length: count }, (_, j) => {
                tests.push(covered(f, offset + f.u16(o + j * 2)));
                return tests.length - 1;
            });
            const matchCoverage: MatchFunc = (info, value) => tests[value](info.codepoint);
            let r: Rule, first: number;
            if (!chained) {
                const inputCount = f.u16(offset + 2), recordCount = f.u16(offset + 4);
                const input = coverages(offset + 6, inputCount);
                if (!input.length) return null;
                first = input[0];
                r = { backtrack: [], input: input.slice(1), lookahead: [], records: records(offset + 6 + inputCount * 2, recordCount) };
            } else {
                const backtrackCount = f.u16(offset + 2);
                const backtrack = coverages(offset + 4, backtrackCount);
                let p = offset + 4 + backtrackCount * 2;
                const inputCount = f.u16(p);
                const input = coverages(p + 2, inputCount);
                if (!input.length) return null;
                p += 2 + inputCount * 2;
                const lookaheadCount = f.u16(p);
                const lookahead = coverages(p + 2, lookaheadCount);
                p += 2 + lookaheadCount * 2;
                first = input[0];
                r = { backtrack, input: input.slice(1), lookahead, records: records(p + 2, f.u16(p)) };
            }
            const firstTest = tests[first];
            return {
                coverage: firstTest,
                apply: c => firstTest(c.buffer.cur().codepoint) && applyRule(c, r, [matchCoverage, matchCoverage, matchCoverage]),
                would: (glyphs, zeroContext) => firstTest(glyphs[0]) && wouldRule(glyphs, zeroContext, r, matchCoverage),
            };
        }
        return null;
    }

    private gsubSubtable(type: number, offset: number): Parsed | null {
        const f = this.font, format = f.u16(offset);
        if (type >= 1 && type <= 4 || type === 8) {
            const coverage = parseCoverage(f, offset + f.u16(offset + 2));
            const has = (glyph: number): boolean => coverage(glyph) >= 0;
            const single = (glyphs: number[]): boolean => glyphs.length === 1 && has(glyphs[0]);
            switch (type) {
                // single
                case 1:
                    if (format === 1) {
                        const delta = f.u16(offset + 4);
                        return { coverage: has, would: single, apply: c => {
                            const glyph = c.buffer.cur().codepoint;
                            if (coverage(glyph) < 0) return false;
                            c.replaceGlyph(glyph + delta & 0xffff);
                            return true;
                        } };
                    }
                    if (format !== 2) return null;
                    return { coverage: has, would: single, apply: c => {
                        const index = coverage(c.buffer.cur().codepoint);
                        if (index < 0 || index >= f.u16(offset + 4)) return false;
                        c.replaceGlyph(f.u16(offset + 6 + index * 2));
                        return true;
                    } };

                // multiple
                case 2:
                    return { coverage: has, would: single, apply: c => {
                        const index = coverage(c.buffer.cur().codepoint);
                        if (index < 0 || index >= f.u16(offset + 4)) return false;
                        const sequence = offset + f.u16(offset + 6 + index * 2), count = f.u16(sequence);
                        const buffer = c.buffer;
                        if (count === 1) {
                            c.replaceGlyph(f.u16(sequence + 2));
                            return true;
                        }
                        if (count === 0) {
                            buffer.deleteGlyph();
                            return true;
                        }
                        const klass = isLigature(buffer.cur()) ? GlyphProps.BASE : 0;
                        const id = ligId(buffer.cur());
                        for (let i = 0; i < count; i++) {
                            // (glyphs attached to a ligature keep that)
                            if (!id) setLigPropsForMark(buffer.cur(), 0, i);
                            c.outputGlyphForComponent(f.u16(sequence + 2 + i * 2), klass);
                        }
                        buffer.skipGlyph();
                        return true;
                    } };

                // alternate: the one the feature's value picks
                case 3:
                    return { coverage: has, would: single, apply: c => {
                        const index = coverage(c.buffer.cur().codepoint);
                        if (index < 0 || index >= f.u16(offset + 4)) return false;
                        const set = offset + f.u16(offset + 6 + index * 2), count = f.u16(set);
                        if (!count) return false;
                        const mask = c.lookupMask;
                        const shift = 31 - Math.clz32(mask & -mask);
                        let alternate = (mask & c.buffer.cur().mask) >>> shift;
                        if (alternate === MAX_VALUE && c.random) alternate = c.randomNumber() % count + 1;
                        if (alternate > count || alternate === 0) return false;
                        c.replaceGlyph(f.u16(set + 2 + (alternate - 1) * 2));
                        return true;
                    } };

                // ligature
                case 4:
                    return { coverage: has, would: glyphs => {
                        const index = coverage(glyphs[0]);
                        if (index < 0 || index >= f.u16(offset + 4)) return false;
                        const set = offset + f.u16(offset + 6 + index * 2);
                        for (let i = 0, count = f.u16(set); i < count; i++) {
                            const ligature = set + f.u16(set + 2 + i * 2), components = f.u16(ligature + 2);
                            if (glyphs.length !== components) continue;
                            let k = 1;
                            while (k < components && glyphs[k] === f.u16(ligature + 2 + k * 2)) k++;
                            if (k === components) return true;
                        }
                        return false;
                    }, apply: c => {
                        const index = coverage(c.buffer.cur().codepoint);
                        if (index < 0 || index >= f.u16(offset + 4)) return false;
                        const set = offset + f.u16(offset + 6 + index * 2);
                        for (let i = 0, count = f.u16(set); i < count; i++) {
                            const ligature = set + f.u16(set + 2 + i * 2);
                            const glyph = f.u16(ligature), components = f.u16(ligature + 2);
                            if (!components) continue;
                            if (components === 1) {
                                c.replaceGlyph(glyph);
                                return true;
                            }
                            if (components > MAX_CONTEXT_LENGTH) continue;
                            const input = values16(f, ligature + 4, components - 1);
                            const end = [0], total = [0];
                            if (!matchInput(c, components, input, matchGlyph, end, total)) continue;
                            ligateInput(c, components, end[0], glyph, total[0]);
                            return true;
                        }
                        return false;
                    } };

                // reverse chaining single
                case 8: {
                    const backtrackCount = f.u16(offset + 4);
                    const tests: Array<(glyph: number) => boolean> = [];
                    const list = (o: number, count: number): number[] => Array.from({ length: count }, (_, j) => {
                        tests.push(covered(f, offset + f.u16(o + j * 2)));
                        return tests.length - 1;
                    });
                    const backtrack = list(offset + 6, backtrackCount);
                    let p = offset + 6 + backtrackCount * 2;
                    const lookaheadCount = f.u16(p);
                    const lookahead = list(p + 2, lookaheadCount);
                    p += 2 + lookaheadCount * 2;
                    const substituteCount = f.u16(p), substitutes = p + 2;
                    const matchCoverage: MatchFunc = (info, value) => tests[value](info.codepoint);
                    return { coverage: has, would: single, apply: c => {
                        const index = coverage(c.buffer.cur().codepoint);
                        if (index < 0) return false;
                        // (no chaining into this type)
                        if (c.nestingLevelLeft !== MAX_NESTING_LEVEL) return false;
                        if (index >= substituteCount) return false;
                        if (matchBacktrack(c, backtrack.length, backtrack, matchCoverage) && matchLookahead(c, lookahead.length, lookahead, matchCoverage, c.buffer.idx + 1)) {
                            c.replaceGlyphInplace(f.u16(substitutes + index * 2));
                            return true;
                        }
                        return false;
                    } };
                }
            }
        }
        if (type === 5 || type === 6) return this.context(offset, type === 6);
        return null;
    }

    private gposSubtable(type: number, offset: number): Parsed | null {
        const f = this.font, format = f.u16(offset);
        if (type === 7 || type === 8) return this.context(offset, type === 8);
        if (type < 1 || type > 6) return null;
        const coverage = parseCoverage(f, offset + f.u16(offset + 2));
        const has = (glyph: number): boolean => coverage(glyph) >= 0;

        switch (type) {
            // single adjustment
            case 1: {
                const valueFormat = f.u16(offset + 4), size = valueSize(valueFormat);
                if (format === 1) return { coverage: has, apply: c => {
                    if (coverage(c.buffer.cur().codepoint) < 0) return false;
                    applyValue(f, c, valueFormat, offset + 6, c.buffer.cur());
                    c.buffer.idx++;
                    return true;
                } };
                if (format !== 2) return null;
                return { coverage: has, apply: c => {
                    const index = coverage(c.buffer.cur().codepoint);
                    if (index < 0 || index >= f.u16(offset + 6)) return false;
                    applyValue(f, c, valueFormat, offset + 8 + index * size, c.buffer.cur());
                    c.buffer.idx++;
                    return true;
                } };
            }

            // pair adjustment
            case 2: {
                const format1 = f.u16(offset + 4), format2 = f.u16(offset + 6);
                const len1 = valueSize(format1), len2 = valueSize(format2);
                if (format === 1) {
                    const recordSize = 2 + len1 + len2;
                    return { coverage: has, apply: c => {
                        const buffer = c.buffer;
                        const index = coverage(buffer.cur().codepoint);
                        if (index < 0 || index >= f.u16(offset + 8)) return false;
                        const it = c.iterInput;
                        it.resetFast(buffer.idx);
                        it.setMatchFunc(null, null);
                        if (!it.next()) return false;
                        const pos = it.idx;
                        const set = offset + f.u16(offset + 10 + index * 2), count = f.u16(set);
                        // binary search for the second glyph
                        const second = buffer.info[pos].codepoint;
                        let lo = 0, hi = count - 1, record = -1;
                        while (lo <= hi) {
                            const mid = lo + hi >> 1, g = f.u16(set + 2 + mid * recordSize);
                            if (g < second) lo = mid + 1;
                            else if (g > second) hi = mid - 1;
                            else {
                                record = set + 2 + mid * recordSize;
                                break;
                            }
                        }
                        if (record < 0) return false;
                        if (len1) applyValue(f, c, format1, record + 2, buffer.cur(), set);
                        if (len2) applyValue(f, c, format2, record + 2 + len1, buffer.info[pos], set);
                        buffer.idx = len2 ? pos + 1 : pos;
                        return true;
                    } };
                }
                if (format !== 2) return null;
                const class1 = parseClassDef(f, offset + f.u16(offset + 8)), class2 = parseClassDef(f, offset + f.u16(offset + 10));
                const class1Count = f.u16(offset + 12), class2Count = f.u16(offset + 14), records = offset + 16;
                return { coverage: has, apply: c => {
                    const buffer = c.buffer;
                    if (coverage(buffer.cur().codepoint) < 0) return false;
                    const it = c.iterInput;
                    it.resetFast(buffer.idx);
                    it.setMatchFunc(null, null);
                    if (!it.next()) return false;
                    const pos = it.idx;
                    const k1 = class1(buffer.cur().codepoint), k2 = class2(buffer.info[pos].codepoint);
                    if (k1 >= class1Count || k2 >= class2Count) return false;
                    const v = records + (k1 * class2Count + k2) * (len1 + len2);
                    if (len1) applyValue(f, c, format1, v, buffer.cur());
                    if (len2) applyValue(f, c, format2, v + len1, buffer.info[pos]);
                    buffer.idx = len2 ? pos + 1 : pos;
                    return true;
                } };
            }

            // cursive attachment
            case 3: {
                const count = f.u16(offset + 4);
                const anchorOf = (index: number, entry: boolean): number => {
                    if (index < 0 || index >= count) return 0;
                    const o = f.u16(offset + 6 + index * 4 + (entry ? 0 : 2));
                    return o ? offset + o : 0;
                };
                return { coverage: has, apply: c => {
                    const buffer = c.buffer, info = buffer.info;
                    const entry = anchorOf(coverage(buffer.cur().codepoint), true);
                    if (!entry) return false;
                    const it = c.iterInput;
                    it.resetFast(buffer.idx);
                    it.setMatchFunc(null, null);
                    if (!it.prev()) return false;
                    const exit = anchorOf(coverage(info[it.idx].codepoint), false);
                    if (!exit) return false;

                    const i = it.idx, j = buffer.idx;
                    const [exitX, exitY] = anchor(f, exit), [entryX, entryY] = anchor(f, entry);
                    if (c.direction === Direction.LTR) {
                        info[i].xAdvance = exitX + info[i].xOffset;
                        const d = entryX + info[j].xOffset;
                        info[j].xAdvance -= d;
                        info[j].xOffset -= d;
                    } else {
                        const d = exitX + info[i].xOffset;
                        info[i].xAdvance -= d;
                        info[i].xOffset -= d;
                        info[j].xAdvance = entryX + info[j].xOffset;
                    }

                    // the child aligns itself with the parent (for right to left lookups, the earlier glyph is the child)
                    let child = i, parent = j, yOffset = entryY - exitY;
                    if (!(c.lookupProps & LookupFlag.RightToLeft)) {
                        child = j;
                        parent = i;
                        yOffset = -yOffset;
                    }
                    reverseCursiveMinorOffset(info, child, parent, 0);
                    info[child].attachChain = parent - child;
                    info[child].attachType = AttachType.CURSIVE;
                    buffer.hasAttachment = true;
                    info[child].yOffset = yOffset;
                    // if the parent was attached to the child, they separate
                    if (info[parent].attachChain === -info[child].attachChain) {
                        info[parent].attachChain = 0;
                        info[parent].yOffset = 0;
                    }
                    buffer.idx++;
                    return true;
                } };
            }

            // mark to base, mark to ligature
            case 4:
            case 5: {
                const baseCoverage = parseCoverage(f, offset + f.u16(offset + 4));
                const classCount = f.u16(offset + 6);
                const markArray = offset + f.u16(offset + 8), baseArray = offset + f.u16(offset + 10);
                const ligature = type === 5;
                // only the first of a multiple substitution's glyphs takes marks (unless it ligated); for mark to
                // base, others too where a mark separates them from the sequence before
                const accept = (info: GlyphInfo[], i: number): boolean => {
                    if (!isMultiplied(info[i]) || ligComp(info[i]) === 0) return true;
                    if (ligature) return false;
                    return i === 0 || isMarkGlyph(info[i - 1]) || !isMultiplied(info[i - 1]) || ligId(info[i]) !== ligId(info[i - 1])
                        || ligComp(info[i]) !== ligComp(info[i - 1]) + 1;
                };
                return { coverage: has, apply: c => {
                    const buffer = c.buffer, info = buffer.info;
                    const markIndex = coverage(buffer.cur().codepoint);
                    if (markIndex < 0) return false;
                    // the base: the closest glyph before that isn't a mark
                    const it = c.iterInput;
                    it.lookupProps = LookupFlag.IgnoreMarks;
                    it.setMatchFunc(null, null);
                    if (c.lastBaseUntil > buffer.idx) {
                        c.lastBaseUntil = 0;
                        c.lastBase = -1;
                    }
                    for (let j = buffer.idx; j > c.lastBaseUntil; j--) {
                        let m = it.match(info[j - 1]);
                        if (m === Match.MATCH && !accept(info, j - 1) && baseCoverage(info[j - 1].codepoint) < 0) m = Match.SKIP;
                        if (m === Match.MATCH) {
                            c.lastBase = j - 1;
                            break;
                        }
                    }
                    c.lastBaseUntil = buffer.idx;
                    if (c.lastBase === -1) return false;
                    const idx = c.lastBase;
                    const baseIndex = baseCoverage(info[idx].codepoint);
                    if (baseIndex < 0) return false;
                    if (!ligature) return markAttach(f, c, markArray, markIndex, baseArray, baseIndex, classCount, idx);

                    // a ligature's component: the mark's if it belongs to this ligature, else the last
                    if (baseIndex >= f.u16(baseArray)) return false;
                    const attach = baseArray + f.u16(baseArray + 2 + baseIndex * 2), components = f.u16(attach);
                    if (!components) return false;
                    const id = ligId(info[idx]), markId = ligId(buffer.cur()), markComp = ligComp(buffer.cur());
                    const component = id && id === markId && markComp > 0 ? Math.min(components, markComp) - 1 : components - 1;
                    return markAttach(f, c, markArray, markIndex, attach, component, classCount, idx);
                } };
            }

            // mark to mark
            case 6: {
                const mark2Coverage = parseCoverage(f, offset + f.u16(offset + 4));
                const classCount = f.u16(offset + 6);
                const mark1Array = offset + f.u16(offset + 8), mark2Array = offset + f.u16(offset + 10);
                return { coverage: has, apply: c => {
                    const buffer = c.buffer, info = buffer.info;
                    const mark1Index = coverage(buffer.cur().codepoint);
                    if (mark1Index < 0) return false;
                    // the previous mark, up to a glyph that isn't one
                    const it = c.iterInput;
                    it.resetFast(buffer.idx);
                    it.lookupProps = c.lookupProps & ~LookupFlag.IgnoreFlags;
                    it.setMatchFunc(null, null);
                    if (!it.prev()) return false;
                    if (!isMarkGlyph(info[it.idx])) return false;
                    const j = it.idx;
                    const id1 = ligId(buffer.cur()), id2 = ligId(info[j]), comp1 = ligComp(buffer.cur()), comp2 = ligComp(info[j]);
                    let good = false;
                    if (id1 === id2) good = id1 === 0 || comp1 === comp2;
                    else good = id1 > 0 && !comp1 || id2 > 0 && !comp2;
                    if (!good) return false;
                    const mark2Index = mark2Coverage(info[j].codepoint);
                    if (mark2Index < 0) return false;
                    return markAttach(f, c, mark1Array, mark1Index, mark2Array, mark2Index, classCount, j);
                } };
            }
        }
        return null;
    }
}

/**
 * A substitution lookup made in code (single substitutions, or ligatures by first glyph: [components after it,
 * ligature] in order), like the ones HarfBuzz synthesizes for Arabic fonts without shaping features
 */
export function syntheticLookup(props: number, single: Map<number, number> | null, ligatures: Map<number, Array<[number[], number]>> | null): Lookup {
    const covers = (glyph: number): boolean => !!(single && single.has(glyph) || ligatures && ligatures.has(glyph));
    const apply: Subtable = c => {
        const glyph = c.buffer.cur().codepoint;
        if (single) {
            const s = single.get(glyph);
            if (s === undefined) return false;
            c.replaceGlyph(s);
            return true;
        }
        for (const [components, ligature] of ligatures?.get(glyph) ?? []) {
            const count = components.length + 1, end = [0], total = [0];
            if (!matchInput(c, count, components, matchGlyph, end, total)) continue;
            ligateInput(c, count, end[0], ligature, total[0]);
            return true;
        }
        return false;
    };
    return { type: single ? 1 : 4, props, subtables: [apply], covers, would: () => false, reverse: false };
}

/** applies a lookup by itself, to the glyphs with the mask */
export function applySynthetic(buffer: Buffer, gdef: GDEF, l: Lookup, mask: number): void {
    const c = new ApplyContext(0, null, buffer, gdef);
    c.lookupMask = mask;
    c.setLookupProps(l.props);
    applyString(c, l, 0);
}

const values16 = (f: Font, o: number, count: number): number[] => Array.from({ length: count }, (_, j) => f.u16(o + j * 2));

// the most bits a feature's value takes (HB_OT_MAP_MAX_BITS)
const MAX_BITS = 8;
const MAX_VALUE = (1 << MAX_BITS) - 1;

const valueSize = (format: number): number => {
    let n = 0;
    for (let v = format & 0xff; v; v >>= 1) n += v & 1;
    return n * 2;
};

// a value record's placement and advance (device tables don't apply without a pixel size or variations)
function applyValue(f: Font, c: ApplyContext, format: number, offset: number, info: GlyphInfo, _base?: number): void {
    if (format & 1) info.xOffset += f.i16(offset), offset += 2;
    if (format & 2) info.yOffset += f.i16(offset), offset += 2;
    if (format & 4) {
        info.xAdvance += f.i16(offset);
        offset += 2;
    }
    void c;
}

function anchor(f: Font, offset: number): [number, number] {
    return [f.i16(offset + 2), f.i16(offset + 4)];
}

// the anchor of a mark array's record for a base (anchor matrix row), attaches the current mark to the glyph at
// position glyphPos
function markAttach(f: Font, c: ApplyContext, markArray: number, markIndex: number, anchors: number, row: number, classCount: number, glyphPos: number): boolean {
    const buffer = c.buffer, info = buffer.info;
    if (markIndex >= f.u16(markArray)) return false;
    const record = markArray + 2 + markIndex * 4;
    const markClass = f.u16(record), markAnchor = markArray + f.u16(record + 2);
    if (row >= f.u16(anchors) || markClass >= classCount) return false;
    const o = f.u16(anchors + 2 + (row * classCount + markClass) * 2);
    // (no anchor for this class: later subtables can have one)
    if (!o) return false;
    const [markX, markY] = anchor(f, markAnchor), [baseX, baseY] = anchor(f, anchors + o);

    const baseOffset = resolveCrossOffset(info, glyphPos);
    const mark = buffer.cur();
    mark.attachChain = glyphPos - buffer.idx;
    mark.attachType = AttachType.MARK;
    mark.xOffset = baseX - markX;
    mark.yOffset = baseY - markY + baseOffset;
    buffer.hasAttachment = true;
    buffer.idx++;
    return true;
}

// the cross-stream offset of a glyph including the cursive chain it hangs on
function resolveCrossOffset(info: GlyphInfo[], glyphPos: number): number {
    let offset = info[glyphPos].yOffset;
    while (info[glyphPos].attachType & AttachType.CURSIVE) {
        const chain = info[glyphPos].attachChain;
        if (!chain) break;
        const parent = glyphPos + chain;
        if (parent < 0 || parent >= info.length) break;
        glyphPos = parent;
        offset += info[glyphPos].yOffset;
    }
    return offset;
}

function reverseCursiveMinorOffset(info: GlyphInfo[], i: number, newParent: number, level: number): void {
    if (level > MAX_NESTING_LEVEL) return;
    const chain = info[i].attachChain, type = info[i].attachType;
    if (!chain || !(type & AttachType.CURSIVE)) return;
    info[i].attachChain = 0;
    const j = i + chain;
    if (j < 0 || j >= info.length || j === newParent) return;
    reverseCursiveMinorOffset(info, j, newParent, level + 1);
    info[j].yOffset = -info[i].yOffset;
    info[j].attachChain = -chain;
    info[j].attachType = type;
}

/** adds the offsets of the glyphs attached glyphs hang on (GPOS::position_finish_offsets) */
export function propagateAttachmentOffsets(buffer: Buffer): void {
    if (!buffer.hasAttachment) return;
    const info = buffer.info, len = info.length, forward = buffer.direction === Direction.LTR;
    const propagate = (i: number, level: number): void => {
        const chain = info[i].attachChain, type = info[i].attachType;
        info[i].attachChain = 0;
        const j = i + chain;
        if (j < 0 || j >= len || !level) return;
        if (info[j].attachChain) propagate(j, level - 1);
        if (type & AttachType.CURSIVE) info[i].yOffset += info[j].yOffset;
        else {
            info[i].xOffset += info[j].xOffset;
            if (j < i) {
                if (forward) for (let k = j; k < i; k++) {
                    info[i].xOffset -= info[k].xAdvance;
                    info[i].yOffset -= info[k].yAdvance;
                }
                else for (let k = j + 1; k < i + 1; k++) {
                    info[i].xOffset += info[k].xAdvance;
                    info[i].yOffset += info[k].yAdvance;
                }
            } else {
                if (forward) for (let k = i; k < j; k++) {
                    info[i].xOffset += info[k].xAdvance;
                    info[i].yOffset += info[k].yAdvance;
                }
                else for (let k = i + 1; k < j + 1; k++) {
                    info[i].xOffset -= info[k].xAdvance;
                    info[i].yOffset -= info[k].yAdvance;
                }
            }
        }
    };
    if (forward) {
        for (let i = 0; i < len; i++) if (info[i].attachChain) propagate(i, MAX_NESTING_LEVEL);
    } else for (let i = len; i-- > 0;) if (info[i].attachChain) propagate(i, MAX_NESTING_LEVEL);
}

// ---------------------------------------------------------------------------------------------------------------------
// the feature map

export const enum FeatureFlags {
    NONE = 0,
    GLOBAL = 0x01,
    HAS_FALLBACK = 0x02,
    MANUAL_ZWNJ = 0x04,
    MANUAL_ZWJ = 0x08,
    MANUAL_JOINERS = MANUAL_ZWNJ | MANUAL_ZWJ,
    GLOBAL_MANUAL_JOINERS = GLOBAL | MANUAL_JOINERS,
    GLOBAL_HAS_FALLBACK = GLOBAL | HAS_FALLBACK,
    GLOBAL_SEARCH = 0x10,
    RANDOM = 0x20,
    PER_SYLLABLE = 0x40,
}

/** a function run between stages (it can change the buffer) */
export type PauseFunc = (plan: Plan, font: ShapeFont, buffer: Buffer) => void;

interface FeatureInfo {
    tag: string;
    seq: number;
    maxValue: number;
    flags: number;
    defaultValue: number;
    stage: [number, number];
}

interface FeatureMap {
    tag: string;
    index: [number, number];
    stage: [number, number];
    shift: number;
    mask: number;
    oneMask: number;
    needsFallback: boolean;
    autoZWNJ: boolean;
    autoZWJ: boolean;
    random: boolean;
    perSyllable: boolean;
}

interface LookupMap {
    index: number;
    mask: number;
    autoZWNJ: boolean;
    autoZWJ: boolean;
    random: boolean;
    perSyllable: boolean;
    tag: string;
}

const GLOBAL_BIT_SHIFT = 31;
const GLOBAL_BIT_MASK = 1 << GLOBAL_BIT_SHIFT;
// the first bit HarfBuzz gives features (after its glyph flags)
const FIRST_BIT = 4;

/** the shaping plan's features and lookups for a font, script and direction */
export class OTMap {
    globalMask = GLOBAL_BIT_MASK;
    features: FeatureMap[] = [];
    lookups: [LookupMap[], LookupMap[]] = [[], []];
    stages: [Array<{ lastLookup: number, pause: PauseFunc | null }>, Array<{ lastLookup: number, pause: PauseFunc | null }>] = [[], []];
    chosenScript: [string, string] = ['', ''];
    foundScript: [boolean, boolean] = [false, false];

    private feature(tag: string): FeatureMap | undefined {
        return this.features.find(f => f.tag === tag);
    }

    getMask(tag: string): [number, number] {
        const f = this.feature(tag);
        return f ? [f.mask, f.shift] : [0, 0];
    }

    get1Mask(tag: string): number {
        return this.feature(tag)?.oneMask ?? 0;
    }

    needsFallback(tag: string): boolean {
        return this.feature(tag)?.needsFallback ?? false;
    }

    featureIndex(table: 0 | 1, tag: string): number {
        return this.feature(tag)?.index[table] ?? -1;
    }

    /** the lookups of a feature's stage (hb_ot_map_t::get_stage_lookups of get_feature_stage) */
    stageLookups(table: 0 | 1, tag: string): LookupMap[] {
        const f = this.feature(tag);
        if (!f) return [];
        const stage = f.stage[table], stages = this.stages[table];
        if (stage > stages.length) return [];
        const start = stage ? stages[stage - 1].lastLookup : 0;
        const end = stage < stages.length ? stages[stage].lastLookup : this.lookups[table].length;
        return this.lookups[table].slice(start, end);
    }

    /** applies the GSUB (0) or GPOS (1) lookups by stage */
    apply(table: 0 | 1, layout: LayoutTable | null, buffer: Buffer, gdef: GDEF, plan: Plan, font: ShapeFont): void {
        const c = layout ? new ApplyContext(table, layout, buffer, gdef) : null;
        let i = 0;
        for (const stage of this.stages[table]) {
            for (; i < stage.lastLookup; i++) {
                const lookup = this.lookups[table][i];
                const l = layout && layout.lookup(lookup.index);
                if (!l || !c || !buffer.len || !lookup.mask) continue;
                c.lookupIndex = lookup.index;
                c.lookupMask = lookup.mask;
                c.lastBase = -1;
                c.lastBaseUntil = 0;
                c.autoZWJ = lookup.autoZWJ;
                c.autoZWNJ = lookup.autoZWNJ;
                c.random = lookup.random;
                c.perSyllable = lookup.perSyllable;
                c.setLookupProps(l.props);
                applyString(c, l, table);
            }
            if (stage.pause) stage.pause(plan, font, buffer);
        }
    }
}

function applyString(c: ApplyContext, l: Lookup, table: 0 | 1): void {
    const buffer = c.buffer;
    if (!l.reverse) {
        if (table === 0) buffer.clearOutput();
        buffer.idx = 0;
        while (buffer.successful) {
            const info = buffer.info;
            let j = buffer.idx;
            while (j < buffer.len && !(l.covers(info[j].codepoint) && info[j].mask & c.lookupMask && c.checkGlyphProperty(info[j], c.lookupProps))) j++;
            if (j > buffer.idx) buffer.nextGlyphs(j - buffer.idx);
            if (buffer.idx >= buffer.len) break;
            let applied = false;
            for (const subtable of l.subtables) if (subtable(c)) {
                applied = true;
                break;
            }
            if (!applied) buffer.nextGlyph();
        }
        if (table === 0) buffer.sync();
    } else {
        buffer.idx = buffer.len - 1;
        do {
            const cur = buffer.cur();
            if (l.covers(cur.codepoint) && cur.mask & c.lookupMask && c.checkGlyphProperty(cur, c.lookupProps))
                for (const subtable of l.subtables) if (subtable(c)) break;
            buffer.idx--;
        } while (buffer.idx >= 0);
    }
}

/** collects the features of a shaping plan (hb_ot_map_builder_t) */
export class MapBuilder {
    private featureInfos: FeatureInfo[] = [];
    private currentStage: [number, number] = [0, 0];
    private stages: [Array<{ index: number, pause: PauseFunc | null }>, Array<{ index: number, pause: PauseFunc | null }>] = [[], []];
    readonly scriptIndex: [number, number] = [-1, -1];
    readonly chosenScript: [string, string] = ['', ''];
    readonly foundScript: [boolean, boolean] = [false, false];
    private langSys: [number, number] = [0, 0];
    isSimple = true;

    constructor(readonly tables: [LayoutTable | null, LayoutTable | null], scriptTags: string[]) {
        for (const t of [0, 1] as const) {
            const table = tables[t];
            if (!table) continue;
            // the script's tags, else DFLT, dflt or latn (not found then)
            let index = -1;
            for (const tag of scriptTags) if ((index = table.findScript(tag)) >= 0) {
                this.chosenScript[t] = tag;
                this.foundScript[t] = true;
                break;
            }
            if (index < 0) for (const tag of ['DFLT', 'dflt', 'latn']) if ((index = table.findScript(tag)) >= 0) {
                this.chosenScript[t] = tag;
                break;
            }
            this.scriptIndex[t] = index;
            this.langSys[t] = table.langSys(index);
        }
    }

    addFeature(tag: string, flags = FeatureFlags.NONE, value = 1): void {
        this.featureInfos.push({ tag, seq: this.featureInfos.length + 1, maxValue: value, flags, defaultValue: flags & FeatureFlags.GLOBAL ? value : 0, stage: [...this.currentStage] as [number, number] });
    }

    enableFeature(tag: string, flags = FeatureFlags.NONE, value = 1): void {
        this.addFeature(tag, flags | FeatureFlags.GLOBAL, value);
    }

    disableFeature(tag: string): void {
        this.addFeature(tag, FeatureFlags.GLOBAL, 0);
    }

    addGsubPause(pause: PauseFunc | null): void {
        this.stages[0].push({ index: this.currentStage[0]++, pause });
    }

    addGposPause(pause: PauseFunc | null): void {
        this.stages[1].push({ index: this.currentStage[1]++, pause });
    }

    hasFeature(tag: string): boolean {
        return [0, 1].some(t => this.tables[t] && (this.tables[t] as LayoutTable).langSysFeatures(this.langSys[t]).features.has(tag));
    }

    compile(): OTMap {
        const m = new OTMap();
        m.chosenScript = [...this.chosenScript] as [string, string];
        m.foundScript = [...this.foundScript] as [boolean, boolean];

        const langSys = [0, 1].map(t => this.tables[t] ? (this.tables[t] as LayoutTable).langSysFeatures(this.langSys[t]) : { required: -1, features: new Map<string, number>() });
        const requiredTag = [0, 1].map(t => langSys[t].required >= 0 && this.tables[t] ? (this.tables[t] as LayoutTable).featureTag(langSys[t].required) : '');
        const requiredStage = [0, 0];

        // sort the features and merge duplicates
        let infos = this.featureInfos;
        if (infos.length) {
            if (!this.isSimple) infos = infos.slice().sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : a.seq - b.seq);
            const merged: FeatureInfo[] = [{ ...infos[0], stage: [...infos[0].stage] as [number, number] }];
            for (let i = 1; i < infos.length; i++) {
                const f = infos[i], j = merged[merged.length - 1];
                if (f.tag !== j.tag) {
                    merged.push({ ...f, stage: [...f.stage] as [number, number] });
                    continue;
                }
                if (f.flags & FeatureFlags.GLOBAL) {
                    j.flags |= FeatureFlags.GLOBAL;
                    j.maxValue = f.maxValue;
                    j.defaultValue = f.defaultValue;
                } else {
                    if (j.flags & FeatureFlags.GLOBAL) j.flags ^= FeatureFlags.GLOBAL;
                    j.maxValue = Math.max(j.maxValue, f.maxValue);
                }
                j.flags |= f.flags & FeatureFlags.HAS_FALLBACK;
                j.stage[0] = Math.min(j.stage[0], f.stage[0]);
                j.stage[1] = Math.min(j.stage[1], f.stage[1]);
            }
            infos = merged;
        }

        let nextBit = FIRST_BIT;
        for (const info of infos) {
            const global = info.flags & FeatureFlags.GLOBAL && info.maxValue === 1;
            const bitsNeeded = global ? 0 : Math.min(MAX_BITS, 32 - Math.clz32(info.maxValue));
            if (!info.maxValue || nextBit + bitsNeeded >= GLOBAL_BIT_SHIFT) continue;

            let found = false;
            const index: [number, number] = [-1, -1];
            for (const t of [0, 1]) {
                if (requiredTag[t] === info.tag) requiredStage[t] = info.stage[t];
                const i = langSys[t].features.get(info.tag);
                if (i !== undefined) {
                    index[t] = i;
                    found = true;
                }
            }
            if (!found && info.flags & FeatureFlags.GLOBAL_SEARCH) for (const t of [0, 1]) {
                const i = this.tables[t] ? (this.tables[t] as LayoutTable).findFeature(info.tag) : -1;
                if (i >= 0) {
                    index[t] = i;
                    found = true;
                }
            }
            if (!found && !(info.flags & FeatureFlags.HAS_FALLBACK)) continue;

            const map: FeatureMap = {
                tag: info.tag, index, stage: [...info.stage] as [number, number], shift: 0, mask: 0, oneMask: 0, needsFallback: !found,
                autoZWNJ: !(info.flags & FeatureFlags.MANUAL_ZWNJ), autoZWJ: !(info.flags & FeatureFlags.MANUAL_ZWJ),
                random: !!(info.flags & FeatureFlags.RANDOM), perSyllable: !!(info.flags & FeatureFlags.PER_SYLLABLE),
            };
            if (global) {
                map.shift = GLOBAL_BIT_SHIFT;
                map.mask = GLOBAL_BIT_MASK;
            } else {
                map.shift = nextBit;
                map.mask = (1 << nextBit + bitsNeeded) - (1 << nextBit);
                nextBit += bitsNeeded;
                m.globalMask |= info.defaultValue << map.shift & map.mask;
            }
            map.oneMask = 1 << map.shift & map.mask;
            m.features.push(map);
        }
        if (this.isSimple) m.features.sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);

        this.addGsubPause(null);
        this.addGposPause(null);

        for (const t of [0, 1] as const) {
            const table = this.tables[t];
            const lookups = m.lookups[t];
            let stageIndex = 0, lastNumLookups = 0;
            const add = (featureIndex: number, mask: number, autoZWNJ = true, autoZWJ = true, random = false, perSyllable = false, tag = ''): void => {
                if (!table || featureIndex < 0) return;
                for (const index of table.featureLookups(featureIndex)) {
                    if (index >= table.lookupCount) continue;
                    lookups.push({ index, mask, autoZWNJ, autoZWJ, random, perSyllable, tag });
                }
            };
            for (let stage = 0; stage < this.currentStage[t]; stage++) {
                if (langSys[t].required >= 0 && requiredStage[t] === stage) add(langSys[t].required, GLOBAL_BIT_MASK);
                for (const feature of m.features) if (feature.stage[t] === stage)
                    add(feature.index[t], feature.mask, feature.autoZWNJ, feature.autoZWJ, feature.random, feature.perSyllable, feature.tag);

                // sort the stage's lookups and merge duplicates
                if (lastNumLookups + 1 < lookups.length) {
                    const stageLookups = lookups.splice(lastNumLookups).sort((a, b) => a.index - b.index);
                    for (const l of stageLookups) {
                        const last = lookups.length > lastNumLookups ? lookups[lookups.length - 1] : null;
                        if (last && last.index === l.index) {
                            last.mask |= l.mask;
                            last.autoZWNJ &&= l.autoZWNJ;
                            last.autoZWJ &&= l.autoZWJ;
                        } else lookups.push({ ...l });
                    }
                }
                lastNumLookups = lookups.length;

                if (stageIndex < this.stages[t].length && this.stages[t][stageIndex].index === stage) {
                    m.stages[t].push({ lastLookup: lastNumLookups, pause: this.stages[t][stageIndex].pause });
                    stageIndex++;
                }
            }
        }
        return m;
    }
}
