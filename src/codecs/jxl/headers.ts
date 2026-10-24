/*!
 * The JPEG XL image header: size, metadata (bit depths, extra channels, color encoding, tone mapping, animation),
 * the embedded ICC profile's stream; ported from jxl-oxide (crates/jxl-image, crates/jxl-color/src/icc/decode.rs).
 * Copyright (c) Wonwoo Choi, MIT License (see THIRD_PARTY_NOTICES.md)
 */
import { BitReader, extensions, unpackSigned } from './bits.ts';
import { EntropyDecoder } from './entropy.ts';

export interface BitDepth {
    float: boolean;
    bits: number;
    expBits: number;
}

export const EXTRA_ALPHA = 0, EXTRA_SPOT = 2, EXTRA_BLACK = 4;

export interface ExtraChannel {
    type: number;
    bitDepth: BitDepth;
    dimShift: number;
    /** alpha: premultiplied */
    alphaAssociated: boolean;
    /** spot colors: RGB and solidity */
    spot: number[];
}

export const CS_RGB = 0, CS_GREY = 1, CS_XYB = 2;
export const WP_D65 = 1, WP_CUSTOM = 2, WP_E = 10, WP_DCI = 11;
export const PRI_SRGB = 1, PRI_CUSTOM = 2, PRI_BT2100 = 9, PRI_P3 = 11;
export const TF_BT709 = 1, TF_UNKNOWN = 2, TF_LINEAR = 8, TF_SRGB = 13, TF_PQ = 16, TF_DCI = 17, TF_HLG = 18;

export interface ColourEncoding {
    wantICC: boolean;
    colourSpace: number;
    whitePoint: number;
    /** custom white point, primaries: x, y (red, green, blue) */
    white: number[];
    primaries: number;
    primariesXY: number[];
    /** a transfer function, or a gamma (1 / it, -1: none) */
    transfer: number;
    gamma: number;
    renderingIntent: number;
}

export interface ToneMapping {
    intensityTarget: number;
    minNits: number;
    relativeToMaxDisplay: boolean;
    linearBelow: number;
}

export interface ImageHeader {
    width: number;
    height: number;
    orientation: number;
    preview: { width: number, height: number } | null;
    animation: { tpsNumerator: number, tpsDenominator: number, numLoops: number, haveTimecodes: boolean } | null;
    bitDepth: BitDepth;
    modular16BitBuffers: boolean;
    extraChannels: ExtraChannel[];
    xybEncoded: boolean;
    colour: ColourEncoding;
    toneMapping: ToneMapping;
    /** the opsin inverse matrix (3x3, rows), opsin and quantization biases */
    opsinInverse: number[];
    opsinBias: number[];
    quantBias: number[];
    quantBiasNumerator: number;
    /** the upsampling weights (2x, 4x, 8x) */
    up2: number[];
    up4: number[];
    up8: number[];
}

const SIZE_DIST: [[number, number], [number, number], [number, number], [number, number]] = [[1, 9], [1, 13], [1, 18], [1, 30]];

function defaultWidth(ratio: number, height: number): number {
    switch (ratio) {
        case 1: return height;
        case 2: return Math.floor(height * 12 / 10);
        case 3: return Math.floor(height * 4 / 3);
        case 4: return Math.floor(height * 3 / 2);
        case 5: return Math.floor(height * 16 / 9);
        case 6: return Math.floor(height * 5 / 4);
        default: return height * 2;
    }
}

/** SizeHeader: [width, height] */
export function sizeHeader(r: BitReader): [number, number] {
    const div8 = r.bool();
    const height = div8 ? 8 * (1 + r.bits(5)) : r.u32(...SIZE_DIST);
    const ratio = r.bits(3);
    const width = ratio ? defaultWidth(ratio, height) : div8 ? 8 * (1 + r.bits(5)) : r.u32(...SIZE_DIST);
    return [width, height];
}

function previewHeader(r: BitReader): [number, number] {
    const div8 = r.bool();
    const dist8: [number, number, [number, number], [number, number]] = [16, 32, [1, 5], [33, 9]];
    const dist: [[number, number], [number, number], [number, number], [number, number]] = [[1, 6], [65, 8], [321, 10], [1345, 12]];
    const height = div8 ? 8 * r.u32(...dist8) : r.u32(...dist);
    const ratio = r.bits(3);
    const width = ratio ? defaultWidth(ratio, height) : div8 ? 8 * r.u32(...dist8) : r.u32(...dist);
    return [width, height];
}

