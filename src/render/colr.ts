// COLR version 1 color glyphs: a graph of paints (solid colors, linear, radial and sweep gradients, glyph outlines as
// masks, affine transforms and Porter-Duff/blend compositing), rendered into premultiplied RGBA. Variable paints
// render with their default values

import { Font, PathCommand } from './font.ts';
import { parsePalette } from './color.ts';

/** an affine transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f */
type Matrix = [number, number, number, number, number, number];

/** bounds as [xMin, yMin, xMax, yMax] */
type Box = [number, number, number, number];

/** an outline rasterized at pixel coordinates (y up), placed like the glyph bitmaps of the text renderer */
export interface Coverage {
    data: Uint8Array;
    width: number;
    height: number;
    left: number;
    top: number;
}

/** premultiplied RGBA (0-1) of a canvas whose pixel (0, 0) has its top left corner at (left, top), y up */
interface Canvas {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** a font's COLR version 1 glyphs */
export interface PaintGlyphs {
    /** the paint (an offset into the font) of a base glyph, null if it has none */
    paint: (glyph: number) => number | null;
    /** the glyph's clip box in font units, null if it has none */
    clip: (glyph: number) => Box | null;
}

const MAX_DEPTH = 64;
// samples per pixel axis
const SAMPLES = 4;

const multiply = (m: Matrix, n: Matrix): Matrix => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
];

const invert = (m: Matrix): Matrix | null => {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};

const around = (cx: number, cy: number, m: Matrix): Matrix => multiply(multiply([1, 0, 0, 1, cx, cy], m), [1, 0, 0, 1, -cx, -cy]);

/**
 * The font's COLR version 1 base glyphs, null if it has none
 */
export function parsePaintGlyphs(font: Font): PaintGlyphs | null {
    const colr = font.tables.COLR?.offset;
    if (colr === undefined || font.u16(colr) < 1) return null;
    const baseList = font.u32(colr + 14) ? colr + font.u32(colr + 14) : 0;
    if (!baseList) return null;
    const clipList = font.u32(colr + 22) ? colr + font.u32(colr + 22) : 0;
    const count = font.u32(baseList), clips = clipList ? font.u32(clipList + 1) : 0;

    return {
        paint: glyph => {
            // records sorted by glyph
            for (let lo = 0, hi = count - 1; lo <= hi;) {
                const mid = lo + hi >> 1, record = baseList + 4 + mid * 6, id = font.u16(record);
                if (id < glyph) lo = mid + 1;
                else if (id > glyph) hi = mid - 1;
                else return baseList + font.u32(record + 2);
            }
            return null;
        },
        clip: glyph => {
            for (let lo = 0, hi = clips - 1; lo <= hi;) {
                const mid = lo + hi >> 1, record = clipList + 5 + mid * 7;
                if (font.u16(record + 2) < glyph) lo = mid + 1;
                else if (font.u16(record) > glyph) hi = mid - 1;
                else {
                    const box = clipList + (font.u8(record + 4) << 16 | font.u16(record + 5));
                    return [font.i16(box + 1), font.i16(box + 3), font.i16(box + 5), font.i16(box + 7)];
                }
            }
            return null;
        }
    };
}

// reads the paint graph of a font
class Paints {
    font: Font;
    layerList: number;
    palette: (index: number) => number | null;
    glyphs: PaintGlyphs;

    constructor(font: Font, glyphs: PaintGlyphs) {
        this.font = font;
        this.glyphs = glyphs;
        const colr = font.tables.COLR.offset;
        this.layerList = font.u32(colr + 18) ? colr + font.u32(colr + 18) : 0;
        const cpal = font.tables.CPAL?.offset;
        this.palette = cpal === undefined ? () => null : parsePalette(font, cpal);
    }

    offset24(o: number): number {
        return this.font.u8(o) << 16 | this.font.u16(o + 1);
    }

    child(paint: number, at = 1): number {
        return paint + this.offset24(paint + at);
    }

    f2dot14(o: number): number {
        return this.font.i16(o) / 16384;
    }

    layer(index: number): number {
        return this.layerList + this.font.u32(this.layerList + 4 + index * 4);
    }

