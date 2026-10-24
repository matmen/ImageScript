/*!
 * JPEG XL's dequantization matrices: their encodings (the defaults, parameters, raw tables) and how they become the
 * multipliers of the varblocks' coefficients; ported from jxl-oxide (crates/jxl-vardct/src/dequant.rs). Copyright (c)
 * Wonwoo Choi, MIT License (see THIRD_PARTY_NOTICES.md)
 */
import { BitReader } from './bits.ts';
import { ModularImage, MAConfig, channel, decodeModular } from './modular.ts';

const f32 = Math.fround;

// the matrices' sizes (width, height) of the 17 parameter sets, by varblock type
export const MATRIX_SIZES = [[8, 8], [8, 8], [8, 8], [8, 8], [16, 16], [32, 32], [16, 8], [32, 8], [32, 16], [8, 8], [8, 8], [64, 64], [64, 32], [128, 128], [128, 64], [256, 256], [256, 128]];
/** the parameter set of each varblock type */
export const MATRIX_INDEX = [0, 1, 2, 3, 4, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 10, 10, 11, 12, 12, 13, 14, 14, 15, 16, 16];

const SEQ_A = [-1.025, -0.78, -0.65012, -0.19041574, -0.20819396, -0.421064, -0.32733846];
const SEQ_B = [-0.30419582, -0.36330363, -0.3566038, -0.34430745, -0.33699593, -0.30180866, -0.27321684];
const SEQ_C = [-1.2, -1.2, -0.8, -0.7, -0.7, -0.4, -0.5];
const DCT4X8_PARAMS = [[2198.0505, -0.96269625, -0.7619425, -0.65511405], [764.36554, -0.926302, -0.967523, -0.2784529], [527.10754, -1.4594386, -1.4500821, -1.5843723]];
const DCT4_PARAMS = [[2200.0, 0.0, 0.0, 0.0], [392.0, 0.0, 0.0, 0.0], [112.0, -0.25, -0.25, -0.5]];

type Encoding =
    | { mode: 'dct', dct: number[][] }
    | { mode: 'hornuss', params: number[][] }
    | { mode: 'dct2', params: number[][] }
    | { mode: 'dct4', params: number[][], dct: number[][] }
    | { mode: 'dct4x8', params: number[][], dct: number[][] }
    | { mode: 'afv', params: number[][], dct: number[][], dct4x4: number[][] }
    | { mode: 'raw', denominator: number, values: Int32Array[] };

const common = (a: number, b: number, c: number): Encoding => ({ mode: 'dct', dct: [[a, ...SEQ_A], [b, ...SEQ_B], [c, ...SEQ_C]] });

function defaultEncoding(index: number): Encoding {
    switch (index) {
        case 0: return { mode: 'dct', dct: [[3150.0, 0.0, -0.4, -0.4, -0.4, -2.0], [560.0, 0.0, -0.3, -0.3, -0.3, -0.3], [512.0, -2.0, -1.0, 0.0, -1.0, -2.0]] };
        case 1: return { mode: 'hornuss', params: [[280.0, 3160.0, 3160.0], [60.0, 864.0, 864.0], [18.0, 200.0, 200.0]] };
        case 2: return { mode: 'dct2', params: [[3840.0, 2560.0, 1280.0, 640.0, 480.0, 300.0], [960.0, 640.0, 320.0, 180.0, 140.0, 120.0], [640.0, 320.0, 128.0, 64.0, 32.0, 16.0]] };
        case 3: return { mode: 'dct4', params: [[1, 1], [1, 1], [1, 1]], dct: DCT4_PARAMS };
        case 4: return { mode: 'dct', dct: [[8996.873, -1.3000778, -0.4942453, -0.43909377, -0.6350102, -0.9017726, -1.6162099], [3191.4836, -0.67424583, -0.80745816, -0.4492584, -0.3586544, -0.3132239, -0.37615025], [1157.504, -2.0531423, -1.4, -0.5068713, -0.4270873, -1.4856834, -4.920914]] };
        case 5: return { mode: 'dct', dct: [[15718.408, -1.025, -0.98, -0.9012, -0.4, -0.48819396, -0.421064, -0.27], [7305.7637, -0.8041958, -0.76330364, -0.5566038, -0.49785304, -0.43699592, -0.40180868, -0.27321684], [3803.5317, -3.0607336, -2.041327, -2.023565, -0.54953897, -0.4, -0.4, -0.3]] };
        case 6: return { mode: 'dct', dct: [[7240.7734, -0.7, -0.7, -0.2, -0.2, -0.2, -0.5], [1448.1547, -0.5, -0.5, -0.5, -0.2, -0.2, -0.2], [506.85413, -1.4, -0.2, -0.5, -0.5, -1.5, -3.6]] };
        case 7: return { mode: 'dct', dct: [[16283.249, -1.7812846, -1.6309059, -1.0382179, -0.85, -0.7, -0.9, -1.2360638], [5089.1577, -0.3200494, -0.3536285, -0.3034, -0.61, -0.5, -0.5, -0.6], [3397.7761, -0.32132736, -0.3450762, -0.7034, -0.9, -1.0, -1.0, -1.1754606]] };
        case 8: return { mode: 'dct', dct: [[13844.971, -0.971138, -0.658, -0.42026, -0.22712, -0.2206, -0.226, -0.6], [4798.964, -0.6112531, -0.8377079, -0.7901486, -0.26927274, -0.38272768, -0.22924222, -0.20719099], [1807.2369, -1.2, -1.2, -0.7, -0.7, -0.7, -0.4, -0.5]] };
        case 9: return { mode: 'dct4x8', params: [[1], [1], [1]], dct: DCT4X8_PARAMS };
        case 10: return {
            mode: 'afv',
            params: [[3072.0, 3072.0, 256.0, 256.0, 256.0, 414.0, 0.0, 0.0, 0.0], [1024.0, 1024.0, 50.0, 50.0, 50.0, 58.0, 0.0, 0.0, 0.0], [384.0, 384.0, 12.0, 12.0, 12.0, 22.0, -0.25, -0.25, -0.25]],
            dct: DCT4X8_PARAMS, dct4x4: DCT4_PARAMS
        };
        case 11: return common(23966.166, 8380.191, 4493.024);
        case 12: return common(15358.898, 5597.3604, 2919.9617);
        case 13: return common(47932.332, 16760.383, 8986.048);
        case 14: return common(30717.797, 11194.721, 5839.9233);
        case 15: return common(95864.664, 33520.766, 17972.096);
        default: return common(61435.594, 24209.441, 12979.847);
    }
}

