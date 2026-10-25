/*!
 * The adaptive quantization field of the lossy JPEG XL encoder, for its varblock search: libjxl's initial quantization
 * field and masking (lib/jxl/enc_adaptive_quantization.cc: InitialQuantField, AdaptiveQuantizationMap, FuzzyErosion,
 * PerBlockModulations, Blur1x1Masking), on the whole image instead of tiles. Copyright (c) the JPEG XL Project Authors, BSD-3-Clause
 * License (see THIRD_PARTY_NOTICES.md)
 */

const SG_MUL = 226.77216153508914, SG_MUL2 = 1 / 73.377132366608819, LOG2 = 0.693147181;
const SG_RET_MUL = SG_MUL2 * 18.6580932135 * LOG2, SG_V_OFFSET = 7.7825991679894591;
const NUM_MUL = SG_RET_MUL * 3 * SG_MUL, V_OFFSET = SG_V_OFFSET * LOG2 + 1e-2, DEN_MUL = LOG2 * SG_MUL;

// the ratio of the derivatives of XYB's cubic root and butteraugli's gamma (or its inverse)
const gammaRatio = (v: number): number => {
    v = Math.max(v, 0);
    const v2 = v * v;
    return (DEN_MUL * v * v2 + V_OFFSET) / (NUM_MUL * v2 + 1e-2);
};
const gammaRatioInverse = (v: number): number => {
    v = Math.max(v, 0);
    const v2 = v * v;
    return (NUM_MUL * v2 + 1e-2) / (DEN_MUL * v * v2 + V_OFFSET);
};

function computeMask(v: number): number {
    const v1 = Math.max(v * 0.80061762862741759, 1e-3), offset3 = 3.7179635626140772;
    return -0.7647 + 9.4708735624378946 / (v1 * v1 + 0.25 * offset3) + 17.35036561631863 / (v1 + 302.59587815579727) + 6.7943250517376494 / (v1 * v1 + offset3);
}

const maskingSqrt = (v: number): number => 0.25 * Math.sqrt(v * Math.sqrt(211.66567973503678 * 1e8) + 27.505837037000106);

/** The adaptive quantization of an image: per block the quantization field and masking, per pixel the masking */
export interface QuantField {
    quant: Float32Array;
    mask: Float32Array;
    mask1x1: Float32Array;
}

/**
 * libjxl's initial quantization field of XYB planes (w x h, whole blocks) for a Butteraugli distance (scale: the
 * field's scale)
 */
export function initialQuantField(distance: number, planes: Float32Array[], w: number, h: number, scale: number): QuantField {
    const [px, py, pb] = planes, bw = w / 8, bh = h / 8;
    const MATCH_GAMMA_OFFSET = 0.019, LIMIT = 0.2;
    // the masking of each pixel: the inverse of the gamma corrected Laplacian; the pre-erosion: its square (limited),
    // through maskingSqrt, averaged over 4x4 pixels
    const mask1x1 = new Float32Array(w * h), preErosion = new Float32Array((w / 4) * (h / 4)), rowSum = new Float32Array(w);
    for (let y = 0; y < h; y++) {
        const r = y * w, r1 = (y > 0 ? y - 1 : y) * w, r2 = (y + 1 < h ? y + 1 : y) * w;
        for (let x = 0; x < w; x++) {
            const x1 = x > 0 ? x - 1 : x, x2 = x + 1 < w ? x + 1 : x;
            const base = 0.25 * (py[r2 + x] + py[r1 + x] + py[r + x1] + py[r + x2]);
            const gammac = gammaRatio(py[r + x] + MATCH_GAMMA_OFFSET);
            const d = gammac * (py[r + x] - base);
            mask1x1[r + x] = 1 / (Math.log1p(Math.abs(d)) + 0.01);
            const v = maskingSqrt(Math.min(d * d, LIMIT));
            rowSum[x] = y % 4 ? rowSum[x] + v : v;
        }
        if (y % 4 === 3) {
            const out = (y >> 2) * (w / 4);
            for (let x = 0; x < w / 4; x++) preErosion[out + x] = (rowSum[4 * x] + rowSum[4 * x + 1] + rowSum[4 * x + 2] + rowSum[4 * x + 3]) * 0.25;
        }
    }
    const aq = fuzzyErosion(distance, preErosion, w / 4, h / 4);
    const mask = Float32Array.from(aq, v => 1 / (v + 0.001));
    perBlockModulations(distance, px, py, pb, w, bw, bh, scale, aq);
    return { quant: aq, mask, mask1x1: blur1x1(mask1x1, w, h) };
}

