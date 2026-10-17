/*!
 * The Universal Shaping Engine, ported from HarfBuzz (hb-ot-shaper-use.cc, hb-ot-shaper-use-machine.rl)
 * Copyright © 2015 Mozilla Foundation, © 2015 Google, Inc., Old MIT license (see THIRD_PARTY_NOTICES.md and
 * licenses/HarfBuzz.txt)
 */

import { Buffer, GlyphInfo, GlyphProps, isLigated, isSubstituted, ligComp, isUnicodeMark, isMark } from '../buffer.ts';
import { FeatureFlags } from '../layout.ts';
import { Plan, Planner, Shaper, ShapeFont, Normalization, ZeroMarks, compose, unicodeCategory } from '../shape.ts';
import { useCategory } from '../unicode-data.ts';
import { value } from '../unicode.ts';
import { scanner, cat, seq, alt, opt, star, plus, any } from './machine.ts';
import { forEachSyllable, insertDottedCircles, vowelConstraintsPreprocess } from './syllabic.ts';
import { ArabicPlan, dataCreate as arabicDataCreate, setupMasksArabic } from './arabic.ts';

const enum U {
    O = 0, B = 1, N = 4, GB = 5, CGJ = 6, SUB = 11, H = 12, HN = 13, ZWNJ = 14, WJ = 16, R = 18, CS = 43, IS = 44, Sk = 48, G = 49, J = 50, SB = 51,
    SE = 52, HVM = 53, HM = 54, HR = 55, RK = 56, FAbv = 24, FBlw = 25, FPst = 26, MAbv = 27, MBlw = 28, MPst = 29, MPre = 30, CMAbv = 31, CMBlw = 32,
    VAbv = 33, VBlw = 34, VPst = 35, VPre = 22, VMAbv = 37, VMBlw = 38, VMPst = 39, VMPre = 23, SMAbv = 41, SMBlw = 42, FMAbv = 45, FMBlw = 46, FMPst = 47,
}
const CATEGORIES: Record<string, number> = {
    O: U.O, B: U.B, N: U.N, GB: U.GB, CGJ: U.CGJ, SUB: U.SUB, H: U.H, HN: U.HN, ZWNJ: U.ZWNJ, WJ: U.WJ, R: U.R, CS: U.CS, IS: U.IS, Sk: U.Sk, G: U.G,
    J: U.J, SB: U.SB, SE: U.SE, HVM: U.HVM, HM: U.HM, HR: U.HR, RK: U.RK, FAbv: U.FAbv, FBlw: U.FBlw, FPst: U.FPst, MAbv: U.MAbv, MBlw: U.MBlw,
    MPst: U.MPst, MPre: U.MPre, CMAbv: U.CMAbv, CMBlw: U.CMBlw, VAbv: U.VAbv, VBlw: U.VBlw, VPst: U.VPst, VPre: U.VPre, VMAbv: U.VMAbv, VMBlw: U.VMBlw,
    VMPst: U.VMPst, VMPre: U.VMPre, SMAbv: U.SMAbv, SMBlw: U.SMBlw, FMAbv: U.FMAbv, FMBlw: U.FMBlw, FMPst: U.FMPst,
};

const enum Syllable { VIRAMA_TERMINATED, SAKOT_TERMINATED, STANDARD, NUMBER_JOINER_TERMINATED, NUMERAL, SYMBOL, HIEROGLYPH, BROKEN, NON_CLUSTER }