function interpolate(pos: number, max: number, bands: number[]): number {
    if (bands.length === 1) return bands[0];
    const scaled = f32(pos * (bands.length - 1) / max), index = Math.trunc(scaled), frac = f32(scaled - index);
    const a = bands[index], b = bands[index + 1];
    return f32(a * f32((b / a) ** frac));
}

const mult = (x: number): number => x > 0 ? 1 + x : 1 / (1 - x);

function dctWeights(params: number[], w: number, h: number): Float32Array {
    const bands = [params[0]];
    for (let i = 1; i < params.length; i++) {
        const band = f32(bands[i - 1] * f32(mult(params[i])));
        if (band <= 0) throw new Error('JPEG XL: invalid dequantization matrix');
        bands.push(band);
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = f32(x / (w - 1)), dy = f32(y / (h - 1));
            out[y * w + x] = interpolate(f32(Math.sqrt(f32(dx * dx + dy * dy))), f32(Math.SQRT2 + 1e-6), bands);
        }
    }
    return out;
}

// the weights (quantization steps) of an encoding, for X, Y, B
function weights(e: Encoding, index: number): Float32Array[] {
    const [w, h] = MATRIX_SIZES[index];
    switch (e.mode) {
        case 'dct': return e.dct.map(p => dctWeights(p, w, h));
        case 'hornuss': return e.params.map(p => {
            const m = new Float32Array(64).fill(p[0]);
            m[0] = 1;
            m[1] = m[8] = p[1];
            m[9] = p[2];
            return m;
        });
        case 'dct2': return e.params.map(p => {
            const m = new Float32Array(64);
            m[0] = 1;
            p.forEach((v, i) => {
                const dim = 1 << (i >> 1);
                if (i % 2 === 0) {
                    for (let y = 0; y < dim; y++) for (let x = dim; x < 2 * dim; x++) m[y * 8 + x] = m[x * 8 + y] = v;
                } else for (let y = dim; y < 2 * dim; y++) for (let x = dim; x < 2 * dim; x++) m[y * 8 + x] = v;
            });
            return m;
        });
        case 'dct4': return e.params.map((p, c) => {
            const mat = dctWeights(e.dct[c], 4, 4), m = new Float32Array(64);
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    const v = mat[y * 4 + x];
                    m[y * 16 + x * 2] = m[y * 16 + x * 2 + 1] = m[(y * 2 + 1) * 8 + x * 2] = m[(y * 2 + 1) * 8 + x * 2 + 1] = v;
                }
            }
            m[1] /= p[0];
            m[8] /= p[0];
            m[9] /= p[1];
            return m;
        });
        case 'dct4x8': return e.params.map((p, c) => {
            const mat = dctWeights(e.dct[c], 8, 4), m = new Float32Array(64);
            for (let y = 0; y < 4; y++) for (let k = 0; k < 2; k++) m.set(mat.subarray(y * 8, y * 8 + 8), (y * 2 + k) * 8);
            m[8] /= p[0];
            return m;
        });
        case 'afv': return e.params.map((p, c) => {
            const FREQS = [0, 0, 0.8517779, 5.3777843, 0, 0, 4.734748, 5.4492455, 1.659827, 4.0, 7.275749, 10.423227, 2.6629324, 7.6306577, 8.962389, 12.971662];
            const lo = FREQS[2], hi = FREQS[15];
            const w4x8 = dctWeights(e.dct[c], 8, 4), w4x4 = dctWeights(e.dct4x4[c], 4, 4);
            const bands = [p[5]];
            for (let i = 1; i < 4; i++) bands.push(f32(bands[i - 1] * f32(mult(p[5 + i]))));
            const m = new Float32Array(64);
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    m[16 * y + 2 * x] = x === 0 && y === 0 ? 1 : x === 0 && y === 1 ? p[2] : x === 1 && y === 0 ? p[3] : x === 1 && y === 1 ? p[4] :
                        interpolate(f32(FREQS[y * 4 + x] - lo), f32(hi - lo + 1e-6), bands);
                }
            }
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 8; x++) m[16 * y + 8 + x] = y === 0 && x === 0 ? p[0] : w4x8[y * 8 + x];
                for (let x = 0; x < 4; x++) m[16 * y + 2 * x + 1] = y === 0 && x === 0 ? p[1] : w4x4[y * 4 + x];
            }
            return m;
        });
        default: return e.values.map(v => Float32Array.from(v, q => q * e.denominator));
    }
}

