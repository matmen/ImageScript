/*!
 * JPEG XL frame headers and tables of contents, ported from jxl-oxide (crates/jxl-frame/src/header.rs, filter.rs,
 * data/toc.rs). Copyright (c) Wonwoo Choi, MIT License (see THIRD_PARTY_NOTICES.md)
 */
import { BitReader, extensions, unpackSigned } from './bits.ts';
import { EntropyDecoder, readPermutation } from './entropy.ts';
import { ImageHeader } from './headers.ts';

export const FRAME_REGULAR = 0, FRAME_LF = 1, FRAME_REFERENCE = 2, FRAME_SKIP_PROGRESSIVE = 3;
export const BLEND_REPLACE = 0, BLEND_ADD = 1, BLEND_BLEND = 2, BLEND_MULADD = 3, BLEND_MUL = 4;
export const FLAG_NOISE = 1, FLAG_PATCHES = 2, FLAG_SPLINES = 16, FLAG_USE_LF_FRAME = 32, FLAG_SKIP_ADAPTIVE_LF_SMOOTHING = 128;

export interface BlendingInfo {
    mode: number;
    alphaChannel: number;
    clamp: boolean;
    source: number;
}

export interface EPF {
    iters: number;
    sharpLut: number[];
    channelScale: number[];
    quantMul: number;
    pass0SigmaScale: number;
    pass2SigmaScale: number;
    borderSadMul: number;
    sigmaForModular: number;
}

export interface FrameHeader {
    type: number;
    modular: boolean;
    flags: number;
    doYCbCr: boolean;
    encodedColorChannels: number;
    jpegUpsampling: number[];
    upsampling: number;
    ecUpsampling: number[];
    groupSizeShift: number;
    xqmScale: number;
    bqmScale: number;
    numPasses: number;
    passShift: number[];
    downsample: number[];
    lastPass: number[];
    lfLevel: number;
    haveCrop: boolean;
    x0: number;
    y0: number;
    width: number;
    height: number;
    blending: BlendingInfo;
    ecBlending: BlendingInfo[];
    duration: number;
    isLast: boolean;
    saveAsReference: number;
    resetsCanvas: boolean;
    saveBeforeCT: boolean;
    /** Gaborish weights (per channel: the side and the corner one), or null */
    gab: number[] | null;
    epf: EPF | null;
    // derived
    /** the size of the frame upsampled (of the LF for LF frames) */
    upsampledWidth: number;
    upsampledHeight: number;
    /** the size of the color samples (before upsampling) */
    sampleWidth: number;
    sampleHeight: number;
    groupDim: number;
    groupsPerRow: number;
    numGroups: number;
    lfGroupsPerRow: number;
    numLfGroups: number;
}

const DEFAULT_EPF = (): EPF => ({
    iters: 2, sharpLut: [0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 1], channelScale: [40, 5, 3.5],
    quantMul: 0.46, pass0SigmaScale: 0.9, pass2SigmaScale: 6.5, borderSadMul: 2 / 3, sigmaForModular: 1
});

const DEFAULT_GAB = [0.115169525, 0.061248592, 0.115169525, 0.061248592, 0.115169525, 0.061248592];

function blendingInfo(r: BitReader, haveExtra: boolean, resets: (mode: number) => boolean, mainMode = -1): BlendingInfo {
    const mode = r.u32(0, 1, 2, [3, 2]);
    if (mode > 4) throw new Error('JPEG XL: invalid blend mode');
    const usesAlpha = haveExtra && (mode === BLEND_BLEND || mode === BLEND_MULADD);
    const alphaChannel = usesAlpha ? r.u32(0, 1, 2, [3, 3]) : 0;
    const clamp = usesAlpha || mode === BLEND_MUL ? r.bool() : false;
    const source = resets(mainMode >= 0 ? mainMode : mode) ? 0 : r.bits(2);
    return { mode, alphaChannel, clamp, source };
}

function epf(r: BitReader, modular: boolean): EPF | null {
    const iters = r.bits(2);
    if (!iters) return null;
    const e = DEFAULT_EPF();
    e.iters = iters;
    if (!modular && r.bool()) e.sharpLut = Array.from({ length: 8 }, () => r.f16());
    if (r.bool()) {
        e.channelScale = [r.f16(), r.f16(), r.f16()];
        r.bits(32);
    }
    if (r.bool()) {
        if (!modular) e.quantMul = r.f16();
        e.pass0SigmaScale = r.f16();
        e.pass2SigmaScale = r.f16();
        e.borderSadMul = r.f16();
    }
    if (modular) e.sigmaForModular = r.f16();
    return e;
}

