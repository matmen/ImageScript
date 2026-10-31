import { decompress } from '../codecs/zlib.ts';
import { type Axis, Gvar, ItemVariationStore, cvarDeltas, deltaSetIndexMap, normalize, parseAvar, parseFvar } from './variations.ts';


/**
 * A path command in font units (y up) or user units:
 * ['M', x, y], ['L', x, y], ['Q', cx, cy, x, y], ['C', c1x, c1y, c2x, c2y, x, y], ['Z']
 */
export type PathCommand = [string, ...number[]];

/** a TrueType glyph's points (font units) and instructions, for hinting */
export interface GlyfPoints {
    xs: number[];
    ys: number[];
    /** on curve flags */
    on: boolean[];
    /** index of the last point of every contour */
    ends: number[];
    instructions: Uint8Array;
    /** glyph bounding box minimum x (the left side bearing's reference) */
    xMin: number;
    /** components of composite glyphs (their points are not included in xs/ys) */
    components: Array<{ glyph: number, dx: number, dy: number, matrix: [number, number, number, number], round: boolean, match: [number, number] | null, useMetrics: boolean }> | null;
}

interface CFF {
    charStrings: Uint8Array[];
    globalSubrs: Uint8Array[];
    privateFor: (glyph: number) => { subrs: Uint8Array[] };
}

type Dict = Record<number, number[]>;

// a variable font's tables (parsed when first needed)
interface VariationTables {
    avar: number[][] | null;
    gvar: Gvar | null;
    /** HVAR: the item variation store and the advance widths' mapping (null: by glyph index) */
    hvar: { store: ItemVariationStore, advances: ((glyph: number) => [number, number]) | null } | null;
    /** MVAR: its item variation store and the items of the values by tag */
    mvar: { store: ItemVariationStore, records: Map<string, [number, number]> } | null;
    /** GDEF's item variation store (for GPOS's variation indices) */
    gdef: ItemVariationStore | null;
}

// the most path commands of a glyph outline
const MAX_COMMANDS = 100000;

/**
 * Parses TrueType (glyf) and OpenType (CFF) fonts, including the first font of a collection
 */
export class Font {
    data: Uint8Array;
    view: DataView;
    tables: Record<string, { offset: number, length: number }>;
    unitsPerEm: number;
    indexToLocFormat: number;
    ascender: number;
    descender: number;
    lineGap: number;
    numberOfHMetrics: number;
    numGlyphs: number;
    /** where the glyph outlines come from ('none' for fonts with only bitmap glyphs) */
    outlines: 'glyf' | 'cff' | 'none';
    cff: CFF | null = null;
    cmap: (codepoint: number) => number;
    outlineCache: Map<number, PathCommand[]>;
    /** the kern table's kerning between two glyphs in font units (null without one) */
    kernTable: ((left: number, right: number) => number) | null;
    /** glyphs for variation sequences (cmap format 14): the glyph, -1 for the default one, 0 if the font has none */
    variation: ((codepoint: number, selector: number) => number) | null;
    /** a variable font's axes (fvar; none for other fonts) */
    axes: Axis[];
    /** the normalized coordinates of this instance of a variable font, empty for its default instance */
    coords: number[] = [];
    private variationTables: VariationTables | null = null;
    /** a variable font's instances by their coordinates (kept on the font they come from) */
    private instances: Map<string, Font> | null = null;

    constructor(data: Uint8Array) {
        // 'wOFF': the TrueType or OpenType font it compresses; 'wOF2' (Brotli) isn't everywhere yet
        const woff = data.length >= 4 ? (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0 : 0;
        if (woff === 0x774f4646) data = fromWOFF(data);
        else if (woff === 0x774f4632) throw new Error('Font: WOFF2 fonts are not supported, only WOFF');
        this.data = data;
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        let offset = 0;
        const signature = this.u32(0);
        if (signature === 0x74746366) offset = this.u32(12); // 'ttcf', use the first font

        const version = this.u32(offset);
        if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) throw new Error('Font: invalid font file');

        this.tables = {};
        const count = this.u16(offset + 4);
        for (let i = 0; i < count; i++) {
            const record = offset + 12 + i * 16;
            const tag = String.fromCharCode(...data.subarray(record, record + 4));
            this.tables[tag] = { offset: this.u32(record + 8), length: this.u32(record + 12) };
        }

        for (const tag of ['head', 'hhea', 'hmtx', 'maxp', 'cmap'])
            if (!this.tables[tag]) throw new Error(`Font: missing ${tag} table`);

        const head = this.tables.head.offset;
        this.unitsPerEm = this.u16(head + 18);
        this.indexToLocFormat = this.i16(head + 50);

        const hhea = this.tables.hhea.offset;
        this.ascender = this.i16(hhea + 4);
        this.descender = this.i16(hhea + 6);
        this.lineGap = this.i16(hhea + 8);
        this.numberOfHMetrics = this.u16(hhea + 34);

        this.numGlyphs = this.u16(this.tables.maxp.offset + 4);

        if (this.tables.glyf && this.tables.loca) this.outlines = 'glyf';
        else if (this.tables['CFF ']) {
            this.outlines = 'cff';
            this.cff = parseCFF(this, this.tables['CFF '].offset);
        } else if (this.tables.CFF2) throw new Error('Font: CFF2 outlines are not supported');
        else if (this.tables.CBDT && this.tables.CBLC || this.tables.sbix) this.outlines = 'none';
        else throw new Error('Font: no supported glyph outlines');

        this.cmap = parseCmap(this, this.tables.cmap.offset);
        this.outlineCache = new Map();
        this.kernTable = this.tables.kern && parseKern(this, this.tables.kern.offset) || null;
        this.variation = parseVariations(this, this.tables.cmap.offset);
        this.axes = this.tables.fvar ? parseFvar(this, this.tables.fvar.offset) : [];
    }

