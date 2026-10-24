/*!
 * AV1 film grain synthesis, ported from dav1d (src/filmgrain_tmpl.c, src/fg_apply_tmpl.c). Copyright (c) 2018-2021,
 * VideoLAN and dav1d authors, Copyright (c) 2018, Two Orioles, LLC, BSD-2-Clause License (see THIRD_PARTY_NOTICES.md)
 */

import { Frame } from './decode.ts';
import { FilmGrain } from './obu.ts';
import { gaussianSequence } from './tables.ts';

const GRAIN_WIDTH = 82, GRAIN_HEIGHT = 73, SUB_GRAIN_WIDTH = 44, SUB_GRAIN_HEIGHT = 38, BLOCK = 32;

// the 16 bit linear feedback shift register: the state, and the next bits
class Random {
    constructor(public state: number) {}

    next(bits: number): number {
        const r = this.state;
        const bit = (r ^ r >> 1 ^ r >> 3 ^ r >> 12) & 1;
        this.state = r >> 1 | bit << 15;
        return this.state >> (16 - bits) & (1 << bits) - 1;
    }
}

const round2 = (x: number, shift: number): number => (x + ((1 << shift) >> 1)) >> shift;

function generateGrainY(g: FilmGrain, bitdepth: number): Int16Array {
    const gauss = gaussianSequence();
    const buf = new Int16Array(GRAIN_HEIGHT * GRAIN_WIDTH);
    const rnd = new Random(g.seed);
    const shift = 4 - (bitdepth - 8) + g.grainScaleShift;
    const ctr = 128 << (bitdepth - 8), min = -ctr, max = ctr - 1;
    for (let i = 0; i < buf.length; i++) buf[i] = round2(gauss[rnd.next(11)], shift);
    const lag = g.arCoeffLag;
    for (let y = 3; y < GRAIN_HEIGHT; y++) {
        for (let x = 3; x < GRAIN_WIDTH - 3; x++) {
            let sum = 0, c = 0;
            outer: for (let dy = -lag; dy <= 0; dy++) {
                for (let dx = -lag; dx <= lag; dx++) {
                    if (!dx && !dy) break outer;
                    sum += g.arCoeffsY[c++] * buf[(y + dy) * GRAIN_WIDTH + x + dx];
                }
            }
            const v = buf[y * GRAIN_WIDTH + x] + round2(sum, g.arCoeffShift);
            buf[y * GRAIN_WIDTH + x] = v < min ? min : v > max ? max : v;
        }
    }
    return buf;
}

function generateGrainUv(g: FilmGrain, lumaBuf: Int16Array, uv: number, subx: number, suby: number, bitdepth: number): Int16Array {
    const gauss = gaussianSequence();
    const buf = new Int16Array(GRAIN_HEIGHT * GRAIN_WIDTH);
    const rnd = new Random(g.seed ^ (uv ? 0x49d8 : 0xb524));
    const shift = 4 - (bitdepth - 8) + g.grainScaleShift;
    const ctr = 128 << (bitdepth - 8), min = -ctr, max = ctr - 1;
    const w = subx ? SUB_GRAIN_WIDTH : GRAIN_WIDTH, h = suby ? SUB_GRAIN_HEIGHT : GRAIN_HEIGHT;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) buf[y * GRAIN_WIDTH + x] = round2(gauss[rnd.next(11)], shift);
    const lag = g.arCoeffLag, coeffs = g.arCoeffsUv[uv];
    for (let y = 3; y < h; y++) {
        for (let x = 3; x < w - 3; x++) {
            let sum = 0, c = 0;
            outer: for (let dy = -lag; dy <= 0; dy++) {
                for (let dx = -lag; dx <= lag; dx++) {
                    if (!dx && !dy) {
                        // the contribution of the luma grain
                        if (!g.yPoints.length) break outer;
                        let luma = 0;
                        const lx = ((x - 3) << subx) + 3, ly = ((y - 3) << suby) + 3;
                        for (let i = 0; i <= suby; i++) for (let j = 0; j <= subx; j++) luma += lumaBuf[(ly + i) * GRAIN_WIDTH + lx + j];
                        sum += round2(luma, subx + suby) * coeffs[c];
                        break outer;
                    }
                    sum += coeffs[c++] * buf[(y + dy) * GRAIN_WIDTH + x + dx];
                }
            }
            const v = buf[y * GRAIN_WIDTH + x] + round2(sum, g.arCoeffShift);
            buf[y * GRAIN_WIDTH + x] = v < min ? min : v > max ? max : v;
        }
    }
    return buf;
}

