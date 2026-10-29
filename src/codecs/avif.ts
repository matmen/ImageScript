/*!
 * AVIF (AV1 images in HEIF containers, https://aomediacodec.github.io/av1-avif/): the primary item (an AV1 image or a
 * grid of them), its alpha, crop, rotation and mirroring, or the first frame of an image sequence; converted to RGB like
 * libavif converts (its reference path, src/reformat.c, with bilinear chroma upsampling; src/read.c, src/alpha.c), HDR
 * (PQ, HLG) tone mapped. Copyright 2019 Joe Drago, BSD-2-Clause License (see THIRD_PARTY_NOTICES.md)
 */

import { parseProfile } from '../util/icc.ts';
import { MAX_PIXELS, checkPixels } from '../util/limits.ts';
import { decodeAV1, Frame } from './av1/frame.ts';
import { toSRGB, hdrToLinear, ToneMapping } from './hdr.ts';

interface Box { type: string, start: number, end: number }

const fourcc = (d: Uint8Array, o: number): string => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);

function* boxes(d: Uint8Array, start: number, end: number): Generator<Box> {
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let o = start;
    while (o + 8 <= end) {
        let size = view.getUint32(o);
        const type = fourcc(d, o + 4);
        let header = 8;
        if (size === 1) {
            if (o + 16 > end) throw new Error('AVIF: truncated box');
            size = view.getUint32(o + 8) * 2 ** 32 + view.getUint32(o + 12);
            header = 16;
        } else if (size === 0) size = end - o;
        if (size < header || o + size > end) throw new Error(`AVIF: invalid ${type} box`);
        yield { type, start: o + header, end: o + size };
        o += size;
    }
}

const child = (d: Uint8Array, box: Box, type: string, offset = 0): Box | undefined => {
    for (const b of boxes(d, box.start + offset, box.end)) if (b.type === type) return b;
    return undefined;
};

/** Whether the data starts like an AVIF: an ftyp box with the avif or avis brand */
export function isAVIF(d: Uint8Array): boolean {
    if (d.length < 16 || fourcc(d, 4) !== 'ftyp') return false;
    const size = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0);
    for (let o = 8; o + 4 <= Math.min(size, d.length); o += o === 8 ? 8 : 4) {
        const brand = fourcc(d, o);
        if (brand === 'avif' || brand === 'avis') return true;
    }
    return false;
}

interface Item {
    id: number;
    type: string;
    extents: Array<{ offset: number, length: number }>;
    /** 0: file offsets, 1: in the idat box */
    method: number;
    props: Array<{ box: Box, essential: boolean }>;
    refs: Map<string, number[]>;
}