export function frameHeader(r: BitReader, image: ImageHeader): FrameHeader {
    const numExtra = image.extraChannels.length;
    const allDefault = r.bool();
    const type = allDefault ? FRAME_REGULAR : r.bits(2);
    const modular = allDefault ? false : r.bool();
    const flags = allDefault ? 0 : r.u64();
    const doYCbCr = !allDefault && !image.xybEncoded ? r.bool() : false;
    const useLfFrame = (flags & FLAG_USE_LF_FRAME) !== 0;
    const grey = image.colour.colourSpace === 1;
    const encodedColorChannels = modular && !doYCbCr && !image.xybEncoded && grey ? 1 : 3;
    const jpegUpsampling = doYCbCr && !useLfFrame ? [r.bits(2), r.bits(2), r.bits(2)] : [0, 0, 0];
    // (the extra channels' upsampling includes their dim_shift, like libjxl's)
    let upsampling = 1, ecUpsampling = image.extraChannels.map(e => 1 << e.dimShift);
    if (!allDefault && !useLfFrame) {
        upsampling = r.u32(1, 2, 4, 8);
        ecUpsampling = image.extraChannels.map(e => r.u32(1, 2, 4, 8) << e.dimShift);
    }
    const groupSizeShift = modular ? r.bits(2) : 1;
    let xqmScale = image.xybEncoded && !modular ? 3 : 2, bqmScale = 2;
    if (!allDefault && image.xybEncoded && !modular) {
        xqmScale = r.bits(3);
        bqmScale = r.bits(3);
    }
    let numPasses = 1, passShift: number[] = [];
    const downsample: number[] = [], lastPass: number[] = [];
    if (!allDefault && type !== FRAME_REFERENCE) {
        numPasses = r.u32(1, 2, 3, [4, 3]);
        if (numPasses !== 1) {
            const numDs = r.u32(0, 1, 2, [3, 1]);
            if (numDs >= numPasses) throw new Error('JPEG XL: invalid passes');
            for (let i = 0; i < numPasses - 1; i++) passShift.push(r.bits(2));
            for (let i = 0; i < numDs; i++) downsample.push(r.u32(1, 2, 4, 8));
            for (let i = 0; i < numDs; i++) lastPass.push(r.u32(0, 1, 2, [0, 3]));
        } else passShift = [];
    }
    if (passShift.length < numPasses - 1) passShift = new Array<number>(numPasses - 1).fill(0);
    const lfLevel = type === FRAME_LF ? 1 + r.bits(2) : 0;
    const haveCrop = !allDefault && type !== FRAME_LF ? r.bool() : false;
    let x0 = 0, y0 = 0, width = image.width, height = image.height;
    if (haveCrop) {
        const d: [[number, number], [number, number], [number, number], [number, number]] = [[0, 8], [256, 11], [2304, 14], [18688, 30]];
        if (type !== FRAME_REFERENCE) {
            x0 = unpackSigned(r.u32(...d));
            y0 = unpackSigned(r.u32(...d));
        }
        width = r.u32(...d);
        height = r.u32(...d);
    }
    const resets = (mode: number): boolean => mode === BLEND_REPLACE && (!haveCrop || (x0 <= 0 && y0 <= 0 && x0 + width >= image.width && y0 + height >= image.height));
    const normal = type === FRAME_REGULAR || type === FRAME_SKIP_PROGRESSIVE;
    let blending: BlendingInfo = { mode: BLEND_REPLACE, alphaChannel: 0, clamp: false, source: 0 };
    const ecBlending: BlendingInfo[] = [];
    if (!allDefault && normal) {
        blending = blendingInfo(r, numExtra > 0, resets);
        for (let i = 0; i < numExtra; i++) ecBlending.push(blendingInfo(r, true, resets, blending.mode));
    } else for (let i = 0; i < numExtra; i++) ecBlending.push({ ...blending });
    let duration = 0, isLast = type === FRAME_REGULAR, saveAsReference = 0;
    if (!allDefault && normal) {
        if (image.animation) {
            duration = r.u32(0, 1, [0, 8], [0, 32]);
            if (image.animation.haveTimecodes) r.bits(32);
        }
        isLast = r.bool();
    }
    if (!allDefault && type !== FRAME_LF && !isLast) saveAsReference = r.bits(2);
    const resetsCanvas = resets(blending.mode);
    let saveBeforeCT = !normal;
    if (!allDefault && (type === FRAME_REFERENCE || (resetsCanvas && !isLast && (duration === 0 || saveAsReference !== 0) && type !== FRAME_LF))) saveBeforeCT = r.bool();
    let gab: number[] | null = DEFAULT_GAB, filter: EPF | null = DEFAULT_EPF();
    if (!allDefault) {
        // name
        r.skipBits(8 * r.u32(0, [0, 4], [16, 5], [48, 10]));
        if (!r.bool()) {
            gab = null;
            if (r.bool()) {
                gab = r.bool() ? Array.from({ length: 6 }, () => r.f16()) : DEFAULT_GAB;
                for (let c = 0; c < 3; c++) if (Math.abs(1 + 4 * (gab[2 * c] + gab[2 * c + 1])) < 1.1920929e-7) throw new Error('JPEG XL: invalid Gaborish weights');
            }
            filter = epf(r, modular);
            extensions(r);
        }
        extensions(r);
    }
    if (ecUpsampling.some(u => u < upsampling || u > 8)) throw new Error('JPEG XL: invalid extra channel upsampling');

    const upsampledWidth = Math.ceil(width / 8 ** lfLevel), upsampledHeight = Math.ceil(height / 8 ** lfLevel);
    const sampleWidth = Math.ceil(upsampledWidth / upsampling), sampleHeight = Math.ceil(upsampledHeight / upsampling);
    const groupDim = 128 << groupSizeShift, groupsPerRow = Math.ceil(sampleWidth / groupDim), lfGroupsPerRow = Math.ceil(sampleWidth / (groupDim * 8));
    return {
        type, modular, flags, doYCbCr, encodedColorChannels, jpegUpsampling, upsampling, ecUpsampling, groupSizeShift, xqmScale, bqmScale,
        numPasses, passShift, downsample, lastPass, lfLevel, haveCrop, x0, y0, width, height, blending, ecBlending, duration, isLast,
        saveAsReference, resetsCanvas, saveBeforeCT, gab, epf: filter, upsampledWidth, upsampledHeight, sampleWidth, sampleHeight, groupDim, groupsPerRow,
        numGroups: groupsPerRow * Math.ceil(sampleHeight / groupDim), lfGroupsPerRow, numLfGroups: lfGroupsPerRow * Math.ceil(sampleHeight / (groupDim * 8))
    };
}

