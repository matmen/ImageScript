/*!
 * The Khmer shaper, ported from HarfBuzz (hb-ot-shaper-khmer.cc, hb-ot-shaper-khmer-machine.rl)
 * Copyright © 2011,2012 Google, Inc., Old MIT license (see THIRD_PARTY_NOTICES.md and licenses/HarfBuzz.txt)
 */

import { Buffer, isMark } from '../buffer.ts';
import { FeatureFlags } from '../layout.ts';
import { Plan, Planner, Shaper, ShapeFont, Normalization, ZeroMarks, decompose, compose, unicodeCategory } from '../shape.ts';
import { scanner, cat, seq, alt, opt, star, any } from './machine.ts';
import { forEachSyllable, insertDottedCircles } from './syllabic.ts';
import { I, indicProperties, setSyllables } from './indic.ts';

const enum Syllable { CONSONANT, BROKEN, NON_KHMER }

const findSyllables = ((): ((categories: number[]) => Array<[number, number, number]>) => {
    const c = cat(I.C, I.Ra, I.V);
    const joiner = cat(I.ZWJ, I.ZWNJ);
    const cn = seq(c, opt(opt(joiner), cat(I.Robatic)));
    const xgroup = star(star(joiner), cat(I.Xgroup));
    const ygroup = star(cat(I.Ygroup));
    const matraGroup = seq(opt(cat(I.VPre)), xgroup, opt(cat(I.VBlw)), xgroup, opt(opt(joiner), cat(I.VAbv)), xgroup, opt(cat(I.VPst)));
    const syllableTail = seq(xgroup, matraGroup, xgroup, opt(cat(I.H), c), ygroup);
    const brokenCluster = seq(opt(cat(I.Robatic)), star(cat(I.H), cn), alt(cat(I.H), syllableTail));
    const consonantSyllable = seq(alt(cn, cat(I.PLACEHOLDER), cat(I.DOTTEDCIRCLE)), brokenCluster);
    return scanner([[consonantSyllable, Syllable.CONSONANT], [brokenCluster, Syllable.BROKEN], [any, Syllable.NON_KHMER]]);
})();

const FEATURES: Array<[string, number]> = [
    ['pref', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['blwf', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['abvf', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['pstf', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['cfar', FeatureFlags.MANUAL_JOINERS | FeatureFlags.PER_SYLLABLE],
    ['pres', FeatureFlags.GLOBAL_MANUAL_JOINERS],
    ['abvs', FeatureFlags.GLOBAL_MANUAL_JOINERS],
    ['blws', FeatureFlags.GLOBAL_MANUAL_JOINERS],
    ['psts', FeatureFlags.GLOBAL_MANUAL_JOINERS],
];
const enum F { PREF, BLWF, ABVF, PSTF, CFAR, BASIC = 5 }

function reorderConsonantSyllable(plan: Plan, buffer: Buffer, start: number, end: number): void {
    const masks = plan.data as number[], info = buffer.info;
    const mask = masks[F.BLWF] | masks[F.ABVF] | masks[F.PSTF];
    for (let i = start + 1; i < end; i++) info[i].mask |= mask;

    let coengs = 0;
    for (let i = start + 1; i < end; i++) {
        if (info[i].category === I.H && coengs <= 2 && i + 1 < end) {
            coengs++;
            // a Coeng,Ro moves to the start (pre-base)
            if (info[i + 1].category === I.Ra) {
                for (let j = 0; j < 2; j++) info[i + j].mask |= masks[F.PREF];
                buffer.mergeClusters(start, i + 2);
                const t0 = info[i], t1 = info[i + 1];
                for (let k = i - 1; k >= start; k--) info[k + 2] = info[k];
                info[start] = t0;
                info[start + 1] = t1;
                if (masks[F.CFAR]) for (let j = i + 2; j < end; j++) info[j].mask |= masks[F.CFAR];
                coengs = 2;
            }
        } else if (info[i].category === I.VPre) {
            buffer.mergeClusters(start, i + 1);
            const t = info[i];
            for (let k = i - 1; k >= start; k--) info[k + 1] = info[k];
            info[start] = t;
        }
    }
}

function reorder(plan: Plan, font: ShapeFont, buffer: Buffer): void {
    insertDottedCircles(font, buffer, Syllable.BROKEN, I.DOTTEDCIRCLE, -1, -1);
    forEachSyllable(buffer, (start, end) => {
        const type = buffer.info[start].syllable & 0x0f;
        if (type === Syllable.CONSONANT || type === Syllable.BROKEN) reorderConsonantSyllable(plan, buffer, start, end);
    });
}

function collectFeatures(planner: Planner): void {
    const map = planner.map;
    map.addGsubPause((_plan, _font, buffer) => setSyllables(buffer, findSyllables(buffer.info.map(info => info.category)), Syllable.BROKEN));
    map.addGsubPause(reorder);
    map.enableFeature('locl', FeatureFlags.PER_SYLLABLE);
    map.enableFeature('ccmp', FeatureFlags.PER_SYLLABLE);
    let i = 0;
    for (; i < F.BASIC; i++) map.addFeature(FEATURES[i][0], FEATURES[i][1]);
    map.addGsubPause(null);
    for (; i < FEATURES.length; i++) map.addFeature(FEATURES[i][0], FEATURES[i][1]);
}

// split vowels decompose into their pre-base part and themselves
const SPLIT = new Set([0x17be, 0x17bf, 0x17c0, 0x17c4, 0x17c5]);

export const khmerShaper: Shaper = {
    collectFeatures,
    overrideFeatures: planner => {
        planner.map.enableFeature('clig');
        planner.map.disableFeature('liga');
    },
    dataCreate: plan => FEATURES.map(([tag, flags]) => flags & FeatureFlags.GLOBAL ? 0 : plan.map.get1Mask(tag)),
    decompose: (_c, ab) => SPLIT.has(ab) ? [0x17c1, ab] : decompose(ab),
    compose: (_c, a, b) => isMark(unicodeCategory(a)) ? 0 : compose(a, b),
    setupMasks: (_plan, buffer) => {
        for (const info of buffer.info) info.category = indicProperties(info.codepoint)[0];
    },
    normalization: Normalization.COMPOSED_DIACRITICS_NO_SHORT_CIRCUIT,
    zeroWidthMarks: ZeroMarks.NONE,
    fallbackPosition: false,
};
