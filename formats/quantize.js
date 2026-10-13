'use strict';

// perceptual channel weights for squared color distances
const WR = 3, WG = 4, WB = 2;

/**
 * Reduces RGBA pixel data to an indexed palette
 * Pixels with alpha < 128 are mapped to a dedicated transparent index
 * @param {Uint8Array} pixels RGBA pixel data
 * @param {number} width Image width in pixels (needed for dithering)
 * @param {{maxColors?: number, quality?: number}} [options] quality (1-100) scales the palette size exponentially (1 = 8 colors, 50 = 55, 90 and above = 256)
 * @return {{palette: Uint8Array, indices: Uint8Array, transparentIndex: number}} palette is packed RGB, transparentIndex is -1 if unused
 */
function quantize(pixels, width, { maxColors = 256, quality = 95 } = {}) {
    const length = pixels.length >> 2;
    let hasTransparency = false;
    for (let i = 3; i < pixels.length; i += 4)
        if (pixels[i] < 128) {
            hasTransparency = true;
            break;
        }

    quality = Math.min(100, Math.max(1, quality));
    const limit = Math.min(maxColors, Math.round(8 * 32 ** (Math.min(quality, 90) / 90)));
    const colors = hasTransparency ? limit - 1 : limit;
    const exact = exactPalette(pixels, colors);

    let palette, indices;
    if (exact) ({ palette, indices } = exact);
    else {
        palette = medianCut(pixels, colors, Math.ceil(quality / 25));
        indices = ditherMap(pixels, width, palette, palette.length / 3);
    }

    let transparentIndex = -1;
    if (hasTransparency) {
        transparentIndex = palette.length / 3;
        const padded = new Uint8Array(palette.length + 3);
        padded.set(palette);
        palette = padded;

        for (let i = 0; i < length; i++)
            if (pixels[i * 4 + 3] < 128) indices[i] = transparentIndex;
    }

    return { palette, indices, transparentIndex };
}

// returns an exact palette if the opaque pixels use at most `limit` distinct colors
function exactPalette(pixels, limit) {
    const lookup = new Map();
    const indices = new Uint8Array(pixels.length >> 2);
    const palette = [];

    for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
        if (pixels[i + 3] < 128) continue;

        const key = pixels[i] << 16 | pixels[i + 1] << 8 | pixels[i + 2];
        let index = lookup.get(key);

        if (index === undefined) {
            if (lookup.size >= limit) return null;
            index = lookup.size;
            lookup.set(key, index);
            palette.push(pixels[i], pixels[i + 1], pixels[i + 2]);
        }

        indices[p] = index;
    }

    // a palette needs at least one entry
    if (!palette.length) palette.push(0, 0, 0);
    return { palette: Uint8Array.from(palette), indices };
}

// weighted median cut on a 15-bit histogram, followed by k-means refinement
function medianCut(pixels, colors, iterations) {
    const count = new Float64Array(32768);
    const sumR = new Float64Array(32768);
    const sumG = new Float64Array(32768);
    const sumB = new Float64Array(32768);

    for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 128) continue;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        const bin = (r >> 3) << 10 | (g >> 3) << 5 | b >> 3;
        count[bin]++;
        sumR[bin] += r;
        sumG[bin] += g;
        sumB[bin] += b;
    }

    // collapse non-empty bins into weighted points (mean color + count)
    const bins = [];
    for (let i = 0; i < 32768; i++)
        if (count[i]) bins.push({ c: [sumR[i] / count[i], sumG[i] / count[i], sumB[i] / count[i]], w: count[i] });

    const boxes = [makeBox(bins)];
    while (boxes.length < colors) {
        let target = -1;
        for (let i = 0; i < boxes.length; i++)
            if (boxes[i].points.length > 1 && (target === -1 || boxes[i].error > boxes[target].error)) target = i;
        if (target === -1) break;

        const box = boxes[target];
        const axis = box.axis;
        box.points.sort((a, b) => a.c[axis] - b.c[axis]);

        // split at the weighted median, keeping at least one point on each side
        const half = box.weight / 2;
        let split = 1;
        for (let acc = 0; split < box.points.length - 1; split++) {
            acc += box.points[split - 1].w;
            if (acc >= half) break;
        }

        boxes.splice(target, 1, makeBox(box.points.slice(0, split)), makeBox(box.points.slice(split)));
    }

    const palette = new Float64Array(boxes.length * 3);
    boxes.forEach((box, i) => palette.set(box.mean, i * 3));

    // k-means: reassign every point to its nearest palette color and move colors to their cluster means
    const entries = boxes.length;
    for (let iteration = 0; iteration < iterations; iteration++) {
        const acc = new Float64Array(entries * 4);

        for (const point of bins) {
            const index = nearest(palette, entries, point.c[0], point.c[1], point.c[2]);
            acc[index * 4] += point.c[0] * point.w;
            acc[index * 4 + 1] += point.c[1] * point.w;
            acc[index * 4 + 2] += point.c[2] * point.w;
            acc[index * 4 + 3] += point.w;
        }

        for (let i = 0; i < entries; i++) {
            const w = acc[i * 4 + 3];
            if (!w) continue;
            palette[i * 3] = acc[i * 4] / w;
            palette[i * 3 + 1] = acc[i * 4 + 1] / w;
            palette[i * 3 + 2] = acc[i * 4 + 2] / w;
        }
    }

    return Uint8Array.from(palette, Math.round);
}

