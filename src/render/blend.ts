/*!
 * Blend modes on premultiplied colors, ported from tiny-skia (https://github.com/linebender/tiny-skia,
 * src/pipeline/highp.rs; Copyright 2011 Google Inc., 2020 Yevhenii Reizner, BSD-3-Clause License, itself from Skia).
 * See THIRD_PARTY_NOTICES.md
 */

/** the modes of feBlend and mix-blend-mode (plus-lighter only exists for mix-blend-mode) */
export const BLEND_MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light',
    'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'plus-lighter']);

const inv = (v: number): number => 1 - v;
const lum = (r: number, g: number, b: number): number => r * 0.3 + g * 0.59 + b * 0.11;
const sat = (r: number, g: number, b: number): number => Math.max(r, g, b) - Math.min(r, g, b);

function setSat(c: number[], value: number): void {
    const mn = Math.min(c[0], c[1], c[2]), mx = Math.max(c[0], c[1], c[2]), range = mx - mn;
    for (let k = 0; k < 3; k++) c[k] = range === 0 ? 0 : (c[k] - mn) * value / range;
}

function setLum(c: number[], l: number): void {
    const diff = l - lum(c[0], c[1], c[2]);
    for (let k = 0; k < 3; k++) c[k] += diff;
}

function clipColor(c: number[], a: number): void {
    const mn = Math.min(c[0], c[1], c[2]), mx = Math.max(c[0], c[1], c[2]), l = lum(c[0], c[1], c[2]);
    for (let k = 0; k < 3; k++) {
        let v = c[k];
        if (!(mx >= 0)) v = l + (v - l) * l / (l - mn);
        if (mx > a) v = l + (v - l) * (a - l) / (mx - l);
        c[k] = Math.max(v, 0);
    }
}

function separable(mode: string, sc: number, dc: number, sa: number, da: number): number {
    switch (mode) {
        case 'multiply': return sc * inv(da) + dc * inv(sa) + sc * dc;
        case 'screen': return sc + dc - sc * dc;
        case 'darken': return sc + dc - Math.max(sc * da, dc * sa);
        case 'lighten': return sc + dc - Math.min(sc * da, dc * sa);
        case 'difference': return sc + dc - 2 * Math.min(sc * da, dc * sa);
        case 'exclusion': return sc + dc - 2 * sc * dc;
        case 'color-burn':
            return dc === da ? dc + sc * inv(da) : sc === 0 ? dc * inv(sa) : sa * (da - Math.min(da, (da - dc) * sa / sc)) + sc * inv(da) + dc * inv(sa);
        case 'color-dodge':
            return dc === 0 ? sc * inv(da) : sc === sa ? sc + dc * inv(sa) : sa * Math.min(da, dc * sa / (sa - sc)) + sc * inv(da) + dc * inv(sa);
        case 'hard-light':
            return sc * inv(da) + dc * inv(sa) + (2 * sc <= sa ? 2 * sc * dc : sa * da - 2 * (da - dc) * (sa - sc));
        case 'overlay':
            return sc * inv(da) + dc * inv(sa) + (2 * dc <= da ? 2 * sc * dc : sa * da - 2 * (da - dc) * (sa - sc));
        case 'soft-light': {
            const m = da > 0 ? dc / da : 0, s2 = 2 * sc, m4 = 4 * m;
            const darkSrc = dc * (sa + (s2 - sa) * (1 - m));
            const darkDst = (m4 * m4 + m4) * (m - 1) + 7 * m;
            const liteDst = Math.sqrt(m) - m;
            const liteSrc = dc * sa + da * (s2 - sa) * (4 * dc <= da ? darkDst : liteDst);
            return sc * inv(da) + dc * inv(sa) + (s2 <= sa ? darkSrc : liteSrc);
        }
        case 'plus-lighter': return Math.min(sc + dc, 1);
        default: return sc + dc * inv(sa);
    }
}

const c = [0, 0, 0];

/** blends the premultiplied source (r, g, b, a) over the destination d[i..i + 3] in place (values 0-1, unclamped) */
export function blendPixel(mode: string, r: number, g: number, b: number, a: number, d: ArrayLike<number> & { [i: number]: number }, i: number): void {
    const dr = d[i], dg = d[i + 1], db = d[i + 2], da = d[i + 3];
    if (mode === 'hue' || mode === 'saturation' || mode === 'color' || mode === 'luminosity') {
        if (mode === 'hue') {
            c[0] = r * a; c[1] = g * a; c[2] = b * a;
            setSat(c, sat(dr, dg, db) * a);
            setLum(c, lum(dr, dg, db) * a);
        } else if (mode === 'saturation') {
            c[0] = dr * a; c[1] = dg * a; c[2] = db * a;
            setSat(c, sat(r, g, b) * da);
            setLum(c, lum(dr, dg, db) * a);
        } else if (mode === 'color') {
            c[0] = r * da; c[1] = g * da; c[2] = b * da;
            setLum(c, lum(dr, dg, db) * a);
        } else {
            c[0] = dr * a; c[1] = dg * a; c[2] = db * a;
            setLum(c, lum(r, g, b) * da);
        }
        clipColor(c, a * da);
        d[i] = r * inv(da) + dr * inv(a) + c[0];
        d[i + 1] = g * inv(da) + dg * inv(a) + c[1];
        d[i + 2] = b * inv(da) + db * inv(a) + c[2];
        d[i + 3] = a + da - a * da;
    } else {
        d[i] = separable(mode, r, dr, a, da);
        d[i + 1] = separable(mode, g, dg, a, da);
        d[i + 2] = separable(mode, b, db, a, da);
        d[i + 3] = mode === 'plus-lighter' ? Math.min(a + da, 1) : da * inv(a) + a;
    }
}
