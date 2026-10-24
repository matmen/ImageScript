/*!
 * The transforms of JPEG XL's varblocks: DCTs from 2 to 256 points (recursive, by the half secants), their 2D layout,
 * and the special 8x8 ones (DCT2, DCT4, Hornuss, DCT4x8, AFV); ported from jxl-oxide
 * (crates/jxl-render/src/vardct/generic, dct_common.rs, transform_common.rs). Copyright (c) Wonwoo Choi, MIT License
 * (see THIRD_PARTY_NOTICES.md)
 */
import { idct16, idct32 } from './idct.ts';

/** A rectangle of a plane: its top left at offset, rows stride apart */
export interface Block {
    buf: Float32Array;
    offset: number;
    stride: number;
    w: number;
    h: number;
}

const halfSecants = new Map<number, Float64Array>();

// 1 / (2 cos((2k + 1) pi / 2n)) for k < n / 2
function secHalf(n: number): Float64Array {
    let t = halfSecants.get(n);
    if (!t) {
        t = new Float64Array(n / 2);
        for (let k = 0; k < n / 2; k++) t[k] = 1 / Math.cos((2 * k + 1) / (2 * n) * Math.PI) / 2;
        halfSecants.set(n, t);
    }
    return t;
}

const SEC0 = 0.5411961, SEC1 = 1.306563;

function dct4(io: Float64Array, o: number, inverse: boolean): void {
    const i0 = io[o], i1 = io[o + 1], i2 = io[o + 2], i3 = io[o + 3];
    if (!inverse) {
        const sum03 = i0 + i3, sum12 = i1 + i2, t0 = (i0 - i3) * SEC0, t1 = (i1 - i2) * SEC1;
        const out0 = (t0 + t1) / 4, out1 = (t0 - t1) / 4;
        io[o] = (sum03 + sum12) / 4;
        io[o + 1] = out0 * Math.SQRT2 + out1;
        io[o + 2] = (sum03 - sum12) / 4;
        io[o + 3] = out1;
    } else {
        const t0 = i1 * Math.SQRT2, t1 = i1 + i3, out0 = (t0 + t1) * SEC0, out1 = (t0 - t1) * SEC1;
        const sum02 = i0 + i2, sub02 = i0 - i2;
        io[o] = sum02 + out0;
        io[o + 1] = sub02 + out1;
        io[o + 2] = sub02 - out1;
        io[o + 3] = sum02 - out0;
    }
}

/** A DCT (forward: scaled by 1/n, the AC by sqrt 2) of n values at io[o..], in place (scratch: n values from s) */
export function dct(io: Float64Array, o: number, n: number, scratch: Float64Array, s: number, inverse: boolean): void {
    if (n <= 1) return;
    if (n === 2) {
        const a = io[o] + io[o + 1], b = io[o] - io[o + 1];
        io[o] = inverse ? a : a / 2;
        io[o + 1] = inverse ? b : b / 2;
        return;
    }
    if (n === 4) {
        dct4(io, o, inverse);
        return;
    }
    const half = n / 2, sec = secHalf(n);
    if (!inverse) {
        for (let i = 0; i < half; i++) {
            scratch[s + i] = (io[o + i] + io[o + n - i - 1]) / 2;
            scratch[s + half + i] = (io[o + i] - io[o + n - i - 1]) / 2 * sec[i];
        }
        dct(scratch, s, half, io, o, false);
        dct(scratch, s + half, half, io, o + half, false);
        scratch[s + half] *= Math.SQRT2;
        for (let i = 0; i < half - 1; i++) scratch[s + half + i] += scratch[s + half + i + 1];
        for (let i = 0; i < half; i++) {
            io[o + 2 * i] = scratch[s + i];
            io[o + 2 * i + 1] = scratch[s + half + i];
        }
    } else {
        for (let i = 0; i < half; i++) {
            scratch[s + i] = io[o + 2 * i];
            scratch[s + half + i] = io[o + 2 * i + 1];
        }
        for (let i = 1; i < half; i++) scratch[s + n - i] += scratch[s + n - i - 1];
        scratch[s + half] *= Math.SQRT2;
        dct(scratch, s, half, io, o, true);
        dct(scratch, s + half, half, io, o + half, true);
        for (let i = 0; i < half; i++) {
            const r = scratch[s + half + i] * sec[i];
            io[o + i] = scratch[s + i] + r;
            io[o + n - i - 1] = scratch[s + i] - r;
        }
    }
}

