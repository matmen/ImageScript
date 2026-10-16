// color glyphs: layers of outlines with palette colors (COLR version 0 with CPAL), and bitmaps (CBDT/CBLC, PNG)

import { Font } from './font.ts';

/** an outline glyph drawn in a color, RGBA as 0xrrggbbaa (null: the text color) */
export interface ColorLayer {
    glyph: number;
    color: number | null;
}

/** a glyph's PNG and where it goes, in pixels of its strike */
export interface BitmapGlyph {
    png: Uint8Array;
    /** pixels per em of the strike */
    ppem: number;
    /** size of the bitmap */
    width: number;
    height: number;
    /** offset of the bitmap's left edge from the pen position */
    left: number;
    /** offset of the bitmap's top edge above the baseline */
    top: number;
}

/**
 * The layers of the font's color glyphs (COLR version 0 records, with the colors of the first CPAL palette), null if the
 * font has none. The lookup returns null for glyphs without layers
 */
export function parseColorLayers(font: Font): ((glyph: number) => ColorLayer[] | null) | null {
    const colr = font.tables.COLR?.offset, cpal = font.tables.CPAL?.offset;
    if (colr === undefined || cpal === undefined) return null;

    const baseCount = font.u16(colr + 2), bases = colr + font.u32(colr + 4), layers = colr + font.u32(colr + 8);
    if (!baseCount) return null;

    // the first palette
    const entries = font.u16(cpal + 2), records = cpal + font.u32(cpal + 8), first = font.u16(cpal + 12);
    const color = (index: number): number | null => {
        if (index === 0xffff || index >= entries) return null;
        const o = records + (first + index) * 4; // blue, green, red, alpha
        return (font.u8(o + 2) << 24 | font.u8(o + 1) << 16 | font.u8(o) << 8 | font.u8(o + 3)) >>> 0;
    };

    const cache = new Map<number, ColorLayer[] | null>();
    return glyph => {
        let result = cache.get(glyph);
        if (result !== undefined) return result;
        result = null;
        // base glyph records are sorted by glyph
        for (let lo = 0, hi = baseCount - 1; lo <= hi;) {
            const mid = lo + hi >> 1, record = bases + mid * 6, id = font.u16(record);
            if (id < glyph) lo = mid + 1;
            else if (id > glyph) hi = mid - 1;
            else {
                const start = font.u16(record + 2), count = font.u16(record + 4);
                result = [];
                for (let i = 0; i < count; i++) {
                    const layer = layers + (start + i) * 4;
                    result.push({ glyph: font.u16(layer), color: color(font.u16(layer + 2)) });
                }
                break;
            }
        }
        cache.set(glyph, result);
        return result;
    };
}

/**
 * The font's bitmap glyphs (CBDT/CBLC with PNG images) from the strike closest to `size` (the smallest at least as
 * large, else the largest), null if the font has none. The lookup returns null for glyphs without a bitmap
 */
export function parseBitmaps(font: Font, size: number): ((glyph: number) => BitmapGlyph | null) | null {
    const cblc = font.tables.CBLC?.offset, cbdt = font.tables.CBDT?.offset;
    if (cblc === undefined || cbdt === undefined) return null;

    const sizes = font.u32(cblc + 4);
    let strike = -1, strikePpem = 0;
    for (let i = 0; i < sizes; i++) {
        const ppem = font.u8(cblc + 8 + i * 48 + 45);
        const better = strike < 0 || (strikePpem < size ? ppem > strikePpem : ppem >= size && ppem < strikePpem);
        if (better) { strike = cblc + 8 + i * 48; strikePpem = ppem; }
    }
    if (strike < 0) return null;

    const array = cblc + font.u32(strike), subtables = font.u32(strike + 8);

    // where a glyph's data starts in CBDT, its image format, and its metrics if the index holds them (image format 19)
    const locate = (glyph: number): { offset: number, format: number, metrics: number } | null => {
        for (let i = 0; i < subtables; i++) {
            const entry = array + i * 8, firstGlyph = font.u16(entry), lastGlyph = font.u16(entry + 2);
            if (glyph < firstGlyph || glyph > lastGlyph) continue;

            const header = array + font.u32(entry + 4);
            const indexFormat = font.u16(header), format = font.u16(header + 2), data = cbdt + font.u32(header + 4), k = glyph - firstGlyph;
            switch (indexFormat) {
                case 1: {
                    const start = font.u32(header + 8 + k * 4), end = font.u32(header + 12 + k * 4);
                    return end > start ? { offset: data + start, format, metrics: -1 } : null;
                }
                case 2: return { offset: data + k * font.u32(header + 8), format, metrics: header + 12 };
                case 3: {
                    const start = font.u16(header + 8 + k * 2), end = font.u16(header + 10 + k * 2);
                    return end > start ? { offset: data + start, format, metrics: -1 } : null;
                }
                case 4: {
                    const count = font.u32(header + 8);
                    for (let j = 0; j < count; j++) {
                        const pair = header + 12 + j * 4;
                        if (font.u16(pair) === glyph) return { offset: data + font.u16(pair + 2), format, metrics: -1 };
                    }
                    return null;
                }
                case 5: {
                    const size = font.u32(header + 8), count = font.u32(header + 20);
                    for (let j = 0; j < count; j++)
                        if (font.u16(header + 24 + j * 2) === glyph) return { offset: data + j * size, format, metrics: header + 12 };
                    return null;
                }
                default: return null;
            }
        }
        return null;
    };

    const cache = new Map<number, BitmapGlyph | null>();
    return glyph => {
        let result = cache.get(glyph);
        if (result !== undefined) return result;
        result = null;

        const location = locate(glyph);
        if (location) {
            const { format } = location;
            let o = location.offset, metrics = location.metrics;
            // small metrics (height, width, bearingX, bearingY, advance) and big ones start alike
            if (format === 17) { metrics = o; o += 5; }
            else if (format === 18) { metrics = o; o += 8; }
            if ((format === 17 || format === 18 || format === 19) && metrics >= 0) {
                const length = font.u32(o);
                result = { png: font.data.subarray(o + 4, o + 4 + length), ppem: strikePpem, width: font.u8(metrics + 1), height: font.u8(metrics), left: font.i8(metrics + 2), top: font.i8(metrics + 3) };
            }
        }

        cache.set(glyph, result);
        return result;
    };
}
