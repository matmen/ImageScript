/*!
 * JPEG codec. This software is based in part on the work of the Independent JPEG Group: the IDCT, FDCT, upsampling,
 * downsampling, color conversion, quantization, progressive refinement and optimal Huffman tables are translated from
 * libjpeg/libjpeg-turbo (IJG license, see licenses/README.ijg). The scan decoder follows the structure of pdf.js' jpg.js
 * (Copyright 2014 Mozilla Foundation, Apache License 2.0). See THIRD_PARTY_NOTICES.md
 */

import { ByteWriter } from '../util/bytes.ts';
import { MAX_PIXELS, checkPixels } from '../util/limits.ts';
import { orientation as exifOrientation } from './exif.ts';
import { concat } from '../util/mem.ts';
import { littleEndian } from '../util/alpha.ts';

// natural order index of the n-th zigzag coefficient
const ZIGZAG = Int32Array.of(
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
);

type Transform = 'grey' | 'rgb' | 'ycc' | 'ycck' | 'cmyk';

interface HuffmanTable {
    /** (length << 8 | symbol) for codes up to 9 bits, 0 = slow path */
    lookup: Uint16Array;
    maxCode: Int32Array;
    valueOffset: Int32Array;
    values: Uint8Array;
}

interface Component {
    id: number;
    h: number;
    v: number;
    tq: number;
    /** dimensions of the component's sample plane */
    width: number;
    height: number;
    blocksPerLine: number;
    blocksPerColumn: number;
    /** blocks are allocated for whole MCUs */
    blocksPerLineForMcu: number;
    blocksPerColumnForMcu: number;
    coefficients: Int16Array;
    pred: number;
    dcTable?: HuffmanTable;
    acTable?: HuffmanTable;
    quantization?: Int32Array;
}

interface Frame {
    progressive: boolean;
    width: number;
    height: number;
    components: Component[];
    hmax: number;
    vmax: number;
    mcusPerLine: number;
    mcusPerColumn: number;
}

export interface DecodeOptions {
    /** overrides the color transform detected from JFIF/Adobe markers (used by TIFF) */
    transform?: 'ycc' | 'rgb' | 'cmyk' | null;
    /** the most pixels to decode */
    maxPixels?: number;
}

