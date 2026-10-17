/*!
 * The Indic shaper (Bengali, Devanagari, Gujarati, Gurmukhi, Kannada, Malayalam, Oriya, Tamil, Telugu), ported from
 * HarfBuzz (hb-ot-shaper-indic.cc, hb-ot-shaper-indic-machine.rl)
 * Copyright © 2011,2012 Google, Inc., Old MIT license (see THIRD_PARTY_NOTICES.md and licenses/HarfBuzz.txt)
 */

import { Buffer, GlyphInfo, Category as GC, isLigated, isSubstituted, isMultiplied, generalCategory, isMark, GlyphProps } from '../buffer.ts';
import { FeatureFlags } from '../layout.ts';
import { Plan, Planner, Shaper, ShapeFont, Normalization, ZeroMarks, decompose, compose, unicodeCategory } from '../shape.ts';
import { indicCategory } from '../unicode-data.ts';
import { value } from '../unicode.ts';
import { lazyScanner, cat, seq, alt, opt, star, any } from './machine.ts';
import { forEachSyllable, insertDottedCircles, vowelConstraintsPreprocess } from './syllabic.ts';

/** categories of the Indic, Khmer and Myanmar shapers */
export const enum I {
    X = 0, C = 1, V = 2, N = 3, H = 4, ZWNJ = 5, ZWJ = 6, M = 7, SM = 8, A = 9, VD = 9, PLACEHOLDER = 10, DOTTEDCIRCLE = 11, RS = 12, MPst = 13,
    Repha = 14, Ra = 15, CM = 16, Symbol = 17, CS = 18, VAbv = 20, VBlw = 21, VPre = 22, VPst = 23, Robatic = 25, Xgroup = 26, Ygroup = 27,
    IV = 2, DB = 3, GB = 10, As = 32, MH = 35, MR = 36, MW = 37, MY = 38, PT = 39, VS = 40, ML = 41, SMPst = 57,
}
const CATEGORY_NAMES: Record<string, number> = {
    X: I.X, C: I.C, V: I.V, N: I.N, H: I.H, ZWNJ: I.ZWNJ, ZWJ: I.ZWJ, M: I.M, SM: I.SM, A: I.A, VD: I.VD, PLACEHOLDER: I.PLACEHOLDER,
    DOTTEDCIRCLE: I.DOTTEDCIRCLE, RS: I.RS, MPst: I.MPst, Repha: I.Repha, Ra: I.Ra, CM: I.CM, Symbol: I.Symbol, CS: I.CS, VAbv: I.VAbv, VBlw: I.VBlw,
    VPre: I.VPre, VPst: I.VPst, Robatic: I.Robatic, Xgroup: I.Xgroup, Ygroup: I.Ygroup, IV: I.IV, DB: I.DB, GB: I.GB, As: I.As, MH: I.MH, MR: I.MR,
    MW: I.MW, MY: I.MY, PT: I.PT, VS: I.VS, ML: I.ML, SMPst: I.SMPst,
};

/** visual positions in a syllable, from left to right */
export const enum Pos {
    START, RA_TO_BECOME_REPH, PRE_M, PRE_C, BASE_C, AFTER_MAIN, ABOVE_C, BEFORE_SUB, BELOW_C, AFTER_SUB, BEFORE_POST, POST_C, AFTER_POST, SMVD, END,
}
const POSITION_NAMES: Record<string, number> = {
    START: Pos.START, RA_TO_BECOME_REPH: Pos.RA_TO_BECOME_REPH, PRE_M: Pos.PRE_M, PRE_C: Pos.PRE_C, BASE_C: Pos.BASE_C, AFTER_MAIN: Pos.AFTER_MAIN,
    ABOVE_C: Pos.ABOVE_C, BEFORE_SUB: Pos.BEFORE_SUB, BELOW_C: Pos.BELOW_C, AFTER_SUB: Pos.AFTER_SUB, BEFORE_POST: Pos.BEFORE_POST, POST_C: Pos.POST_C,
    AFTER_POST: Pos.AFTER_POST, SMVD: Pos.SMVD, END: Pos.END,
};

