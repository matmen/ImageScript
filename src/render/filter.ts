/*!
 * SVG filter effects on premultiplied RGBA pixels, ported from resvg (https://github.com/linebender/resvg,
 * crates/resvg/src/filter: mod.rs, box_blur.rs (itself based on https://github.com/fschutt/fastblur), iir_blur.rs,
 * color_matrix.rs, component_transfer.rs, composite.rs, morphology.rs, convolve_matrix.rs, turbulence.rs (itself from
 * the reference implementation in the SVG 1.1 specification), lighting.rs, displacement_map.rs; Copyright 2017 the Resvg
 * Authors, MIT License). The IIR blur
 * follows Pascal Getreuer's gaussianiir (http://www.getreuer.info/home/gaussianiir; Simplified BSD License), an
 * implementation of Alvarez and Mazorra's fast Gaussian convolution. See THIRD_PARTY_NOTICES.md
 */

import { blendPixel } from './blend.ts';

/** premultiplied RGBA pixels */
export interface Pixmap {
    width: number;
    height: number;
    data: Uint8Array;
}

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type Input = 'SourceGraphic' | 'SourceAlpha' | { result: string };

/** a transfer function of feComponentTransfer, null where it's the identity */
export type Transfer = null
    | { type: 'table' | 'discrete', values: number[] }
    | { type: 'linear', slope: number, intercept: number }
    | { type: 'gamma', amplitude: number, exponent: number, offset: number };

export type ColorMatrix = { type: 'matrix', values: number[] } | { type: 'saturate', value: number } | { type: 'hueRotate', angle: number }
    | { type: 'luminanceToAlpha' };

export type Kind =
    | { type: 'blur', input: Input, sx: number, sy: number }
    | { type: 'offset', input: Input, dx: number, dy: number }
    | { type: 'flood', color: number[], opacity: number }
    | { type: 'composite', operator: string, k: number[], input: Input, input2: Input }
    | { type: 'merge', inputs: Input[] }
    | { type: 'dropShadow', input: Input, dx: number, dy: number, sx: number, sy: number, color: number[], opacity: number }
    | { type: 'colorMatrix', input: Input, matrix: ColorMatrix }
    | { type: 'componentTransfer', input: Input, functions: Transfer[] }
    | { type: 'tile', input: Input }
    | { type: 'blend', mode: string, input: Input, input2: Input }
    | { type: 'morphology', dilate: boolean, rx: number, ry: number, input: Input }
    | { type: 'convolve', input: Input, columns: number, rows: number, targetX: number, targetY: number, kernel: number[], divisor: number, bias: number,
        edge: string, preserveAlpha: boolean }
    | { type: 'turbulence', fx: number, fy: number, octaves: number, seed: number, stitch: boolean, fractal: boolean }
    | { type: 'displacement', input: Input, input2: Input, scale: number, xChannel: number, yChannel: number }
    | { type: 'image', draw: (matrix: Matrix, width: number, height: number) => Pixmap | null }
    | { type: 'lighting', specular: boolean, input: Input, surfaceScale: number, constant: number, exponent: number, color: number[], light: Light };

export type Light = { type: 'distant', azimuth: number, elevation: number } | { type: 'point', x: number, y: number, z: number }
    | { type: 'spot', x: number, y: number, z: number, atX: number, atY: number, atZ: number, exponent: number, cone: number | null };

export interface Primitive {
    /** the subregion, in user space */
    rect: Rect;
    /** color-interpolation-filters: linearRGB (else sRGB) */
    linear: boolean;
    result: string;
    kind: Kind;
}

export interface Filter {
    /** the filter region, in user space */
    rect: Rect;
    primitives: Primitive[];
}

/** a primitive's result: its pixels (the size of the filter region), the subregion they're in, their color space */
interface Result {
    pixmap: Pixmap;
    region: Rect;
    linear: boolean;
}

type Matrix = number[];

// sRGB and linear RGB, as 8 bits each (the rounded curves, like resvg's tables)
const TO_LINEAR = new Uint8Array(256), TO_SRGB = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    TO_LINEAR[i] = Math.round((c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * 255);
    TO_SRGB[i] = Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
}

// a float as u8 like Rust's saturating cast (truncating, NaN is 0)
const u8 = (v: number): number => v >= 255 ? 255 : v > 0 ? Math.trunc(v) : 0;
const clamp = (min: number, v: number, max: number): number => v > max ? max : v >= min ? v : min;

const create = (width: number, height: number): Pixmap => ({ width, height, data: new Uint8Array(width * height * 4) });
const clone = (p: Pixmap): Pixmap => ({ width: p.width, height: p.height, data: p.data.slice() });

function demultiply(d: Uint8Array): void {
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        d[i] = u8(d[i] / a + 0.5);
        d[i + 1] = u8(d[i + 1] / a + 0.5);
        d[i + 2] = u8(d[i + 2] / a + 0.5);
    }
}

function multiply(d: Uint8Array): void {
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        d[i] = u8(d[i] * a + 0.5);
        d[i + 1] = u8(d[i + 1] * a + 0.5);
        d[i + 2] = u8(d[i + 2] * a + 0.5);
    }
}

function convert(d: Uint8Array, table: Uint8Array): void {
    demultiply(d);
    for (let i = 0; i < d.length; i += 4) {
        d[i] = table[d[i]];
        d[i + 1] = table[d[i + 1]];
        d[i + 2] = table[d[i + 2]];
    }
    multiply(d);
}

function inColorSpace(result: Result, linear: boolean): Result {
    if (result.linear === linear) return result;
    const pixmap = clone(result.pixmap);
    convert(pixmap.data, linear ? TO_LINEAR : TO_SRGB);
    return { pixmap, region: result.region, linear };
}

