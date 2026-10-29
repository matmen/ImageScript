/*!
 * Decoding JPEG XL frames: their sections (LfGlobal, LF groups, HfGlobal, pass groups), Modular and VarDCT data, the
 * restoration filters, features, upsampling, the color transform, blending and reference frames; the structure of
 * libjxl (lib/jxl/dec_frame.cc, dec_modular.cc, dec_cache.cc, blending.cc, alpha.cc). Copyright (c) the JPEG XL
 * Project Authors, BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */
import { BitReader } from './bits.ts';
import { ImageHeader, EXTRA_ALPHA } from './headers.ts';
import {
    FrameHeader, TOC, frameHeader, toc, passShifts, FRAME_LF, FRAME_REGULAR, FRAME_SKIP_PROGRESSIVE, BLEND_REPLACE, BLEND_ADD,
    BLEND_BLEND, BLEND_MULADD, BLEND_MUL, FLAG_PATCHES, FLAG_SPLINES, FLAG_NOISE, FLAG_USE_LF_FRAME, type EPF
} from './frame-header.ts';
import { ModularImage, Channel, MAConfig, channel, readTree, decodeModular } from './modular.ts';
import { upsample } from './upsample.ts';
import { gaborish, gaborishRows, epf, epfStrip, epfScratch, epfSteps, epfStrips } from './filters.ts';
import { VarDCT, VarDCTGlobal, readVarDCTGlobal, type VarDCTShared } from './vardct.ts';
import { runChunks, shared, sharedOf, type ChunkTask, type Thread } from '../../util/threads.ts';
import { Patch, Splines, readPatches, applyPatches, readSplines, renderSplines, readNoise, renderNoise } from './features.ts';
import { ColorOutput, xybToBytes } from './color.ts';
import { Blending, performBlending, PB_REPLACE, PB_ADD, PB_BLEND_ABOVE, PB_ADD_ABOVE, PB_MUL } from './blend.ts';

/** Float planes: the 3 color channels (or 1), then the extra channels */
export interface Planes {
    width: number;
    height: number;
    channels: Float32Array[];
    /** the colors as interleaved sRGB bytes (RGBA), then the channels are the extra ones (see ColorOutput.transform) */
    rgba?: Uint8Array;
}

/** What frames share: the image header, the references (saved frames) and the LF frames */
export interface DecoderState {
    image: ImageHeader;
    output: ColorOutput;
    /** image sized (or frame sized and in XYB for references saved before the color transform) */
    references: (Planes | null)[];
    referenceIsXYB: boolean[];
    lfFrames: (Planes | null)[];
    /** the frames shown so far, and those not since */
    visible: number;
    invisible: number;
}

/** A decoded frame */
export interface Frame {
    header: FrameHeader;
    /** the canvas after blending (image sized), when the frame is shown */
    canvas: Planes | null;
}

const NUM_QUANT_TABLES = 17;

// the sections of a frame
class Sections {
    private single: BitReader | null = null;

    constructor(private readonly d: Uint8Array, private readonly t: TOC) {
        if (t.offsets.length === 1) this.single = new BitReader(d, t.offsets[0], t.offsets[0] + t.sizes[0]);
    }

    /** the reader of section i (LfGlobal, the LF groups, HfGlobal, then the pass groups) */
    get(i: number): BitReader {
        if (this.single) return this.single;
        const end = this.t.offsets[i] + this.t.sizes[i];
        if (end > this.d.length) throw new Error('JPEG XL: truncated data');
        return new BitReader(this.d, this.t.offsets[i], end);
    }
}

/** The data of the LfGlobal section that later sections use */
interface LfGlobal {
    patches: Patch[] | null;
    splines: Splines | null;
    noise: number[] | null;
    /** the LF dequantization weights (X, Y, B) */
    lfDequant: number[];
    vardct: VarDCTGlobal | null;
    tree: MAConfig | null;
    modular: ModularImage;
}