function clamp8(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

// ---------------------------------------------------------------------------
// decoder
// ---------------------------------------------------------------------------

/**
 * Decodes a JPEG into 8-bit RGBA pixel data
 * Supports baseline, extended and progressive huffman coded JPEGs with any
 * sampling factors, restart intervals and greyscale, YCbCr, RGB, CMYK and YCCK color
 * The output matches libjpeg's defaults (islow IDCT, fancy upsampling)
 * @param {Uint8Array} data
 * @param {{transform?: 'ycc'|'rgb'|'cmyk'}} [options] overrides the color transform detected from JFIF/Adobe markers (used by TIFF)
 * @return {{width: number, height: number, pixels: Uint8Array}}
 */
export function decode(data: Uint8Array, { transform, maxPixels = MAX_PIXELS }: DecodeOptions = {}): { width: number, height: number, pixels: Uint8Array, orientation: number, icc?: Uint8Array } {
    if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('JPEG: invalid signature');

    const quantizationTables: Int32Array[] = [];
    const dcTables: HuffmanTable[] = [];
    const acTables: HuffmanTable[] = [];
    let frame: Frame | null = null;
    let adobe: { transform: number } | null = null;
    let jfif = false;
    let orientation = 1;
    // the ICC profile's parts (APP2 ICC_PROFILE segments) by their sequence numbers
    const profile: Uint8Array[] = [];
    let restartInterval = 0;
    let pos = 2;

    const u16 = (offset: number): number => data[offset] << 8 | data[offset + 1];

    while (pos < data.length) {
        // find the next marker, skipping fill bytes and stray data
        if (data[pos] !== 0xff) {
            pos++;
            continue;
        }

        const marker = data[pos + 1];
        if (marker === 0xff || marker === 0x00 || marker === undefined) {
            pos++;
            continue;
        }

        pos += 2;

        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
        if (marker === 0xd9) break;

        const length = u16(pos);
        const start = pos + 2;
        const end = pos + length;
        if (end > data.length) throw new Error('JPEG: unexpected end of data');

        switch (marker) {
            case 0xdb: { // DQT
                let p = start;
                while (p < end) {
                    const precision = data[p] >> 4;
                    const id = data[p++] & 15;
                    const table = new Int32Array(64);

                    for (let k = 0; k < 64; k++) {
                        table[ZIGZAG[k]] = precision ? u16(p) : data[p];
                        p += precision ? 2 : 1;
                    }

                    quantizationTables[id] = table;
                }
                break;
            }

            case 0xc4: { // DHT
                let p = start;
                while (p < end) {
                    const tableClass = data[p] >> 4;
                    const id = data[p++] & 15;
                    const counts = data.subarray(p, p + 16);
                    p += 16;

                    let total = 0;
                    for (let i = 0; i < 16; i++) total += counts[i];

                    const table = buildHuffmanTable(counts, data.subarray(p, p + total));
                    p += total;
                    (tableClass === 0 ? dcTables : acTables)[id] = table;
                }
                break;
            }

            case 0xdd: // DRI
                restartInterval = u16(start);
                break;

            case 0xc0: case 0xc1: case 0xc2: { // SOF baseline, extended, progressive
                if (frame) throw new Error('JPEG: multiple frames are not supported');
                if (data[start] !== 8) throw new Error(`JPEG: ${data[start]}-bit precision is not supported`);
                checkPixels(u16(start + 3), u16(start + 1), maxPixels);
                frame = createFrame(marker === 0xc2, u16(start + 1), u16(start + 3), data.subarray(start + 5, end));
                break;
            }

            case 0xc3: case 0xc5: case 0xc6: case 0xc7:
            case 0xc9: case 0xca: case 0xcb: case 0xcd: case 0xce: case 0xcf:
                throw new Error(marker === 0xc3 || marker === 0xc7 || marker === 0xcb || marker === 0xcf
                    ? 'JPEG: lossless JPEGs are not supported'
                    : marker >= 0xc9 ? 'JPEG: arithmetic coding is not supported' : 'JPEG: hierarchical JPEGs are not supported');

            case 0xe0: // APP0
                if (data[start] === 0x4a && data[start + 1] === 0x46 && data[start + 2] === 0x49 && data[start + 3] === 0x46 && data[start + 4] === 0) jfif = true;
                break;

            case 0xe1: // APP1, the first Exif block holds the orientation
                if (orientation === 1) orientation = exifOrientation(data.subarray(start, end));
                break;

            case 0xe2: // APP2, "ICC_PROFILE\0", sequence number (from 1), count, data
                if (length >= 16 && String.fromCharCode(...data.subarray(start, start + 12)) === 'ICC_PROFILE\0' && data[start + 12] >= 1)
                    profile[data[start + 12] - 1] ??= data.subarray(start + 14, end);
                break;

            case 0xee: // APP14
                if (length >= 14 && data[start] === 0x41 && data[start + 1] === 0x64 && data[start + 2] === 0x6f && data[start + 3] === 0x62 && data[start + 4] === 0x65)
                    adobe = { transform: data[start + 11] };
                break;

            case 0xda: { // SOS
                if (!frame) throw new Error('JPEG: scan before frame header');
                if (frame.height === 0) throw new Error('JPEG: DNL markers are not supported');

                const count = data[start];
                const components = [];
                let p = start + 1;

                for (let i = 0; i < count; i++) {
                    const component = frame.components.find(c => c.id === data[p]);
                    if (!component) throw new Error('JPEG: scan references unknown component');

                    component.dcTable = dcTables[data[p + 1] >> 4];
                    component.acTable = acTables[data[p + 1] & 15];
                    // latch the quantization table on first use, it may be redefined afterwards
                    if (!component.quantization) {
                        const table = quantizationTables[component.tq];
                        if (!table) throw new Error('JPEG: missing quantization table');
                        component.quantization = table.slice();
                    }

                    components.push(component);
                    p += 2;
                }

                const spectralStart = data[p];
                const spectralEnd = data[p + 1];
                const successiveHigh = data[p + 2] >> 4;
                const successiveLow = data[p + 2] & 15;

                pos = decodeScan(data, end, frame, components, restartInterval, spectralStart, spectralEnd, successiveHigh, successiveLow);
                continue;
            }
        }

        pos = end;
    }

    if (!frame) throw new Error('JPEG: missing frame header');
    // (the profile only if no part is missing)
    const icc = profile.length && Array.from(profile).every(Boolean) ? concat(profile) : undefined;
    return { width: frame.width, height: frame.height, pixels: output(frame, adobe, jfif, transform), orientation, icc };
}

function createFrame(progressive: boolean, height: number, width: number, componentData: Uint8Array): Frame {
    const count = componentData[0];
    const sampling: Array<{ id: number, h: number, v: number, tq: number }> = [];

    for (let i = 0; i < count; i++) {
        const p = 1 + i * 3;
        sampling.push({ id: componentData[p], h: componentData[p + 1] >> 4 || 1, v: componentData[p + 1] & 15 || 1, tq: componentData[p + 2] });
    }

    if (!width || !sampling.length) throw new Error('JPEG: invalid dimensions');
    // each component takes coefficients for the whole image (grey, YCbCr/RGB and CMYK have up to 4)
    if (sampling.length > 4) throw new Error(`JPEG: ${sampling.length} components are not supported`);

    const hmax = Math.max(...sampling.map(c => c.h));
    const vmax = Math.max(...sampling.map(c => c.v));
    const mcusPerLine = Math.ceil(width / (8 * hmax));
    const mcusPerColumn = Math.ceil(height / (8 * vmax));

    const components = sampling.map((c): Component => {
        const componentWidth = Math.ceil(width * c.h / hmax);
        const componentHeight = Math.ceil(height * c.v / vmax);
        const blocksPerLineForMcu = mcusPerLine * c.h;
        const blocksPerColumnForMcu = mcusPerColumn * c.v;

        return {
            ...c,
            width: componentWidth,
            height: componentHeight,
            blocksPerLine: Math.ceil(componentWidth / 8),
            blocksPerColumn: Math.ceil(componentHeight / 8),
            blocksPerLineForMcu,
            blocksPerColumnForMcu,
            coefficients: new Int16Array(blocksPerLineForMcu * blocksPerColumnForMcu * 64),
            pred: 0
        };
    });

    return { progressive, width, height, components, hmax, vmax, mcusPerLine, mcusPerColumn };
}

function buildHuffmanTable(counts: Uint8Array, symbols: Uint8Array): HuffmanTable {
    // fast lookup for codes up to 9 bits: (length << 8 | symbol), 0 = slow path
    const lookup = new Uint16Array(512);
    const maxCode = new Int32Array(18).fill(-1);
    const valueOffset = new Int32Array(17);
    const values = Uint8Array.from(symbols);

    let code = 0, k = 0;
    for (let length = 1; length <= 16; length++) {
        valueOffset[length] = k - code;

        for (let i = 0; i < counts[length - 1]; i++, k++, code++) {
            if (length <= 9) {
                const shift = 9 - length;
                for (let j = 0; j < 1 << shift; j++) lookup[code << shift | j] = length << 8 | values[k];
            }
        }

        if (counts[length - 1]) maxCode[length] = code - 1;
        code <<= 1;
    }

    maxCode[17] = 0x7fffffff;
    return { lookup, maxCode, valueOffset, values };
}

function decodeScan(data: Uint8Array, offset: number, frame: Frame, components: Component[], restartInterval: number, ss: number, se: number, ah: number, al: number): number {
    // bit reader state
    let pos = offset;
    let buffer = 0, bits = 0;

    const fill = (): void => {
        while (bits <= 24) {
            let byte = 0;
            if (pos < data.length) {
                byte = data[pos];
                if (byte === 0xff) {
                    const next = data[pos + 1];
                    if (next === 0x00) pos += 2;
                    else byte = 0; // marker reached, feed zeros
                } else pos++;
            }

            buffer = buffer << 8 | byte;
            bits += 8;
        }
    };

    const getBits = (n: number): number => {
        if (bits < n) fill();
        bits -= n;
        return buffer >>> bits & (1 << n) - 1;
    };

    const getBit = (): number => {
        if (bits < 1) fill();
        return buffer >>> --bits & 1;
    };

    const huffman = (table: HuffmanTable | undefined): number => {
        if (!table) throw new Error('JPEG: missing huffman table');
        if (bits < 16) fill();
        const entry = table.lookup[buffer >>> bits - 9 & 511];

        if (entry) {
            bits -= entry >> 8;
            return entry & 255;
        }

        let length = 10;
        let code = buffer >>> bits - 10 & 1023;
        while (code > table.maxCode[length]) {
            if (++length > 16) throw new Error('JPEG: invalid huffman code');
            code = buffer >>> bits - length & (1 << length) - 1;
        }

        bits -= length;
        return table.values[code + table.valueOffset[length]];
    };

    const extend = (value: number, size: number): number => value < 1 << size - 1 ? value + (-1 << size) + 1 : value;
    const receiveExtend = (size: number): number => size ? extend(getBits(size), size) : 0;

    let eobrun = 0;

    const decodeBaseline = (component: Component, offset: number): void => {
        const coefficients = component.coefficients;
        const t = huffman(component.dcTable);
        coefficients[offset] = component.pred += receiveExtend(t);

        for (let k = 1; k < 64;) {
            const rs = huffman(component.acTable);
            const s = rs & 15, r = rs >> 4;

            if (s === 0) {
                if (r < 15) break;
                k += 16;
                continue;
            }

            k += r;
            if (k > 63) break;
            coefficients[offset + ZIGZAG[k++]] = receiveExtend(s);
        }
    };

    const decodeDCFirst = (component: Component, offset: number): void => {
        const t = huffman(component.dcTable);
        component.coefficients[offset] = (component.pred += receiveExtend(t)) * (1 << al);
    };

    const decodeDCSuccessive = (component: Component, offset: number): void => {
        if (getBit()) component.coefficients[offset] |= 1 << al;
    };

    const decodeACFirst = (component: Component, offset: number): void => {
        if (eobrun > 0) {
            eobrun--;
            return;
        }

        const coefficients = component.coefficients;
        for (let k = ss; k <= se;) {
            const rs = huffman(component.acTable);
            const s = rs & 15, r = rs >> 4;

            if (s === 0) {
                if (r < 15) {
                    eobrun = (1 << r) - 1;
                    if (r) eobrun += getBits(r);
                    break;
                }

                k += 16;
                continue;
            }

            k += r;
            if (k > 63) break;
            coefficients[offset + ZIGZAG[k++]] = receiveExtend(s) * (1 << al);
        }
    };

    const decodeACSuccessive = (component: Component, offset: number): void => {
        const coefficients = component.coefficients;
        const p1 = 1 << al;
        const m1 = -1 << al;
        let k = ss;

        if (eobrun === 0) {
            for (; k <= se; k++) {
                const rs = huffman(component.acTable);
                let r = rs >> 4;
                let s = rs & 15;

                if (s) s = getBit() ? p1 : m1;
                else if (r !== 15) {
                    eobrun = 1 << r;
                    if (r) eobrun += getBits(r);
                    break;
                }

                // skip r zero coefficients, refining the nonzero ones passed on the way
                do {
                    const z = offset + ZIGZAG[k];
                    const c = coefficients[z];

                    if (c !== 0) {
                        if (getBit() && (c & p1) === 0) coefficients[z] = c >= 0 ? c + p1 : c + m1;
                    } else if (--r < 0) break;

                    k++;
                } while (k <= se);

                if (s && k <= se) coefficients[offset + ZIGZAG[k]] = s;
            }
        }

        if (eobrun > 0) {
            for (; k <= se; k++) {
                const z = offset + ZIGZAG[k];
                const c = coefficients[z];
                if (c !== 0 && getBit() && (c & p1) === 0) coefficients[z] = c >= 0 ? c + p1 : c + m1;
            }

            eobrun--;
        }
    };

    const decodeBlock = !frame.progressive ? decodeBaseline
        : ss === 0 ? (ah === 0 ? decodeDCFirst : decodeDCSuccessive)
            : (ah === 0 ? decodeACFirst : decodeACSuccessive);

    const single = components.length === 1;
    const total = single
        ? components[0].blocksPerLine * components[0].blocksPerColumn
        : frame.mcusPerLine * frame.mcusPerColumn;
    const interval = restartInterval || total;

    for (const component of components) component.pred = 0;

    for (let unit = 0; unit < total;) {
        for (let n = 0; n < interval && unit < total; n++, unit++) {
            if (single) {
                const component = components[0];
                const row = unit / component.blocksPerLine | 0;
                const column = unit % component.blocksPerLine;
                decodeBlock(component, (row * component.blocksPerLineForMcu + column) * 64);
            } else {
                const mcuRow = unit / frame.mcusPerLine | 0;
                const mcuColumn = unit % frame.mcusPerLine;

                for (const component of components)
                    for (let v = 0; v < component.v; v++)
                        for (let h = 0; h < component.h; h++) {
                            const row = mcuRow * component.v + v;
                            const column = mcuColumn * component.h + h;
                            decodeBlock(component, (row * component.blocksPerLineForMcu + column) * 64);
                        }
            }
        }

        if (unit >= total) break;

        // restart: discard remaining bits and expect an RSTn marker
        bits = 0;
        buffer = 0;
        while (pos + 1 < data.length && !(data[pos] === 0xff && data[pos + 1] >= 0xd0 && data[pos + 1] <= 0xd7)) {
            // a different marker means the scan ended early
            if (data[pos] === 0xff && data[pos + 1] !== 0x00 && data[pos + 1] !== 0xff) return pos;
            pos++;
        }

        if (pos + 1 >= data.length) return pos;
        pos += 2;
        eobrun = 0;
        for (const component of components) component.pred = 0;
    }

    return pos;
}

// libjpeg's jpeg_idct_islow
const CONST_BITS = 13;
const PASS1_BITS = 2;
const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;

function idct(coefficients: Int16Array, offset: number, quantization: Int32Array, workspace: Int32Array, out: Uint8Array, outOffset: number, stride: number): void {
    const P1 = CONST_BITS - PASS1_BITS;
    const R1 = 1 << P1 - 1;

    for (let column = 0; column < 8; column++) {
        const c = offset + column;

        if (coefficients[c + 8] === 0 && coefficients[c + 16] === 0 && coefficients[c + 24] === 0 && coefficients[c + 32] === 0
            && coefficients[c + 40] === 0 && coefficients[c + 48] === 0 && coefficients[c + 56] === 0) {
            const dc = coefficients[c] * quantization[column] << PASS1_BITS;
            for (let row = 0; row < 64; row += 8) workspace[row + column] = dc;
            continue;
        }

        let z2 = coefficients[c + 16] * quantization[column + 16];
        let z3 = coefficients[c + 48] * quantization[column + 48];
        let z1 = (z2 + z3) * FIX_0_541196100;
        let tmp2 = z1 - z3 * FIX_1_847759065;
        let tmp3 = z1 + z2 * FIX_0_765366865;

        z2 = coefficients[c] * quantization[column];
        z3 = coefficients[c + 32] * quantization[column + 32];
        let tmp0 = z2 + z3 << CONST_BITS;
        let tmp1 = z2 - z3 << CONST_BITS;

        const tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3;
        const tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;

        tmp0 = coefficients[c + 56] * quantization[column + 56];
        tmp1 = coefficients[c + 40] * quantization[column + 40];
        tmp2 = coefficients[c + 24] * quantization[column + 24];
        tmp3 = coefficients[c + 8] * quantization[column + 8];

        z1 = tmp0 + tmp3;
        z2 = tmp1 + tmp2;
        z3 = tmp0 + tmp2;
        let z4 = tmp1 + tmp3;
        const z5 = (z3 + z4) * FIX_1_175875602;

        tmp0 *= FIX_0_298631336;
        tmp1 *= FIX_2_053119869;
        tmp2 *= FIX_3_072711026;
        tmp3 *= FIX_1_501321110;
        z1 *= -FIX_0_899976223;
        z2 *= -FIX_2_562915447;
        z3 = z3 * -FIX_1_961570560 + z5;
        z4 = z4 * -FIX_0_390180644 + z5;

        tmp0 += z1 + z3;
        tmp1 += z2 + z4;
        tmp2 += z2 + z3;
        tmp3 += z1 + z4;

        workspace[column] = tmp10 + tmp3 + R1 >> P1;
        workspace[column + 56] = tmp10 - tmp3 + R1 >> P1;
        workspace[column + 8] = tmp11 + tmp2 + R1 >> P1;
        workspace[column + 48] = tmp11 - tmp2 + R1 >> P1;
        workspace[column + 16] = tmp12 + tmp1 + R1 >> P1;
        workspace[column + 40] = tmp12 - tmp1 + R1 >> P1;
        workspace[column + 24] = tmp13 + tmp0 + R1 >> P1;
        workspace[column + 32] = tmp13 - tmp0 + R1 >> P1;
    }

    const P2 = CONST_BITS + PASS1_BITS + 3;
    const R2 = 1 << P2 - 1;

    for (let row = 0; row < 64; row += 8) {
        const o = outOffset + (row >> 3) * stride;

        let z2 = workspace[row + 2];
        let z3 = workspace[row + 6];
        let z1 = (z2 + z3) * FIX_0_541196100;
        let tmp2 = z1 - z3 * FIX_1_847759065;
        let tmp3 = z1 + z2 * FIX_0_765366865;

        let tmp0 = workspace[row] + workspace[row + 4] << CONST_BITS;
        let tmp1 = workspace[row] - workspace[row + 4] << CONST_BITS;

        const tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3;
        const tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;

        tmp0 = workspace[row + 7];
        tmp1 = workspace[row + 5];
        tmp2 = workspace[row + 3];
        tmp3 = workspace[row + 1];

        z1 = tmp0 + tmp3;
        z2 = tmp1 + tmp2;
        z3 = tmp0 + tmp2;
        let z4 = tmp1 + tmp3;
        const z5 = (z3 + z4) * FIX_1_175875602;

        tmp0 *= FIX_0_298631336;
        tmp1 *= FIX_2_053119869;
        tmp2 *= FIX_3_072711026;
        tmp3 *= FIX_1_501321110;
        z1 *= -FIX_0_899976223;
        z2 *= -FIX_2_562915447;
        z3 = z3 * -FIX_1_961570560 + z5;
        z4 = z4 * -FIX_0_390180644 + z5;

        tmp0 += z1 + z3;
        tmp1 += z2 + z4;
        tmp2 += z2 + z3;
        tmp3 += z1 + z4;

        out[o] = clamp8((tmp10 + tmp3 + R2 >> P2) + 128);
        out[o + 7] = clamp8((tmp10 - tmp3 + R2 >> P2) + 128);
        out[o + 1] = clamp8((tmp11 + tmp2 + R2 >> P2) + 128);
        out[o + 6] = clamp8((tmp11 - tmp2 + R2 >> P2) + 128);
        out[o + 2] = clamp8((tmp12 + tmp1 + R2 >> P2) + 128);
        out[o + 5] = clamp8((tmp12 - tmp1 + R2 >> P2) + 128);
        out[o + 3] = clamp8((tmp13 + tmp0 + R2 >> P2) + 128);
        out[o + 4] = clamp8((tmp13 - tmp0 + R2 >> P2) + 128);
    }
}

// runs the IDCT over every block, producing the component's sample plane
function buildPlane(component: Component): { plane: Uint8Array, stride: number } {
    const stride = component.blocksPerLineForMcu * 8;
    const plane = new Uint8Array(stride * component.blocksPerColumnForMcu * 8);
    const workspace = new Int32Array(64);
    // components without any scan data decode to mid grey
    const quantization = component.quantization || new Int32Array(64);

    for (let row = 0; row < component.blocksPerColumn; row++)
        for (let column = 0; column < component.blocksPerLine; column++)
            idct(component.coefficients, (row * component.blocksPerLineForMcu + column) * 64, quantization, workspace, plane, row * 8 * stride + column * 8, stride);

    return { plane, stride };
}

// a component at full resolution, following libjpeg's fancy upsampling: the plane itself if it isn't subsampled, else
// a row buffer that fill(y) upsamples output row y into
interface Samples {
    samples: Uint8Array;
    stride: number;
    fill?: (y: number) => void;
}

function upsample(component: Component, frame: Frame): Samples {
    const { plane, stride } = buildPlane(component);
    const hf = frame.hmax / component.h;
    const vf = frame.vmax / component.v;
    const w = component.width, h = component.height;
    const W = Math.ceil(w * hf);
    const out = new Uint8Array(W);
    const fancy = w > 2;

    if (hf === 1 && vf === 1) return { samples: plane, stride };

    if (hf === 2 && vf === 1 && fancy) return {
        samples: out, stride: 0, fill: y => {
            const i = y * stride;
            out[0] = plane[i];
            out[1] = plane[i] * 3 + plane[i + 1] + 2 >> 2;
            for (let x = 1; x < w - 1; x++) {
                const v = plane[i + x] * 3;
                out[2 * x] = v + plane[i + x - 1] + 1 >> 2;
                out[2 * x + 1] = v + plane[i + x + 1] + 2 >> 2;
            }
            out[2 * w - 2] = plane[i + w - 1] * 3 + plane[i + w - 2] + 1 >> 2;
            out[2 * w - 1] = plane[i + w - 1];
        }
    };

    if (hf === 1 && vf === 2 && fancy) return {
        samples: out, stride: 0, fill: y => {
            const i = (y >> 1) * stride;
            if (y & 1) {
                const below = Math.min(h - 1, (y >> 1) + 1) * stride;
                for (let x = 0; x < w; x++) out[x] = plane[i + x] * 3 + plane[below + x] + 2 >> 2;
            } else {
                const above = Math.max(0, (y >> 1) - 1) * stride;
                for (let x = 0; x < w; x++) out[x] = plane[i + x] * 3 + plane[above + x] + 1 >> 2;
            }
        }
    };

    if (hf === 2 && vf === 2 && fancy) return {
        samples: out, stride: 0, fill: y => {
            const i = (y >> 1) * stride;
            const other = (y & 1 ? Math.min(h - 1, (y >> 1) + 1) : Math.max(0, (y >> 1) - 1)) * stride;

            let thisSum = plane[i] * 3 + plane[other];
            let nextSum = plane[i + 1] * 3 + plane[other + 1];
            out[0] = thisSum * 4 + 8 >> 4;
            out[1] = thisSum * 3 + nextSum + 7 >> 4;
            let lastSum = thisSum;
            thisSum = nextSum;

            for (let x = 1; x < w - 1; x++) {
                nextSum = plane[i + x + 1] * 3 + plane[other + x + 1];
                out[2 * x] = thisSum * 3 + lastSum + 8 >> 4;
                out[2 * x + 1] = thisSum * 3 + nextSum + 7 >> 4;
                lastSum = thisSum;
                thisSum = nextSum;
            }

            out[2 * w - 2] = thisSum * 3 + lastSum + 8 >> 4;
            out[2 * w - 1] = thisSum * 4 + 7 >> 4;
        }
    };

    // plain replication for every other sampling ratio
    return {
        samples: out, stride: 0, fill: y => {
            const i = Math.min(h - 1, y / vf | 0) * stride;
            for (let x = 0; x < W; x++) out[x] = plane[i + Math.min(w - 1, x / hf | 0)];
        }
    };
}

// libjpeg's fixed point YCbCr -> RGB tables
const crR = new Int32Array(256);
const cbB = new Int32Array(256);
const crG = new Int32Array(256);
const cbG = new Int32Array(256);
for (let i = 0; i < 256; i++) {
    const x = i - 128;
    crR[i] = 91881 * x + 32768 >> 16;
    cbB[i] = 116130 * x + 32768 >> 16;
    crG[i] = -46802 * x;
    cbG[i] = -22554 * x + 32768;
}

// clamping to 0-255 by a lookup: CLAMP[v + CLAMP_OFFSET] for v in -CLAMP_OFFSET..CLAMP_OFFSET + 255 (YCbCr to RGB
// stays within 227 of the range)
const CLAMP_OFFSET = 256, CLAMP = new Uint8Array(768);
for (let i = 0; i < 768; i++) CLAMP[i] = clamp8(i - CLAMP_OFFSET);

function output(frame: Frame, adobe: { transform: number } | null, jfif: boolean, override: DecodeOptions['transform']): Uint8Array {
    const { width, height, components } = frame;
    const planes = components.map(component => upsample(component, frame));
    const pixels = new Uint8Array(width * height * 4);
    const count = components.length;

    let transform: Transform;
    if (count === 1) transform = 'grey';
    else if (override && (count === 4) === (override === 'cmyk')) transform = override;
    else if (count === 3) {
        if (adobe) transform = adobe.transform === 0 ? 'rgb' : 'ycc';
        else if (!jfif && components[0].id === 0x52 && components[1].id === 0x47 && components[2].id === 0x42) transform = 'rgb';
        else transform = 'ycc';
    } else if (count === 4) transform = adobe && adobe.transform === 2 ? 'ycck' : 'cmyk';
    else throw new Error(`JPEG: ${count} color components are not supported`);

    const [p0, p1, p2, p3] = planes;

    // one loop per transform: deciding per pixel costs more than the conversion
    if (transform === 'grey' || transform === 'rgb' || transform === 'ycc') {
        const s0 = p0.samples, s1 = (p1 ?? p0).samples, s2 = (p2 ?? p0).samples;
        const grey = transform === 'grey', ycc = transform === 'ycc';
        // (YCbCr a pixel at a time as a 32-bit word, little endian)
        const words = littleEndian ? new Uint32Array(pixels.buffer) : null;
        for (let y = 0, o = 0; y < height; y++, o = y * width * 4) {
            for (const p of planes) p.fill?.(y);
            const r0 = y * p0.stride, r1 = p1 ? y * p1.stride : r0, r2 = p2 ? y * p2.stride : r0;
            if (grey) for (let x = 0; x < width; x++, o += 4) {
                pixels[o] = pixels[o + 1] = pixels[o + 2] = s0[r0 + x];
                pixels[o + 3] = 0xff;
            } else if (ycc && words) for (let x = 0, w = o >> 2; x < width; x++, w++) {
                const a = s0[r0 + x] + CLAMP_OFFSET, b = s1[r1 + x], c = s2[r2 + x];
                words[w] = (CLAMP[a + crR[c]] | CLAMP[a + (cbG[b] + crG[c] >> 16)] << 8 | CLAMP[a + cbB[b]] << 16 | 0xff000000) >>> 0;
            } else if (ycc) for (let x = 0; x < width; x++, o += 4) {
                const a = s0[r0 + x] + CLAMP_OFFSET, b = s1[r1 + x], c = s2[r2 + x];
                pixels[o] = CLAMP[a + crR[c]];
                pixels[o + 1] = CLAMP[a + (cbG[b] + crG[c] >> 16)];
                pixels[o + 2] = CLAMP[a + cbB[b]];
                pixels[o + 3] = 0xff;
            } else for (let x = 0; x < width; x++, o += 4) {
                pixels[o] = s0[r0 + x];
                pixels[o + 1] = s1[r1 + x];
                pixels[o + 2] = s2[r2 + x];
                pixels[o + 3] = 0xff;
            }
        }
        return pixels;
    }

    for (let y = 0, o = 0; y < height; y++) {
        for (const p of planes) p.fill?.(y);
        const r0 = y * p0.stride, r1 = y * p1.stride, r2 = y * p2.stride, r3 = y * p3.stride;

        for (let x = 0; x < width; x++, o += 4) {
            pixels[o + 3] = 0xff;
            const a = p0.samples[r0 + x], b = p1.samples[r1 + x], c = p2.samples[r2 + x];

            let cyan = a, magenta = b, yellow = c, k = p3.samples[r3 + x];
            if (transform === 'ycck') {
                cyan = 255 - clamp8(a + crR[c]);
                magenta = 255 - clamp8(a + (cbG[b] + crG[c] >> 16));
                yellow = 255 - clamp8(a + cbB[b]);
            }

            // CMYK data written by Adobe applications is stored inverted
            if (adobe) {
                cyan = 255 - cyan;
                magenta = 255 - magenta;
                yellow = 255 - yellow;
                k = 255 - k;
            }

            pixels[o] = cmykToRGB(cyan, k);
            pixels[o + 1] = cmykToRGB(magenta, k);
            pixels[o + 2] = cmykToRGB(yellow, k);
        }
    }

    return pixels;
}

function cmykToRGB(c: number, k: number): number {
    const t = (255 - c) * k + 128;
    return clamp8(255 - (c + ((t >> 8) + t >> 8)));
}

// ---------------------------------------------------------------------------
// encoder
// ---------------------------------------------------------------------------

// ITU T.81 Annex K quantization tables, in natural order
const LUMA_QUANTIZATION = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
];