// the meta box's items: their types, locations, properties and references
function parseMeta(d: Uint8Array, meta: Box): { items: Map<number, Item>, primary: number, idat: Box | undefined } {
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const items = new Map<number, Item>();
    const item = (id: number): Item => {
        let it = items.get(id);
        if (!it) items.set(id, it = { id, type: '', extents: [], method: 0, props: [], refs: new Map() });
        return it;
    };
    let primary = -1;
    const uint = (o: number, size: number): number => size === 8 ? view.getUint32(o) * 2 ** 32 + view.getUint32(o + 4) : size === 4 ? view.getUint32(o) : size === 2 ? view.getUint16(o) : size === 1 ? d[o] : 0;
    // (meta is a full box: its children start after the version and flags)
    const idat = child(d, meta, 'idat', 4);
    for (const box of boxes(d, meta.start + 4, meta.end)) {
        const version = d[box.start];
        let o = box.start + 4;
        if (box.type === 'pitm') primary = version ? view.getUint32(o) : view.getUint16(o);
        else if (box.type === 'iinf') {
            o += version ? 4 : 2;
            for (const infe of boxes(d, o, box.end)) {
                if (infe.type !== 'infe') continue;
                const v = d[infe.start];
                if (v < 2) continue;
                let p = infe.start + 4;
                const id = v === 2 ? view.getUint16(p) : view.getUint32(p);
                p += v === 2 ? 2 : 4;
                p += 2; // protection index
                item(id).type = fourcc(d, p);
            }
        } else if (box.type === 'iloc') {
            const offsetSize = d[o] >> 4, lengthSize = d[o] & 15, baseSize = d[o + 1] >> 4, indexSize = version ? d[o + 1] & 15 : 0;
            o += 2;
            const count = version < 2 ? view.getUint16(o) : view.getUint32(o);
            o += version < 2 ? 2 : 4;
            for (let i = 0; i < count; i++) {
                const id = version < 2 ? view.getUint16(o) : view.getUint32(o);
                o += version < 2 ? 2 : 4;
                const it = item(id);
                if (version) {
                    it.method = view.getUint16(o) & 15;
                    o += 2;
                }
                o += 2; // data reference index
                const base = uint(o, baseSize);
                o += baseSize;
                const extents = view.getUint16(o);
                o += 2;
                for (let e = 0; e < extents; e++) {
                    o += indexSize;
                    const offset = uint(o, offsetSize);
                    o += offsetSize;
                    const length = uint(o, lengthSize);
                    o += lengthSize;
                    it.extents.push({ offset: base + offset, length });
                }
            }
        } else if (box.type === 'iref') {
            for (const ref of boxes(d, o, box.end)) {
                let p = ref.start;
                const from = version ? view.getUint32(p) : view.getUint16(p);
                p += version ? 4 : 2;
                const count = view.getUint16(p);
                p += 2;
                const to: number[] = [];
                for (let i = 0; i < count; i++, p += version ? 4 : 2) to.push(version ? view.getUint32(p) : view.getUint16(p));
                item(from).refs.set(ref.type, (item(from).refs.get(ref.type) ?? []).concat(to));
            }
        } else if (box.type === 'iprp') {
            const ipco = child(d, box, 'ipco');
            const properties = ipco ? [...boxes(d, ipco.start, ipco.end)] : [];
            for (const ipma of boxes(d, box.start, box.end)) {
                if (ipma.type !== 'ipma') continue;
                const v = d[ipma.start], flags = d[ipma.start + 3];
                let p = ipma.start + 4;
                const count = view.getUint32(p);
                p += 4;
                for (let i = 0; i < count; i++) {
                    const id = v < 1 ? view.getUint16(p) : view.getUint32(p);
                    p += v < 1 ? 2 : 4;
                    const n = d[p++];
                    for (let k = 0; k < n; k++) {
                        let index: number, essential: boolean;
                        if (flags & 1) {
                            essential = !!(d[p] & 0x80);
                            index = view.getUint16(p) & 0x7fff;
                            p += 2;
                        } else {
                            essential = !!(d[p] & 0x80);
                            index = d[p++] & 0x7f;
                        }
                        if (index && properties[index - 1]) item(id).props.push({ box: properties[index - 1], essential });
                    }
                }
            }
        }
    }
    return { items, primary, idat };
}

