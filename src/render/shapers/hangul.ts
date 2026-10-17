/*!
 * The Hangul shaper, ported from HarfBuzz (hb-ot-shaper-hangul.cc)
 * Copyright © 2013 Google, Inc., Old MIT license (see THIRD_PARTY_NOTICES.md and licenses/HarfBuzz.txt)
 */

import { Buffer } from '../buffer.ts';
import { Plan, Shaper, ShapeFont, Normalization, ZeroMarks } from '../shape.ts';

const enum Jamo { NONE, LJMO, VJMO, TJMO }
const FEATURES = ['', 'ljmo', 'vjmo', 'tjmo'];

const L_BASE = 0x1100, V_BASE = 0x1161, T_BASE = 0x11a7, L_COUNT = 19, V_COUNT = 21, T_COUNT = 28, S_BASE = 0xac00;
const N_COUNT = V_COUNT * T_COUNT, S_COUNT = L_COUNT * N_COUNT;
const isCombiningL = (u: number): boolean => u >= L_BASE && u < L_BASE + L_COUNT;
const isCombiningV = (u: number): boolean => u >= V_BASE && u < V_BASE + V_COUNT;
const isCombiningT = (u: number): boolean => u > T_BASE && u < T_BASE + T_COUNT;
const isCombinedS = (u: number): boolean => u >= S_BASE && u < S_BASE + S_COUNT;
const isL = (u: number): boolean => u >= 0x1100 && u <= 0x115f || u >= 0xa960 && u <= 0xa97c;
const isV = (u: number): boolean => u >= 0x1160 && u <= 0x11a7 || u >= 0xd7b0 && u <= 0xd7c6;
const isT = (u: number): boolean => u >= 0x11a8 && u <= 0x11ff || u >= 0xd7cb && u <= 0xd7fb;
const isTone = (u: number): boolean => u >= 0x302e && u <= 0x302f;

interface HangulPlan {
    masks: number[];
    caltMask: number;
}

const isZeroWidth = (font: ShapeFont, u: number): boolean => {
    const glyph = font.glyph(u);
    return glyph !== 0 && font.advance(glyph) === 0;
};

// syllables compose when the font has the whole one, else decompose into jamo for ljmo/vjmo/tjmo; tone marks after a
// syllable move before it (unless zero width, overstriking)
function preprocessText(_plan: Plan, buffer: Buffer, font: ShapeFont): void {
    buffer.clearOutput();
    let start = 0, end = 0;
    const count = buffer.len;
    for (buffer.idx = 0; buffer.idx < count && buffer.successful;) {
        const u = buffer.cur().codepoint;
        if (isTone(u)) {
            if (start < end && end === buffer.outLen) {
                buffer.nextGlyph();
                if (!isZeroWidth(font, u)) {
                    buffer.mergeOutClusters(start, end + 1);
                    const info = buffer.outInfo, tone = info[end];
                    for (let k = end; k > start; k--) info[k] = info[k - 1];
                    info[start] = tone;
                }
            } else if (font.hasGlyph(0x25cc)) buffer.replaceGlyphs(1, 2, isZeroWidth(font, u) ? [0x25cc, u] : [u, 0x25cc]);
            else buffer.nextGlyph();
            start = end = buffer.outLen;
            continue;
        }

        start = buffer.outLen;
        if (isL(u) && buffer.idx + 1 < count) {
            const l = u, v = buffer.cur(1).codepoint;
            if (isV(v)) {
                let t = 0, tindex = 0;
                if (buffer.idx + 2 < count) {
                    t = buffer.cur(2).codepoint;
                    if (isT(t)) tindex = t - T_BASE;
                    else t = 0;
                }
                if (isCombiningL(l) && isCombiningV(v) && (t === 0 || isCombiningT(t))) {
                    const s = S_BASE + (l - L_BASE) * N_COUNT + (v - V_BASE) * T_COUNT + tindex;
                    if (font.hasGlyph(s)) {
                        buffer.replaceGlyphs(t ? 3 : 2, 1, [s]);
                        end = start + 1;
                        continue;
                    }
                }
                buffer.cur().category = Jamo.LJMO;
                buffer.nextGlyph();
                buffer.cur().category = Jamo.VJMO;
                buffer.nextGlyph();
                if (t) {
                    buffer.cur().category = Jamo.TJMO;
                    buffer.nextGlyph();
                    end = start + 3;
                } else end = start + 2;
                if (!buffer.successful) break;
                buffer.mergeOutClusters(start, end);
                continue;
            }
        } else if (isCombinedS(u)) {
            const s = u, hasGlyph = font.hasGlyph(s);
            const lindex = Math.floor((s - S_BASE) / N_COUNT), nindex = (s - S_BASE) % N_COUNT;
            const vindex = Math.floor(nindex / T_COUNT), tindex = nindex % T_COUNT;
            if (!tindex && buffer.idx + 1 < count && isCombiningT(buffer.cur(1).codepoint)) {
                const combined = s + buffer.cur(1).codepoint - T_BASE;
                if (font.hasGlyph(combined)) {
                    buffer.replaceGlyphs(2, 1, [combined]);
                    end = start + 1;
                    continue;
                }
            }
            if (!hasGlyph || !tindex && buffer.idx + 1 < count && isT(buffer.cur(1).codepoint)) {
                const decomposed = [L_BASE + lindex, V_BASE + vindex, T_BASE + tindex];
                if (font.hasGlyph(decomposed[0]) && font.hasGlyph(decomposed[1]) && (!tindex || font.hasGlyph(decomposed[2]))) {
                    let length = tindex ? 3 : 2;
                    buffer.replaceGlyphs(1, length, decomposed);
                    // (a non-combining T after a decomposed LV joins the syllable)
                    if (hasGlyph && !tindex) {
                        buffer.nextGlyph();
                        length++;
                    }
                    if (!buffer.successful) break;
                    const info = buffer.outInfo;
                    end = start + length;
                    let i = start;
                    info[i++].category = Jamo.LJMO;
                    info[i++].category = Jamo.VJMO;
                    if (i < end) info[i++].category = Jamo.TJMO;
                    buffer.mergeOutClusters(start, end);
                    continue;
                }
            }
            if (hasGlyph) end = start + 1;
        }
        buffer.nextGlyph();
    }
    buffer.sync();
}

export const hangulShaper: Shaper = {
    collectFeatures: planner => {
        for (const tag of FEATURES.slice(1)) planner.map.addFeature(tag);
    },
    // calt gets a mask of its own so jamo can be kept away from it (fonts apply jamo lookups there)
    overrideFeatures: planner => planner.map.addFeature('calt'),
    dataCreate: (plan): HangulPlan => ({ masks: FEATURES.map(tag => tag ? plan.map.get1Mask(tag) : 0), caltMask: plan.map.get1Mask('calt') }),
    preprocessText,
    setupMasks: (plan, buffer) => {
        const hangul = plan.data as HangulPlan;
        for (const info of buffer.info) {
            info.mask |= hangul.masks[info.category];
            const u = info.codepoint;
            if (isL(u) || isV(u) || isT(u)) info.mask &= ~hangul.caltMask;
        }
    },
    normalization: Normalization.NONE,
    zeroWidthMarks: ZeroMarks.NONE,
    fallbackPosition: true,
};
