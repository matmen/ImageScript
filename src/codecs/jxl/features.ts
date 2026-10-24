/*!
 * JPEG XL's image features: patches (rectangles of reference frames blended onto frames), splines (Catmull-Rom curves
 * drawn with Gaussian-like profiles) and noise (from a seeded Xorshift128+, convolved, by intensity); parsing ported
 * from jxl-oxide (crates/jxl-frame/src/data), rendering from libjxl (lib/jxl/dec_patch_dictionary.cc, splines.cc,
 * dec_noise.cc, render_pipeline/stage_noise.cc, xorshift128plus-inl.h). Copyright (c) Wonwoo Choi, MIT License;
 * Copyright (c) the JPEG XL Project Authors, BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */
import { BitReader, unpackSigned } from './bits.ts';
import { EntropyDecoder } from './entropy.ts';
import { ExtraChannel, EXTRA_ALPHA } from './headers.ts';
import { Blending, performBlending } from './blend.ts';
import { mirror } from './upsample.ts';
import type { Planes } from './frame.ts';

// ---- patches

export interface Patch {
    ref: number;
    x0: number;
    y0: number;
    w: number;
    h: number;
    /** where it goes, with the blending of the color and of each extra channel */
    targets: { x: number, y: number, blending: Blending[] }[];
}

export function readPatches(r: BitReader, extra: ExtraChannel[], frameWidth: number, frameHeight: number): Patch[] {
    const alphas = extra.map((e, i) => e.type === EXTRA_ALPHA ? i : -1).filter(i => i >= 0);
    const dec = new EntropyDecoder(r, 10);
    dec.begin(r);
    const maxRefs = Math.min(1 << 24, Math.floor(frameWidth * frameHeight / 16));
    const numRefs = dec.read(r, 0);
    if (numRefs > maxRefs) throw new Error('JPEG XL: too many patches');
    const patches: Patch[] = [];
    let total = 0;
    for (let p = 0; p < numRefs; p++) {
        const ref = dec.read(r, 1);
        if (ref >= 4) throw new Error('JPEG XL: invalid patch reference');
        const x0 = dec.read(r, 3), y0 = dec.read(r, 3), w = dec.read(r, 2) + 1, h = dec.read(r, 2) + 1, count = dec.read(r, 7) + 1;
        total += count;
        if (total > maxRefs * 4) throw new Error('JPEG XL: too many patches');
        const targets: Patch['targets'] = [];
        for (let i = 0; i < count; i++) {
            let x: number, y: number;
            if (i) {
                x = targets[i - 1].x + unpackSigned(dec.read(r, 6));
                y = targets[i - 1].y + unpackSigned(dec.read(r, 6));
            } else {
                x = dec.read(r, 4);
                y = dec.read(r, 4);
            }
            const blending: Blending[] = [];
            for (let c = 0; c <= extra.length; c++) {
                const mode = dec.read(r, 5);
                if (mode > 7) throw new Error('JPEG XL: invalid patch blend mode');
                const alpha = mode >= 4 && alphas.length >= 2 ? dec.read(r, 8) : alphas[0] ?? 0;
                if (mode >= 4 && alpha >= extra.length) throw new Error('JPEG XL: invalid patch alpha channel');
                const clamp = mode >= 3 ? dec.read(r, 9) !== 0 : false;
                blending.push({ mode, alpha, clamp });
            }
            targets.push({ x, y, blending });
        }
        patches.push({ ref, x0, y0, w, h, targets });
    }
    dec.finish();
    return patches;
}

/** Blends the patches onto a frame's planes (in place) */
export function applyPatches(p: Planes, numColor: number, patches: Patch[], references: (Planes | null)[], extra: ExtraChannel[]): void {
    for (const patch of patches) {
        const ref = references[patch.ref];
        if (!ref) throw new Error('JPEG XL: a patch of a missing reference');
        if (patch.x0 + patch.w > ref.width || patch.y0 + patch.h > ref.height) throw new Error('JPEG XL: a patch outside its reference');
        for (const t of patch.targets) {
            const x0 = Math.max(t.x, 0), x1 = Math.min(t.x + patch.w, p.width);
            if (x1 <= x0) continue;
            for (let y = Math.max(t.y, 0); y < Math.min(t.y + patch.h, p.height); y++) {
                const ri = (patch.y0 + y - t.y) * ref.width + patch.x0 + x0 - t.x, i = y * p.width + x0;
                performBlending(p.channels, i, ref.channels, ri, p.channels, i, x1 - x0, numColor, t.blending[0], t.blending.slice(1), extra);
            }
        }
    }
}

// ---- splines