const work = { row: new Float64Array(256), scratch: new Float64Array(256), col: new Float64Array(256 * 2) };

const SEC8 = secHalf(8);

// the inverse 8-point DCT of buf[o + k * step] in place (like dct's recursion, unrolled)
function idct8(buf: Float32Array, o: number, step: number): void {
    const v0 = buf[o], v1 = buf[o + step], v2 = buf[o + 2 * step], v3 = buf[o + 3 * step];
    const v4 = buf[o + 4 * step], v5 = buf[o + 5 * step], v6 = buf[o + 6 * step], v7 = buf[o + 7 * step];
    // the even half: v0, v2, v4, v6
    let t0 = v2 * Math.SQRT2, t1 = v2 + v6;
    const e0 = (t0 + t1) * SEC0, e1 = (t0 - t1) * SEC1, s02 = v0 + v4, d02 = v0 - v4;
    const a0 = s02 + e0, a1 = d02 + e1, a2 = d02 - e1, a3 = s02 - e0;
    // the odd half: v1 * sqrt 2, v3 + v1, v5 + v3, v7 + v5
    const o0 = v1 * Math.SQRT2, o1 = v3 + v1, o2 = v5 + v3, o3 = v7 + v5;
    t0 = o1 * Math.SQRT2;
    t1 = o1 + o3;
    const f0 = (t0 + t1) * SEC0, f1 = (t0 - t1) * SEC1, s13 = o0 + o2, d13 = o0 - o2;
    const b0 = (s13 + f0) * SEC8[0], b1 = (d13 + f1) * SEC8[1], b2 = (d13 - f1) * SEC8[2], b3 = (s13 - f0) * SEC8[3];
    buf[o] = a0 + b0;
    buf[o + 7 * step] = a0 - b0;
    buf[o + step] = a1 + b1;
    buf[o + 6 * step] = a1 - b1;
    buf[o + 2 * step] = a2 + b2;
    buf[o + 5 * step] = a2 - b2;
    buf[o + 3 * step] = a3 + b3;
    buf[o + 4 * step] = a3 - b3;
}

// a DCT of n values of buf from o (rows) or every stride (columns)
function dctRow(buf: Float32Array, o: number, n: number, inverse: boolean): void {
    if (inverse && n <= 32 && n >= 8) {
        (n === 8 ? idct8 : n === 16 ? idct16 : idct32)(buf, o, 1);
        return;
    }
    const row = work.row;
    for (let x = 0; x < n; x++) row[x] = buf[o + x];
    dct(row, 0, n, work.scratch, 0, inverse);
    for (let x = 0; x < n; x++) buf[o + x] = row[x];
}

function dctColumn(buf: Float32Array, o: number, stride: number, n: number, inverse: boolean): void {
    if (inverse && n <= 32 && n >= 8) {
        (n === 8 ? idct8 : n === 16 ? idct16 : idct32)(buf, o, stride);
        return;
    }
    const row = work.row;
    for (let y = 0; y < n; y++) row[y] = buf[o + y * stride];
    dct(row, 0, n, work.scratch, 0, inverse);
    for (let y = 0; y < n; y++) buf[o + y * stride] = row[y];
}