/** Reads a frame (its header at r) and renders it */
/** Worker threads decoding frames' pass groups (null without them, or once they failed) */
export interface FrameThreads {
    threads: Thread[] | null;
    /** the codestream in shared memory */
    data: Uint8Array | null;
}

// (frames below this many pixels decode faster without threads, which take about 0.1 s to start)
const MIN_THREADED_PIXELS = 1024 * 1024;

/** Decodes a frame (at, read by r), the pass groups in threads if there are and the frame is large enough */
export async function decodeFrame(d: Uint8Array, r: BitReader, state: DecoderState, at: number, pool: FrameThreads): Promise<Frame & { end: number }> {
    const image = state.image;
    const f = frameHeader(r, image);
    const t = toc(r, f);
    const sections = new Sections(d, t);
    // (the index among the visible frames, and the invisible ones since, seed the noise)
    if ((f.isLast || f.duration > 0) && (f.type === FRAME_REGULAR || f.type === FRAME_SKIP_PROGRESSIVE)) {
        state.visible++;
        state.invisible = 0;
    } else state.invisible++;
    const useLfFrame = (f.flags & FLAG_USE_LF_FRAME) !== 0;

    // LfGlobal
    const lf = lfGlobal(sections.get(0), f, image);
    const vardct = lf.vardct ? new VarDCT(f, lf.vardct, lf.lfDequant, image.bitDepth.bits) : null;
    // LF groups
    const lfGroupDim = f.groupDim * 8;
    for (let g = 0; g < f.numLfGroups; g++) {
        const gr = sections.get(1 + g);
        if (vardct && !useLfFrame) vardct.readLfCoefficients(gr, g, lf.tree);
        const x = (g % f.lfGroupsPerRow) * lfGroupDim, y = Math.floor(g / f.lfGroupsPerRow) * lfGroupDim;
        decodeModularGroup(gr, lf, f, x, y, lfGroupDim, 3, 1000, 1 + f.numLfGroups + g);
        vardct?.readHfMetadata(gr, g, lf.tree);
    }
    // HfGlobal
    if (vardct) {
        vardct.readHfGlobal(sections.get(1 + f.numLfGroups), lf.tree);
        const lfFrame = useLfFrame ? state.lfFrames[f.lfLevel] : null;
        if (useLfFrame && !lfFrame) throw new Error('JPEG XL: no LF frame');
        // (in shared memory, for threads)
        const many = pool.threads && f.numGroups > 1 && f.width * f.height >= MIN_THREADED_PIXELS;
        vardct.prepare(image.quantBias, image.quantBiasNumerator, lfFrame ? lfFrame.channels.slice(0, 3) : null,
            many ? [0, 1, 2].map(c => new Float32Array(new SharedArrayBuffer(4 * vardct.stride(c) * (vardct.bh >> vardct.vs[c]) * 8))) : undefined);
    }
    // the pass groups: in threads (the XYB planes and the Modular channels in shared memory), or here
    const coeffs = vardct ? [0, 1, 2].map(() => new Int32Array(f.groupDim * f.groupDim)) : [];
    const local = (g: number): void => decodeGroup(g, f, sections, lf, vardct, coeffs);
    let groupsDone = false;
    if (pool.threads && f.numGroups > 1 && f.width * f.height >= MIN_THREADED_PIXELS) {
        if (!pool.data) pool.data = shared(d);
        const planes = vardct ? vardct.rendered : null;
        for (const c of lf.modular.channels) c.data = shared(c.data);
        const task: GroupTask = {
            task: 'jxl-groups', data: pool.data, at, image, channels: lf.modular.channels, nbMeta: lf.modular.nbMeta,
            vardct: vardct ? vardct.share() : null, planes,
        };
        try {
            await runChunks(pool.threads, task, f.numGroups, local);
            if (vardct && planes) vardct.adopt(vardct.share(), planes);
            groupsDone = true;
        } catch {
            // (threads that fail aren't used again; the planes are rendered again)
            for (const t of pool.threads) t.terminate();
            pool.threads = null;
            if (vardct) vardct.rendered.forEach(p => p.fill(0));
        }
    }
    if (!groupsDone) for (let g = 0; g < f.numGroups; g++) local(g);
    lf.modular.undo();
    let planes = modularToPlanes(lf, f, image);
    let sigma: Float32Array | null = null;
    if (vardct) {
        const xyb = vardct.rendered;
        const color = xyb.map((plane, c) => {
            const hs = vardct.hs[c], vs = vardct.vs[c], w = Math.ceil(f.sampleWidth / (1 << hs)), h = Math.ceil(f.sampleHeight / (1 << vs));
            const out = crop(plane, vardct.stride(c), w, h);
            return hs || vs ? chromaUpsample(out, w, h, f.sampleWidth, f.sampleHeight) : out;
        });
        planes = { ...planes, channels: [...color, ...planes.channels] };
        sigma = vardct.sigma;
    }
    planes = await threaded(pool, planes.width * planes.height, threads => filterThreaded(planes, f, image, sigma, vardct ? vardct.bw : 0, threads), () => filter(planes, f, image, sigma, vardct ? vardct.bw : 0));
    // patches and splines (before upsampling), noise (after)
    const numColor = planes.channels.length - image.extraChannels.length;
    if (lf.patches) applyPatches(planes, numColor, lf.patches, state.references, image.extraChannels);
    const baseX = lf.vardct ? lf.vardct.baseX : 0, baseB = lf.vardct ? lf.vardct.baseB : 1;
    if (lf.splines && numColor === 3) renderSplines(planes, lf.splines, baseX, baseB);
    planes = upsamplePlanes(planes, f, image);
    if (lf.noise && numColor === 3) renderNoise(planes, lf.noise, f.groupDim, state.visible, state.invisible, baseX, baseB);
    const frame = await render(planes, f, state, pool);
    return { ...frame, end: t.end };
}

