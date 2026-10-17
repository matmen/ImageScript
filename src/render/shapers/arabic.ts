/*!
 * The Arabic shaper (Arabic, Syriac, and joining for Mongolian, N'Ko and others through USE), ported from HarfBuzz
 * (hb-ot-shaper-arabic.cc)
 * Copyright © 2010,2012 Google, Inc., Old MIT license (see THIRD_PARTY_NOTICES.md and licenses/HarfBuzz.txt)
 */

import { Buffer, GlyphInfo, Category, Direction, generalCategory, isDefaultIgnorable, isMultiplied, ligComp, combiningClass, setCombiningClass } from '../buffer.ts';
import { FeatureFlags, LookupFlag, Lookup, syntheticLookup, applySynthetic } from '../layout.ts';
import { Plan, Planner, Shaper, ShapeFont, Normalization, ZeroMarks, unicodeCategory } from '../shape.ts';
import { joiningType as joiningTable, ARABIC_SHAPING_FIRST, arabicShaping, arabicLigatures, arabicLigatures3, arabicMarkLigatures } from '../unicode-data.ts';
import { value } from '../unicode.ts';

const enum Joining { U = 0, L = 1, R = 2, D = 3, ALAPH = 4, DALATH_RISH = 5, T = 6 }
const JOINING: Record<string, Joining> = { U: Joining.U, L: Joining.L, R: Joining.R, D: Joining.D, C: Joining.D, T: Joining.T, ALAPH: Joining.ALAPH, DALATH_RISH: Joining.DALATH_RISH };

export const joiningType = (u: number, category: number): Joining => {
    const type = JOINING[value(joiningTable, u)];
    if (type !== undefined) return type;
    // (unlisted characters: marks and format characters are transparent)
    return category === Category.Mn || category === Category.Me || category === Category.Cf ? Joining.T : Joining.U;
};

const FEATURES = ['isol', 'fina', 'fin2', 'fin3', 'medi', 'med2', 'init'];
export const enum Action { ISOL, FINA, FIN2, FIN3, MEDI, MED2, INIT, NONE, STCH_FIXED = 8, STCH_REPEATING = 9 }
const isSyriacFeature = (tag: string): boolean => tag[3] === '2' || tag[3] === '3';

// [previous action, current action, next state] by state and joining type
const N = Action.NONE, ISOL = Action.ISOL, FINA = Action.FINA, FIN2 = Action.FIN2, FIN3 = Action.FIN3, MEDI = Action.MEDI, MED2 = Action.MED2, INIT = Action.INIT;
const STATES: Array<Array<[Action, Action, number]>> = [
    // U, L, R, D, ALAPH, DALATH_RISH
    // 0: the previous was U, not willing to join
    [[N, N, 0], [N, ISOL, 2], [N, ISOL, 1], [N, ISOL, 2], [N, ISOL, 1], [N, ISOL, 6]],
    // 1: the previous was R or ISOL/ALAPH, not willing to join
    [[N, N, 0], [N, ISOL, 2], [N, ISOL, 1], [N, ISOL, 2], [N, FIN2, 5], [N, ISOL, 6]],
    // 2: the previous was D/L in ISOL form, willing to join
    [[N, N, 0], [N, ISOL, 2], [INIT, FINA, 1], [INIT, FINA, 3], [INIT, FINA, 4], [INIT, FINA, 6]],
    // 3: the previous was D in FINA form, willing to join
    [[N, N, 0], [N, ISOL, 2], [MEDI, FINA, 1], [MEDI, FINA, 3], [MEDI, FINA, 4], [MEDI, FINA, 6]],
    // 4: the previous was FINA ALAPH, not willing to join
    [[N, N, 0], [N, ISOL, 2], [MED2, ISOL, 1], [MED2, ISOL, 2], [MED2, FIN2, 5], [MED2, ISOL, 6]],
    // 5: the previous was FIN2/FIN3 ALAPH, not willing to join
    [[N, N, 0], [N, ISOL, 2], [ISOL, ISOL, 1], [ISOL, ISOL, 2], [ISOL, FIN2, 5], [ISOL, ISOL, 6]],
    // 6: the previous was DALATH/RISH, not willing to join
    [[N, N, 0], [N, ISOL, 2], [N, ISOL, 1], [N, ISOL, 2], [N, FIN3, 5], [N, ISOL, 6]],
];

