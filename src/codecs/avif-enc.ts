/*!
 * Encodes AVIFs: the image as an AV1 still picture (YUV of BT.601's matrix, full range, like avifenc's defaults; RGB
 * if lossless, monochrome if gray), transparency as a monochrome auxiliary image, in a HEIF container with the boxes
 * libavif writes. The quality maps to the quantizer like avifenc's, with libaom's quantizer_to_qindex (Copyright (c)
 * 2016, Alliance for Open Media, BSD-2-Clause License, see THIRD_PARTY_NOTICES.md)
 */
import { encodeAV1 } from './av1/encode.ts';

/** Options of the AVIF encoder */
export interface AVIFOptions {
    /** 0-100 (like avifenc's -q; 100: lossless) */
    quality: number;
    /** of the alpha channel, 0-100 (100: lossless) */
    alphaQuality: number;
    /** 4:4:4 or 4:2:0 chroma */
    subsampling: '4:4:4' | '4:2:0';
    /** how hard to search for the best modes, 0-2 */
    effort: number;
}

// libaom's quantizer_to_qindex (avifenc's quality: (100 - quality) * 63 / 100, rounded)
const QINDEX = [
    0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84, 88, 92, 96, 100, 104, 108, 112,
    116, 120, 124, 128, 132, 136, 140, 144, 148, 152, 156, 160, 164, 168, 172, 176, 180, 184, 188, 192, 196, 200, 204, 208,
    212, 216, 220, 224, 228, 232, 236, 240, 244, 249, 255
];
const qindex = (quality: number): number => QINDEX[Math.round((100 - Math.max(0, Math.min(100, quality))) * 63 / 100)];

// BT.601 full range (the color description: BT.709 primaries, sRGB transfer, BT.601 matrix)
const KR = 0.299, KB = 0.114, KG = 1 - KR - KB, CICP = [1, 13, 6];

function toYUV(rgba: Uint8Array, width: number, height: number, subsampled: boolean): Uint8Array[] {
    const n = width * height, y = new Uint8Array(n);
    const u = new Float64Array(n), v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2];
        const l = KR * r + KG * g + KB * b;
        y[i] = Math.round(l);
        u[i] = (b - l) / (2 * (1 - KB)) + 128;
        v[i] = (r - l) / (2 * (1 - KR)) + 128;
    }
    const byte = (x: number): number => x < 0 ? 0 : x > 255 ? 255 : Math.round(x);
    if (!subsampled) {
        const cu = new Uint8Array(n), cv = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            cu[i] = byte(u[i]);
            cv[i] = byte(v[i]);
        }
        return [y, cu, cv];
    }
    // (the average of each 2x2 block)
    const cw = width + 1 >> 1, ch = height + 1 >> 1, cu = new Uint8Array(cw * ch), cv = new Uint8Array(cw * ch);
    for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
            let su = 0, sv = 0, k = 0;
            for (let dy = 0; dy < 2 && 2 * cy + dy < height; dy++) {
                for (let dx = 0; dx < 2 && 2 * cx + dx < width; dx++, k++) {
                    const i = (2 * cy + dy) * width + 2 * cx + dx;
                    su += u[i];
                    sv += v[i];
                }
            }
            cu[cy * cw + cx] = byte(su / k);
            cv[cy * cw + cx] = byte(sv / k);
        }
    }
    return [y, cu, cv];
}

