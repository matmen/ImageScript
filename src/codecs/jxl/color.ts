/*!
 * The color transform of JPEG XL frames: XYB to linear RGB (libjxl's lib/jxl/dec_xyb-inl.h: XybToRgb), YCbCr to RGB
 * (jxl-oxide's crates/jxl-color/src/ycbcr.rs); and the decoded image as 8-bit RGBA. Copyright (c) the JPEG XL Project
 * Authors, BSD-3-Clause License; Copyright (c) Wonwoo Choi, MIT License (see THIRD_PARTY_NOTICES.md)
 */
import { ImageHeader, TF_PQ, TF_HLG, PRI_BT2100, PRI_P3, EXTRA_ALPHA, EXTRA_SPOT, EXTRA_BLACK } from './headers.ts';
import { toSRGB, hdrToLinear, ToneMapping, REFERENCE_WHITE } from '../hdr.ts';
import type { Planes } from './frame.ts';

// a sample (0-1) as a byte
const byte = (v: number): number => v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);

// linear light to sRGB like libjxl (TF_SRGB::EncodedFromDisplay, lib/jxl/cms/transfer_functions-inl.h): a rational
// polynomial of the square root instead of the power, within 5e-7
const [P0, P1, P2, P3, P4] = [-5.135152395e-04, 5.287254571e-03, 3.903842876e-01, 1.474205315e+00, 7.352629620e-01].map(Math.fround);
const [Q0, Q1, Q2, Q3, Q4] = [1.004519624e-02, 3.036675394e-01, 1.340816930e+00, 9.258482155e-01, 2.424867759e-02].map(Math.fround);
const srgbEncode = (v: number): number => {
    if (v <= 0.0031308) return 12.92 * v;
    const x = Math.sqrt(v);
    return ((((P4 * x + P3) * x + P2) * x + P1) * x + P0) / ((((Q4 * x + Q3) * x + Q2) * x + Q1) * x + Q0);
};

// the sRGB bytes of linear light (what byte(fround(srgbEncode(v))) gives, which only grows with v): the smallest value
// of each byte (by bisection), and per 1/4096 the byte there
const THRESHOLDS = new Float64Array(257), LINEAR_BYTE = new Uint8Array(4097);
{
    const f = (v: number): number => byte(Math.fround(srgbEncode(v)));
    THRESHOLDS[0] = -Infinity;
    THRESHOLDS[256] = Infinity;
    for (let k = 1; k < 256; k++) {
        let lo = 0, hi = 1;
        for (let i = 0; i < 80; i++) {
            const mid = (lo + hi) / 2;
            if (mid === lo || mid === hi) break;
            if (f(mid) >= k) hi = mid;
            else lo = mid;
        }
        THRESHOLDS[k] = hi;
    }
    for (let i = 0, k = 0; i <= 4096; i++) {
        while (k < 255 && THRESHOLDS[k + 1] <= i / 4096) k++;
        LINEAR_BYTE[i] = k;
    }
}
const linearByte = (v: number): number => {
    if (!(v > 0)) return 0;
    if (v >= 1) return 255;
    let k = LINEAR_BYTE[(v * 4096) | 0];
    while (v >= THRESHOLDS[k + 1]) k++;
    return k;
};

// XYB to interleaved sRGB bytes (out: RGBA, alpha left)
function xybToBytes(x: Float32Array, y: Float32Array, b: Float32Array, m: number[], bias: number[], k: number, out: Uint8Array): void {
    const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
    const b0 = bias[0], b1 = bias[1], b2 = bias[2], c0 = Math.cbrt(b0), c1 = Math.cbrt(b1), c2 = Math.cbrt(b2);
    for (let i = 0, o = 0; i < x.length; i++, o += 4) {
        const gr = y[i] + x[i] - c0, gg = y[i] - x[i] - c1, gb = b[i] - c2;
        const mr = gr * gr * gr + b0, mg = gg * gg * gg + b1, mb = gb * gb * gb + b2;
        out[o] = linearByte((m0 * mr + m1 * mg + m2 * mb) * k);
        out[o + 1] = linearByte((m3 * mr + m4 * mg + m5 * mb) * k);
        out[o + 2] = linearByte((m6 * mr + m7 * mg + m8 * mb) * k);
    }
}

/**
 * How frames become output colors: XYB to sRGB (or to linear light, 1 being SDR white, for HDR images), other images
 * stay in their color space (HDR ones become linear light at the end)
 */
export class ColorOutput {
    /** whether the color channels are linear light (until toRGBA) */
    private readonly linear: boolean;
    /** whether they're PQ or HLG signals (until toRGBA) */
    private readonly hdrSignal: boolean;
    private readonly scale: number;

    constructor(private readonly image: ImageHeader, private readonly toneMapping: ToneMapping) {
        const c = image.colour, hdr = !c.wantICC && (c.transfer === TF_PQ || c.transfer === TF_HLG);
        this.linear = image.xybEncoded && (hdr || image.toneMapping.intensityTarget > 255);
        this.hdrSignal = !image.xybEncoded && hdr;
        // (XYB is absolute: 1 is the intensity target)
        this.scale = this.linear ? image.toneMapping.intensityTarget / REFERENCE_WHITE : 1;
    }