// decodes pass group g: each pass (VarDCT's coefficients into coeffs, then rendered; the Modular channels' part)
function decodeGroup(g: number, f: FrameHeader, sections: Sections, lf: LfGlobal, vardct: VarDCT | null, coeffs: Int32Array[]): void {
    for (const c of coeffs) c.fill(0);
    for (let p = 0; p < f.numPasses; p++) {
        const [min, max] = passShifts(f, p);
        const gr = sections.get(2 + f.numLfGroups + p * f.numGroups + g);
        vardct?.readPassGroup(gr, p, g, coeffs);
        const x = (g % f.groupsPerRow) * f.groupDim, y = Math.floor(g / f.groupsPerRow) * f.groupDim;
        decodeModularGroup(gr, lf, f, x, y, f.groupDim, min, max, 1 + 3 * f.numLfGroups + NUM_QUANT_TABLES + f.numGroups * p + g);
    }
    vardct?.renderGroup(g, coeffs);
}

/** The pass groups of a frame for threads (see groupChunks) */
export interface GroupTask extends ChunkTask {
    task: 'jxl-groups';
    /** the codestream (shared), the frame's offset */
    data: Uint8Array;
    at: number;
    image: ImageHeader;
    /** the global Modular image's channels (their data shared, the groups' parts set) */
    channels: Channel[];
    nbMeta: number;
    vardct: VarDCTShared | null;
    /** the XYB planes rendered into (shared) */
    planes: Float32Array[] | null;
}