const findSyllables = ((): ((categories: number[]) => Array<[number, number, number]>) => {
    const s = (...c: number[]) => star(cat(...c));
    const h = cat(U.H, U.HVM, U.IS, U.Sk);
    const consonantModifiers = seq(s(U.CMAbv), s(U.CMBlw), star(alt(seq(h, cat(U.B)), cat(U.SUB)), s(U.CMAbv), s(U.CMBlw)));
    const medialConsonants = seq(opt(cat(U.MPre)), opt(cat(U.MAbv)), opt(cat(U.MBlw)), opt(cat(U.MPst)));
    const dependentVowels = alt(seq(s(U.VPre), s(U.VAbv), s(U.VBlw), s(U.VPst)), cat(U.H));
    const vowelModifiers = seq(opt(cat(U.HVM)), s(U.VMPre), s(U.VMAbv), s(U.VMBlw), s(U.VMPst));
    const finalConsonants = seq(s(U.FAbv), s(U.FBlw), s(U.FPst));
    const finalModifiers = alt(seq(s(U.FMAbv), s(U.FMBlw)), opt(cat(U.FMPst)));
    const complexSyllableStart = seq(opt(cat(U.R, U.CS)), cat(U.B, U.GB));
    const complexSyllableMiddle = seq(consonantModifiers, medialConsonants, dependentVowels, vowelModifiers, star(cat(U.Sk), cat(U.B)));
    const complexSyllableTail = seq(complexSyllableMiddle, finalConsonants, finalModifiers);
    const numberJoinerTerminatedClusterTail = seq(star(cat(U.HN), cat(U.N)), cat(U.HN));
    const numeralClusterTail = plus(cat(U.HN), cat(U.N));
    const symbolClusterTail = alt(seq(plus(cat(U.SMAbv)), s(U.SMBlw)), plus(cat(U.SMBlw)));
    const viramaTerminatedClusterTail = seq(consonantModifiers, cat(U.IS, U.RK));
    const viramaTerminatedCluster = seq(complexSyllableStart, viramaTerminatedClusterTail);
    const sakotTerminatedClusterTail = seq(complexSyllableMiddle, cat(U.Sk));
    const sakotTerminatedCluster = seq(complexSyllableStart, sakotTerminatedClusterTail);
    const standardCluster = seq(complexSyllableStart, complexSyllableTail);
    const tail = alt(complexSyllableTail, sakotTerminatedClusterTail, symbolClusterTail, viramaTerminatedClusterTail);
    const brokenCluster = seq(opt(cat(U.R)), alt(tail, numberJoinerTerminatedClusterTail, numeralClusterTail));
    const numberJoinerTerminatedCluster = seq(cat(U.N), numberJoinerTerminatedClusterTail);
    const numeralCluster = seq(cat(U.N), opt(numeralClusterTail));
    const symbolCluster = seq(cat(U.O, U.GB, U.SB), opt(tail));
    const g = seq(cat(U.G), opt(cat(U.HR)), opt(cat(U.HM)), s(U.SE));
    const hieroglyphCluster = seq(s(U.SB), g, star(cat(U.J), s(U.SB), opt(g)));
    const zwnj = opt(cat(U.ZWNJ));
    return scanner([
        [seq(viramaTerminatedCluster, zwnj), Syllable.VIRAMA_TERMINATED],
        [seq(sakotTerminatedCluster, zwnj), Syllable.SAKOT_TERMINATED],
        [seq(standardCluster, zwnj), Syllable.STANDARD],
        [seq(numberJoinerTerminatedCluster, zwnj), Syllable.NUMBER_JOINER_TERMINATED],
        [seq(numeralCluster, zwnj), Syllable.NUMERAL],
        [seq(symbolCluster, zwnj), Syllable.SYMBOL],
        [seq(hieroglyphCluster, zwnj), Syllable.HIEROGLYPH],
        [cat(U.FMPst), Syllable.NON_CLUSTER],
        [seq(brokenCluster, zwnj), Syllable.BROKEN],
        [any, Syllable.NON_CLUSTER],
    ]);
})();

// syllables over the categories without CGJ (and ZWNJ before marks): the ignored characters join the syllable before
function setupSyllables(plan: Plan, _font: ShapeFont, buffer: Buffer): void {
    const info = buffer.info, kept: number[] = [];
    for (let i = 0; i < info.length; i++) {
        if (info[i].category === U.CGJ) continue;
        if (info[i].category === U.ZWNJ) {
            let j = i + 1;
            while (j < info.length && info[j].category === U.CGJ) j++;
            if (j < info.length && isUnicodeMark(info[j])) continue;
        }
        kept.push(i);
    }
    let serial = 1;
    for (const [start, end, type] of findSyllables(kept.map(i => info[i].category))) {
        const from = kept[start], to = end < kept.length ? kept[end] : info.length;
        for (let i = from; i < to; i++) info[i].syllable = serial << 4 | type;
        if (type === Syllable.BROKEN) buffer.hasBrokenSyllable = true;
        if (++serial === 16) serial = 1;
    }
    setupRphfMask(plan, buffer);
    setupTopographicalMasks(plan, buffer);
}

