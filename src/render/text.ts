/*!
 * The Rasterizer class is translated from font-rs (https://github.com/raphlinus/font-rs)
 * Copyright 2015 Google Inc., Apache License 2.0 (see THIRD_PARTY_NOTICES.md and licenses/Apache-2.0.txt)
 */

import { Font, PathCommand } from './font.ts';
import { Hinter } from './hinting.ts';
import { ColorLayer, BitmapGlyph, parseColorLayers, parseBitmaps } from './color.ts';
import { GlyphBuffer, parseGSUB } from './gsub.ts';
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
    gsub: ((buffer: GlyphBuffer) => void) | null;
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
    /** the layers or the bitmap of color glyphs */
    color: { layers: ColorLayer[] } | { bitmap: BitmapGlyph } | null;
    /** color bitmaps by subpixel offset and text color (bitmap glyphs only have the one for offset 0) */
    colors: Map<string, ColorBitmap | null>;
}

/** a glyph of a shaped paragraph, and whether it is a space (a line can break after it) */
interface ShapedGlyph {
    glyph: Glyph;
    space: boolean;
}

interface Line {
    glyphs: Array<{ x: number, glyph: Glyph }>;
    extent: number;
    soft: boolean;
}

// glyphs are rasterized at quarter pixel offsets
const SUBPIXELS = 4;

// parsed fonts are cached per memory region, so new views of the same font data (e.g. from node Buffers) hit the cache
const fonts = new WeakMap<ArrayBufferLike, Map<string, Font>>();
const hinters = new WeakMap<Font, Hinter>();
const substitutions = new WeakMap<Font, { gsub: ((buffer: GlyphBuffer) => void) | null, layers: ((glyph: number) => ColorLayer[] | null) | null }>();
// sizes (and hinting) per font, a few of them
const sizes = new WeakMap<Font, Map<string, SizedFont>>();
const SIZES = 16;

function loadFont(data: Uint8Array): Font {
    let regions = fonts.get(data.buffer);
    if (!regions) fonts.set(data.buffer, regions = new Map());

    const key = `${data.byteOffset}:${data.byteLength}`;
    let font = regions.get(key);
    if (!font) regions.set(key, font = new Font(data));
    return font;
}

function sizedFont(data: Uint8Array, size: number, hinting: boolean): SizedFont {
    const font = loadFont(data);
    let bySize = sizes.get(font);
    if (!bySize) sizes.set(font, bySize = new Map());
    const key = `${size}:${hinting}`;
    let sized = bySize.get(key);
    if (sized) return sized;

    let hinter: Hinter | null = null;
    if (hinting && font.outlines === 'glyf') {
        hinter = hinters.get(font) ?? null;
        if (!hinter) hinters.set(font, hinter = new Hinter(font));
        if (!hinter.hasInstructions) hinter = null;
    }
    let shared = substitutions.get(font);
    if (!shared) substitutions.set(font, shared = { gsub: parseGSUB(font), layers: parseColorLayers(font) });

    if (bySize.size >= SIZES) bySize.clear();
    bySize.set(key, sized = { font, scale: size / font.unitsPerEm, hinter, layers: shared.layers, bitmaps: parseBitmaps(font, size), gsub: shared.gsub, glyphs: new Map() });
    return sized;
}