    /** the variation tables, parsed the first time */
    private get vary(): VariationTables {
        if (this.variationTables) return this.variationTables;
        const t = this.tables, at = (tag: string): number => t[tag].offset;
        const hvar = t.HVAR ? (() => {
            const o = at('HVAR'), map = this.u32(o + 8);
            return { store: new ItemVariationStore(this, o + this.u32(o + 4)), advances: map ? deltaSetIndexMap(this, o + map) : null };
        })() : null;
        const mvar = t.MVAR && this.u16(at('MVAR') + 10) ? (() => {
            const o = at('MVAR'), size = this.u16(o + 6), count = this.u16(o + 8), records = new Map<string, [number, number]>();
            for (let i = 0; i < count; i++) {
                const r = o + 12 + i * size;
                records.set(String.fromCharCode(...this.data.subarray(r, r + 4)), [this.u16(r + 4), this.u16(r + 6)]);
            }
            return { store: new ItemVariationStore(this, o + this.u16(o + 10)), records };
        })() : null;
        const gdef = t.GDEF && this.u16(at('GDEF') + 2) >= 3 && this.u32(at('GDEF') + 14) ? new ItemVariationStore(this, at('GDEF') + this.u32(at('GDEF') + 14)) : null;
        // (shared by the instances: stored on the font they come from)
        const base = Object.getPrototypeOf(this) instanceof Font ? Object.getPrototypeOf(this) as Font : this;
        base.variationTables = {
            avar: t.avar ? parseAvar(this, at('avar'), this.axes.length) : null,
            gvar: t.gvar && this.outlines === 'glyf' ? new Gvar(this, at('gvar')) : null,
            hvar, mvar, gdef,
        };
        return base.variationTables;
    }

    /**
     * An instance of a variable font at axis values in their user units by tag (like wght: 700; missing axes at their
     * default, values clamped to the axes' ranges): the font itself for fonts without axes or at the default
     */
    withVariations(values: Record<string, number>): Font {
        if (!this.axes.length) return this;
        const coords = normalize(this.axes, this.vary.avar, values);
        if (coords.every(c => c === 0)) return Object.getPrototypeOf(this) instanceof Font ? Object.getPrototypeOf(this) as Font : this;
        const base = Object.getPrototypeOf(this) instanceof Font ? Object.getPrototypeOf(this) as Font : this;
        const key = coords.join(',');
        const cached = base.instances?.get(key);
        if (cached) return cached;
        const instance = Object.create(base) as Font;
        (base.instances ??= new Map()).set(key, instance);
        instance.coords = coords;
        instance.outlineCache = new Map();
        // (the metrics MVAR varies)
        const metric = (tag: string, value: number): number => {
            const item = this.vary.mvar?.records.get(tag);
            return item ? value + (this.vary.mvar as { store: ItemVariationStore }).store.delta(coords, item[0], item[1]) : value;
        };
        instance.ascender = metric('hasc', base.ascender);
        instance.descender = metric('hdsc', base.descender);
        instance.lineGap = metric('hlgn', base.lineGap);
        return instance;
    }

    /** the delta of GDEF's item (outer, inner) at this instance's coordinates (for GPOS's device tables), 0 without */
    variationDelta(outer: number, inner: number): number {
        return this.coords.length && this.vary.gdef ? this.vary.gdef.delta(this.coords, outer, inner) : 0;
    }

    /** the deltas of the control values (cvar) at this instance's coordinates, null without */
    cvtDeltas(count: number): Float64Array | null {
        return this.coords.length && this.tables.cvar ? cvarDeltas(this, this.tables.cvar.offset, this.axes.length, this.coords, count) : null;
    }

    u8(o: number): number { return this.data[o]; }
    i8(o: number): number { return this.view.getInt8(o); }
    u16(o: number): number { return this.view.getUint16(o); }
    i16(o: number): number { return this.view.getInt16(o); }
    u32(o: number): number { return this.view.getUint32(o); }
    i32(o: number): number { return this.view.getInt32(o); }

    /**
     * @param {number} codepoint
     * @return {number} glyph index, 0 (.notdef) if the font has no glyph for it
     */
    glyphIndex(codepoint: number): number {
        return this.cmap(codepoint) || 0;
    }

    /**
     * @param {number} glyph
     * @return {number} advance width in font units
     */
    advance(glyph: number): number {
        const hmtx = this.tables.hmtx.offset;
        const index = Math.min(glyph, this.numberOfHMetrics - 1);
        const advance = this.u16(hmtx + index * 4);
        if (!this.coords.length) return advance;
        // (varied: by HVAR, else by gvar's phantom points)
        const hvar = this.vary.hvar;
        if (hvar) {
            const [outer, inner] = hvar.advances ? hvar.advances(glyph) : [0, glyph];
            return advance + hvar.store.delta(this.coords, outer, inner);
        }
        const phantom = this.phantomDeltas(glyph);
        return phantom ? advance + phantom[2] - phantom[0] : advance;
    }

    // the deltas (x, y) of a glyph's 4 phantom points (origin, advance, top, bottom) at this instance's coordinates
    private phantomDeltas(glyph: number): Float64Array | null {
        const varied = this.varied(glyph);
        return varied && varied.deltas && varied.deltas.subarray(2 * varied.count);
    }