export interface ArabicPlan {
    masks: number[];
    hasStch: boolean;
    /** whether the font lacks the Arabic shaping features (presentation forms are used) */
    doFallback: boolean;
    fallback: Array<[Lookup, number]> | null;
}

// fonts without Arabic shaping features: lookups made from the presentation forms the font has, for init, medi,
// fina, isol and three rlig ligature sets
function fallbackPlan(plan: Plan, font: ShapeFont): Array<[Lookup, number]> {
    const lookups: Array<[Lookup, number]> = [];
    const features = ['init', 'medi', 'fina', 'isol', 'rlig', 'rlig', 'rlig'];
    for (let i = 0; i < features.length; i++) {
        const mask = plan.map.get1Mask(features[i]);
        if (!mask) continue;
        let lookup: Lookup | null = null;
        if (i < 4) {
            const single = new Map<number, number>();
            for (let k = 0; k < arabicShaping.length / 4; k++) {
                const u = ARABIC_SHAPING_FIRST + k, s = arabicShaping[k * 4 + i];
                const ug = font.glyph(u), sg = s && font.glyph(s);
                if (!s || !ug || !sg || ug === sg) continue;
                if (!single.has(ug)) single.set(ug, sg);
            }
            if (single.size) lookup = syntheticLookup(LookupFlag.IgnoreMarks, single, null);
        } else {
            const table = i === 4 ? arabicLigatures3 : i === 5 ? arabicLigatures : arabicMarkLigatures;
            const ligatures = new Map<number, Array<[number[], number]>>();
            for (const [first, list] of table) {
                const fg = font.glyph(first);
                if (!fg) continue;
                for (const entry of list) {
                    const lg = font.glyph(entry[entry.length - 1]);
                    if (!lg) continue;
                    const components = entry.slice(0, -1).map(u => font.glyph(u));
                    if (components.some(g => !g)) continue;
                    if (!ligatures.has(fg)) ligatures.set(fg, []);
                    (ligatures.get(fg) as Array<[number[], number]>).push([components, lg]);
                }
            }
            if (ligatures.size) lookup = syntheticLookup(i === 6 ? 0 : LookupFlag.IgnoreMarks, null, ligatures);
        }
        if (lookup) lookups.push([lookup, mask]);
    }
    return lookups;
}

function fallbackShape(plan: Plan, font: ShapeFont, buffer: Buffer): void {
    const arabic = plan.data as ArabicPlan;
    if (!arabic.doFallback) return;
    arabic.fallback ??= fallbackPlan(plan, font);
    for (const [lookup, mask] of arabic.fallback) applySynthetic(buffer, font.gdef, lookup, mask);
}

function recordStch(plan: Plan, _font: ShapeFont, buffer: Buffer): void {
    if (!(plan.data as ArabicPlan).hasStch) return;
    // what stch multiplied is stretched after positioning
    for (const info of buffer.info) if (isMultiplied(info)) {
        info.category = ligComp(info) % 2 ? Action.STCH_REPEATING : Action.STCH_FIXED;
        buffer.hasStch = true;
    }
}