function generateScaling(bitdepth: number, points: number[][]): Uint8Array {
    const shiftX = bitdepth - 8, size = 1 << bitdepth;
    const scaling = new Uint8Array(size);
    const num = points.length;
    if (!num) return scaling;
    scaling.fill(points[0][1], 0, points[0][0] << shiftX);
    for (let i = 0; i < num - 1; i++) {
        const [bx, by] = points[i], [ex, ey] = points[i + 1];
        const dx = ex - bx, dy = ey - by;
        const delta = dy * Math.floor((0x10000 + (dx >> 1)) / dx);
        for (let x = 0, d = 0x8000; x < dx; x++) {
            scaling[(bx + x) << shiftX] = by + (d >> 16);
            d += delta;
        }
    }
    const n = points[num - 1][0] << shiftX;
    scaling.fill(points[num - 1][1], n, size);
    if (bitdepth > 8) {
        const pad = 1 << shiftX, rnd = pad >> 1;
        for (let i = 0; i < num - 1; i++) {
            const bx = points[i][0] << shiftX, ex = points[i + 1][0] << shiftX;
            for (let x = 0; x < ex - bx; x += pad) {
                const range = scaling[bx + x + pad] - scaling[bx + x];
                for (let k = 1, r = rnd; k < pad; k++) {
                    r += range;
                    scaling[bx + x + k] = scaling[bx + x] + (r >> shiftX);
                }
            }
        }
    }
    return scaling;
}

const W = [[[27, 17], [17, 27]], [[23, 22], [0, 0]]];

// adds the grain to a 32 row stripe of a plane (rowNum: the stripe), chroma also by the luma (luma: the input luma plane)
function applyStripe(g: FilmGrain, dst: Uint16Array, src: Uint16Array, stride: number, pw: number, bh: number, rowNum: number,
    scaling: Uint8Array, lut: Int16Array, bitdepth: number, plane: number, sx: number, sy: number, isId: boolean,
    luma: Uint16Array, lumaStride: number): void {
    const rows = 1 + (g.overlap && rowNum > 0 ? 1 : 0);
    const shift8 = bitdepth - 8, ctr = 128 << shift8, gmin = -ctr, gmax = ctr - 1, bdMax = (1 << bitdepth) - 1;
    const minV = g.clipToRestrictedRange ? 16 << shift8 : 0;
    const maxV = g.clipToRestrictedRange ? (plane && !isId ? 240 : 235) << shift8 : bdMax;
    const clip = (v: number, lo: number, hi: number): number => v < lo ? lo : v > hi ? hi : v;
    const seeds: Random[] = [];
    for (let i = 0; i < rows; i++) {
        let s = g.seed;
        s ^= (((rowNum - i) * 37 + 178) & 0xff) << 8;
        s ^= ((rowNum - i) * 173 + 105) & 0xff;
        seeds.push(new Random(s));
    }
    const offsets = [[0, 0], [0, 0]];
    const sample = (bx: number, by: number, x: number, y: number): number => {
        const randval = offsets[bx][by];
        const offx = 3 + (2 >> sx) * (3 + (randval >> 4)), offy = 3 + (2 >> sy) * (3 + (randval & 0xf));
        return lut[(offy + y + (BLOCK >> sy) * by) * GRAIN_WIDTH + offx + x + (BLOCK >> sx) * bx];
    };
    const y0 = rowNum * BLOCK >> sy;
    const uv = plane - 1;
    const add = (bx: number, x: number, y: number, grain: number): void => {
        const o = (y0 + y) * stride + bx + x;
        let val: number;
        if (!plane) val = src[o];
        else {
            const lx = (bx + x) << sx, ly = (y0 + y) << sy;
            let avg = luma[ly * lumaStride + lx];
            if (sx) avg = (avg + luma[ly * lumaStride + lx + 1] + 1) >> 1;
            val = avg;
            if (!g.chromaScalingFromLuma) {
                const combined = avg * g.uvLumaMult[uv] + src[o] * g.uvMult[uv];
                val = clip((combined >> 6) + g.uvOffset[uv] * (1 << shift8), 0, bdMax);
            }
        }
        const noise = round2(scaling[val] * grain, g.scalingShift);
        dst[o] = clip(src[o] + noise, minV, maxV);
    };
    const blockW = BLOCK >> sx;
    for (let bx = 0; bx < pw; bx += blockW) {
        const bw = Math.min(blockW, pw - bx);
        if (g.overlap && bx) for (let i = 0; i < rows; i++) offsets[1][i] = offsets[0][i];
        for (let i = 0; i < rows; i++) offsets[0][i] = seeds[i].next(8);
        const ystart = g.overlap && rowNum ? Math.min(2 >> sy, bh) : 0;
        const xstart = g.overlap && bx ? Math.min(2 >> sx, bw) : 0;
        const wx = W[sx], wy = W[sy];
        for (let y = ystart; y < bh; y++) {
            for (let x = xstart; x < bw; x++) add(bx, x, y, sample(0, 0, x, y));
            for (let x = 0; x < xstart; x++) {
                const grain = clip(round2(sample(1, 0, x, y) * wx[x][0] + sample(0, 0, x, y) * wx[x][1], 5), gmin, gmax);
                add(bx, x, y, grain);
            }
        }
        for (let y = 0; y < ystart; y++) {
            for (let x = xstart; x < bw; x++) {
                const grain = clip(round2(sample(0, 1, x, y) * wy[y][0] + sample(0, 0, x, y) * wy[y][1], 5), gmin, gmax);
                add(bx, x, y, grain);
            }
            for (let x = 0; x < xstart; x++) {
                const top = clip(round2(sample(1, 1, x, y) * wx[x][0] + sample(0, 1, x, y) * wx[x][1], 5), gmin, gmax);
                let grain = clip(round2(sample(1, 0, x, y) * wx[x][0] + sample(0, 0, x, y) * wx[x][1], 5), gmin, gmax);
                grain = clip(round2(top * wy[y][0] + grain * wy[y][1], 5), gmin, gmax);
                add(bx, x, y, grain);
            }
        }
    }
}