// an item's data: its extents, from the file or the idat box
function itemData(d: Uint8Array, it: Item, idat: Box | undefined): Uint8Array {
    const parts = it.extents.map(({ offset, length }) => {
        const base = it.method === 1 ? (idat ? idat.start : 0) : 0, end = it.method === 1 ? idat?.end ?? 0 : d.length;
        if (it.method > 1) throw new Error('AVIF: unsupported item construction method');
        // (a length of 0: up to the end)
        const start = base + offset, stop = length ? start + length : end;
        if (start > end || stop > end) throw new Error('AVIF: item data outside the file');
        return d.subarray(start, stop);
    });
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

const property = (it: Item, type: string): Box | undefined => it.props.find(p => p.box.type === type)?.box;

/** A decoded YUV (or monochrome) image: full planes (16 bit) and its color description */
interface Yuv {
    width: number;
    height: number;
    bitdepth: number;
    /** 0: monochrome, 1: 4:2:0, 2: 4:2:2, 3: 4:4:4 */
    layout: number;
    planes: Uint16Array[];
    strides: number[];
    fullRange: boolean;
    matrix: number;
    transfer: number;
    primaries: number;
}

function fromFrame(f: Frame): Yuv {
    return {
        width: f.hdr.upscaledWidth, height: f.height, bitdepth: f.bitdepth, layout: f.layout, planes: f.planes, strides: f.strides,
        fullRange: f.seq.fullRange, matrix: f.seq.matrixCoefficients, transfer: f.seq.transferCharacteristics,
        primaries: f.seq.colorPrimaries
    };
}

// decodes an AV1 image item (with the av1C's configuration OBUs if its data lacks a sequence header)
function decodeAV1Item(d: Uint8Array, it: Item, idat: Box | undefined, maxPixels: number): Yuv {
    let data = itemData(d, it, idat);
    const av1C = property(it, 'av1C');
    if (av1C && av1C.end - av1C.start > 4 && (data[0] >> 3 & 15) !== 1) {
        const config = d.subarray(av1C.start + 4, av1C.end);
        const joined = new Uint8Array(config.length + data.length);
        joined.set(config);
        joined.set(data, config.length);
        data = joined;
    }
    // layered images: the operating point (a1op) and the layer (lsel) to show
    const a1op = property(it, 'a1op'), lsel = property(it, 'lsel');
    const layer = lsel ? d[lsel.start] << 8 | d[lsel.start + 1] : 0xffff;
    const frame = decodeAV1(data, 0, data.length, { maxPixels, operatingPoint: a1op ? d[a1op.start] : 0, layer: layer === 0xffff ? -1 : layer });
    if (frame.incomplete) {
        // the layer to show uses inter prediction: a lower one is shown if it has the image's size
        const ispe = property(it, 'ispe');
        const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
        if (!ispe || view.getUint32(ispe.start + 4) !== frame.hdr.upscaledWidth || view.getUint32(ispe.start + 8) !== frame.height)
            throw new Error('AVIF: layered images with inter predicted layers are not supported');
    }
    return fromFrame(frame);
}

// a grid's tiles (all the same size) put together, cropped to its output size
// a grid: of its own tiles, or of the given ones (the alpha items of a grid's tiles)
function decodeGrid(d: Uint8Array, it: Item, items: Map<number, Item>, idat: Box | undefined, maxPixels: number, tiles = it.refs.get('dimg') ?? []): Yuv {
    const g = itemData(d, it, idat);
    const view = new DataView(g.buffer, g.byteOffset, g.byteLength);
    const wide = g[1] & 1;
    const rows = g[2] + 1, cols = g[3] + 1;
    const width = wide ? view.getUint32(4) : view.getUint16(4), height = wide ? view.getUint32(8) : view.getUint16(6);
    checkPixels(width, height, maxPixels);
    if (tiles.length !== rows * cols) throw new Error('AVIF: the grid has the wrong number of tiles');
    if (new Set(tiles).size !== tiles.length) throw new Error('AVIF: the grid repeats tiles');
    let out: Yuv | null = null;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const tileItem = items.get(tiles[r * cols + c]);
            if (!tileItem || tileItem.type !== 'av01') throw new Error('AVIF: invalid grid tile');
            const tile = decodeAV1Item(d, tileItem, idat, maxPixels);
            if (!out) {
                if (tile.width * cols < width || tile.height * rows < height) throw new Error('AVIF: the grid\'s tiles are too small');
                out = { ...tile, width, height, planes: [], strides: [] };
                for (let p = 0; p < tile.planes.length; p++) {
                    const sx = p && tile.layout < 3 ? 1 : 0, sy = p && tile.layout === 1 ? 1 : 0;
                    const stride = (width + sx) >> sx;
                    out.strides.push(stride);
                    out.planes.push(new Uint16Array(stride * ((height + sy) >> sy)));
                }
            } else if (tile.layout !== out.layout || tile.bitdepth !== out.bitdepth) throw new Error('AVIF: the grid\'s tiles differ');
            for (let p = 0; p < out.planes.length; p++) {
                const sx = p && out.layout < 3 ? 1 : 0, sy = p && out.layout === 1 ? 1 : 0;
                const tw = (tile.width + sx) >> sx, th = (tile.height + sy) >> sy;
                const x0 = c * tw, y0 = r * th;
                const pw = (width + sx) >> sx, ph = (height + sy) >> sy;
                for (let y = 0; y < th && y0 + y < ph; y++) {
                    const n = Math.min(tw, pw - x0);
                    if (n <= 0) break;
                    out.planes[p].set(tile.planes[p].subarray(y * tile.strides[p], y * tile.strides[p] + n), (y0 + y) * out.strides[p] + x0);
                }
            }
        }
    }
    return out as Yuv;
}

