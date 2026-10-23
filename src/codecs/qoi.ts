/*!
 * The Quite OK Image format (https://qoiformat.org/qoi-specification.pdf). The encoder makes the choices of the
 * reference encoder qoi.h, so it writes the same bytes. Copyright (c) 2021 Dominic Szablewski, MIT License (see
 * THIRD_PARTY_NOTICES.md)
 */

import { MAX_PIXELS, checkPixels } from '../util/limits.ts';

const OP_INDEX = 0x00, OP_DIFF = 0x40, OP_LUMA = 0x80, OP_RUN = 0xc0, OP_RGB = 0xfe, OP_RGBA = 0xff;

/** Whether the data starts like a QOI */
export function isQOI(d: Uint8Array): boolean {
    return d.length >= 14 && d[0] === 0x71 && d[1] === 0x6f && d[2] === 0x69 && d[3] === 0x66;
}

const hash = (r: number, g: number, b: number, a: number): number => (r * 3 + g * 5 + b * 7 + a * 11) & 63;

/** Decodes a QOI into RGBA */
export function decode(d: Uint8Array, maxPixels = MAX_PIXELS): { width: number, height: number, pixels: Uint8Array } {
    if (!isQOI(d)) throw new Error('QOI: invalid header');
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const width = view.getUint32(4), height = view.getUint32(8);
    if (!width || !height) throw new Error(`QOI: invalid dimensions ${width}x${height}`);
    checkPixels(width, height, maxPixels);

    const pixels = new Uint8Array(width * height * 4);
    const index = new Uint8Array(256);
    let r = 0, g = 0, b = 0, a = 255;
    // (the end marker, seven zeros and a one, isn't needed)
    for (let p = 0, o = 14; p < pixels.length;) {
        if (o >= d.length) throw new Error('QOI: truncated image data');
        const op = d[o++];
        let run = 1;
        if (op === OP_RGB) {
            r = d[o]; g = d[o + 1]; b = d[o + 2];
            o += 3;
        } else if (op === OP_RGBA) {
            r = d[o]; g = d[o + 1]; b = d[o + 2]; a = d[o + 3];
            o += 4;
        } else if ((op & 0xc0) === OP_INDEX) {
            const i = op * 4;
            r = index[i]; g = index[i + 1]; b = index[i + 2]; a = index[i + 3];
        } else if ((op & 0xc0) === OP_DIFF) {
            r = r + (op >> 4 & 3) - 2 & 255;
            g = g + (op >> 2 & 3) - 2 & 255;
            b = b + (op & 3) - 2 & 255;
        } else if ((op & 0xc0) === OP_LUMA) {
            const dg = (op & 63) - 32, next = d[o++];
            r = r + dg - 8 + (next >> 4) & 255;
            g = g + dg & 255;
            b = b + dg - 8 + (next & 15) & 255;
        } else run = (op & 63) + 1;
        if (o > d.length) throw new Error('QOI: truncated image data');

        const i = hash(r, g, b, a) * 4;
        index[i] = r; index[i + 1] = g; index[i + 2] = b; index[i + 3] = a;
        for (const stop = Math.min(pixels.length, p + run * 4); p < stop; p += 4) {
            pixels[p] = r; pixels[p + 1] = g; pixels[p + 2] = b; pixels[p + 3] = a;
        }
    }
    return { width, height, pixels };
}

/** Encodes RGBA pixels into a QOI (3 channels if the image is opaque), byte for byte like the reference encoder */
export function encode(rgba: Uint8Array, width: number, height: number): Uint8Array {
    if (width < 1 || height < 1) throw new RangeError('QOI: dimensions must be at least 1');
    const count = width * height;
    let opaque = true;
    for (let i = 3; i < count * 4; i += 4) if (rgba[i] !== 255) { opaque = false; break; }

    // worst case: 5 bytes per pixel, the header and the end marker
    const out = new Uint8Array(14 + count * (opaque ? 4 : 5) + 8);
    const view = new DataView(out.buffer);
    out.set([0x71, 0x6f, 0x69, 0x66]);
    view.setUint32(4, width);
    view.setUint32(8, height);
    out[12] = opaque ? 3 : 4;
    out[13] = 0; // sRGB with linear alpha

    const index = new Uint8Array(256);
    let o = 14, run = 0;
    let pr = 0, pg = 0, pb = 0, pa = 255;
    for (let p = 0, last = count * 4 - 4; p <= last; p += 4) {
        const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2], a = rgba[p + 3];
        if (r === pr && g === pg && b === pb && a === pa) {
            run++;
            if (run === 62 || p === last) {
                out[o++] = OP_RUN | run - 1;
                run = 0;
            }
            continue;
        }
        if (run) {
            out[o++] = OP_RUN | run - 1;
            run = 0;
        }

        const h = hash(r, g, b, a), i = h * 4;
        if (index[i] === r && index[i + 1] === g && index[i + 2] === b && index[i + 3] === a) out[o++] = OP_INDEX | h;
        else {
            index[i] = r; index[i + 1] = g; index[i + 2] = b; index[i + 3] = a;
            if (a === pa) {
                // the differences as signed bytes
                const vr = (r - pr) << 24 >> 24, vg = (g - pg) << 24 >> 24, vb = (b - pb) << 24 >> 24;
                const vgr = vr - vg, vgb = vb - vg;
                if (vr > -3 && vr < 2 && vg > -3 && vg < 2 && vb > -3 && vb < 2) out[o++] = OP_DIFF | vr + 2 << 4 | vg + 2 << 2 | vb + 2;
                else if (vgr > -9 && vgr < 8 && vg > -33 && vg < 32 && vgb > -9 && vgb < 8) {
                    out[o++] = OP_LUMA | vg + 32;
                    out[o++] = vgr + 8 << 4 | vgb + 8;
                } else {
                    out[o++] = OP_RGB; out[o++] = r; out[o++] = g; out[o++] = b;
                }
            } else {
                out[o++] = OP_RGBA; out[o++] = r; out[o++] = g; out[o++] = b; out[o++] = a;
            }
        }
        pr = r; pg = g; pb = b; pa = a;
    }
    out[o + 7] = 1;
    return out.slice(0, o + 8);
}
