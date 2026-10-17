/*!
 * The shaping buffer, ported from HarfBuzz (hb-buffer.hh, hb-buffer.cc)
 * Copyright © 1998-2004 David Turner and Werner Lemberg, © 2004-2007,2009,2010 Red Hat, Inc., © 2011,2012 Google, Inc.
 * Old MIT license (see THIRD_PARTY_NOTICES.md and licenses/HarfBuzz.txt)
 */

// glyph properties (from GDEF or guessed), the low byte; the mark attachment class is in the high byte
export const enum GlyphProps {
    BASE = 0x02,
    LIGATURE = 0x04,
    MARK = 0x08,
    CLASS_MASK = BASE | LIGATURE | MARK,
    SUBSTITUTED = 0x10,
    LIGATED = 0x20,
    MULTIPLIED = 0x40,
    PRESERVE = SUBSTITUTED | LIGATED | MULTIPLIED,
}

// unicode properties: the general category, flags, and the modified combining class in the high byte
export const enum UnicodeProps {
    GEN_CAT = 0x1f,
    IGNORABLE = 0x20,
    HIDDEN = 0x40,
    CONTINUATION = 0x80,
    ZWJ = 0x100,
    ZWNJ = 0x200,
    VS = 0x400,
}

// general categories, numbered like HarfBuzz's hb_unicode_general_category_t
export const enum Category {
    Cc, Cf, Cn, Co, Cs, Ll, Lm, Lo, Lt, Lu, Mc, Me, Mn, Nd, Nl, No, Pc, Pd, Pe, Pf, Pi, Po, Ps, Sc, Sk, Sm, So, Zl, Zp, Zs,
}
export const CATEGORY_NAMES = ['Cc', 'Cf', 'Cn', 'Co', 'Cs', 'Ll', 'Lm', 'Lo', 'Lt', 'Lu', 'Mc', 'Me', 'Mn', 'Nd', 'Nl', 'No', 'Pc', 'Pd', 'Pe', 'Pf',
    'Pi', 'Po', 'Ps', 'Sc', 'Sk', 'Sm', 'So', 'Zl', 'Zp', 'Zs'];
export const isMark = (category: number): boolean => category === Category.Mc || category === Category.Me || category === Category.Mn;

export const enum Direction { LTR = 4, RTL = 5 }

/** a character, then a glyph, with what shaping derives for it, and its position */
export class GlyphInfo {
    /** the code point, then the glyph id */
    codepoint = 0;
    mask = 0;
    cluster = 0;
    unicodeProps = 0;
    glyphProps = 0;
    ligProps = 0;
    syllable = 0;
    /** shaper data: categories, positions, actions */
    category = 0;
    position = 0;
    /** the glyph found for the character by the normalizer */
    glyphIndex = 0;
    xAdvance = 0;
    yAdvance = 0;
    xOffset = 0;
    yOffset = 0;
    attachChain = 0;
    attachType = 0;

    clone(): GlyphInfo {
        return Object.assign(new GlyphInfo(), this);
    }
}

// the most operations on a buffer, relative to its length (like HarfBuzz's max_ops, against runaway lookups)
const MAX_OPS_FACTOR = 64;
const MAX_OPS_MIN = 16384;
const MAX_LEN_FACTOR = 32;
const MAX_LEN_MIN = 8192;

export class Buffer {
    info: GlyphInfo[] = [];
    outInfo: GlyphInfo[] = [];
    idx = 0;
    outLen = 0;
    haveOutput = false;
    successful = true;
    direction: Direction = Direction.LTR;
    script = '';
    serial = 0;
    maxOps = 0;
    maxLen = 0;
    /** whether a default ignorable character, a continuation (mark) or CGJ is in the buffer */
    hasIgnorables = false;
    hasContinuations = false;
    hasCGJ = false;
    hasSpaceFallback = false;
    hasAttachment = false;
    /** whether the text starts at the buffer's start (dotted circles are inserted before marks at the start) */
    beginning = true;
    /** the characters before (closest first) and after the buffer */
    context: [number[], number[]] = [[], []];
    /** shaper flags */
    hasStch = false;
    hasBrokenSyllable = false;

    get len(): number {
        return this.info.length;
    }

    /** prepares the operation limits once the text is in */
    limit(): void {
        this.maxOps = Math.max(this.len * MAX_OPS_FACTOR, MAX_OPS_MIN);
        this.maxLen = Math.max(this.len * MAX_LEN_FACTOR, MAX_LEN_MIN);
    }

