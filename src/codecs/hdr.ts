import { MAX_PIXELS, checkPixels } from '../util/limits.ts';

// Radiance HDR (RGBE): linear light, a shared exponent per pixel, run length encoded scan lines (as described in
// Radiance's file format documentation, https://www.radiance-online.org/learning/documentation/manual-pages, and Greg
// Ward's "Real Pixels" in Graphics Gems II). The values are tone mapped (or clamped to 0..1) and stored as sRGB

/** How linear light brighter than white becomes 8 bit sRGB: tone mapped by Reinhard's operator, or clamped */
export type ToneMapping = 'reinhard' | 'clamp';

// a linear light value as an 8 bit sRGB one (clamped to 0..1)
function linearToSRGB(v: number): number {
    if (!(v > 0)) return 0;
    if (v >= 1) return 255;
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
}

/**
 * Linear light RGB (3 values per pixel) as sRGB RGBA. Reinhard's extended operator ("Photographic Tone Reproduction
 * for Digital Images", 2002, equation 4) without its automatic exposure, which makes dark scenes like nights grey:
 * the luminance L becomes L (1 + L / Lw²) / (1 + L), the brightest pixel's (at least 1) Lw white, and the channels are
 * scaled by that, keeping their hue; images no brighter than white stay as they are
 */
export function toSRGB(rgb: Float32Array, toneMapping: ToneMapping): Uint8Array {
    const count = rgb.length / 3;
    const luminance = (i: number): number => 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
    let white = 1;
    if (toneMapping === 'reinhard') for (let i = 0; i < rgb.length; i += 3) white = Math.max(white, luminance(i));
    const white2 = white * white;

    const pixels = new Uint8Array(count * 4);
    for (let i = 0, p = 0; i < rgb.length; i += 3, p += 4) {
        let scale = 1;
        if (white > 1) {
            const l = Math.max(0, luminance(i));
            scale = (1 + l / white2) / (1 + l);
        }
        pixels[p] = linearToSRGB(rgb[i] * scale);
        pixels[p + 1] = linearToSRGB(rgb[i + 1] * scale);
        pixels[p + 2] = linearToSRGB(rgb[i + 2] * scale);
        pixels[p + 3] = 255;
    }
    return pixels;
}

const ascii = (d: Uint8Array, start: number, end: number): string => String.fromCharCode(...d.subarray(start, end));

/** Whether the data starts like a Radiance HDR */
export function isHDR(d: Uint8Array): boolean {
    const start = ascii(d, 0, 10);
    return start === '#?RADIANCE' || start.startsWith('#?RGBE');
}

// XYZ to Radiance's RGB: its primaries (0.640, 0.330), (0.290, 0.600), (0.150, 0.060) and an equal energy white
// (RGB 1, 1, 1 is XYZ 1, 1, 1), like its xyz2rgbmat
const XYZ_TO_RGB = ((): number[] => {
    const inverse = ([a, b, c, d, e, f, g, h, i]: number[]): number[] => {
        const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
        return [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d].map(v => v / det);
    };
    // the primaries' XYZ (as columns), scaled so they add up to the white
    const [r, g, b] = [[0.640, 0.330], [0.290, 0.600], [0.150, 0.060]].map(([x, y]) => [x / y, 1, (1 - x - y) / y]);
    const primaries = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
    const inv = inverse(primaries);
    const scale = [0, 1, 2].map(row => inv[row * 3] + inv[row * 3 + 1] + inv[row * 3 + 2]);
    return inverse(primaries.map((v, i) => v * scale[i % 3]));
})();

