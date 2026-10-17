/*!
 * The Rasterizer class is translated from font-rs (https://github.com/raphlinus/font-rs)
 * Copyright 2015 Google Inc., Apache License 2.0 (see THIRD_PARTY_NOTICES.md and licenses/Apache-2.0.txt)
 */

import { Font, PathCommand } from './font.ts';
import { Hinter } from './hinting.ts';
import { ColorLayer, BitmapGlyph, parseColorLayers, parseBitmaps } from './color.ts';
import { Direction } from './buffer.ts';
import { ShapeFont, shapeFont, shapeRun, isDefaultIgnorableCodepoint } from './shape.ts';
import './shapers/index.ts';
import { classOf, resolve, lineLevels, Paragraph as BidiParagraph } from './bidi.ts';
import { lineBreaks, Break } from './linebreak.ts';
import { graphemeBoundaries, scripts } from './segment.ts';
import { PaintGlyphs, parsePaintGlyphs, paintExtent, renderPaintGlyph } from './colr.ts';
import { decode as decodePNG } from '../codecs/png.ts';
import { resample, TRIANGLE } from '../util/resample.ts';

export interface Layout {
    maxWidth: number;
    maxHeight: number;
    wrapStyle: 'word' | 'char';
    horizontalAlign: 'left' | 'center' | 'right';
    verticalAlign: 'top' | 'middle' | 'bottom';
    wrapHardBreaks: boolean;
}

export interface GlyphBitmap {
    data: Uint8Array;
    width: number;
    height: number;
    /** offset from the pen position */
    left: number;
    /** offset above the baseline */
    top: number;
}

/** a color glyph's premultiplied RGBA pixels, placed like a {@link GlyphBitmap} */
interface ColorBitmap {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    left: number;
    top: number;
}

/** a font with what's derived from it for one size, and its glyphs (kept across calls) */
interface SizedFont {
    font: Font;
    /** pixels per font unit */
    scale: number;
    hinter: Hinter | null;
    layers: ((glyph: number) => ColorLayer[] | null) | null;
    bitmaps: ((glyph: number) => BitmapGlyph | null) | null;
    paints: PaintGlyphs | null;
    shaping: ShapeFont;
    glyphs: Map<number, Glyph>;
}

interface Glyph {
    index: number;
    font: SizedFont;
    /** outline and its scale to pixels (1 for hinted outlines, which are in pixels) */
    path: PathCommand[];
    scale: number;
    /** advance width in pixels */
    advance: number;
    /** horizontal ink extent relative to the pen position in pixels, null for glyphs without outline */
    ink: { left: number, right: number } | null;
    /** bitmaps per subpixel offset */
    bitmaps: Array<GlyphBitmap | null>;
    /** the paint graph (COLR version 1), the layers (version 0) or the bitmap of color glyphs */
    color: { paint: true } | { layers: ColorLayer[] } | { bitmap: BitmapGlyph } | null;
    /** color bitmaps by subpixel offset and text color (bitmap glyphs only have the one for offset 0) */
    colors: Map<string, ColorBitmap | null>;
}

/** a glyph placed on a line: its pen position and the offset of its drawing (up is positive) in pixels */
interface PlacedGlyph {
    x: number;
    dx: number;
    dy: number;
    glyph: Glyph;
}

interface Line {
    glyphs: PlacedGlyph[];
    /** the right edge of the ink */
    extent: number;
}

// glyphs are rasterized at quarter pixel offsets
const SUBPIXELS = 4;
// the largest glyph bitmap (2^26 pixels, 8192 pixels square)
const MAX_GLYPH_PIXELS = 1 << 26;

// parsed fonts are cached per memory region, so new views of the same font data (e.g. from node Buffers) hit the cache
const fonts = new WeakMap<ArrayBufferLike, Map<string, Font>>();
const hinters = new WeakMap<Font, Hinter>();
const colorTables = new WeakMap<Font, { layers: ((glyph: number) => ColorLayer[] | null) | null, paints: PaintGlyphs | null }>();
// sizes (and hinting) per font, a few of them
const sizes = new WeakMap<Font, Map<string, SizedFont>>();
const SIZES = 16;

function loadFont(data: Uint8Array): Font {
    let regions = fonts.get(data.buffer);
    if (!regions) fonts.set(data.buffer, regions = new Map<string, Font>());

    const key = `${data.byteOffset}:${data.byteLength}`;
    let font = regions.get(key);
    if (!font) regions.set(key, font = new Font(data));
    return font;
}