    cur(offset = 0): GlyphInfo {
        return this.info[this.idx + offset];
    }

    prev(): GlyphInfo {
        return this.outInfo[this.outLen - 1];
    }

    backtrackLen(): number {
        return this.haveOutput ? this.outLen : this.idx;
    }

    lookaheadLen(): number {
        return this.len - this.idx;
    }

    nextSerial(): number {
        this.serial = this.serial + 1 & 255;
        if (!this.serial) this.serial = 1;
        return this.serial;
    }

    clearOutput(): void {
        this.haveOutput = true;
        this.idx = 0;
        this.outLen = 0;
        this.outInfo = [];
    }

    sync(): void {
        if (this.successful) this.nextGlyphs(this.len - this.idx);
        if (this.successful) {
            this.outInfo.length = this.outLen;
            this.info = this.outInfo;
        }
        this.haveOutput = false;
        this.outLen = 0;
        this.outInfo = [];
        this.idx = 0;
    }

    private grow(count: number): boolean {
        if (this.outLen + count > this.maxLen) {
            this.successful = false;
            return false;
        }
        return true;
    }

    nextGlyph(): void {
        if (this.haveOutput) this.outInfo[this.outLen++] = this.info[this.idx];
        this.idx++;
    }

    nextGlyphs(n: number): void {
        if (this.haveOutput) for (let i = 0; i < n; i++) this.outInfo[this.outLen++] = this.info[this.idx + i];
        this.idx += n;
    }

    skipGlyph(): void {
        this.idx++;
    }

    replaceGlyphs(numIn: number, numOut: number, glyphs: ArrayLike<number>): void {
        if (!this.grow(numOut)) return;
        this.mergeClusters(this.idx, this.idx + numIn);
        const orig = this.idx < this.len ? this.cur() : this.prev();
        for (let i = 0; i < numOut; i++) {
            const info = orig.clone();
            info.codepoint = glyphs[i];
            this.outInfo[this.outLen++] = info;
        }
        this.idx += numIn;
    }

    replaceGlyph(glyph: number): void {
        this.replaceGlyphs(1, 1, [glyph]);
    }

    /** a copy of the current glyph with another id to the output */
    outputGlyph(glyph: number): GlyphInfo {
        this.replaceGlyphs(0, 1, [glyph]);
        return this.prev();
    }

    outputInfo(info: GlyphInfo): void {
        if (!this.grow(1)) return;
        this.outInfo[this.outLen++] = info;
    }

    copyGlyph(): void {
        this.outputInfo(this.cur().clone());
    }

    /** moves the output position to i (glyphs between the input and output shift over) */
    moveTo(i: number): boolean {
        if (!this.haveOutput) {
            this.idx = i;
            return true;
        }
        if (!this.successful) return false;
        if (this.outLen < i) {
            const count = i - this.outLen;
            if ((this.maxOps -= count) < 0) return this.successful = false;
            for (let k = 0; k < count; k++) this.outInfo[this.outLen++] = this.info[this.idx++];
        } else if (this.outLen > i) {
            const count = this.outLen - i;
            if ((this.maxOps -= count) < 0) return this.successful = false;
            // rewinding: the glyphs go back in front of the input
            if (this.idx < count) {
                const shift = count - this.idx;
                this.info.splice(this.idx, 0, ...Array.from({ length: shift }, () => new GlyphInfo()));
                this.idx += shift;
            }
            this.idx -= count;
            this.outLen -= count;
            for (let k = 0; k < count; k++) this.info[this.idx + k] = this.outInfo[this.outLen + k];
        }
        return true;
    }

    /** gives the glyphs from start to end the smallest of their clusters (extended over neighbors in the same ones) */
    mergeClusters(start: number, end: number): void {
        if (end - start < 2) return;
        if ((this.maxOps -= end - start) < 0) this.successful = false;
        const info = this.info;
        let cluster = info[start].cluster;
        for (let i = start + 1; i < end; i++) cluster = Math.min(cluster, info[i].cluster);

        if (cluster !== info[end - 1].cluster) while (end < this.len && info[end - 1].cluster === info[end].cluster) end++;
        if (cluster !== info[start].cluster) while (this.idx < start && info[start - 1].cluster === info[start].cluster) start--;
        // at the start of the input, the output continues it
        if (this.idx === start && info[start].cluster !== cluster)
            for (let i = this.outLen; i && this.outInfo[i - 1].cluster === info[start].cluster; i--) this.outInfo[i - 1].cluster = cluster;

        for (let i = start; i < end; i++) info[i].cluster = cluster;
    }

