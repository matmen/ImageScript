// OpenType font variations (OpenType 1.9, "OpenType Font Variations Overview" and the fvar, avar, gvar, cvar, HVAR,
// MVAR chapters): axes and their normalization, tuple and region scalars, item variation stores, the deltas of
// TrueType glyph points (with the interpolation of untouched points) and of control values

/** the bytes of a font's tables, read big endian */
export interface Reader {
    u8(o: number): number;
    i8(o: number): number;
    u16(o: number): number;
    i16(o: number): number;
    u32(o: number): number;
    i32(o: number): number;
}

/** a variation axis of the fvar table, in its user units */
export interface Axis {
    tag: string;
    min: number;
    default: number;
    max: number;
}

const fixed = (r: Reader, o: number): number => r.i32(o) / 65536;
const f2dot14 = (r: Reader, o: number): number => r.i16(o) / 16384;

/** the fvar table's axes */
export function parseFvar(r: Reader, fvar: number): Axis[] {
    const axesOffset = r.u16(fvar + 4), count = r.u16(fvar + 8), size = r.u16(fvar + 10);
    const axes: Axis[] = [];
    for (let i = 0; i < count; i++) {
        const o = fvar + axesOffset + i * size;
        const tag = String.fromCharCode(r.u8(o), r.u8(o + 1), r.u8(o + 2), r.u8(o + 3));
        const min = fixed(r, o + 4), def = fixed(r, o + 8), max = fixed(r, o + 12);
        axes.push({ tag, min: Math.min(min, def), default: def, max: Math.max(max, def) });
    }
    return axes;
}

/** the avar table's segment maps (version 1), per axis: pairs of normalized from and to values */
export function parseAvar(r: Reader, avar: number, axisCount: number): number[][] | null {
    if (r.u16(avar) !== 1 || r.u16(avar + 6) !== axisCount) return null;
    const maps: number[][] = [];
    let o = avar + 8;
    for (let a = 0; a < axisCount; a++) {
        const count = r.u16(o), map: number[] = [];
        for (let i = 0; i < count; i++) map.push(f2dot14(r, o + 2 + i * 4), f2dot14(r, o + 4 + i * 4));
        maps.push(map);
        o += 2 + count * 4;
    }
    return maps;
}

/**
 * Normalized coordinates (-1 to 1, 0 at the default; quantized to F2Dot14 like fonts store them) of values in the axes'
 * user units, by tag (missing axes at their default), mapped by avar's segment maps
 */
export function normalize(axes: Axis[], avar: number[][] | null, values: Record<string, number>): number[] {
    return axes.map((axis, a) => {
        const v = Math.min(Math.max(values[axis.tag] ?? axis.default, axis.min), axis.max);
        let n = v < axis.default ? (v - axis.default) / (axis.default - axis.min) : v > axis.default ? (v - axis.default) / (axis.max - axis.default) : 0;
        const map = avar?.[a];
        if (map && map.length >= 6) {
            // (piecewise linear between the map's points)
            for (let i = 2; i < map.length; i += 2) {
                if (n > map[i]) continue;
                const [x0, y0, x1, y1] = [map[i - 2], map[i - 1], map[i], map[i + 1]];
                n = x1 === x0 ? y1 : y0 + (n - x0) * (y1 - y0) / (x1 - x0);
                break;
            }
        }
        return Math.round(n * 16384) / 16384;
    });
}

/**
 * The scalar of a tuple or region (peak, start and end per axis) at normalized coordinates: 1 at its peak, falling to
 * 0 at its start and end; axes whose peak is 0 (or whose region is invalid) don't take part
 */
export function scalar(coords: number[], peak: ArrayLike<number>, start: ArrayLike<number> | null, end: ArrayLike<number> | null): number {
    let s = 1;
    for (let a = 0; a < peak.length; a++) {
        const p = peak[a];
        if (p === 0) continue;
        const v = coords[a] ?? 0, lo = start ? start[a] : Math.min(p, 0), hi = end ? end[a] : Math.max(p, 0);
        if (start && end && (lo > p || p > hi || lo < 0 && hi > 0)) continue;
        if (v === p) continue;
        if (v <= lo || v >= hi) return 0;
        s *= v < p ? (v - lo) / (p - lo) : (hi - v) / (hi - p);
    }
    return s;
}