function sizedFont(data: Uint8Array, size: number, hinting: boolean): SizedFont {
    const font = loadFont(data);
    let bySize = sizes.get(font);
    if (!bySize) sizes.set(font, bySize = new Map<string, SizedFont>());
    const key = `${size}:${hinting}`;
    let sized = bySize.get(key);
    if (sized) return sized;

    let hinter: Hinter | null = null;
    if (hinting && font.outlines === 'glyf') {
        hinter = hinters.get(font) ?? null;
        if (!hinter) hinters.set(font, hinter = new Hinter(font));
        if (!hinter.hasInstructions) hinter = null;
    }
    let shared = colorTables.get(font);
    if (!shared) colorTables.set(font, shared = { layers: parseColorLayers(font), paints: parsePaintGlyphs(font) });

    if (bySize.size >= SIZES) bySize.clear();
    bySize.set(key, sized = { font, scale: size / font.unitsPerEm, hinter, layers: shared.layers, bitmaps: parseBitmaps(font, size), paints: shared.paints, shaping: shapeFont(font), glyphs: new Map() });
    return sized;
}

// a glyph of a font, with its outline or color glyph data (hinted glyphs advance by whole pixels)
function glyphOf(f: SizedFont, index: number, size: number): Glyph {
    let g = f.glyphs.get(index);
    if (g) return g;

    const { font, scale, hinter } = f;
    // renderers that support COLR version 1 prefer it over the other color glyphs
    const paint = f.paints !== null && f.paints.paint(index) !== null;
    const bitmap = paint ? null : f.bitmaps?.(index) ?? null, layers = paint || bitmap ? null : f.layers?.(index) ?? null;
    const advance = font.advance(index) * scale;
    g = { index, font: f, path: [], scale, advance: hinter ? Math.round(advance) : advance, ink: null, bitmaps: [], color: null, colors: new Map() };
    if (paint) {
        g.color = { paint: true };
        const extent = paintExtent(font, f.paints as PaintGlyphs, index, glyph => font.outline(glyph));
        g.ink = extent && { left: extent.left * scale, right: extent.right * scale };
    } else if (bitmap) {
        const s = size / bitmap.ppem;
        g.color = { bitmap };
        g.ink = { left: bitmap.left * s, right: (bitmap.left + bitmap.width) * s };
    } else if (layers) {
        g.color = { layers };
        g.ink = inkExtent(layers.flatMap(layer => font.outline(layer.glyph)), scale);
    } else {
        const hinted = hinter && hinter.glyph(index, size);
        if (hinted) Object.assign(g, { path: hinted.path, scale: 1, advance: hinted.advance, ink: inkExtent(hinted.path, 1) });
        else {
            g.path = font.outline(index);
            g.ink = inkExtent(g.path, scale);
        }
    }
    f.glyphs.set(index, g);
    return g;
}

/**
 * Lays out and rasterizes text
 * Lines start at ceil(ascender) and advance by ceil(ascender - descender + lineGap) of the first font. Every grapheme
 * (a character with its joined, modifying and combining ones, like an emoji sequence) comes from the first font that
 * has all of it. Paragraphs are ordered by the bidirectional algorithm, runs of one direction, script and font shaped
 * like HarfBuzz (see shape.ts), lines broken at UAX #14 opportunities. Glyphs are placed with subpixel precision; the
 * canvas spans from the origin to the furthest glyph edge
 * @param fonts TrueType/OpenType fonts, by priority (later ones are only loaded when the text needs them)
 * @param size font size in pixels per em
 * @param text
 * @param layout
 * @param hinting Whether to run TrueType fonts' hinting instructions, the glyphs of hinted fonts are then placed on
 *     whole pixels (fonts without instructions render as without hinting)
 * @param foreground RGBA color (0xrrggbbaa) of color glyph layers drawn in the text color
 * @return the coverage of the outline glyphs, and the premultiplied RGBA pixels of color glyphs (null without any)
 */
export async function render(fonts: Uint8Array[], size: number, text: string, layout: Layout, hinting = false, foreground = 0xffffffff): Promise<{ width: number, height: number, coverage: Uint8Array, color: Uint8ClampedArray | null }> {
    // reading past the end of damaged or truncated font data throws a RangeError
    try {
        return await layOut(fonts, size, text, layout, hinting, foreground);
    } catch (err) {
        if (err instanceof RangeError && !(err instanceof TooLarge)) throw new Error('Font: damaged or truncated font data', { cause: err });
        throw err;
    }
}

// rendered text larger than 2^28 pixels (16384 square)
const MAX_PIXELS = 1 << 28;
class TooLarge extends RangeError {}