/** In a thread: the decoding of pass groups (the chunks) of a frame, reading its headers and HfGlobal again */
export function groupChunks(task: GroupTask): (g: number) => void {
    const r = new BitReader(task.data, task.at), f = frameHeader(r, task.image), sections = new Sections(task.data, toc(r, f));
    const lf = lfGlobal(sections.get(0), f, task.image, task);
    const vardct = lf.vardct ? new VarDCT(f, lf.vardct, lf.lfDequant, task.image.bitDepth.bits) : null;
    if (vardct) {
        vardct.adopt(task.vardct as VarDCTShared, task.planes as Float32Array[]);
        vardct.readHfGlobal(sections.get(1 + f.numLfGroups), lf.tree);
    }
    const coeffs = vardct ? [0, 1, 2].map(() => new Int32Array(f.groupDim * f.groupDim)) : [];
    return g => decodeGroup(g, f, sections, lf, vardct, coeffs);
}

/** a w x h part of a plane (rows stride apart) */
function crop(src: Float32Array, stride: number, w: number, h: number): Float32Array {
    if (stride === w && src.length === w * h) return src;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) out.set(src.subarray(y * stride, y * stride + w), y * w);
    return out;
}

/** 2x chroma upsampling (to w x h): 3/4 and 1/4 of the nearest samples, edges repeated */
function chromaUpsample(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
    let cur = src, cw = sw;
    if (sw < w) {
        const out = new Float32Array(w * sh);
        for (let y = 0; y < sh; y++) {
            for (let x = 0; x < w; x++) {
                const c = x >> 1, n = x & 1 ? Math.min(c + 1, sw - 1) : Math.max(c - 1, 0);
                out[y * w + x] = 0.75 * cur[y * sw + c] + 0.25 * cur[y * sw + n];
            }
        }
        cur = out;
        cw = w;
    }
    if (sh < h) {
        const out = new Float32Array(cw * h);
        for (let y = 0; y < h; y++) {
            const c = y >> 1, n = y & 1 ? Math.min(c + 1, sh - 1) : Math.max(c - 1, 0);
            for (let x = 0; x < cw; x++) out[y * cw + x] = 0.75 * cur[c * cw + x] + 0.25 * cur[n * cw + x];
        }
        cur = out;
    }
    return cur;
}

// (given the global Modular image's channels, in a thread, without reading them)
function lfGlobal(r: BitReader, f: FrameHeader, image: ImageHeader, given?: { channels: Channel[], nbMeta: number }): LfGlobal {
    const patches = f.flags & FLAG_PATCHES ? readPatches(r, image.extraChannels, f.width, f.height) : null;
    const splines = f.flags & FLAG_SPLINES ? readSplines(r, f.width, f.height) : null;
    const noise = f.flags & FLAG_NOISE ? readNoise(r) : null;
    const lfDequant = r.bool() ? [1 / 32, 1 / 4, 1 / 2] : [r.f16(), r.f16(), r.f16()];
    if (lfDequant.some(v => v / 128 < 1e-8)) throw new Error('JPEG XL: invalid LF dequantization');
    const vardct = f.modular ? null : readVarDCTGlobal(r);
    // the global Modular image (the frame's channels for Modular frames, the extra channels)
    const numExtra = image.extraChannels.length;
    let tree: MAConfig | null = null;
    if (r.bool()) tree = readTree(r, Math.min(1 << 22, 1024 + Math.floor(f.width * f.height * (f.encodedColorChannels + numExtra) / 16)));
    if (given) {
        const modular = new ModularImage(given.channels, image.bitDepth.bits);
        modular.nbMeta = given.nbMeta;
        return { patches, splines, noise, lfDequant, vardct, tree, modular };
    }
    const w = f.sampleWidth, h = f.sampleHeight, list: Channel[] = [];
    if (f.modular) {
        if (f.doYCbCr) {
            // (the channels are Cb, Y, Cr)
            const hs = f.jpegUpsampling.map(u => u === 1 || u === 2), vs = f.jpegUpsampling.map(u => u === 1 || u === 3);
            const anyH = hs.some(Boolean), anyV = vs.some(Boolean);
            for (let c = 0; c < 3; c++) {
                const u = f.jpegUpsampling[c];
                const hshift = anyH && (u === 0 || u === 3) ? 1 : 0, vshift = anyV && (u === 0 || u === 2) ? 1 : 0;
                list.push(channel(Math.ceil(w / (1 << hshift)), Math.ceil(h / (1 << vshift)), hshift, vshift));
            }
        } else for (let c = 0; c < f.encodedColorChannels; c++) list.push(channel(w, h));
    }
    const colorShift = Math.log2(f.upsampling);
    for (const up of f.ecUpsampling) {
        const shift = Math.log2(up) - colorShift;
        list.push(channel(Math.ceil(f.upsampledWidth / up), Math.ceil(f.upsampledHeight / up), shift, shift));
    }
    const modular = new ModularImage(list, image.bitDepth.bits);
    decodeModular(r, modular, 0, tree, f.groupDim, false);
    return { patches, splines, noise, lfDequant, vardct, tree, modular };
}