/** An item variation store: the delta of an item (outer and inner index) at normalized coordinates */
export class ItemVariationStore {
    private readonly regions: Array<{ peak: number[], start: number[], end: number[] }> = [];
    private readonly data: Array<{ itemCount: number, wordCount: number, long: boolean, regions: number[], offset: number }> = [];
    /** the scalars of the regions at the coordinates they were last asked for */
    private scalars: Float64Array | null = null;
    private scalarsFor: number[] | null = null;

    constructor(private readonly r: Reader, store: number) {
        const regionList = store + r.u32(store + 2), count = r.u16(store + 6);
        const axisCount = r.u16(regionList), regionCount = r.u16(regionList + 2);
        for (let i = 0; i < regionCount; i++) {
            const region = { peak: [] as number[], start: [] as number[], end: [] as number[] };
            for (let a = 0; a < axisCount; a++) {
                const o = regionList + 4 + (i * axisCount + a) * 6;
                region.start.push(f2dot14(r, o));
                region.peak.push(f2dot14(r, o + 2));
                region.end.push(f2dot14(r, o + 4));
            }
            this.regions.push(region);
        }
        for (let i = 0; i < count; i++) {
            const o = store + r.u32(store + 8 + i * 4);
            const words = r.u16(o + 2), regionIndexCount = r.u16(o + 4), regions: number[] = [];
            for (let k = 0; k < regionIndexCount; k++) regions.push(r.u16(o + 6 + k * 2));
            this.data.push({ itemCount: r.u16(o), wordCount: words & 0x7fff, long: (words & 0x8000) !== 0, regions, offset: o + 6 + regionIndexCount * 2 });
        }
    }

    /** the delta of item (outer, inner), 0 for one that isn't there */
    delta(coords: number[], outer: number, inner: number): number {
        const d = this.data[outer];
        if (!d || inner >= d.itemCount) return 0;
        if (this.scalarsFor !== coords) {
            this.scalars = Float64Array.from(this.regions, region => scalar(coords, region.peak, region.start, region.end));
            this.scalarsFor = coords;
        }
        const scalars = this.scalars as Float64Array, r = this.r;
        const big = d.long ? 4 : 2, small = d.long ? 2 : 1;
        let o = d.offset + inner * (d.wordCount * big + (d.regions.length - d.wordCount) * small), delta = 0;
        for (let k = 0; k < d.regions.length; k++) {
            const s = scalars[d.regions[k]] ?? 0;
            let v: number;
            if (k < d.wordCount) {
                v = d.long ? r.i32(o) : r.i16(o);
                o += big;
            } else {
                v = d.long ? r.i16(o) : r.i8(o);
                o += small;
            }
            if (s) delta += s * v;
        }
        return delta;
    }
}

/** A delta set index map: an index (like a glyph) to an item variation store's outer and inner index */
export function deltaSetIndexMap(r: Reader, map: number): (index: number) => [number, number] {
    const format = r.u8(map), entryFormat = r.u8(map + 1);
    const count = format === 0 ? r.u16(map + 2) : r.u32(map + 2), start = map + (format === 0 ? 4 : 6);
    const size = (entryFormat >> 4 & 3) + 1, innerBits = (entryFormat & 15) + 1;
    return index => {
        if (!count) return [0, index];
        const i = Math.min(index, count - 1);
        let v = 0;
        for (let k = 0; k < size; k++) v = v * 256 + r.u8(start + i * size + k);
        return [Math.floor(v / 2 ** innerBits), v % 2 ** innerBits];
    };
}

// a tuple variation's header (gvar, cvar): its peak (and intermediate region), its point numbers (null: all), the
// offset of its serialized data
interface Tuple {
    peak: number[];
    start: number[] | null;
    end: number[] | null;
    points: number[] | null;
    data: number;
    size: number;
}