    /** the transform a transforming paint applies (formats 12-31), with its child */
    transform(paint: number, format: number): Matrix {
        const font = this.font, p = paint;
        const f = (o: number): number => this.f2dot14(p + o);
        const degrees = (o: number): number => f(o) * Math.PI;
        switch (format) {
            case 12: case 13: {
                const t = this.child(p, 4), fixed = (k: number): number => font.i32(t + k * 4) / 65536;
                return [fixed(0), fixed(1), fixed(2), fixed(3), fixed(4), fixed(5)];
            }
            case 14: case 15: return [1, 0, 0, 1, font.i16(p + 4), font.i16(p + 6)];
            case 16: case 17: return [f(4), 0, 0, f(6), 0, 0];
            case 18: case 19: return around(font.i16(p + 8), font.i16(p + 10), [f(4), 0, 0, f(6), 0, 0]);
            case 20: case 21: return [f(4), 0, 0, f(4), 0, 0];
            case 22: case 23: return around(font.i16(p + 6), font.i16(p + 8), [f(4), 0, 0, f(4), 0, 0]);
            case 24: case 25: case 26: case 27: {
                const a = degrees(4), cos = Math.cos(a), sin = Math.sin(a), m: Matrix = [cos, sin, -sin, cos, 0, 0];
                return format >= 26 ? around(font.i16(p + 6), font.i16(p + 8), m) : m;
            }
            default: {
                // skew (28-31)
                const m: Matrix = [1, Math.tan(degrees(6)), Math.tan(-degrees(4)), 1, 0, 0];
                return format >= 30 ? around(font.i16(p + 8), font.i16(p + 10), m) : m;
            }
        }
    }

    /** bounds in pixels of what a paint draws (the outlines it masks with), null if unbounded or empty */
    bounds(paint: number, m: Matrix, outline: (glyph: number) => PathCommand[], depth = 0): Box | null {
        if (depth > MAX_DEPTH) return null;
        const font = this.font, format = font.u8(paint);
        const union = (a: Box | null, b: Box | null): Box | null => !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
        switch (format) {
            case 1: {
                let box: Box | null = null;
                const first = font.u32(paint + 2);
                for (let i = 0, n = font.u8(paint + 1); i < n; i++) box = union(box, this.bounds(this.layer(first + i), m, outline, depth + 1));
                return box;
            }
            case 10: {
                let box: Box | null = null;
                for (const command of outline(font.u16(paint + 4)))
                    for (let i = 1; i < command.length; i += 2) {
                        const x = command[i] as number, y = command[i + 1] as number;
                        const px = m[0] * x + m[2] * y + m[4], py = m[1] * x + m[3] * y + m[5];
                        box = union(box, [px, py, px, py]);
                    }
                return box;
            }
            case 11: {
                const base = this.glyphs.paint(font.u16(paint + 1));
                return base === null ? null : this.bounds(base, m, outline, depth + 1);
            }
            case 32: return union(this.bounds(this.child(paint), m, outline, depth + 1), this.bounds(this.child(paint, 5), m, outline, depth + 1));
            default:
                if (format >= 12 && format <= 31) return this.bounds(this.child(paint), multiply(m, this.transform(paint, format)), outline, depth + 1);
                return null;
        }
    }
}

const paintsOf = new WeakMap<PaintGlyphs, Paints>();
const paintsFor = (font: Font, glyphs: PaintGlyphs): Paints => {
    let paints = paintsOf.get(glyphs);
    if (!paints) paintsOf.set(glyphs, paints = new Paints(font, glyphs));
    return paints;
};

/**
 * The horizontal extent of a COLR version 1 glyph in font units (its clip box, else what its outlines cover), null if
 * it draws nothing
 */
export function paintExtent(font: Font, glyphs: PaintGlyphs, glyph: number, outline: (glyph: number) => PathCommand[]): { left: number, right: number } | null {
    const clip = glyphs.clip(glyph);
    if (clip) return { left: clip[0], right: clip[2] };
    const root = glyphs.paint(glyph);
    const box = root === null ? null : paintsFor(font, glyphs).bounds(root, [1, 0, 0, 1, 0, 0], outline);
    return box && box[2] > box[0] ? { left: box[0], right: box[2] } : null;
}

/**
 * Renders a COLR version 1 glyph into premultiplied RGBA
 * @param scale pixels per font unit
 * @param offset horizontal subpixel offset
 * @param foreground the text color (RGBA, 0xrrggbbaa) for paints in it
 * @param outline the outline of a glyph (font units)
 * @param rasterize coverage of an outline at pixel coordinates (y up)
 * @return the pixels and their placement relative to the pen position on the baseline (top measured upwards)
 */