// a glyph of a font, with its outline or color glyph data (hinted glyphs advance by whole pixels)
function glyphOf(f: SizedFont, index: number, size: number): Glyph {
    let g = f.glyphs.get(index);
    if (g) return g;

    const { font, scale, hinter } = f;
    const bitmap = f.bitmaps?.(index) ?? null, layers = bitmap ? null : f.layers?.(index) ?? null;
    const advance = font.advance(index) * scale;
    g = { index, font: f, path: [], scale, advance: hinter ? Math.round(advance) : advance, ink: null, bitmaps: [], color: null, colors: new Map() };
    if (bitmap) {
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
 * has all of it; runs of a font are shaped with its substitutions (GSUB). Glyphs are placed with subpixel precision
 * using their advance widths and the font's kerning; the canvas spans from the origin to the furthest glyph edge
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
    const sized: SizedFont[] = [];
    const font = (i: number): SizedFont => sized[i] ??= sizedFont(fonts[i], size, hinting);
    const primary = font(0);
    const ascent = Math.ceil(primary.font.ascender * primary.scale);
    const lineHeight = Math.ceil((primary.font.ascender - primary.font.descender + primary.font.lineGap) * primary.scale);

    const invisible: Glyph = { index: 0, font: primary, path: [], scale: primary.scale, advance: 0, ink: null, bitmaps: [], color: null, colors: new Map() };
    const paragraphs = layout.wrapHardBreaks ? text.split(/\r\n|\r|\n/) : [text.replace(/\r\n|\r|\n/g, '')];
    const shaped = paragraphs.map(paragraph => shape(paragraph, fonts.length, font, size, invisible));

    const kern = (left: Glyph, right: Glyph): number => {
        const kerning = left.font === right.font && left !== invisible && right !== invisible && left.font.font.kerning;
        if (!kerning) return 0;
        const k = kerning(left.index, right.index) * left.font.scale;
        return left.font.hinter ? Math.round(k) : k;
    };
    const lines = wrap(shaped, layout, kern);

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

    const width = Math.ceil(Math.max(0, ...visible.map(line => line.extent)));
    const height = visible.length * lineHeight;
    const coverage = new Uint8Array(width * height);
    let color: Uint8ClampedArray | null = null;

    for (const [n, line] of visible.entries()) {
        let offset = layout.horizontalAlign === 'right' ? width - line.extent
            : layout.horizontalAlign === 'center' ? (width - line.extent) / 2 : 0;
        if (primary.hinter) offset = Math.round(offset);
        const baseline = ascent + n * lineHeight;

        for (const { x, glyph: g } of line.glyphs) {
            if (!g.ink) continue;

            // whole pixels plus the closest subpixel offset (none for hinted glyphs)
            const position = g.font.hinter ? Math.round(offset + x) : Math.round((offset + x) * SUBPIXELS) / SUBPIXELS;
            const pixel = Math.floor(position);
            let subpixel = Math.round((position - pixel) * SUBPIXELS);

            if (g.color) {
                // bitmaps are placed on whole pixels
                if ('bitmap' in g.color) subpixel = 0;
                const key = 'bitmap' in g.color ? '0' : `${subpixel}:${foreground}`;
                let bitmap = g.colors.get(key);
                if (bitmap === undefined) g.colors.set(key, bitmap = 'bitmap' in g.color
                    ? await scaledBitmap(g.color.bitmap, size / g.color.bitmap.ppem)
                    : layeredGlyph(g, g.color.layers, subpixel / SUBPIXELS, foreground));
                if (bitmap) blitColor(color ??= new Uint8ClampedArray(width * height * 4), width, height, bitmap, pixel + bitmap.left, baseline - bitmap.top);
                continue;
            }

            if (g.bitmaps[subpixel] === undefined) g.bitmaps[subpixel] = rasterizeGlyph(g.path, g.scale, subpixel / SUBPIXELS);
            const bitmap = g.bitmaps[subpixel];
            if (bitmap) blit(coverage, width, height, bitmap, pixel + bitmap.left, baseline - bitmap.top);
        }
    }

    return { width, height, coverage, color };
}

/**
 * Turns a paragraph into glyphs: graphemes go to the first font that has all of their (visible) characters,
 * preferring color glyphs before an emoji variation selector and others before a text one; each run of a font is
 * mapped to glyphs and substituted. Invisible characters that weren't substituted show nothing
 */
function shape(paragraph: string, count: number, font: (i: number) => SizedFont, size: number, invisible: Glyph): ShapedGlyph[] {
    const codepoints = Array.from(paragraph, char => char.codePointAt(0) as number);
    const has = (f: SizedFont, codepoint: number): boolean => f.font.glyphIndex(codepoint) !== 0;
    const isColor = (f: SizedFont, codepoint: number): boolean => {
        const index = f.font.glyphIndex(codepoint);
        return !!(f.bitmaps?.(index) || f.layers?.(index));
    };

    // the font of a grapheme (later fonts are only loaded when the earlier ones miss a character)
    const choose = (start: number, end: number): number => {
        const needed = codepoints.slice(start, end).filter(c => !defaultIgnorable(c));
        const variation = codepoints.slice(start, end).find(c => c === 0xfe0f || c === 0xfe0e);
        let first = -1;
        for (let i = 0; i < count; i++) {
            const f = font(i);
            if (!needed.every(c => has(f, c))) continue;
            if (first < 0) first = i;
            if (!variation || !needed.length || (variation === 0xfe0f) === isColor(f, needed[0])) return i;
        }
        return first;
    };

    // fonts per character: whole graphemes where a font has all of them, else character by character
    const fontOf = new Int32Array(codepoints.length);
    for (const [start, end] of graphemes(codepoints)) {
        const chosen = choose(start, end);
        for (let k = start; k < end; k++) fontOf[k] = chosen >= 0 ? chosen : Math.max(0, choose(k, k + 1));
    }

    const shaped: ShapedGlyph[] = [];
    for (let start = 0; start < codepoints.length;) {
        let end = start + 1;
        while (end < codepoints.length && fontOf[end] === fontOf[start]) end++;
        const f = font(fontOf[start]);

        // invisible characters the font has no glyph for are left out of the run
        const buffer: GlyphBuffer = { glyphs: [], clusters: [] };
        for (let k = start; k < end; k++) {
            const index = f.font.glyphIndex(codepoints[k]);
            if (!index && defaultIgnorable(codepoints[k])) continue;
            buffer.glyphs.push(index);
            buffer.clusters.push(k);
        }
        f.gsub?.(buffer);

        for (let j = 0; j < buffer.glyphs.length; j++) {
            const codepoint = codepoints[buffer.clusters[j]], index = buffer.glyphs[j];
            const hidden = defaultIgnorable(codepoint) && index === f.font.glyphIndex(codepoint);
            shaped.push({ glyph: hidden ? invisible : glyphOf(f, index, size), space: codepoint === 0x20 || codepoint === 0x09 });
        }
        start = end;
    }
    return shaped;
}

// characters that extend the grapheme before them: combining marks, variation selectors, emoji modifiers, the keycap,
// tags and joiners (which also join the next character)
const EXTENDING = [0x300, 0x36f, 0x1ab0, 0x1aff, 0x1dc0, 0x1dff, 0x200d, 0x200d, 0x20d0, 0x20ff, 0xfe00, 0xfe0f, 0xfe20, 0xfe2f,
    0x1f3fb, 0x1f3ff, 0xe0020, 0xe007f, 0xe0100, 0xe01ef];
const inRanges = (ranges: number[], codepoint: number): boolean => {
    for (let i = 0; i < ranges.length; i += 2) if (codepoint >= ranges[i] && codepoint <= ranges[i + 1]) return true;
    return false;
};
const regionalIndicator = (codepoint: number): boolean => codepoint >= 0x1f1e6 && codepoint <= 0x1f1ff;

// grapheme ranges (simplified UAX #29 for emoji): extensions, joined sequences and pairs of regional indicators
function graphemes(codepoints: number[]): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (let start = 0; start < codepoints.length;) {
        let end = start + 1;
        if (regionalIndicator(codepoints[start]) && end < codepoints.length && regionalIndicator(codepoints[end])) end++;
        while (end < codepoints.length && (inRanges(EXTENDING, codepoints[end]) || codepoints[end - 1] === 0x200d)) end++;
        ranges.push([start, end]);
        start = end;
    }
    return ranges;
}