const CHROMA_QUANTIZATION = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99
];

// libjpeg's fixed point RGB -> YCbCr tables (jccolor.c): Y = (Y_R[r] + Y_G[g] + Y_B[b]) >> 16, Cb with CB_R, CB_G and
// CB_B, Cr with CB_B (for red), CR_G and CR_B
const fix16 = (x: number): number => Math.round(x * 65536);
const Y_R = new Int32Array(256), Y_G = new Int32Array(256), Y_B = new Int32Array(256);
const CB_R = new Int32Array(256), CB_G = new Int32Array(256), CB_B = new Int32Array(256);
const CR_G = new Int32Array(256), CR_B = new Int32Array(256);
for (let i = 0; i < 256; i++) {
    Y_R[i] = fix16(0.299) * i;
    Y_G[i] = fix16(0.587) * i;
    Y_B[i] = fix16(0.114) * i + 32768;
    CB_R[i] = -fix16(0.16874) * i;
    CB_G[i] = -fix16(0.33126) * i;
    // (128 << 16 for the offset, 32767 to round)
    CB_B[i] = fix16(0.5) * i + (128 << 16) + 32767;
    CR_G[i] = -fix16(0.41869) * i;
    CR_B[i] = -fix16(0.08131) * i;
}

// libjpeg-turbo's quantization by reciprocals (jcdctmgr.c, compute_reciprocal, with 16-bit DCT elements): a coefficient's
// magnitude t quantizes to (t + correction) * reciprocal >>> shift, for the divisors of a table (its values times 8,
// the DCT's scale)
function reciprocals(table: number[]): Int32Array {
    // reciprocals, corrections and shifts in natural order
    const r = new Int32Array(3 * 64);
    for (let i = 0; i < 64; i++) {
        const divisor = table[i] * 8;
        const b = 31 - Math.clz32(divisor), shift = 16 + b;
        let fq = Math.floor(2 ** shift / divisor), c = divisor >> 1, bits = shift;
        const fr = 2 ** shift % divisor;
        if (fr === 0) {
            fq >>= 1;
            bits--;
        } else if (fr <= divisor >> 1) c++;
        else fq++;
        r[i] = fq;
        r[64 + i] = c;
        r[128 + i] = bits;
    }
    return r;
}

