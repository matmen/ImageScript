// ICC color profiles: matrix/TRC profiles (RGB and gray, with an XYZ connection space) turned into transforms of 8-bit
// pixels to sRGB, relative colorimetric (out of gamut colors are clipped). Profiles with only lookup tables (A2B0),
// CMYK and other color spaces, and ones close enough to sRGB aren't applied

/** a profile's tone curve: an encoded value (0-1) to linear light */
type Curve = (v: number) => number;

const s15Fixed16 = (view: DataView, o: number): number => view.getInt32(o) / 65536;

// sRGB's primaries in the D50 connection space (Bradford adapted, as ICC sRGB profiles have them), rows X, Y, Z
const SRGB_D50 = [
    0.4360747, 0.3850649, 0.1430804,
    0.2225045, 0.7168786, 0.0606169,
    0.0139322, 0.0971045, 0.7141733,
];

function invert3(m: number[]): number[] | null {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det || !Number.isFinite(det)) return null;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const multiply3 = (m: number[], n: number[]): number[] => Array.from({ length: 9 }, (_, k) => {
    const r = k / 3 | 0, c = k % 3;
    return m[r * 3] * n[c] + m[r * 3 + 1] * n[3 + c] + m[r * 3 + 2] * n[6 + c];
});

const srgbEncode = (v: number): number => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

// a curv or para tag, null if invalid
function curve(view: DataView, o: number, size: number): Curve | null {
    if (size < 12) return null;
    const type = view.getUint32(o);
    if (type === 0x63757276) { // 'curv'
        const n = view.getUint32(o + 8);
        if (12 + n * 2 > size) return null;
        if (n === 0) return v => v;
        if (n === 1) {
            const gamma = view.getUint16(o + 12) / 256;
            return v => v ** gamma;
        }
        const table = new Float64Array(n);
        for (let i = 0; i < n; i++) table[i] = view.getUint16(o + 12 + i * 2) / 65535;
        return v => {
            const x = Math.min(1, Math.max(0, v)) * (n - 1), i = Math.min(n - 2, Math.floor(x));
            return table[i] + (table[i + 1] - table[i]) * (x - i);
        };
    }
    if (type === 0x70617261) { // 'para'
        const kind = view.getUint16(o + 8), counts = [1, 3, 4, 5, 7];
        if (kind > 4 || 12 + counts[kind] * 4 > size) return null;
        const p = Array.from({ length: counts[kind] }, (_, i) => s15Fixed16(view, o + 12 + i * 4));
        const [g, a, b, c, d, e, f] = p;
        switch (kind) {
            case 0: return v => v ** g;
            case 1: return v => v >= -b / a ? (a * v + b) ** g : 0;
            case 2: return v => v >= -b / a ? (a * v + b) ** g + c : c;
            case 3: return v => v >= d ? (a * v + b) ** g : c * v;
            default: return v => v >= d ? (a * v + b) ** g + e : c * v + f;
        }
    }
    return null;
}

interface Profile {
    gray: boolean;
    /** RGB: the primaries in the connection space (columns red, green, blue; rows X, Y, Z) */
    matrix: number[];
    curves: Curve[];
}

