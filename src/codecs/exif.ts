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
