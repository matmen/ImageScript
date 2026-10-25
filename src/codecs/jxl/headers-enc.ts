/*!
 * The headers of the JPEG XL encoders: libjxl's image header (lib/jxl/headers.cc, fields.cc). Copyright (c) the JPEG
 * XL Project Authors, BSD-3-Clause License (see THIRD_PARTY_NOTICES.md)
 */
import { BitWriter } from './bit-writer.ts';

/** Writes a U32 field: the selector and bits of BitsOffset distributions (the one with the fewest bits) */
export function u32(w: BitWriter, value: number, dists: [number, number][]): void {
    for (let s = 0; s < dists.length; s++) {
        const [bits, offset] = dists[s];
        if (value >= offset && value - offset < 2 ** bits) {
            w.write(2, s);
            w.write(bits, value - offset);
            return;
        }
    }
    throw new RangeError(`JPEG XL: ${value} out of range`);
}

// libjxl's fixed aspect ratios of the size header (the width from the height)
const RATIOS: [number, number][] = [[1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];

/** The signature, the size, the image metadata: 8-bit, alpha if there is, XYB or not, sRGB (grey with 1-2 channels) */
export function imageHeader(w: BitWriter, width: number, height: number, numChans: number, xyb = false): void {
    w.write(16, 0x0aff);
    let ratio = 0;
    for (let r = 1; r < 8 && !ratio; r++) if (width === Math.floor(height * RATIOS[r - 1][0] / RATIOS[r - 1][1])) ratio = r;
    const small = height <= 256 && height % 8 === 0 && (ratio !== 0 || (width <= 256 && width % 8 === 0));
    const dists: [number, number][] = [[9, 1], [13, 1], [18, 1], [30, 1]];
    w.write(1, +small);
    if (small) w.write(5, height / 8 - 1);
    else u32(w, height, dists);
    w.write(3, ratio);
    if (!ratio) {
        if (small) w.write(5, width / 8 - 1);
        else u32(w, width, dists);
    }
    // not all default, no extra fields, integers of 8 bits, a 16-bit buffer suffices
    w.write(1, 0);
    w.write(1, 0);
    w.write(1, 0);
    w.write(2, 0b00);
    w.write(1, 1);
    if (numChans === 2 || numChans === 4) {
        // an extra channel: 8-bit alpha
        w.write(2, 0b01);
        w.write(1, 1);
    } else w.write(2, 0b00);
    w.write(1, xyb ? 1 : 0);
    if (numChans > 2) w.write(1, 1);
    else {
        // grey, D65, the sRGB transfer function, relative intent
        w.write(1, 0);
        w.write(1, 0);
        w.write(2, 1);
        w.write(2, 1);
        w.write(1, 0);
        w.write(2, 0b10);
        w.write(4, 11);
        w.write(2, 1);
    }
    // no extensions, default transform data
    w.write(2, 0b00);
    w.write(1, 1);
    w.zeroPadToByte();
}