// the weighted 4 smallest values of each 3x3 neighbourhood, summed over 2x2 (the output is half the size)
function fuzzyErosion(distance: number, from: Float32Array, w: number, h: number): Float32Array {
    const mul = distance < 2 ? (2 - distance) / 2 : 0;
    let k0 = 0.125, k1 = 0.10 - 0.10 * mul, k2 = 0.09 - 0.09 * mul, k3 = 0.06 - 0.06 * mul;
    const norm = 0.29959705784054957 / (k0 + k1 + k2 + k3);
    k0 *= norm;
    k1 *= norm;
    k2 *= norm;
    k3 *= norm;
    const out = new Float32Array((w / 2) * (h / 2)), ow = w / 2;
    const v = new Float64Array(9);
    for (let y = 0; y < h; y++) {
        const t = (y > 0 ? y - 1 : y) * w, r = y * w, b = (y + 1 < h ? y + 1 : y) * w;
        for (let x = 0; x < w; x++) {
            const xm = x > 0 ? x - 1 : x, xp = x + 1 < w ? x + 1 : x;
            v[0] = from[r + x]; v[1] = from[r + xm]; v[2] = from[r + xp]; v[3] = from[t + xm];
            v[4] = from[t + x]; v[5] = from[t + xp]; v[6] = from[b + xm]; v[7] = from[b + x]; v[8] = from[b + xp];
            // (the 4 smallest)
            let m0 = Infinity, m1 = Infinity, m2 = Infinity, m3 = Infinity;
            for (let i = 0; i < 9; i++) {
                const a = v[i];
                if (a >= m3) continue;
                if (a < m0) { m3 = m2; m2 = m1; m1 = m0; m0 = a; }
                else if (a < m1) { m3 = m2; m2 = m1; m1 = a; }
                else if (a < m2) { m3 = m2; m2 = a; }
                else m3 = a;
            }
            const val = k0 * m0 + k1 * m1 + k2 * m2 + k3 * m3, o = (y >> 1) * ow + (x >> 1);
            out[o] = x % 2 === 0 && y % 2 === 0 ? val : out[o] + val;
        }
    }
    return out;
}

// the field from the erosion (in place): its mask, modulated by high frequencies, gamma and blue, exponentiated
function perBlockModulations(distance: number, px: Float32Array, py: Float32Array, pb: Float32Array, w: number, bw: number, bh: number, scale: number, aq: Float32Array): void {
    const baseLevel = 0.48 * scale;
    let dampen = 1;
    if (distance >= 2) dampen = Math.max(0, 1 - (distance - 2) / (14 - 2));
    const mul = scale * dampen, add = (1 - dampen) * baseLevel;
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const o = by * 8 * w + bx * 8;
            let v = computeMask(aq[by * bw + bx]);
            // high frequencies: the (limited) differences of Y to the right and below
            let hf = 0;
            for (let dy = 0; dy < 8; dy++) {
                const r = o + dy * w, next = dy === 7 ? r : r + w;
                for (let dx = 0; dx < 8; dx++) {
                    const p = py[r + dx];
                    if (dx < 7) hf += Math.min(0.0206, Math.abs(p - py[r + dx + 1]));
                    hf += Math.min(0.0206, Math.abs(p - py[next + dx]));
                }
            }
            v += hf * -0.38 + 0.42;
            // gamma
            let ratio = 0;
            for (let dy = 0; dy < 8; dy++) {
                for (let dx = 0; dx < 8; dx++) {
                    const iny = py[o + dy * w + dx] + 0.16, inx = px[o + dy * w + dx];
                    ratio += gammaRatioInverse(iny - inx) + gammaRatioInverse(iny + inx);
                }
            }
            v += 0.1005613337192697 * Math.log2(ratio * (0.5 / 64));
            // blue (but not all blue)
            const LIMIT = 0.027121074570634722;
            let blue = 0;
            for (let dy = 0; dy < 8; dy++) {
                for (let dx = 0; dx < 8; dx++) {
                    const i = o + dy * w + dx, eff = py[i] + 0.084381641171960495 + Math.abs(px[i]);
                    if (pb[i] > eff) blue += Math.min(pb[i] - eff, LIMIT);
                }
            }
            if (blue >= 32 * LIMIT) blue = 64 * LIMIT - blue;
            if (blue >= 15.398788439047934 * LIMIT) blue = 15.398788439047934 * LIMIT;
            v += blue * 0.14207000358439159;
            aq[by * bw + bx] = Math.exp(v) * mul + add;
        }
    }
}

// a symmetric 5x5 convolution with mirrored borders (libjxl's Symmetric5): the weights of the center, the edges 1 and 2
// away, the diagonals 1 and 2 away and the knight moves
function symmetric5(m: Float32Array, w: number, h: number, [c, r, R, d, D, L]: number[]): Float32Array {
    const weights = [D, L, R, L, D, L, d, r, d, L, R, r, c, r, R, L, d, r, d, L, D, L, R, L, D];
    const mirror = (v: number, n: number): number => {
        while (v < 0 || v >= n) v = v < 0 ? -v - 1 : 2 * n - 1 - v;
        return v;
    };
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const rows = [-2, -1, 0, 1, 2].map(dy => mirror(y + dy, h) * w);
        for (let x = 0; x < w; x++) {
            let sum = 0;
            for (let dx = -2; dx <= 2; dx++) {
                const col = x + dx >= 0 && x + dx < w ? x + dx : mirror(x + dx, w);
                for (let k = 0; k < 5; k++) sum += weights[k * 5 + dx + 2] * m[rows[k] + col];
            }
            out[y * w + x] = sum;
        }
    }
    return out;
}

// the 5x5 blur of the pixels' masking
function blur1x1(m: Float32Array, w: number, h: number): Float32Array {
    const k = [0.25647067633737225, 0.2050056912354399, 0.1540820486684973, 0.08149576591362004, 0.05127501048123085];
    const n = 1 / Math.max(1 + 4 * (k[0] + k[1] + k[2] + k[4] + 2 * k[3]), 1e-5);
    return symmetric5(m, w, h, [n, n * k[0], n * k[2], n * k[1], n * k[4], n * k[3]]);
}