// source over at an integer offset (tiny-skia's draw_pixmap), or with another of its blend modes
function draw(dst: Pixmap, src: Pixmap, dx: number, dy: number, mode = 'over'): void {
    const s = src.data, d = dst.data;
    if (mode === 'over') {
        for (let y = Math.max(0, dy); y < Math.min(dst.height, src.height + dy); y++) {
            const x0 = Math.max(0, dx), x1 = Math.min(dst.width, src.width + dx);
            for (let i = (y * dst.width + x0) * 4, j = ((y - dy) * src.width + x0 - dx) * 4, end = (y * dst.width + x1) * 4; i < end; i += 4, j += 4) {
                const sa = s[j + 3];
                if (sa === 0) continue;
                if (sa === 255) {
                    d[i] = s[j];
                    d[i + 1] = s[j + 1];
                    d[i + 2] = s[j + 2];
                    d[i + 3] = 255;
                    continue;
                }
                const fd = 255 - sa;
                d[i] = Math.round((s[j] * 255 + d[i] * fd) / 255);
                d[i + 1] = Math.round((s[j + 1] * 255 + d[i + 1] * fd) / 255);
                d[i + 2] = Math.round((s[j + 2] * 255 + d[i + 2] * fd) / 255);
                d[i + 3] = Math.round((sa * 255 + d[i + 3] * fd) / 255);
            }
        }
        return;
    }
    for (let y = Math.max(0, dy); y < Math.min(dst.height, src.height + dy); y++) {
        for (let x = Math.max(0, dx); x < Math.min(dst.width, src.width + dx); x++) {
            const i = (y * dst.width + x) * 4, j = ((y - dy) * src.width + x - dx) * 4;
            const sa = s[j + 3], da = d[i + 3];
            // the Porter-Duff factors of the source and the destination
            let fs: number, fd: number;
            switch (mode) {
                case 'in': fs = da; fd = 0; break;
                case 'out': fs = 255 - da; fd = 0; break;
                case 'atop': fs = da; fd = 255 - sa; break;
                case 'xor': fs = 255 - da; fd = 255 - sa; break;
                case 'lighter': fs = 255; fd = 255; break;
                default: fs = 255; fd = 255 - sa;
            }
            for (let c = 0; c < 4; c++) d[i + c] = u8(Math.round((s[j + c] * fs + d[i + c] * fd) / 255));
        }
    }
}

// clears everything outside a rectangle
function clearOutside(p: Pixmap, r: Rect): void {
    const x0 = clamp(0, r.x, p.width), x1 = clamp(0, r.x + r.width, p.width), y0 = clamp(0, r.y, p.height), y1 = clamp(0, r.y + r.height, p.height);
    const row = p.width * 4;
    p.data.fill(0, 0, y0 * row);
    p.data.fill(0, y1 * row);
    for (let y = y0; y < y1; y++) {
        p.data.fill(0, y * row, (y * p.width + x0) * 4);
        p.data.fill(0, (y * p.width + x1) * 4, (y + 1) * row);
    }
}

// the bounds of a rectangle transformed, as whole pixels like tiny-skia's to_int_rect (its width and height at least 1)
function intRect(r: Rect, m: Matrix): Rect {
    const xs = [r.x, r.x + r.width], ys = [r.y, r.y + r.height];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of xs)
        for (const y of ys) {
            const tx = m[0] * x + m[2] * y + m[4], ty = m[1] * x + m[3] * y + m[5];
            x0 = Math.min(x0, tx);
            y0 = Math.min(y0, ty);
            x1 = Math.max(x1, tx);
            y1 = Math.max(y1, ty);
        }
    return { x: Math.floor(x0), y: Math.floor(y0), width: Math.max(1, Math.ceil(x1 - x0)), height: Math.max(1, Math.ceil(y1 - y0)) };
}

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const scaleOf = (m: Matrix): [number, number] => [Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])];

/**
 * Applies a filter to pixels rendered with a matrix (user space to the pixels), in place; an invalid region leaves
 * them transparent (like resvg's apply)
 */
export function applyFilter(filter: Filter, ts: Matrix, source: Pixmap): void {
    const result = filterResult(filter, ts, source);
    source.data.fill(0);
    if (!result) return;
    const { image, region } = result;
    draw(source, inColorSpace(image, false).pixmap, region.x, region.y);
}

function filterResult(filter: Filter, ts: Matrix, full: Pixmap): { image: Result, region: Rect } | null {
    // the filter region, within the pixels
    const r = intRect(filter.rect, ts);
    const x0 = Math.max(r.x, 0), y0 = Math.max(r.y, 0), x1 = Math.min(r.x + r.width, full.width), y1 = Math.min(r.y + r.height, full.height);
    if (x1 <= x0 || y1 <= y0) return null;
    const outputRegion = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };

    let source = full;
    if (!sameRect(outputRegion, { x: 0, y: 0, width: full.width, height: full.height })) {
        source = create(outputRegion.width, outputRegion.height);
        for (let y = 0; y < source.height; y++)
            source.data.set(full.data.subarray(((y + y0) * full.width + x0) * 4, ((y + y0) * full.width + x1) * 4), y * source.width * 4);
    }
    const matrix = [ts[0], ts[1], ts[2], ts[3], ts[4] - x0, ts[5] - y0];
    const region = { x: 0, y: 0, width: outputRegion.width, height: outputRegion.height };

    const results: Array<{ name: string, image: Result }> = [];
    const input = (value: Input): Result => {
        if (value === 'SourceGraphic' || value === 'SourceAlpha') {
            const pixmap = clone(source);
            if (value === 'SourceAlpha') for (let i = 0; i < pixmap.data.length; i += 4) pixmap.data[i] = pixmap.data[i + 1] = pixmap.data[i + 2] = 0;
            return { pixmap, region, linear: false };
        }
        for (let i = results.length - 1; i >= 0; i--) if (results[i].name === value.result) return results[i].image;
        return input('SourceGraphic');
    };

    for (const primitive of filter.primitives) {
        const { kind } = primitive;
        let subregion = intRect(primitive.rect, matrix);
        if (kind.type === 'offset' && typeof kind.input === 'object') {
            const name = kind.input.result;
            for (let i = results.length - 1; i >= 0; i--)
                if (results[i].name === name) {
                    subregion = results[i].image.region;
                    break;
                }
        }

        let result = apply(kind, primitive.linear, matrix, region, subregion, input);
        if (!sameRect(region, subregion)) {
            const pixmap = clone(result.pixmap);
            // (offsets aren't clipped: their subregion is the one of their input)
            if (kind.type !== 'offset') clearOutside(pixmap, subregion);
            result = { pixmap, region: subregion, linear: result.linear };
        }
        results.push({ name: primitive.result, image: result });
    }

    const last = results.pop();
    return last ? { image: last.image, region: outputRegion } : null;
}