export function renderPaintGlyph(font: Font, glyphs: PaintGlyphs, glyph: number, scale: number, offset: number, foreground: number,
    outline: (glyph: number) => PathCommand[], rasterize: (path: PathCommand[]) => Coverage | null): { data: Uint8ClampedArray, width: number, height: number, left: number, top: number } | null {
    const root = glyphs.paint(glyph);
    if (root === null) return null;
    const p = paintsFor(font, glyphs);

    // font units to pixels (y up)
    const base: Matrix = [scale, 0, 0, scale, offset, 0];
    const clip = glyphs.clip(glyph);
    const box = clip ? [clip[0] * scale + offset, clip[1] * scale, clip[2] * scale + offset, clip[3] * scale] as Box : p.bounds(root, base, outline);
    if (!box) return null;
    const left = Math.floor(box[0]), top = Math.ceil(box[3]);
    const width = Math.ceil(box[2]) - left, height = top - Math.floor(box[1]);
    if (width <= 0 || height <= 0 || width * height * SAMPLES * SAMPLES > 1 << 24) return null;

    // rendered at SAMPLES times the size and averaged down: layers sharing an edge would otherwise each be antialiased
    // there, and the ones below would show through
    const S = SAMPLES, canvas: Canvas = { left: left * S, top: top * S, width: width * S, height: height * S };
    const layer = render(p, root, [scale * S, 0, 0, scale * S, offset * S, 0], canvas, [0, 0, canvas.width, canvas.height], foreground, outline, rasterize, 0);
    const sum = new Float32Array(width * height * 4);
    if (layer) {
        const [x0, y0, x1, y1] = layer.box, stride = x1 - x0;
        for (let y = y0; y < y1; y++)
            for (let x = x0, i = (y - y0) * stride * 4; x < x1; x++, i += 4) {
                const o = ((y / S | 0) * width + (x / S | 0)) * 4;
                sum[o] += layer.data[i];
                sum[o + 1] += layer.data[i + 1];
                sum[o + 2] += layer.data[i + 2];
                sum[o + 3] += layer.data[i + 3];
            }
    }
    const data = new Uint8ClampedArray(width * height * 4), share = 255 / (S * S);
    for (let i = 0; i < data.length; i++) data[i] = sum[i] * share;
    return { data, width, height, left, top };
}

/** a rendered paint: premultiplied RGBA (0-1) of a box [x0, y0, x1, y1) of the canvas, transparent outside of it */
interface Layer {
    data: Float32Array;
    box: Box;
}

const blank = (box: Box): Layer => ({ data: new Float32Array((box[2] - box[0]) * (box[3] - box[1]) * 4), box });
const unionBox = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const empty = (box: Box): boolean => box[0] >= box[2] || box[1] >= box[3];