function collectFeatures(planner: Planner): void {
    const map = planner.map;
    map.enableFeature('stch');
    map.addGsubPause(recordStch);
    map.enableFeature('ccmp', FeatureFlags.MANUAL_ZWJ);
    map.enableFeature('locl', FeatureFlags.MANUAL_ZWJ);
    map.addGsubPause(null);
    for (const tag of FEATURES) {
        const fallback = planner.script === 'Arab' && !isSyriacFeature(tag);
        map.addFeature(tag, FeatureFlags.MANUAL_ZWJ | (fallback ? FeatureFlags.HAS_FALLBACK : 0));
        map.addGsubPause(null);
    }
    map.addGsubPause(null);
    // in Arabic, ZWJ stops ligatures too
    map.enableFeature('rlig', FeatureFlags.MANUAL_ZWJ | FeatureFlags.HAS_FALLBACK);
    if (planner.script === 'Arab') map.addGsubPause(fallbackShape);
    map.enableFeature('calt', FeatureFlags.MANUAL_ZWJ);
    if (!map.hasFeature('rclt')) map.addGsubPause(null);
    map.enableFeature('liga', FeatureFlags.MANUAL_ZWJ);
    map.enableFeature('clig', FeatureFlags.MANUAL_ZWJ);
    map.enableFeature('mset', FeatureFlags.MANUAL_ZWJ);
}

export function dataCreate(plan: Plan): ArabicPlan {
    const doFallback = plan.script === 'Arab' && FEATURES.every(tag => isSyriacFeature(tag) || plan.map.needsFallback(tag));
    return { masks: [...FEATURES.map(tag => plan.map.get1Mask(tag)), 0], hasStch: !!plan.map.get1Mask('stch'), doFallback, fallback: null };
}

/** the joining forms, with the text around the buffer */
export function arabicJoining(buffer: Buffer): void {
    const info = buffer.info;
    let prev = -1, state = 0;
    for (const u of buffer.context[0]) {
        const type = joiningType(u, unicodeCategory(u));
        if (type === Joining.T) continue;
        state = STATES[state][type][2];
        break;
    }
    for (let i = 0; i < info.length; i++) {
        const type = joiningType(info[i].codepoint, generalCategory(info[i]));
        if (type === Joining.T) {
            info[i].category = Action.NONE;
            continue;
        }
        const entry = STATES[state][type];
        if (entry[0] !== Action.NONE && prev >= 0) info[prev].category = entry[0];
        info[i].category = entry[1];
        prev = i;
        state = entry[2];
    }
    for (const u of buffer.context[1]) {
        const type = joiningType(u, unicodeCategory(u));
        if (type === Joining.T) continue;
        const entry = STATES[state][type];
        if (entry[0] !== Action.NONE && prev >= 0) info[prev].category = entry[0];
        break;
    }
}

export function setupMasksArabic(arabic: ArabicPlan, buffer: Buffer, script: string): void {
    arabicJoining(buffer);
    const info = buffer.info;
    // Mongolian variation selectors take their base's form
    if (script === 'Mong')
        for (let i = 1; i < info.length; i++) {
            const u = info[i].codepoint;
            if (u >= 0x180b && u <= 0x180d || u === 0x180f) info[i].category = info[i - 1].category;
        }
    for (const g of info) g.mask |= arabic.masks[g.category];
}

const isWord = (category: number): boolean => [Category.Cn, Category.Co, Category.Lm, Category.Lo, Category.Mc, Category.Me, Category.Mn, Category.Nd,
    Category.Nl, Category.No, Category.Sc, Category.Sk, Category.Sm, Category.So].includes(category);
const isStch = (info: GlyphInfo): boolean => info.category === Action.STCH_FIXED || info.category === Action.STCH_REPEATING;

