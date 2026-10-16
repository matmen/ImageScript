import { encode as utf8 } from '../util/utf8.ts';
import { MAX_PIXELS, checkPixels } from '../util/limits.ts';

// Truevision TGA: color mapped, truecolor and greyscale images, uncompressed or run length encoded

const SIGNATURE = 'TRUEVISION-XFILE.\0';

interface Header {
    idLength: number;
    colorMapType: number;
    imageType: number;
    mapFirst: number;
    mapLength: number;
    mapEntrySize: number;
    width: number;
    height: number;
    depth: number;
    alphaBits: number;
    rightToLeft: boolean;
    topToBottom: boolean;
}

function readHeader(d: Uint8Array): Header | null {
    if (d.length < 18) return null;
    return {
        idLength: d[0],
        colorMapType: d[1],
        imageType: d[2],
        mapFirst: d[3] | d[4] << 8,
        mapLength: d[5] | d[6] << 8,
        mapEntrySize: d[7],
        width: d[12] | d[13] << 8,
        height: d[14] | d[15] << 8,
        depth: d[16],
        alphaBits: d[17] & 15,
        rightToLeft: (d[17] & 16) !== 0,
        topToBottom: (d[17] & 32) !== 0
    };
}

/** Whether the data has the TGA 2.0 footer */
function hasFooter(d: Uint8Array): boolean {
    if (d.length < 44) return false;
    for (let i = 0; i < SIGNATURE.length; i++) if (d[d.length - 18 + i] !== SIGNATURE.charCodeAt(i)) return false;
    return true;
}

/**
 * Whether the data looks like a TGA. Older TGAs have no signature, so this checks that the header is consistent
 */
export function isTGA(d: Uint8Array): boolean {
    const h = readHeader(d);
    if (!h) return false;
    if (hasFooter(d)) return true;

    const base = h.imageType & ~8;
    if (h.colorMapType > 1 || ![1, 2, 3].includes(base) || h.imageType > 11 || (h.imageType & 4)) return false;
    if (!h.width || !h.height || d[17] & 0xc0) return false;
    if (base === 1 && (h.colorMapType !== 1 || (h.depth !== 8 && h.depth !== 16))) return false;
    if (base === 2 && ![15, 16, 24, 32].includes(h.depth)) return false;
    if (base === 3 && h.depth !== 8 && h.depth !== 16) return false;
    if (h.colorMapType === 1 && ![8, 15, 16, 24, 32].includes(h.mapEntrySize)) return false;

    // the image data has to fit: exactly for uncompressed images, at least a byte per packet for RLE
    const mapBytes = h.colorMapType ? h.mapLength * Math.ceil(h.mapEntrySize / 8) : 0;
    const dataStart = 18 + h.idLength + mapBytes;
    const pixelBytes = h.width * h.height * Math.ceil(h.depth / 8);
    return h.imageType & 8 ? d.length > dataStart : d.length >= dataStart + pixelBytes;
}

// reads a 15/16/24/32 bit color (BGR(A), 5 bits per channel for 15/16), or 8 bit grey (color maps)
function readColor(d: Uint8Array, o: number, bits: number, alphaBits: number, out: Uint8Array, p: number): void {
    if (bits === 8) {
        out[p] = out[p + 1] = out[p + 2] = d[o];
        out[p + 3] = 255;
    } else if (bits === 15 || bits === 16) {
        // the 16th bit is an "attribute" bit, writers fill it inconsistently (zero, inverted alpha, or unrelated):
        // like image-rs, it is ignored
        const v = d[o] | d[o + 1] << 8;
        out[p] = (v >> 10 & 31) * 255 / 31 | 0;
        out[p + 1] = (v >> 5 & 31) * 255 / 31 | 0;
        out[p + 2] = (v & 31) * 255 / 31 | 0;
        out[p + 3] = 255;
    } else {
        out[p] = d[o + 2];
        out[p + 1] = d[o + 1];
        out[p + 2] = d[o];
        out[p + 3] = bits === 32 && alphaBits ? d[o + 3] : 255;
    }
}