async function layOut(fonts: Uint8Array[], size: number, text: string, layout: Layout, hinting: boolean, foreground: number): Promise<{ width: number, height: number, coverage: Uint8Array, color: Uint8ClampedArray | null }> {
    const sized: SizedFont[] = [];
    const font = (i: number): SizedFont => sized[i] ??= sizedFont(fonts[i], size, hinting);
    const primary = font(0);
    const ascent = Math.ceil(primary.font.ascender * primary.scale);
    // (at least a pixel, damaged fonts can have any metrics)
    const lineHeight = Math.max(1, Math.ceil((primary.font.ascender - primary.font.descender + primary.font.lineGap) * primary.scale));

    // paragraphs end at hard line breaks (CR LF, CR, LF, NEL, LS, PS) unless they are ignored
    const paragraphs = layout.wrapHardBreaks ? text.split(/\r\n|[\r\n\u0085\u2028\u2029]/) : [text.replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, '')];
    const lines: Line[] = [];
    for (const paragraph of paragraphs) lines.push(...layOutParagraph(analyze(paragraph, fonts.length, font), layout, font, size));

    // lines that fit into maxHeight, chosen by the vertical alignment
    let visible = lines;
    if (isFinite(layout.maxHeight)) {
        const count = Math.max(1, Math.floor(layout.maxHeight / lineHeight));
        if (count < lines.length) {
            const start = layout.verticalAlign === 'bottom' ? lines.length - count
                : layout.verticalAlign === 'middle' ? lines.length - count >> 1 : 0;
            visible = lines.slice(start, start + count);
        }
    }

    // text without ink (empty, spaces) still makes an image, a transparent pixel wide
    const width = Math.max(1, Math.ceil(Math.max(0, ...visible.map(line => line.extent))));
    const height = visible.length * lineHeight;
    if (!(width * height <= MAX_PIXELS)) throw new TooLarge(`Text too large to render (${width}x${height} pixels)`);
    const coverage = new Uint8Array(width * height);
    let color: Uint8ClampedArray | null = null;

    for (const [n, line] of visible.entries()) {
        let offset = layout.horizontalAlign === 'right' ? width - line.extent
            : layout.horizontalAlign === 'center' ? (width - line.extent) / 2 : 0;
        if (primary.hinter) offset = Math.round(offset);
        const baseline = ascent + n * lineHeight;

        for (const { x, dx, dy, glyph: g } of line.glyphs) {
            if (!g.ink) continue;

            // whole pixels plus the closest subpixel offset (none for hinted glyphs); vertical offsets on whole pixels
            const position = g.font.hinter ? Math.round(offset + x + dx) : Math.round((offset + x + dx) * SUBPIXELS) / SUBPIXELS;
            const y = baseline - Math.round(dy);
            const pixel = Math.floor(position);
            let subpixel = Math.round((position - pixel) * SUBPIXELS);

            if (g.color) {
                // bitmaps are placed on whole pixels
                if ('bitmap' in g.color) subpixel = 0;
                const key = 'bitmap' in g.color ? '0' : `${subpixel}:${foreground}`;
                let bitmap = g.colors.get(key);
                if (bitmap === undefined) g.colors.set(key, bitmap = 'bitmap' in g.color
                    ? await scaledBitmap(g.color.bitmap, size / g.color.bitmap.ppem)
                    : 'layers' in g.color ? layeredGlyph(g, g.color.layers, subpixel / SUBPIXELS, foreground)
                        : paintedGlyph(g, subpixel / SUBPIXELS, foreground));
                if (bitmap) blitColor(color ??= new Uint8ClampedArray(width * height * 4), width, height, bitmap, pixel + bitmap.left, y - bitmap.top);
                continue;
            }

            if (g.bitmaps[subpixel] === undefined) g.bitmaps[subpixel] = rasterizeGlyph(g.path, g.scale, subpixel / SUBPIXELS);
            const bitmap = g.bitmaps[subpixel];
            if (bitmap) blit(coverage, width, height, bitmap, pixel + bitmap.left, y - bitmap.top);
        }
    }

    return { width, height, coverage, color };
}

/** a paragraph's text with what laying it out needs */
interface Paragraph {
    codepoints: number[];
    bidi: BidiParagraph;
    /** per character: its font, its script for shaping */
    fontOf: Int32Array;
    scripts: string[];
    /** UAX #14 break opportunities and grapheme boundaries before each character (and at the end) */
    breaks: Uint8Array;
    graphemes: Uint8Array;
}