function apply(kind: Kind, linear: boolean, ts: Matrix, region: Rect, subregion: Rect, input: (value: Input) => Result): Result {
    const [scaleX, scaleY] = scaleOf(ts);
    const own = (pixmap: Pixmap, space = linear): Result => ({ pixmap, region: { x: 0, y: 0, width: pixmap.width, height: pixmap.height }, linear: space });

    switch (kind.type) {
        case 'blur': {
            const source = input(kind.input);
            const sigma = stdDeviation(kind.sx * scaleX, kind.sy * scaleY);
            if (!sigma) return source;
            const pixmap = clone(inColorSpace(source, linear).pixmap);
            blur(pixmap, sigma);
            return own(pixmap);
        }

        case 'offset': {
            const source = input(kind.input);
            const dx = kind.dx * scaleX, dy = kind.dy * scaleY;
            if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return source;
            const pixmap = create(source.pixmap.width, source.pixmap.height);
            draw(pixmap, source.pixmap, Math.trunc(dx), Math.trunc(dy));
            return own(pixmap, source.linear);
        }

        case 'flood': {
            const pixmap = create(region.width, region.height);
            const a = Math.round(kind.opacity * 255) / 255;
            const color = [u8(kind.color[0] * a + 0.5), u8(kind.color[1] * a + 0.5), u8(kind.color[2] * a + 0.5), Math.round(a * 255)];
            for (let i = 0; i < pixmap.data.length; i += 4) pixmap.data.set(color, i);
            return own(pixmap, false);
        }

        case 'composite': {
            const a = inColorSpace(input(kind.input), linear).pixmap, b = inColorSpace(input(kind.input2), linear).pixmap;
            const pixmap = create(region.width, region.height);
            if (kind.operator === 'arithmetic') {
                const [k1, k2, k3, k4] = kind.k, d = pixmap.data;
                const calc = (i1: number, i2: number, max: number): number => {
                    const x = i1 / 255, y = i2 / 255;
                    return clamp(0, k1 * x * y + k2 * x + k3 * y + k4, max);
                };
                for (let i = 0; i < d.length; i += 4) {
                    const alpha = calc(a.data[i + 3], b.data[i + 3], 1);
                    if (Math.abs(alpha) < 1e-6) continue;
                    for (let c = 0; c < 3; c++) d[i + c] = u8(calc(a.data[i + c], b.data[i + c], alpha) * 255);
                    d[i + 3] = u8(alpha * 255);
                }
                return own(pixmap);
            }
            draw(pixmap, b, 0, 0);
            draw(pixmap, a, 0, 0, kind.operator);
            return own(pixmap);
        }

        case 'merge': {
            const pixmap = create(region.width, region.height);
            for (const value of kind.inputs) draw(pixmap, inColorSpace(input(value), linear).pixmap, 0, 0);
            return own(pixmap);
        }

        case 'dropShadow': {
            const source = inColorSpace(input(kind.input), linear).pixmap;
            const dx = kind.dx * scaleX, dy = kind.dy * scaleY;
            const pixmap = create(source.width, source.height);
            const shadow = clone(source);
            const sigma = stdDeviation(kind.sx * scaleX, kind.sy * scaleY);
            if (sigma) blur(shadow, sigma);
            // (the shadow's color with the blurred alpha, premultiplied)
            const opacity = Math.round(kind.opacity * 255) / 255, d = shadow.data;
            for (let i = 0; i < d.length; i += 4) {
                const a = opacity * d[i + 3] / 255;
                d[i] = u8(kind.color[0] * a + 0.5);
                d[i + 1] = u8(kind.color[1] * a + 0.5);
                d[i + 2] = u8(kind.color[2] * a + 0.5);
                d[i + 3] = u8(a * 255 + 0.5);
            }
            // (resvg converts the shadow from linear RGB, or to it)
            convert(d, linear ? TO_LINEAR : TO_SRGB);
            draw(pixmap, shadow, Math.trunc(dx), Math.trunc(dy));
            draw(pixmap, source, 0, 0);
            return own(pixmap);
        }

        case 'colorMatrix': {
            const pixmap = clone(inColorSpace(input(kind.input), linear).pixmap);
            demultiply(pixmap.data);
            colorMatrix(kind.matrix, pixmap.data);
            multiply(pixmap.data);
            return own(pixmap);
        }

        case 'componentTransfer': {
            const pixmap = clone(inColorSpace(input(kind.input), linear).pixmap);
            demultiply(pixmap.data);
            const d = pixmap.data;
            for (let c = 0; c < 4; c++) {
                const f = kind.functions[c];
                if (!f || ((f.type === 'table' || f.type === 'discrete') && !f.values.length)) continue;
                const table = new Uint8Array(256);
                for (let v = 0; v < 256; v++) table[v] = transfer(f, v);
                for (let i = c; i < d.length; i += 4) d[i] = table[d[i]];
            }
            multiply(pixmap.data);
            return own(pixmap);
        }

        case 'blend': {
            const a = inColorSpace(input(kind.input), linear).pixmap, b = inColorSpace(input(kind.input2), linear).pixmap;
            const pixmap = create(region.width, region.height);
            draw(pixmap, b, 0, 0);
            blend(pixmap, a, kind.mode);
            return own(pixmap);
        }

        case 'morphology': {
            const pixmap = clone(inColorSpace(input(kind.input), linear).pixmap);
            const rx = kind.rx * scaleX, ry = kind.ry * scaleY;
            if (!(rx > 0 && ry > 0)) pixmap.data.fill(0);
            else morphology(pixmap, kind.dilate, rx, ry);
            return own(pixmap);
        }

        case 'convolve': {
            const pixmap = clone(inColorSpace(input(kind.input), linear).pixmap);
            if (kind.preserveAlpha) demultiply(pixmap.data);
            convolve(pixmap, kind);
            return own(pixmap);
        }

        case 'turbulence': {
            const pixmap = create(region.width, region.height);
            if (Math.abs(scaleX) < 1e-6 || Math.abs(scaleY) < 1e-6) return own(pixmap);
            turbulence(pixmap, region.x - ts[4], region.y - ts[5], scaleX, scaleY, kind);
            multiply(pixmap.data);
            return own(pixmap);
        }

        case 'displacement': {
            const src = inColorSpace(input(kind.input), linear).pixmap, map = inColorSpace(input(kind.input2), linear).pixmap;
            const pixmap = create(region.width, region.height);
            // (like resvg: the scale counts twice, the map isn't unpremultiplied)
            const sx = kind.scale * scaleX, sy = kind.scale * scaleY, w = src.width, h = src.height;
            const round = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));
            for (let y = 0; y < Math.min(h, map.height); y++)
                for (let x = 0; x < Math.min(w, map.width); x++) {
                    const m = (y * map.width + x) * 4;
                    const ox = round(x + (map.data[m + kind.xChannel] / 255 - 0.5) * sx * kind.scale);
                    const oy = round(y + (map.data[m + kind.yChannel] / 255 - 0.5) * sy * kind.scale);
                    if (ox < 0 || ox >= w || oy < 0 || oy >= h) continue;
                    pixmap.data.set(src.data.subarray((oy * w + ox) * 4, (oy * w + ox) * 4 + 4), (y * pixmap.width + x) * 4);
                }
            return own(pixmap);
        }

        case 'image': {
            // (drawn at the subregion's corner in the filter's scale, like resvg)
            const pixmap = kind.draw([scaleX, 0, 0, scaleY, subregion.x, subregion.y], region.width, region.height) || create(region.width, region.height);
            return own(pixmap, false);
        }

        case 'lighting': {
            const pixmap = create(region.width, region.height);
            lighting(kind, transformLight(kind.light, region, ts), input(kind.input).pixmap, pixmap);
            return own(pixmap);
        }

        case 'tile': {
            const source = input(kind.input);
            const r = source.region, pixmap = create(region.width, region.height);
            if (r.width <= 0 || r.height <= 0) return own(pixmap, false);
            const s = source.pixmap.data, d = pixmap.data;
            for (let y = 0; y < pixmap.height; y++) {
                const sy = r.y + (((y - r.y) % r.height) + r.height) % r.height;
                for (let x = 0; x < pixmap.width; x++) {
                    const sx = r.x + (((x - r.x) % r.width) + r.width) % r.width;
                    if (sx < 0 || sy < 0 || sx >= source.pixmap.width || sy >= source.pixmap.height) continue;
                    const j = (sy * source.pixmap.width + sx) * 4, i = (y * pixmap.width + x) * 4;
                    d[i] = s[j];
                    d[i + 1] = s[j + 1];
                    d[i + 2] = s[j + 2];
                    d[i + 3] = s[j + 3];
                }
            }
            // (resvg marks tiles as sRGB)
            return own(pixmap, false);
        }
    }
}

