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
const tmp = new Float32Array(256 + 3);

/**
 * Blends n pixels of fg (channels at fi) onto bg (at bi) into out (at oi; may be bg); channels: numColor color ones,
 * then the extra channels
 */
export function performBlending(bg: Float32Array[], bi: number, fg: Float32Array[], fi: number, out: Float32Array[], oi: number, n: number,
    numColor: number, color: Blending, ec: Blending[], extra: ExtraChannel[]): void {
    const hasAlpha = extra.some(e => e.type === EXTRA_ALPHA), numEc = extra.length, nc = numColor + numEc;
    const t = nc <= tmp.length ? tmp : new Float32Array(nc);
    for (let k = 0; k < n; k++) {
        const b = bi + k, f = fi + k;
        // extra channels first, with the alpha before blending
        for (let i = 0; i < numEc; i++) {
            const c = numColor + i, e = ec[i], a = numColor + e.alpha, bgv = bg[c][b], fgv = fg[c][f];
            switch (e.mode) {
                case PB_ADD: t[c] = bgv + fgv; break;
                case PB_BLEND_ABOVE: t[c] = alphaBlend1(bgv, bg[a][b], fgv, fg[a][f], c === a, extra[e.alpha].alphaAssociated, e.clamp); break;
                case PB_BLEND_BELOW: t[c] = alphaBlend1(fgv, fg[a][f], bgv, bg[a][b], c === a, extra[e.alpha].alphaAssociated, e.clamp); break;
                case PB_ADD_ABOVE: t[c] = c === a ? bgv : bgv + fgv * (e.clamp ? clamp01(fg[a][f]) : fg[a][f]); break;
                case PB_ADD_BELOW: t[c] = c === a ? fgv : fgv + bgv * (e.clamp ? clamp01(bg[a][b]) : bg[a][b]); break;
                case PB_MUL: t[c] = bgv * (e.clamp ? clamp01(fgv) : fgv); break;
                case PB_REPLACE: t[c] = fgv; break;
                default: t[c] = bgv;
            }
        }
        const a = numColor + color.alpha;
        switch (color.mode) {
            case PB_ADD:
                for (let c = 0; c < numColor; c++) t[c] = bg[c][b] + fg[c][f];
                break;
            case PB_ADD_ABOVE:
            case PB_ADD_BELOW: {
                const [lo, li, hi, hiIdx] = color.mode === PB_ADD_ABOVE ? [bg, b, fg, f] : [fg, f, bg, b];
                for (let c = 0; c < numColor; c++) {
                    t[c] = hasAlpha ? lo[c][li] + hi[c][hiIdx] * (color.clamp ? clamp01(hi[a][hiIdx]) : hi[a][hiIdx]) : bg[c][b] + fg[c][f];
                }
                break;
            }
            case PB_BLEND_ABOVE:
            case PB_BLEND_BELOW: {
                if (!hasAlpha) {
                    for (let c = 0; c < numColor; c++) t[c] = fg[c][f];
                    break;
                }
                const [lo, li, hi, hiIdx] = color.mode === PB_BLEND_ABOVE ? [bg, b, fg, f] : [fg, f, bg, b];
                const fa = color.clamp ? clamp01(hi[a][hiIdx]) : hi[a][hiIdx], ba = lo[a][li], na = 1 - (1 - fa) * (1 - ba);
                if (extra[color.alpha].alphaAssociated) for (let c = 0; c < numColor; c++) t[c] = hi[c][hiIdx] + lo[c][li] * (1 - fa);
                else {
                    const rna = na > 0 ? 1 / na : 0;
                    for (let c = 0; c < numColor; c++) t[c] = (hi[c][hiIdx] * fa + lo[c][li] * ba * (1 - fa)) * rna;
                }
                t[a] = na;
                break;
            }
            case PB_MUL:
                for (let c = 0; c < numColor; c++) t[c] = bg[c][b] * (color.clamp ? clamp01(fg[c][f]) : fg[c][f]);
                break;
            case PB_REPLACE:
                for (let c = 0; c < numColor; c++) t[c] = fg[c][f];
                break;
            default:
                for (let c = 0; c < numColor; c++) t[c] = bg[c][b];
        }
        for (let c = 0; c < nc; c++) out[c][oi + k] = t[c];
    }
}

// alpha blending of a single channel (libjxl's clamps when not asked to)
function alphaBlend1(bg: number, bga: number, fg: number, fga: number, isAlpha: boolean, premultiplied: boolean, clamp: boolean): number {
    const fa = clamp ? fga : clamp01(fga);
    if (isAlpha) return 1 - (1 - fa) * (1 - bga);
    if (premultiplied) return fg + bg * (1 - fa);
    const na = 1 - (1 - fa) * (1 - bga);
    return (fg * fa + bg * bga * (1 - fa)) * (na > 0 ? 1 / na : 0);
}