/** A 2D DCT of a block in place (in the layout of JPEG XL's coefficients: wider than high, square blocks transposed) */
export function dct2d(b: Block, inverse: boolean): void {
    const { buf, offset, stride, w, h } = b;
    if (w * h <= 1) return;
    const mul = inverse ? 1 : 0.5;
    const at = (x: number, y: number): number => offset + y * stride + x;
    if ((w === 2 && h === 1) || (w === 1 && h === 2)) {
        const p = at(0, 0), q = w === 2 ? at(1, 0) : at(0, 1), v0 = buf[p], v1 = buf[q];
        buf[p] = (v0 + v1) * mul;
        buf[q] = (v0 - v1) * mul;
        return;
    }
    if (w === 2 && h === 2) {
        const v00 = buf[at(0, 0)], v01 = buf[at(1, 0)], v10 = buf[at(0, 1)], v11 = buf[at(1, 1)], m = mul * mul;
        buf[at(0, 0)] = (v00 + v01 + v10 + v11) * m;
        buf[at(1, 0)] = (v00 - v01 + v10 - v11) * m;
        buf[at(0, 1)] = (v00 + v01 - v10 - v11) * m;
        buf[at(1, 1)] = (v00 - v01 - v10 + v11) * m;
        return;
    }
    if (inverse && w === 8 && h === 8) {
        // (rows, then columns)
        for (let y = 0; y < 8; y++) idct8(buf, offset + y * stride, 1);
        for (let x = 0; x < 8; x++) idct8(buf, offset + x, stride);
        return;
    }
    const rowDct = (y: number, n: number, x0 = 0): void => dctRow(buf, offset + y * stride + x0, n, inverse);
    const colDct = (x: number, n: number): void => dctColumn(buf, offset + x, stride, n, inverse);
    if (h === 1) {
        rowDct(0, w);
        return;
    }
    if (w === 1) {
        colDct(0, h);
        return;
    }
    if (h === 2) {
        for (let x = 0; x < w; x++) {
            const p = at(x, 0), q = at(x, 1), v0 = buf[p], v1 = buf[q];
            buf[p] = (v0 + v1) * mul;
            buf[q] = (v0 - v1) * mul;
        }
        rowDct(0, w);
        rowDct(1, w);
        return;
    }
    if (w === 2) {
        for (let y = 0; y < h; y++) {
            const p = at(0, y), q = at(1, y), v0 = buf[p], v1 = buf[q];
            buf[p] = (v0 + v1) * mul;
            buf[q] = (v0 - v1) * mul;
        }
        colDct(0, h);
        colDct(1, h);
        return;
    }
    for (let y = 0; y < h; y++) rowDct(y, w);
    // (the square blocks of the size of the shorter side transposed, then the columns transformed as rows)
    const size = Math.min(w, h);
    const transposeSquares = (): void => {
        for (let by = 0; by < h; by += size) {
            for (let bx = 0; bx < w; bx += size) {
                for (let dy = 0; dy < size; dy++) {
                    for (let dx = dy + 1; dx < size; dx++) {
                        const p = at(bx + dx, by + dy), q = at(bx + dy, by + dx), t = buf[p];
                        buf[p] = buf[q];
                        buf[q] = t;
                    }
                }
            }
        }
    };
    transposeSquares();
    if (size === h) {
        for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0 += h) rowDct(y, h, x0);
    } else {
        // (rows of w values, h / w of them make a column)
        const col = work.col, scratch = work.scratch;
        for (let y = 0; y < w; y++) {
            for (let k = 0; k < h / size; k++) {
                const p = at(0, y + k * size);
                for (let x = 0; x < w; x++) col[k * w + x] = buf[p + x];
            }
            dct(col, 0, h, scratch, 0, inverse);
            for (let k = 0; k < h / size; k++) {
                const p = at(0, y + k * size);
                for (let x = 0; x < w; x++) buf[p + x] = col[k * w + x];
            }
        }
    }
    transposeSquares();
}