/**
 * Encodes RGBA pixel data into a baseline JPEG (alpha is ignored), byte for byte like libjpeg-turbo's
 * `cjpeg -quality <quality> -baseline -optimize`: 4:2:0 chroma subsampling up to quality 90 and 4:4:4 above (-sample 1x1)
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} [quality=90] 1-100
 * @return {Uint8Array}
 */
export interface EncodeMetadata {
    /** Exif data (a TIFF header and IFDs), written as APP1 */
    exif?: Uint8Array;
    /** written as comment (COM) */
    comment?: Uint8Array;
}

export function encode(pixels: Uint8Array, width: number, height: number, quality = 90, { exif, comment }: EncodeMetadata = {}): Uint8Array {
    if (!width || !height || width > 0xffff || height > 0xffff) throw new RangeError('JPEG: invalid dimensions');

    quality = Math.min(100, Math.max(1, Math.round(quality)));
    const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
    const scaleTable = (base: number[]): number[] => base.map(v => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
    const tables = [scaleTable(LUMA_QUANTIZATION), scaleTable(CHROMA_QUANTIZATION)];
    const divisors = tables.map(reciprocals);

    // like libjpeg-turbo (cjpeg -optimize, -sample 1x1 above 90), byte for byte: its color conversion, downsampling,
    // integer DCT, quantization and padding
    const subsample = quality <= 90;
    const hmax = subsample ? 2 : 1;
    const mcuSize = 8 * hmax;
    const mcusPerLine = Math.ceil(width / mcuSize);
    const mcusPerColumn = Math.ceil(height / mcuSize);

    // the planes in whole blocks, edges replicated
    const chromaWidth = Math.ceil(width / hmax), chromaHeight = Math.ceil(height / hmax);
    const lumaBlocksX = Math.ceil(width / 8), lumaBlocksY = Math.ceil(height / 8);
    const chromaBlocksX = Math.ceil(chromaWidth / 8), chromaBlocksY = Math.ceil(chromaHeight / 8);
    const W = lumaBlocksX * 8, CW = chromaBlocksX * 8;
    const Y = new Uint8Array(W * lumaBlocksY * 8), Cb = new Uint8Array(CW * chromaBlocksY * 8), Cr = new Uint8Array(CW * chromaBlocksY * 8);
    // (subsampled chroma from pairs of full rows, replicated to twice the planes' width)
    const rowWidth = CW * hmax;
    const cbRows = subsample ? new Uint8Array(2 * rowWidth) : Cb, crRows = subsample ? new Uint8Array(2 * rowWidth) : Cr;

    // (pixels a 32-bit word at a time where they're aligned, little endian)
    const words = littleEndian && pixels.byteOffset % 4 === 0 ? new Uint32Array(pixels.buffer, pixels.byteOffset, width * height) : null;
    for (let y = 0; y < height; y++) {
        const row = subsample ? (y & 1) * rowWidth : y * CW;
        let i = y * width * 4, o = y * W, c = row;

        if (words) for (let x = 0, w = i >> 2; x < width; x++, w++, o++, c++) {
            const p = words[w], r = p & 255, g = p >> 8 & 255, b = p >> 16 & 255;
            Y[o] = Y_R[r] + Y_G[g] + Y_B[b] >> 16;
            cbRows[c] = CB_R[r] + CB_G[g] + CB_B[b] >> 16;
            crRows[c] = CB_B[r] + CR_G[g] + CR_B[b] >> 16;
        } else for (let x = 0; x < width; x++, i += 4, o++, c++) {
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            Y[o] = Y_R[r] + Y_G[g] + Y_B[b] >> 16;
            cbRows[c] = CB_R[r] + CB_G[g] + CB_B[b] >> 16;
            crRows[c] = CB_B[r] + CR_G[g] + CR_B[b] >> 16;
        }

        Y.fill(Y[o - 1], o, (y + 1) * W);
        cbRows.fill(cbRows[c - 1], c, row + rowWidth);
        crRows.fill(crRows[c - 1], c, row + rowWidth);

        // (h2v2_downsample: the sums of 2x2 samples, rounded up and down by turns)
        if (subsample && (y & 1 || y === height - 1)) {
            if (!(y & 1)) {
                cbRows.copyWithin(rowWidth, 0, rowWidth);
                crRows.copyWithin(rowWidth, 0, rowWidth);
            }
            for (let x = 0, o = (y >> 1) * CW, bias = 1; x < rowWidth; x += 2, o++, bias ^= 3) {
                Cb[o] = cbRows[x] + cbRows[x + 1] + cbRows[x + rowWidth] + cbRows[x + rowWidth + 1] + bias >> 2;
                Cr[o] = crRows[x] + crRows[x + 1] + crRows[x + rowWidth] + crRows[x + rowWidth + 1] + bias >> 2;
            }
        }
    }

    for (let y = height; y < lumaBlocksY * 8; y++) Y.copyWithin(y * W, (height - 1) * W, height * W);
    for (let y = chromaHeight; y < chromaBlocksY * 8; y++) {
        Cb.copyWithin(y * CW, (chromaHeight - 1) * CW, chromaHeight * CW);
        Cr.copyWithin(y * CW, (chromaHeight - 1) * CW, chromaHeight * CW);
    }

    const components = [
        { plane: Y, stride: W, h: hmax, v: hmax, blocksX: lumaBlocksX, blocksY: lumaBlocksY, table: 0 },
        { plane: Cb, stride: CW, h: 1, v: 1, blocksX: chromaBlocksX, blocksY: chromaBlocksY, table: 1 },
        { plane: Cr, stride: CW, h: 1, v: 1, blocksX: chromaBlocksX, blocksY: chromaBlocksY, table: 1 }
    ];

    // quantized blocks in MCU order (Y blocks, then Cb, then Cr), their coefficients in zigzag order, with the index
    // of each block's last nonzero coefficient. MCUs reaching past a component's blocks get dummy blocks (jccoefct.c):
    // without AC coefficients, with the DC coefficient of the block before (below the image: of the MCU's block
    // before the row)
    const blocksPerMcu = hmax * hmax + 2;
    const count = mcusPerLine * mcusPerColumn * blocksPerMcu;
    const coefficients = new Int16Array(count * 64);
    const owners = new Uint8Array(count), ends = new Uint8Array(count);
    const block = new Int32Array(64);
    let n = 0;

    for (let my = 0; my < mcusPerColumn; my++)
        for (let mx = 0; mx < mcusPerLine; mx++)
            for (let c = 0; c < 3; c++) {
                const { plane, stride, h: ch, v: cv, blocksX, blocksY, table } = components[c];
                const reciprocal = divisors[table];

                for (let v = 0; v < cv; v++) {
                    const by = my * cv + v, rowStart = n;
                    for (let h = 0; h < ch; h++, n++) {
                        const bx = mx * ch + h, o = n * 64;
                        owners[n] = c;

                        if (by >= blocksY) {
                            coefficients[o] = coefficients[(rowStart - 1) * 64];
                            continue;
                        }
                        if (bx >= blocksX) {
                            coefficients[o] = coefficients[o - 64];
                            continue;
                        }

                        fdct(plane, by * 8 * stride + bx * 8, stride, block);
                        let end = 0;
                        for (let k = 0; k < 64; k++) {
                            // (the magnitude's, the product below 2^32, signed again)
                            const i = ZIGZAG[k], t = block[i], sign = t >> 31;
                            const value = (Math.imul((t ^ sign) - sign + reciprocal[64 + i], reciprocal[i]) >>> reciprocal[128 + i] ^ sign) - sign;
                            coefficients[o + k] = value;
                            if (value) end = k;
                        }
                        ends[n] = end;
                    }
                }
            }

    const blocks = { coefficients, owners, ends, count };

    // pass 1: gather symbol statistics, pass 2: write with optimal tables
    const frequencies = [new Int32Array(257), new Int32Array(257), new Int32Array(257), new Int32Array(257)];
    countSymbols(blocks, frequencies);

    const huffman = frequencies.map(buildOptimalTable);
    const writer = new BitWriter(width * height);

    writer.bytes(0xff, 0xd8);
    // JFIF APP0
    writer.bytes(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
    // segments hold up to 65533 bytes
    const segment = (marker: number, body: ArrayLike<number>): void => {
        if (body.length > 65533) throw new RangeError('JPEG: metadata too large');
        writer.bytes(0xff, marker, body.length + 2 >> 8, body.length + 2 & 255);
        for (let i = 0; i < body.length; i++) writer.bytes(body[i]);
    };
    if (exif) segment(0xe1, concat([[0x45, 0x78, 0x69, 0x66, 0, 0], exif]));
    if (comment) segment(0xfe, comment);

    // DQT, a segment per table like libjpeg
    for (let t = 0; t < 2; t++) {
        writer.bytes(0xff, 0xdb, 0x00, 0x43, t);
        for (let k = 0; k < 64; k++) writer.bytes(tables[t][ZIGZAG[k]]);
    }

    // SOF0
    writer.bytes(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03);
    writer.bytes(1, hmax << 4 | hmax, 0, 2, 0x11, 1, 3, 0x11, 1);

    // DHT: luma DC, luma AC, chroma DC, chroma AC
    for (const [index, id] of [[0, 0x00], [1, 0x10], [2, 0x01], [3, 0x11]] as Array<[number, number]>) {
        const { bits, values } = huffman[index];
        const length = 19 + values.length;
        writer.bytes(0xff, 0xc4, length >> 8, length & 0xff, id);
        for (let i = 1; i <= 16; i++) writer.bytes(bits[i]);
        for (const value of values) writer.bytes(value);
    }

    // SOS
    writer.bytes(0xff, 0xda, 0x00, 0x0c, 0x03, 1, 0x00, 2, 0x11, 3, 0x11, 0x00, 0x3f, 0x00);

    writeBlocks(blocks, huffman, writer);
    writer.flush();
    writer.bytes(0xff, 0xd9);
    return writer.finish();
}

// tables: 0 luma DC, 1 luma AC, 2 chroma DC, 3 chroma AC
interface Blocks {
    coefficients: Int16Array;
    owners: Uint8Array;
    ends: Uint8Array;
    count: number;
}

// counts the symbols the blocks take (the DC differences' sizes, AC runs and sizes)
function countSymbols({ coefficients, owners, ends, count }: Blocks, frequencies: Int32Array[]): void {
    const pred = [0, 0, 0];

    for (let n = 0; n < count; n++) {
        const component = owners[n], o = n * 64;
        const dc = frequencies[component === 0 ? 0 : 2], ac = frequencies[component === 0 ? 1 : 3];

        dc[magnitude(coefficients[o] - pred[component])]++;
        pred[component] = coefficients[o];

        let run = 0;
        for (let k = 1, end = ends[n]; k <= end; k++) {
            const value = coefficients[o + k];
            if (value === 0) {
                run++;
                continue;
            }
            for (; run > 15; run -= 16) ac[0xf0]++;
            ac[run << 4 | magnitude(value)]++;
            run = 0;
        }

        if (ends[n] < 63) ac[0]++;
    }
}

// writes the blocks' symbols and bits
function writeBlocks({ coefficients, owners, ends, count }: Blocks, huffman: OptimalTable[], writer: BitWriter): void {
    const pred = [0, 0, 0];
    let { bits, count: pending, buffer, length } = writer;

    // (the bits in a local, bytes stuffed with a zero after 0xff, like BitWriter.write)
    const put = (value: number, size: number): void => {
        bits = bits << size | value & (1 << size) - 1;
        pending += size;
        while (pending >= 8) {
            pending -= 8;
            const byte = bits >>> pending & 0xff;
            if (length + 2 > buffer.length) {
                writer.length = length;
                writer.reserve(2);
                buffer = writer.buffer;
            }
            buffer[length++] = byte;
            if (byte === 0xff) buffer[length++] = 0x00;
        }
        bits &= (1 << pending) - 1;
    };

    for (let n = 0; n < count; n++) {
        const component = owners[n], o = n * 64;
        const dc = huffman[component === 0 ? 0 : 2], ac = huffman[component === 0 ? 1 : 3];
        const dcCodes = dc.codes, dcSizes = dc.sizes, acCodes = ac.codes, acSizes = ac.sizes;

        const diff = coefficients[o] - pred[component];
        pred[component] = coefficients[o];
        const size = magnitude(diff);
        put(dcCodes[size], dcSizes[size]);
        if (size) put(diff < 0 ? diff - 1 : diff, size);

        let run = 0;
        for (let k = 1, end = ends[n]; k <= end; k++) {
            const value = coefficients[o + k];
            if (value === 0) {
                run++;
                continue;
            }
            for (; run > 15; run -= 16) put(acCodes[0xf0], acSizes[0xf0]);
            const s = magnitude(value), symbol = run << 4 | s;
            put(acCodes[symbol], acSizes[symbol]);
            put(value < 0 ? value - 1 : value, s);
            run = 0;
        }

        if (ends[n] < 63) put(acCodes[0], acSizes[0]);
    }

    writer.bits = bits;
    writer.count = pending;
    writer.length = length;
}

// the bits a value takes
function magnitude(value: number): number {
    return 32 - Math.clz32(Math.abs(value));
}

// libjpeg's jpeg_gen_optimal_table (ITU T.81 Annex K.2)
interface OptimalTable {
    bits: Int32Array;
    values: number[];
    codes: Int32Array;
    sizes: Int32Array;
}

function buildOptimalTable(frequencies: Int32Array): OptimalTable {
    const freq = Int32Array.from(frequencies);
    const codesize = new Int32Array(257);
    const others = new Int32Array(257).fill(-1);
    freq[256] = 1; // reserved, guarantees no code consists of all ones

    for (; ;) {
        let c1 = -1, c2 = -1, v1 = Infinity, v2 = Infinity;
        for (let i = 0; i <= 256; i++)
            if (freq[i] && freq[i] <= v1) {
                v1 = freq[i];
                c1 = i;
            }
        for (let i = 0; i <= 256; i++)
            if (freq[i] && freq[i] <= v2 && i !== c1) {
                v2 = freq[i];
                c2 = i;
            }
        if (c2 < 0) break;

        freq[c1] += freq[c2];
        freq[c2] = 0;

        codesize[c1]++;
        while (others[c1] >= 0) {
            c1 = others[c1];
            codesize[c1]++;
        }
        others[c1] = c2;

        codesize[c2]++;
        while (others[c2] >= 0) {
            c2 = others[c2];
            codesize[c2]++;
        }
    }

    const bits = new Int32Array(33);
    for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;

    // limit code lengths to 16 bits
    for (let i = 32; i > 16; i--) {
        while (bits[i] > 0) {
            let j = i - 2;
            while (bits[j] === 0) j--;
            bits[i] -= 2;
            bits[i - 1]++;
            bits[j + 1] += 2;
            bits[j]--;
        }
    }

    // remove the reserved code point
    let i = 16;
    while (bits[i] === 0) i--;
    bits[i]--;

    const values = [];
    for (let length = 1; length <= 32; length++)
        for (let symbol = 0; symbol < 256; symbol++)
            if (codesize[symbol] === length) values.push(symbol);

    // canonical codes
    const codes = new Int32Array(256);
    const sizes = new Int32Array(256);
    let code = 0, k = 0;
    for (let length = 1; length <= 16; length++) {
        for (let n = 0; n < bits[length]; n++, k++) {
            codes[values[k]] = code++;
            sizes[values[k]] = length;
        }
        code <<= 1;
    }

    return { bits: bits.subarray(0, 17), values, codes, sizes };
}

// libjpeg's jpeg_fdct_float (AAN), output scaled by AAN_SCALE[row] * AAN_SCALE[col] * 8
// libjpeg's integer forward DCT (jfdctint.c, jpeg_fdct_islow) of the block at `offset` in a plane, its samples
// centered around 0, into d (scaled up by 8)
function fdct(plane: Uint8Array, offset: number, stride: number, d: Int32Array): void {
    const P1 = CONST_BITS - PASS1_BITS, R1 = 1 << P1 - 1;

    for (let row = 0; row < 64; row += 8, offset += stride) {
        const s0 = plane[offset] - 128, s1 = plane[offset + 1] - 128, s2 = plane[offset + 2] - 128, s3 = plane[offset + 3] - 128;
        const s4 = plane[offset + 4] - 128, s5 = plane[offset + 5] - 128, s6 = plane[offset + 6] - 128, s7 = plane[offset + 7] - 128;
        let tmp4 = s3 - s4, tmp5 = s2 - s5, tmp6 = s1 - s6, tmp7 = s0 - s7;
        const tmp0 = s0 + s7, tmp1 = s1 + s6, tmp2 = s2 + s5, tmp3 = s3 + s4;

        const tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3, tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
        d[row] = tmp10 + tmp11 << PASS1_BITS;
        d[row + 4] = tmp10 - tmp11 << PASS1_BITS;
        const z1 = (tmp12 + tmp13) * FIX_0_541196100;
        d[row + 2] = z1 + tmp13 * FIX_0_765366865 + R1 >> P1;
        d[row + 6] = z1 - tmp12 * FIX_1_847759065 + R1 >> P1;

        let o1 = tmp4 + tmp7, o2 = tmp5 + tmp6, o3 = tmp4 + tmp6, o4 = tmp5 + tmp7;
        const z5 = (o3 + o4) * FIX_1_175875602;
        tmp4 *= FIX_0_298631336;
        tmp5 *= FIX_2_053119869;
        tmp6 *= FIX_3_072711026;
        tmp7 *= FIX_1_501321110;
        o1 *= -FIX_0_899976223;
        o2 *= -FIX_2_562915447;
        o3 = o3 * -FIX_1_961570560 + z5;
        o4 = o4 * -FIX_0_390180644 + z5;
        d[row + 7] = tmp4 + o1 + o3 + R1 >> P1;
        d[row + 5] = tmp5 + o2 + o4 + R1 >> P1;
        d[row + 3] = tmp6 + o2 + o3 + R1 >> P1;
        d[row + 1] = tmp7 + o1 + o4 + R1 >> P1;
    }

    const P2 = CONST_BITS + PASS1_BITS, R2 = 1 << P2 - 1;

    for (let c = 0; c < 8; c++) {
        const s0 = d[c], s1 = d[c + 8], s2 = d[c + 16], s3 = d[c + 24], s4 = d[c + 32], s5 = d[c + 40], s6 = d[c + 48], s7 = d[c + 56];
        let tmp4 = s3 - s4, tmp5 = s2 - s5, tmp6 = s1 - s6, tmp7 = s0 - s7;
        const tmp0 = s0 + s7, tmp1 = s1 + s6, tmp2 = s2 + s5, tmp3 = s3 + s4;

        const tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3, tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
        d[c] = tmp10 + tmp11 + (1 << PASS1_BITS - 1) >> PASS1_BITS;
        d[c + 32] = tmp10 - tmp11 + (1 << PASS1_BITS - 1) >> PASS1_BITS;
        const z1 = (tmp12 + tmp13) * FIX_0_541196100;
        d[c + 16] = z1 + tmp13 * FIX_0_765366865 + R2 >> P2;
        d[c + 48] = z1 - tmp12 * FIX_1_847759065 + R2 >> P2;

        let o1 = tmp4 + tmp7, o2 = tmp5 + tmp6, o3 = tmp4 + tmp6, o4 = tmp5 + tmp7;
        const z5 = (o3 + o4) * FIX_1_175875602;
        tmp4 *= FIX_0_298631336;
        tmp5 *= FIX_2_053119869;
        tmp6 *= FIX_3_072711026;
        tmp7 *= FIX_1_501321110;
        o1 *= -FIX_0_899976223;
        o2 *= -FIX_2_562915447;
        o3 = o3 * -FIX_1_961570560 + z5;
        o4 = o4 * -FIX_0_390180644 + z5;
        d[c + 56] = tmp4 + o1 + o3 + R2 >> P2;
        d[c + 40] = tmp5 + o2 + o4 + R2 >> P2;
        d[c + 24] = tmp6 + o2 + o3 + R2 >> P2;
        d[c + 8] = tmp7 + o1 + o4 + R2 >> P2;
    }
}

class BitWriter extends ByteWriter {
    bits = 0;
    count = 0;

    // writes `size` bits MSB first, stuffing a zero after every 0xff byte
    write(value: number, size: number): void {
        this.bits = this.bits << size | value & (1 << size) - 1;
        this.count += size;

        while (this.count >= 8) {
            this.count -= 8;
            const byte = this.bits >>> this.count & 0xff;
            this.reserve(2);
            this.buffer[this.length++] = byte;
            if (byte === 0xff) this.buffer[this.length++] = 0x00;
        }

        this.bits &= (1 << this.count) - 1;
    }

    // pads the last byte with ones
    flush(): void {
        if (this.count) this.write((1 << 8 - this.count) - 1, 8 - this.count);
    }

}