// decodes the channels of a group (of the global image's channels with shifts min to max), at x, y (size dim)
function decodeModularGroup(r: BitReader, lf: LfGlobal, f: FrameHeader, x0: number, y0: number, dim: number, minShift: number, maxShift: number, stream: number): void {
    const full = lf.modular.channels, nbMeta = lf.modular.nbMeta;
    let c = nbMeta;
    while (c < full.length && full[c].w <= f.groupDim && full[c].h <= f.groupDim) c++;
    const parts: [Channel, number, number][] = [], channels: Channel[] = [];
    for (; c < full.length; c++) {
        const fc = full[c], shift = Math.min(fc.hshift, fc.vshift);
        if (shift > maxShift || shift < minShift) continue;
        const x = x0 >> fc.hshift, y = y0 >> fc.vshift;
        const w = Math.max(0, Math.min(dim >> fc.hshift, fc.w - x)), h = Math.max(0, Math.min(dim >> fc.vshift, fc.h - y));
        if (!w || !h) continue;
        parts.push([fc, x, y]);
        channels.push(channel(w, h, fc.hshift, fc.vshift));
    }
    if (!channels.length) return;
    const gi = new ModularImage(channels, lf.modular.bitDepth);
    decodeModular(r, gi, stream, lf.tree, Infinity, true);
    parts.forEach(([fc, x, y], i) => {
        const g = gi.channels[i];
        for (let row = 0; row < g.h; row++) fc.data.set(g.data.subarray(row * g.w, (row + 1) * g.w), (y + row) * fc.w + x);
    });
}

// a Modular image's channels as floats: [0, 1] for integers, cast for float samples; XYB scaled by the LF dequantization
function modularToPlanes(lf: LfGlobal, f: FrameHeader, image: ImageHeader): Planes {
    const ch = lf.modular.channels.slice(lf.modular.nbMeta);
    const out: Float32Array[] = [];
    const toFloat = (c: Channel, depth = image.bitDepth): Float32Array => {
        const o = new Float32Array(c.w * c.h);
        if (depth.float) for (let i = 0; i < o.length; i++) o[i] = floatSample(c.data[i], depth.bits, depth.expBits);
        else {
            const scale = 1 / (2 ** depth.bits - 1);
            for (let i = 0; i < o.length; i++) o[i] = c.data[i] * scale;
        }
        return o;
    };
    if (!f.modular) {
        // (the extra channels only)
        image.extraChannels.forEach((ec, i) => out.push(toFloat(ch[i], ec.bitDepth)));
        return { width: f.sampleWidth, height: f.sampleHeight, channels: out };
    }
    const numColor = f.encodedColorChannels;
    if (image.xybEncoded) {
        // (Y, X, B with B - Y)
        const [y, x, b] = ch;
        const X = new Float32Array(y.w * y.h), Y = new Float32Array(y.w * y.h), B = new Float32Array(y.w * y.h);
        const mx = lf.lfDequant[0] / 128, my = lf.lfDequant[1] / 128, mb = lf.lfDequant[2] / 128;
        for (let i = 0; i < X.length; i++) {
            X[i] = x.data[i] * mx;
            Y[i] = y.data[i] * my;
            B[i] = (b.data[i] + y.data[i]) * mb;
        }
        out.push(X, Y, B);
    } else for (let c = 0; c < numColor; c++) out.push(toFloat(ch[c]));
    image.extraChannels.forEach((ec, i) => out.push(toFloat(ch[numColor + i], ec.bitDepth)));
    return { width: f.sampleWidth, height: f.sampleHeight, channels: out };
}

