/*!
 * The Thai and Lao shaper, ported from HarfBuzz (hb-ot-shaper-thai.cc)
 * Copyright © 2010,2012 Google, Inc., Old MIT license (see THIRD_PARTY_NOTICES.md and licenses/HarfBuzz.txt)
 */

import { Buffer, Category, UnicodeProps, setGeneralCategory } from '../buffer.ts';
import { Plan, Shaper, ShapeFont, Normalization, ZeroMarks } from '../shape.ts';

const enum Consonant { NC, AC, RC, DC, NOT_CONSONANT }
const consonantType = (u: number): Consonant => {
    if (u === 0x0e1b || u === 0x0e1d || u === 0x0e1f) return Consonant.AC;
    if (u === 0x0e0d || u === 0x0e10) return Consonant.RC;
    if (u === 0x0e0e || u === 0x0e0f) return Consonant.DC;
    if (u >= 0x0e01 && u <= 0x0e2e) return Consonant.NC;
    return Consonant.NOT_CONSONANT;
};

const enum Mark { AV, BV, T, NOT_MARK }
const markType = (u: number): Mark => {
    if (u === 0x0e31 || u >= 0x0e34 && u <= 0x0e37 || u === 0x0e47 || u >= 0x0e4d && u <= 0x0e4e) return Mark.AV;
    if (u >= 0x0e38 && u <= 0x0e3a) return Mark.BV;
    if (u >= 0x0e48 && u <= 0x0e4c) return Mark.T;
    return Mark.NOT_MARK;
};

// shift down, left, down-left, remove the descender
const enum Action { NOP, SD, SL, SDL, RD }

// the Windows and Mac private use characters for each action
const PUA: Record<number, Array<[number, number, number]>> = {
    [Action.SD]: [[0x0e48, 0xf70a, 0xf88b], [0x0e49, 0xf70b, 0xf88e], [0x0e4a, 0xf70c, 0xf891], [0x0e4b, 0xf70d, 0xf894], [0x0e4c, 0xf70e, 0xf897],
        [0x0e38, 0xf718, 0xf89b], [0x0e39, 0xf719, 0xf89c], [0x0e3a, 0xf71a, 0xf89d]],
    [Action.SDL]: [[0x0e48, 0xf705, 0xf88c], [0x0e49, 0xf706, 0xf88f], [0x0e4a, 0xf707, 0xf892], [0x0e4b, 0xf708, 0xf895], [0x0e4c, 0xf709, 0xf898]],
    [Action.SL]: [[0x0e48, 0xf713, 0xf88a], [0x0e49, 0xf714, 0xf88d], [0x0e4a, 0xf715, 0xf890], [0x0e4b, 0xf716, 0xf893], [0x0e4c, 0xf717, 0xf896],
        [0x0e31, 0xf710, 0xf884], [0x0e34, 0xf701, 0xf885], [0x0e35, 0xf702, 0xf886], [0x0e36, 0xf703, 0xf887], [0x0e37, 0xf704, 0xf888],
        [0x0e47, 0xf712, 0xf889], [0x0e4d, 0xf711, 0xf899]],
    [Action.RD]: [[0x0e0d, 0xf70f, 0xf89a], [0x0e10, 0xf700, 0xf89e]],
};

function puaShape(u: number, action: Action, font: ShapeFont): number {
    if (action === Action.NOP) return u;
    for (const [from, win, mac] of PUA[action]) if (from === u) {
        if (font.hasGlyph(win)) return win;
        if (font.hasGlyph(mac)) return mac;
        break;
    }
    return u;
}

// how the marks above and below the consonant stack up: [action, next state] per mark type
const ABOVE_START = [0, 1, 0, 0, 3];
const ABOVE: Array<Array<[Action, number]>> = [
    [[Action.NOP, 3], [Action.NOP, 0], [Action.SD, 3]],
    [[Action.SL, 2], [Action.NOP, 1], [Action.SDL, 2]],
    [[Action.NOP, 3], [Action.NOP, 2], [Action.SL, 3]],
    [[Action.NOP, 3], [Action.NOP, 3], [Action.NOP, 3]],
];
const BELOW_START = [0, 0, 1, 2, 2];
const BELOW: Array<Array<[Action, number]>> = [
    [[Action.NOP, 0], [Action.NOP, 2], [Action.NOP, 0]],
    [[Action.NOP, 1], [Action.RD, 2], [Action.NOP, 1]],
    [[Action.NOP, 2], [Action.SD, 2], [Action.NOP, 2]],
];

// fonts without Thai GSUB position marks with private use glyphs
function puaShaping(buffer: Buffer, font: ShapeFont): void {
    let above = ABOVE_START[Consonant.NOT_CONSONANT], below = BELOW_START[Consonant.NOT_CONSONANT], base = 0;
    const info = buffer.info;
    for (let i = 0; i < info.length; i++) {
        const mt = markType(info[i].codepoint);
        if (mt === Mark.NOT_MARK) {
            const ct = consonantType(info[i].codepoint);
            above = ABOVE_START[ct];
            below = BELOW_START[ct];
            base = i;
            continue;
        }
        const aboveEdge = ABOVE[above][mt], belowEdge = BELOW[below][mt];
        above = aboveEdge[1];
        below = belowEdge[1];
        const action = aboveEdge[0] !== Action.NOP ? aboveEdge[0] : belowEdge[0];
        if (action === Action.RD) info[base].codepoint = puaShape(info[base].codepoint, action, font);
        else info[i].codepoint = puaShape(info[i].codepoint, action, font);
    }
}

const isSaraAm = (u: number): boolean => (u & ~0x80) === 0x0e33;
const isAboveBaseMark = (u: number): boolean => {
    const v = u & ~0x80;
    return v >= 0x0e34 && v <= 0x0e37 || v >= 0x0e47 && v <= 0x0e4e || v === 0x0e31 || v === 0x0e3b;
};

// SARA AM decomposes into NIKHAHIT and SARA AA, the NIKHAHIT moving back over above base marks (also for Lao)
function preprocessText(plan: Plan, buffer: Buffer, font: ShapeFont): void {
    buffer.clearOutput();
    const count = buffer.len;
    for (buffer.idx = 0; buffer.idx < count;) {
        const u = buffer.cur().codepoint;
        if (!isSaraAm(u)) {
            buffer.nextGlyph();
            continue;
        }
        const nikhahit = buffer.outputGlyph(u - 0x0e33 + 0x0e4d);
        buffer.hasContinuations = true;
        nikhahit.unicodeProps |= UnicodeProps.CONTINUATION;
        buffer.replaceGlyph(u - 1);
        const end = buffer.outLen;
        // (a mark of class 0 for width zeroing)
        setGeneralCategory(buffer.outInfo[end - 2], Category.Mn);
        let start = end - 2;
        while (start > 0 && isAboveBaseMark(buffer.outInfo[start - 1].codepoint)) start--;
        if (start + 2 < end) {
            buffer.mergeOutClusters(start, end);
            const t = buffer.outInfo[end - 2];
            for (let k = end - 2; k > start; k--) buffer.outInfo[k] = buffer.outInfo[k - 1];
            buffer.outInfo[start] = t;
        }
        // the NIKHAHIT combines with the cluster before
        if (start) buffer.mergeOutClusters(start - 1, end);
    }
    buffer.sync();
    if (plan.script === 'Thai' && !plan.map.foundScript[0]) puaShaping(buffer, font);
}

export const thaiShaper: Shaper = {
    preprocessText,
    normalization: Normalization.AUTO,
    zeroWidthMarks: ZeroMarks.BY_GDEF_LATE,
    fallbackPosition: false,
};