    /**
     * the color transform of a frame's planes (YCbCr and XYB ones become 3 RGB ones); final: whether only toRGBA uses
     * them (straight alpha, no black or spot channels), then XYB ones become interleaved sRGB bytes right away
     */
    transform(p: Planes, ycbcr: boolean, final = false): Planes {
        const image = this.image, n = p.width * p.height, ch = p.channels.slice();
        if (ycbcr) {
            const [cb, y, cr] = ch, r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const Y = y[i] + 128 / 255;
                r[i] = Y + 1.402 * cr[i];
                g[i] = Y - 0.299 * 1.402 / 0.587 * cr[i] - 0.114 * 1.772 / 0.587 * cb[i];
                b[i] = Y + 1.772 * cb[i];
            }
            ch.splice(0, 3, r, g, b);
        } else if (image.xybEncoded) {
            const [x, y, b] = ch, m = image.opsinInverse, bias = image.opsinBias, cbrt = bias.map(Math.cbrt);
            const k = 255 / image.toneMapping.intensityTarget * this.scale;
            if (final && !this.linear) {
                // (the bytes right away, interleaved: the planes keep the extra channels only)
                const rgba = new Uint8Array(4 * n);
                xybToBytes(x, y, b, m, bias, k, rgba);
                return { width: p.width, height: p.height, channels: ch.slice(3), rgba };
            }
            const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const gr = y[i] + x[i] - cbrt[0], gg = y[i] - x[i] - cbrt[1], gb = b[i] - cbrt[2];
                const mr = gr * gr * gr + bias[0], mg = gg * gg * gg + bias[1], mb = gb * gb * gb + bias[2];
                let r = (m[0] * mr + m[1] * mg + m[2] * mb) * k, g = (m[3] * mr + m[4] * mg + m[5] * mb) * k, bl = (m[6] * mr + m[7] * mg + m[8] * mb) * k;
                if (!this.linear) {
                    r = srgbEncode(r);
                    g = srgbEncode(g);
                    bl = srgbEncode(bl);
                }
                R[i] = r;
                G[i] = g;
                B[i] = bl;
            }
            ch.splice(0, 3, R, G, B);
        }
        return { width: p.width, height: p.height, channels: ch };
    }

    /** the image (its planes after the color transform) as 8-bit RGBA, unpremultiplied */
    toRGBA(p: Planes): Uint8Array {
        const n = p.width * p.height, ch = p.channels, image = this.image;
        if (p.rgba) {
            // (the colors are bytes already, the channels are the extra ones: straight alpha or none)
            const out = p.rgba, alpha = ch.find((_, i) => image.extraChannels[i].type === EXTRA_ALPHA);
            if (alpha) for (let i = 0, o = 3; i < n; i++, o += 4) out[o] = byte(alpha[i]);
            else for (let o = 3; o < out.length; o += 4) out[o] = 255;
            return out;
        }
        const numColor = ch.length - image.extraChannels.length, grey = numColor === 1;
        let [r, g, b] = grey ? [ch[0], ch[0], ch[0]] : ch;
        // CMYK (a black channel): the color channels and black are stored as 1 - ink, the color becomes their product
        // (without the CMYK profile, like JPEGs' CMYK)
        const black = image.extraChannels.findIndex(e => e.type === EXTRA_BLACK);
        if (black >= 0) {
            const k = ch[numColor + black];
            if (grey) r = g = b = r.slice();
            else [r, g, b] = [r.slice(), g.slice(), b.slice()];
            for (let i = 0; i < n; i++) {
                r[i] *= k[i];
                if (!grey) {
                    g[i] *= k[i];
                    b[i] *= k[i];
                }
            }
        }
        // spot colors (onto color images), mixed in by their solidity
        image.extraChannels.forEach((e, i) => {
            if (e.type !== EXTRA_SPOT || grey) return;
            const s = ch[numColor + i], [sr, sg, sb, solidity] = e.spot;
            if (r === ch[0]) [r, g, b] = [r.slice(), g.slice(), b.slice()];
            for (let k = 0; k < n; k++) {
                const mix = solidity * s[k];
                r[k] = mix * sr + (1 - mix) * r[k];
                g[k] = mix * sg + (1 - mix) * g[k];
                b[k] = mix * sb + (1 - mix) * b[k];
            }
        });
        const alphaIndex = image.extraChannels.findIndex(e => e.type === EXTRA_ALPHA);
        const alpha = alphaIndex >= 0 ? ch[ch.length - image.extraChannels.length + alphaIndex] : null;
        const premultiplied = alphaIndex >= 0 && image.extraChannels[alphaIndex].alphaAssociated;
        let out: Uint8Array;
        if (this.linear || this.hdrSignal) {
            const rgb = new Float32Array(3 * n);
            for (let i = 0; i < n; i++) {
                const a = premultiplied ? Math.max(alpha![i], 2 ** -26) : 1;
                rgb[3 * i] = r[i] / a;
                rgb[3 * i + 1] = g[i] / a;
                rgb[3 * i + 2] = b[i] / a;
            }
            const c = image.colour;
            if (this.hdrSignal) hdrToLinear(rgb, c.transfer, c.primaries === PRI_BT2100 ? 9 : c.primaries === PRI_P3 ? 12 : 1);
            out = toSRGB(rgb, this.toneMapping);
        } else {
            out = new Uint8Array(4 * n);
            if (premultiplied) {
                for (let i = 0, o = 0; i < n; i++, o += 4) {
                    const a = Math.max(alpha![i], 2 ** -26);
                    out[o] = byte(r[i] / a);
                    out[o + 1] = byte(g[i] / a);
                    out[o + 2] = byte(b[i] / a);
                }
            } else {
                for (let i = 0, o = 0; i < n; i++, o += 4) {
                    out[o] = byte(r[i]);
                    out[o + 1] = byte(g[i]);
                    out[o + 2] = byte(b[i]);
                }
            }
        }
        if (alpha) for (let i = 0, o = 3; i < n; i++, o += 4) out[o] = byte(alpha[i]);
        else for (let o = 3; o < out.length; o += 4) out[o] = 255;
        return out;
    }
}
