// 8-bit premultiplied alpha on the pixels as 32-bit words (little endian: alpha is the top byte), for the fast paths

export let littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * @internal for tests: run the code paths for the other byte order (on little endian machines, where the big endian
 * ones never run otherwise; those don't depend on the byte order, so they work on either)
 * @ignore
 */
export function useLittleEndian(value: boolean): void {
    littleEndian = value;
}

const words = (bitmap: Uint8ClampedArray): Int32Array => new Int32Array(bitmap.buffer, bitmap.byteOffset, bitmap.length >> 2);

/** Whether every pixel of the RGBA bitmap is opaque */
export function isOpaque(bitmap: Uint8ClampedArray): boolean {
    const pixels = words(bitmap);
    let all = -1;
    for (let i = 0; i < pixels.length; i++) all &= pixels[i];
    return all >>> 24 === 255;
}

/** Premultiplies RGBA into `out` (which may be `bitmap`): channel * alpha / 255, rounded */
export function premultiply8(bitmap: Uint8ClampedArray, out: Uint8ClampedArray): void {
    const src = words(bitmap), dst = words(out);
    for (let i = 0; i < src.length; i++) {
        const p = src[i], a = p >>> 24;
        if (a === 255) {
            dst[i] = p;
            continue;
        }
        // red and blue as 16-bit lanes: x * a + 128, plus its high byte, shifted by 8
        let rb = Math.imul(p & 0xff00ff, a) + 0x800080;
        rb = (rb + (rb >>> 8 & 0xff00ff)) >>> 8 & 0xff00ff;
        const g = (p >> 8 & 255) * a + 128;
        dst[i] = rb | (g + (g >> 8) & 0xff00) | a << 24;
    }
}

// channel * 255 / alpha at alpha << 8 | channel, rounded (half to even) and clamped like the clamped arrays
let unpremultiplied: Uint8ClampedArray | undefined;

/** Unpremultiplies RGBA in place */
export function unpremultiply8(bitmap: Uint8ClampedArray): void {
    if (!unpremultiplied) {
        unpremultiplied = new Uint8ClampedArray(65536);
        for (let i = 256; i < 65536; i++) unpremultiplied[i] = (i & 255) * (255 / (i >> 8));
    }
    const table = unpremultiplied, pixels = words(bitmap);
    for (let i = 0; i < pixels.length; i++) {
        const p = pixels[i], a = p >>> 24;
        if (a === 255) continue;
        // what the table gives at alpha 0, without looking it up
        if (a === 0) {
            pixels[i] = 0;
            continue;
        }
        const o = a << 8;
        pixels[i] = table[o | p & 255] | table[o | p >> 8 & 255] << 8 | table[o | p >> 16 & 255] << 16 | a << 24;
    }
}