/**
 * The analysis of a paragraph: its bidirectional levels, graphemes, scripts, line breaks, and fonts. Every grapheme
 * comes from the first font that has all of its (visible) characters, composed or decomposed, preferring color glyphs
 * before an emoji variation selector and others before a text one
 */
function analyze(text: string, count: number, font: (i: number) => SizedFont): Paragraph {
    const codepoints = Array.from(text, char => char.codePointAt(0) as number);
    const n = codepoints.length;
    const has = (f: SizedFont, codepoint: number): boolean => f.font.glyphIndex(codepoint) !== 0;
    const isColor = (f: SizedFont, codepoint: number): boolean => {
        const index = f.font.glyphIndex(codepoint);
        return !!(f.paints && f.paints.paint(index) !== null || f.bitmaps?.(index) || f.layers?.(index));
    };

    // the font of a grapheme (later fonts are only loaded when the earlier ones miss a character), -1 if none has all
    const choose = (grapheme: number[]): number => {
        const needed = grapheme.filter(c => !isDefaultIgnorableCodepoint(c));
        const variation = grapheme.find(c => c === 0xfe0f || c === 0xfe0e);
        let first = -1;
        for (let i = 0; i < count; i++) {
            const f = font(i);
            if (!needed.every(c => has(f, c))) continue;
            if (first < 0) first = i;
            if (!variation || !needed.length || (variation === 0xfe0f) === isColor(f, needed[0])) return i;
        }
        return first;
    };
    const normalized = (grapheme: number[], form: string): number[] => Array.from(String.fromCodePoint(...grapheme).normalize(form), char => char.codePointAt(0) as number);

    const graphemes = graphemeBoundaries(codepoints), fontOf = new Int32Array(n);
    for (let start = 0; start < n;) {
        let end = start + 1;
        while (end < n && !graphemes[end]) end++;
        const grapheme = codepoints.slice(start, end);
        // (shaping composes and decomposes like the font needs)
        // (the other form only when needed)
        let chosen = grapheme.length > 1 ? choose(normalized(grapheme, 'NFC')) : choose(grapheme);
        if (chosen < 0) chosen = choose(grapheme.length > 1 ? grapheme : normalized(grapheme, 'NFD'));
        if (chosen >= 0) fontOf.fill(chosen, start, end);
        else for (let k = start; k < end; k++) fontOf[k] = Math.max(0, choose([codepoints[k]]));
        start = end;
    }

    return {
        codepoints, fontOf, graphemes,
        bidi: resolve(codepoints.map(classOf), codepoints),
        scripts: scripts(codepoints),
        breaks: lineBreaks(codepoints),
    };
}

// characters of context around a run for joining scripts
const CONTEXT = 5;

/**
 * Shapes the characters start to end of a paragraph with the given embedding levels: runs of one level, script and
 * font, in visual order. The glyphs are placed from x = 0; advances is the width by cluster (its first character)
 */