export function bitDepth(r: BitReader): BitDepth {
    if (r.bool()) {
        const bits = r.u32(32, 16, 24, [1, 6]), expBits = r.bits(4) + 1;
        const mantissaBits = bits - expBits - 1;
        if (expBits < 2 || expBits > 8 || mantissaBits < 2 || mantissaBits > 23) throw new Error('JPEG XL: invalid float sample bit depth');
        return { float: true, bits, expBits };
    }
    const bits = r.u32(8, 10, 12, [1, 6]);
    if (bits > 31) throw new Error('JPEG XL: invalid bit depth');
    return { float: false, bits, expBits: 0 };
}

function name(r: BitReader): void {
    const length = r.u32(0, [0, 4], [16, 5], [48, 10]);
    r.skipBits(8 * length);
}

function extraChannel(r: BitReader): ExtraChannel {
    if (r.bool()) return { type: EXTRA_ALPHA, bitDepth: { float: false, bits: 8, expBits: 0 }, dimShift: 0, alphaAssociated: false, spot: [] };
    const type = r.enum();
    const depth = bitDepth(r);
    const dimShift = r.u32(0, 3, 4, [1, 3]);
    name(r);
    let alphaAssociated = false;
    const spot: number[] = [];
    if (type === EXTRA_ALPHA) alphaAssociated = r.bool();
    else if (type === EXTRA_SPOT) for (let i = 0; i < 4; i++) spot.push(r.f16());
    else if (type === 5) r.u32(1, [0, 2], [3, 4], [19, 8]);
    else if (type > 6 && type !== 15 && type !== 16) throw new Error('JPEG XL: invalid extra channel type');
    return { type, bitDepth: depth, dimShift, alphaAssociated, spot };
}

function customXY(r: BitReader): number {
    const d: [[number, number], [number, number], [number, number], [number, number]] = [[0, 19], [524288, 19], [1048576, 20], [2097152, 21]];
    return unpackSigned(r.u32(...d)) / 1e6;
}

export function colourEncoding(r: BitReader): ColourEncoding {
    const c: ColourEncoding = {
        wantICC: false, colourSpace: CS_RGB, whitePoint: WP_D65, white: [], primaries: PRI_SRGB, primariesXY: [],
        transfer: TF_SRGB, gamma: -1, renderingIntent: 1
    };
    if (r.bool()) return c;
    c.wantICC = r.bool();
    c.colourSpace = r.enum();
    if (c.colourSpace > 3) throw new Error('JPEG XL: invalid color space');
    if (c.wantICC) return c;
    if (c.colourSpace !== CS_XYB) {
        c.whitePoint = r.enum();
        if (c.whitePoint === WP_CUSTOM) c.white = [customXY(r), customXY(r)];
        else if (c.whitePoint !== WP_D65 && c.whitePoint !== WP_E && c.whitePoint !== WP_DCI) throw new Error('JPEG XL: invalid white point');
    }
    if (c.colourSpace !== CS_XYB && c.colourSpace !== CS_GREY) {
        c.primaries = r.enum();
        if (c.primaries === PRI_CUSTOM) for (let i = 0; i < 6; i++) c.primariesXY.push(customXY(r));
        else if (c.primaries !== PRI_SRGB && c.primaries !== PRI_BT2100 && c.primaries !== PRI_P3) throw new Error('JPEG XL: invalid primaries');
    }
    if (r.bool()) {
        c.gamma = r.bits(24) / 1e7;
        c.transfer = -1;
    } else {
        c.transfer = r.enum();
        if (![TF_BT709, TF_UNKNOWN, TF_LINEAR, TF_SRGB, TF_PQ, TF_DCI, TF_HLG].includes(c.transfer)) throw new Error('JPEG XL: invalid transfer function');
    }
    c.renderingIntent = r.enum();
    if (c.renderingIntent > 3) throw new Error('JPEG XL: invalid rendering intent');
    return c;
}

const f16s = (r: BitReader, n: number): number[] => Array.from({ length: n }, () => r.f16());