export interface Splines {
    quantAdjust: number;
    splines: { points: number[], color: Int32Array[], sigma: Int32Array }[];
}

export function readSplines(r: BitReader, frameWidth: number, frameHeight: number): Splines {
    const dec = new EntropyDecoder(r, 6);
    dec.begin(r);
    const pixels = frameWidth * frameHeight, maxPoints = Math.min(1 << 20, Math.floor(pixels / 2));
    const n = dec.read(r, 2) + 1;
    if (n > maxPoints) throw new Error('JPEG XL: too many splines');
    const starts: number[] = [];
    for (let i = 0; i < n; i++) {
        let x = dec.read(r, 1), y = dec.read(r, 1);
        if (i) {
            x = unpackSigned(x) + starts[2 * i - 2];
            y = unpackSigned(y) + starts[2 * i - 1];
        }
        starts.push(x, y);
    }
    const quantAdjust = unpackSigned(dec.read(r, 0));
    const splines: Splines['splines'] = [];
    let totalPoints = n;
    for (let s = 0; s < n; s++) {
        const count = dec.read(r, 3);
        totalPoints += count;
        if (totalPoints > maxPoints) throw new Error('JPEG XL: too many spline points');
        const points = [starts[2 * s], starts[2 * s + 1]];
        let dx = 0, dy = 0;
        for (let i = 0; i < count; i++) {
            dx += unpackSigned(dec.read(r, 4));
            dy += unpackSigned(dec.read(r, 4));
            const x = points[points.length - 2] + dx, y = points[points.length - 1] + dy;
            if (x === points[points.length - 2] && y === points[points.length - 1]) throw new Error('JPEG XL: identical successive spline points');
            points.push(x, y);
        }
        const read32 = (): Int32Array => Int32Array.from({ length: 32 }, () => unpackSigned(dec.read(r, 5)));
        const color = [read32(), read32(), read32()];
        splines.push({ points, color, sigma: read32() });
    }
    dec.finish();
    return { quantAdjust, splines };
}

const CHANNEL_WEIGHT = [0.0042, 0.075, 0.07, 0.3333];
// (halves away from zero)
const llround = (x: number): number => x < 0 ? -Math.round(-x) : Math.round(x);

function continuousIDCT(dct: Float64Array, t: number): number {
    let sum = 0;
    for (let i = 0; i < 32; i++) sum += Math.SQRT2 * dct[i] * Math.cos(Math.PI / 32 * i * (t + 0.5));
    return sum;
}

function erf(x: number): number {
    const ax = Math.abs(x);
    const d = (((ax * 7.77394369e-02 + 2.05260015e-04) * ax + 2.32120216e-01) * ax + 2.77820801e-01) * ax + 1;
    const inv = 1 / (d * d), r = 1 - inv * inv;
    return x <= 0 ? -r : r;
}

// the centripetal Catmull-Rom spline through the points (x, y pairs), 16 points per segment
function catmullRom(p: number[]): number[] {
    const n = p.length / 2;
    if (n === 1) return p.slice();
    const pts = [2 * p[0] - p[2], 2 * p[1] - p[3], ...p, 2 * p[2 * n - 2] - p[2 * n - 4], 2 * p[2 * n - 1] - p[2 * n - 3]];
    const out: number[] = [];
    for (let s = 0; s + 3 < pts.length / 2; s++) {
        const P = (k: number): [number, number] => [pts[2 * (s + k)], pts[2 * (s + k) + 1]];
        out.push(...P(1));
        const d: number[] = [], t = [0];
        for (let k = 0; k < 3; k++) {
            const [ax, ay] = P(k), [bx, by] = P(k + 1);
            d.push(Math.sqrt(Math.hypot(bx - ax, by - ay)));
            t.push(t[k] + d[k]);
        }
        for (let i = 1; i < 16; i++) {
            const tt = d[0] + i / 16 * d[1];
            const a: [number, number][] = [];
            for (let k = 0; k < 3; k++) {
                const [ax, ay] = P(k), [bx, by] = P(k + 1), m = (tt - t[k]) / d[k];
                a.push([ax + m * (bx - ax), ay + m * (by - ay)]);
            }
            const b: [number, number][] = [];
            for (let k = 0; k < 2; k++) {
                const m = (tt - t[k]) / (d[k] + d[k + 1]);
                b.push([a[k][0] + m * (a[k + 1][0] - a[k][0]), a[k][1] + m * (a[k + 1][1] - a[k][1])]);
            }
            const m = (tt - t[1]) / d[1];
            out.push(b[0][0] + m * (b[1][0] - b[0][0]), b[0][1] + m * (b[1][1] - b[0][1]));
        }
    }
    out.push(pts[pts.length - 4], pts[pts.length - 3]);
    return out;
}