// renders a paint into a new layer, only within the region [x0, y0, x1, y1) of the canvas, null if it draws nothing
// there
function render(p: Paints, paint: number, m: Matrix, canvas: Canvas, region: Box, foreground: number,
    outline: (glyph: number) => PathCommand[], rasterize: (path: PathCommand[]) => Coverage | null, depth: number): Layer | null {
    if (depth > MAX_DEPTH || empty(region)) return null;
    const font = p.font, format = font.u8(paint);
    const next = (child: number, matrix: Matrix, r: Box): Layer | null => render(p, child, matrix, canvas, r, foreground, outline, rasterize, depth + 1);

    switch (format) {
        // layers, drawn over each other
        case 1: {
            let out: Layer | null = null;
            const first = font.u32(paint + 2);
            for (let i = 0, n = font.u8(paint + 1); i < n; i++) {
                const layer = next(p.layer(first + i), m, region);
                if (layer) out = out ? composite(3, layer, out) : layer;
            }
            return out;
        }

        case 2: case 3: {
            const color = colorOf(p, font.u16(paint + 1), p.f2dot14(paint + 3), foreground);
            const out = blank(region);
            for (let o = 0; o < out.data.length; o += 4) out.data.set(color, o);
            return out;
        }

        case 4: case 5: case 6: case 7: case 8: case 9:
            return gradient(p, paint, format, m, canvas, region, foreground);

        // the child paint within a glyph's outline
        case 10: {
            const path = outline(font.u16(paint + 4)).map(command => transformCommand(command, m));
            const mask = rasterize(path);
            if (!mask) return null;
            // the mask's pixels on the canvas
            const mx = mask.left - canvas.left, my = canvas.top - mask.top;
            const inner: Box = [Math.max(region[0], mx), Math.max(region[1], my), Math.min(region[2], mx + mask.width), Math.min(region[3], my + mask.height)];
            if (empty(inner)) return null;

            // a solid color (the common case) is the mask in that color, anything else is masked
            const child = p.child(paint), childFormat = font.u8(child);
            const solid = childFormat === 2 || childFormat === 3 ? colorOf(p, font.u16(child + 1), p.f2dot14(child + 3), foreground) : null;
            const layer = solid ? blank(inner) : next(child, m, inner);
            if (!layer) return null;
            const [x0, y0, x1, y1] = layer.box, data = layer.data;
            for (let y = y0, o = 0; y < y1; y++)
                for (let x = x0, k = (y - my) * mask.width + x0 - mx; x < x1; x++, k++, o += 4) {
                    const c = mask.data[k] / 255;
                    if (solid) {
                        data[o] = solid[0] * c;
                        data[o + 1] = solid[1] * c;
                        data[o + 2] = solid[2] * c;
                        data[o + 3] = solid[3] * c;
                    } else {
                        data[o] *= c;
                        data[o + 1] *= c;
                        data[o + 2] *= c;
                        data[o + 3] *= c;
                    }
                }
            return layer;
        }

        // another base glyph's paint
        case 11: {
            const base = p.glyphs.paint(font.u16(paint + 1));
            return base === null ? null : next(base, m, region);
        }

        // the source composited over (or with) the backdrop
        case 32: {
            const backdrop = next(p.child(paint, 5), m, region);
            const source = next(p.child(paint), m, region);
            if (!backdrop && !source) return null;
            const box = (backdrop ?? source as Layer).box;
            return composite(font.u8(paint + 4), source ?? blank(box), backdrop ?? blank(box));
        }

        default:
            if (format >= 12 && format <= 31) return next(p.child(paint), multiply(m, p.transform(paint, format)), region);
            return null;
    }
}

function transformCommand(command: PathCommand, m: Matrix): PathCommand {
    const out: PathCommand = [command[0]];
    for (let i = 1; i < command.length; i += 2) {
        const x = command[i] as number, y = command[i + 1] as number;
        out.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
    }
    return out;
}

// a palette color with an alpha factor, premultiplied (0-1)
function colorOf(p: Paints, index: number, alpha: number, foreground: number): [number, number, number, number] {
    const rgba = p.palette(index) ?? foreground;
    const a = (rgba & 255) / 255 * Math.min(1, Math.max(0, alpha));
    return [(rgba >>> 24) / 255 * a, (rgba >>> 16 & 255) / 255 * a, (rgba >>> 8 & 255) / 255 * a, a];
}

const LUT = 256;

