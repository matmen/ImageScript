/*!
 * The AV1 deblocking filter: every transform block edge of intra frames, filtered with the filters of dav1d
 * (src/loopfilter_tmpl.c, src/lf_mask.c). Copyright (c) 2018-2021, VideoLAN and dav1d authors, Copyright (c) 2018,
 * Two Orioles, LLC, BSD-2-Clause License (see THIRD_PARTY_NOTICES.md)
 */

import { Frame } from './decode.ts';

/** Deblocks the frame in place: the vertical edges of each plane, then the horizontal ones */
export function deblock(f: Frame): void {
    const lf = f.hdr.loopFilter;
    if (!lf.levelY[0] && !lf.levelY[1]) return;
    // the limits by filter level
    const sharp = lf.sharpness;
    const I = new Uint8Array(64), E = new Uint8Array(64);
    for (let level = 0; level < 64; level++) {
        let limit = level;
        if (sharp > 0) limit = Math.min(limit >> (sharp + 3 >> 2), 9 - sharp);
        I[level] = Math.max(limit, 1);
        E[level] = 2 * (level + 2) + I[level];
    }
    const s4 = f.b4Stride;
    for (let plane = 0; plane < f.planes.length; plane++) {
        if (plane && !(plane === 1 ? lf.levelU : lf.levelV)) continue;
        const subX = plane ? f.ssx : 0, subY = plane ? f.ssy : 0;
        const txW = plane ? f.uvTxW : f.txW, txH = plane ? f.uvTxH : f.txH;
        const pic = f.planes[plane], stride = f.strides[plane];
        for (let pass = 0; pass < 2; pass++) {
            const dx = pass ? 0 : 1, dy = pass;
            const tx = pass ? txH : txW;
            const level = plane ? plane + 1 : pass;
            for (let row = 0; row < f.bh; row += 1 << subY) {
                const y = row * 4;
                if (y >= f.height || pass && !y) continue;
                for (let col = 0; col < f.bw; col += 1 << subX) {
                    const x = col * 4;
                    if (x >= f.width || !pass && !x) continue;
                    const r = row | subY, c = col | subX;
                    const xP = x >> subX, yP = y >> subY;
                    // the transform blocks on both sides of the edge (chroma ones by chroma 4x4 position)
                    const cur = (r >> subY) * s4 + (c >> subX);
                    const prevR = r - (dy << subY), prevC = c - (dx << subX);
                    const prev = (prevR >> subY) * s4 + (prevC >> subX);
                    const size = 4 << tx[cur];
                    if ((pass ? yP : xP) % size) continue;
                    const filterSize = Math.min(plane ? 8 : 16, size, 4 << tx[prev]);
                    let lvl = f.lfLevels[(r * s4 + c) * 4 + level];
                    if (!lvl) lvl = f.lfLevels[(prevR * s4 + prevC) * 4 + level];
                    if (!lvl) continue;
                    const wd = plane && filterSize === 8 ? 6 : filterSize;
                    filter(pic, yP * stride + xP, E[lvl], I[lvl], lvl >> 4, pass ? 1 : stride, pass ? stride : 1, wd, f.bitdepth);
                }
            }
        }
    }
}