function decodeItem(d: Uint8Array, it: Item, items: Map<number, Item>, idat: Box | undefined, maxPixels: number): Yuv {
    if (it.type === 'av01') return decodeAV1Item(d, it, idat, maxPixels);
    if (it.type === 'grid') return decodeGrid(d, it, items, idat, maxPixels);
    throw new Error(`AVIF: unsupported item type ${it.type}`);
}

// Kr and Kb of the matrix coefficients (BT.601 for the ones without, like libavif)
function coefficients(matrix: number): [number, number] {
    switch (matrix) {
        case 1: return [0.2126, 0.0722];
        case 4: return [0.30, 0.11];
        case 7: return [0.212, 0.087];
        case 9: case 10: return [0.2627, 0.0593];
        default: return [0.299, 0.114];
    }
}

const TRANSFER_PQ = 16, TRANSFER_HLG = 18;

// YUV to RGBA (8 bit), libavif's reference conversion: in floating point, chroma upsampled bilinearly
const f32 = Math.fround;

// 0-1 to 8 bits, rounded in single precision like libavif (which can round up where rounding the exact value wouldn't)
const toByte = (v: number): number => v <= 0 ? 0 : v >= 1 ? 255 : Math.trunc(f32(0.5 + f32(v * 255)));

// what converting the rows of an image takes (the rows are converted by functions of their own, which get optimized
// early, unlike loops over the whole image in a function called once)
interface Conversion {
    width: number;
    height: number;
    layout: number;
    color: boolean;
    identity: boolean;
    ycgco: boolean;
    Y: Uint16Array;
    U: Uint16Array;
    V: Uint16Array;
    ys: number;
    cs: number;
    sx: number;
    sy: number;
    /** the samples as 0-1 (chroma -0.5-0.5); the decoder's samples don't exceed the maximum, they need no clamping */
    tableY: Float32Array;
    tableUV: Float32Array;
    out: Uint8Array;
    /** HDR: the non-linear RGB values */
    rgb: Float32Array | null;
    unmultiply: Float32Array | null;
    cr2: number;
    cb2: number;
    crg: number;
    cbg: number;
    /**
     * 1 / kg: dividing by kg in single precision is the same as multiplying by this in double precision and rounding
     * (the product's error is smaller than how close a quotient of floats can get to halfway between two floats; also
     * checked for every float of a binade with each matrix's kg)
     */
    kgInverse: number;
    /** 4:4:4: red and blue by luma and chroma sample (n values each), green's chroma term by both chroma samples */
    n: number;
    red: Uint8Array | null;
    blue: Uint8Array | null;
    gTerm: Float32Array | null;
}

// a row of a 4:4:4 image with the chroma terms computed ahead
function convertRow444(c: Conversion, j: number): void {
    const { Y, U, V, tableY, out, n } = c, red = c.red as Uint8Array, blue = c.blue as Uint8Array, gTerm = c.gTerm as Float32Array;
    const yRow = j * c.ys, uvRow = j * c.cs;
    for (let i = 0, p = j * c.width * 4; i < c.width; i++, p += 4) {
        const y = Y[yRow + i], u = U[uvRow + i], v = V[uvRow + i];
        out[p] = red[y * n + v];
        out[p + 1] = toByte(f32(tableY[y] - gTerm[u * n + v]));
        out[p + 2] = blue[y * n + u];
        out[p + 3] = 255;
    }
}