const properties = new Map<string, [number, number]>();
/** the category and position of a character for the Indic shapers */
export function indicProperties(u: number): [number, number] {
    const v = value(indicCategory, u);
    let p = properties.get(v);
    if (!p) {
        const [category, position] = v.split('/');
        properties.set(v, p = [CATEGORY_NAMES[category], POSITION_NAMES[position]]);
    }
    return p;
}

export function setIndicProperties(info: GlyphInfo): void {
    [info.category, info.position] = indicProperties(info.codepoint);
}

// (anything that ligated has no category anymore)
export const isOneOf = (info: GlyphInfo, categories: readonly number[]): boolean => !isLigated(info) && categories.includes(info.category);
const CONSONANTS = [I.C, I.CS, I.Ra, I.CM, I.V, I.PLACEHOLDER, I.DOTTEDCIRCLE];
const JOINERS = [I.ZWJ, I.ZWNJ];
const isConsonant = (info: GlyphInfo): boolean => isOneOf(info, CONSONANTS);
const isJoiner = (info: GlyphInfo): boolean => isOneOf(info, JOINERS);
const isHalant = (info: GlyphInfo): boolean => isOneOf(info, [I.H]);

// syllable types
const enum Syllable { CONSONANT, VOWEL, STANDALONE, SYMBOL, BROKEN, NON_INDIC }

// the syllable grammar (hb-ot-shaper-indic-machine.rl)
const findSyllables = lazyScanner(() => {
    const c = cat(I.C, I.Ra);
    const n = seq(opt(opt(cat(I.ZWNJ)), cat(I.RS)), opt(cat(I.N), opt(cat(I.N))));
    const z = cat(I.ZWJ, I.ZWNJ);
    const reph = alt(seq(cat(I.Ra), cat(I.H)), cat(I.Repha));
    const sm = cat(I.SM, I.SMPst);
    const cn = seq(c, opt(cat(I.ZWJ)), opt(n));
    const symbol = seq(cat(I.Symbol), opt(cat(I.N)));
    const matraGroup = seq(star(z), alt(cat(I.M), seq(opt(sm), cat(I.MPst))), opt(cat(I.N)), opt(cat(I.H)));
    const syllableTail = seq(opt(opt(z), sm, opt(sm), opt(cat(I.ZWNJ))), star(cat(I.A, I.VD)));
    const halantGroup = seq(opt(z), cat(I.H), opt(cat(I.ZWJ), opt(cat(I.N))));
    const finalHalantGroup = alt(halantGroup, seq(cat(I.H), cat(I.ZWNJ)));
    const medialGroup = opt(cat(I.CM));
    const halantOrMatraGroup = alt(finalHalantGroup, star(matraGroup));
    const complexSyllableTail = seq(star(halantGroup, cn), medialGroup, halantOrMatraGroup, syllableTail);
    const consonantSyllable = seq(opt(cat(I.Repha, I.CS)), cn, complexSyllableTail);
    const vowelSyllable = seq(opt(reph), cat(I.V), opt(n), alt(cat(I.ZWJ), complexSyllableTail));
    const standaloneCluster = seq(alt(seq(opt(cat(I.Repha, I.CS)), cat(I.PLACEHOLDER)), seq(opt(reph), cat(I.DOTTEDCIRCLE))), opt(n), complexSyllableTail);
    const symbolCluster = seq(symbol, syllableTail);
    const brokenCluster = seq(opt(reph), opt(n), complexSyllableTail);
    return [
        [consonantSyllable, Syllable.CONSONANT],
        [vowelSyllable, Syllable.VOWEL],
        [standaloneCluster, Syllable.STANDALONE],
        [symbolCluster, Syllable.SYMBOL],
        [cat(I.SMPst), Syllable.NON_INDIC],
        [brokenCluster, Syllable.BROKEN],
        [any, Syllable.NON_INDIC],
    ];
});

/** assigns syllables (serial << 4 | type) from a scanner, true if a broken one was found */
export function setSyllables(buffer: Buffer, syllables: Array<[number, number, number]>, broken: number): void {
    let serial = 1;
    for (const [start, end, type] of syllables) {
        for (let i = start; i < end; i++) buffer.info[i].syllable = serial << 4 | type;
        if (type === broken) buffer.hasBrokenSyllable = true;
        if (++serial === 16) serial = 1;
    }
}