/** Parses a matrix/TRC profile, null for other or damaged ones */
export function parseProfile(icc: Uint8Array): Profile | null {
    if (icc.length < 132) return null;
    const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
    const space = view.getUint32(16), pcs = view.getUint32(20);
    if (pcs !== 0x58595a20) return null; // 'XYZ '
    const gray = space === 0x47524159; // 'GRAY'
    if (!gray && space !== 0x52474220) return null; // 'RGB '

    const tags = new Map<string, [number, number]>();
    const count = view.getUint32(128);
    for (let i = 0; i < count && 132 + i * 12 + 12 <= icc.length; i++) {
        const e = 132 + i * 12, offset = view.getUint32(e + 4), size = view.getUint32(e + 8);
        if (offset + size <= icc.length) tags.set(String.fromCharCode(...icc.subarray(e, e + 4)), [offset, size]);
    }
    const curveOf = (tag: string): Curve | null => {
        const t = tags.get(tag);
        return t ? curve(view, t[0], t[1]) : null;
    };
    if (gray) {
        const k = curveOf('kTRC');
        return k ? { gray, matrix: [], curves: [k] } : null;
    }

    const xyz = (tag: string): number[] | null => {
        const t = tags.get(tag);
        if (!t || t[1] < 20 || view.getUint32(t[0]) !== 0x58595a20) return null;
        return [s15Fixed16(view, t[0] + 8), s15Fixed16(view, t[0] + 12), s15Fixed16(view, t[0] + 16)];
    };
    const r = xyz('rXYZ'), g = xyz('gXYZ'), b = xyz('bXYZ');
    const curves = [curveOf('rTRC'), curveOf('gTRC'), curveOf('bTRC')];
    if (!r || !g || !b || curves.some(c => !c)) return null;
    return { gray, matrix: [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]], curves: curves as Curve[] };
}

// whether a profile is sRGB, up to what 8 bits can tell apart
function isSRGB(p: Profile): boolean {
    if (!p.gray && p.matrix.some((v, i) => Math.abs(v - SRGB_D50[i]) > 0.002)) return false;
    for (const c of p.curves)
        for (let i = 0; i <= 255; i += 5) if (Math.abs(srgbEncode(c(i / 255)) * 255 - i) > 0.4) return false;
    return true;
}

/**
 * The transform of a profile's 8-bit RGBA pixels to sRGB (in place, alpha untouched), null if the profile can't be
 * applied or doesn't need to be
 */
export function profileTransform(icc: Uint8Array): ((rgba: Uint8Array | Uint8ClampedArray) => void) | null {
    let p: Profile | null;
    try {
        p = parseProfile(icc);
    } catch {
        return null;
    }
    if (!p || isSRGB(p)) return null;

    // 8-bit values to linear light per channel, linear sRGB to 8 bits through a fine table
    const linear = p.curves.map(c => Float32Array.from({ length: 256 }, (_, i) => c(i / 255)));
    const N = 4096, encode = new Uint8Array(N + 1);
    for (let i = 0; i <= N; i++) encode[i] = Math.round(srgbEncode(i / N) * 255);
    const out = (v: number): number => encode[v <= 0 ? 0 : v >= 1 ? N : Math.round(v * N)];

    if (p.gray) {
        // (the gray's luminance in all three channels: the profile's white is sRGB's)
        // (only for gray images: like libpng, a gray profile of a color image isn't applied)
        const k = linear[0], lut = Uint8Array.from({ length: 256 }, (_, i) => out(k[i]));
        return rgba => {
            for (let i = 0; i < rgba.length; i += 4) if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) return;
            for (let i = 0; i < rgba.length; i += 4) rgba[i] = rgba[i + 1] = rgba[i + 2] = lut[rgba[i]];
        };
    }
    const inverse = invert3(SRGB_D50) as number[];
    const m = multiply3(inverse, p.matrix);
    if (m.some(v => !Number.isFinite(v))) return null;
    // (the table's index scaled into the matrix: linear values from 0 to N, clamped)
    const [r0, r1, r2, g0, g1, g2, b0, b1, b2] = m.map(v => v * N), [lr, lg, lb] = linear;
    return rgba => {
        for (let i = 0; i < rgba.length; i += 4) {
            const r = lr[rgba[i]], g = lg[rgba[i + 1]], b = lb[rgba[i + 2]];
            const x = r0 * r + r1 * g + r2 * b + 0.5, y = g0 * r + g1 * g + g2 * b + 0.5, z = b0 * r + b1 * g + b2 * b + 0.5;
            rgba[i] = encode[x <= 0 ? 0 : x >= N ? N : x | 0];
            rgba[i + 1] = encode[y <= 0 ? 0 : y >= N ? N : y | 0];
            rgba[i + 2] = encode[z <= 0 ? 0 : z >= N ? N : z | 0];
        }
    };
}
