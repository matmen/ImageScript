import { MAX_PIXELS, checkPixels } from '../util/limits.ts';
import { toSRGB, ToneMapping } from './hdr.ts';

// Netpbm: PBM, PGM and PPM (plain and raw), PAM, and PFM (floating point samples, linear light tone mapped like Radiance
// HDRs'). A file
// with several images decodes as its first

const isSpace = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d);

/** Whether the data starts like a Netpbm image: P1-P6, PF or Pf and whitespace, or P7 and a line break (PAM) */
export function isNetpbm(d: Uint8Array): boolean {
    if (d.length < 3 || d[0] !== 0x50) return false;
    // (XV thumbnails start with P7 332)
    if (d[1] === 0x37) return d[2] === 0x0a;
    return (d[1] >= 0x31 && d[1] <= 0x36 || d[1] === 0x46 || d[1] === 0x66) && isSpace(d[2]);
}

// reads the header's tokens: whitespace separated, comments from # to the line end
class Reader {
    constructor(private d: Uint8Array, public o: number) {}

    skip(): void {
        const d = this.d;
        while (this.o < d.length) {
            if (d[this.o] === 0x23) while (this.o < d.length && d[this.o] !== 0x0a && d[this.o] !== 0x0d) this.o++;
            else if (isSpace(d[this.o])) this.o++;
            else break;
        }
    }

    token(): string {
        this.skip();
        const start = this.o;
        while (this.o < this.d.length && !isSpace(this.d[this.o]) && this.d[this.o] !== 0x23) this.o++;
        if (start === this.o) throw new Error('Netpbm: truncated header');
        return String.fromCharCode(...this.d.subarray(start, this.o));
    }

    integer(name: string): number {
        const token = this.token();
        if (!/^\d{1,10}$/.test(token)) throw new Error(`Netpbm: invalid ${name} ${token.slice(0, 20)}`);
        return +token;
    }
}

interface Header { width: number, height: number, depth: number, maxval: number, tupleType: string, data: number }

// the PAM header: lines of a name and its value up to ENDHDR
function pamHeader(d: Uint8Array): Header {
    const fields: Record<string, string> = {};
    const types: string[] = [];
    let o = 3;
    for (;;) {
        let end = o;
        while (end < d.length && d[end] !== 0x0a) end++;
        if (end >= d.length) throw new Error('PAM: truncated header');
        const line = String.fromCharCode(...d.subarray(o, end)).trim();
        o = end + 1;
        if (line === 'ENDHDR') break;
        if (!line || line[0] === '#') continue;
        const [name, ...value] = line.split(/\s+/);
        if (name === 'TUPLTYPE') types.push(value.join(' '));
        else fields[name] = value.join(' ');
    }
    const number = (name: string): number => {
        if (!/^\d{1,10}$/.test(fields[name] ?? '')) throw new Error(`PAM: invalid ${name}`);
        return +fields[name];
    };
    return { width: number('WIDTH'), height: number('HEIGHT'), depth: number('DEPTH'), maxval: number('MAXVAL'), tupleType: types.join(' '), data: o };
}

/** Decodes a Netpbm image into RGBA */
export function decode(d: Uint8Array, maxPixels = MAX_PIXELS, toneMapping: ToneMapping = 'reinhard'): { width: number, height: number, pixels: Uint8Array } {
    if (!isNetpbm(d)) throw new Error('Netpbm: invalid header');
    const kind = String.fromCharCode(d[1]);
    if (kind === 'F' || kind === 'f') return decodePFM(d, kind === 'F' ? 3 : 1, maxPixels, toneMapping);

    let header: Header;
    const reader = new Reader(d, 2);
    if (kind === '7') header = pamHeader(d);
    else {
        const width = reader.integer('width'), height = reader.integer('height');
        const bitmap = kind === '1' || kind === '4';
        const maxval = bitmap ? 1 : reader.integer('maxval');
        // a single whitespace character ends the header of raw images
        if (kind >= '4' && reader.o >= d.length) throw new Error('Netpbm: truncated header');
        header = { width, height, depth: kind === '3' || kind === '6' ? 3 : 1, maxval, tupleType: bitmap ? 'PBM' : '', data: reader.o + 1 };
    }

    const { width, height, depth, maxval } = header;
    if (!width || !height) throw new Error(`Netpbm: invalid dimensions ${width}x${height}`);
    if (!maxval || maxval > 65535) throw new Error(`Netpbm: invalid maxval ${maxval}`);
    if (depth < 1 || depth > 4) throw new Error(`PAM: unsupported depth ${depth}`);
    checkPixels(width, height, maxPixels);

    // the samples, scaled to 8 bits
    const count = width * height, samples = new Uint8Array(count * depth);
    const scale = (v: number): number => v >= maxval ? 255 : Math.round(v * 255 / maxval);
    if (kind === '1' || kind === '2' || kind === '3') {
        // plain: decimal numbers, a PBM's digits may follow each other without whitespace
        let o = header.data - 1;
        for (let i = 0; i < samples.length; i++) {
            while (o < d.length && (isSpace(d[o]) || d[o] === 0x23)) {
                if (d[o] === 0x23) while (o < d.length && d[o] !== 0x0a) o++;
                else o++;
            }
            if (o >= d.length) throw new Error('Netpbm: truncated image data');
            let v = 0;
            if (kind === '1') v = d[o++] - 0x30;
            else {
                const start = o;
                while (o < d.length && d[o] >= 0x30 && d[o] <= 0x39 && o - start < 6) v = v * 10 + d[o++] - 0x30;
                if (start === o) throw new Error('Netpbm: invalid sample');
            }
            if (v < 0 || v > maxval) throw new Error('Netpbm: invalid sample');
            samples[i] = kind === '1' ? (v ? 0 : 255) : scale(v);
        }
    } else if (kind === '4') {
        const stride = width + 7 >> 3;
        if (header.data + stride * height > d.length) throw new Error('Netpbm: truncated image data');
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) samples[y * width + x] = d[header.data + y * stride + (x >> 3)] >> (7 - (x & 7)) & 1 ? 0 : 255;
    } else {
        const wide = maxval > 255;
        if (header.data + samples.length * (wide ? 2 : 1) > d.length) throw new Error('Netpbm: truncated image data');
        for (let i = 0, o = header.data; i < samples.length; i++, o += wide ? 2 : 1) samples[i] = scale(wide ? d[o] << 8 | d[o + 1] : d[o]);
    }

    // greyscale, greyscale and alpha, RGB, RGBA (by the depth; PAM's tuple types say the same)
    const pixels = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
        const s = i * depth, p = i * 4;
        if (depth < 3) {
            pixels[p] = pixels[p + 1] = pixels[p + 2] = samples[s];
            pixels[p + 3] = depth === 2 ? samples[s + 1] : 255;
        } else {
            pixels[p] = samples[s]; pixels[p + 1] = samples[s + 1]; pixels[p + 2] = samples[s + 2];
            pixels[p + 3] = depth === 4 ? samples[s + 3] : 255;
        }
    }
    return { width, height, pixels };
}