// the colors of fully transparent pixels from the others: averages over ever larger squares (pull), each
// transparent pixel taking its square's (push), then smoothed
function fillTransparent(rgba: Uint8Array, width: number, height: number): Uint8Array {
    const out = rgba.slice();
    // the levels' sums of colors and counts of known pixels
    const levels: Array<{ w: number, h: number, sum: Float64Array, n: Float64Array }> = [];
    let w = width, h = height, sum = new Float64Array(w * h * 3), n = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) {
        if (!rgba[4 * i + 3]) continue;
        n[i] = 1;
        for (let c = 0; c < 3; c++) sum[3 * i + c] = rgba[4 * i + c];
    }
    levels.push({ w, h, sum, n });
    while (w > 1 || h > 1) {
        const pw = w + 1 >> 1, ph = h + 1 >> 1, ps = new Float64Array(pw * ph * 3), pn = new Float64Array(pw * ph);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x, j = (y >> 1) * pw + (x >> 1);
                pn[j] += n[i];
                for (let c = 0; c < 3; c++) ps[3 * j + c] += sum[3 * i + c];
            }
        }
        levels.push({ w: w = pw, h: h = ph, sum: sum = ps, n: n = pn });
    }
    // (the colors of each level: the known average, or the coarser level's)
    let colors = new Float64Array(3);
    for (let c = 0; c < 3; c++) colors[c] = n[0] ? sum[c] / n[0] : 0;
    for (let l = levels.length - 2; l >= 0; l--) {
        const { w, h, sum, n } = levels[l], pw = levels[l + 1].w, next = new Float64Array(w * h * 3);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x, j = (y >> 1) * pw + (x >> 1);
                for (let c = 0; c < 3; c++) next[3 * i + c] = n[i] ? sum[3 * i + c] / n[i] : colors[3 * j + c];
            }
        }
        colors = next;
    }
    // (the transparent pixels smoothed: a few passes of averaging with their neighbours)
    const unknown: number[] = [];
    for (let i = 0; i < width * height; i++) if (!rgba[4 * i + 3]) unknown.push(i);
    for (let pass = 0; pass < 4; pass++) {
        for (const i of unknown) {
            const x = i % width, y = (i - x) / width;
            for (let c = 0; c < 3; c++) {
                let s = colors[3 * i + c], k = 1;
                if (x) { s += colors[3 * (i - 1) + c]; k++; }
                if (x + 1 < width) { s += colors[3 * (i + 1) + c]; k++; }
                if (y) { s += colors[3 * (i - width) + c]; k++; }
                if (y + 1 < height) { s += colors[3 * (i + width) + c]; k++; }
                colors[3 * i + c] = s / k;
            }
        }
    }
    for (const i of unknown) for (let c = 0; c < 3; c++) out[4 * i + c] = Math.round(colors[3 * i + c]);
    return out;
}

// ---- boxes

const ascii = (s: string): number[] => Array.from(s, c => c.charCodeAt(0));
const u16 = (v: number): number[] => [v >> 8 & 255, v & 255];
const u32 = (v: number): number[] => [v >>> 24, v >> 16 & 255, v >> 8 & 255, v & 255];
const box = (type: string, ...content: number[][]): number[] => {
    const body = content.flat();
    return [...u32(8 + body.length), ...ascii(type), ...body];
};
const fullBox = (type: string, version: number, flags: number, ...content: number[][]): number[] => box(type, [version, flags >> 16 & 255, flags >> 8 & 255, flags & 255], ...content);

// av1C: the AV1 codec configuration, with the sequence header OBU
function av1C(data: Uint8Array): number[] {
    // (the sequence header OBU: its size, profile, level, color config)
    let size = 0, i = 1, shift = 0;
    for (; ; i++) {
        size += (data[i] & 0x7f) << shift;
        shift += 7;
        if (!(data[i] & 0x80)) break;
    }
    const seqObu = Array.from(data.subarray(0, i + 1 + size));
    // (profile, still picture, reduced header, level)
    const profile = data[i + 1] >> 5, level = (data[i + 1] & 7) << 2 | data[i + 2] >> 6;
    const monochrome = profile !== 1 && seqMonochrome(data, i + 1);
    // (tier 0, 8 bits, monochrome, subsampled horizontally and vertically: profile 0)
    return box('av1C', [0x81, profile << 5 | level, (monochrome ? 0x10 : 0) | (profile === 1 ? 0 : 0x0c), 0], seqObu);
}

// whether a reduced still picture sequence header (at o) is monochrome: the bit after the size fields and tool flags
function seqMonochrome(d: Uint8Array, o: number): boolean {
    let bit = o * 8;
    const read = (n: number): number => {
        let v = 0;
        for (let k = 0; k < n; k++, bit++) v = v * 2 + (d[bit >> 3] >> (7 - (bit & 7)) & 1);
        return v;
    };
    read(3 + 1 + 1 + 5);
    const wb = read(4) + 1, hb = read(4) + 1;
    read(wb + hb + 6);
    read(1); // high bitdepth
    return !!read(1);
}