// linear (4, 5), radial (6, 7) and sweep (8, 9) gradients: each pixel center mapped back into the paint's space
function gradient(p: Paints, paint: number, format: number, m: Matrix, canvas: Canvas, region: Box, foreground: number): Layer | null {
    const font = p.font, inverse = invert(m);
    if (!inverse) return null;

    // the color line as a lookup table over its stops' range
    const line = p.child(paint), extend = font.u8(line), count = font.u16(line + 1), stride = format & 1 ? 10 : 6;
    if (!count) return null;
    const stops = Array.from({ length: count }, (_, i) => {
        const o = line + 3 + i * stride;
        return { offset: p.f2dot14(o), color: colorOf(p, font.u16(o + 2), p.f2dot14(o + 4), foreground) };
    }).sort((a, b) => a.offset - b.offset);
    const start = stops[0].offset, end = stops[stops.length - 1].offset, span = end - start;
    const table = new Float32Array(LUT * 4);
    for (let i = 0; i < LUT; i++) {
        const t = start + span * i / (LUT - 1);
        let k = 0;
        while (k < stops.length - 2 && stops[k + 1].offset < t) k++;
        const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
        const f = b.offset > a.offset ? Math.min(1, Math.max(0, (t - a.offset) / (b.offset - a.offset))) : t >= b.offset ? 1 : 0;
        for (let c = 0; c < 4; c++) table[i * 4 + c] = a.color[c] + (b.color[c] - a.color[c]) * f;
    }

    const x0 = font.i16(paint + 4), y0 = font.i16(paint + 6);
    // the position on the color line (NaN where the gradient is undefined)
    let position: (x: number, y: number) => number;
    if (format <= 5) {
        // p1 projected onto the perpendicular of p0-p2 through p0 (p2 rotates the gradient)
        let dx = font.i16(paint + 8) - x0, dy = font.i16(paint + 10) - y0;
        const nx = font.i16(paint + 12) - x0, ny = font.i16(paint + 14) - y0, perp = nx * nx + ny * ny;
        if (perp) {
            const k = (dx * -ny + dy * nx) / perp;
            dx = -ny * k;
            dy = nx * k;
        }
        const length = dx * dx + dy * dy;
        if (!length) return null;
        position = (x, y) => ((x - x0) * dx + (y - y0) * dy) / length;
    } else if (format <= 7) {
        // two point conical: the largest t whose circle (with a radius not below 0) goes through the point
        const r0 = font.u16(paint + 8), cx = font.i16(paint + 10) - x0, cy = font.i16(paint + 12) - y0, dr = font.u16(paint + 14) - r0;
        const a = cx * cx + cy * cy - dr * dr;
        position = (x, y) => {
            const px = x - x0, py = y - y0;
            const b = px * cx + py * cy + r0 * dr, c = px * px + py * py - r0 * r0;
            if (Math.abs(a) < 1e-9) {
                const t = c / (2 * b);
                return b && r0 + t * dr >= 0 ? t : NaN;
            }
            const discriminant = b * b - a * c;
            if (discriminant < 0) return NaN;
            const root = Math.sqrt(discriminant), t1 = (b + root) / a, t2 = (b - root) / a;
            const high = Math.max(t1, t2), low = Math.min(t1, t2);
            return r0 + high * dr >= 0 ? high : r0 + low * dr >= 0 ? low : NaN;
        };
    } else {
        // counterclockwise angles, the stored ones are biased by 180 degrees
        const startAngle = (p.f2dot14(paint + 8) + 1) * 180, endAngle = (p.f2dot14(paint + 10) + 1) * 180;
        position = (x, y) => {
            let angle = Math.atan2(y - y0, x - x0) * 180 / Math.PI;
            if (angle < 0) angle += 360;
            return endAngle === startAngle ? (angle >= startAngle ? 1 : 0) : (angle - startAngle) / (endAngle - startAngle);
        };
    }

    const out = blank(region), data = out.data;
    for (let py = region[1], o = 0; py < region[3]; py++)
        for (let px = region[0]; px < region[2]; px++, o += 4) {
            // the pixel center, back in the paint's space
            const x = canvas.left + px + 0.5, y = canvas.top - py - 0.5;
            const t = position(inverse[0] * x + inverse[2] * y + inverse[4], inverse[1] * x + inverse[3] * y + inverse[5]);
            if (t !== t) continue;
            // the color line extended past its stops
            let u = span > 0 ? (t - start) / span : t >= start ? 1 : 0;
            if (extend === 1) u -= Math.floor(u);
            else if (extend === 2) {
                u = Math.abs(u) % 2;
                if (u > 1) u = 2 - u;
            }
            const i = Math.round(Math.min(1, Math.max(0, u)) * (LUT - 1)) * 4;
            data[o] = table[i];
            data[o + 1] = table[i + 1];
            data[o + 2] = table[i + 2];
            data[o + 3] = table[i + 3];
        }
    return out;
}

// separable blend functions of unpremultiplied backdrop and source channels (W3C Compositing and Blending)
const softLight = (b: number, s: number): number => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
};
const hardLight = (b: number, s: number): number => s <= 0.5 ? b * 2 * s : 1 - (1 - b) * (1 - (2 * s - 1));
const BLEND: Record<number, (b: number, s: number) => number> = {
    13: (b, s) => b + s - b * s,
    14: (b, s) => hardLight(s, b),
    15: Math.min,
    16: Math.max,
    17: (b, s) => b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)),
    18: (b, s) => b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s),
    19: hardLight,
    20: softLight,
    21: (b, s) => Math.abs(b - s),
    22: (b, s) => b + s - 2 * b * s,
    23: (b, s) => b * s
};