function shapeRange(p: Paragraph, start: number, end: number, levels: ArrayLike<number>, font: (i: number) => SizedFont, size: number): { glyphs: PlacedGlyph[], width: number, advances: Map<number, number> } {
    // runs: [start, end, level], characters removed by bidi rule X9 take the level before them
    const runs: Array<[number, number, number]> = [];
    let lastLevel = p.bidi.level;
    const levelAt = (i: number): number => levels[i] >= 0 ? lastLevel = levels[i] : lastLevel;
    for (let i = start; i < end;) {
        const level = levelAt(i), script = p.scripts[i], f = p.fontOf[i];
        let j = i + 1;
        while (j < end && (levels[j] < 0 || levels[j] === level) && p.scripts[j] === script && p.fontOf[j] === f) j++;
        runs.push([i, j, level]);
        i = j;
    }

    // L2: from the highest level to the lowest odd one, reverse sequences of runs at that level or higher
    let highest = 0, lowestOdd = Infinity;
    for (const [, , level] of runs) {
        highest = Math.max(highest, level);
        if (level & 1) lowestOdd = Math.min(lowestOdd, level);
    }
    for (let level = highest; level >= lowestOdd; level--)
        for (let i = 0; i < runs.length;) {
            if (runs[i][2] < level) {
                i++;
                continue;
            }
            let j = i;
            while (j < runs.length && runs[j][2] >= level) j++;
            const reversed = runs.slice(i, j).reverse();
            for (let k = i; k < j; k++) runs[k] = reversed[k - i];
            i = j;
        }

    const glyphs: PlacedGlyph[] = [], advances = new Map<number, number>();
    // hinted glyphs: their hinted advances, with the positioning's adjustments rounded as they add up (so that a
    // kerning split between two glyphs is rounded once)
    let x = 0, adjustment = 0;
    for (const [rs, re, level] of runs) {
        const f = font(p.fontOf[rs]);
        const before = p.codepoints.slice(Math.max(0, rs - CONTEXT), rs).reverse(), after = p.codepoints.slice(re, re + CONTEXT);
        const clusters = Array.from({ length: re - rs }, (_, k) => rs + k);
        const shaped = shapeRun(f.shaping, p.codepoints.slice(rs, re), p.scripts[rs], level & 1 ? Direction.RTL : Direction.LTR, clusters, { before, after });
        for (const info of shaped) {
            const g = glyphOf(f, info.codepoint, size);
            let advance: number;
            if (f.hinter) {
                // (x already holds the rounded adjustment so far)
                const before = Math.round(adjustment);
                glyphs.push({ x, dx: Math.round(adjustment + info.xOffset * f.scale) - before, dy: Math.round(info.yOffset * f.scale), glyph: g });
                adjustment += (info.xAdvance - f.font.advance(info.codepoint)) * f.scale;
                advance = g.advance + Math.round(adjustment) - before;
            } else {
                advance = info.xAdvance * f.scale;
                glyphs.push({ x, dx: info.xOffset * f.scale, dy: info.yOffset * f.scale, glyph: g });
            }
            advances.set(info.cluster, (advances.get(info.cluster) ?? 0) + advance);
            x += advance;
        }
    }
    return { glyphs, width: x, advances };
}

// whitespace that hangs at the end of a line (not counted when it fits)
const isSpace = (codepoint: number): boolean => codepoint === 0x20 || codepoint === 0x09 || codepoint === 0x3000 || codepoint >= 0x2000 && codepoint <= 0x200a;

/** breaks a paragraph into lines and shapes them (reordered by the bidirectional algorithm) */
function layOutParagraph(p: Paragraph, layout: Layout, font: (i: number) => SizedFont, size: number): Line[] {
    const n = p.codepoints.length;
    if (!n) return [{ glyphs: [], extent: 0 }];

    // the width of each character's cluster in the paragraph shaped as one line (characters within a cluster have
    // none, and lines can't break inside clusters)
    const whole = shapeRange(p, 0, n, p.bidi.levels, font, size);
    const width = new Float64Array(n), starts = new Uint8Array(n + 1);
    starts[n] = 1;
    for (const [cluster, advance] of whole.advances) {
        width[cluster] = advance;
        starts[cluster] = 1;
    }
    // (characters the shaping removed belong to the cluster before them)
    starts[0] = 1;

    // where lines can end: break opportunities (or graphemes, for char wrapping) at cluster starts
    const canBreak = (i: number): boolean => starts[i] === 1 && (layout.wrapStyle === 'char' ? p.graphemes[i] === 1 : p.breaks[i] !== Break.None);
    const ranges: Array<[number, number]> = [];
    let lineStart = 0;
    while (lineStart < n) {
        let fit = -1, emergency = -1, used = 0, trailing = 0;
        for (let i = lineStart; i < n; i++) {
            used += width[i];
            trailing = isSpace(p.codepoints[i]) ? trailing + width[i] : 0;
            const end = i + 1;
            if (!starts[end]) continue;
            // mandatory breaks (line separators) end the line
            if (p.breaks[end] === Break.Mandatory && end < n && layout.wrapHardBreaks) {
                fit = end;
                break;
            }
            const fits = used - trailing <= layout.maxWidth;
            if (!fits) break;
            if (canBreak(end)) fit = end;
            if (p.graphemes[end]) emergency = end;
        }
        // a line holds at least one grapheme: words wider than the line break between graphemes
        if (fit < 0) {
            fit = emergency;
            if (fit < 0) {
                fit = lineStart + 1;
                while (fit < n && !(starts[fit] && p.graphemes[fit])) fit++;
            }
        }
        ranges.push([lineStart, fit]);
        lineStart = fit;
    }

    // every line shaped by itself, with the levels of rule L1
    return ranges.map(([start, end]) => {
        const levels = lineLevels(p.bidi, start, end);
        const shifted = new Int8Array(n);
        shifted.set(levels, start);
        const { glyphs } = ranges.length === 1 ? whole : shapeRange(p, start, end, shifted, font, size);
        let extent = 0;
        for (const { x, dx, glyph } of glyphs) if (glyph.ink) extent = Math.max(extent, x + dx + glyph.ink.right);
        return { glyphs, extent };
    });
}