    // a TrueType glyph's points (or its components' offsets) at this instance's coordinates: the default ones and their
    // deltas (count points, then the 4 phantom ones); null for empty or damaged glyphs
    private varied(glyph: number): { count: number, deltas: Float64Array | null, simple: { xs: Int32Array, ys: Int32Array, flags: Uint8Array, ends: number[], instructions: Uint8Array } | null } | null {
        if (this.outlines !== 'glyf' || glyph >= this.numGlyphs) return null;
        const offset = this.glyfOffset(glyph);
        const gvar = this.coords.length ? this.vary.gvar : null;
        if (offset < 0) return { count: 0, deltas: gvar ? gvar.deltas(glyph, this.coords, 4, null, [], []) : null, simple: null };
        const contours = this.i16(offset);
        if (contours < 0) {
            const count = this.components(offset).components.length;
            return { count, deltas: gvar ? gvar.deltas(glyph, this.coords, count + 4, null, [], []) : null, simple: null };
        }
        const simple = this.simplePoints(offset, contours);
        if (!simple) return null;
        const count = simple.xs.length;
        return { count, deltas: gvar ? gvar.deltas(glyph, this.coords, count + 4, simple.ends, simple.xs, simple.ys) : null, simple };
    }

    /** the glyph for a variation sequence, 0 if the font has none */
    variationGlyph(codepoint: number, selector: number): number {
        const glyph = this.variation ? this.variation(codepoint, selector) : 0;
        return glyph < 0 ? this.glyphIndex(codepoint) : glyph;
    }

