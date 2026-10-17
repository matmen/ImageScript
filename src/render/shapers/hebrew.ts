/*!
 * The Hebrew shaper, ported from HarfBuzz (hb-ot-shaper-hebrew.cc)
 * Copyright © 2010,2012 Google, Inc., Old MIT license (see THIRD_PARTY_NOTICES.md and licenses/HarfBuzz.txt)
 */

import { combiningClass } from '../buffer.ts';
import { Shaper, Normalization, ZeroMarks, compose } from '../shape.ts';

// presentation forms with dagesh for U+05D0..U+05EA (0 where none is encoded)
const DAGESH_FORMS = [0xfb30, 0xfb31, 0xfb32, 0xfb33, 0xfb34, 0xfb35, 0xfb36, 0, 0xfb38, 0xfb39, 0xfb3a, 0xfb3b, 0xfb3c, 0, 0xfb3e, 0, 0xfb40, 0xfb41, 0,
    0xfb43, 0xfb44, 0, 0xfb46, 0xfb47, 0xfb48, 0xfb49, 0xfb4a];

// presentation forms excluded from normalization, for old fonts without mark positioning
const PRESENTATION: Record<number, Record<number, number>> = {
    0x05b4: { 0x05d9: 0xfb1d },
    0x05b7: { 0x05f2: 0xfb1f, 0x05d0: 0xfb2e },
    0x05b8: { 0x05d0: 0xfb2f },
    0x05b9: { 0x05d5: 0xfb4b },
    0x05bf: { 0x05d1: 0xfb4c, 0x05db: 0xfb4d, 0x05e4: 0xfb4e },
    0x05c1: { 0x05e9: 0xfb2a, 0xfb49: 0xfb2c },
    0x05c2: { 0x05e9: 0xfb2b, 0xfb49: 0xfb2d },
};

export const hebrewShaper: Shaper = {
    compose: (c, a, b) => {
        const found = compose(a, b);
        if (found || c.plan.hasGposMark) return found;
        if (b === 0x05bc) {
            if (a >= 0x05d0 && a <= 0x05ea) return DAGESH_FORMS[a - 0x05d0];
            if (a === 0xfb2a) return 0xfb2c;
            if (a === 0xfb2b) return 0xfb2d;
            return 0;
        }
        return PRESENTATION[b]?.[a] ?? 0;
    },
    // patah or qamats, sheva or hiriq, meteg or below: the meteg goes before the sheva or hiriq
    reorderMarks: (_plan, buffer, start, end) => {
        const info = buffer.info;
        for (let i = start + 2; i < end; i++) {
            const c0 = combiningClass(info[i - 2]), c1 = combiningClass(info[i - 1]), c2 = combiningClass(info[i]);
            if ((c0 === 20 || c0 === 21) && (c1 === 22 || c1 === 23) && (c2 === 25 || c2 === 220)) {
                buffer.mergeClusters(i - 1, i + 1);
                [info[i - 1], info[i]] = [info[i], info[i - 1]];
                break;
            }
        }
    },
    gposTag: 'hebr',
    normalization: Normalization.AUTO,
    zeroWidthMarks: ZeroMarks.BY_GDEF_LATE,
    fallbackPosition: true,
};