// a bitmap glyph's PNG decoded and scaled from its strike to the font size, premultiplied
async function scaledBitmap(glyph: BitmapGlyph, scale: number): Promise<ColorBitmap | null> {
    let decoded;
    try {
        decoded = await decodePNG(glyph.png);
    } catch {
        return null;
    }
    const width = Math.max(1, Math.round(decoded.width * scale)), height = Math.max(1, Math.round(decoded.height * scale));
    const data = new Uint8ClampedArray(width * height * 4);
    resample(new Uint8ClampedArray(decoded.pixels.buffer, decoded.pixels.byteOffset, decoded.pixels.length), decoded.width, decoded.height, width, height, TRIANGLE, data, true);
    premultiply(data);
    return { data, width, height, left: Math.round(glyph.left * scale), top: Math.round(glyph.top * scale) };
}

// a layered color glyph: every layer's outline filled with its color over the ones below, premultiplied
function layeredGlyph(g: Glyph, layers: ColorLayer[], offset: number, foreground: number): ColorBitmap | null {
    const rasters = layers.map(layer => ({ bitmap: rasterizeGlyph(g.font.font.outline(layer.glyph), g.scale, offset), color: layer.color ?? foreground }));
    let left = Infinity, top = -Infinity, right = -Infinity, bottom = Infinity;
    for (const { bitmap } of rasters) if (bitmap) {
        left = Math.min(left, bitmap.left);
        top = Math.max(top, bitmap.top);
        right = Math.max(right, bitmap.left + bitmap.width);
        bottom = Math.min(bottom, bitmap.top - bitmap.height);
    }
    if (right <= left) return null;

    const width = right - left, height = top - bottom;
    const data = new Uint8ClampedArray(width * height * 4);
    for (const { bitmap, color } of rasters) {
        if (!bitmap) continue;
        const r = color >>> 24, gr = color >> 16 & 255, b = color >> 8 & 255, a = color & 255;
        for (let y = 0; y < bitmap.height; y++)
            for (let x = 0; x < bitmap.width; x++) {
                const coverage = bitmap.data[y * bitmap.width + x];
                if (!coverage) continue;
                const o = ((top - bitmap.top + y) * width + bitmap.left - left + x) * 4;
                // source over, premultiplied
                const sa = coverage * a / 255, keep = 1 - sa / 255;
                data[o] = r * sa / 255 + data[o] * keep;
                data[o + 1] = gr * sa / 255 + data[o + 1] * keep;
                data[o + 2] = b * sa / 255 + data[o + 2] * keep;
                data[o + 3] = sa + data[o + 3] * keep;
            }
    }
    return { data, width, height, left, top };
}

// a COLR version 1 glyph, its outlines rasterized like the others
function paintedGlyph(g: Glyph, offset: number, foreground: number): ColorBitmap | null {
    const { font } = g.font;
    return renderPaintGlyph(font, g.font.paints as PaintGlyphs, g.index, g.scale, offset, foreground, glyph => font.outline(glyph), (path, clip) => rasterizeGlyph(path, 1, 0, clip));
}

function premultiply(rgba: Uint8ClampedArray): void {
    for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3] / 255;
        rgba[i] *= a;
        rgba[i + 1] *= a;
        rgba[i + 2] *= a;
    }
}

// horizontal ink extent of an outline in pixels
function inkExtent(path: PathCommand[], scale: number): Glyph['ink'] {
    let left = Infinity, right = -Infinity;
    for (const command of path)
        for (let i = 1; i < command.length; i += 2) {
            left = Math.min(left, (command[i] as number) * scale);
            right = Math.max(right, (command[i] as number) * scale);
        }
    return right > left ? { left, right } : null;
}

// the part of a bitmap placed at x0, y0 that lies in the target: [x start, x end, y start, y end] in the bitmap
function clipped(width: number, height: number, bitmap: { width: number, height: number }, x0: number, y0: number): [number, number, number, number] {
    return [Math.max(0, -x0), Math.min(bitmap.width, width - x0), Math.max(0, -y0), Math.min(bitmap.height, height - y0)];
}

function blit(target: Uint8Array, width: number, height: number, bitmap: GlyphBitmap, x0: number, y0: number): void {
    const [xs, xe, ys, ye] = clipped(width, height, bitmap, x0, y0);
    for (let y = ys; y < ye; y++)
        for (let x = xs, s = y * bitmap.width + xs, o = (y0 + y) * width + x0 + xs; x < xe; x++, s++, o++) {
            const v = bitmap.data[s];
            if (v) target[o] = Math.min(255, target[o] + v);
        }
}

