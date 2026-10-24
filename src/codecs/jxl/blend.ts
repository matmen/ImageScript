/*!
 * Blending (of frames onto their sources, of patches onto frames), ported from libjxl (lib/jxl/blending.cc,
 * alpha.cc: PerformBlending, PerformAlphaBlending, PerformAlphaWeightedAdd, PerformMulBlending). Copyright (c) the
 * JPEG XL Project Authors, BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */
import { ExtraChannel, EXTRA_ALPHA } from './headers.ts';

export const PB_NONE = 0, PB_REPLACE = 1, PB_ADD = 2, PB_MUL = 3, PB_BLEND_ABOVE = 4, PB_BLEND_BELOW = 5, PB_ADD_ABOVE = 6, PB_ADD_BELOW = 7;

/** How a layer is blended: a mode (PB_*), the extra channel of its alpha, whether alpha is clamped */
export interface Blending {
    mode: number;
    alpha: number;
    clamp: boolean;
}

const clamp01 = (x: number): number => x < 0 ? 0 : x > 1 ? 1 : x;
// (a row per channel: the extra channels are blended with the alpha from before blending)
let rows: Float32Array[] = [];

/**
 * Blends n pixels of fg (channels at fi) onto bg (at bi) into out (at oi; may be bg); channels: numColor color ones,
 * then the extra channels
 */
export function performBlending(bg: Float32Array[], bi: number, fg: Float32Array[], fi: number, out: Float32Array[], oi: number, n: number,
    numColor: number, color: Blending, ec: Blending[], extra: ExtraChannel[]): void {
    const hasAlpha = extra.some(e => e.type === EXTRA_ALPHA), numEc = extra.length, nc = numColor + numEc;
    if (rows.length < nc || rows[0].length < n) rows = Array.from({ length: Math.max(nc, rows.length) }, () => new Float32Array(Math.max(n, rows[0]?.length ?? 0)));
    for (let i = 0; i < numEc; i++) {
        const c = numColor + i, e = ec[i], a = numColor + e.alpha, t = rows[c], B = bg[c], F = fg[c], BA = bg[a], FA = fg[a];
        const isAlpha = c === a, premultiplied = extra[e.alpha].alphaAssociated;
        switch (e.mode) {
            case PB_ADD: for (let k = 0; k < n; k++) t[k] = B[bi + k] + F[fi + k]; break;
            case PB_BLEND_ABOVE:
                for (let k = 0; k < n; k++) t[k] = alphaBlend1(B[bi + k], BA[bi + k], F[fi + k], FA[fi + k], isAlpha, premultiplied, e.clamp);
                break;
            case PB_BLEND_BELOW:
                for (let k = 0; k < n; k++) t[k] = alphaBlend1(F[fi + k], FA[fi + k], B[bi + k], BA[bi + k], isAlpha, premultiplied, e.clamp);
                break;
            case PB_ADD_ABOVE:
                for (let k = 0; k < n; k++) t[k] = isAlpha ? B[bi + k] : B[bi + k] + F[fi + k] * (e.clamp ? clamp01(FA[fi + k]) : FA[fi + k]);
                break;
            case PB_ADD_BELOW:
                for (let k = 0; k < n; k++) t[k] = isAlpha ? F[fi + k] : F[fi + k] + B[bi + k] * (e.clamp ? clamp01(BA[bi + k]) : BA[bi + k]);
                break;
            case PB_MUL: for (let k = 0; k < n; k++) t[k] = B[bi + k] * (e.clamp ? clamp01(F[fi + k]) : F[fi + k]); break;
            case PB_REPLACE: t.set(F.subarray(fi, fi + n)); break;
            default: t.set(B.subarray(bi, bi + n));
        }
    }
    const a = numColor + color.alpha;
    switch (color.mode) {
        case PB_ADD:
            for (let c = 0; c < numColor; c++) {
                const t = rows[c], B = bg[c], F = fg[c];
                for (let k = 0; k < n; k++) t[k] = B[bi + k] + F[fi + k];
            }
            break;
        case PB_ADD_ABOVE:
        case PB_ADD_BELOW: {
            const [lo, li, hi, hj] = color.mode === PB_ADD_ABOVE ? [bg, bi, fg, fi] : [fg, fi, bg, bi];
            for (let c = 0; c < numColor; c++) {
                const t = rows[c], L = lo[c], H = hi[c];
                if (!hasAlpha) {
                    for (let k = 0; k < n; k++) t[k] = bg[c][bi + k] + fg[c][fi + k];
                    continue;
                }
                const HA = hi[a];
                for (let k = 0; k < n; k++) t[k] = L[li + k] + H[hj + k] * (color.clamp ? clamp01(HA[hj + k]) : HA[hj + k]);
            }
            break;
        }
        case PB_BLEND_ABOVE:
        case PB_BLEND_BELOW: {
            if (!hasAlpha) {
                for (let c = 0; c < numColor; c++) rows[c].set(fg[c].subarray(fi, fi + n));
                break;
            }
            const [lo, li, hi, hj] = color.mode === PB_BLEND_ABOVE ? [bg, bi, fg, fi] : [fg, fi, bg, bi];
            const premultiplied = extra[color.alpha].alphaAssociated, HA = hi[a], LA = lo[a], ta = rows[a];
            for (let k = 0; k < n; k++) {
                const fa = color.clamp ? clamp01(HA[hj + k]) : HA[hj + k], ba = LA[li + k], na = 1 - (1 - fa) * (1 - ba);
                if (premultiplied) for (let c = 0; c < numColor; c++) rows[c][k] = hi[c][hj + k] + lo[c][li + k] * (1 - fa);
                else {
                    const rna = na > 0 ? 1 / na : 0;
                    for (let c = 0; c < numColor; c++) rows[c][k] = (hi[c][hj + k] * fa + lo[c][li + k] * ba * (1 - fa)) * rna;
                }
                ta[k] = na;
            }
            break;
        }
        case PB_MUL:
            for (let c = 0; c < numColor; c++) {
                const t = rows[c], B = bg[c], F = fg[c];
                for (let k = 0; k < n; k++) t[k] = B[bi + k] * (color.clamp ? clamp01(F[fi + k]) : F[fi + k]);
            }
            break;
        case PB_REPLACE:
            for (let c = 0; c < numColor; c++) rows[c].set(fg[c].subarray(fi, fi + n));
            break;
        default:
            for (let c = 0; c < numColor; c++) rows[c].set(bg[c].subarray(bi, bi + n));
    }
    for (let c = 0; c < nc; c++) out[c].set(rows[c].subarray(0, n), oi);
}

// alpha blending of a single channel (libjxl's clamps when not asked to)
function alphaBlend1(bg: number, bga: number, fg: number, fga: number, isAlpha: boolean, premultiplied: boolean, clamp: boolean): number {
    const fa = clamp ? fga : clamp01(fga);
    if (isAlpha) return 1 - (1 - fa) * (1 - bga);
    if (premultiplied) return fg + bg * (1 - fa);
    const na = 1 - (1 - fa) * (1 - bga);
    return (fg * fa + bg * bga * (1 - fa)) * (na > 0 ? 1 / na : 0);
}
