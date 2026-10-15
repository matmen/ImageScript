import { concat } from '../util/mem.ts';
import { encode as utf8 } from '../util/utf8.ts';

/**
 * Reads the orientation tag (0x0112) from the first IFD of Exif data
 * @param data a TIFF header and IFDs, optionally preceded by "Exif\0\0" (as in JPEG's APP1)
 * @return the orientation (1-8), 1 if it is missing or invalid
 */
export function orientation(data: Uint8Array): number {
    if (data.length >= 6 && data[0] === 0x45 && data[1] === 0x78 && data[2] === 0x69 && data[3] === 0x66 && data[4] === 0 && data[5] === 0)
        data = data.subarray(6);
    if (data.length < 8) return 1;

    const tiff = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const little = tiff.getUint16(0) === 0x4949;
    if (!little && tiff.getUint16(0) !== 0x4d4d) return 1;

    const ifd = tiff.getUint32(4, little);
    if (ifd + 2 > tiff.byteLength) return 1;

    for (let i = 0, count = tiff.getUint16(ifd, little); i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > tiff.byteLength) break;
        if (tiff.getUint16(entry, little) !== 0x0112) continue;

        // a SHORT, stored in the first two bytes of the value field
        const value = tiff.getUint16(entry + 8, little);
        return value >= 1 && value <= 8 ? value : 1;
    }

    return 1;
}

/**
 * Reads tiff:Orientation from an XMP packet, as attribute or element
 * @return the orientation (1-8), 1 if it is missing or invalid
 */
export function xmpOrientation(xmp: string): number {
    const match = /tiff:Orientation\s*(?:=\s*["']|>\s*)([1-8])\b/.exec(xmp);
    return match ? +match[1] : 1;
}

export interface ExifFields {
    description?: string;
    software?: string;
    /** written as UTC (DateTime and DateTimeOriginal, with their offsets) */
    dateTime?: Date;
    artist?: string;
    copyright?: string;
}

const ASCII = 2, LONG = 4, UNDEFINED = 7;

interface Entry {
    tag: number;
    type: number;
    count: number;
    data: Uint8Array;
}

// ASCII values are NUL terminated; other text than ASCII is stored as UTF-8, which readers commonly accept
const ascii = (tag: number, text: string): Entry => {
    const data = concat([utf8(text), [0]]);
    return { tag, type: ASCII, count: data.length, data };
};

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Writes Exif data: a big endian TIFF header, IFD0 and (with a date) an Exif IFD
 * @return the TIFF data, without the "Exif\0\0" prefix that JPEG's APP1 adds
 */
export function encode(fields: ExifFields): Uint8Array {
    const ifd0: Entry[] = [];
    const exifIFD: Entry[] = [];
    if (fields.description) ifd0.push(ascii(0x010e, fields.description));
    if (fields.software) ifd0.push(ascii(0x0131, fields.software));
    if (fields.dateTime) {
        const d = fields.dateTime;
        const time = `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
        ifd0.push(ascii(0x0132, time));
        exifIFD.push({ tag: 0x9000, type: UNDEFINED, count: 4, data: Uint8Array.of(0x30, 0x32, 0x33, 0x32) }); // ExifVersion 0232
        exifIFD.push(ascii(0x9003, time)); // DateTimeOriginal
        exifIFD.push(ascii(0x9010, '+00:00')); // OffsetTime
        exifIFD.push(ascii(0x9011, '+00:00')); // OffsetTimeOriginal
    }
    if (fields.artist) ifd0.push(ascii(0x013b, fields.artist));
    if (fields.copyright) ifd0.push(ascii(0x8298, fields.copyright));
    if (exifIFD.length) ifd0.push({ tag: 0x8769, type: LONG, count: 1, data: new Uint8Array(4) }); // pointer, set below

    const size = (entries: Entry[]): number => 2 + entries.length * 12 + 4 + entries.reduce((n, e) => n + (e.data.length > 4 ? e.data.length + (e.data.length & 1) : 0), 0);
    const ifd0Offset = 8;
    const exifOffset = ifd0Offset + size(ifd0);
    const out = new Uint8Array(exifOffset + (exifIFD.length ? size(exifIFD) : 0));
    const view = new DataView(out.buffer);
    out.set([0x4d, 0x4d, 0x00, 0x2a]);
    view.setUint32(4, ifd0Offset);

    const pointer = ifd0.find(e => e.tag === 0x8769);
    if (pointer) new DataView(pointer.data.buffer).setUint32(0, exifOffset);

    const write = (entries: Entry[], offset: number): void => {
        view.setUint16(offset, entries.length);
        // values that don't fit into an entry follow the IFD (and its next IFD offset, 0)
        let data = offset + 2 + entries.length * 12 + 4;
        entries.forEach((e, i) => {
            const at = offset + 2 + i * 12;
            view.setUint16(at, e.tag);
            view.setUint16(at + 2, e.type);
            view.setUint32(at + 4, e.count);
            if (e.data.length <= 4) out.set(e.data, at + 8);
            else {
                view.setUint32(at + 8, data);
                out.set(e.data, data);
                data += e.data.length + (e.data.length & 1);
            }
        });
    };
    write(ifd0, ifd0Offset);
    if (exifIFD.length) write(exifIFD, exifOffset);
    return out;
}
