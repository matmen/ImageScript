/*!
 * Slice-by-16 CRC-32, derived from "Fast CRC32 in JavaScript" (https://gist.github.com/101arrowz/e58695f7ccfdf74f60ba22018093edea)
 * Copyright (c) 2021 Arjun Barrett, MIT License (see THIRD_PARTY_NOTICES.md)
 */

// slice-by-16 tables: TABLE[k * 256 + n] is the CRC of byte n followed by k zero bytes
const TABLE = new Int32Array(16 * 256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
    TABLE[n] = c;
}
for (let n = 0; n < 256; n++) {
    let c = TABLE[n];
    for (let k = 256; k < TABLE.length; k += 256) c = TABLE[k + n] = TABLE[c & 0xff] ^ c >>> 8;
}

/**
 * CRC-32 (ISO 3309), as used by PNG and zlib. Processes 16 bytes per step (slice-by-16, see #12), byte by byte so
 * it doesn't depend on alignment or endianness
 */
export function crc32(buffer: Uint8Array): number {
    let crc = -1, i = 0;
    for (const end = buffer.length - 16; i <= end; i += 16) {
        crc = TABLE[3840 + ((buffer[i] ^ crc) & 0xff)] ^ TABLE[3584 + ((buffer[i + 1] ^ crc >> 8) & 0xff)]
            ^ TABLE[3328 + ((buffer[i + 2] ^ crc >> 16) & 0xff)] ^ TABLE[3072 + (buffer[i + 3] ^ crc >>> 24)]
            ^ TABLE[2816 + buffer[i + 4]] ^ TABLE[2560 + buffer[i + 5]] ^ TABLE[2304 + buffer[i + 6]] ^ TABLE[2048 + buffer[i + 7]]
            ^ TABLE[1792 + buffer[i + 8]] ^ TABLE[1536 + buffer[i + 9]] ^ TABLE[1280 + buffer[i + 10]] ^ TABLE[1024 + buffer[i + 11]]
            ^ TABLE[768 + buffer[i + 12]] ^ TABLE[512 + buffer[i + 13]] ^ TABLE[256 + buffer[i + 14]] ^ TABLE[buffer[i + 15]];
    }
    for (; i < buffer.length; i++) crc = TABLE[(crc ^ buffer[i]) & 0xff] ^ crc >>> 8;
    return (crc ^ -1) >>> 0;
}