/** Decodes a Radiance HDR into RGBA */
export function decode(d: Uint8Array, maxPixels = MAX_PIXELS, toneMapping: ToneMapping = 'reinhard'): { width: number, height: number, pixels: Uint8Array } {
    if (!isHDR(d)) throw new Error('HDR: invalid header');

    // header lines up to an empty one, then the resolution
    let o = 0, xyz = false;
    for (;;) {
        let end = o;
        while (end < d.length && d[end] !== 0x0a) end++;
        if (end >= d.length) throw new Error('HDR: truncated header');
        const line = ascii(d, o, end);
        o = end + 1;
        if (!line) break;
        if (line.startsWith('FORMAT=')) {
            const format = line.slice(7).trim();
            if (format !== '32-bit_rle_rgbe' && format !== '32-bit_rle_xyze') throw new Error(`HDR: unsupported format ${format}`);
            xyz = format === '32-bit_rle_xyze';
        }
    }
    let end = o;
    while (end < d.length && d[end] !== 0x0a) end++;
    const resolution = /^([-+])([XY]) (\d+) ([-+])([XY]) (\d+)$/.exec(ascii(d, o, Math.min(end, o + 64)).trim());
    if (!resolution || resolution[2] === resolution[5]) throw new Error('HDR: invalid resolution');
    o = end + 1;

    // scan lines along the second axis; the standard -Y height +X width is from the top, left to right
    const [, sign1, axis1, n1, sign2, , n2] = resolution;
    const lines = +n1, length = +n2;
    const columns = axis1 === 'X';
    const width = columns ? lines : length, height = columns ? length : lines;
    if (!width || !height) throw new Error(`HDR: invalid dimensions ${width}x${height}`);
    checkPixels(width, height, maxPixels);

    const rgb = new Float32Array(width * height * 3);
    const line = new Uint8Array(length * 4);
    for (let s = 0; s < lines; s++) {
        o = readLine(d, o, line, length);
        for (let i = 0; i < length; i++) {
            // Y grows upwards in Radiance's coordinates
            const x = columns ? (sign1 === '+' ? s : width - 1 - s) : sign2 === '+' ? i : width - 1 - i;
            const y = columns ? (sign2 === '-' ? i : height - 1 - i) : sign1 === '-' ? s : height - 1 - s;
            const p = (y * width + x) * 3, e = line[i * 4 + 3];
            if (e) {
                const f = 2 ** (e - 136);
                let r = line[i * 4] * f, g = line[i * 4 + 1] * f, b = line[i * 4 + 2] * f;
                if (xyz) {
                    const m = XYZ_TO_RGB;
                    [r, g, b] = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
                }
                rgb[p] = r; rgb[p + 1] = g; rgb[p + 2] = b;
            }
        }
    }
    return { width, height, pixels: toSRGB(rgb, toneMapping) };
}

// reads a scan line of RGBE pixels: run length encoded by channel (starting with 2, 2 and the length), or the old
// encoding: pixels, where 1, 1, 1, n repeats the previous one n times (shifted by 8 bits more for each repetition
// that follows)
function readLine(d: Uint8Array, o: number, line: Uint8Array, length: number): number {
    if (o + 4 > d.length) throw new Error('HDR: truncated image data');
    if (length >= 8 && length < 0x8000 && d[o] === 2 && d[o + 1] === 2 && !(d[o + 2] & 0x80)) {
        if ((d[o + 2] << 8 | d[o + 3]) !== length) throw new Error('HDR: scan line of the wrong length');
        o += 4;
        for (let c = 0; c < 4; c++) {
            for (let i = 0; i < length;) {
                if (o >= d.length) throw new Error('HDR: truncated image data');
                let n = d[o++];
                if (n > 128) {
                    n -= 128;
                    if (i + n > length || o >= d.length) throw new Error('HDR: invalid run');
                    const v = d[o++];
                    for (; n; n--) line[i++ * 4 + c] = v;
                } else {
                    if (!n || i + n > length || o + n > d.length) throw new Error('HDR: invalid run');
                    for (; n; n--) line[i++ * 4 + c] = d[o++];
                }
            }
        }
        return o;
    }

    for (let i = 0, shift = 0; i < length;) {
        if (o + 4 > d.length) throw new Error('HDR: truncated image data');
        if (d[o] === 1 && d[o + 1] === 1 && d[o + 2] === 1) {
            if (!i) throw new Error('HDR: repetition without a pixel');
            const n = d[o + 3] * 2 ** shift;
            if (i + n > length) throw new Error('HDR: invalid run');
            for (let k = 0; k < n; k++, i++) line.copyWithin(i * 4, i * 4 - 4, i * 4);
            shift += 8;
        } else {
            line.set(d.subarray(o, o + 4), i * 4);
            i++;
            shift = 0;
        }
        o += 4;
    }
    return o;
}
