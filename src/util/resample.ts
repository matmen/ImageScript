// separable convolution resampling (the approach of Pillow's resample.c): the filter is stretched by the
// downscaling factor, so shrinking averages every source pixel instead of skipping most of them

export interface Filter {
    /** radius of the filter at scale 1 */
    support: number;
    weight: (x: number) => number;
}

export const BOX: Filter = { support: 0.5, weight: x => x >= -0.5 && x < 0.5 ? 1 : 0 };

export const TRIANGLE: Filter = { support: 1, weight: x => Math.max(0, 1 - Math.abs(x)) };

// Keys' cubic convolution with a = -0.5 (Catmull-Rom)
export const CUBIC: Filter = {
    support: 2,
    weight: x => {
        const a = -0.5;
        x = Math.abs(x);
        if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
        if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
        return 0;
    }
};

interface Coefficients {
    /** first source index per output index */
    start: Int32Array;
    /** source pixel count per output index */
    count: Int32Array;
    /** normalized weights, `size` per output index */
    weights: Float64Array;
    size: number;
}

function coefficients(inSize: number, outSize: number, filter: Filter): Coefficients {
    const scale = inSize / outSize;
    const filterScale = Math.max(1, scale);
    const support = filter.support * filterScale;
    const size = Math.ceil(support) * 2 + 1;

    const start = new Int32Array(outSize);
    const count = new Int32Array(outSize);
    const weights = new Float64Array(outSize * size);

    for (let i = 0; i < outSize; i++) {
        const center = (i + 0.5) * scale;
        const min = Math.max(0, Math.floor(center - support + 0.5));
        const max = Math.min(inSize, Math.floor(center + support + 0.5));

        let total = 0;
        for (let x = min; x < max; x++) {
            const w = filter.weight((x - center + 0.5) / filterScale);
            weights[i * size + x - min] = w;
            total += w;
        }

        if (total !== 0) for (let k = 0; k < max - min; k++) weights[i * size + k] /= total;
        start[i] = min;
        count[i] = max - min;
    }

    return { start, count, weights, size };
}

/**
 * Resamples RGBA pixels with the given filter, in premultiplied alpha so transparent pixels don't bleed their color
 */
export function resample(src: Uint8ClampedArray, width: number, height: number, outWidth: number, outHeight: number, filter: Filter, out: Uint8ClampedArray): void {
    // premultiplied float rows, scaled horizontally (premultiplying on the fly)
    let plane = new Float32Array(outWidth * height * 4);

    if (outWidth !== width) {
        const { start, count, weights, size } = coefficients(width, outWidth, filter);
        for (let y = 0, o = 0; y < height; y++) {
            const row = y * width * 4;
            for (let x = 0; x < outWidth; x++, o += 4) {
                let r = 0, g = 0, b = 0, a = 0;
                for (let k = 0, s = row + start[x] * 4, w = x * size, n = count[x]; k < n; k++, s += 4) {
                    const wa = weights[w + k] * src[s + 3];
                    r += src[s] * wa;
                    g += src[s + 1] * wa;
                    b += src[s + 2] * wa;
                    a += wa;
                }

                plane[o] = r / 255;
                plane[o + 1] = g / 255;
                plane[o + 2] = b / 255;
                plane[o + 3] = a;
            }
        }
    } else {
        for (let s = 0; s < plane.length; s += 4) {
            const a = src[s + 3];
            plane[s] = src[s] * a / 255;
            plane[s + 1] = src[s + 1] * a / 255;
            plane[s + 2] = src[s + 2] * a / 255;
            plane[s + 3] = a;
        }
    }

    if (outHeight !== height) {
        const { start, count, weights, size } = coefficients(height, outHeight, filter);
        const next = new Float32Array(outWidth * outHeight * 4);
        const stride = outWidth * 4;

        // every sum is rounded to float32 after each row it adds, as accumulating in a Float32Array would. Up to 4 rows
        // (bilinear and bicubic, from half the size up) are added with the weights in variables, more in a loop
        for (let y = 0; y < outHeight; y++) {
            const o = y * stride, n = count[y], w = y * size;
            const s0 = start[y] * stride, s1 = s0 + stride, s2 = s1 + stride, s3 = s2 + stride;
            const w0 = weights[w], w1 = weights[w + 1], w2 = weights[w + 2], w3 = weights[w + 3];
            if (n === 1) for (let x = 0; x < stride; x++) next[o + x] = 0 + plane[s0 + x] * w0;
            else if (n === 2) for (let x = 0; x < stride; x++) next[o + x] = Math.fround(0 + plane[s0 + x] * w0) + plane[s1 + x] * w1;
            else if (n === 3) {
                for (let x = 0; x < stride; x++)
                    next[o + x] = Math.fround(Math.fround(0 + plane[s0 + x] * w0) + plane[s1 + x] * w1) + plane[s2 + x] * w2;
            } else if (n === 4) {
                for (let x = 0; x < stride; x++)
                    next[o + x] = Math.fround(Math.fround(Math.fround(0 + plane[s0 + x] * w0) + plane[s1 + x] * w1) + plane[s2 + x] * w2) + plane[s3 + x] * w3;
            } else {
                for (let x = 0; x < stride; x++) {
                    let sum = 0;
                    for (let k = 0, s = s0 + x; k < n; k++, s += stride) sum = Math.fround(sum + plane[s] * weights[w + k]);
                    next[o + x] = sum;
                }
            }
        }

        plane = next;
    }

    // unpremultiply, the clamped output rounds and clamps (cubic filters overshoot)
    for (let i = 0; i < plane.length; i += 4) {
        const a = plane[i + 3];
        if (a < 0.5) {
            out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
            continue;
        }

        const f = 255 / Math.min(255, a);
        out[i] = plane[i] * f;
        out[i + 1] = plane[i + 1] * f;
        out[i + 2] = plane[i + 2] * f;
        out[i + 3] = a;
    }
}