const enum RephPos { AFTER_MAIN = Pos.AFTER_MAIN, BEFORE_SUB = Pos.BEFORE_SUB, AFTER_SUB = Pos.AFTER_SUB, BEFORE_POST = Pos.BEFORE_POST, AFTER_POST = Pos.AFTER_POST }
const enum RephMode { IMPLICIT, EXPLICIT, LOG_REPHA }
const enum BlwfMode { PRE_AND_POST, POST_ONLY }

interface Config {
    hasOldSpec: boolean;
    virama: number;
    rephPos: RephPos;
    rephMode: RephMode;
    blwfMode: BlwfMode;
}
const DEFAULT_CONFIG: Config = { hasOldSpec: false, virama: 0, rephPos: RephPos.BEFORE_POST, rephMode: RephMode.IMPLICIT, blwfMode: BlwfMode.PRE_AND_POST };
const CONFIGS: Record<string, Config> = {
    Deva: { hasOldSpec: true, virama: 0x094d, rephPos: RephPos.BEFORE_POST, rephMode: RephMode.IMPLICIT, blwfMode: BlwfMode.PRE_AND_POST },
    Beng: { hasOldSpec: true, virama: 0x09cd, rephPos: RephPos.AFTER_SUB, rephMode: RephMode.IMPLICIT, blwfMode: BlwfMode.PRE_AND_POST },
    Guru: { hasOldSpec: true, virama: 0x0a4d, rephPos: RephPos.BEFORE_SUB, rephMode: RephMode.IMPLICIT, blwfMode: BlwfMode.PRE_AND_POST },
    Gujr: { hasOldSpec: true, virama: 0x0acd, rephPos: RephPos.BEFORE_POST, rephMode: RephMode.IMPLICIT, blwfMode: BlwfMode.PRE_AND_POST },
    Orya: { hasOldSpec: true, virama: 0x0b4d, rephPos: RephPos.AFTER_MAIN, rephMode: RephMode.IMPLICIT, blwfMode: BlwfMode.PRE_AND_POST },
    Taml: { hasOldSpec: true, virama: 0x0bcd, rephPos: RephPos.AFTER_POST, rephMode: RephMode.IMPLICIT, blwfMode: BlwfMode.PRE_AND_POST },
    Telu: { hasOldSpec: true, virama: 0x0c4d, rephPos: RephPos.AFTER_POST, rephMode: RephMode.EXPLICIT, blwfMode: BlwfMode.POST_ONLY },
    Knda: { hasOldSpec: true, virama: 0x0ccd, rephPos: RephPos.AFTER_POST, rephMode: RephMode.IMPLICIT, blwfMode: BlwfMode.POST_ONLY },
    Mlym: { hasOldSpec: true, virama: 0x0d4d, rephPos: RephPos.AFTER_MAIN, rephMode: RephMode.LOG_REPHA, blwfMode: BlwfMode.PRE_AND_POST },
};

