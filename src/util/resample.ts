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
    const horizontal = outWidth !== width ? coefficients(width, outWidth, filter) : null;

    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < outWidth; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            if (horizontal) {
                const { start, count, weights, size } = horizontal;
                for (let k = 0, s = row + start[x] * 4; k < count[x]; k++, s += 4) {
                    const wa = weights[x * size + k] * src[s + 3];
                    r += src[s] * wa;
                    g += src[s + 1] * wa;
                    b += src[s + 2] * wa;
                    a += wa;
                }
            } else {
                const s = row + x * 4;
                a = src[s + 3];
                r = src[s] * a;
                g = src[s + 1] * a;
                b = src[s + 2] * a;
            }

            const o = (y * outWidth + x) * 4;
            plane[o] = r / 255;
            plane[o + 1] = g / 255;
            plane[o + 2] = b / 255;
            plane[o + 3] = a;
        }
    }

    if (outHeight !== height) {
        const { start, count, weights, size } = coefficients(height, outHeight, filter);
        const next = new Float32Array(outWidth * outHeight * 4);
        const stride = outWidth * 4;

        for (let y = 0; y < outHeight; y++) {
            const o = y * stride;
            for (let k = 0; k < count[y]; k++) {
                const w = weights[y * size + k];
                const s = (start[y] + k) * stride;
                for (let x = 0; x < stride; x++) next[o + x] += plane[s + x] * w;
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