// the deviations of a blur in pixels, and whether it's a box blur (from 2 pixels on), or null for none
function stdDeviation(sx: number, sy: number): { sx: number, sy: number, box: boolean } | null {
    if (Math.abs(sx) < 1e-6 && Math.abs(sy) < 1e-6) return null;
    // (tiny deviations make the IIR blur transparent)
    if (sx < 0.05) sx = 0;
    if (sy < 0.05) sy = 0;
    return { sx, sy, box: sx >= 2 || sy >= 2 };
}

function blur(p: Pixmap, { sx, sy, box }: { sx: number, sy: number, box: boolean }): void {
    if (box) boxBlur(p, sx, sy);
    else iirBlur(p, sx, sy);
}

// round half to even in single precision, like resvg's (adding and subtracting 1.5 * 2^23)
const roundF32 = (x: number): number => Math.fround(Math.fround(x + 12582912) - 12582912);

// the sizes of 5 box blurs approximating a Gaussian (fastblur's create_box_gauss)
function boxSizes(sigma: number): number[] {
    if (!(sigma > 0)) return [1, 1, 1, 1, 1];
    const n = 5, f = Math.fround;
    const ideal = f(Math.sqrt(f(f(12 * sigma * sigma) / n)) + 1);
    let wl = Math.floor(ideal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const m = Math.round(f(f(12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / f(-4 * wl - 4)));
    return Array.from({ length: n }, (_, i) => i < m ? wl : wu);
}

// a horizontal box blur of radius r (zero outside), from src into dst, all channels at once
function boxRows(src: Uint8Array, dst: Uint8Array, width: number, height: number, r: number): void {
    if (r === 0) {
        dst.set(src);
        return;
    }
    const scale = Math.fround(1 / (2 * r + 1));
    for (let y = 0; y < height; y++) {
        const o = y * width * 4;
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (let k = 0; k < Math.min(r, width); k++) {
            const i = o + k * 4;
            s0 += src[i];
            s1 += src[i + 1];
            s2 += src[i + 2];
            s3 += src[i + 3];
        }
        for (let t = 0; t < width; t++) {
            if (t + r < width) {
                const i = o + (t + r) * 4;
                s0 += src[i];
                s1 += src[i + 1];
                s2 += src[i + 2];
                s3 += src[i + 3];
            }
            if (t > r) {
                const i = o + (t - r - 1) * 4;
                s0 -= src[i];
                s1 -= src[i + 1];
                s2 -= src[i + 2];
                s3 -= src[i + 3];
            }
            const i = o + t * 4;
            dst[i] = roundF32(Math.fround(s0 * scale));
            dst[i + 1] = roundF32(Math.fround(s1 * scale));
            dst[i + 2] = roundF32(Math.fround(s2 * scale));
            dst[i + 3] = roundF32(Math.fround(s3 * scale));
        }
    }
}

// a vertical box blur of radius r (zero outside), from src into dst, a row at a time
function boxColumns(src: Uint8Array, dst: Uint8Array, width: number, height: number, r: number): void {
    if (r === 0) {
        dst.set(src);
        return;
    }
    const scale = Math.fround(1 / (2 * r + 1)), row = width * 4;
    const sums = new Int32Array(row);
    for (let k = 0; k < Math.min(r, height); k++) for (let i = 0; i < row; i++) sums[i] += src[k * row + i];
    for (let t = 0; t < height; t++) {
        if (t + r < height) for (let i = 0, o = (t + r) * row; i < row; i++) sums[i] += src[o + i];
        if (t > r) for (let i = 0, o = (t - r - 1) * row; i < row; i++) sums[i] -= src[o + i];
        for (let i = 0, o = t * row; i < row; i++) dst[o + i] = roundF32(Math.fround(sums[i] * scale));
    }
}

function boxBlur(p: Pixmap, sx: number, sy: number): void {
    const { width, height, data } = p;
    const horizontal = boxSizes(sx), vertical = boxSizes(sy);
    const back = new Uint8Array(data.length);
    for (let i = 0; i < 5; i++) {
        boxColumns(data, back, width, height, (vertical[i] - 1) >> 1);
        boxRows(back, data, width, height, (horizontal[i] - 1) >> 1);
    }
}

// the IIR approximation of a Gaussian (Alvarez and Mazorra, 4 steps), each channel as floats
function iirBlur(p: Pixmap, sx: number, sy: number): void {
    const { width, height, data } = p, steps = 4;
    const buf = new Float64Array(width * height);
    const coefficients = (sigma: number): [number, number] => {
        const lambda = sigma * sigma / (2 * steps);
        return [lambda, (1 + 2 * lambda - Math.sqrt(1 + 4 * lambda)) / (2 * lambda)];
    };
    for (let c = 0; c < 4; c++) {
        for (let i = 0; i < buf.length; i++) buf[i] = data[i * 4 + c] / 255;
        let lambdaX = 1, nuX = 1, lambdaY = 1, nuY = 1;
        if (sx > 0) {
            [lambdaX, nuX] = coefficients(sx);
            for (let y = 0; y < height; y++) {
                const o = y * width;
                for (let s = 0; s < steps; s++) {
                    for (let x = 1; x < width; x++) buf[o + x] += nuX * buf[o + x - 1];
                    for (let x = width - 1; x > 0; x--) buf[o + x - 1] += nuX * buf[o + x];
                }
            }
        }
        if (sy > 0) {
            [lambdaY, nuY] = coefficients(sy);
            for (let x = 0; x < width; x++)
                for (let s = 0; s < steps; s++) {
                    for (let y = width; y < buf.length; y += width) buf[x + y] += nuY * buf[x + y - width];
                    for (let y = buf.length - width; y > 0; y -= width) buf[x + y - width] += nuY * buf[x + y];
                }
        }
        const post = (Math.sqrt(nuX * nuY) / Math.sqrt(lambdaX * lambdaY)) ** (2 * steps);
        for (let i = 0; i < buf.length; i++) data[i * 4 + c] = u8(buf[i] * post * 255);
    }
}

function colorMatrix(matrix: ColorMatrix, d: Uint8Array): void {
    const out = (v: number): number => u8(clamp(0, v, 1) * 255);
    if (matrix.type === 'luminanceToAlpha') {
        for (let i = 0; i < d.length; i += 4) {
            const a = d[i] / 255 * 0.2125 + d[i + 1] / 255 * 0.7154 + d[i + 2] / 255 * 0.0721;
            d[i] = d[i + 1] = d[i + 2] = 0;
            d[i + 3] = out(a);
        }
        return;
    }
    if (matrix.type === 'matrix') {
        const m = matrix.values;
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, a = d[i + 3] / 255;
            d[i] = out(r * m[0] + g * m[1] + b * m[2] + a * m[3] + m[4]);
            d[i + 1] = out(r * m[5] + g * m[6] + b * m[7] + a * m[8] + m[9]);
            d[i + 2] = out(r * m[10] + g * m[11] + b * m[12] + a * m[13] + m[14]);
            d[i + 3] = out(r * m[15] + g * m[16] + b * m[17] + a * m[18] + m[19]);
        }
        return;
    }
    let m: number[];
    if (matrix.type === 'saturate') {
        const v = Math.max(0, matrix.value);
        m = [0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v,
            0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v];
    } else {
        const angle = matrix.angle * Math.PI / 180, a1 = Math.cos(angle), a2 = Math.sin(angle);
        m = [0.213 + 0.787 * a1 - 0.213 * a2, 0.715 - 0.715 * a1 - 0.715 * a2, 0.072 - 0.072 * a1 + 0.928 * a2,
            0.213 - 0.213 * a1 + 0.143 * a2, 0.715 + 0.285 * a1 + 0.140 * a2, 0.072 - 0.072 * a1 - 0.283 * a2,
            0.213 - 0.213 * a1 - 0.787 * a2, 0.715 - 0.715 * a1 + 0.715 * a2, 0.072 + 0.928 * a1 + 0.072 * a2];
    }
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        d[i] = out(r * m[0] + g * m[1] + b * m[2]);
        d[i + 1] = out(r * m[3] + g * m[4] + b * m[5]);
        d[i + 2] = out(r * m[6] + g * m[7] + b * m[8]);
    }
}