// default ignorable code points (Unicode's DerivedCoreProperties), which render as nothing
const IGNORABLE = [0xad, 0xad, 0x34f, 0x34f, 0x61c, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x200b, 0x200f, 0x202a, 0x202e,
    0x2060, 0x206f, 0x3164, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xfeff, 0xffa0, 0xffa0, 0xfff0, 0xfff8, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a,
    0xe0000, 0xe0fff];
const defaultIgnorable = (codepoint: number): boolean => inRanges(IGNORABLE, codepoint);

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

// breaks shaped paragraphs into lines of positioned glyphs
function wrap(paragraphs: ShapedGlyph[][], layout: Layout, kern: (left: Glyph, right: Glyph) => number): Line[] {
    const lines: Line[] = [];

    // right edge of a glyph placed at x (glyphs without ink don't extend the line)
    const edge = (x: number, g: Glyph): number => g.ink ? x + g.ink.right : 0;

    for (const paragraph of paragraphs) {
        let line: Line = { glyphs: [], extent: 0, soft: false };
        let x = 0;
        // index into line.glyphs right after the last space, for word wrapping
        let breakAt = -1;

        // pen position for the next glyph, including the kerning with the previous one
        const next = (g: Glyph): number => line.glyphs.length ? x + kern(line.glyphs[line.glyphs.length - 1].glyph, g) : x;

        const add = (g: Glyph): void => {
            const position = next(g);
            line.glyphs.push({ x: position, glyph: g });
            line.extent = Math.max(line.extent, edge(position, g));
            x = position + g.advance;
        };

        const newLine = (): void => {
            lines.push(line);
            line = { glyphs: [], extent: 0, soft: true };
            x = 0;
            breakAt = -1;
        };

        for (const { glyph: g, space } of paragraph) {
            if (!space && line.glyphs.length && edge(next(g), g) > layout.maxWidth) {
                if (layout.wrapStyle === 'word' && breakAt > 0) {
                    // move the current word to the next line
                    const word = line.glyphs.splice(breakAt);
                    line.extent = measure(line.glyphs, edge);
                    newLine();
                    for (const item of word) add(item.glyph);
                } else newLine();
            }

            // soft wrapped lines don't start with whitespace
            if (space && line.soft && !line.glyphs.length) continue;

            add(g);
            if (space) breakAt = line.glyphs.length;
        }

        lines.push(line);
    }

    return lines;
}