/** The restoration filters (sigma: per 8x8 block for VarDCT, blocks sigmaStride per row) */
function filter(p: Planes, f: FrameHeader, image: ImageHeader, sigma: Float32Array | null, sigmaStride = 0): Planes {
    if (!f.gab && !f.epf) return p;
    const numColor = p.channels.length - image.extraChannels.length;
    // (grey as 3 channels)
    let color = numColor === 1 ? [p.channels[0], p.channels[0], p.channels[0]] : p.channels.slice(0, 3);
    if (f.gab) color = gaborish(color, p.width, p.height, f.gab);
    if (f.epf) color = epf(color, p.width, p.height, f.epf, sigma, sigmaStride);
    return { ...p, channels: [...color.slice(0, numColor), ...p.channels.slice(numColor)] };
}

// runs a step in threads, if there are and the frame is large enough, else (or if they fail: then not again) here
async function threaded<T>(pool: FrameThreads, pixels: number, inThreads: (threads: Thread[]) => Promise<T>, here: () => T): Promise<T> {
    if (pool.threads && pixels >= MIN_THREADED_PIXELS) {
        try {
            return await inThreads(pool.threads);
        } catch {
            for (const t of pool.threads) t.terminate();
            pool.threads = null;
        }
    }
    return here();
}

// a typed array in shared memory (itself if it is)
const sharedPlanes = (n: number, w: number, h: number): Float32Array[] => Array.from({ length: n }, () => new Float32Array(new SharedArrayBuffer(4 * w * h)));

/** The rows of the steps after decoding for threads (see postChunks): Gaborish, an EPF pass, XYB to bytes */
export interface PostTask extends ChunkTask {
    task: 'jxl-post';
    kind: 'gaborish' | 'epf' | 'xyb';
    w: number;
    h: number;
    inputs: Float32Array[];
    outputs: Float32Array[];
    weights?: number[];
    epf?: EPF;
    sigma?: Float32Array | null;
    bw?: number;
    step?: number;
    rgba?: Uint8Array;
    m?: number[];
    bias?: number[];
    k?: number;
}

// (the rows of a chunk of Gaborish and the XYB conversion; EPF's are its strips)
const BAND = 64;

/** The steps after decoding (the chunks: bands of rows) */
export function postChunks(t: PostTask): (chunk: number) => void {
    const { w, h, inputs, outputs } = t;
    if (t.kind === 'gaborish') return chunk => gaborishRows(inputs, outputs, w, h, t.weights as number[], chunk * BAND, Math.min(h, (chunk + 1) * BAND));
    if (t.kind === 'epf') {
        const scratch = epfScratch(w);
        return chunk => epfStrip(inputs, outputs, w, h, t.epf as EPF, t.sigma ?? null, t.bw as number, t.step as number, chunk, scratch);
    }
    const [x, y, b] = inputs;
    return chunk => xybToBytes(x, y, b, t.m as number[], t.bias as number[], t.k as number, t.rgba as Uint8Array, chunk * BAND * w, Math.min(h, (chunk + 1) * BAND) * w);
}