// packed point numbers at o: the numbers (null: all points) and where they end
function readPoints(r: Reader, o: number): [number[] | null, number] {
    let count = r.u8(o++);
    if (count & 0x80) count = (count & 0x7f) << 8 | r.u8(o++);
    if (!count) return [null, o];
    const points: number[] = [];
    let point = 0;
    while (points.length < count) {
        const control = r.u8(o++), words = control & 0x80, run = (control & 0x7f) + 1;
        for (let i = 0; i < run && points.length < count; i++) {
            point += words ? r.u16(o) : r.u8(o);
            o += words ? 2 : 1;
            points.push(point);
        }
    }
    return [points, o];
}

// n packed deltas at o, and where they end
function readDeltas(r: Reader, o: number, n: number): [Int32Array, number] {
    const deltas = new Int32Array(n);
    for (let i = 0; i < n;) {
        const control = r.u8(o++), run = (control & 0x3f) + 1;
        for (let k = 0; k < run && i < n; k++, i++) {
            if (control & 0x80) deltas[i] = 0;
            else if (control & 0x40) {
                deltas[i] = r.i16(o);
                o += 2;
            } else deltas[i] = r.i8(o++);
        }
    }
    return [deltas, o];
}

// the tuple variations of serialized variation data (gvar's glyph variation data, cvar): count, data offset, headers
function readTuples(r: Reader, base: number, header: number, axisCount: number, sharedTuples: number[][]): Tuple[] {
    const countField = r.u16(header), count = countField & 0xfff, dataOffset = r.u16(header + 2);
    let h = header + 4, data = base + dataOffset;
    let shared: number[] | null = null;
    if (countField & 0x8000) [shared, data] = readPoints(r, data);
    const tuples: Tuple[] = [];
    for (let i = 0; i < count; i++) {
        const size = r.u16(h), index = r.u16(h + 2);
        h += 4;
        let peak: number[];
        if (index & 0x8000) {
            peak = Array.from({ length: axisCount }, (_, a) => f2dot14(r, h + a * 2));
            h += axisCount * 2;
        } else peak = sharedTuples[index & 0xfff] ?? new Array<number>(axisCount).fill(0);
        let start: number[] | null = null, end: number[] | null = null;
        if (index & 0x4000) {
            start = Array.from({ length: axisCount }, (_, a) => f2dot14(r, h + a * 2));
            end = Array.from({ length: axisCount }, (_, a) => f2dot14(r, h + axisCount * 2 + a * 2));
            h += axisCount * 4;
        }
        let points = shared, d = data;
        if (index & 0x2000) [points, d] = readPoints(r, data);
        tuples.push({ peak, start, end, points, data: d, size: size - (d - data) });
        data += size;
    }
    return tuples;
}

/** The gvar table: the deltas of a glyph's points at normalized coordinates */
export class Gvar {
    private readonly axisCount: number;
    private readonly sharedTuples: number[][] = [];
    private readonly glyphCount: number;
    private readonly long: boolean;
    private readonly offsets: number;
    private readonly dataStart: number;

    constructor(private readonly r: Reader, gvar: number) {
        this.axisCount = r.u16(gvar + 4);
        const sharedCount = r.u16(gvar + 6), shared = gvar + r.u32(gvar + 8);
        for (let i = 0; i < sharedCount; i++) this.sharedTuples.push(Array.from({ length: this.axisCount }, (_, a) => f2dot14(r, shared + (i * this.axisCount + a) * 2)));
        this.glyphCount = r.u16(gvar + 12);
        this.long = (r.u16(gvar + 14) & 1) !== 0;
        this.dataStart = gvar + r.u32(gvar + 16);
        this.offsets = gvar + 20;
    }