// draws premultiplied RGBA over the target (premultiplied RGBA as well)
function blitColor(target: Uint8ClampedArray, width: number, height: number, bitmap: ColorBitmap, x0: number, y0: number): void {
    const [xs, xe, ys, ye] = clipped(width, height, bitmap, x0, y0);
    for (let y = ys; y < ye; y++)
        for (let x = xs, s = (y * bitmap.width + xs) * 4, o = ((y0 + y) * width + x0 + xs) * 4; x < xe; x++, s += 4, o += 4) {
            const sa = bitmap.data[s + 3];
            if (!sa) continue;
            const keep = 1 - sa / 255;
            target[o] = bitmap.data[s] + target[o] * keep;
            target[o + 1] = bitmap.data[s + 1] + target[o + 1] * keep;
            target[o + 2] = bitmap.data[s + 2] + target[o + 2] * keep;
            target[o + 3] = sa + target[o + 3] * keep;
        }
}

/**
 * Rasterizes a glyph outline into an 8-bit coverage bitmap
 * @param {Array} path outline in font units (y up)
 * @param {number} scale pixels per font unit
 * @param {number} [offset=0] horizontal subpixel offset
 * @param clip the area (pixels, y up) to rasterize the outline within, if not all of it
 * @return {{data: Uint8Array, width: number, height: number, left: number, top: number}|null}
 *     left/top position the bitmap relative to the pen position on the baseline (top is measured upwards)
 */
export function rasterizeGlyph(path: PathCommand[], scale: number, offset = 0, clip?: { left: number, top: number, right: number, bottom: number }): GlyphBitmap | null {
    if (!path.length) return null;

    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const command of path)
        for (let i = 1; i < command.length; i += 2) {
            const x = (command[i] as number) * scale + offset, y = (command[i + 1] as number) * scale;
            if (x < xmin) xmin = x;
            if (x > xmax) xmax = x;
            if (y < ymin) ymin = y;
            if (y > ymax) ymax = y;
        }

    // only the part within the clip: the rasterizer puts what lies left of the bitmap into its first column, what lies
    // right of it evens out at the row's end, rows above and below are left out
    let left = Math.floor(xmin), right = Math.ceil(xmax), bottom = Math.floor(ymin), top = Math.ceil(ymax);
    if (clip) {
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
        bottom = Math.max(bottom, clip.bottom);
        top = Math.min(top, clip.top);
    }
    const width = right - left, height = top - bottom;
    // (damaged fonts can have coordinates that aren't numbers, or are far out)
    if (!(width > 0 && height > 0) || width * height > MAX_GLYPH_PIXELS) return null;

    const raster = new Rasterizer(width, height);
    // flip y and move the bitmap origin to (left, top)
    const tx = (x: number): number => x * scale + offset - left;
    const ty = (y: number): number => top - y * scale;

    let sx = 0, sy = 0, cx = 0, cy = 0;
    for (const command of path) {
        switch (command[0]) {
            case 'M':
                sx = cx = tx(command[1]);
                sy = cy = ty(command[2]);
                break;
            case 'L': {
                const x = tx(command[1]), y = ty(command[2]);
                raster.line(cx, cy, x, y);
                cx = x;
                cy = y;
                break;
            }
            case 'Q': {
                const x = tx(command[3]), y = ty(command[4]);
                raster.quad(cx, cy, tx(command[1]), ty(command[2]), x, y);
                cx = x;
                cy = y;
                break;
            }
            case 'C': {
                const x = tx(command[5]), y = ty(command[6]);
                raster.cubic(cx, cy, tx(command[1]), ty(command[2]), tx(command[3]), ty(command[4]), x, y);
                cx = x;
                cy = y;
                break;
            }
            case 'Z':
                if (cx !== sx || cy !== sy) raster.line(cx, cy, sx, sy);
                cx = sx;
                cy = sy;
                break;
        }
    }

    return { data: raster.coverage(), width, height, left, top };
}

/**
 * Signed area coverage rasterizer: every line segment adds its area to an accumulation buffer,
 * a prefix sum over each row yields the coverage
 */