function measure(glyphs: Line['glyphs'], edge: (x: number, g: Glyph) => number): number {
    let extent = 0;
    for (const { x, glyph } of glyphs) extent = Math.max(extent, edge(x, glyph));
    return extent;
}

function blit(target: Uint8Array, width: number, height: number, bitmap: GlyphBitmap, x0: number, y0: number): void {
    for (let y = 0; y < bitmap.height; y++) {
        const ty = y0 + y;
        if (ty < 0 || ty >= height) continue;

        for (let x = 0; x < bitmap.width; x++) {
            const tx = x0 + x;
            if (tx < 0 || tx >= width) continue;

            const v = bitmap.data[y * bitmap.width + x];
            if (v) {
                const o = ty * width + tx;
                target[o] = Math.min(255, target[o] + v);
            }
        }
    }
}

// draws premultiplied RGBA over the target (premultiplied RGBA as well)
function blitColor(target: Uint8ClampedArray, width: number, height: number, bitmap: ColorBitmap, x0: number, y0: number): void {
    for (let y = 0; y < bitmap.height; y++) {
        const ty = y0 + y;
        if (ty < 0 || ty >= height) continue;

        for (let x = 0; x < bitmap.width; x++) {
            const tx = x0 + x;
            if (tx < 0 || tx >= width) continue;

            const s = (y * bitmap.width + x) * 4, sa = bitmap.data[s + 3];
            if (!sa) continue;
            const o = (ty * width + tx) * 4, keep = 1 - sa / 255;
            target[o] = bitmap.data[s] + target[o] * keep;
            target[o + 1] = bitmap.data[s + 1] + target[o + 1] * keep;
            target[o + 2] = bitmap.data[s + 2] + target[o + 2] * keep;
            target[o + 3] = sa + target[o + 3] * keep;
        }
    }
}

/**
 * Rasterizes a glyph outline into an 8-bit coverage bitmap
 * @param {Array} path outline in font units (y up)
 * @param {number} scale pixels per font unit
 * @param {number} [offset=0] horizontal subpixel offset
 * @return {{data: Uint8Array, width: number, height: number, left: number, top: number}|null}
 *     left/top position the bitmap relative to the pen position on the baseline (top is measured upwards)
 */
export function rasterizeGlyph(path: PathCommand[], scale: number, offset = 0): GlyphBitmap | null {
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

    const left = Math.floor(xmin), right = Math.ceil(xmax);
    const bottom = Math.floor(ymin), top = Math.ceil(ymax);
    const width = right - left, height = top - bottom;
    if (width <= 0 || height <= 0) return null;

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
        // outlines lie within the bitmap, but subdividing curves can land a hair outside (e.g. -1e-17 for points on the
        // left edge, common with hinting); such segments would be dropped (their row index is negative)
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

