/*!
 * The Myanmar shaper, ported from HarfBuzz (hb-ot-shaper-myanmar.cc, hb-ot-shaper-myanmar-machine.rl)
 * Copyright © 2011,2012,2013 Google, Inc., Old MIT license (see THIRD_PARTY_NOTICES.md and licenses/HarfBuzz.txt)
 */

import { Buffer, GlyphInfo } from '../buffer.ts';
import { FeatureFlags } from '../layout.ts';
import { Plan, Planner, Shaper, ShapeFont, Normalization, ZeroMarks } from '../shape.ts';
import { scanner, cat, seq, alt, opt, star, any } from './machine.ts';
import { forEachSyllable, insertDottedCircles } from './syllabic.ts';
import { I, Pos, indicProperties, isOneOf, setSyllables } from './indic.ts';

const enum Syllable { CONSONANT, BROKEN, NON_MYANMAR }

const findSyllables = ((): ((categories: number[]) => Array<[number, number, number]>) => {
    const j = cat(I.ZWJ, I.ZWNJ);
    const k = seq(cat(I.Ra), cat(I.As), cat(I.H));
    const sm = cat(I.SM, I.SMPst);
    const c = cat(I.C, I.Ra);
    const medialGroup = seq(opt(cat(I.MY)), opt(cat(I.As)), opt(cat(I.MR)),
        opt(alt(seq(cat(I.MW), opt(cat(I.MH)), opt(cat(I.ML))), seq(cat(I.MH), opt(cat(I.ML))), cat(I.ML)), opt(cat(I.As))));
    const mainVowelGroup = seq(star(cat(I.VPre), opt(cat(I.VS))), star(cat(I.VAbv)), star(cat(I.VBlw)), star(cat(I.A)), opt(cat(I.DB), opt(cat(I.As))));
    const postVowelGroup = seq(cat(I.VPst), opt(cat(I.MH)), opt(cat(I.ML)), star(cat(I.As)), star(cat(I.VAbv)), star(cat(I.A)), opt(cat(I.DB), opt(cat(I.As))));
    const toneGroup = alt(sm, seq(cat(I.PT), star(cat(I.A)), opt(cat(I.DB)), opt(cat(I.As))));
    const complexSyllableTail = seq(star(cat(I.As)), medialGroup, mainVowelGroup, star(postVowelGroup), star(toneGroup), opt(j));
    const syllableTail = seq(star(cat(I.H), alt(c, cat(I.IV)), opt(cat(I.VS))), alt(cat(I.H), complexSyllableTail));
    const consonantSyllable = seq(opt(alt(k, cat(I.CS))), alt(c, cat(I.IV), cat(I.GB), cat(I.DOTTEDCIRCLE)), opt(cat(I.VS)), syllableTail);
    const brokenCluster = seq(opt(k), opt(cat(I.VS)), syllableTail);
    return scanner([
        [consonantSyllable, Syllable.CONSONANT],
        [alt(j, cat(I.SMPst)), Syllable.NON_MYANMAR],
        [brokenCluster, Syllable.BROKEN],
        [any, Syllable.NON_MYANMAR],
    ]);
})();

const CONSONANTS = [I.C, I.CS, I.Ra, I.IV, I.GB, I.DOTTEDCIRCLE];
const isConsonant = (info: GlyphInfo): boolean => isOneOf(info, CONSONANTS);

function reorderConsonantSyllable(buffer: Buffer, start: number, end: number): void {
    const info = buffer.info;
    let base = end, hasReph = false, limit = start;
    // Kinzi (Ra,Asat,Halant)
    if (start + 3 <= end && info[start].category === I.Ra && info[start + 1].category === I.As && info[start + 2].category === I.H) {
        limit += 3;
        base = start;
        hasReph = true;
    }
    if (!hasReph) base = limit;
    for (let i = limit; i < end; i++) if (isConsonant(info[i])) {
        base = i;
        break;
    }

    let i = start;
    for (; i < start + (hasReph ? 3 : 0); i++) info[i].position = Pos.AFTER_MAIN;
    for (; i < base; i++) info[i].position = Pos.PRE_C;
    if (i < end) info[i++].position = Pos.BASE_C;
    let pos = Pos.AFTER_MAIN;
    for (; i < end; i++) {
        const category = info[i].category;
        if (category === I.MR) info[i].position = Pos.PRE_C;
        else if (category === I.VPre) info[i].position = Pos.PRE_M;
        else if (category === I.VS) info[i].position = info[i - 1].position;
        else if (pos === Pos.AFTER_MAIN && category === I.VBlw) info[i].position = pos = Pos.BELOW_C;
        else if (pos === Pos.BELOW_C && category === I.A) info[i].position = Pos.BEFORE_SUB;
        else if (pos === Pos.BELOW_C && category === I.VBlw) info[i].position = pos;
        else if (pos === Pos.BELOW_C) info[i].position = pos = Pos.AFTER_SUB;
        else info[i].position = pos;
    }

    buffer.sort(start, end, (a, b) => a.position - b.position);

    // left matra sequences flipped
    let firstLeftMatra = end, lastLeftMatra = end;
    for (let k = start; k < end; k++) if (info[k].position === Pos.PRE_M) {
        if (firstLeftMatra === end) firstLeftMatra = k;
        lastLeftMatra = k;
    }
    if (firstLeftMatra < lastLeftMatra) {
        buffer.reverseRange(firstLeftMatra, lastLeftMatra + 1);
        let k = firstLeftMatra;
        for (let j = k; j <= lastLeftMatra; j++)
            if (info[j].category === I.VPre) {
                buffer.reverseRange(k, j + 1);
                k = j + 1;
            }
    }
}

function reorder(_plan: Plan, font: ShapeFont, buffer: Buffer): void {
    insertDottedCircles(font, buffer, Syllable.BROKEN, I.DOTTEDCIRCLE, -1, -1);
    forEachSyllable(buffer, (start, end) => {
        const type = buffer.info[start].syllable & 0x0f;
        if (type === Syllable.CONSONANT || type === Syllable.BROKEN) reorderConsonantSyllable(buffer, start, end);
    });
}

function collectFeatures(planner: Planner): void {
    const map = planner.map;
    map.addGsubPause((_plan, _font, buffer) => setSyllables(buffer, findSyllables(buffer.info.map(info => info.category)), Syllable.BROKEN));
    map.enableFeature('locl', FeatureFlags.PER_SYLLABLE);
    map.enableFeature('ccmp', FeatureFlags.PER_SYLLABLE);
    map.addGsubPause(reorder);
    for (const tag of ['rphf', 'pref', 'blwf', 'pstf']) {
        map.enableFeature(tag, FeatureFlags.MANUAL_ZWJ | FeatureFlags.PER_SYLLABLE);
        map.addGsubPause(null);
    }
    map.addGsubPause(null);
    for (const tag of ['pres', 'abvs', 'blws', 'psts']) map.enableFeature(tag, FeatureFlags.MANUAL_ZWJ);
}

export const myanmarShaper: Shaper = {
    collectFeatures,
    setupMasks: (_plan, buffer) => {
        for (const info of buffer.info) info.category = indicProperties(info.codepoint)[0];
    },
    normalization: Normalization.COMPOSED_DIACRITICS_NO_SHORT_CIRCUIT,
    zeroWidthMarks: ZeroMarks.BY_GDEF_EARLY,
    fallbackPosition: false,
};