    /** a glyph's ink box in font units (the glyf header's for TrueType outlines), null if it has none */
    extents(glyph: number): { xMin: number, yMin: number, xMax: number, yMax: number } | null {
        // (varied glyphs: their outline's)
        if (this.outlines === 'glyf' && glyph < this.numGlyphs && !this.coords.length) {
            const o = this.glyfOffset(glyph);
            if (o < 0) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
            return { xMin: this.i16(o + 2), yMin: this.i16(o + 4), xMax: this.i16(o + 6), yMax: this.i16(o + 8) };
        }
        let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
        for (const command of this.outline(glyph))
            for (let i = 1; i < command.length; i += 2) {
                const x = command[i] as number, y = command[i + 1] as number;
                xMin = Math.min(xMin, x);
                xMax = Math.max(xMax, x);
                yMin = Math.min(yMin, y);
                yMax = Math.max(yMax, y);
            }
        return xMax >= xMin ? { xMin, yMin, xMax, yMax } : { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    }

    /** left side bearing in font units */
    leftSideBearing(glyph: number): number {
        const hmtx = this.tables.hmtx.offset;
        if (glyph < this.numberOfHMetrics) return this.i16(hmtx + glyph * 4 + 2);
        return this.i16(hmtx + this.numberOfHMetrics * 4 + (glyph - this.numberOfHMetrics) * 2);
    }

    /**
     * A TrueType glyph's points and instructions (null for empty glyphs or CFF fonts)
     */
    glyfPoints(glyph: number): GlyfPoints | null {
        if (this.outlines !== 'glyf' || glyph >= this.numGlyphs) return null;
        const offset = this.glyfOffset(glyph);
        if (offset < 0) return null;
        const contourCount = this.i16(offset);
        const xMin = this.i16(offset + 2);

        // (varied: the points and component offsets moved by their deltas, rounded to font units like FreeType does,
        // the origin by the first phantom point's)
        const varied = this.coords.length ? this.varied(glyph) : null, d = varied?.deltas;
        const at = (i: number, axis: number): number => d ? Math.round(d[2 * i + axis]) : 0;
        const origin = d && varied ? at(varied.count, 0) : 0;

        if (contourCount < 0) {
            const { components, end } = this.components(offset);
            const instructions = components[components.length - 1].flags & 0x100 ? this.data.subarray(end + 2, end + 2 + this.u16(end)) : new Uint8Array(0);
            return {
                xs: [], ys: [], on: [], ends: [], instructions, xMin: xMin + origin,
                components: components.map(({ glyph, flags, arg1, arg2, matrix }, i) => ({
                    glyph, dx: flags & 2 ? arg1 + at(i, 0) : 0, dy: flags & 2 ? arg2 + at(i, 1) : 0, matrix,
                    round: (flags & 4) !== 0, match: flags & 2 ? null : [arg1, arg2], useMetrics: (flags & 0x200) !== 0,
                })),
            };
        }

        const points = this.simplePoints(offset, contourCount);
        if (!points) return null;
        const { xs, ys, flags, ends, instructions } = points;
        return {
            xs: Array.from(xs, (x, i) => x + at(i, 0)), ys: Array.from(ys, (y, i) => y + at(i, 1)), on: Array.from(flags, f => (f & 1) === 1), ends,
            instructions, xMin: xMin + origin, components: null,
        };
    }

    /** where a glyph's glyf data starts, -1 for empty glyphs */
    private glyfOffset(glyph: number): number {
        const loca = this.tables.loca.offset;
        const start = this.indexToLocFormat ? this.u32(loca + glyph * 4) : this.u16(loca + glyph * 2) * 2;
        const end = this.indexToLocFormat ? this.u32(loca + glyph * 4 + 4) : this.u16(loca + glyph * 2 + 2) * 2;
        return end > start ? this.tables.glyf.offset + start : -1;
    }

    /**
     * A simple glyph's points: coordinates, flags, the last point of every contour and the instructions; null for
     * damaged glyphs whose contours don't end at increasing points (FreeType rejects them)
     */
    private simplePoints(offset: number, contourCount: number): { xs: Int32Array, ys: Int32Array, flags: Uint8Array, ends: number[], instructions: Uint8Array } | null {
        const ends: number[] = [];
        for (let i = 0; i < contourCount; i++) {
            const end = this.u16(offset + 10 + i * 2);
            if (i && end <= ends[i - 1]) return null;
            ends.push(end);
        }
        const pointCount = contourCount ? ends[contourCount - 1] + 1 : 0;

        let p = offset + 10 + contourCount * 2;
        const instructionLength = this.u16(p);
        const instructions = this.data.subarray(p + 2, p + 2 + instructionLength);
        p += 2 + instructionLength;

        const flags = new Uint8Array(pointCount);
        for (let i = 0; i < pointCount;) {
            const flag = this.u8(p++);
            flags[i++] = flag;
            if (flag & 8) for (let repeat = this.u8(p++); repeat > 0 && i < pointCount; repeat--) flags[i++] = flag;
        }

        const xs = new Int32Array(pointCount), ys = new Int32Array(pointCount);
        for (const [coords, short, same] of [[xs, 2, 16], [ys, 4, 32]] as Array<[Int32Array, number, number]>) {
            let value = 0;
            for (let i = 0; i < pointCount; i++) {
                const flag = flags[i];
                if (flag & short) {
                    const delta = this.u8(p++);
                    value += flag & same ? delta : -delta;
                } else if (!(flag & same)) {
                    value += this.i16(p);
                    p += 2;
                }
                coords[i] = value;
            }
        }
        return { xs, ys, flags, ends, instructions };
    }

    /** a composite glyph's components (flags, arguments and transform), and where its instructions start */
    private components(offset: number): { components: Array<{ glyph: number, flags: number, arg1: number, arg2: number, matrix: [number, number, number, number] }>, end: number } {
        const components = [];
        const f2dot14 = (o: number): number => this.i16(o) / 16384;
        let p = offset + 10, flags = 0;
        do {
            flags = this.u16(p);
            const glyph = this.u16(p + 2);
            p += 4;
            let arg1, arg2;
            if (flags & 1) {
                arg1 = flags & 2 ? this.i16(p) : this.u16(p);
                arg2 = flags & 2 ? this.i16(p + 2) : this.u16(p + 2);
                p += 4;
            } else {
                arg1 = flags & 2 ? this.i8(p) : this.u8(p);
                arg2 = flags & 2 ? this.i8(p + 1) : this.u8(p + 1);
                p += 2;
            }
            let matrix: [number, number, number, number] = [1, 0, 0, 1];
            if (flags & 8) {
                const scale = f2dot14(p);
                matrix = [scale, 0, 0, scale];
                p += 2;
            } else if (flags & 0x40) {
                matrix = [f2dot14(p), 0, 0, f2dot14(p + 2)];
                p += 4;
            } else if (flags & 0x80) {
                matrix = [f2dot14(p), f2dot14(p + 2), f2dot14(p + 4), f2dot14(p + 6)];
                p += 8;
            }
            components.push({ glyph, flags, arg1, arg2, matrix });
        } while (flags & 0x20);
        return { components, end: p };
    }

    /**
     * @param {number} glyph
     * @return {Array} path commands in font units
     */
    outline(glyph: number): PathCommand[] {
        if (glyph >= this.numGlyphs) glyph = 0;
        let path = this.outlineCache.get(glyph);
        if (!path) {
            path = this.outlines === 'glyf' ? this.glyfOutline(glyph, { expanding: new Set(), budget: MAX_COMMANDS }) : this.outlines === 'cff' ? this.cffOutline(glyph) : [];
            this.outlineCache.set(glyph, path);
        }
        return path;
    }

    /**
     * @param expanding the composite glyphs being expanded (a glyph doesn't contain itself), and how many commands are
     *     left (damaged composites can multiply each other's components endlessly)
     */
    glyfOutline(glyph: number, expanding: { expanding: Set<number>, budget: number }): PathCommand[] {
        if (expanding.expanding.has(glyph) || expanding.expanding.size > 8 || expanding.budget <= 0) return [];
        const offset = this.glyfOffset(glyph);
        if (offset < 0) return [];
        const contours = this.i16(offset);

        if (contours >= 0) {
            const path = this.simpleGlyph(offset, contours, glyph);
            expanding.budget -= path.length;
            return expanding.budget >= 0 ? path : [];
        }
        expanding.expanding.add(glyph);
        const path = this.compositeGlyph(offset, expanding, glyph);
        expanding.expanding.delete(glyph);
        return path;
    }

    simpleGlyph(offset: number, contourCount: number, glyph: number): PathCommand[] {
        // (damaged glyphs are left empty)
        const points = this.simplePoints(offset, contourCount);
        if (!points) return [];
        let xs: ArrayLike<number> = points.xs, ys: ArrayLike<number> = points.ys;
        // (varied: the points moved by their deltas)
        const d = this.coords.length ? this.varied(glyph)?.deltas : null;
        if (d) {
            xs = Float64Array.from(points.xs, (x, i) => x + d[2 * i]);
            ys = Float64Array.from(points.ys, (y, i) => y + d[2 * i + 1]);
        }
        const path: PathCommand[] = [];
        let first = 0;
        for (const last of points.ends) {
            contourToPath(path, xs, ys, points.flags, first, last);
            first = last + 1;
        }
        return path;
    }

    compositeGlyph(offset: number, expanding: { expanding: Set<number>, budget: number }, composite: number): PathCommand[] {
        const path: PathCommand[] = [];
        // (varied: the components' offsets moved by their deltas)
        const deltas = this.coords.length ? this.varied(composite)?.deltas : null;
        for (const [k, { glyph, flags, arg1, arg2, matrix: [a, b, c, d] }] of this.components(offset).components.entries()) {
            // point matching (ARGS_ARE_XY_VALUES unset) is rare, treated as no offset
            const dx = flags & 2 ? arg1 + (deltas ? deltas[2 * k] : 0) : 0, dy = flags & 2 ? arg2 + (deltas ? deltas[2 * k + 1] : 0) : 0;
            for (const command of this.glyfOutline(glyph, expanding)) {
                const transformed: PathCommand = [command[0]];
                for (let i = 1; i < command.length; i += 2) {
                    const x = command[i] as number, y = command[i + 1] as number;
                    transformed.push(a * x + c * y + dx, b * x + d * y + dy);
                }
                path.push(transformed);
            }
        }
        return path;
    }

    cffOutline(glyph: number): PathCommand[] {
        return cffCharString(this.cff as CFF, glyph);
    }
}

// converts a TrueType contour (quadratic, with implied on-curve points) to path commands
export function contourToPath(path: PathCommand[], xs: ArrayLike<number>, ys: ArrayLike<number>, flags: ArrayLike<number | boolean>, first: number, last: number): void {
    if (last < first) return;
    const count = last - first + 1;
    const on = (i: number): boolean => flags[first + (i % count)] === true || ((flags[first + (i % count)] as number) & 1) === 1;
    const x = (i: number): number => xs[first + (i % count)];
    const y = (i: number): number => ys[first + (i % count)];

    // find a starting point that is on the curve, or synthesize one between two off-curve points
    let start = -1;
    for (let i = 0; i < count; i++)
        if (on(i)) {
            start = i;
            break;
        }

    let sx, sy;
    if (start === -1) {
        sx = (x(0) + x(1)) / 2;
        sy = (y(0) + y(1)) / 2;
        start = 1;
    } else {
        sx = x(start);
        sy = y(start);
        start++;
    }

    path.push(['M', sx, sy]);

    // pending off-curve control point
    let cx = 0, cy = 0, pending = false;
    for (let n = 0; n < count; n++) {
        const i = start + n;
        const px = x(i), py = y(i);

        if (on(i)) {
            if (!pending) path.push(['L', px, py]);
            else {
                path.push(['Q', cx, cy, px, py]);
                pending = false;
            }
        } else {
            if (pending) {
                const mx = (cx + px) / 2, my = (cy + py) / 2;
                path.push(['Q', cx, cy, mx, my]);
            }
            cx = px;
            cy = py;
            pending = true;
        }
    }

    if (pending) path.push(['Q', cx, cy, sx, sy]);
    path.push(['Z']);
}

function parseCmap(font: Font, offset: number): (codepoint: number) => number {
    const count = font.u16(offset + 2);
    const subtables: Array<{ platform: number, encoding: number, table: number, format: number }> = [];

    for (let i = 0; i < count; i++) {
        const record = offset + 4 + i * 8;
        const platform = font.u16(record);
        const encoding = font.u16(record + 2);
        const table = offset + font.u32(record + 4);
        subtables.push({ platform, encoding, table, format: font.u16(table) });
    }

    const rank = ({ platform, encoding, format }: { platform: number, encoding: number, format: number }): number => {
        if (![0, 4, 6, 12].includes(format)) return -1;
        if (platform === 3 && encoding === 10) return 6;
        if (platform === 0 && (encoding === 4 || encoding === 6)) return 5;
        if (platform === 3 && encoding === 1) return 4;
        if (platform === 0) return 3;
        if (platform === 3 && encoding === 0) return 2;
        if (platform === 1 && encoding === 0) return 1;
        return -1;
    };

    const best = subtables.filter(s => rank(s) >= 0).sort((a, b) => rank(b) - rank(a))[0];
    if (!best) throw new Error('Font: no supported character map');

    const { table, format, platform, encoding } = best;
    const symbol = platform === 3 && encoding === 0;

    let lookup: (c: number) => number;
    if (format === 0) lookup = (c: number): number => c < 256 ? font.u8(table + 6 + c) : 0;
    else if (format === 6) {
        const first = font.u16(table + 6), entries = font.u16(table + 8);
        lookup = (c: number): number => c >= first && c < first + entries ? font.u16(table + 10 + (c - first) * 2) : 0;
    } else if (format === 4) {
        const segments = font.u16(table + 6) / 2;
        const ends = table + 14;
        const starts = ends + segments * 2 + 2;
        const deltas = starts + segments * 2;
        const rangeOffsets = deltas + segments * 2;

        lookup = (c: number): number => {
            if (c > 0xffff) return 0;
            // binary search over segment end codes
            let lo = 0, hi = segments - 1;
            while (lo < hi) {
                const mid = lo + hi >> 1;
                if (font.u16(ends + mid * 2) < c) lo = mid + 1;
                else hi = mid;
            }

            const start = font.u16(starts + lo * 2);
            if (c < start || c > font.u16(ends + lo * 2)) return 0;

            const delta = font.u16(deltas + lo * 2);
            const rangeOffset = font.u16(rangeOffsets + lo * 2);
            if (!rangeOffset) return c + delta & 0xffff;

            const glyph = font.u16(rangeOffsets + lo * 2 + rangeOffset + (c - start) * 2);
            return glyph ? glyph + delta & 0xffff : 0;
        };
    } else {
        const groups = font.u32(table + 12);
        lookup = (c: number): number => {
            let lo = 0, hi = groups - 1;
            while (lo <= hi) {
                const mid = lo + hi >> 1;
                const group = table + 16 + mid * 12;
                if (c < font.u32(group)) hi = mid - 1;
                else if (c > font.u32(group + 4)) lo = mid + 1;
                else return font.u32(group + 8) + c - font.u32(group);
            }
            return 0;
        };
    }

    // symbol fonts map their characters to U+F000-U+F0FF
    return symbol ? (c: number): number => lookup(c) || (c < 256 ? lookup(0xf000 + c) : 0) : lookup;
}

// the variation sequences subtable (platform 0, encoding 5, format 14): for a code point and selector, the glyph,
// -1 for the default glyph, 0 if not listed
function parseVariations(font: Font, offset: number): ((codepoint: number, selector: number) => number) | null {
    let table = -1;
    for (let i = 0, count = font.u16(offset + 2); i < count; i++) {
        const record = offset + 4 + i * 8;
        if (font.u16(record) === 0 && font.u16(record + 2) === 5) {
            const t = offset + font.u32(record + 4);
            if (font.u16(t) === 14) table = t;
        }
    }
    if (table < 0) return null;
    const u24 = (o: number): number => font.u8(o) << 16 | font.u16(o + 1);
    const records = font.u32(table + 6);
    return (codepoint, selector) => {
        let lo = 0, hi = records - 1;
        while (lo <= hi) {
            const mid = lo + hi >> 1, record = table + 10 + mid * 11, vs = u24(record);
            if (vs < selector) lo = mid + 1;
            else if (vs > selector) hi = mid - 1;
            else {
                const defaults = font.u32(record + 3), others = font.u32(record + 7);
                if (others) {
                    const o = table + others;
                    let l = 0, h = font.u32(o) - 1;
                    while (l <= h) {
                        const m = l + h >> 1, u = u24(o + 4 + m * 5);
                        if (u < codepoint) l = m + 1;
                        else if (u > codepoint) h = m - 1;
                        else return font.u16(o + 4 + m * 5 + 3);
                    }
                }
                if (defaults) {
                    const o = table + defaults;
                    let l = 0, h = font.u32(o) - 1;
                    while (l <= h) {
                        const m = l + h >> 1, start = u24(o + 4 + m * 4);
                        if (codepoint < start) h = m - 1;
                        else if (codepoint > start + font.u8(o + 4 + m * 4 + 3)) l = m + 1;
                        else return -1;
                    }
                }
                return 0;
            }
        }
        return 0;
    };
}

// ---------------------------------------------------------------------------
// OpenType layout common tables, and the kern table
// ---------------------------------------------------------------------------

// returns the coverage index of a glyph, -1 if it isn't covered
export function parseCoverage(font: Font, table: number): (glyph: number) => number {
    const format = font.u16(table), count = font.u16(table + 2);

    return glyph => {
        let lo = 0, hi = count - 1;
        while (lo <= hi) {
            const mid = lo + hi >> 1;
            if (format === 1) {
                const value = font.u16(table + 4 + mid * 2);
                if (value < glyph) lo = mid + 1;
                else if (value > glyph) hi = mid - 1;
                else return mid;
            } else {
                const range = table + 4 + mid * 6;
                if (font.u16(range + 2) < glyph) lo = mid + 1;
                else if (font.u16(range) > glyph) hi = mid - 1;
                else return font.u16(range + 4) + glyph - font.u16(range);
            }
        }
        return -1;
    };
}

export function parseClassDef(font: Font, table: number): (glyph: number) => number {
    const format = font.u16(table);

    if (format === 1) {
        const start = font.u16(table + 2), count = font.u16(table + 4);
        return glyph => glyph >= start && glyph < start + count ? font.u16(table + 6 + (glyph - start) * 2) : 0;
    }

    const count = font.u16(table + 2);
    return glyph => {
        let lo = 0, hi = count - 1;
        while (lo <= hi) {
            const mid = lo + hi >> 1;
            const range = table + 4 + mid * 6;
            if (font.u16(range + 2) < glyph) lo = mid + 1;
            else if (font.u16(range) > glyph) hi = mid - 1;
            else return font.u16(range + 4);
        }
        return 0;
    };
}

// the (Microsoft) kern table, format 0 subtables with horizontal kerning
function parseKern(font: Font, kern: number): ((left: number, right: number) => number) | null {
    if (font.u16(kern) !== 0) return null;

    const tables: Array<{ pairs: number, start: number }> = [];
    let offset = kern + 4;
    for (let i = 0, count = font.u16(kern + 2); i < count; i++) {
        const coverage = font.u16(offset + 4);
        // big format 0 subtables overflow their 16-bit length field, so it is computed from the pair count
        const length = coverage >> 8 === 0 ? 14 + font.u16(offset + 6) * 6 : font.u16(offset + 2);
        // horizontal, no minimum values, not cross stream, format 0
        if ((coverage & 0xff0f) === 1) tables.push({ pairs: font.u16(offset + 6), start: offset + 14 });
        offset += length;
    }

    if (!tables.length) return null;
    return (left, right) => {
        const key = (left << 16 | right) >>> 0;
        let total = 0;
        for (const { pairs, start } of tables) {
            let lo = 0, hi = pairs - 1;
            while (lo <= hi) {
                const mid = lo + hi >> 1;
                const pair = start + mid * 6;
                const value = font.u32(pair);
                if (value < key) lo = mid + 1;
                else if (value > key) hi = mid - 1;
                else {
                    total += font.i16(pair + 4);
                    break;
                }
            }
        }
        return total;
    };
}

// ---------------------------------------------------------------------------
// CFF
// ---------------------------------------------------------------------------

function parseCFF(font: Font, base: number): CFF {
    const data = font.data;

    const readIndex = (offset: number): { items: Uint8Array[], end: number } => {
        const count = font.u16(offset);
        if (count === 0) return { items: [], end: offset + 2 };

        const offSize = data[offset + 2];
        const readOffset = (o: number): number => {
            let v = 0;
            for (let i = 0; i < offSize; i++) v = v * 256 + data[o + i];
            return v;
        };

        const dataStart = offset + 3 + (count + 1) * offSize - 1;
        const items: Uint8Array[] = [];
        for (let i = 0; i < count; i++) {
            const start = dataStart + readOffset(offset + 3 + i * offSize);
            const end = dataStart + readOffset(offset + 3 + (i + 1) * offSize);
            items.push(data.subarray(start, end));
        }

        return { items, end: dataStart + readOffset(offset + 3 + count * offSize) };
    };

    const headerSize = data[base + 2];
    const names = readIndex(base + headerSize);
    const topDicts = readIndex(names.end);
    const strings = readIndex(topDicts.end);
    const globalSubrs = readIndex(strings.end).items;

    const top = parseDict(topDicts.items[0]);
    if (!top[17]) throw new Error('Font: CFF font has no charstrings');

    const charStrings = readIndex(base + top[17][0]).items;

    const readPrivate = (entry: number[] | undefined): { subrs: Uint8Array[] } => {
        if (!entry) return { subrs: [] };
        const [size, offset] = entry;
        const dict = parseDict(data.subarray(base + offset, base + offset + size));
        const subrs = dict[19] ? readIndex(base + offset + dict[19][0]).items : [];
        return { subrs };
    };

    // CID-keyed fonts select a private dict per glyph
    let privateFor: CFF['privateFor'];
    if (top[1236]) {
        const fdArray = readIndex(base + top[1236][0]).items.map(dict => readPrivate(parseDict(dict)[18]));
        const fdSelect = base + top[1237][0];
        const format = data[fdSelect];

        privateFor = glyph => {
            if (format === 0) return fdArray[data[fdSelect + 1 + glyph]];
            const ranges = font.u16(fdSelect + 1);
            for (let i = 0; i < ranges; i++) {
                const r = fdSelect + 3 + i * 3;
                const next = font.u16(r + 3);
                if (glyph >= font.u16(r) && glyph < next) return fdArray[data[r + 2]];
            }
            return fdArray[0];
        };
    } else {
        const shared = readPrivate(top[18]);
        privateFor = () => shared;
    }

    return { charStrings, globalSubrs, privateFor };
}

// returns operator (escaped operators as 1200 + n) -> operands
function parseDict(bytes: Uint8Array): Dict {
    const dict: Dict = {};
    const operands: number[] = [];

    for (let i = 0; i < bytes.length;) {
        const b0 = bytes[i++];

        if (b0 <= 21) {
            const op = b0 === 12 ? 1200 + bytes[i++] : b0;
            dict[op] = operands.splice(0);
        } else if (b0 === 28) {
            operands.push((bytes[i] << 24 | bytes[i + 1] << 16) >> 16);
            i += 2;
        } else if (b0 === 29) {
            operands.push(bytes[i] << 24 | bytes[i + 1] << 16 | bytes[i + 2] << 8 | bytes[i + 3]);
            i += 4;
        } else if (b0 === 30) {
            let s = '';
            for (let done = false; !done;) {
                const byte = bytes[i++];
                for (const nibble of [byte >> 4, byte & 15]) {
                    if (nibble === 15) {
                        done = true;
                        break;
                    }
                    s += ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', 'E', 'E-', '', '-'][nibble];
                }
            }
            operands.push(parseFloat(s));
        } else if (b0 >= 32 && b0 <= 246) operands.push(b0 - 139);
        else if (b0 >= 247 && b0 <= 250) operands.push((b0 - 247) * 256 + bytes[i++] + 108);
        else if (b0 >= 251 && b0 <= 254) operands.push(-(b0 - 251) * 256 - bytes[i++] - 108);
    }

    return dict;
}

function subrBias(count: number): number {
    return count < 1240 ? 107 : count < 33900 ? 1131 : 32768;
}

// Type 2 charstring interpreter
function cffCharString(cff: CFF, glyph: number): PathCommand[] {
    const code = cff.charStrings[glyph];
    if (!code) return [];

    const { subrs } = cff.privateFor(glyph);
    const globalBias = subrBias(cff.globalSubrs.length);
    const localBias = subrBias(subrs.length);

    const path: PathCommand[] = [];
    const stack: number[] = [];
    let x = 0, y = 0;
    let stems = 0;
    let open = false;
    let widthParsed = false;
    let depth = 0;

    const moveTo = (dx: number, dy: number): void => {
        if (open) path.push(['Z']);
        x += dx;
        y += dy;
        path.push(['M', x, y]);
        open = true;
    };

    const lineTo = (dx: number, dy: number): void => {
        x += dx;
        y += dy;
        path.push(['L', x, y]);
    };

    const curveTo = (dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number): void => {
        const c1x = x + dx1, c1y = y + dy1;
        const c2x = c1x + dx2, c2y = c1y + dy2;
        x = c2x + dx3;
        y = c2y + dy3;
        path.push(['C', c1x, c1y, c2x, c2y, x, y]);
    };

    // the first stack clearing operator may carry the advance width as an extra argument
    const stripWidth = (expectedEven: boolean): void => {
        if (!widthParsed && (stack.length % 2 === 1) === expectedEven) stack.shift();
        widthParsed = true;
    };

    const run = (code: Uint8Array): boolean => {
        if (++depth > 10) return true;

        for (let i = 0; i < code.length;) {
            const b0 = code[i++];

            if (b0 >= 32 || b0 === 28) {
                if (b0 === 28) {
                    stack.push((code[i] << 24 | code[i + 1] << 16) >> 16);
                    i += 2;
                } else if (b0 <= 246) stack.push(b0 - 139);
                else if (b0 <= 250) stack.push((b0 - 247) * 256 + code[i++] + 108);
                else if (b0 <= 254) stack.push(-(b0 - 251) * 256 - code[i++] - 108);
                else {
                    stack.push((code[i] << 24 | code[i + 1] << 16 | code[i + 2] << 8 | code[i + 3]) / 65536);
                    i += 4;
                }
                continue;
            }

            switch (b0) {
                case 1: case 3: case 18: case 23: // hstem, vstem, hstemhm, vstemhm
                    stripWidth(true);
                    stems += stack.length >> 1;
                    stack.length = 0;
                    break;

                case 19: case 20: // hintmask, cntrmask
                    stripWidth(true);
                    stems += stack.length >> 1;
                    stack.length = 0;
                    i += stems + 7 >> 3;
                    break;

                case 21: // rmoveto
                    stripWidth(true);
                    moveTo(stack[0], stack[1]);
                    stack.length = 0;
                    break;

                case 22: // hmoveto
                    stripWidth(false);
                    moveTo(stack[0], 0);
                    stack.length = 0;
                    break;

                case 4: // vmoveto
                    stripWidth(false);
                    moveTo(0, stack[0]);
                    stack.length = 0;
                    break;

                case 5: // rlineto
                    for (let j = 0; j + 1 < stack.length; j += 2) lineTo(stack[j], stack[j + 1]);
                    stack.length = 0;
                    break;

                case 6: case 7: { // hlineto, vlineto
                    let horizontal = b0 === 6;
                    for (const v of stack) {
                        if (horizontal) lineTo(v, 0);
                        else lineTo(0, v);
                        horizontal = !horizontal;
                    }
                    stack.length = 0;
                    break;
                }

                case 8: // rrcurveto
                    for (let j = 0; j + 5 < stack.length; j += 6) curveTo(stack[j], stack[j + 1], stack[j + 2], stack[j + 3], stack[j + 4], stack[j + 5]);
                    stack.length = 0;
                    break;

                case 24: { // rcurveline
                    let j = 0;
                    for (; j + 5 < stack.length - 2; j += 6) curveTo(stack[j], stack[j + 1], stack[j + 2], stack[j + 3], stack[j + 4], stack[j + 5]);
                    lineTo(stack[j], stack[j + 1]);
                    stack.length = 0;
                    break;
                }

                case 25: { // rlinecurve
                    let j = 0;
                    for (; j + 1 < stack.length - 6; j += 2) lineTo(stack[j], stack[j + 1]);
                    curveTo(stack[j], stack[j + 1], stack[j + 2], stack[j + 3], stack[j + 4], stack[j + 5]);
                    stack.length = 0;
                    break;
                }

                case 26: { // vvcurveto
                    let j = 0, dx1 = 0;
                    if (stack.length % 4) dx1 = stack[j++];
                    for (; j + 3 < stack.length; j += 4) {
                        curveTo(dx1, stack[j], stack[j + 1], stack[j + 2], 0, stack[j + 3]);
                        dx1 = 0;
                    }
                    stack.length = 0;
                    break;
                }

                case 27: { // hhcurveto
                    let j = 0, dy1 = 0;
                    if (stack.length % 4) dy1 = stack[j++];
                    for (; j + 3 < stack.length; j += 4) {
                        curveTo(stack[j], dy1, stack[j + 1], stack[j + 2], stack[j + 3], 0);
                        dy1 = 0;
                    }
                    stack.length = 0;
                    break;
                }

                case 30: case 31: { // vhcurveto, hvcurveto
                    let horizontal = b0 === 31;
                    for (let j = 0; j + 3 < stack.length; j += 4) {
                        const last = j + 5 === stack.length ? stack[j + 4] : 0;
                        if (horizontal) curveTo(stack[j], 0, stack[j + 1], stack[j + 2], last, stack[j + 3]);
                        else curveTo(0, stack[j], stack[j + 1], stack[j + 2], stack[j + 3], last);
                        horizontal = !horizontal;
                    }
                    stack.length = 0;
                    break;
                }

                case 10: case 29: { // callsubr, callgsubr
                    const local = b0 === 10;
                    const index = (stack.pop() as number) + (local ? localBias : globalBias);
                    const subr = (local ? subrs : cff.globalSubrs)[index];
                    if (subr && run(subr)) return true;
                    break;
                }

                case 11: // return
                    depth--;
                    return false;

                case 14: // endchar
                    stripWidth(true);
                    if (open) path.push(['Z']);
                    open = false;
                    return true;

                case 12: { // escaped operators: flex variants, everything else is ignored
                    const op = code[i++];
                    const s = stack;

                    if (op === 35) { // flex
                        curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
                        curveTo(s[6], s[7], s[8], s[9], s[10], s[11]);
                    } else if (op === 34) { // hflex
                        const startY = y;
                        curveTo(s[0], 0, s[1], s[2], s[3], 0);
                        curveTo(s[4], 0, s[5], startY - y, s[6], 0);
                    } else if (op === 36) { // hflex1
                        const startY = y;
                        curveTo(s[0], s[1], s[2], s[3], s[4], 0);
                        curveTo(s[5], 0, s[6], s[7], s[8], startY - (y + s[7]));
                    } else if (op === 37) { // flex1
                        const startX = x, startY = y;
                        let dx = 0, dy = 0;
                        for (let j = 0; j < 10; j += 2) {
                            dx += s[j];
                            dy += s[j + 1];
                        }
                        curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
                        const lastX = Math.abs(dx) > Math.abs(dy);
                        curveTo(s[6], s[7], s[8], s[9], lastX ? s[10] : startX - (x + s[6] + s[8]), lastX ? startY - (y + s[7] + s[9]) : s[10]);
                    }

                    stack.length = 0;
                    break;
                }

                default:
                    stack.length = 0;
            }
        }

        depth--;
        return false;
    };

    run(code);
    if (open) path.push(['Z']);
    return path;
}

// a WOFF (1) font as the TrueType or OpenType font it compresses
function fromWOFF(data: Uint8Array): Uint8Array {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint16(12);
    const tables: Array<{ tag: number, data: Uint8Array, checksum: number }> = [];
    for (let i = 0; i < count; i++) {
        const e = 44 + i * 20, offset = view.getUint32(e + 4), compressed = view.getUint32(e + 8), length = view.getUint32(e + 12);
        const raw = data.subarray(offset, offset + compressed);
        tables.push({ tag: view.getUint32(e), checksum: view.getUint32(e + 16), data: compressed < length ? decompress(raw, length).subarray(0, length) : raw });
    }
    const header = 12 + count * 16;
    let size = header;
    for (const t of tables) size += t.data.length + 3 & ~3;
    const out = new Uint8Array(size), o = new DataView(out.buffer);
    o.setUint32(0, view.getUint32(4));
    o.setUint16(4, count);
    let position = header;
    tables.forEach((t, i) => {
        o.setUint32(12 + i * 16, t.tag);
        o.setUint32(16 + i * 16, t.checksum);
        o.setUint32(20 + i * 16, position);
        o.setUint32(24 + i * 16, t.data.length);
        out.set(t.data, position);
        position += t.data.length + 3 & ~3;
    });
    return out;
}