// the DCT scale factors of the LF of large varblocks (for c up to 32 of a 256 point DCT)
const SCALE_F = [
    1.0000000000000000, 0.9996047255830407, 0.9984194528776054, 0.9964458326264695, 0.9936866130906366,
    0.9901456355893141, 0.9858278282666936, 0.9807391980963174, 0.9748868211368796, 0.9682788310563117,
    0.9609244059440204, 0.9528337534340876, 0.9440180941651672, 0.9344896436056892, 0.9242615922757944,
    0.9133480844001980, 0.9017641950288744, 0.8895259056651056, 0.8766500784429904, 0.8631544288990163,
    0.8490574973847023, 0.8343786191696513, 0.8191378932865928, 0.8033561501721485, 0.7870549181591013,
    0.7702563888779096, 0.7529833816270532, 0.7352593067735488, 0.7171081282466044, 0.6985543251889097,
    0.6796228528314652, 0.6603391026591464
];

export const scaleF = (c: number, logb: number): number => SCALE_F[c << logb];

// ---- the 8x8 transforms other than the DCT

const sub = (b: Block, x: number, y: number, w: number, h: number): Block => ({ buf: b.buf, offset: b.offset + y * b.stride + x, stride: b.stride, w, h });
const get = (b: Block, x: number, y: number): number => b.buf[b.offset + y * b.stride + x];
const set = (b: Block, x: number, y: number, v: number): void => {
    b.buf[b.offset + y * b.stride + x] = v;
};
const tmp = { a: new Float32Array(64), b: new Float32Array(64) };
const blockOf = (buf: Float32Array, offset: number, w: number, h: number, stride = w): Block => ({ buf, offset, stride, w, h });

function idct2InPlace(b: Block, size: number): void {
    const half = size / 2, s = tmp.a;
    for (let y = 0; y < half; y++) {
        for (let x = 0; x < half; x++) {
            const c00 = get(b, x, y), c01 = get(b, x + half, y), c10 = get(b, x, y + half), c11 = get(b, x + half, y + half);
            s[2 * y * 8 + 2 * x] = c00 + c01 + c10 + c11;
            s[2 * y * 8 + 2 * x + 1] = c00 + c01 - c10 - c11;
            s[(2 * y + 1) * 8 + 2 * x] = c00 - c01 + c10 - c11;
            s[(2 * y + 1) * 8 + 2 * x + 1] = c00 - c01 - c10 + c11;
        }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(b, x, y, s[y * 8 + x]);
}

function dct2(b: Block): void {
    idct2InPlace(b, 2);
    idct2InPlace(b, 4);
    idct2InPlace(b, 8);
}

function dct4x4(b: Block): void {
    idct2InPlace(b, 2);
    const s = tmp.b;
    for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
            const o = (y * 2 + x) * 16;
            // (transposed)
            for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) s[o + ix * 4 + iy] = get(b, x + ix * 2, y + iy * 2);
            dct2d(blockOf(s, o, 4, 4), true);
        }
    }
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) set(b, x * 4 + ix, y * 4 + iy, s[(y * 2 + x) * 16 + iy * 4 + ix]);
}

function hornuss(b: Block): void {
    idct2InPlace(b, 2);
    const s = tmp.b;
    for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
            const o = (y * 2 + x) * 16;
            for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) s[o + iy * 4 + ix] = get(b, x + ix * 2, y + iy * 2);
            let residual = 0;
            for (let i = 1; i < 16; i++) residual += s[o + i];
            const avg = s[o] - residual / 16;
            s[o] = s[o + 5];
            s[o + 5] = 0;
            for (let i = 0; i < 16; i++) s[o + i] += avg;
        }
    }
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) set(b, x * 4 + ix, y * 4 + iy, s[(y * 2 + x) * 16 + iy * 4 + ix]);
}

function dct4x8(b: Block, transposed: boolean): void {
    const c0 = get(b, 0, 0), c1 = get(b, 0, 1);
    set(b, 0, 0, c0 + c1);
    set(b, 0, 1, c0 - c1);
    const s = tmp.b;
    for (let i = 0; i < 2; i++) {
        for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 8; ix++) s[i * 32 + iy * 8 + ix] = get(b, ix, iy * 2 + i);
        dct2d(blockOf(s, i * 32, 8, 4), true);
    }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        if (transposed) set(b, y, x, s[y * 8 + x]);
        else set(b, x, y, s[y * 8 + x]);
    }
}