// filters 4 lines across an edge (dav1d's loop_filter): stridea along the edge, strideb across it
function filter(dst: Uint16Array, d: number, E: number, I: number, H: number, stridea: number, strideb: number, wd: number, bitdepth: number): void {
    const shift = bitdepth - 8, F = 1 << shift;
    E <<= shift;
    I <<= shift;
    H <<= shift;
    const max = (1 << bitdepth) - 1;
    const pix = (v: number): number => v < 0 ? 0 : v > max ? max : v;
    const diffMin = -128 * (1 << shift), diffMax = 128 * (1 << shift) - 1;
    const clipDiff = (v: number): number => v < diffMin ? diffMin : v > diffMax ? diffMax : v;
    const abs = Math.abs;

    for (let i = 0; i < 4; i++, d += stridea) {
        let p6 = 0, p5 = 0, p4 = 0, p3 = 0, p2 = 0, q2 = 0, q3 = 0, q4 = 0, q5 = 0, q6 = 0;
        const p1 = dst[d - 2 * strideb], p0 = dst[d - strideb], q0 = dst[d], q1 = dst[d + strideb];
        let fm = abs(p1 - p0) <= I && abs(q1 - q0) <= I && abs(p0 - q0) * 2 + (abs(p1 - q1) >> 1) <= E;
        if (wd > 4) {
            p2 = dst[d - 3 * strideb];
            q2 = dst[d + 2 * strideb];
            fm &&= abs(p2 - p1) <= I && abs(q2 - q1) <= I;
            if (wd > 6) {
                p3 = dst[d - 4 * strideb];
                q3 = dst[d + 3 * strideb];
                fm &&= abs(p3 - p2) <= I && abs(q3 - q2) <= I;
            }
        }
        if (!fm) continue;

        let flat8out = false, flat8in = false;
        if (wd >= 16) {
            p6 = dst[d - 7 * strideb]; p5 = dst[d - 6 * strideb]; p4 = dst[d - 5 * strideb];
            q4 = dst[d + 4 * strideb]; q5 = dst[d + 5 * strideb]; q6 = dst[d + 6 * strideb];
            flat8out = abs(p6 - p0) <= F && abs(p5 - p0) <= F && abs(p4 - p0) <= F && abs(q4 - q0) <= F &&
                abs(q5 - q0) <= F && abs(q6 - q0) <= F;
        }
        if (wd >= 6) flat8in = abs(p2 - p0) <= F && abs(p1 - p0) <= F && abs(q1 - q0) <= F && abs(q2 - q0) <= F;
        if (wd >= 8) flat8in &&= abs(p3 - p0) <= F && abs(q3 - q0) <= F;

        if (wd >= 16 && flat8out && flat8in) {
            dst[d - 6 * strideb] = (p6 * 7 + p5 * 2 + p4 * 2 + p3 + p2 + p1 + p0 + q0 + 8) >> 4;
            dst[d - 5 * strideb] = (p6 * 5 + p5 * 2 + p4 * 2 + p3 * 2 + p2 + p1 + p0 + q0 + q1 + 8) >> 4;
            dst[d - 4 * strideb] = (p6 * 4 + p5 + p4 * 2 + p3 * 2 + p2 * 2 + p1 + p0 + q0 + q1 + q2 + 8) >> 4;
            dst[d - 3 * strideb] = (p6 * 3 + p5 + p4 + p3 * 2 + p2 * 2 + p1 * 2 + p0 + q0 + q1 + q2 + q3 + 8) >> 4;
            dst[d - 2 * strideb] = (p6 * 2 + p5 + p4 + p3 + p2 * 2 + p1 * 2 + p0 * 2 + q0 + q1 + q2 + q3 + q4 + 8) >> 4;
            dst[d - strideb] = (p6 + p5 + p4 + p3 + p2 + p1 * 2 + p0 * 2 + q0 * 2 + q1 + q2 + q3 + q4 + q5 + 8) >> 4;
            dst[d] = (p5 + p4 + p3 + p2 + p1 + p0 * 2 + q0 * 2 + q1 * 2 + q2 + q3 + q4 + q5 + q6 + 8) >> 4;
            dst[d + strideb] = (p4 + p3 + p2 + p1 + p0 + q0 * 2 + q1 * 2 + q2 * 2 + q3 + q4 + q5 + q6 * 2 + 8) >> 4;
            dst[d + 2 * strideb] = (p3 + p2 + p1 + p0 + q0 + q1 * 2 + q2 * 2 + q3 * 2 + q4 + q5 + q6 * 3 + 8) >> 4;
            dst[d + 3 * strideb] = (p2 + p1 + p0 + q0 + q1 + q2 * 2 + q3 * 2 + q4 * 2 + q5 + q6 * 4 + 8) >> 4;
            dst[d + 4 * strideb] = (p1 + p0 + q0 + q1 + q2 + q3 * 2 + q4 * 2 + q5 * 2 + q6 * 5 + 8) >> 4;
            dst[d + 5 * strideb] = (p0 + q0 + q1 + q2 + q3 + q4 * 2 + q5 * 2 + q6 * 7 + 8) >> 4;
        } else if (wd >= 8 && flat8in) {
            dst[d - 3 * strideb] = (p3 * 3 + 2 * p2 + p1 + p0 + q0 + 4) >> 3;
            dst[d - 2 * strideb] = (p3 * 2 + p2 + 2 * p1 + p0 + q0 + q1 + 4) >> 3;
            dst[d - strideb] = (p3 + p2 + p1 + 2 * p0 + q0 + q1 + q2 + 4) >> 3;
            dst[d] = (p2 + p1 + p0 + 2 * q0 + q1 + q2 + q3 + 4) >> 3;
            dst[d + strideb] = (p1 + p0 + q0 + 2 * q1 + q2 + q3 * 2 + 4) >> 3;
            dst[d + 2 * strideb] = (p0 + q0 + q1 + 2 * q2 + q3 * 3 + 4) >> 3;
        } else if (wd === 6 && flat8in) {
            dst[d - 2 * strideb] = (p2 * 3 + 2 * p1 + 2 * p0 + q0 + 4) >> 3;
            dst[d - strideb] = (p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3;
            dst[d] = (p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3;
            dst[d + strideb] = (p0 + 2 * q0 + 2 * q1 + q2 * 3 + 4) >> 3;
        } else {
            const hev = abs(p1 - p0) > H || abs(q1 - q0) > H;
            const top = (128 << shift) - 1;
            if (hev) {
                let f = clipDiff(p1 - q1);
                f = clipDiff(3 * (q0 - p0) + f);
                const f1 = Math.min(f + 4, top) >> 3, f2 = Math.min(f + 3, top) >> 3;
                dst[d - strideb] = pix(p0 + f2);
                dst[d] = pix(q0 - f1);
            } else {
                const f = clipDiff(3 * (q0 - p0));
                const f1 = Math.min(f + 4, top) >> 3, f2 = Math.min(f + 3, top) >> 3;
                dst[d - strideb] = pix(p0 + f2);
                dst[d] = pix(q0 - f1);
                const g = (f1 + 1) >> 1;
                dst[d - 2 * strideb] = pix(p1 + g);
                dst[d + strideb] = pix(q1 - g);
            }
        }
    }
}