/** Reads the image header (after the signature ff 0a) */
export function imageHeader(r: BitReader): ImageHeader {
    if (r.bits(16) !== 0xaff) throw new Error('JPEG XL: invalid signature');
    const [width, height] = sizeHeader(r);
    const h: ImageHeader = {
        width, height, orientation: 1, preview: null, animation: null, bitDepth: { float: false, bits: 8, expBits: 0 },
        modular16BitBuffers: true, extraChannels: [], xybEncoded: true,
        colour: { wantICC: false, colourSpace: CS_RGB, whitePoint: WP_D65, white: [], primaries: PRI_SRGB, primariesXY: [], transfer: TF_SRGB, gamma: -1, renderingIntent: 1 },
        toneMapping: { intensityTarget: 255, minNits: 0, relativeToMaxDisplay: false, linearBelow: 0 },
        opsinInverse: [11.031566901960783, -9.866943921568629, -0.16462299647058826, -3.254147380392157, 4.418770392156863, -0.16462299647058826, -3.6588512862745097, 2.7129230470588235, 1.9459282392156863],
        opsinBias: [-0.0037930732552754493, -0.0037930732552754493, -0.0037930732552754493],
        quantBias: [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655],
        quantBiasNumerator: 0.145, up2: UP2, up4: UP4, up8: UP8
    };
    const allDefault = r.bool();
    if (!allDefault) {
        const extraFields = r.bool();
        if (extraFields) {
            h.orientation = 1 + r.bits(3);
            if (r.bool()) sizeHeader(r);
            if (r.bool()) {
                const [w, ph] = previewHeader(r);
                h.preview = { width: w, height: ph };
            }
            if (r.bool()) {
                h.animation = {
                    tpsNumerator: r.u32(100, 1000, [1, 10], [1, 30]), tpsDenominator: r.u32(1, 1001, [1, 8], [1, 10]),
                    numLoops: r.u32(0, [0, 3], [0, 16], [0, 32]), haveTimecodes: r.bool()
                };
            }
        }
        h.bitDepth = bitDepth(r);
        h.modular16BitBuffers = r.bool();
        const numExtra = r.u32(0, 1, [2, 4], [1, 12]);
        if (numExtra > 256) throw new Error('JPEG XL: too many extra channels');
        for (let i = 0; i < numExtra; i++) h.extraChannels.push(extraChannel(r));
        h.xybEncoded = r.bool();
        h.colour = colourEncoding(r);
        if (extraFields && !r.bool()) {
            h.toneMapping = { intensityTarget: r.f16(), minNits: r.f16(), relativeToMaxDisplay: r.bool(), linearBelow: r.f16() };
            const t = h.toneMapping;
            if (t.intensityTarget <= 0 || t.minNits < 0 || t.minNits > t.intensityTarget || t.linearBelow < 0 || (t.relativeToMaxDisplay && t.linearBelow > 1)) {
                throw new Error('JPEG XL: invalid tone mapping');
            }
        }
        extensions(r);
    }
    // CustomTransformData
    if (!r.bool()) {
        if (h.xybEncoded && !r.bool()) {
            h.opsinInverse = f16s(r, 9);
            h.opsinBias = f16s(r, 3);
            h.quantBias = f16s(r, 3);
            h.quantBiasNumerator = r.f16();
        }
        const mask = r.bits(3);
        if (mask & 1) h.up2 = f16s(r, 15);
        if (mask & 2) h.up4 = f16s(r, 55);
        if (mask & 4) h.up8 = f16s(r, 210);
    }
    return h;
}

/** Reads (and skips) the embedded ICC profile's stream */
export function skipICC(r: BitReader): void {
    const size = r.u64();
    if (size > 1 << 28) throw new Error('JPEG XL: ICC profile too large');
    const dec = new EntropyDecoder(r, 41);
    dec.begin(r);
    const kind = (b: number): number => b >= 97 && b <= 122 || b >= 65 && b <= 90 ? 0 : b >= 48 && b <= 57 || b === 46 || b === 44 ? 1 : -1;
    let b1 = 0, b2 = 0;
    for (let i = 0; i < size; i++) {
        let ctx = 0;
        if (i > 128) {
            const k1 = kind(b1), k2 = kind(b2);
            const p1 = k1 >= 0 ? k1 : b1 <= 1 ? 2 + b1 : b1 <= 15 ? 4 : b1 >= 241 && b1 <= 254 ? 5 : b1 === 255 ? 6 : 7;
            const p2 = k2 >= 0 ? k2 : b2 <= 15 ? 2 : b2 >= 241 ? 3 : 4;
            ctx = 1 + p1 + 8 * p2;
        }
        const b = dec.read(r, ctx);
        if (b > 255) throw new Error('JPEG XL: invalid ICC profile');
        b2 = b1;
        b1 = b;
    }
    dec.finish();
}