function afv(b: Block, n: number): void {
    const flipX = n % 2, flipY = n >> 1;
    const coeffs = new Float64Array(16), samples = new Float64Array(16);
    coeffs[0] = (get(b, 0, 0) + get(b, 1, 0) + get(b, 0, 1)) * 4;
    for (let i = 1; i < 16; i++) coeffs[i] = get(b, 2 * (i % 4), 2 * (i >> 2));
    for (let i = 0; i < 16; i++) for (let k = 0; k < 16; k++) samples[k] += coeffs[i] * AFV_BASIS[i * 16 + k];
    const s4 = new Float32Array(16), s8 = new Float32Array(32);
    s4[0] = get(b, 0, 0) - get(b, 1, 0) + get(b, 0, 1);
    for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) if (ix | iy) s4[ix * 4 + iy] = get(b, 2 * ix + 1, 2 * iy);
    dct2d(blockOf(s4, 0, 4, 4), true);
    s8[0] = get(b, 0, 0) - get(b, 0, 1);
    for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 8; ix++) if (ix | iy) s8[iy * 8 + ix] = get(b, ix, 2 * iy + 1);
    dct2d(blockOf(s8, 0, 8, 4), true);
    for (let iy = 0; iy < 4; iy++) {
        const ay = flipY ? 3 - iy : iy;
        for (let ix = 0; ix < 4; ix++) set(b, flipX * 4 + ix, flipY * 4 + iy, samples[ay * 4 + (flipX ? 3 - ix : ix)]);
    }
    for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 4; ix++) set(b, (1 - flipX) * 4 + ix, flipY * 4 + iy, s4[iy * 4 + ix]);
    for (let iy = 0; iy < 4; iy++) for (let ix = 0; ix < 8; ix++) set(b, ix, (1 - flipY) * 4 + iy, s8[iy * 8 + ix]);
}

export const DCT8 = 0, HORNUSS = 1, DCT2 = 2, DCT4 = 3, DCT4X8 = 12, DCT8X4 = 13, AFV0 = 14;

/** The inverse transform of a varblock (of its type) in place */
export function inverseTransform(b: Block, type: number): void {
    switch (type) {
        case DCT2: dct2(b); break;
        case DCT4: dct4x4(b); break;
        case HORNUSS: hornuss(b); break;
        case DCT4X8: dct4x8(b, false); break;
        case DCT8X4: dct4x8(b, true); break;
        case 14: case 15: case 16: case 17: afv(b, type - 14); break;
        default: dct2d(b, true);
    }
}

export { sub as subBlock };