function transfer(f: Exclude<Transfer, null>, value: number): number {
    const c = value / 255;
    let v: number;
    if (f.type === 'linear') v = f.slope * c + f.intercept;
    else if (f.type === 'gamma') v = f.amplitude * c ** f.exponent + f.offset;
    else if (f.type === 'table') {
        const n = f.values.length - 1, k = Math.min(Math.floor(c * n), n);
        v = k === n ? f.values[k] : f.values[k] + (c - k / n) * n * (f.values[k + 1] - f.values[k]);
    } else {
        const n = f.values.length;
        v = f.values[Math.min(Math.floor(c * n), n - 1)];
    }
    return u8(clamp(0, v, 1) * 255);
}

// feBlend's modes (the source over the destination)
function blend(dst: Pixmap, src: Pixmap, mode: string): void {
    const s = src.data, d = dst.data;
    const out = [0, 0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
        for (let k = 0; k < 4; k++) out[k] = d[i + k] / 255;
        blendPixel(mode, s[i] / 255, s[i + 1] / 255, s[i + 2] / 255, s[i + 3] / 255, out, 0);
        for (let k = 0; k < 4; k++) d[i + k] = u8(clamp(0, out[k], 1) * 255 + 0.5);
    }
}

// erodes (the minimum) or dilates (the maximum) within the radii, premultiplied: rows, then columns (a rectangle's
// extreme is the extreme of its rows' extremes), each in linear time with a monotonic queue
function morphology(p: Pixmap, dilate: boolean, rx: number, ry: number): void {
    const { width, height, data } = p;
    const xr = Math.min(Math.round(rx), width - 1), yr = Math.min(Math.round(ry), height - 1);
    const tmp = new Uint8Array(data.length);
    const queue = new Int32Array(Math.max(width, height));
    // the extremes of the windows (radius r) along a line of n values (step apart from start), from src into dst
    const pass = (src: Uint8Array, dst: Uint8Array, start: number, step: number, n: number, r: number): void => {
        let head = 0, tail = 0, next = 0;
        for (let i = 0; i < n; i++) {
            for (; next <= Math.min(i + r, n - 1); next++) {
                const v = src[start + next * step];
                while (tail > head && (dilate ? src[start + queue[tail - 1] * step] <= v : src[start + queue[tail - 1] * step] >= v)) tail--;
                queue[tail++] = next;
            }
            while (queue[head] < i - r) head++;
            dst[start + i * step] = src[start + queue[head] * step];
        }
    };
    for (let c = 0; c < 4; c++) {
        for (let y = 0; y < height; y++) pass(data, tmp, y * width * 4 + c, 4, width, xr);
        for (let x = 0; x < width; x++) pass(tmp, data, x * 4 + c, width * 4, height, yr);
    }
}

