/*!
 * Lossy JPEG XL encoding (VarDCT), like libjxl's effort 3 (lib/jxl/enc_heuristics.cc, enc_group.cc, quantizer.cc,
 * enc_adaptive_quantization.cc, enc_xyb.cc, enc_modular.cc): XYB, 8x8 DCTs, a constant quantization field from the
 * distance, libjxl's dead zone quantization, the default matrices, contexts and chroma from luma, the edge
 * preserving filter. Copyright (c) the JPEG XL Project Authors, BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */
import { BitWriter } from './bit-writer.ts';
import { imageHeader, u32 } from './headers-enc.ts';
import { EntropyCode, Tokens, packSigned } from './entropy-enc.ts';
import { MATree, TreeNode, PRED_GRADIENT, PRED_LEFT, PRED_WEIGHTED, PROP_CHANNEL, PROP_STREAM, PROP_WP_ERROR, channelTokens, fixedTree, streamHeader } from './modular-enc.ts';
import { dct2d } from './dct.ts';
import { defaultDequant } from './quant.ts';
import { naturalOrder } from './vardct.ts';

/** Options of the lossy JPEG XL encoder */
export interface VarDCTOptions {
    /** the Butteraugli distance (libjxl's -d): 1 is visually lossless, higher is smaller */
    distance: number;
}

// libjxl's opsin absorbance matrix and bias (lib/jxl/cms/opsin_params.h)
const OPSIN = [
    0.30, 0.622, 0.078,
    0.23, 0.692, 0.078,
    0.2434226892454782, 0.2047674442449682, 0.5518098665095535
];
const BIAS = 0.0037930732552754493, CBRT_BIAS = Math.cbrt(BIAS);

// sRGB to linear light
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
    const v = i / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

/** RGBA to the XYB planes, padded to whole blocks (by repeating the last column and row) */
function toXYB(rgba: Uint8Array, width: number, height: number, pw: number, ph: number): Float32Array[] {
    const x = new Float32Array(pw * ph), y = new Float32Array(pw * ph), b = new Float32Array(pw * ph);
    for (let py = 0; py < ph; py++) {
        const sy = Math.min(py, height - 1);
        for (let px = 0; px < pw; px++) {
            const s = 4 * (sy * width + Math.min(px, width - 1));
            const r = LINEAR[rgba[s]], g = LINEAR[rgba[s + 1]], bl = LINEAR[rgba[s + 2]];
            const l = Math.cbrt(Math.max(OPSIN[0] * r + OPSIN[1] * g + OPSIN[2] * bl + BIAS, 0)) - CBRT_BIAS;
            const m = Math.cbrt(Math.max(OPSIN[3] * r + OPSIN[4] * g + OPSIN[5] * bl + BIAS, 0)) - CBRT_BIAS;
            const s3 = Math.cbrt(Math.max(OPSIN[6] * r + OPSIN[7] * g + OPSIN[8] * bl + BIAS, 0)) - CBRT_BIAS;
            const i = py * pw + px;
            x[i] = 0.5 * (l - m);
            y[i] = 0.5 * (l + m);
            b[i] = s3;
        }
    }
    return [x, y, b];
}

// the quantization parameters of a distance (libjxl's InitialQuantDC, ComputeGlobalScaleAndQuant, SetQuantField for
// effort 3's constant field): [global scale, LF quantizer, HF multiplier]
function quantizer(distance: number): [number, number, number] {
    const dcDistance = Math.max(0.5 * distance, Math.min(distance, 0.3 * (distance / 0.3) ** 0.83));
    const quantDc = Math.fround(Math.min(1.095924047623553 / dcDistance, 50));
    const q = Math.fround(0.79 / distance);
    let globalScale = Math.trunc(Math.min(Math.max(65536 * q / 5, 1), 1 << 15));
    const scaledQuantDc = Math.trunc(quantDc * 4096 * 1.6);
    if (globalScale > scaledQuantDc) globalScale = Math.max(scaledQuantDc, 1);
    const inv = 65536 / globalScale;
    const quantLf = Math.trunc(Math.min(quantDc * inv + 0.5, 1 << 16));
    const mul = Math.trunc(Math.max(1, Math.min(q * inv + 0.5, 256)));
    return [globalScale, quantLf, mul];
}