/**
 * Decodes a TGA into RGBA
 */
export function decode(d: Uint8Array, maxPixels = MAX_PIXELS): { width: number, height: number, pixels: Uint8Array } {
    const h = readHeader(d);
    if (!h || !isTGA(d)) throw new Error('TGA: invalid header');
    const { width, height, depth } = h;
    checkPixels(width, height, maxPixels);
    const base = h.imageType & ~8, rle = (h.imageType & 8) !== 0;
    const bytesPerPixel = Math.ceil(depth / 8);

    let offset = 18 + h.idLength;
    let palette: Uint8Array | null = null;
    if (h.colorMapType === 1) {
        const entryBytes = Math.ceil(h.mapEntrySize / 8);
        palette = new Uint8Array((h.mapFirst + h.mapLength) * 4);
        for (let i = 0; i < h.mapLength; i++) {
            if (offset + entryBytes > d.length) throw new Error('TGA: truncated color map');
            readColor(d, offset, h.mapEntrySize, h.alphaBits, palette, (h.mapFirst + i) * 4);
            offset += entryBytes;
        }
    }
    if (base === 1 && !palette) throw new Error('TGA: color mapped image without color map');

    // the pixel data in file order, expanded to RGBA
    const count = width * height;
    const stored = new Uint8Array(count * 4);
    const pixel = (o: number, p: number): void => {
        if (base === 1) {
            const index = depth === 16 ? d[o] | d[o + 1] << 8 : d[o];
            const pal = palette as Uint8Array;
            if (index * 4 + 3 < pal.length) stored.set(pal.subarray(index * 4, index * 4 + 4), p);
            else stored[p + 3] = 255; // out of range indices become black
        } else if (base === 3) {
            stored[p] = stored[p + 1] = stored[p + 2] = d[o];
            stored[p + 3] = depth === 16 ? d[o + 1] : 255;
        } else readColor(d, o, depth, h.alphaBits, stored, p);
    };

    if (!rle) {
        if (offset + count * bytesPerPixel > d.length) throw new Error('TGA: truncated image data');
        for (let i = 0; i < count; i++) pixel(offset + i * bytesPerPixel, i * 4);
    } else {
        // packets: high bit set = one pixel repeated (n & 127) + 1 times, otherwise (n + 1) raw pixels;
        // packets may cross scan lines
        for (let i = 0; i < count;) {
            if (offset >= d.length) throw new Error('TGA: truncated image data');
            const header = d[offset++];
            const n = (header & 127) + 1;
            if (offset + (header & 128 ? 1 : n) * bytesPerPixel > d.length) throw new Error('TGA: truncated image data');
            if (header & 128) {
                pixel(offset, i * 4);
                for (let k = 1; k < n && i + k < count; k++) stored.copyWithin((i + k) * 4, i * 4, i * 4 + 4);
                offset += bytesPerPixel;
            } else {
                for (let k = 0; k < n && i + k < count; k++) pixel(offset + k * bytesPerPixel, (i + k) * 4);
                offset += n * bytesPerPixel;
            }
            i += n;
        }
    }

    // the default origin is the bottom left
    if (!h.topToBottom || h.rightToLeft) {
        const pixels = new Uint8Array(count * 4);
        const src = new Uint32Array(stored.buffer), dst = new Uint32Array(pixels.buffer);
        for (let y = 0; y < height; y++) {
            const sy = h.topToBottom ? y : height - 1 - y;
            for (let x = 0; x < width; x++) dst[y * width + x] = src[sy * width + (h.rightToLeft ? width - 1 - x : x)];
        }
        return { width, height, pixels };
    }

    return { width, height, pixels: stored };
}

/**
 * Encodes RGBA pixels into a run length encoded TGA (32 bit with alpha, 24 bit if opaque), top left origin
 */
export interface Extension {
    author?: string;
    /** up to four lines of 80 bytes */
    comment?: string;
    time?: Date;
    software?: string;
}