// a row of any image
function convertRow(c: Conversion, j: number): void {
    const { width, height, layout, color, identity, ycgco, Y, U, V, cs, sx, sy, tableY, tableUV, out, rgb, unmultiply, cr2, cb2, crg, cbg, kgInverse } = c;
    const uvRow = (j >> sy) * cs, yRow = j * c.ys;
    let adjRow = 0;
    if (color && layout === 1 && !(j === 0 || j === height - 1 && j % 2)) adjRow = j % 2 ? cs : -cs;
    for (let i = 0, p = j * width * 4; i < width; i++, p += 4) {
        const lum = tableY[Y[yRow + i]];
        out[p + 3] = 255;
        if (!color) {
            if (rgb) rgb[p / 4 * 3] = rgb[p / 4 * 3 + 1] = rgb[p / 4 * 3 + 2] = lum;
            else out[p] = out[p + 1] = out[p + 2] = toByte(lum);
            continue;
        }
        const o = uvRow + (i >> sx);
        let cb: number, cr: number;
        if (layout === 3) {
            cb = tableUV[U[o]];
            cr = tableUV[V[o]];
        } else {
            // bilinear: the nearest chroma sample, the ones next to it in the row and column, the diagonal one
            const adjCol = i === 0 || i === width - 1 && i % 2 ? 0 : i % 2 ? 1 : -1;
            cb = f32(f32(f32(f32(tableUV[U[o]] * 0.5625) + f32(tableUV[U[o + adjCol]] * 0.1875)) +
                f32(tableUV[U[o + adjRow]] * 0.1875)) + f32(tableUV[U[o + adjCol + adjRow]] * 0.0625));
            cr = f32(f32(f32(f32(tableUV[V[o]] * 0.5625) + f32(tableUV[V[o + adjCol]] * 0.1875)) +
                f32(tableUV[V[o + adjRow]] * 0.1875)) + f32(tableUV[V[o + adjCol + adjRow]] * 0.0625));
        }
        let r: number, g: number, b: number;
        if (identity) {
            g = lum; b = cb; r = cr;
        } else if (ycgco) {
            const t = lum - cb;
            g = lum + cb; b = t - cr; r = t + cr;
        } else {
            r = f32(lum + f32(cr2 * cr));
            b = f32(lum + f32(cb2 * cb));
            g = f32(lum - f32(f32(2 * f32(f32(crg * cr) + f32(cbg * cb))) * kgInverse));
        }
        if (rgb) {
            const q = p / 4 * 3;
            rgb[q] = r;
            rgb[q + 1] = g;
            rgb[q + 2] = b;
            continue;
        }
        if (unmultiply) {
            const a = unmultiply[p >> 2];
            if (a === 0) r = g = b = 0;
            else if (a < 1) {
                r = Math.min(f32((r <= 0 ? 0 : r >= 1 ? 1 : r) / a), 1);
                g = Math.min(f32((g <= 0 ? 0 : g >= 1 ? 1 : g) / a), 1);
                b = Math.min(f32((b <= 0 ? 0 : b >= 1 ? 1 : b) / a), 1);
            }
        }
        out[p] = toByte(r);
        out[p + 1] = toByte(g);
        out[p + 2] = toByte(b);
    }
}