// the default LF dequantization (X, Y, B) and quantization biases
const LF_DEQUANT = [1 / 32, 1 / 4, 1 / 2];
const QUANT_BIAS = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655], QUANT_BIAS_NUMERATOR = 0.145;
// the default block context map (the context of a channel's DCT8 blocks: Y, then X and B) and its number of contexts
const BLOCK_CTX = [0, 7, 7], NUM_BLOCK_CTX = 15;
// libjxl's coefficient contexts (lib/jxl/ac_context.h)
const FREQ_CONTEXT = Uint8Array.of(
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 23, 23,
    24, 24, 24, 24, 25, 25, 25, 25, 26, 26, 26, 26, 27, 27, 27, 27, 28, 28, 28, 28, 29, 29, 29, 29, 30, 30, 30, 30
);
const NUM_NONZERO_CONTEXT = Uint8Array.of(
    0, 31, 62, 62, 93, 93, 93, 93, 123, 123, 123, 123, 152, 152, 152, 152, 152, 152, 152, 152, 180, 180, 180, 180, 180, 180, 180, 180,
    180, 180, 180, 180, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206,
    206, 206, 206, 206, 206, 206, 206, 206, 206
);

const ceilLog2 = (x: number): number => x <= 1 ? 0 : 32 - Math.clz32(x - 1);

// libjxl's cutoffs of its fixed trees for the LF
const LF_CUTOFFS = [
    -500, -392, -255, -191, -127, -95, -63, -47, -31, -23, -15, -11, -7, -4, -3, -1, 0, 1, 3, 5, 7, 11, 15, 23, 31, 47, 63, 95,
    127, 191, 255, 392, 500
];

// the global tree: the LF coefficients (streams 1 to numLfGroups) of each channel by libjxl's fixed tree (effort 3: the
// weighted predictor, split by its error), the channels of the HF metadata (CfL, varblock types and multipliers, EPF
// sharpness: mostly constant; streams up to 3 numLfGroups) predicted from the left, alpha (the global stream 0 or the
// pass groups') by the gradient
function globalTree(numLfGroups: number, numPixels: number): MATree {
    const lf = (): TreeNode => fixedTree(PROP_WP_ERROR, LF_CUTOFFS, PRED_WEIGHTED, numPixels);
    const byChannel = (n: number, leaf: () => TreeNode): TreeNode => {
        let node = leaf();
        for (let c = n - 2; c >= 0; c--) node = { property: PROP_CHANNEL, split: c, above: node, below: leaf() };
        return node;
    };
    const hf = byChannel(4, () => ({ predictor: PRED_LEFT })), alpha = (): TreeNode => ({ predictor: PRED_GRADIENT });
    const lfOrAlpha: TreeNode = { property: PROP_STREAM, split: 0, above: byChannel(3, lf), below: alpha() };
    return new MATree({ property: PROP_STREAM, split: 3 * numLfGroups + 16, above: alpha(), below: { property: PROP_STREAM, split: numLfGroups, above: hf, below: lfOrAlpha } });
}