/** The frame's planes with film grain (new planes; the frame's stay as they are) */
export function applyFilmGrain(f: Frame, g: FilmGrain): Uint16Array[] {
    const bitdepth = f.bitdepth, w = f.hdr.upscaledWidth, h = f.height;
    const sx = f.ssx, sy = f.ssy;
    const lumaLut = generateGrainY(g, bitdepth);
    const out = f.planes.map(p => p.slice());
    const scalingY = g.yPoints.length || g.chromaScalingFromLuma ? generateScaling(bitdepth, g.yPoints) : new Uint8Array(1 << bitdepth);
    const isId = f.seq.matrixCoefficients === 0;
    const rows = Math.ceil(h / BLOCK);
    if (g.yPoints.length) {
        for (let row = 0; row < rows; row++) {
            applyStripe(g, out[0], f.planes[0], f.strides[0], w, Math.min(h - row * BLOCK, BLOCK), row, scalingY, lumaLut, bitdepth, 0, 0, 0, isId, f.planes[0], f.strides[0]);
        }
    }
    if (f.planes.length === 1 || !g.uvPoints[0].length && !g.uvPoints[1].length && !g.chromaScalingFromLuma) return out;

    // (odd widths: the luma column right of the image repeats the last one, for the chroma's averages)
    const luma = f.planes[0], ls = f.strides[0];
    if (w & sx) for (let y = 0; y < h; y++) luma[y * ls + w] = luma[y * ls + w - 1];
    const cpw = w + sx >> sx;
    for (let pl = 0; pl < 2; pl++) {
        if (!g.chromaScalingFromLuma && !g.uvPoints[pl].length) continue;
        const lut = generateGrainUv(g, lumaLut, pl, sx, sy, bitdepth);
        const scaling = g.chromaScalingFromLuma ? scalingY : generateScaling(bitdepth, g.uvPoints[pl]);
        for (let row = 0; row < rows; row++) {
            const bh = Math.min(h - row * BLOCK, BLOCK) + sy >> sy;
            applyStripe(g, out[1 + pl], f.planes[1 + pl], f.strides[1], cpw, bh, row, scaling, lut, bitdepth, 1 + pl, sx, sy, isId, luma, ls);
        }
    }
    return out;
}