// the default upsampling weights
const UP2 = [
    -0.01716200, -0.03452303, -0.04022174, -0.02921014, -0.00624645, 0.14111091, 0.28896755, 0.00278718, -0.01610267,
    0.56661550, 0.03777607, -0.01986694, -0.03144731, -0.01185068, -0.00213539
];
const UP4 = [
    -0.02419067, -0.03491987, -0.03693351, -0.03094285, -0.00529785, -0.01663432, -0.03556863, -0.03888905, -0.03516850,
    -0.00989469, 0.23651958, 0.33392945, -0.01073543, -0.01313181, -0.03556694, 0.13048175, 0.40103025, 0.03951150,
    -0.02077584, 0.46914198, -0.00209270, -0.01484589, -0.04064806, 0.18942530, 0.56279892, 0.06674400, -0.02335494,
    -0.03551682, -0.00754830, -0.02267919, -0.02363578, 0.00315804, -0.03399098, -0.01359519, -0.00091653, -0.00335467,
    -0.01163294, -0.01610294, -0.00974088, -0.00191622, -0.01095446, -0.03198464, -0.04455121, -0.02799790, -0.00645912,
    0.06390599, 0.22963888, 0.00630981, -0.01897349, 0.67537268, 0.08483369, -0.02534994, -0.02205197, -0.01667999,
    -0.00384443
];
const UP8 = [
    -0.02928613, -0.03706353, -0.03783812, -0.03324558, -0.00447632, -0.02519406, -0.03752601, -0.03901508, -0.03663285,
    -0.00646649, -0.02066407, -0.03838633, -0.04002101, -0.03900035, -0.00901973, -0.01626393, -0.03954148, -0.04046620,
    -0.03979621, -0.01224485, 0.29895328, 0.35757708, -0.02447552, -0.01081748, -0.04314594, 0.23903219, 0.41119301,
    -0.00573046, -0.01450239, -0.04246845, 0.17567618, 0.45220643, 0.02287757, -0.01936783, -0.03583255, 0.11572472,
    0.47416733, 0.06284440, -0.02685066, 0.42720050, -0.02248939, -0.01155273, -0.04562755, 0.28689496, 0.49093869,
    -0.00007891, -0.01545926, -0.04562659, 0.21238920, 0.53980934, 0.03369474, -0.02070211, -0.03866988, 0.14229550,
    0.56593398, 0.08045181, -0.02888298, -0.03680918, -0.00542229, -0.02920477, -0.02788574, -0.02118180, -0.03942402,
    -0.00775547, -0.02433614, -0.03193943, -0.02030828, -0.04044014, -0.01074016, -0.01930822, -0.03620399, -0.01974125,
    -0.03919545, -0.01456093, -0.00045072, -0.00360110, -0.01020207, -0.01231907, -0.00638988, -0.00071592, -0.00279122,
    -0.00957115, -0.01288327, -0.00730937, -0.00107783, -0.00210156, -0.00890705, -0.01317668, -0.00813895, -0.00153491,
    -0.02128481, -0.04173044, -0.04831487, -0.03293190, -0.00525260, -0.01720322, -0.04052736, -0.05045706, -0.03607317,
    -0.00738030, -0.01341764, -0.03965629, -0.05151616, -0.03814886, -0.01005819, 0.18968273, 0.33063684, -0.01300105,
    -0.01372950, -0.04017465, 0.13727832, 0.36402234, 0.01027890, -0.01832107, -0.03365072, 0.08734506, 0.38194295,
    0.04338228, -0.02525993, 0.56408126, 0.00458352, -0.01648227, -0.04887868, 0.24585519, 0.62026135, 0.04314807,
    -0.02213737, -0.04158014, 0.16637289, 0.65027023, 0.09621636, -0.03101388, -0.04082742, -0.00904519, -0.02790922,
    -0.02117818, 0.00798662, -0.03995711, -0.01243427, -0.02231705, -0.02946266, 0.00992055, -0.03600283, -0.01684920,
    -0.00111684, -0.00411204, -0.01297130, -0.01723725, -0.01022545, -0.00165306, -0.00313110, -0.01218016, -0.01763266,
    -0.01125620, -0.00231663, -0.01374149, -0.03797620, -0.05142937, -0.03117307, -0.00581914, -0.01064003, -0.03608089,
    -0.05272168, -0.03375670, -0.00795586, 0.09628104, 0.27129991, -0.00353779, -0.01734151, -0.03153981, 0.05686230,
    0.28500998, 0.02230594, -0.02374955, 0.68214326, 0.05018048, -0.02320852, -0.04383616, 0.18459474, 0.71517975,
    0.10805613, -0.03263677, -0.03637639, -0.01394373, -0.02511203, -0.01728636, 0.05407331, -0.02867568, -0.01893131,
    -0.00240854, -0.00446511, -0.01636187, -0.02377053, -0.01522848, -0.00333334, -0.00819975, -0.02964169, -0.04499287,
    -0.02745350, -0.00612408, 0.02727416, 0.19446600, 0.00159832, -0.02232473, 0.74982506, 0.11452620, -0.03348048,
    -0.01605681, -0.02070339, -0.00458223
];