interface UsePlan {
    rphfMask: number;
    arabic: ArabicPlan | null;
}

function setupRphfMask(plan: Plan, buffer: Buffer): void {
    const mask = (plan.data as UsePlan).rphfMask;
    if (!mask) return;
    const info = buffer.info;
    forEachSyllable(buffer, (start, end) => {
        const limit = info[start].category === U.R ? 1 : Math.min(3, end - start);
        for (let i = start; i < start + limit; i++) info[i].mask |= mask;
    });
}

const TOPOGRAPHICAL = ['isol', 'init', 'medi', 'fina'];
const enum Form { ISOL, INIT, MEDI, FINA, NONE }

// joining forms between clusters, for scripts without Arabic joining
function setupTopographicalMasks(plan: Plan, buffer: Buffer): void {
    if ((plan.data as UsePlan).arabic) return;
    const masks = TOPOGRAPHICAL.map(tag => {
        const m = plan.map.get1Mask(tag);
        return m === plan.map.globalMask ? 0 : m;
    });
    const all = masks.reduce((a, b) => a | b, 0);
    if (!all) return;
    const others = ~all, info = buffer.info;
    let lastStart = 0, lastForm = Form.NONE;
    forEachSyllable(buffer, (start, end) => {
        const type = info[start].syllable & 0x0f;
        if (type === Syllable.HIEROGLYPH || type === Syllable.NON_CLUSTER) lastForm = Form.NONE;
        else {
            const join = lastForm === Form.FINA || lastForm === Form.ISOL;
            if (join) {
                lastForm = lastForm === Form.FINA ? Form.MEDI : Form.INIT;
                for (let i = lastStart; i < start; i++) info[i].mask = info[i].mask & others | masks[lastForm];
            }
            lastForm = join ? Form.FINA : Form.ISOL;
            for (let i = start; i < end; i++) info[i].mask = info[i].mask & others | masks[lastForm];
        }
        lastStart = start;
    });
}

function clearSubstitutionFlags(_plan: Plan, _font: ShapeFont, buffer: Buffer): void {
    for (const info of buffer.info) info.glyphProps &= ~GlyphProps.SUBSTITUTED;
}

function recordRphf(plan: Plan, _font: ShapeFont, buffer: Buffer): void {
    const mask = (plan.data as UsePlan).rphfMask;
    if (!mask) return;
    const info = buffer.info;
    forEachSyllable(buffer, (start, end) => {
        for (let i = start; i < end && info[i].mask & mask; i++)
            if (isSubstituted(info[i])) {
                info[i].category = U.R;
                break;
            }
    });
}

function recordPref(_plan: Plan, _font: ShapeFont, buffer: Buffer): void {
    const info = buffer.info;
    forEachSyllable(buffer, (start, end) => {
        for (let i = start; i < end; i++)
            if (isSubstituted(info[i])) {
                info[i].category = U.VPre;
                break;
            }
    });
}

const isHalant = (info: GlyphInfo): boolean => (info.category === U.H || info.category === U.HVM || info.category === U.IS) && !isLigated(info);
const POST_BASE = new Set([U.FAbv, U.FBlw, U.FPst, U.FMAbv, U.FMBlw, U.FMPst, U.MAbv, U.MBlw, U.MPst, U.MPre, U.VAbv, U.VBlw, U.VPst, U.VPre, U.VMAbv,
    U.VMBlw, U.VMPst, U.VMPre]);
const REORDERED = new Set([Syllable.VIRAMA_TERMINATED, Syllable.SAKOT_TERMINATED, Syllable.STANDARD, Syllable.SYMBOL, Syllable.BROKEN]);

