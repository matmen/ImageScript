
/**
 * A path command in font units (y up) or user units:
 * ['M', x, y], ['L', x, y], ['Q', cx, cy, x, y], ['C', c1x, c1y, c2x, c2y, x, y], ['Z']
 */
export type PathCommand = [string, ...number[]];

interface CFF {
    charStrings: Uint8Array[];
    globalSubrs: Uint8Array[];
    privateFor: (glyph: number) => { subrs: Uint8Array[] };
}

type Dict = Record<number, number[]>;

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
    outlines: 'glyf' | 'cff';
    cff: CFF | null = null;
    cmap: (codepoint: number) => number;
    outlineCache: Map<number, PathCommand[]>;

    constructor(data: Uint8Array) {
        this.data = data;
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        let offset = 0;
        const signature = this.u32(0);
        if (signature === 0x74746366) offset = this.u32(12); // 'ttcf', use the first font
        else if (signature === 0x774f4646 || signature === 0x774f4632) throw new Error('Font: WOFF fonts are not supported');

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
        else throw new Error('Font: no supported glyph outlines');

        this.cmap = parseCmap(this, this.tables.cmap.offset);
        this.outlineCache = new Map();
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
        return this.u16(hmtx + index * 4);
    }

    /**
     * @param {number} glyph
     * @return {Array} path commands in font units
     */
    outline(glyph: number): PathCommand[] {
        if (glyph >= this.numGlyphs) glyph = 0;
        let path = this.outlineCache.get(glyph);
        if (!path) {
            path = this.outlines === 'glyf' ? this.glyfOutline(glyph, 0) : this.cffOutline(glyph);
            this.outlineCache.set(glyph, path);
        }
        return path;
    }

    glyfOutline(glyph: number, depth: number): PathCommand[] {
        if (depth > 8) return [];

        const loca = this.tables.loca.offset;
        const start = this.indexToLocFormat ? this.u32(loca + glyph * 4) : this.u16(loca + glyph * 2) * 2;
        const end = this.indexToLocFormat ? this.u32(loca + glyph * 4 + 4) : this.u16(loca + glyph * 2 + 2) * 2;
        if (end <= start) return [];

        const offset = this.tables.glyf.offset + start;
        const contours = this.i16(offset);

        return contours >= 0 ? this.simpleGlyph(offset, contours) : this.compositeGlyph(offset, depth);
    }

    simpleGlyph(offset: number, contourCount: number): PathCommand[] {
        const endPoints = [];
        for (let i = 0; i < contourCount; i++) endPoints.push(this.u16(offset + 10 + i * 2));
        const pointCount = contourCount ? endPoints[contourCount - 1] + 1 : 0;

        let p = offset + 10 + contourCount * 2;
        p += 2 + this.u16(p); // skip instructions

        const flags = new Uint8Array(pointCount);
        for (let i = 0; i < pointCount;) {
            const flag = this.u8(p++);
            flags[i++] = flag;
            if (flag & 8) {
                for (let repeat = this.u8(p++); repeat > 0 && i < pointCount; repeat--) flags[i++] = flag;
            }
        }

        const xs = new Int32Array(pointCount);
        const ys = new Int32Array(pointCount);
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

        const path: PathCommand[] = [];
        let first = 0;
        for (const last of endPoints) {
            contourToPath(path, xs, ys, flags, first, last);
            first = last + 1;
        }

        return path;
    }

    compositeGlyph(offset: number, depth: number): PathCommand[] {
        const path: PathCommand[] = [];
        let p = offset + 10;

        for (let more = true; more;) {
            const flags = this.u16(p);
            const glyph = this.u16(p + 2);
            p += 4;

            let dx, dy;
            if (flags & 1) {
                dx = flags & 2 ? this.i16(p) : this.u16(p);
                dy = flags & 2 ? this.i16(p + 2) : this.u16(p + 2);
                p += 4;
            } else {
                dx = flags & 2 ? this.i8(p) : this.u8(p);
                dy = flags & 2 ? this.i8(p + 1) : this.u8(p + 1);
                p += 2;
            }

            // point matching (ARGS_ARE_XY_VALUES unset) is rare, treat it as no offset
            if (!(flags & 2)) dx = dy = 0;

            let a = 1, b = 0, c = 0, d = 1;
            const f2dot14 = (o: number): number => this.i16(o) / 16384;
            if (flags & 8) {
                a = d = f2dot14(p);
                p += 2;
            } else if (flags & 0x40) {
                a = f2dot14(p);
                d = f2dot14(p + 2);
                p += 4;
            } else if (flags & 0x80) {
                a = f2dot14(p);
                b = f2dot14(p + 2);
                c = f2dot14(p + 4);
                d = f2dot14(p + 6);
                p += 8;
            }

            for (const command of this.glyfOutline(glyph, depth + 1)) {
                const transformed: PathCommand = [command[0]];
                for (let i = 1; i < command.length; i += 2) {
                    const x = command[i] as number, y = command[i + 1] as number;
                    transformed.push(a * x + c * y + dx, b * x + d * y + dy);
                }
                path.push(transformed);
            }

            more = !!(flags & 0x20);
        }

        return path;
    }

    cffOutline(glyph: number): PathCommand[] {
        return cffCharString(this.cff as CFF, glyph);
    }
}

// converts a TrueType contour (quadratic, with implied on-curve points) to path commands
function contourToPath(path: PathCommand[], xs: Int32Array, ys: Int32Array, flags: Uint8Array, first: number, last: number): void {
    if (last < first) return;
    const count = last - first + 1;
    const on = (i: number): number => flags[first + (i % count)] & 1;
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