const FEATURES: Array<[string, number]> = [
    // basic features, one at a time after the initial reordering, per syllable
    ['nukt', FeatureFlags.GLOBAL_MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['akhn', FeatureFlags.GLOBAL_MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['rphf', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['rkrf', FeatureFlags.GLOBAL_MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['pref', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['blwf', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['abvf', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['half', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['pstf', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['vatu', FeatureFlags.GLOBAL_MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['cjct', FeatureFlags.GLOBAL_MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    // the others, all at once after the final reordering
    ['init', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['pres', FeatureFlags.GLOBAL_MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['abvs', FeatureFlags.GLOBAL_MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['blws', FeatureFlags.GLOBAL_MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['psts', FeatureFlags.GLOBAL_MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['haln', FeatureFlags.GLOBAL_MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
];
const enum F { NUKT, AKHN, RPHF, RKRF, PREF, BLWF, ABVF, HALF, PSTF, VATU, CJCT, INIT, PRES, ABVS, BLWS, PSTS, HALN, COUNT, BASIC = INIT }

/** whether the lookups of a feature's stage would substitute a glyph sequence */
export class WouldSubstitute {
    private lookups: number[];

    constructor(plan: Plan, tag: string, private zeroContext: boolean) {
        this.lookups = plan.map.stageLookups(0, tag).map(l => l.index);
    }

    would(font: ShapeFont, glyphs: number[]): boolean {
        if (!font.gsub) return false;
        for (const index of this.lookups) {
            const l = font.gsub.lookup(index);
            if (l && l.would(glyphs, this.zeroContext)) return true;
        }
        return false;
    }
}

interface IndicPlan {
    config: Config;
    isOldSpec: boolean;
    viramaGlyph: number;
    rphf: WouldSubstitute;
    pref: WouldSubstitute;
    blwf: WouldSubstitute;
    pstf: WouldSubstitute;
    vatu: WouldSubstitute;
    masks: number[];
}

function collectFeatures(planner: Planner): void {
    const map = planner.map;
    map.addGsubPause(setupSyllables);
    map.enableFeature('locl', FeatureFlags.PER_SYLLABLE);
    map.enableFeature('ccmp', FeatureFlags.PER_SYLLABLE);
    map.addGsubPause(initialReordering);
    let i = 0;
    for (; i < F.BASIC; i++) {
        map.addFeature(FEATURES[i][0], FEATURES[i][1]);
        map.addGsubPause(null);
    }
    map.addGsubPause(finalReordering);
    for (; i < F.COUNT; i++) map.addFeature(FEATURES[i][0], FEATURES[i][1]);
}

function overrideFeatures(planner: Planner): void {
    planner.map.disableFeature('liga');
    planner.map.addGsubPause(null);
}

function dataCreate(plan: Plan): IndicPlan {
    const config = CONFIGS[plan.script] ?? DEFAULT_CONFIG;
    const isOldSpec = config.hasOldSpec && plan.map.chosenScript[0][3] !== '2';
    // zero-context matching for the new specifications (Malayalam allows context in both)
    const zeroContext = !isOldSpec && plan.script !== 'Mlym';
    return {
        config, isOldSpec, viramaGlyph: -1,
        rphf: new WouldSubstitute(plan, 'rphf', zeroContext),
        pref: new WouldSubstitute(plan, 'pref', zeroContext),
        blwf: new WouldSubstitute(plan, 'blwf', zeroContext),
        pstf: new WouldSubstitute(plan, 'pstf', zeroContext),
        vatu: new WouldSubstitute(plan, 'vatu', zeroContext),
        masks: FEATURES.map(([tag, flags]) => flags & FeatureFlags.GLOBAL ? 0 : plan.map.get1Mask(tag)),
    };
}

function viramaGlyph(indic: IndicPlan, font: ShapeFont): number {
    if (indic.viramaGlyph === -1) indic.viramaGlyph = indic.config.virama ? font.glyph(indic.config.virama) : 0;
    return indic.viramaGlyph;
}

// below-base, post-base or base: matched with both Virama,Consonant (new) and Consonant,Virama (old) orders
function consonantPositionFromFace(indic: IndicPlan, consonant: number, virama: number, font: ShapeFont): number {
    const a = [virama, consonant], b = [consonant, virama];
    if (indic.blwf.would(font, a) || indic.blwf.would(font, b) || indic.vatu.would(font, a) || indic.vatu.would(font, b)) return Pos.BELOW_C;
    if (indic.pstf.would(font, a) || indic.pstf.would(font, b)) return Pos.POST_C;
    if (indic.pref.would(font, a) || indic.pref.would(font, b)) return Pos.POST_C;
    return Pos.BASE_C;
}

function setupSyllables(_plan: Plan, _font: ShapeFont, buffer: Buffer): void {
    setSyllables(buffer, findSyllables(buffer.info.map(info => info.category)), Syllable.BROKEN);
}

function initialReorderingConsonantSyllable(plan: Plan, font: ShapeFont, buffer: Buffer, start: number, end: number): void {
    const indic = plan.data as IndicPlan, info = buffer.info;

    // Kannada Ra,H,ZWJ behaves like Ra,ZWJ,H
    if (buffer.script === 'Knda' && start + 3 <= end && isOneOf(info[start], [I.Ra]) && isOneOf(info[start + 1], [I.H]) && isOneOf(info[start + 2], [I.ZWJ])) {
        buffer.mergeClusters(start + 1, start + 3);
        [info[start + 1], info[start + 2]] = [info[start + 2], info[start + 1]];
    }

    // 1. the base consonant: from the end, the first consonant without a below-base or post-base form (a starting
    // Ra,H is a reph and no candidate if there are other consonants)
    let base = end, hasReph = false;
    {
        let limit = start;
        const config = indic.config;
        if (indic.masks[F.RPHF] && start + 3 <= end
            && (config.rephMode === RephMode.IMPLICIT && !isJoiner(info[start + 2]) || config.rephMode === RephMode.EXPLICIT && info[start + 2].category === I.ZWJ)) {
            const glyphs = [info[start].codepoint, info[start + 1].codepoint, config.rephMode === RephMode.EXPLICIT ? info[start + 2].codepoint : 0];
            if (indic.rphf.would(font, glyphs.slice(0, 2)) || config.rephMode === RephMode.EXPLICIT && indic.rphf.would(font, glyphs)) {
                limit += 2;
                while (limit < end && isJoiner(info[limit])) limit++;
                base = start;
                hasReph = true;
            }
        } else if (config.rephMode === RephMode.LOG_REPHA && info[start].category === I.Repha) {
            limit += 1;
            while (limit < end && isJoiner(info[limit])) limit++;
            base = start;
            hasReph = true;
        }

        let i = end, seenBelow = false;
        do {
            i--;
            if (isConsonant(info[i])) {
                if (info[i].position !== Pos.BELOW_C && (info[i].position !== Pos.POST_C || seenBelow)) {
                    base = i;
                    break;
                }
                if (info[i].position === Pos.BELOW_C) seenBelow = true;
                base = i;
            } else if (start < i && info[i].category === I.ZWJ && info[i - 1].category === I.H) break;
            // (a ZWJ after a halant stops the search: an explicit half form)
        } while (i > limit);

        // without another consonant, no reph forms and Ra is the base
        if (hasReph && base === start && limit - base <= 2) hasReph = false;
    }

    // reorder: pre-base before the base
    for (let i = start; i < base; i++) info[i].position = Math.min(Pos.PRE_C, info[i].position);
    if (base < end) info[base].position = Pos.BASE_C;
    if (hasReph) info[start].position = Pos.RA_TO_BECOME_REPH;

    // old specifications: the first post-base halant moves after the last consonant (Kannada: unless there's one)
    if (indic.isOldSpec) {
        const disallowDoubleHalants = buffer.script === 'Knda';
        for (let i = base + 1; i < end; i++)
            if (info[i].category === I.H) {
                let j = end - 1;
                for (; j > i; j--) if (isConsonant(info[j]) || disallowDoubleHalants && info[j].category === I.H) break;
                if (info[j].category !== I.H && j > i) {
                    const t = info[i];
                    for (let k = i; k < j; k++) info[k] = info[k + 1];
                    info[j] = t;
                }
                break;
            }
    }

    // miscellaneous marks move with what's before them
    {
        let lastPos = Pos.START;
        for (let i = start; i < end; i++) {
            const category = info[i].category;
            if ([I.ZWJ, I.ZWNJ, I.N, I.RS, I.CM, I.H].includes(category)) {
                info[i].position = lastPos;
                // (the halant doesn't move with a left matra)
                if (category === I.H && info[i].position === Pos.PRE_M)
                    for (let j = i; j > start; j--)
                        if (info[j - 1].position !== Pos.PRE_M) {
                            info[i].position = info[j - 1].position;
                            break;
                        }
            } else if (info[i].position !== Pos.SMVD) {
                if (category === I.MPst && i > start && info[i - 1].category === I.SM) info[i - 1].position = info[i].position;
                lastPos = info[i].position;
            }
        }
    }

    // post-base consonants own what's before them since the last consonant or matra
    {
        let last = base;
        for (let i = base + 1; i < end; i++)
            if (isConsonant(info[i])) {
                for (let j = last + 1; j < i; j++) if (info[j].position < Pos.SMVD) info[j].position = info[i].position;
                last = i;
            } else if (info[i].category === I.M || info[i].category === I.MPst) last = i;
    }

    {
        // syllable holds the original order while sorting
        const syllable = info[start].syllable;
        for (let i = start; i < end; i++) info[i].syllable = i - start;
        const sorted = info.slice(start, end).sort((a, b) => a.position - b.position || a.syllable - b.syllable);
        for (let i = start; i < end; i++) info[i] = sorted[i - start];

        // the base again, and left matra sequences flipped
        let firstLeftMatra = end, lastLeftMatra = end;
        base = end;
        for (let i = start; i < end; i++) {
            if (info[i].position === Pos.BASE_C) {
                base = i;
                break;
            } else if (info[i].position === Pos.PRE_M) {
                if (firstLeftMatra === end) firstLeftMatra = i;
                lastLeftMatra = i;
            }
        }
        if (firstLeftMatra < lastLeftMatra) {
            buffer.reverseRange(firstLeftMatra, lastLeftMatra + 1);
            // nuktas etc. back after their matras
            let i = firstLeftMatra;
            for (let j = i; j <= lastLeftMatra; j++)
                if (info[j].category === I.M || info[j].category === I.MPst) {
                    buffer.reverseRange(i, j + 1);
                    i = j + 1;
                }
        }

        // clusters after the base merge where the order changed (all of them for the old specifications)
        if (indic.isOldSpec || end - start > 127) buffer.mergeClusters(base, end);
        else {
            for (let i = base; i < end; i++)
                if (info[i].syllable !== 255) {
                    let min = i, max = i, j = start + info[i].syllable;
                    while (j !== i) {
                        min = Math.min(min, j);
                        max = Math.max(max, j);
                        const next = start + info[j].syllable;
                        info[j].syllable = 255;
                        j = next;
                    }
                    buffer.mergeClusters(Math.max(base, min), max + 1);
                }
        }
        for (let i = start; i < end; i++) info[i].syllable = syllable;
    }

    // masks
    for (let i = start; i < end && info[i].position === Pos.RA_TO_BECOME_REPH; i++) info[i].mask |= indic.masks[F.RPHF];
    let mask = indic.masks[F.HALF];
    if (!indic.isOldSpec && indic.config.blwfMode === BlwfMode.PRE_AND_POST) mask |= indic.masks[F.BLWF];
    for (let i = start; i < base; i++) info[i].mask |= mask;
    mask = indic.masks[F.BLWF] | indic.masks[F.ABVF] | indic.masks[F.PSTF];
    for (let i = base + 1; i < end; i++) info[i].mask |= mask;

    // old specification Devanagari: an eyelash Ra (Ra,H not followed by ZWJ) before the base takes blwf
    if (indic.isOldSpec && buffer.script === 'Deva')
        for (let i = start; i + 1 < base; i++)
            if (info[i].category === I.Ra && info[i + 1].category === I.H && (i + 2 === base || info[i + 2].category !== I.ZWJ)) {
                info[i].mask |= indic.masks[F.BLWF];
                info[i + 1].mask |= indic.masks[F.BLWF];
            }

    // a Halant,Ra after the base for pre-base reordering
    const prefLength = 2;
    if (indic.masks[F.PREF] && base + prefLength < end)
        for (let i = base + 1; i + prefLength - 1 < end; i++) {
            if (indic.pref.would(font, [info[i].codepoint, info[i + 1].codepoint])) {
                for (let j = 0; j < prefLength; j++) info[i++].mask |= indic.masks[F.PREF];
                break;
            }
        }

    // a ZWNJ disables half forms before it
    for (let i = start + 1; i < end; i++)
        if (isJoiner(info[i])) {
            const nonJoiner = info[i].category === I.ZWNJ;
            let j = i;
            do {
                j--;
                if (nonJoiner) info[j].mask &= ~indic.masks[F.HALF];
            } while (j > start && !isConsonant(info[j]));
        }
}

function initialReordering(plan: Plan, font: ShapeFont, buffer: Buffer): void {
    const indic = plan.data as IndicPlan;
    // consonant positions from the font
    const virama = viramaGlyph(indic, font);
    if (virama) for (const info of buffer.info) if (info.position === Pos.BASE_C) info.position = consonantPositionFromFace(indic, info.codepoint, virama, font);
    insertDottedCircles(font, buffer, Syllable.BROKEN, I.DOTTEDCIRCLE, I.Repha, Pos.END);
    forEachSyllable(buffer, (start, end) => {
        const type = buffer.info[start].syllable & 0x0f;
        if (type === Syllable.CONSONANT || type === Syllable.VOWEL || type === Syllable.BROKEN || type === Syllable.STANDALONE)
            initialReorderingConsonantSyllable(plan, font, buffer, start, end);
    });
}

function finalReorderingSyllable(plan: Plan, buffer: Buffer, start: number, end: number): void {
    const indic = plan.data as IndicPlan, info = buffer.info;

    // halant glyphs that lost their category in a multiple substitution
    const virama = indic.viramaGlyph;
    if (virama > 0)
        for (let i = start; i < end; i++)
            if (info[i].codepoint === virama && isLigated(info[i]) && isMultiplied(info[i])) {
                info[i].category = I.H;
                info[i].glyphProps &= ~(GlyphProps.LIGATED | GlyphProps.MULTIPLIED);
            }

    let tryPref = !!indic.masks[F.PREF];
    // the base again
    let base = start;
    for (; base < end; base++)
        if (info[base].position >= Pos.BASE_C) {
            if (tryPref && base + 1 < end) {
                for (let i = base + 1; i < end; i++)
                    if (info[i].mask & indic.masks[F.PREF]) {
                        if (!(isSubstituted(info[i]) && isLigated(info[i]) && !isMultiplied(info[i]))) {
                            // a pref candidate that formed nothing: the base is around here
                            base = i;
                            while (base < end && isHalant(info[base])) base++;
                            if (base < end) info[base].position = Pos.BASE_C;
                            tryPref = false;
                        }
                        break;
                    }
                if (base === end) break;
            }
            // Malayalam skips unformed below-base forms
            if (buffer.script === 'Mlym')
                for (let i = base + 1; i < end; i++) {
                    while (i < end && isJoiner(info[i])) i++;
                    if (i === end || !isHalant(info[i])) break;
                    i++;
                    while (i < end && isJoiner(info[i])) i++;
                    if (i < end && isConsonant(info[i]) && info[i].position === Pos.BELOW_C) {
                        base = i;
                        info[base].position = Pos.BASE_C;
                    }
                }
            if (start < base && info[base].position > Pos.BASE_C) base--;
            break;
        }
    if (base === end && start < base && isOneOf(info[base - 1], [I.ZWJ])) base--;
    if (base < end) while (start < base && isOneOf(info[base], [I.N, I.H])) base--;

    // pre-base matras move after the last standalone halant (unless a ZWJ follows it), before the base
    if (start + 1 < end && start < base) {
        let newPos = base === end ? base - 2 : base - 1;
        if (buffer.script !== 'Mlym' && buffer.script !== 'Taml') {
            for (; ;) {
                while (newPos > start && !isOneOf(info[newPos], [I.M, I.MPst, I.H])) newPos--;
                if (isHalant(info[newPos]) && info[newPos].position !== Pos.PRE_M) {
                    if (newPos + 1 < end && info[newPos + 1].category === I.ZWJ && newPos > start) {
                        newPos--;
                        continue;
                    }
                } else newPos = start;
                break;
            }
        }
        if (start < newPos && info[newPos].position !== Pos.PRE_M) {
            for (let i = newPos; i > start; i--)
                if (info[i - 1].position === Pos.PRE_M) {
                    const oldPos = i - 1;
                    if (oldPos < base && base <= newPos) base--;
                    const tmp = info[oldPos];
                    for (let k = oldPos; k < newPos; k++) info[k] = info[k + 1];
                    info[newPos] = tmp;
                    buffer.mergeClusters(newPos, Math.min(end, base + 1));
                    newPos--;
                }
        } else {
            for (let i = start; i < base; i++)
                if (info[i].position === Pos.PRE_M) {
                    buffer.mergeClusters(i, Math.min(end, base + 1));
                    break;
                }
        }
    }

    // reph: moved if Ra,H ligated into it, or if an encoded repha didn't ligate
    if (start + 1 < end && info[start].position === Pos.RA_TO_BECOME_REPH
        && (info[start].category === I.Repha) !== (isLigated(info[start]) && !isMultiplied(info[start]))) {
        const rephPos = indic.config.rephPos;
        let newRephPos = -1;
        // after the first explicit halant between the reph and the main consonant (and a joiner after it)
        const afterHalant = (): number => {
            let p = start + 1;
            while (p < base && !isHalant(info[p])) p++;
            if (p < base && isHalant(info[p])) {
                if (p + 1 < base && isJoiner(info[p + 1])) p++;
                return p;
            }
            return -1;
        };
        if (rephPos !== RephPos.AFTER_POST) newRephPos = afterHalant();
        if (newRephPos < 0 && rephPos === RephPos.AFTER_MAIN) {
            let p = base;
            while (p + 1 < end && info[p + 1].position <= Pos.AFTER_MAIN) p++;
            if (p < end) newRephPos = p;
        }
        if (newRephPos < 0 && rephPos === RephPos.AFTER_SUB) {
            let p = base;
            while (p + 1 < end && ![Pos.POST_C, Pos.AFTER_POST, Pos.SMVD].includes(info[p + 1].position)) p++;
            if (p < end) newRephPos = p;
        }
        if (newRephPos < 0) newRephPos = afterHalant();
        if (newRephPos < 0) {
            // the end of the syllable (before a matra's halant)
            newRephPos = end - 1;
            while (newRephPos > start && info[newRephPos].position === Pos.SMVD) newRephPos--;
            if (isHalant(info[newRephPos]))
                for (let i = base + 1; i < newRephPos; i++) if (info[i].category === I.M || info[i].category === I.MPst) newRephPos--;
        }
        buffer.mergeClusters(start, newRephPos + 1);
        const reph = info[start];
        for (let k = start; k < newRephPos; k++) info[k] = info[k + 1];
        info[newRephPos] = reph;
        if (start < base && base <= newRephPos) base--;
    }

    // pre-base reordering consonants (that pref formed) move like pre-base matras, else before the base
    if (tryPref && base + 1 < end)
        for (let i = base + 1; i < end; i++)
            if (info[i].mask & indic.masks[F.PREF]) {
                if (isLigated(info[i]) && !isMultiplied(info[i])) {
                    let newPos = base;
                    if (buffer.script !== 'Mlym' && buffer.script !== 'Taml')
                        while (newPos > start && !isOneOf(info[newPos - 1], [I.M, I.MPst, I.H])) newPos--;
                    if (newPos > start && isHalant(info[newPos - 1]) && newPos < end && isJoiner(info[newPos])) newPos++;
                    const oldPos = i;
                    buffer.mergeClusters(newPos, oldPos + 1);
                    const tmp = info[oldPos];
                    for (let k = oldPos; k > newPos; k--) info[k] = info[k - 1];
                    info[newPos] = tmp;
                    if (newPos <= base && base < oldPos) base++;
                }
                break;
            }

    // init for a left matra at a word start
    if (info[start].position === Pos.PRE_M) {
        const c = start ? generalCategory(info[start - 1]) : -1;
        if (!start || !(c >= GC.Cf && c <= GC.Mn)) info[start].mask |= indic.masks[F.INIT];
    }
}

function finalReordering(plan: Plan, _font: ShapeFont, buffer: Buffer): void {
    if (!buffer.len) return;
    forEachSyllable(buffer, (start, end) => finalReorderingSyllable(plan, buffer, start, end));
}

export const indicShaper: Shaper = {
    collectFeatures,
    overrideFeatures,
    dataCreate,
    preprocessText: (_plan, buffer) => vowelConstraintsPreprocess(buffer),
    decompose: (_c, ab) => {
        // (not decomposed: Devanagari RRA, Bengali RRA and RHA, Tamil AU)
        if (ab === 0x0931 || ab === 0x09dc || ab === 0x09dd || ab === 0x0b94) return null;
        return decompose(ab);
    },
    compose: (_c, a, b) => {
        // split matras don't recompose
        if (isMark(unicodeCategory(a))) return 0;
        if (a === 0x09af && b === 0x09bc) return 0x09df;
        return compose(a, b);
    },
    setupMasks: (_plan, buffer) => {
        for (const info of buffer.info) setIndicProperties(info);
    },
    normalization: Normalization.COMPOSED_DIACRITICS_NO_SHORT_CIRCUIT,
    zeroWidthMarks: ZeroMarks.NONE,
    fallbackPosition: false,
};