function reorderSyllable(buffer: Buffer, start: number, end: number): void {
    const info = buffer.info;
    if (!REORDERED.has(info[start].syllable & 0x0f)) return;
    // a repha moves before the first post-base glyph (or to the end)
    if (info[start].category === U.R && end - start > 1)
        for (let i = start + 1; i < end; i++) {
            const postBase = POST_BASE.has(info[i].category) || isHalant(info[i]);
            if (postBase || i === end - 1) {
                if (postBase) i--;
                buffer.mergeClusters(start, i + 1);
                const t = info[start];
                for (let k = start; k < i; k++) info[k] = info[k + 1];
                info[i] = t;
                break;
            }
        }
    // pre-base vowels (and vowel modifiers) move to after the last halant
    let j = start;
    for (let i = start; i < end; i++) {
        const category = info[i].category;
        if (isHalant(info[i])) j = i + 1;
        else if ((category === U.VPre || category === U.VMPre) && ligComp(info[i]) === 0 && j < i) {
            buffer.mergeClusters(j, i + 1);
            const t = info[i];
            for (let k = i; k > j; k--) info[k] = info[k - 1];
            info[j] = t;
        }
    }
}

function reorder(_plan: Plan, font: ShapeFont, buffer: Buffer): void {
    insertDottedCircles(font, buffer, Syllable.BROKEN, U.B, U.R, -1);
    forEachSyllable(buffer, (start, end) => reorderSyllable(buffer, start, end));
}

function collectFeatures(planner: Planner): void {
    const map = planner.map;
    map.addGsubPause(setupSyllables);
    map.enableFeature('locl', FeatureFlags.PER_SYLLABLE);
    map.enableFeature('ccmp', FeatureFlags.PER_SYLLABLE);
    map.enableFeature('nukt', FeatureFlags.PER_SYLLABLE);
    map.enableFeature('akhn', FeatureFlags.MANUAL_ZWJ | FeatureFlags.PER_SYLLABLE);
    map.addGsubPause(clearSubstitutionFlags);
    map.addFeature('rphf', FeatureFlags.MANUAL_ZWJ | FeatureFlags.PER_SYLLABLE);
    map.addGsubPause(recordRphf);
    map.addGsubPause(clearSubstitutionFlags);
    map.enableFeature('pref', FeatureFlags.MANUAL_ZWJ | FeatureFlags.PER_SYLLABLE);
    map.addGsubPause(recordPref);
    for (const tag of ['rkrf', 'abvf', 'blwf', 'half', 'pstf', 'vatu', 'cjct']) map.enableFeature(tag, FeatureFlags.MANUAL_ZWJ | FeatureFlags.PER_SYLLABLE);
    map.addGsubPause(reorder);
    map.addGsubPause(null);
    for (const tag of TOPOGRAPHICAL) map.addFeature(tag);
    map.addGsubPause(null);
    for (const tag of ['abvs', 'blws', 'haln', 'pres', 'psts']) map.enableFeature(tag, FeatureFlags.MANUAL_ZWJ);
}

// scripts that join like Arabic (hb-ot-shaper-arabic-joining-list.hh)
const ARABIC_JOINING = new Set(['Adlm', 'Arab', 'Chrs', 'Rohg', 'Mand', 'Mani', 'Mong', 'Nkoo', 'Ougr', 'Phag', 'Phlp', 'Sogd', 'Syrc']);

export const useShaper: Shaper = {
    collectFeatures,
    dataCreate: (plan): UsePlan => ({ rphfMask: plan.map.get1Mask('rphf'), arabic: ARABIC_JOINING.has(plan.script) ? arabicDataCreate(plan) : null }),
    preprocessText: (_plan, buffer) => vowelConstraintsPreprocess(buffer),
    compose: (_c, a, b) => isMark(unicodeCategory(a)) ? 0 : compose(a, b),
    setupMasks: (plan, buffer) => {
        const use = plan.data as UsePlan;
        if (use.arabic) setupMasksArabic(use.arabic, buffer, plan.script);
        for (const info of buffer.info) info.category = CATEGORIES[value(useCategory, info.codepoint)];
    },
    normalization: Normalization.COMPOSED_DIACRITICS_NO_SHORT_CIRCUIT,
    zeroWidthMarks: ZeroMarks.BY_GDEF_EARLY,
    fallbackPosition: false,
};