/** Draws the splines onto a frame's XYB channels (in place); baseX, baseB: the color correlation */
export function renderSplines(p: Planes, s: Splines, baseX: number, baseB: number): void {
    const inv = s.quantAdjust >= 0 ? 1 / (1 + 0.125 * s.quantAdjust) : 1 - 0.125 * s.quantAdjust;
    const [cx, cy, cb] = p.channels, W = p.width, H = p.height;
    for (const spline of s.splines) {
        const color = [0, 1, 2].map(c => Float64Array.from(spline.color[c], (v, i) => v * (i ? 1 : Math.SQRT1_2) * CHANNEL_WEIGHT[c] * inv));
        for (let i = 0; i < 32; i++) {
            color[0][i] += baseX * color[1][i];
            color[2][i] += baseB * color[1][i];
        }
        const sigmaDct = Float64Array.from(spline.sigma, (v, i) => v * (i ? 1 : Math.SQRT1_2) * CHANNEL_WEIGHT[3] * inv);
        // points one apart along the curve, with how much of a unit length each stands for
        const curve = catmullRom(spline.points), points: number[] = [];
        let px = curve[0], py = curve[1];
        points.push(px, py, 1);
        for (let next = 0; next < curve.length / 2;) {
            let prevX = px, prevY = py, along = 0;
            for (; ;) {
                if (next >= curve.length / 2) {
                    points.push(prevX, prevY, along);
                    next = Infinity;
                    break;
                }
                const nx = curve[2 * next], ny = curve[2 * next + 1], toNext = Math.sqrt((nx - prevX) ** 2 + (ny - prevY) ** 2);
                if (along + toNext >= 1) {
                    const m = (1 - along) / toNext;
                    px = prevX + m * (nx - prevX);
                    py = prevY + m * (ny - prevY);
                    points.push(px, py, 1);
                    break;
                }
                along += toNext;
                prevX = nx;
                prevY = ny;
                next++;
            }
        }
        const count = points.length / 3, arcLength = count - 2 + points[points.length - 1];
        if (arcLength <= 0) continue;
        for (let k = 0; k < count; k++) {
            const x = points[3 * k], y = points[3 * k + 1], intensity = points[3 * k + 2];
            const progress = Math.min(1, k / arcLength);
            const c = [0, 1, 2].map(ch => continuousIDCT(color[ch], 31 * progress));
            const sigma = continuousIDCT(sigmaDct, 31 * progress);
            if (!(Number.isFinite(sigma) && sigma !== 0 && Number.isFinite(1 / sigma) && Number.isFinite(intensity))) continue;
            let maxColor = 0.01;
            for (let ch = 0; ch < 3; ch++) maxColor = Math.max(maxColor, Math.abs(c[ch] * intensity));
            const maxDistance = Math.sqrt(-2 * sigma * sigma * (Math.log(0.1) * 3 - Math.log(maxColor)));
            const invSigma = 1 / sigma, k4 = 0.25 * sigma * intensity;
            const y0 = Math.max(llround(y - maxDistance), 0), y1 = Math.min(llround(y + maxDistance) + 1, H);
            const x0 = Math.max(llround(x - maxDistance), 0), x1 = Math.min(llround(x + maxDistance) + 1, W);
            for (let yy = y0; yy < y1; yy++) {
                const dy = yy - y;
                for (let xx = x0; xx < x1; xx++) {
                    const dx = xx - x, distance = Math.sqrt(dx * dx + dy * dy);
                    const f = erf((distance * 0.5 + 0.353553391) * invSigma) - erf((distance * 0.5 - 0.353553391) * invSigma);
                    const local = k4 * f * f, i = yy * W + xx;
                    cx[i] += c[0] * local;
                    cy[i] += c[1] * local;
                    cb[i] += c[2] * local;
                }
            }
        }
    }
}

// ---- noise

export function readNoise(r: BitReader): number[] {
    return Array.from({ length: 8 }, () => r.bits(10) / 1024);
}

const M64 = (1n << 64n) - 1n;

function splitMix64(z: bigint): bigint {
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
    return z ^ (z >> 31n);
}

/** libjxl's Xorshift128+: 8 generators, state as 32-bit halves */
class Xorshift128Plus {
    private s0 = new Uint32Array(16);
    private s1 = new Uint32Array(16);