/** The shifts of the channels each pass has (GetDownsamplingBracket): [min, max] */
export function passShifts(f: FrameHeader, pass: number): [number, number] {
    let max = 2, min = 3;
    for (let i = 0; ; i++) {
        for (let j = 0; j < f.downsample.length; j++) {
            if (i === f.lastPass[j]) min = [0, 0, 1, 0, 2, 0, 0, 0, 3][f.downsample[j]];
        }
        if (i === f.numPasses - 1) min = 0;
        if (i === pass) return [min, max];
        max = min - 1;
    }
}

/** The sections of a frame: their offsets (in the codestream) and sizes, in the order LfGlobal, LfGroups, HfGlobal, groups by pass */
export interface TOC {
    offsets: number[];
    sizes: number[];
    /** the byte after the frame */
    end: number;
}

export function toc(r: BitReader, f: FrameHeader): TOC {
    const single = f.numGroups === 1 && f.numPasses === 1;
    const count = single ? 1 : 1 + f.numLfGroups + 1 + f.numGroups * f.numPasses;
    if (count > 65536) throw new Error('JPEG XL: too many sections');
    let permutation: number[] | null = null;
    if (r.bool()) {
        const dec = new EntropyDecoder(r, 8);
        dec.begin(r);
        permutation = readPermutation(r, dec, count, 0);
        dec.finish();
    }
    r.zeroPadToByte();
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) sizes.push(r.u32([0, 10], [1024, 14], [17408, 22], [4211712, 30]));
    r.zeroPadToByte();
    const offsets: number[] = [];
    let at = r.bytePosition;
    for (const size of sizes) {
        offsets.push(at);
        at += size;
    }
    if (permutation) {
        const p = permutation;
        return { offsets: p.map(i => offsets[i]), sizes: p.map(i => sizes[i]), end: at };
    }
    return { offsets, sizes, end: at };
}