// UTF-8, split into pieces of whole characters of at most `max` bytes
function pieces(value: string, max: number): Uint8Array[] {
    const bytes = utf8(value);
    const out: Uint8Array[] = [];
    for (let start = 0; start < bytes.length;) {
        let end = Math.min(bytes.length, start + max);
        while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
        out.push(bytes.subarray(start, end));
        start = end;
    }
    return out;
}

// the TGA 2.0 extension area (495 bytes), text fields are NUL terminated
function extensionArea({ author, comment, time, software }: Extension, alpha: boolean): Uint8Array {
    const area = new Uint8Array(495);
    const view = new DataView(area.buffer);
    view.setUint16(0, 495, true);
    if (author) area.set(pieces(author, 40)[0], 2);
    if (comment) {
        // four lines of 80 bytes, longer lines wrap
        const lines = comment.split(/\r?\n/).flatMap(line => line ? pieces(line, 80) : [new Uint8Array(0)]).slice(0, 4);
        lines.forEach((line, i) => area.set(line, 43 + i * 81));
    }
    if (time) [time.getUTCMonth() + 1, time.getUTCDate(), time.getUTCFullYear(), time.getUTCHours(), time.getUTCMinutes(), time.getUTCSeconds()]
        .forEach((v, i) => view.setUint16(367 + i * 2, v, true));
    if (software) area.set(pieces(software, 40)[0], 426);
    area[469] = 0x20; // no software version letter
    area[494] = alpha ? 3 : 0; // attributes type: useful alpha or none
    return area;
}

export function encode(rgba: Uint8Array, width: number, height: number, extension?: Extension): Uint8Array {
    if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new RangeError('TGA: dimensions must be 1-65535');

    let opaque = true;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
    const bpp = opaque ? 3 : 4;
    const count = width * height;
    if (rgba.byteOffset % 4) rgba = rgba.slice(0, count * 4);
    const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, count);

    // worst case: a header byte per 128 raw pixels of a row, the extension area and the footer
    const out = new Uint8Array(18 + count * bpp + height * Math.ceil(width / 128) + 495 + 26);
    out[2] = 10; // RLE truecolor
    out[12] = width & 255; out[13] = width >> 8;
    out[14] = height & 255; out[15] = height >> 8;
    out[16] = bpp * 8;
    out[17] = 32 | (opaque ? 0 : 8); // top left origin, alpha bits

    let o = 18;
    const put = (i: number): void => {
        const p = i * 4;
        out[o++] = rgba[p + 2];
        out[o++] = rgba[p + 1];
        out[o++] = rgba[p];
        if (bpp === 4) out[o++] = rgba[p + 3];
    };

    for (let i = 0; i < count;) {
        // a run of at least two equal pixels becomes a run packet, otherwise collect raw pixels until the next run;
        // packets end with the row (TGA 2.0 requires it, Pillow rejects packets across rows)
        const end = (Math.floor(i / width) + 1) * width;
        let run = 1;
        while (run < 128 && i + run < end && pixels[i + run] === pixels[i]) run++;
        if (run >= 2) {
            out[o++] = 128 | run - 1;
            put(i);
            i += run;
            continue;
        }

        let raw = 1;
        while (raw < 128 && i + raw < end && !(i + raw + 1 < end && pixels[i + raw] === pixels[i + raw + 1])) raw++;
        out[o++] = raw - 1;
        for (let k = 0; k < raw; k++) put(i + k);
        i += raw;
    }

    // TGA 2.0 footer (without developer area), it makes the file recognizable
    let extensionOffset = 0;
    if (extension && (extension.author || extension.comment || extension.time || extension.software)) {
        extensionOffset = o;
        out.set(extensionArea(extension, bpp === 4), o);
        o += 495;
    }
    out[o] = extensionOffset & 255; out[o + 1] = extensionOffset >> 8 & 255; out[o + 2] = extensionOffset >> 16 & 255; out[o + 3] = extensionOffset >>> 24;
    o += 8;
    for (let i = 0; i < SIGNATURE.length; i++) out[o++] = SIGNATURE.charCodeAt(i);
    return out.slice(0, o);
}