/** The dequantization multipliers by parameter set and channel (raster order), and transposed */
export interface DequantMatrices {
    matrices: Float32Array[][];
    transposed: Float32Array[][];
}

/** Reads the dequantization matrices (stream: the stream index of the first raw one) */
export function readDequantMatrices(r: BitReader, bitDepth: number, stream: number, tree: MAConfig | null): DequantMatrices {
    const encodings: Encoding[] = [];
    const allDefault = r.bool();
    for (let i = 0; i < 17; i++) {
        if (allDefault) {
            encodings.push(defaultEncoding(i));
            continue;
        }
        const mode = r.bits(3);
        if (mode >= 1 && mode <= 5 && ![0, 1, 2, 3, 9, 10].includes(i)) throw new Error('JPEG XL: invalid dequantization matrix encoding');
        const fixed = (n: number): number[][] => [0, 1, 2].map(() => Array.from({ length: n }, () => r.f16()));
        const dctParams = (): number[][] => {
            const n = r.bits(4) + 1;
            const p = [0, 1, 2].map(() => Array.from({ length: n }, () => r.f16()));
            for (const c of p) c[0] *= 64;
            return p;
        };
        switch (mode) {
            case 0: encodings.push(defaultEncoding(i)); break;
            case 1: encodings.push({ mode: 'hornuss', params: fixed(3) }); break;
            case 2: encodings.push({ mode: 'dct2', params: fixed(6) }); break;
            case 3: encodings.push({ mode: 'dct4', params: fixed(2), dct: dctParams() }); break;
            case 4: encodings.push({ mode: 'dct4x8', params: fixed(1), dct: dctParams() }); break;
            case 5: {
                const params = fixed(9);
                for (const c of params) for (let k = 0; k < 6; k++) c[k] *= 64;
                encodings.push({ mode: 'afv', params, dct: dctParams(), dct4x4: dctParams() });
                break;
            }
            case 6: encodings.push({ mode: 'dct', dct: dctParams() }); break;
            case 7: {
                const [w, h] = MATRIX_SIZES[i], denominator = r.f16();
                const image = new ModularImage([channel(w, h), channel(w, h), channel(w, h)], bitDepth);
                decodeModular(r, image, stream + i, tree, Infinity, true);
                encodings.push({ mode: 'raw', denominator, values: image.channels.map(c => c.data) });
                break;
            }
            default: throw new Error('JPEG XL: invalid dequantization matrix encoding');
        }
    }
    const matrices = encodings.map((e, i) => {
        const m = weights(e, i);
        if (e.mode !== 'raw') for (const c of m) for (let k = 0; k < c.length; k++) c[k] = 1 / c[k];
        for (const c of m) for (const v of c) if (!(v > 0 && v < 1e8)) throw new Error('JPEG XL: invalid dequantization matrix');
        return m;
    });
    const transposed = matrices.map((m, i) => {
        const [w, h] = MATRIX_SIZES[i];
        return m.map(c => {
            const t = new Float32Array(c.length);
            for (let k = 0; k < c.length; k++) t[k] = c[(k % h) * w + Math.floor(k / h)];
            return t;
        });
    });
    return { matrices, transposed };
}