    constructor(seed1: number, seed2: number, seed3: number, seed4: number) {
        const s0: bigint[] = [splitMix64(((BigInt(seed1) << 32n) + BigInt(seed2) + 0x9E3779B97F4A7C15n) & M64)];
        const s1: bigint[] = [splitMix64(((BigInt(seed3) << 32n) + BigInt(seed4) + 0x9E3779B97F4A7C15n) & M64)];
        for (let i = 1; i < 8; i++) {
            s0.push(splitMix64(s0[i - 1]));
            s1.push(splitMix64(s1[i - 1]));
        }
        for (let i = 0; i < 8; i++) {
            this.s0[2 * i] = Number(s0[i] & 0xffffffffn);
            this.s0[2 * i + 1] = Number(s0[i] >> 32n);
            this.s1[2 * i] = Number(s1[i] & 0xffffffffn);
            this.s1[2 * i + 1] = Number(s1[i] >> 32n);
        }
    }

    /** 8 random 64-bit values as 16 32-bit ones (little endian) */
    fill(out: Uint32Array): void {
        for (let i = 0; i < 8; i++) {
            let aLo = this.s0[2 * i], aHi = this.s0[2 * i + 1];
            const bLo = this.s1[2 * i], bHi = this.s1[2 * i + 1];
            // bits = a + b
            const lo = (aLo + bLo) >>> 0;
            out[2 * i] = lo;
            out[2 * i + 1] = (aHi + bHi + (lo < aLo ? 1 : 0)) >>> 0;
            this.s0[2 * i] = bLo;
            this.s0[2 * i + 1] = bHi;
            // a ^= a << 23
            aHi = (aHi ^ ((aHi << 23) | (aLo >>> 9))) >>> 0;
            aLo = (aLo ^ (aLo << 23)) >>> 0;
            // a ^= b ^ (a >> 18) ^ (b >> 5)
            const a18Lo = ((aLo >>> 18) | (aHi << 14)) >>> 0, a18Hi = aHi >>> 18;
            const b5Lo = ((bLo >>> 5) | (bHi << 27)) >>> 0, b5Hi = bHi >>> 5;
            this.s1[2 * i] = (aLo ^ bLo ^ a18Lo ^ b5Lo) >>> 0;
            this.s1[2 * i + 1] = (aHi ^ bHi ^ a18Hi ^ b5Hi) >>> 0;
        }
    }
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

/**
 * Adds noise to a frame's XYB channels (in place)
 * @param visible, invisible the frame's index among the visible ones (from 1) and the invisible ones since
 */
export function renderNoise(p: Planes, lut: number[], groupDim: number, visible: number, invisible: number, baseX: number, baseB: number): void {
    const W = p.width, H = p.height;
    // random planes in [1, 2), per group sized tile
    const rnd = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)], batch = new Uint32Array(16);
    for (let ty = 0; ty < H; ty += groupDim) {
        for (let tx = 0; tx < W; tx += groupDim) {
            const rng = new Xorshift128Plus(visible, invisible, tx, ty), tw = Math.min(groupDim, W - tx);
            for (const plane of rnd) {
                for (let y = ty; y < Math.min(ty + groupDim, H); y++) {
                    for (let x = 0; x < tw; x += 16) {
                        rng.fill(batch);
                        for (let k = 0; k < 16 && x + k < tw; k++) {
                            u32[0] = (batch[k] >>> 9) | 0x3f800000;
                            plane[y * W + tx + x + k] = f32[0];
                        }
                    }
                }
            }
        }
    }
    // a 5x5 high pass (4 times 1 minus a box filter), mirrored at the edges
    const conv = rnd.map(src => {
        const out = new Float32Array(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let others = 0;
                for (let dy = -2; dy <= 2; dy++) {
                    const row = mirror(y + dy, H) * W;
                    for (let dx = -2; dx <= 2; dx++) if (dx || dy) others += src[row + mirror(x + dx, W)];
                }
                out[y * W + x] = others * 0.16 - src[y * W + x] * 3.84;
            }
        }
        return out;
    });
    const strength = (v: number): number => {
        const scaled = Math.max(0, v * 6);
        let floor = Math.floor(scaled), frac = scaled - floor;
        if (scaled >= 7) {
            floor = 6;
            frac = 1;
        }
        const s = (lut[floor + 1] - lut[floor]) * frac + lut[floor];
        return s < 0 ? 0 : s > 1 ? 1 : s;
    };
    const [X, Y, B] = p.channels;
    for (let i = 0; i < W * H; i++) {
        const sg = strength((Y[i] - X[i]) * 0.5), sr = strength((Y[i] + X[i]) * 0.5);
        const r = conv[0][i] * 0.22, g = conv[1][i] * 0.22, c = conv[2][i] * 0.22;
        const red = sr * (0.0078125 * r + 0.9921875 * c), green = sg * (0.0078125 * g + 0.9921875 * c), rg = red + green;
        X[i] += baseX * rg + red - green;
        Y[i] += rg;
        B[i] += baseB * rg;
    }
}
