// UTF-8 helpers, so the library doesn't depend on TextEncoder/TextDecoder being available

export function encode(text: string): Uint8Array {
    const out: number[] = [];

    for (const char of text) {
        const c = char.codePointAt(0) as number;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
        else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
        else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    }

    return Uint8Array.from(out);
}

/**
 * Decodes UTF-8, replacing invalid sequences with U+FFFD and skipping a leading byte order mark
 */
export function decode(bytes: Uint8Array): string {
    let out = '';
    let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;

    while (i < bytes.length) {
        const b = bytes[i++];
        let c: number, extra: number;

        if (b < 0x80) {
            c = b;
            extra = 0;
        } else if (b >= 0xc2 && b < 0xe0) {
            c = b & 31;
            extra = 1;
        } else if (b >= 0xe0 && b < 0xf0) {
            c = b & 15;
            extra = 2;
        } else if (b >= 0xf0 && b < 0xf5) {
            c = b & 7;
            extra = 3;
        } else {
            out += '�';
            continue;
        }

        let valid = true;
        for (let k = 0; k < extra; k++) {
            const next = bytes[i];
            if (next === undefined || (next & 0xc0) !== 0x80) {
                valid = false;
                break;
            }
            c = c << 6 | next & 63;
            i++;
        }

        out += valid && c <= 0x10ffff ? String.fromCodePoint(c) : '�';
    }

    return out;
}