    mergeOutClusters(start: number, end: number): void {
        if (end - start < 2) return;
        if ((this.maxOps -= end - start) < 0) this.successful = false;
        const out = this.outInfo;
        let cluster = out[start].cluster;
        for (let i = start + 1; i < end; i++) cluster = Math.min(cluster, out[i].cluster);

        while (start && out[start - 1].cluster === out[start].cluster) start--;
        while (end < this.outLen && out[end - 1].cluster === out[end].cluster) end++;
        // at the end of the output, the input continues it
        if (end === this.outLen)
            for (let i = this.idx; i < this.len && this.info[i].cluster === out[end - 1].cluster; i++) this.info[i].cluster = cluster;

        for (let i = start; i < end; i++) out[i].cluster = cluster;
    }

    /** removes the current glyph, its cluster merges into a neighbor's if it was the last of it */
    deleteGlyph(): void {
        const cluster = this.info[this.idx].cluster;
        if (!(this.idx + 1 < this.len && cluster === this.info[this.idx + 1].cluster || this.outLen && cluster === this.outInfo[this.outLen - 1].cluster)) {
            if (this.outLen) {
                if (cluster < this.outInfo[this.outLen - 1].cluster) {
                    const old = this.outInfo[this.outLen - 1].cluster;
                    for (let i = this.outLen; i && this.outInfo[i - 1].cluster === old; i--) this.outInfo[i - 1].cluster = cluster;
                }
            } else if (this.idx + 1 < this.len) this.mergeClusters(this.idx, this.idx + 2);
        }
        this.skipGlyph();
    }

    /** removes the glyphs the filter matches, without an output */
    deleteGlyphsInplace(filter: (info: GlyphInfo) => boolean): void {
        const info = this.info;
        let j = 0;
        const count = info.length;
        for (let i = 0; i < count; i++) {
            if (filter(info[i])) {
                const cluster = info[i].cluster;
                if (i + 1 < count && cluster === info[i + 1].cluster) continue;
                if (j) {
                    if (cluster < info[j - 1].cluster) {
                        const old = info[j - 1].cluster;
                        for (let k = j; k && info[k - 1].cluster === old; k--) info[k - 1].cluster = cluster;
                    }
                    continue;
                }
                if (i + 1 < count) this.mergeClusters(i, i + 2);
                continue;
            }
            info[j++] = info[i];
        }
        info.length = j;
    }

    /** sorts a range stably, merging the clusters of what moves */
    sort(start: number, end: number, compare: (a: GlyphInfo, b: GlyphInfo) => number): void {
        const info = this.info;
        for (let i = start + 1; i < end; i++) {
            let j = i;
            while (j > start && compare(info[j - 1], info[i]) > 0) j--;
            if (i === j) continue;
            this.mergeClusters(j, i + 1);
            const t = info[i];
            for (let k = i; k > j; k--) info[k] = info[k - 1];
            info[j] = t;
        }
    }

    reverseRange(start: number, end: number): void {
        const info = this.info;
        for (let i = start, j = end - 1; i < j; i++, j--) {
            const t = info[i];
            info[i] = info[j];
            info[j] = t;
        }
    }

    reverse(): void {
        this.reverseRange(0, this.len);
    }

    /** reverses the groups (glyphs for which group is true for the one before), keeping each group's order */
    reverseGroups(group: (a: GlyphInfo, b: GlyphInfo) => boolean): void {
        if (!this.len) return;
        let start = 0, i = 1;
        for (; i < this.len; i++) {
            if (!group(this.info[i - 1], this.info[i])) {
                this.reverseRange(start, i);
                start = i;
            }
        }
        this.reverseRange(start, i);
        this.reverse();
    }

    /** the end of the group starting at start */
    groupEnd(start: number, group: (a: GlyphInfo, b: GlyphInfo) => boolean): number {
        while (++start < this.len && group(this.info[start - 1], this.info[start]));
        return start;
    }

    setMasks(value: number, mask: number, clusterStart: number, clusterEnd: number): void {
        if (!mask) return;
        value &= mask;
        for (const info of this.info)
            if (clusterStart <= info.cluster && info.cluster < clusterEnd) info.mask = info.mask & ~mask | value;
    }

    resetMasks(mask: number): void {
        for (const info of this.info) info.mask = mask;
    }

    addMasks(mask: number): void {
        for (const info of this.info) info.mask |= mask;
    }
}

// glyph and unicode property accessors (hb-ot-layout.hh)