/** filter, Gaborish and EPF in threads */
async function filterThreaded(p: Planes, f: FrameHeader, image: ImageHeader, sigma: Float32Array | null, sigmaStride: number, threads: Thread[]): Promise<Planes> {
    if (!f.gab && !f.epf) return p;
    const numColor = p.channels.length - image.extraChannels.length, w = p.width, h = p.height;
    let color = (numColor === 1 ? [p.channels[0], p.channels[0], p.channels[0]] : p.channels.slice(0, 3)).map(sharedOf);
    if (f.gab) {
        const task: PostTask = { task: 'jxl-post', kind: 'gaborish', w, h, inputs: color, outputs: sharedPlanes(3, w, h), weights: f.gab };
        await runChunks(threads, task, Math.ceil(h / BAND), postChunks(task));
        color = task.outputs;
    }
    if (f.epf) {
        const s = sigma && sharedOf(sigma);
        for (const step of epfSteps(f.epf)) {
            const task: PostTask = { task: 'jxl-post', kind: 'epf', w, h, inputs: color, outputs: sharedPlanes(3, w, h), epf: f.epf, sigma: s, bw: sigmaStride, step };
            await runChunks(threads, task, epfStrips(h), postChunks(task));
            color = task.outputs;
        }
    }
    return { ...p, channels: [...color.slice(0, numColor), ...p.channels.slice(numColor)] };
}