// (premultiplied: the color is multiplied by the alpha, divided by it here like libavif does, before rounding)
function toRgba(y: Yuv, alpha: Yuv | null, toneMapping: ToneMapping, premultiplied = false): Uint8Array {
    const { width, height, bitdepth, layout } = y;
    const max = (1 << bitdepth) - 1;
    // (in single precision, like libavif)
    const [kr, kb] = coefficients(y.matrix).map(f32), kg = f32(f32(1 - kr) - kb);
    const identity = y.matrix === 0, ycgco = y.matrix === 8;
    const biasY = y.fullRange ? 0 : 16 << (bitdepth - 8), rangeY = y.fullRange ? max : 219 << (bitdepth - 8);
    const biasUV = 1 << (bitdepth - 1), rangeUV = y.fullRange ? max : 224 << (bitdepth - 8);
    const tableY = new Float32Array(max + 1), tableUV = new Float32Array(max + 1);
    for (let i = 0; i <= max; i++) {
        tableY[i] = (i - biasY) / rangeY;
        tableUV[i] = identity ? tableY[i] : (i - biasUV) / rangeUV;
    }
    let out: Uint8Array = new Uint8Array(width * height * 4);
    // HDR (PQ, HLG): the non-linear RGB values, converted to linear light and tone mapped after
    const hdr = y.transfer === TRANSFER_PQ || y.transfer === TRANSFER_HLG;
    const rgb = hdr ? new Float32Array(width * height * 3) : null;
    const Y = y.planes[0], ys = y.strides[0];
    const color = layout !== 0 && y.planes.length === 3;
    const U = y.planes[1], V = y.planes[2], cs = y.strides[1];
    const sx = layout < 3 ? 1 : 0, sy = layout === 1 ? 1 : 0;
    // the alpha image's luma, 0-1; a limited range is expanded to the full one like libavif does
    const alphas = alpha ? new Float32Array(width * height).fill(1) : null;
    if (alpha && alphas) {
        const A = alpha.planes[0], as = alpha.strides[0], amax = (1 << alpha.bitdepth) - 1;
        const lo = 16 << (alpha.bitdepth - 8), span = 219 << (alpha.bitdepth - 8);
        for (let j = 0; j < Math.min(height, alpha.height); j++) {
            for (let i = 0; i < Math.min(width, alpha.width); i++) {
                let v = Math.min(A[j * as + i], amax);
                if (!alpha.fullRange) v = Math.min(amax, Math.max(0, Math.trunc(((v - lo) * amax + (span >> 1)) / span)));
                alphas[j * width + i] = v / amax;
            }
        }
    }
    const unmultiply = premultiplied && !hdr ? alphas : null;
    const c: Conversion = {
        width, height, layout, color, identity, ycgco, Y, U, V, ys, cs, sx, sy, tableY, tableUV, out, rgb, unmultiply,
        cr2: f32(2 * f32(1 - kr)), cb2: f32(2 * f32(1 - kb)), crg: f32(kr * f32(1 - kr)), cbg: f32(kb * f32(1 - kb)), kgInverse: 1 / kg,
        n: max + 1, red: null, blue: null, gTerm: null
    };
    // 4:4:4 (most AVIFs): red and blue by luma and chroma sample, green's chroma term by both chroma samples,
    // computed ahead when there are enough pixels (at most half as many entries)
    const n = max + 1;
    if (layout === 3 && color && !identity && !ycgco && !rgb && !unmultiply && n * n * 2 <= width * height) {
        const red = c.red = new Uint8Array(n * n), blue = c.blue = new Uint8Array(n * n), gTerm = c.gTerm = new Float32Array(n * n);
        for (let v = 0; v < n; v++) {
            const rTerm = f32(c.cr2 * tableUV[v]), bTerm = f32(c.cb2 * tableUV[v]);
            for (let y = 0; y < n; y++) {
                red[y * n + v] = toByte(f32(tableY[y] + rTerm));
                blue[y * n + v] = toByte(f32(tableY[y] + bTerm));
            }
        }
        for (let u = 0; u < n; u++) {
            const cbTerm = f32(c.cbg * tableUV[u]);
            for (let v = 0; v < n; v++) gTerm[u * n + v] = f32(f32(2 * f32(f32(c.crg * tableUV[v]) + cbTerm)) * c.kgInverse);
        }
        for (let j = 0; j < height; j++) convertRow444(c, j);
    } else for (let j = 0; j < height; j++) convertRow(c, j);
    if (rgb) out = toSRGB(hdrToLinear(rgb, y.transfer, y.primaries), toneMapping);
    if (alphas) for (let i = 0; i < alphas.length; i++) out[i * 4 + 3] = Math.round(alphas[i] * 255);
    return out;
}