export class Rasterizer {
    width: number;
    height: number;
    accumulation: Float32Array;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.accumulation = new Float32Array(width * height + 4);
    }

    line(x0: number, y0: number, x1: number, y1: number): void {
        if (y0 === y1) return;
        // segments crossing the left or right edge are split there, so the parts outside run along the edge: what lies
        // left of the bitmap covers its rows from the first column, what lies right of it evens out at the row's end.
        // (Outlines clipped to a part, and subdivided curves landing a hair outside, e.g. -1e-17 on the left edge)
        for (const edge of [0, this.width])
            if ((x0 - edge) * (x1 - edge) < 0) {
                const y = y0 + (y1 - y0) * (edge - x0) / (x1 - x0);
                this.line(x0, y0, edge, y);
                this.line(edge, y, x1, y1);
                return;
            }
        x0 = x0 < 0 ? 0 : x0 > this.width ? this.width : x0;
        x1 = x1 < 0 ? 0 : x1 > this.width ? this.width : x1;

        let dir = 1;
        if (y0 > y1) {
            dir = -1;
            [x0, y0, x1, y1] = [x1, y1, x0, y0];
        }

        const a = this.accumulation;
        const w = this.width;
        const dxdy = (x1 - x0) / (y1 - y0);
        let x = x0;
        if (y0 < 0) x -= y0 * dxdy;

        const yEnd = Math.min(this.height, Math.ceil(y1));
        for (let y = Math.max(0, y0 | 0); y < yEnd; y++) {
            const lineStart = y * w;
            const dy = Math.min(y + 1, y1) - Math.max(y, y0);
            let xNext = x + dxdy * dy;
            xNext = xNext < 0 ? 0 : xNext > w ? w : xNext;
            const d = dy * dir;
            const xa = x < xNext ? x : xNext, xb = x < xNext ? xNext : x;

            const xaFloor = Math.floor(xa);
            const xai = xaFloor;
            const xbCeil = Math.ceil(xb);
            const xbi = xbCeil;
            const index = lineStart + xai;

            if (index >= 0) {
                if (xbi <= xai + 1) {
                    const xmf = 0.5 * (x + xNext) - xaFloor;
                    a[index] += d - d * xmf;
                    a[index + 1] += d * xmf;
                } else {
                    const s = 1 / (xb - xa);
                    const xaf = xa - xaFloor;
                    const a0 = 0.5 * s * (1 - xaf) * (1 - xaf);
                    const xbf = xb - xbCeil + 1;
                    const am = 0.5 * s * xbf * xbf;

                    a[index] += d * a0;
                    if (xbi === xai + 2) a[index + 1] += d * (1 - a0 - am);
                    else {
                        const a1 = s * (1.5 - xaf);
                        a[index + 1] += d * (a1 - a0);
                        for (let xi = xai + 2; xi < xbi - 1; xi++) a[lineStart + xi] += d * s;
                        const a2 = a1 + (xbi - xai - 3) * s;
                        a[lineStart + xbi - 1] += d * (1 - a2 - am);
                    }
                    a[lineStart + xbi] += d * am;
                }
            }

            x = xNext;
        }
    }

    quad(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void {
        const devx = x0 - 2 * x1 + x2;
        const devy = y0 - 2 * y1 + y2;
        const devsq = devx * devx + devy * devy;

        if (devsq < 0.333) return this.line(x0, y0, x2, y2);

        const n = 1 + Math.floor(Math.sqrt(Math.sqrt(3 * devsq)));
        let px = x0, py = y0;
        for (let i = 1; i <= n; i++) {
            const t = i / n, mt = 1 - t;
            const x = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
            const y = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
            this.line(px, py, x, y);
            px = x;
            py = y;
        }
    }

    cubic(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
        const dx = Math.max(Math.abs(x0 - 2 * x1 + x2), Math.abs(x1 - 2 * x2 + x3));
        const dy = Math.max(Math.abs(y0 - 2 * y1 + y2), Math.abs(y1 - 2 * y2 + y3));
        const devsq = dx * dx + dy * dy;

        if (devsq < 0.333) return this.line(x0, y0, x3, y3);

        const n = 1 + Math.floor(Math.sqrt(Math.sqrt(6 * devsq)));
        let px = x0, py = y0;
        for (let i = 1; i <= n; i++) {
            const t = i / n, mt = 1 - t;
            const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
            const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
            this.line(px, py, x, y);
            px = x;
            py = y;
        }
    }

    coverage(): Uint8Array {
        const length = this.width * this.height;
        const out = new Uint8Array(length);
        let acc = 0;

        for (let i = 0; i < length; i++) {
            acc += this.accumulation[i];
            const v = acc < 0 ? -acc : acc;
            out[i] = v >= 1 ? 255 : v * 255 + 0.5 | 0;
        }

        return out;
    }
}