// non-separable blend modes (24-27): hue, saturation, color and luminosity, of unpremultiplied RGB
const lum = (c: number[]): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const clipColor = (c: number[]): number[] => {
    const l = lum(c), n = Math.min(...c), x = Math.max(...c);
    return c.map(v => n < 0 ? l + (v - l) * l / (l - n) : x > 1 ? l + (v - l) * (1 - l) / (x - l) : v);
};
const setLum = (c: number[], l: number): number[] => clipColor(c.map(v => v + l - lum(c)));
const sat = (c: number[]): number => Math.max(...c) - Math.min(...c);
const setSat = (c: number[], s: number): number[] => {
    const max = Math.max(...c), min = Math.min(...c);
    return c.map(v => max > min ? (v - min) * s / (max - min) : 0);
};
const NON_SEPARABLE: Record<number, (b: number[], s: number[]) => number[]> = {
    24: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
    25: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
    26: (b, s) => setLum(s, lum(b)),
    27: (b, s) => setLum(b, lum(s))
};

// composites the source onto the backdrop: the result covers both boxes (in the backdrop's layer where it does)
function composite(mode: number, source: Layer, backdrop: Layer): Layer {
    const box = unionBox(source.box, backdrop.box);
    let out = backdrop;
    if (box[0] < backdrop.box[0] || box[1] < backdrop.box[1] || box[2] > backdrop.box[2] || box[3] > backdrop.box[3]) {
        out = blank(box);
        const [x0, y0, x1] = backdrop.box, w = x1 - x0, ow = box[2] - box[0];
        for (let y = y0; y < backdrop.box[3]; y++) out.data.set(backdrop.data.subarray((y - y0) * w * 4, (y - y0 + 1) * w * 4), ((y - box[1]) * ow + x0 - box[0]) * 4);
    }
    const d = out.data, s = source.data, ow = box[2] - box[0];
    const [sx0, sy0, sx1, sy1] = source.box, sw = sx1 - sx0;

    // source over, the common case: only where the source is
    if (mode === 3) {
        for (let y = sy0; y < sy1; y++)
            for (let x = sx0, i = (y - sy0) * sw * 4, o = ((y - box[1]) * ow + sx0 - box[0]) * 4; x < sx1; x++, i += 4, o += 4) {
                const keep = 1 - s[i + 3];
                if (keep === 1) continue;
                d[o] = s[i] + d[o] * keep;
                d[o + 1] = s[i + 1] + d[o + 1] * keep;
                d[o + 2] = s[i + 2] + d[o + 2] * keep;
                d[o + 3] = s[i + 3] + d[o + 3] * keep;
            }
        return out;
    }

    const blend = BLEND[mode], nonSeparable = NON_SEPARABLE[mode];
    const src = new Float32Array(4);
    for (let y = box[1]; y < box[3]; y++)
        for (let x = box[0], o = (y - box[1]) * ow * 4; x < box[2]; x++, o += 4) {
            // the source pixel, transparent outside of its box
            if (x >= sx0 && x < sx1 && y >= sy0 && y < sy1) src.set(s.subarray(((y - sy0) * sw + x - sx0) * 4, ((y - sy0) * sw + x - sx0) * 4 + 4));
            else src.fill(0);
            const as = src[3], ab = d[o + 3];
            // Porter-Duff: result = source * fa + backdrop * fb
            let fa = 0, fb = 0;
            switch (mode) {
                case 0: fa = 0; fb = 0; break;
                case 1: fa = 1; fb = 0; break;
                case 2: fa = 0; fb = 1; break;
                case 4: fa = 1 - ab; fb = 1; break;
                case 5: fa = ab; fb = 0; break;
                case 6: fa = 0; fb = as; break;
                case 7: fa = 1 - ab; fb = 0; break;
                case 8: fa = 0; fb = 1 - as; break;
                case 9: fa = ab; fb = 1 - as; break;
                case 10: fa = 1 - ab; fb = as; break;
                case 11: fa = 1 - ab; fb = 1 - as; break;
                case 12: fa = 1; fb = 1; break;
                default: {
                    // source over, with the blended color where both are
                    if (!blend && !nonSeparable || !as || !ab) { fa = 1; fb = 1 - as; break; }
                    const sc = [src[0] / as, src[1] / as, src[2] / as], b = [d[o] / ab, d[o + 1] / ab, d[o + 2] / ab];
                    const mixed = nonSeparable ? nonSeparable(b, sc) : [blend(b[0], sc[0]), blend(b[1], sc[1]), blend(b[2], sc[2])];
                    for (let c = 0; c < 3; c++) d[o + c] = src[c] * (1 - ab) + d[o + c] * (1 - as) + as * ab * mixed[c];
                    d[o + 3] = as + ab - as * ab;
                    continue;
                }
            }
            for (let c = 0; c < 4; c++) d[o + c] = Math.min(1, src[c] * fa + d[o + c] * fb);
        }
    return out;
}