/** Decodes an AVIF (its primary item, or the first frame of an image sequence) into RGBA */
export function decode(d: Uint8Array, maxPixels = MAX_PIXELS, toneMapping: ToneMapping = 'reinhard'): { width: number, height: number, pixels: Uint8Array, icc?: Uint8Array } {
    if (!isAVIF(d)) throw new Error('AVIF: invalid header');
    let meta: Box | undefined, moov: Box | undefined;
    for (const box of boxes(d, 0, d.length)) {
        if (box.type === 'meta') meta = box;
        else if (box.type === 'moov') moov = box;
    }

    if (meta) {
        const { items, primary, idat } = parseMeta(d, meta);
        const it = items.get(primary);
        if (it) {
            // the alpha item refers to the primary item (auxl) and says it's alpha (auxC)
            const alphaOf = (id: number): Item | undefined => {
                for (const candidate of items.values()) {
                    if (!(candidate.refs.get('auxl') ?? []).includes(id)) continue;
                    const auxC = property(candidate, 'auxC');
                    const type = auxC ? String.fromCharCode(...d.subarray(auxC.start + 4, auxC.end)).replace(/\0.*$/s, '') : '';
                    if (type === 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha' || type === 'urn:mpeg:hevc:2015:auxid:1') return candidate;
                }
                return undefined;
            };
            const alphaItem = alphaOf(primary);
            const color = decodeItem(d, it, items, idat, maxPixels);
            applyColr(d, it, color);
            // an ICC profile describes the RGB values (rather than the primaries and transfer of the nclx box or the
            // sequence header), if it can be applied
            const icc = iccOf(d, it);
            if (icc && parseProfile(icc)) {
                color.primaries = 1;
                color.transfer = 13;
            }
            let alpha = alphaItem ? decodeItem(d, alphaItem, items, idat, maxPixels) : null;
            if (!alphaItem && it.type === 'grid') {
                // or each of a grid's tiles has an alpha item, arranged like them
                const tiles = (it.refs.get('dimg') ?? []).map(alphaOf);
                if (tiles.length && tiles.every(t => t)) alpha = decodeGrid(d, it, items, idat, maxPixels, tiles.map(t => (t as Item).id));
            }
            let pixels = toRgba(color, alpha, toneMapping, alphaItem && (it.refs.get('prem') ?? []).includes(alphaItem.id));
            let { width, height } = color;
            // the transformations, in the order of their properties
            for (const { box } of it.props) {
                if (box.type === 'clap') ({ width, height, pixels } = clap(d, box, width, height, pixels));
                else if (box.type === 'irot') ({ width, height, pixels } = rotate(pixels, width, height, d[box.start] & 3));
                else if (box.type === 'imir') pixels = mirror(pixels, width, height, d[box.start] & 1);
            }
            return { width, height, pixels, icc };
        }
    }
    if (moov) return decodeSequence(d, moov, maxPixels, toneMapping);
    throw new Error('AVIF: no image');
}

// the ICC profile of a colr box (prof or rICC)
function iccOf(d: Uint8Array, it: Item): Uint8Array | undefined {
    for (const { box } of it.props) {
        const type = box.type === 'colr' && box.end - box.start > 4 ? fourcc(d, box.start) : '';
        if (type === 'prof' || type === 'rICC') return d.subarray(box.start + 4, box.end);
    }
    return undefined;
}

// the colr box's (nclx) color description overrides the AV1 sequence header's
function applyColr(d: Uint8Array, it: Item, yuv: Yuv): void {
    for (const { box } of it.props) {
        if (box.type !== 'colr' || fourcc(d, box.start) !== 'nclx') continue;
        const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
        yuv.primaries = view.getUint16(box.start + 4);
        yuv.transfer = view.getUint16(box.start + 6);
        yuv.matrix = view.getUint16(box.start + 8);
        yuv.fullRange = !!(d[box.start + 10] & 0x80);
    }
}

// the clean aperture: a centered crop
function clap(d: Uint8Array, box: Box, width: number, height: number, pixels: Uint8Array): { width: number, height: number, pixels: Uint8Array } {
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const v = [0, 1, 2, 3, 4, 5, 6, 7].map(i => view.getInt32(box.start + i * 4));
    const [wN, wD, hN, hD, xN, xD, yN, yD] = v;
    if (wD <= 0 || hD <= 0 || xD <= 0 || yD <= 0) throw new Error('AVIF: invalid clap');
    const cw = wN / wD, ch = hN / hD;
    // the crop's center relative to the image's center
    const left = xN / xD + (width - 1) / 2 - (cw - 1) / 2, top = yN / yD + (height - 1) / 2 - (ch - 1) / 2;
    if (!Number.isInteger(cw) || !Number.isInteger(ch) || !Number.isInteger(left) || !Number.isInteger(top) ||
        left < 0 || top < 0 || cw < 1 || ch < 1 || left + cw > width || top + ch > height) throw new Error('AVIF: invalid clap');
    const out = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) out.set(pixels.subarray(((top + y) * width + left) * 4, ((top + y) * width + left + cw) * 4), y * cw * 4);
    return { width: cw, height: ch, pixels: out };
}