/** Upsamples the color channels and the extra channels to the frame's size */
function upsamplePlanes(p: Planes, f: FrameHeader, image: ImageHeader): Planes {
    const numColor = p.channels.length - image.extraChannels.length, W = f.upsampledWidth, H = f.upsampledHeight;
    const channels = p.channels.map((c, i) => {
        const up = i < numColor ? f.upsampling : f.ecUpsampling[i - numColor];
        return up === 1 ? c : upsample(c, Math.ceil(W / up), Math.ceil(H / up), up, image, W, H);
    });
    return { width: W, height: H, channels };
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

/** A float sample of bits bits (expBits of them the exponent) */
function floatSample(v: number, bits: number, expBits: number): number {
    if (bits === 32) {
        u32[0] = v;
        return f32[0];
    }
    const mantissaBits = bits - expBits - 1, sign = (v >>> (bits - 1)) & 1;
    const mantissa = v & ((1 << mantissaBits) - 1), exp = (v >>> mantissaBits) & ((1 << expBits) - 1), bias = (1 << (expBits - 1)) - 1;
    let value: number;
    if (exp === 0) value = mantissa / 2 ** mantissaBits * 2 ** (1 - bias);
    else if (exp === (1 << expBits) - 1) value = mantissa ? NaN : Infinity;
    else value = (1 + mantissa / 2 ** mantissaBits) * 2 ** (exp - bias);
    return sign ? -value : value;
}

// ---- rendering: filters, features, upsampling, the color transform, blending, references

// what follows the features: storing LF frames and references, the color transform, blending
async function render(p: Planes, f: FrameHeader, state: DecoderState, pool: FrameThreads): Promise<Frame> {
    const image = state.image;
    let planes = p;
    if (f.type === FRAME_LF) {
        state.lfFrames[f.lfLevel - 1] = planes;
        return { header: f, canvas: null };
    }
    const canReference = !f.isLast && (f.duration === 0 || f.saveAsReference !== 0) && f.type !== FRAME_LF;
    if (canReference && f.saveBeforeCT) {
        state.references[f.saveAsReference] = planes;
        state.referenceIsXYB[f.saveAsReference] = image.xybEncoded;
    }
    const normal = f.type === FRAME_REGULAR || f.type === FRAME_SKIP_PROGRESSIVE;
    // (only toRGBA uses the planes of a frame shown as it is: replacing all, not referenced; with straight alpha only)
    const replaces = !f.haveCrop && f.blending.mode === BLEND_REPLACE && f.ecBlending.every(b => b.mode === BLEND_REPLACE) && p.width === image.width && p.height === image.height;
    const final = normal && replaces && !canReference && image.extraChannels.every(e => e.type === EXTRA_ALPHA && !e.alphaAssociated);
    // (XYB to bytes in threads)
    const bytes = state.output.bytesParams(f.doYCbCr, final), input = planes;
    planes = bytes ? await threaded(pool, planes.width * planes.height, async threads => {
        const { width: w, height: h, channels } = input, rgba = new Uint8Array(new SharedArrayBuffer(4 * w * h));
        const task: PostTask = { task: 'jxl-post', kind: 'xyb', w, h, inputs: channels.slice(0, 3).map(sharedOf), outputs: [], rgba, ...bytes };
        await runChunks(threads, task, Math.ceil(h / BAND), postChunks(task));
        // (the pixels not in shared memory: APIs like crypto.subtle and TextDecoder reject views of it)
        return { width: w, height: h, channels: channels.slice(3), rgba: new Uint8Array(rgba) };
    }, () => state.output.transform(input, f.doYCbCr, final)) : state.output.transform(planes, f.doYCbCr, final);
    const canvas = normal ? blend(planes, f, state) : planes;
    if (canReference && !f.saveBeforeCT) {
        state.references[f.saveAsReference] = canvas;
        state.referenceIsXYB[f.saveAsReference] = false;
    }
    return { header: f, canvas: normal ? canvas : null };
}

// a frame's blending mode as one of performBlending's
const PB_MODES: number[] = [];
PB_MODES[BLEND_REPLACE] = PB_REPLACE;
PB_MODES[BLEND_ADD] = PB_ADD;
PB_MODES[BLEND_BLEND] = PB_BLEND_ABOVE;
PB_MODES[BLEND_MULADD] = PB_ADD_ABOVE;
PB_MODES[BLEND_MUL] = PB_MUL;
const blending = (b: FrameHeader['blending']): Blending => ({ mode: PB_MODES[b.mode], alpha: b.alphaChannel, clamp: b.clamp });

// blends a frame onto its sources (references), giving the image sized canvas
function blend(p: Planes, f: FrameHeader, state: DecoderState): Planes {
    const image = state.image, W = image.width, H = image.height, numExtra = image.extraChannels.length;
    const n = p.channels.length, numColor = n - numExtra;
    const fullReplace = !f.haveCrop && f.blending.mode === BLEND_REPLACE && f.ecBlending.every(b => b.mode === BLEND_REPLACE);
    if (fullReplace && p.width === W && p.height === H) return p;
    const source = (c: number): Planes | null => state.references[c < numColor ? f.blending.source : f.ecBlending[c - numColor].source];
    for (let c = 0; c < n; c++) if (state.referenceIsXYB[c < numColor ? f.blending.source : f.ecBlending[c - numColor].source] && source(c)) throw new Error('JPEG XL: blending onto an XYB reference');
    // the background: the sources
    const out: Float32Array[] = [];
    for (let c = 0; c < n; c++) {
        const bg = source(c), o = new Float32Array(W * H);
        if (bg) {
            if (bg.width < W || bg.height < H) throw new Error('JPEG XL: blending onto a cropped reference');
            const plane = bg.channels[c] ?? bg.channels[0];
            for (let y = 0; y < H; y++) o.set(plane.subarray(y * bg.width, y * bg.width + W), y * W);
        }
        out.push(o);
    }
    // the overlap of the frame and the image
    const x0 = Math.max(f.x0, 0), y0 = Math.max(f.y0, 0), x1 = Math.min(f.x0 + p.width, W), y1 = Math.min(f.y0 + p.height, H);
    if (x1 <= x0 || y1 <= y0) return { width: W, height: H, channels: out };
    const color = blending(f.blending), ec = f.ecBlending.map(blending);
    for (let y = y0; y < y1; y++) {
        const i = y * W + x0, j = (y - f.y0) * p.width + (x0 - f.x0);
        performBlending(out, i, p.channels, j, out, i, x1 - x0, numColor, color, ec, image.extraChannels);
    }
    return { width: W, height: H, channels: out };
}