function convolve(p: Pixmap, m: Extract<Kind, { type: 'convolve' }>): void {
    const { width, height, data } = p, out = new Uint8Array(data.length);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let oy = 0; oy < m.rows; oy++)
                for (let ox = 0; ox < m.columns; ox++) {
                    let tx = x - m.targetX + ox, ty = y - m.targetY + oy;
                    if (m.edge === 'none') {
                        if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
                    } else if (m.edge === 'wrap') {
                        tx = ((tx % width) + width) % width;
                        ty = ((ty % height) + height) % height;
                    } else {
                        tx = clamp(0, tx, width - 1);
                        ty = clamp(0, ty, height - 1);
                    }
                    // (the kernel is rotated by 180 degrees)
                    const k = m.kernel[(m.rows - oy - 1) * m.columns + m.columns - ox - 1], i = (ty * width + tx) * 4;
                    r += data[i] / 255 * k;
                    g += data[i + 1] / 255 * k;
                    b += data[i + 2] / 255 * k;
                    if (!m.preserveAlpha) a += data[i + 3] / 255 * k;
                }
            const o = (y * width + x) * 4;
            a = m.preserveAlpha ? data[o + 3] / 255 : a / m.divisor + m.bias;
            const bounded = clamp(0, a, 1);
            const calc = (v: number): number => {
                v = v / m.divisor + m.bias * a;
                return u8((m.preserveAlpha ? clamp(0, v, 1) * bounded : clamp(0, v, bounded)) * 255 + 0.5);
            };
            out[o] = calc(r);
            out[o + 1] = calc(g);
            out[o + 2] = calc(b);
            out[o + 3] = u8(bounded * 255 + 0.5);
        }
    data.set(out);
}