// stretches what stch marked to the width of the rest of the word: fixed pieces once, repeating ones as often as fit
function applyStch(buffer: Buffer, font: ShapeFont): void {
    if (!buffer.hasStch) return;
    const rtl = buffer.direction === Direction.RTL;
    if (!rtl) buffer.reverse();
    const MAX_GLYPHS = 256;
    const info = buffer.info, out: GlyphInfo[] = [];
    for (let i = info.length; i;) {
        if (!isStch(info[i - 1])) {
            out.push(info[--i]);
            continue;
        }
        let wTotal = 0, wFixed = 0, wRepeating = 0, nFixed = 0, nRepeating = 0;
        const end = i;
        while (i && isStch(info[i - 1])) {
            i--;
            const width = font.advance(info[i].codepoint);
            if (info[i].category === Action.STCH_FIXED) {
                wFixed += width;
                nFixed++;
            } else {
                wRepeating += width;
                nRepeating++;
            }
        }
        const start = i;
        let context = i;
        while (context && !isStch(info[context - 1]) && (isDefaultIgnorable(info[context - 1]) || isWord(generalCategory(info[context - 1])))) {
            context--;
            wTotal += info[context].xAdvance;
        }

        let copies = 0;
        const wRemainingSigned = wTotal - wFixed;
        let wRemaining = wTotal - wFixed;
        if (wRemainingSigned > wRepeating && wRepeating > 0) copies = Math.trunc(wRemainingSigned / wRepeating) - 1;
        let overlap = 0;
        const shortfall = wRemainingSigned - wRepeating * (copies + 1);
        if (shortfall > 0 && nRepeating > 0) {
            copies++;
            const excess = (copies + 1) * wRepeating - wRemainingSigned;
            if (excess > 0) {
                overlap = Math.trunc(excess / (copies * nRepeating));
                wRemaining = 0;
            }
        }
        let maxCopies = 0;
        if (nRepeating > 0 && nFixed + nRepeating < MAX_GLYPHS) maxCopies = Math.trunc((MAX_GLYPHS - nFixed - nRepeating) / nRepeating);
        copies = Math.min(copies, maxCopies);

        let xOffset = Math.trunc(wRemaining / 2);
        for (let k = end; k > start; k--) {
            const width = font.advance(info[k - 1].codepoint);
            const repeat = info[k - 1].category === Action.STCH_REPEATING ? 1 + copies : 1;
            info[k - 1].xAdvance = 0;
            for (let n = 0; n < repeat; n++) {
                if (rtl) {
                    xOffset -= width;
                    if (n > 0) xOffset += overlap;
                }
                info[k - 1].xOffset = xOffset;
                out.push(info[k - 1].clone());
                if (!rtl) {
                    xOffset += width;
                    if (n > 0) xOffset -= overlap;
                }
            }
        }
    }
    buffer.info = out.reverse();
    if (!rtl) buffer.reverse();
}

// modifier combining marks (UAX #53) move before the other marks of their class
const MODIFIER_COMBINING_MARKS = new Set([0x0654, 0x0655, 0x0658, 0x06dc, 0x06e3, 0x06e7, 0x06e8, 0x08ca, 0x08cb, 0x08cd, 0x08ce, 0x08cf, 0x08d3, 0x08f3]);

function reorderMarks(_plan: Plan, buffer: Buffer, start: number, end: number): void {
    const info = buffer.info;
    let i = start;
    for (let cc = 220; cc <= 230; cc += 10) {
        while (i < end && combiningClass(info[i]) < cc) i++;
        if (i === end) break;
        if (combiningClass(info[i]) > cc) continue;
        let j = i;
        while (j < end && combiningClass(info[j]) === cc && MODIFIER_COMBINING_MARKS.has(info[j].codepoint)) j++;
        if (i === j) continue;
        buffer.mergeClusters(start, j);
        const moved = info.slice(i, j);
        info.copyWithin(start + j - i, start, i);
        for (let k = 0; k < moved.length; k++) info[start + k] = moved[k];
        // renumbered so that the sequence stays sorted (22 and 26 are below the Arabic classes)
        const newStart = start + j - i, newCC = cc === 220 ? 25 : 26;
        while (start < newStart) setCombiningClass(info[start++], newCC);
        i = j;
    }
}

export const arabicShaper: Shaper = {
    collectFeatures,
    dataCreate,
    setupMasks: (plan, buffer) => setupMasksArabic(plan.data as ArabicPlan, buffer, plan.script),
    postprocessGlyphs: (_plan, buffer, font) => applyStch(buffer, font),
    reorderMarks,
    normalization: Normalization.AUTO,
    zeroWidthMarks: ZeroMarks.BY_GDEF_LATE,
    fallbackPosition: true,
};