// PFM: 32 bit floats, little endian if the scale is negative, rows from the bottom up
function decodePFM(d: Uint8Array, channels: number, maxPixels: number, toneMapping: ToneMapping): { width: number, height: number, pixels: Uint8Array } {
    const reader = new Reader(d, 2);
    const width = reader.integer('width'), height = reader.integer('height');
    const scale = +reader.token();
    if (!width || !height) throw new Error(`PFM: invalid dimensions ${width}x${height}`);
    if (!Number.isFinite(scale) || !scale) throw new Error('PFM: invalid scale');
    checkPixels(width, height, maxPixels);
    const start = reader.o + 1;
    if (start + width * height * channels * 4 > d.length) throw new Error('PFM: truncated image data');

    const view = new DataView(d.buffer, d.byteOffset + start);
    const little = scale < 0;
    const rgb = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const s = ((height - 1 - y) * width + x) * channels * 4, p = (y * width + x) * 3;
            for (let c = 0; c < 3; c++) rgb[p + c] = view.getFloat32(s + (channels === 3 ? c * 4 : 0), little);
        }
    }
    return { width, height, pixels: toSRGB(rgb, toneMapping) };
}

/**
 * Encodes RGBA pixels into the smallest fitting Netpbm format: PBM for black and white images, PGM for greyscale
 * ones, PPM, and PAM (greyscale or RGB with alpha) for images with transparency
 */
export function encode(rgba: Uint8Array, width: number, height: number): Uint8Array {
    if (width < 1 || height < 1) throw new RangeError('Netpbm: dimensions must be at least 1');
    const count = width * height;
    let opaque = true, grey = true, bitmap = true;
    for (let p = 0; p < count * 4; p += 4) {
        const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2], a = rgba[p + 3];
        if (a !== 255) opaque = false;
        if (r !== g || g !== b) grey = false;
        if (r !== 0 && r !== 255 || r !== g || g !== b) bitmap = false;
        if (!opaque && !grey) break;
    }

    const ascii = (text: string): Uint8Array => Uint8Array.from(text, c => c.charCodeAt(0));
    let header: Uint8Array, depth: number;
    if (!opaque) {
        depth = grey ? 2 : 4;
        header = ascii(`P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH ${depth}\nMAXVAL 255\nTUPLTYPE ${grey ? 'GRAYSCALE_ALPHA' : 'RGB_ALPHA'}\nENDHDR\n`);
    } else if (bitmap) {
        depth = 0;
        header = ascii(`P4\n${width} ${height}\n`);
    } else {
        depth = grey ? 1 : 3;
        header = ascii(`P${grey ? 5 : 6}\n${width} ${height}\n255\n`);
    }

    const stride = depth ? width * depth : width + 7 >> 3;
    const out = new Uint8Array(header.length + stride * height);
    out.set(header);
    let o = header.length;
    if (!depth) {
        // PBM: 1 is black
        for (let y = 0; y < height; y++, o += stride)
            for (let x = 0; x < width; x++) if (!rgba[(y * width + x) * 4]) out[o + (x >> 3)] |= 128 >> (x & 7);
    } else {
        for (let p = 0; p < count * 4; p += 4) {
            if (depth === 1 || depth === 2) out[o++] = rgba[p];
            else { out[o++] = rgba[p]; out[o++] = rgba[p + 1]; out[o++] = rgba[p + 2]; }
            if (depth === 2 || depth === 4) out[o++] = rgba[p + 3];
        }
    }
    return out;
}