// counter-clockwise by 90 degree steps
function rotate(pixels: Uint8Array, width: number, height: number, steps: number): { width: number, height: number, pixels: Uint8Array } {
    if (!steps) return { width, height, pixels };
    const src = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height);
    const w = steps === 2 ? width : height, h = steps === 2 ? height : width;
    const out = new Uint8Array(w * h * 4), dst = new Uint32Array(out.buffer);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sx: number, sy: number;
            if (steps === 1) { sx = width - 1 - y; sy = x; }
            else if (steps === 2) { sx = width - 1 - x; sy = height - 1 - y; }
            else { sx = y; sy = height - 1 - x; }
            dst[y * w + x] = src[sy * width + sx];
        }
    }
    return { width: w, height: h, pixels: out };
}

// axis 0: about the vertical axis (top and bottom swap), 1: the horizontal one (left and right)
function mirror(pixels: Uint8Array, width: number, height: number, axis: number): Uint8Array {
    const src = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height);
    const out = new Uint8Array(width * height * 4), dst = new Uint32Array(out.buffer);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) dst[y * width + x] = axis ? src[y * width + width - 1 - x] : src[(height - 1 - y) * width + x];
    }
    return out;
}

// the first frame of an image sequence (the color track, and the alpha track that refers to it)
function decodeSequence(d: Uint8Array, moov: Box, maxPixels: number, toneMapping: ToneMapping): { width: number, height: number, pixels: Uint8Array } {
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const tracks: Array<{ id: number, handler: string, auxl: number[], sample: Uint8Array, config: Uint8Array | null }> = [];
    for (const trak of boxes(d, moov.start, moov.end)) {
        if (trak.type !== 'trak') continue;
        const tkhd = child(d, trak, 'tkhd');
        const id = tkhd ? view.getUint32(tkhd.start + (d[tkhd.start] ? 20 : 12)) : 0;
        const tref = child(d, trak, 'tref');
        const auxlBox = tref && child(d, tref, 'auxl');
        const auxl: number[] = [];
        if (auxlBox) for (let o = auxlBox.start; o + 4 <= auxlBox.end; o += 4) auxl.push(view.getUint32(o));
        const mdia = child(d, trak, 'mdia');
        const hdlr = mdia && child(d, mdia, 'hdlr');
        const minf = mdia && child(d, mdia, 'minf');
        const stbl = minf && child(d, minf, 'stbl');
        if (!hdlr || !stbl) continue;
        const handler = fourcc(d, hdlr.start + 8);
        const stsd = child(d, stbl, 'stsd'), stsz = child(d, stbl, 'stsz');
        const stco = child(d, stbl, 'stco') ?? child(d, stbl, 'co64');
        if (!stsd || !stsz || !stco) continue;
        const entry = [...boxes(d, stsd.start + 8, stsd.end)][0];
        if (!entry || entry.type !== 'av01') continue;
        // (a visual sample entry has 78 bytes before its boxes)
        const av1C = child(d, entry, 'av1C', 78);
        const size = view.getUint32(stsz.start + 4) || view.getUint32(stsz.start + 12);
        const offset = stco.type === 'stco' ? view.getUint32(stco.start + 8) : view.getUint32(stco.start + 8) * 2 ** 32 + view.getUint32(stco.start + 12);
        if (offset + size > d.length) throw new Error('AVIF: sample outside the file');
        tracks.push({ id, handler, auxl, sample: d.subarray(offset, offset + size), config: av1C && av1C.end - av1C.start > 4 ? d.subarray(av1C.start + 4, av1C.end) : null });
    }
    const colorTrack = tracks.find(t => t.handler === 'pict' || t.handler === 'vide') ?? tracks[0];
    if (!colorTrack) throw new Error('AVIF: no image');
    const alphaTrack = tracks.find(t => t !== colorTrack && (t.auxl.includes(colorTrack.id) || t.handler === 'auxv'));
    const frame = (t: typeof colorTrack): Yuv => {
        let data = t.sample;
        if (t.config && (data[0] >> 3 & 15) !== 1) {
            const joined = new Uint8Array(t.config.length + data.length);
            joined.set(t.config);
            joined.set(data, t.config.length);
            data = joined;
        }
        return fromFrame(decodeAV1(data, 0, data.length, { maxPixels }));
    };
    const color = frame(colorTrack);
    return { width: color.width, height: color.height, pixels: toRgba(color, alphaTrack ? frame(alphaTrack) : null, toneMapping) };
}