// the AFV basis (16 x 16)
const AFV_BASIS = [
    0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25,
    0.876902929799142, 0.2206518106944235, -0.10140050393753763, -0.1014005039375375, 0.2206518106944236, -0.10140050393753777, -0.10140050393753772, -0.10140050393753763, -0.10140050393753758, -0.10140050393753769, -0.1014005039375375, -0.10140050393753768, -0.10140050393753768, -0.10140050393753759, -0.10140050393753763, -0.10140050393753741,
    0.0, 0.0, 0.40670075830260755, 0.44444816619734445, 0.0, 0.0, 0.19574399372042936, 0.2929100136981264, -0.40670075830260716, -0.19574399372042872, 0.0, 0.11379074460448091, -0.44444816619734384, -0.29291001369812636, -0.1137907446044814, 0.0,
    0.0, 0.0, -0.21255748058288748, 0.3085497062849767, 0.0, 0.4706702258572536, -0.1621205195722993, 0.0, -0.21255748058287047, -0.16212051957228327, -0.47067022585725277, -0.1464291867126764, 0.3085497062849487, 0.0, -0.14642918671266536, 0.4251149611657548,
    0.0, -0.7071067811865474, 0.0, 0.0, 0.7071067811865476, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    -0.4105377591765233, 0.6235485373547691, -0.06435071657946274, -0.06435071657946266, 0.6235485373547694, -0.06435071657946284, -0.0643507165794628, -0.06435071657946274, -0.06435071657946272, -0.06435071657946279, -0.06435071657946266, -0.06435071657946277, -0.06435071657946277, -0.06435071657946273, -0.06435071657946274, -0.0643507165794626,
    0.0, 0.0, -0.4517556589999482, 0.15854503551840063, 0.0, -0.04038515160822202, 0.0074182263792423875, 0.39351034269210167, -0.45175565899994635, 0.007418226379244351, 0.1107416575309343, 0.08298163094882051, 0.15854503551839705, 0.3935103426921022, 0.0829816309488214, -0.45175565899994796,
    0.0, 0.0, -0.304684750724869, 0.5112616136591823, 0.0, 0.0, -0.290480129728998, -0.06578701549142804, 0.304684750724884, 0.2904801297290076, 0.0, -0.23889773523344604, -0.5112616136592012, 0.06578701549142545, 0.23889773523345467, 0.0,
    0.0, 0.0, 0.3017929516615495, 0.25792362796341184, 0.0, 0.16272340142866204, 0.09520022653475037, 0.0, 0.3017929516615503, 0.09520022653475055, -0.16272340142866173, -0.35312385449816297, 0.25792362796341295, 0.0, -0.3531238544981624, -0.6035859033230976,
    0.0, 0.0, 0.40824829046386274, 0.0, 0.0, 0.0, 0.0, -0.4082482904638628, -0.4082482904638635, 0.0, 0.0, -0.40824829046386296, 0.0, 0.4082482904638634, 0.408248290463863, 0.0,
    0.0, 0.0, 0.1747866975480809, 0.0812611176717539, 0.0, 0.0, -0.3675398009862027, -0.307882213957909, -0.17478669754808135, 0.3675398009862011, 0.0, 0.4826689115059883, -0.08126111767175039, 0.30788221395790305, -0.48266891150598584, 0.0,
    0.0, 0.0, -0.21105601049335784, 0.18567180916109802, 0.0, 0.0, 0.49215859013738733, -0.38525013709251915, 0.21105601049335806, -0.49215859013738905, 0.0, 0.17419412659916217, -0.18567180916109904, 0.3852501370925211, -0.1741941265991621, 0.0,
    0.0, 0.0, -0.14266084808807264, -0.3416446842253372, 0.0, 0.7367497537172237, 0.24627107722075148, -0.08574019035519306, -0.14266084808807344, 0.24627107722075137, 0.14883399227113567, -0.04768680350229251, -0.3416446842253373, -0.08574019035519267, -0.047686803502292804, -0.14266084808807242,
    0.0, 0.0, -0.13813540350758585, 0.3302282550303788, 0.0, 0.08755115000587084, -0.07946706605909573, -0.4613374887461511, -0.13813540350758294, -0.07946706605910261, 0.49724647109535086, 0.12538059448563663, 0.3302282550303805, -0.4613374887461554, 0.12538059448564315, -0.13813540350758452,
    0.0, 0.0, -0.17437602599651067, 0.0702790691196284, 0.0, -0.2921026642334881, 0.3623817333531167, 0.0, -0.1743760259965108, 0.36238173335311646, 0.29210266423348785, -0.4326608024727445, 0.07027906911962818, 0.0, -0.4326608024727457, 0.34875205199302267,
    0.0, 0.0, 0.11354987314994337, -0.07417504595810355, 0.0, 0.19402893032594343, -0.435190496523228, 0.21918684838857466, 0.11354987314994257, -0.4351904965232251, 0.5550443808910661, -0.25468277124066463, -0.07417504595810233, 0.2191868483885728, -0.25468277124066413, 0.1135498731499429
];
