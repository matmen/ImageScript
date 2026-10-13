const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
    TABLE[n] = c;
}

/**
 * CRC-32 (ISO 3309), as used by PNG and zlib
 */
export function crc32(buffer: Uint8Array): number {
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) crc = TABLE[(crc ^ buffer[i]) & 0xff] ^ crc >>> 8;
    return (crc ^ -1) >>> 0;
}