    /**
     * The deltas (x then y, per point) of a glyph's points (its points and 4 phantom points: n of them) at normalized
     * coordinates, with the untouched points of a tuple interpolated from the touched ones of their contour (ends:
     * the contours' last points; null for composite glyphs, whose untouched components stay); null without variations
     */
    deltas(glyph: number, coords: number[], n: number, ends: number[] | null, xs: ArrayLike<number>, ys: ArrayLike<number>): Float64Array | null {
        if (glyph >= this.glyphCount || coords.every(c => c === 0)) return null;
        const r = this.r;
        const offset = (i: number): number => this.long ? r.u32(this.offsets + i * 4) : r.u16(this.offsets + i * 2) * 2;
        const start = offset(glyph), end = offset(glyph + 1);
        if (end <= start) return null;
        const base = this.dataStart + start;
        const out = new Float64Array(2 * n);
        let any = false;
        for (const t of readTuples(r, base, base, this.axisCount, this.sharedTuples)) {
            const s = scalar(coords, t.peak, t.start, t.end);
            if (!s) continue;
            const count = t.points ? t.points.length : n;
            const [dx, after] = readDeltas(r, t.data, count), [dy] = readDeltas(r, after, count);
            any = true;
            if (!t.points) {
                for (let i = 0; i < n; i++) {
                    out[2 * i] += s * dx[i];
                    out[2 * i + 1] += s * dy[i];
                }
                continue;
            }
            // (touched points; with contours, the others interpolated)
            const tx = new Float64Array(n), ty = new Float64Array(n), touched = new Uint8Array(n);
            t.points.forEach((p, k) => {
                if (p >= n) return;
                tx[p] = dx[k];
                ty[p] = dy[k];
                touched[p] = 1;
            });
            if (ends) interpolateUntouched(tx, ty, touched, ends, xs, ys);
            for (let i = 0; i < n; i++) {
                out[2 * i] += s * tx[i];
                out[2 * i + 1] += s * ty[i];
            }
        }
        return any ? out : null;
    }
}

// infers the deltas of untouched points (IUP) per contour, along x and along y, from the touched ones around them: as
// they are where the point lies between theirs, else the nearer one's (only touched points of a contour: their delta
// for all)
function interpolateUntouched(dx: Float64Array, dy: Float64Array, touched: Uint8Array, ends: number[], xs: ArrayLike<number>, ys: ArrayLike<number>): void {
    let first = 0;
    for (const last of ends) {
        let firstTouched = -1;
        for (let i = first; i <= last; i++) if (touched[i]) { firstTouched = i; break; }
        if (firstTouched >= 0) {
            for (const [d, c] of [[dx, xs], [dy, ys]] as Array<[Float64Array, ArrayLike<number>]>) {
                let prev = firstTouched;
                for (let k = 1; k <= last - first + 1; k++) {
                    const i = first + (firstTouched - first + k) % (last - first + 1);
                    if (!touched[i]) continue;
                    infer(d, c, prev, i, first, last);
                    prev = i;
                }
            }
        }
        first = last + 1;
    }
}

// the untouched points strictly between touched points a and b (going forward in the contour, wrapping): references at
// the same coordinate give their delta if it's the same, else 0
function infer(d: Float64Array, c: ArrayLike<number>, a: number, b: number, first: number, last: number): void {
    const ca = c[a], cb = c[b], da = d[a], db = d[b];
    const lo = Math.min(ca, cb), hi = Math.max(ca, cb), dlo = ca <= cb ? da : db, dhi = ca <= cb ? db : da;
    for (let i = a === last ? first : a + 1; i !== b; i = i === last ? first : i + 1) {
        const v = c[i];
        d[i] = lo === hi ? (da === db ? da : 0) : v <= lo ? dlo : v >= hi ? dhi : dlo + (v - lo) * (dhi - dlo) / (hi - lo);
    }
}

/** The cvar table: the deltas of the control value table's values at normalized coordinates */
export function cvarDeltas(r: Reader, cvar: number, axisCount: number, coords: number[], count: number): Float64Array | null {
    if (coords.every(c => c === 0)) return null;
    const out = new Float64Array(count);
    let any = false;
    for (const t of readTuples(r, cvar, cvar + 4, axisCount, [])) {
        const s = scalar(coords, t.peak, t.start, t.end);
        if (!s) continue;
        const points = t.points ?? Array.from({ length: count }, (_, i) => i);
        const [deltas] = readDeltas(r, t.data, points.length);
        points.forEach((p, k) => {
            if (p < count) out[p] += s * deltas[k];
        });
        any = true;
    }
    return any ? out : null;
}