// Perlin turbulence like the SVG specification's reference code (through resvg's port)
function turbulence(p: Pixmap, offsetX: number, offsetY: number, sx: number, sy: number, t: Extract<Kind, { type: 'turbulence' }>): void {
    const M = 2147483647, A = 16807, Q = 127773, R = 2836, SIZE = 256, N = 4096;
    const random = (seed: number): number => {
        const result = A * (seed % Q) - R * Math.trunc(seed / Q);
        return result <= 0 ? result + M : result;
    };
    // the lattice and the gradients of the 4 channels
    let seed = t.seed;
    if (seed <= 0) seed = -seed % (M - 1) + 1;
    if (seed > M - 1) seed = M - 1;
    const lattice = new Int32Array(SIZE + SIZE + 2), gradient = Array.from({ length: 4 }, () => new Float64Array((SIZE + SIZE + 2) * 2));
    for (let k = 0; k < 4; k++)
        for (let i = 0; i < SIZE; i++) {
            lattice[i] = i;
            for (let j = 0; j < 2; j++) {
                seed = random(seed);
                gradient[k][i * 2 + j] = ((seed % (SIZE + SIZE)) - SIZE) / SIZE;
            }
            const g = gradient[k], len = Math.sqrt(g[i * 2] * g[i * 2] + g[i * 2 + 1] * g[i * 2 + 1]);
            g[i * 2] /= len;
            g[i * 2 + 1] /= len;
        }
    for (let i = SIZE - 1; i > 0; i--) {
        const k = lattice[i];
        seed = random(seed);
        const j = seed % SIZE;
        lattice[i] = lattice[j];
        lattice[j] = k;
    }
    for (let i = 0; i < SIZE + 2; i++) {
        lattice[SIZE + i] = lattice[i];
        for (const g of gradient) {
            g[(SIZE + i) * 2] = g[i * 2];
            g[(SIZE + i) * 2 + 1] = g[i * 2 + 1];
        }
    }

    const curve = (v: number): number => v * v * (3 - 2 * v);
    const lerp = (v: number, a: number, b: number): number => a + v * (b - a);
    const noise = (channel: number, x: number, y: number, stitch: number[] | null): number => {
        let v = x + N;
        let bx0 = Math.trunc(v), bx1 = bx0 + 1;
        const rx0 = v - Math.trunc(v), rx1 = rx0 - 1;
        v = y + N;
        let by0 = Math.trunc(v), by1 = by0 + 1;
        const ry0 = v - Math.trunc(v), ry1 = ry0 - 1;
        if (stitch) {
            if (bx0 >= stitch[2]) bx0 -= stitch[0];
            if (bx1 >= stitch[2]) bx1 -= stitch[0];
            if (by0 >= stitch[3]) by0 -= stitch[1];
            if (by1 >= stitch[3]) by1 -= stitch[1];
        }
        bx0 &= 255;
        bx1 &= 255;
        by0 &= 255;
        by1 &= 255;
        const i = lattice[bx0], j = lattice[bx1];
        const b00 = lattice[i + by0], b10 = lattice[j + by0], b01 = lattice[i + by1], b11 = lattice[j + by1];
        const g = gradient[channel], cx = curve(rx0), cy = curve(ry0);
        const a = lerp(cx, rx0 * g[b00 * 2] + ry0 * g[b00 * 2 + 1], rx1 * g[b10 * 2] + ry0 * g[b10 * 2 + 1]);
        const b = lerp(cx, rx0 * g[b01 * 2] + ry1 * g[b01 * 2 + 1], rx1 * g[b11 * 2] + ry1 * g[b11 * 2 + 1]);
        return lerp(cy, a, b);
    };
    // (resvg passes the pixel's position and the image's size as the tile)
    const sum = (channel: number, x: number, y: number, tileX: number, tileY: number, tileWidth: number, tileHeight: number): number => {
        let fx = t.fx, fy = t.fy, stitch: number[] | null = null;
        if (t.stitch) {
            if (Math.abs(fx) > 1e-6) {
                const lo = Math.floor(tileWidth * fx) / tileWidth, hi = Math.ceil(tileWidth * fx) / tileWidth;
                fx = fx / lo < hi / fx ? lo : hi;
            }
            if (Math.abs(fy) > 1e-6) {
                const lo = Math.floor(tileHeight * fy) / tileHeight, hi = Math.ceil(tileHeight * fy) / tileHeight;
                fy = fy / lo < hi / fy ? lo : hi;
            }
            const w = Math.trunc(tileWidth * fx + 0.5), h = Math.trunc(tileHeight * fy + 0.5);
            stitch = [w, h, Math.trunc(tileX * fx + N + w), Math.trunc(tileY * fy + N + h)];
        }
        let total = 0, ratio = 1;
        x *= fx;
        y *= fy;
        for (let o = 0; o < t.octaves; o++) {
            const n = noise(channel, x, y, stitch);
            total += (t.fractal ? n : Math.abs(n)) / ratio;
            x *= 2;
            y *= 2;
            ratio *= 2;
            if (stitch) {
                stitch[0] *= 2;
                stitch[2] = 2 * stitch[2] - N;
                stitch[1] *= 2;
                stitch[3] = 2 * stitch[3] - N;
            }
        }
        return total;
    };
    const { width, height, data } = p;
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const tx = (x + offsetX) / sx, ty = (y + offsetY) / sy, o = (y * width + x) * 4;
            for (let c = 0; c < 4; c++) {
                let n = sum(c, tx, ty, x, y, width, height);
                n = t.fractal ? (n * 255 + 255) / 2 : n * 255;
                data[o + c] = u8(clamp(0, Math.fround(n), 255) + 0.5);
            }
        }
}

// a light source in the pixels' coordinates (like resvg: z scaled by the diagonal of the scale)
function transformLight(light: Light, region: Rect, ts: Matrix): Light {
    if (light.type === 'distant') return light;
    const map = (x: number, y: number): [number, number] => [ts[0] * x + ts[2] * y + ts[4] - region.x, ts[1] * x + ts[3] * y + ts[5] - region.y];
    const sz = Math.sqrt(ts[0] * ts[0] + ts[3] * ts[3]) / Math.SQRT2;
    const [x, y] = map(light.x, light.y);
    if (light.type === 'point') return { type: 'point', x, y, z: light.z * sz };
    const [atX, atY] = map(light.atX, light.atY);
    return { ...light, x, y, z: light.z * sz, atX, atY, atZ: light.atZ * sz };
}