function makeBox(points) {
    let weight = 0;
    const sum = [0, 0, 0];
    const sq = [0, 0, 0];

    for (const { c, w } of points) {
        weight += w;
        for (let k = 0; k < 3; k++) {
            sum[k] += c[k] * w;
            sq[k] += c[k] * c[k] * w;
        }
    }

    const mean = sum.map(v => v / weight);
    // per-axis squared error, weighted the same way as color distances
    const error = sq.map((v, k) => (v - sum[k] * mean[k]) * [WR, WG, WB][k]);
    const axis = error.indexOf(Math.max(...error));

    return { points, weight, mean, axis, error: error[0] + error[1] + error[2] };
}

function nearest(palette, entries, r, g, b) {
    let best = 0, bestDistance = Infinity;

    for (let i = 0; i < entries; i++) {
        const dr = r - palette[i * 3], dg = g - palette[i * 3 + 1], db = b - palette[i * 3 + 2];
        const distance = WR * dr * dr + WG * dg * dg + WB * db * db;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
        }
    }

    return best;
}

// caches nearest palette lookups on an 18-bit color key
function createLookup(palette, entries) {
    const cache = new Int16Array(1 << 18).fill(-1);

    return (r, g, b) => {
        const key = (r >> 2) << 12 | (g >> 2) << 6 | b >> 2;
        let index = cache[key];
        if (index === -1) index = cache[key] = nearest(palette, entries, r, g, b);
        return index;
    };
}

// serpentine floyd-steinberg error diffusion
function ditherMap(pixels, width, palette, entries) {
    const height = (pixels.length >> 2) / width;
    const lookup = createLookup(palette, entries);
    const indices = new Uint8Array(pixels.length >> 2);

    let current = new Float32Array((width + 2) * 3);
    let next = new Float32Array((width + 2) * 3);
    const strength = 0.85;

    for (let y = 0; y < height; y++) {
        const reverse = y & 1;

        for (let step = 0; step < width; step++) {
            const x = reverse ? width - 1 - step : step;
            const p = y * width + x;
            const e = (x + 1) * 3;

            if (pixels[p * 4 + 3] < 128) continue;

            const r = clamp(pixels[p * 4] + current[e] * strength);
            const g = clamp(pixels[p * 4 + 1] + current[e + 1] * strength);
            const b = clamp(pixels[p * 4 + 2] + current[e + 2] * strength);

            const index = indices[p] = lookup(r, g, b);
            const er = r - palette[index * 3];
            const eg = g - palette[index * 3 + 1];
            const eb = b - palette[index * 3 + 2];

            const forward = reverse ? -3 : 3;
            for (let k = 0; k < 3; k++) {
                const error = k === 0 ? er : k === 1 ? eg : eb;
                current[e + forward + k] += error * 7 / 16;
                next[e - forward + k] += error * 3 / 16;
                next[e + k] += error * 5 / 16;
                next[e + forward + k] += error / 16;
            }
        }

        [current, next] = [next, current];
        next.fill(0);
    }

    return indices;
}

function clamp(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

module.exports = { quantize };