/** Encodes RGBA pixels as a lossy JPEG XL codestream, alpha (if the image has transparency) losslessly */
export function encodeVarDCT(rgba: Uint8Array, width: number, height: number, { distance }: VarDCTOptions): Uint8Array {
    if (width < 1 || height < 1) throw new RangeError('JPEG XL: dimensions must be at least 1');
    const bw = Math.ceil(width / 8), bh = Math.ceil(height / 8), pw = bw * 8;
    const planes = toXYB(rgba, width, height, pw, bh * 8);
    let alpha: Int32Array | null = null;
    for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] === 255) continue;
        alpha = new Int32Array(width * height);
        for (let k = 0; k < alpha.length; k++) alpha[k] = rgba[4 * k + 3];
        break;
    }

    const [globalScale, quantLf, mul] = quantizer(distance);
    // (X's multiplier: libjxl's x_qm_scale 3 up to distance 2.5, then one more per step)
    const xqmScale = 3 + [2.5, 5.5, 9.5].filter(t => distance > t).length, bqmScale = 2;
    const qmMul = [1.25 ** (xqmScale - 2), 1, 1.25 ** (bqmScale - 2)];
    const epfIters = [0.7, 1.5, 4].filter(t => distance >= t).length;
    const lfStep = LF_DEQUANT.map(m => m * 512 / (globalScale * quantLf));
    const hfStep = 65536 / (globalScale * mul);
    const matrices = defaultDequant(0)[1];

    // the LF (per block) and HF (per coefficient, in the planes' layout) quantized
    const lf = [0, 1, 2].map(() => new Int32Array(bw * bh));
    const hf = [0, 1, 2].map(() => new Int32Array(pw * bh * 8));
    const block = new Float32Array(64), coeffs = [0, 1, 2].map(() => new Float32Array(64)), yDequant = new Float32Array(64);
    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            for (let c = 0; c < 3; c++) {
                const p = planes[c], o = by * 8 * pw + bx * 8;
                for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = p[o + y * pw + x];
                dct2d({ buf: block, offset: 0, stride: 8, w: 8, h: 8 }, false);
                coeffs[c].set(block);
            }
            const bi = by * bw + bx, o = by * 8 * pw + bx * 8;
            // LF: Y, then X and B less Y (the default chroma from luma: X 0, B 1)
            const ly = Math.round(coeffs[1][0] / lfStep[1]);
            lf[1][bi] = ly;
            lf[0][bi] = Math.round(coeffs[0][0] / lfStep[0]);
            lf[2][bi] = Math.round((coeffs[2][0] - ly * lfStep[1]) / lfStep[2]);
            // HF: Y, then X and B less the dequantized Y
            for (const c of [1, 0, 2]) {
                const src = coeffs[c], m = matrices[c], out = hf[c];
                const thresholds = c === 1 ? [0.56, 0.62, 0.62, 0.62] : [0.58, 0.62, 0.62, 0.62];
                const scale = qmMul[c] / hfStep;
                for (let y = 0; y < 8; y++) {
                    for (let x = 0; x < 8; x++) {
                        const k = y * 8 + x;
                        if (k === 0) continue;
                        const v = (c === 2 ? src[k] - yDequant[k] : src[k]) / m[k] * scale;
                        const q = Math.abs(v) >= thresholds[(y >= 4 ? 2 : 0) + (x >= 4 ? 1 : 0)] ? Math.round(v) : 0;
                        out[o + y * pw + x] = q;
                        if (c === 1) {
                            const d = q === 0 ? 0 : Math.abs(q) <= 1 ? q * QUANT_BIAS[1] : q - QUANT_BIAS_NUMERATOR / q;
                            yDequant[k] = d * m[k] * hfStep;
                        }
                    }
                }
            }
        }
    }

    // the frame's structure: groups of 256 pixels, LF groups of 2048
    const groupsPerRow = Math.ceil(width / 256), numGroups = groupsPerRow * Math.ceil(height / 256);
    const lfGroupsPerRow = Math.ceil(width / 2048), numLfGroups = lfGroupsPerRow * Math.ceil(height / 2048);
    const tree = globalTree(numLfGroups, 3 * bw * bh);

    // the LF groups' Modular data: the LF coefficients (Y, X, B), then the HF metadata
    const lfTokens: Tokens[] = [];
    const lfGroupBlocks = (g: number): number[] => {
        const x0 = (g % lfGroupsPerRow) * 256, y0 = Math.floor(g / lfGroupsPerRow) * 256;
        return [x0, y0, Math.min(256, bw - x0), Math.min(256, bh - y0)];
    };
    const crop = (src: Int32Array, x0: number, y0: number, w: number, h: number, stride: number): Int32Array => {
        const out = new Int32Array(w * h);
        for (let y = 0; y < h; y++) out.set(src.subarray((y0 + y) * stride + x0, (y0 + y) * stride + x0 + w), y * w);
        return out;
    };
    for (let g = 0; g < numLfGroups; g++) {
        const [x0, y0, w, h] = lfGroupBlocks(g), t = new Tokens();
        [1, 0, 2].forEach((c, i) => channelTokens(t, tree, crop(lf[c], x0, y0, w, h, bw), w, h, i, 1 + g));
        lfTokens.push(t);
        // (CfL tiles of zeros, DCT8 blocks with the multiplier, sharpness 4)
        const m = new Tokens(), tw = Math.ceil(w / 8), th = Math.ceil(h / 8), stream = 1 + 2 * numLfGroups + g;
        channelTokens(m, tree, new Int32Array(tw * th), tw, th, 0, stream);
        channelTokens(m, tree, new Int32Array(tw * th), tw, th, 1, stream);
        const info = new Int32Array(2 * w * h);
        info.fill(mul - 1, w * h);
        channelTokens(m, tree, info, w * h, 2, 2, stream);
        channelTokens(m, tree, new Int32Array(w * h).fill(4), w, h, 3, stream);
        lfTokens.push(m);
    }
    // alpha: in the global stream if it fits into a group, else in the pass groups' streams
    const alphaTokens: Tokens[] = [];
    if (alpha && numGroups === 1) {
        const t = new Tokens();
        channelTokens(t, tree, alpha, width, height, 0, 0);
        alphaTokens.push(t);
    } else if (alpha) {
        for (let g = 0; g < numGroups; g++) {
            const x0 = (g % groupsPerRow) * 256, y0 = Math.floor(g / groupsPerRow) * 256, w = Math.min(256, width - x0), h = Math.min(256, height - y0);
            const t = new Tokens();
            channelTokens(t, tree, crop(alpha, x0, y0, w, h, width), w, h, 0, 1 + 3 * numLfGroups + 17 + g);
            alphaTokens.push(t);
        }
    }
    const modularCode = new EntropyCode([...lfTokens, ...alphaTokens], tree.numLeaves);

    // the pass groups' HF coefficients
    const order = naturalOrder(0);
    const hfTokens: Tokens[] = [];
    for (let g = 0; g < numGroups; g++) {
        const bx0 = (g % groupsPerRow) * 32, by0 = Math.floor(g / groupsPerRow) * 32;
        const gw = Math.min(32, bw - bx0), gh = Math.min(32, bh - by0), t = new Tokens();
        const nonZeros = [0, 1, 2].map(() => new Uint32Array(gw));
        for (let y = 0; y < gh; y++) {
            for (let x = 0; x < gw; x++) {
                const o = (by0 + y) * 8 * pw + (bx0 + x) * 8;
                for (let k = 0; k < 3; k++) {
                    const c = [1, 0, 2][k], q = hf[c], nz = nonZeros[c], blockCtx = BLOCK_CTX[k];
                    let count = 0;
                    for (let i = 1; i < 64; i++) if (q[o + order[2 * i] * pw + order[2 * i + 1]]) count++;
                    const predicted = y === 0 ? (x === 0 ? 32 : nz[x - 1]) : x === 0 ? nz[x] : (nz[x] + nz[x - 1] + 1) >> 1;
                    t.push(blockCtx + (predicted >= 8 ? 4 + (predicted >> 1) : predicted) * NUM_BLOCK_CTX, count);
                    nz[x] = count;
                    if (!count) continue;
                    // (DCT8 is transposed: the order's x is the row)
                    let prevNonZero = count <= 4 ? 1 : 0;
                    const ctxBase = blockCtx * 458 + 37 * NUM_BLOCK_CTX;
                    for (let i = 1; i < 64 && count > 0; i++) {
                        const v = q[o + order[2 * i] * pw + order[2 * i + 1]];
                        t.push(ctxBase + (NUM_NONZERO_CONTEXT[count - 1] + FREQ_CONTEXT[i - 1]) * 2 + prevNonZero, packSigned(v));
                        prevNonZero = v ? 1 : 0;
                        if (v) count--;
                    }
                }
            }
        }
        hfTokens.push(t);
    }
    const hfCode = new EntropyCode(hfTokens, 495 * NUM_BLOCK_CTX);

    // the sections: LfGlobal, the LF groups, HfGlobal, the pass groups
    const sections: BitWriter[] = [];
    {
        const w = new BitWriter();
        // default LF dequantization, the quantizer, the default block contexts and chroma from luma
        w.write(1, 1);
        u32(w, globalScale, [[11, 1], [11, 2049], [12, 4097], [16, 8193]]);
        u32(w, quantLf, [[0, 16], [5, 1], [8, 1], [16, 1]]);
        w.write(1, 1);
        w.write(1, 1);
        // the global tree and its code
        w.write(1, 1);
        tree.write(w);
        modularCode.writeHeader(w);
        // the global Modular image (alpha), if there is
        if (alpha) {
            streamHeader(w);
            if (numGroups === 1) modularCode.writeTokens(w, alphaTokens[0]);
        }
        sections.push(w);
    }
    for (let g = 0; g < numLfGroups; g++) {
        const w = new BitWriter(), [, , gw, gh] = lfGroupBlocks(g);
        // no extra LF precision
        w.write(2, 0);
        streamHeader(w);
        modularCode.writeTokens(w, lfTokens[2 * g]);
        w.write(ceilLog2(gw * gh), gw * gh - 1);
        streamHeader(w);
        modularCode.writeTokens(w, lfTokens[2 * g + 1]);
        sections.push(w);
    }
    {
        const w = new BitWriter();
        // default matrices, one HF preset, natural orders, the coefficients' code
        w.write(1, 1);
        w.write(ceilLog2(numGroups), 0);
        w.write(2, 2);
        hfCode.writeHeader(w);
        sections.push(w);
    }
    for (let g = 0; g < numGroups; g++) {
        const w = new BitWriter();
        hfCode.writeTokens(w, hfTokens[g]);
        if (alpha && numGroups > 1) {
            streamHeader(w);
            modularCode.writeTokens(w, alphaTokens[g]);
        }
        sections.push(w);
    }

    // the image header, the frame header, the TOC, the sections
    const out = new BitWriter();
    imageHeader(out, width, height, alpha ? 4 : 3, true);
    frameHeader(out, xqmScale, bqmScale, epfIters, alpha !== null);
    if (numGroups === 1) {
        // (a single section: all of them one after the other)
        const all = new BitWriter();
        for (const s of sections) all.append(s);
        sections.length = 0;
        sections.push(all);
    }
    for (const s of sections) s.zeroPadToByte();
    out.write(1, 0);
    out.zeroPadToByte();
    for (const s of sections) u32(out, s.length, [[10, 0], [14, 1024], [22, 17408], [30, 4211712]]);
    out.zeroPadToByte();
    const total = out.length + sections.reduce((n, s) => n + s.length, 0), bytes = new Uint8Array(total);
    bytes.set(out.bytes());
    let at = out.length;
    for (const s of sections) {
        bytes.set(s.bytes(), at);
        at += s.length;
    }
    return bytes;
}

// a regular VarDCT frame: no flags, one pass, replacing (alpha too), the last one; no Gaborish, EPF iterations
function frameHeader(w: BitWriter, xqmScale: number, bqmScale: number, epfIters: number, alpha: boolean): void {
    w.write(1, 0);
    w.write(2, 0);
    w.write(1, 0);
    w.write(2, 0);
    w.write(2, 0);
    if (alpha) w.write(2, 0);
    w.write(3, xqmScale);
    w.write(3, bqmScale);
    w.write(2, 0);
    w.write(1, 0);
    w.write(2, 0);
    if (alpha) w.write(2, 0);
    w.write(1, 1);
    w.write(2, 0);
    // the loop filter: not the default, no Gaborish, the EPF iterations (default parameters), no extensions
    w.write(1, 0);
    w.write(1, 0);
    w.write(2, epfIters);
    if (epfIters) {
        w.write(1, 0);
        w.write(1, 0);
        w.write(1, 0);
    }
    w.write(2, 0);
    w.write(2, 0);
}