/** Encodes RGBA pixels as an AVIF (with an alpha image if the image has transparency) */
export function encode(rgba: Uint8Array, width: number, height: number, { quality, alphaQuality, subsampling, effort }: AVIFOptions): Uint8Array {
    if (width < 1 || height < 1) throw new RangeError('AVIF: dimensions must be at least 1');
    if (width > 65536 || height > 65536) throw new RangeError('AVIF: dimensions must be at most 65536');
    let opaque = true;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
    // (lossy: the colors of transparent pixels don't matter, the cheapest are smooth ones)
    const original = rgba;
    if (!opaque && qindex(quality)) rgba = fillTransparent(rgba, width, height);
    // (gray: the luma alone, monochrome)
    let gray = true;
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) { gray = false; break; }
    // (lossless: RGB as GBR with the identity matrix, 4:4:4)
    const lossless = !qindex(quality) && !gray, subsampled = subsampling === '4:2:0' && !lossless && !gray;
    const cicp = lossless ? [1, 13, 0] : CICP;
    const planes = gray ? [Uint8Array.from({ length: width * height }, (_, i) => rgba[4 * i])]
        : lossless ? [1, 2, 0].map(c => Uint8Array.from({ length: width * height }, (_, i) => rgba[4 * i + c])) : toYUV(rgba, width, height, subsampled);
    const color = encodeAV1({ planes, width, height, layout: gray ? 0 : subsampled ? 1 : 3, cicp }, { qidx: qindex(quality), effort });
    let alpha: Uint8Array | null = null;
    if (!opaque) {
        const a = new Uint8Array(width * height);
        for (let i = 0; i < a.length; i++) a[i] = original[4 * i + 3];
        alpha = encodeAV1({ planes: [a], width, height, layout: 0, cicp: [2, 2, 2] }, { qidx: qindex(alphaQuality), effort });
    }

    // the boxes: ftyp, meta (the items, their locations in mdat, their properties), mdat
    const profile = subsampled || gray ? 'MA1B' : 'MA1A';
    const ftyp = box('ftyp', ascii('avif'), u32(0), ascii('avif'), ascii('mif1'), ascii('miaf'), ascii(profile));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('pict'), u32(0), u32(0), u32(0), ascii('ImageScript'), [0]);
    const pitm = fullBox('pitm', 0, 0, u16(1));
    const infe = (id: number, name: string): number[] => fullBox('infe', 2, 0, u16(id), u16(0), ascii('av01'), ascii(name), [0]);
    const iinf = fullBox('iinf', 0, 0, u16(alpha ? 2 : 1), infe(1, 'Color'), alpha ? infe(2, 'Alpha') : []);
    const iref = alpha ? fullBox('iref', 0, 0, box('auxl', u16(2), u16(1), u16(1))) : [];
    const ispe = fullBox('ispe', 0, 0, u32(width), u32(height));
    const colr = box('colr', ascii('nclx'), u16(cicp[0]), u16(cicp[1]), u16(cicp[2]), [0x80]);
    const pixi = (channels: number): number[] => fullBox('pixi', 0, 0, [channels], new Array<number>(channels).fill(8));
    const auxC = fullBox('auxC', 0, 0, ascii('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha'), [0]);
    // (properties 1-based: ispe, av1C, colr, pixi; alpha: av1C, pixi, auxC)
    const ipco = box('ipco', ispe, av1C(color), colr, pixi(gray ? 1 : 3), alpha ? av1C(alpha) : [], alpha ? pixi(1) : [], alpha ? auxC : []);
    const ipma = fullBox('ipma', 0, 0, u32(alpha ? 2 : 1), u16(1), [4, 1, 0x82, 3, 4], alpha ? [...u16(2), 4, 1, 0x85, 6, 7] : []);
    const iprp = box('iprp', ipco, ipma);
    // the locations (absolute offsets into mdat, filled in once the size of meta is known)
    const ilocFor = (offset: number): number[] => fullBox('iloc', 0, 0, [0x44, 0x00], u16(alpha ? 2 : 1),
        u16(1), u16(0), u16(1), u32(offset), u32(color.length),
        alpha ? [...u16(2), ...u16(0), ...u16(1), ...u32(offset + color.length), ...u32(alpha.length)] : []);
    const metaFor = (offset: number): number[] => fullBox('meta', 0, 0, hdlr, pitm, ilocFor(offset), iinf, iref, iprp);
    const headerSize = ftyp.length + metaFor(0).length + 8;
    const head = [...ftyp, ...metaFor(headerSize)];
    const mdatSize = 8 + color.length + (alpha ? alpha.length : 0);
    const out = new Uint8Array(head.length + mdatSize);
    out.set(head);
    out.set([...u32(mdatSize), ...ascii('mdat')], head.length);
    out.set(color, head.length + 8);
    if (alpha) out.set(alpha, head.length + 8 + color.length);
    return out;
}