export const generalCategory = (info: GlyphInfo): number => info.unicodeProps & UnicodeProps.GEN_CAT;
export const setGeneralCategory = (info: GlyphInfo, category: number): void => {
    // (like HarfBuzz, this drops the high bits: joiner and variation selector flags, combining class)
    info.unicodeProps = category | info.unicodeProps & (0xff & ~UnicodeProps.GEN_CAT);
};
export const isUnicodeMark = (info: GlyphInfo): boolean => isMark(generalCategory(info));
export const combiningClass = (info: GlyphInfo): number => isUnicodeMark(info) ? info.unicodeProps >> 8 : 0;
export const setCombiningClass = (info: GlyphInfo, cc: number): void => {
    if (isUnicodeMark(info)) info.unicodeProps = cc << 8 | info.unicodeProps & 0xff;
};
export const isUnicodeSpace = (info: GlyphInfo): boolean => generalCategory(info) === Category.Zs;
export const spaceFallback = (info: GlyphInfo): number => isUnicodeSpace(info) ? info.unicodeProps >> 8 : 0;
export const setSpaceFallback = (info: GlyphInfo, type: number): void => {
    if (isUnicodeSpace(info)) info.unicodeProps = type << 8 | info.unicodeProps & 0xff;
};
export const isDefaultIgnorable = (info: GlyphInfo): boolean => (info.unicodeProps & UnicodeProps.IGNORABLE) !== 0 && !(info.glyphProps & GlyphProps.SUBSTITUTED);
export const isHidden = (info: GlyphInfo): boolean => (info.unicodeProps & UnicodeProps.HIDDEN) !== 0;
export const isContinuation = (info: GlyphInfo): boolean => (info.unicodeProps & UnicodeProps.CONTINUATION) !== 0;
const isFormat = (info: GlyphInfo): boolean => generalCategory(info) === Category.Cf;
export const isZWNJ = (info: GlyphInfo): boolean => isFormat(info) && (info.unicodeProps & UnicodeProps.ZWNJ) !== 0;
export const isZWJ = (info: GlyphInfo): boolean => isFormat(info) && (info.unicodeProps & UnicodeProps.ZWJ) !== 0;
export const isJoiner = (info: GlyphInfo): boolean => isFormat(info) && (info.unicodeProps & (UnicodeProps.ZWJ | UnicodeProps.ZWNJ)) !== 0;
export const isVariationSelector = (info: GlyphInfo): boolean => isFormat(info) && (info.unicodeProps & UnicodeProps.VS) !== 0;

export const IS_LIG_BASE = 0x10;
export const ligId = (info: GlyphInfo): number => info.ligProps >> 5;
const ligatedInternal = (info: GlyphInfo): boolean => (info.ligProps & IS_LIG_BASE) !== 0;
export const ligComp = (info: GlyphInfo): number => ligatedInternal(info) ? 0 : info.ligProps & 0x0f;
export const ligNumComps = (info: GlyphInfo): number =>
    info.glyphProps & GlyphProps.LIGATURE && ligatedInternal(info) ? info.ligProps & 0x0f : 1;
export const setLigPropsForLigature = (info: GlyphInfo, id: number, count: number): void => {
    info.ligProps = id << 5 | IS_LIG_BASE | count & 0x0f;
};
export const setLigPropsForMark = (info: GlyphInfo, id: number, comp: number): void => {
    info.ligProps = id << 5 | comp & 0x0f;
};
export const isBaseGlyph = (info: GlyphInfo): boolean => (info.glyphProps & GlyphProps.BASE) !== 0;
export const isLigature = (info: GlyphInfo): boolean => (info.glyphProps & GlyphProps.LIGATURE) !== 0;
export const isMarkGlyph = (info: GlyphInfo): boolean => (info.glyphProps & GlyphProps.MARK) !== 0;
export const isSubstituted = (info: GlyphInfo): boolean => (info.glyphProps & GlyphProps.SUBSTITUTED) !== 0;
export const isLigated = (info: GlyphInfo): boolean => (info.glyphProps & GlyphProps.LIGATED) !== 0;
export const isMultiplied = (info: GlyphInfo): boolean => (info.glyphProps & GlyphProps.MULTIPLIED) !== 0;
export const ligNumCompsInLigation = (info: GlyphInfo): number => isMultiplied(info) && ligComp(info) ? 0 : ligNumComps(info);
export const allocateLigId = (buffer: Buffer): number => {
    let id = buffer.nextSerial() & 7;
    while (!id) id = buffer.nextSerial() & 7;
    return id;
};