// feDiffuseLighting and feSpecularLighting: the input's alpha as a surface, lit (like resvg's lighting.rs)
function lighting(fe: Extract<Kind, { type: 'lighting' }>, light: Light, src: Pixmap, dst: Pixmap): void {
    const { width, height } = src;
    if (width < 3 || height < 3) return;
    const alpha = (x: number, y: number): number => src.data[(y * width + x) * 4 + 3];
    const zero = (v: number): boolean => Math.abs(v) < 1e-6;
    let lx = 1, ly = 1, lz = 1;
    if (light.type === 'distant') {
        const azimuth = light.azimuth * Math.PI / 180, elevation = light.elevation * Math.PI / 180;
        lx = Math.cos(azimuth) * Math.cos(elevation);
        ly = Math.sin(azimuth) * Math.cos(elevation);
        lz = Math.sin(elevation);
    }
    let sdx = 0, sdy = 0, sdz = 0;
    if (light.type === 'spot') {
        sdx = light.atX - light.x;
        sdy = light.atY - light.y;
        sdz = light.atZ - light.z;
        const len = Math.hypot(sdx, sdy, sdz);
        if (!zero(len)) {
            sdx /= len;
            sdy /= len;
            sdz /= len;
        }
    }
    const factor = (fx: number, fy: number, nx: number, ny: number): number => {
        // (the normal's x and y, scaled; a flat surface's normal is (0, 0, 1))
        const flat = zero(nx) && zero(ny);
        const x = -nx * fe.surfaceScale / 255 * fx, y = -ny * fe.surfaceScale / 255 * fy;
        const length = Math.hypot(x, y, 1);
        if (!fe.specular) return fe.constant * (flat ? lz : (x * lx + y * ly + lz) / length);
        const hx = lx, hy = ly, hz = lz + 1, h = Math.hypot(hx, hy, hz);
        if (zero(h)) return 0;
        const nh = flat ? hz / h : (x * hx + y * hy + hz) / length / h;
        return fe.constant * (Math.abs(fe.exponent - 1) < 1e-6 ? nh : nh ** fe.exponent);
    };
    const compute = (c: number, f: number): number => u8(clamp(0, c * f, 255) + 0.5);
    const calc = (x: number, y: number, fx: number, fy: number, nx: number, ny: number): void => {
        if (light.type !== 'distant') {
            const nz = alpha(x, y) / 255 * fe.surfaceScale;
            lx = light.x - x;
            ly = light.y - y;
            lz = light.z - nz;
            const len = Math.hypot(lx, ly, lz);
            if (!zero(len)) {
                lx /= len;
                ly /= len;
                lz /= len;
            }
        }
        let color = fe.color;
        if (light.type === 'spot') {
            const minus = -(lx * sdx + ly * sdy + lz * sdz);
            if (minus <= 0 || (light.cone !== null && minus < Math.cos(light.cone * Math.PI / 180))) color = [0, 0, 0];
            else {
                const f = minus ** light.exponent;
                color = color.map(c => compute(c, f));
            }
        }
        const f = factor(fx, fy, nx, ny), o = (y * width + x) * 4;
        const r = compute(color[0], f), g = compute(color[1], f), b = compute(color[2], f);
        dst.data[o] = r;
        dst.data[o + 1] = g;
        dst.data[o + 2] = b;
        dst.data[o + 3] = fe.specular ? Math.max(r, g, b) : 255;
    };
    const a = alpha, w = width - 1, h = height - 1;
    // (the Sobel normals of the corners, edges and interior, as in the specification)
    calc(0, 0, 2 / 3, 2 / 3, -2 * a(0, 0) + 2 * a(1, 0) - a(0, 1) + a(1, 1), -2 * a(0, 0) - a(1, 0) + 2 * a(0, 1) + a(1, 1));
    calc(w, 0, 2 / 3, 2 / 3, -2 * a(w - 1, 0) + 2 * a(w, 0) - a(w - 1, 1) + a(w, 1), -a(w - 1, 0) - 2 * a(w, 0) + a(w - 1, 1) + 2 * a(w, 1));
    calc(0, h, 2 / 3, 2 / 3, -a(0, h - 1) + a(1, h - 1) - 2 * a(0, h) + 2 * a(1, h), -2 * a(0, h - 1) - a(1, h - 1) + 2 * a(0, h) + a(1, h));
    calc(w, h, 2 / 3, 2 / 3, -a(w - 1, h - 1) + a(w, h - 1) - 2 * a(w - 1, h) + 2 * a(w, h), -a(w - 1, h - 1) - 2 * a(w, h - 1) + a(w - 1, h) + 2 * a(w, h));
    for (let x = 1; x < w; x++) {
        calc(x, 0, 1 / 3, 1 / 2, -2 * a(x - 1, 0) + 2 * a(x + 1, 0) - a(x - 1, 1) + a(x + 1, 1),
            -a(x - 1, 0) - 2 * a(x, 0) - a(x + 1, 0) + a(x - 1, 1) + 2 * a(x, 1) + a(x + 1, 1));
        calc(x, h, 1 / 3, 1 / 2, -a(x - 1, h - 1) + a(x + 1, h - 1) - 2 * a(x - 1, h) + 2 * a(x + 1, h),
            -a(x - 1, h - 1) - 2 * a(x, h - 1) - a(x + 1, h - 1) + a(x - 1, h) + 2 * a(x, h) + a(x + 1, h));
    }
    for (let y = 1; y < h; y++) {
        calc(0, y, 1 / 2, 1 / 3, -a(0, y - 1) + a(1, y - 1) - 2 * a(0, y) + 2 * a(1, y) - a(0, y + 1) + a(1, y + 1),
            -2 * a(0, y - 1) - a(1, y - 1) + 2 * a(0, y + 1) + a(1, y + 1));
        calc(w, y, 1 / 2, 1 / 3, -a(w - 1, y - 1) + a(w, y - 1) - 2 * a(w - 1, y) + 2 * a(w, y) - a(w - 1, y + 1) + a(w, y + 1),
            -a(w - 1, y - 1) - 2 * a(w, y - 1) + a(w - 1, y + 1) + 2 * a(w, y + 1));
    }
    for (let y = 1; y < h; y++)
        for (let x = 1; x < w; x++)
            calc(x, y, 1 / 4, 1 / 4, -a(x - 1, y - 1) + a(x + 1, y - 1) - 2 * a(x - 1, y) + 2 * a(x + 1, y) - a(x - 1, y + 1) + a(x + 1, y + 1),
                -a(x - 1, y - 1) - 2 * a(x, y - 1) - a(x + 1, y - 1) + a(x - 1, y + 1) + 2 * a(x, y + 1) + a(x + 1, y + 1));
}
