// Frame optimization for the animation encoders: the frames are composited, and each is stored as the rectangle that
// changed since the frame before, with the pixels that didn't change transparent (they compress better, and GIFs keep
// their palette for the others). Consecutive identical frames become one. The animation looks the same as before

export interface InputFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    /** milliseconds */
    duration: number;
    /** 0 none, 1 background (transparent), 2 previous */
    dispose: number;
    /** RGBA, alpha blended onto the canvas */
    pixels: Uint8Array;
}

export interface OptimizedFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    /** milliseconds */
    duration: number;
    /** whether the frame's area is cleared (to transparent) after it was shown */
    dispose: boolean;
    /** whether the frame is alpha blended onto the canvas (otherwise it replaces its area) */
    blend: boolean;
    /** RGBA */
    pixels: Uint8Array;
}

export interface OptimizeOptions {
    /**
     * Whether frames can replace their area instead of being blended onto it (APNG, WebP). GIFs can't: pixels that get
     * more transparent are cleared by the disposal of the frame before instead
     */
    replace: boolean;
    /** Whether frame offsets have to be even (WebP stores them halved) */
    even: boolean;
}

/**
 * Composites the frames and stores each as the area that changed
 * @param width The canvas width
 * @param height The canvas height
 */
export function optimize(frames: InputFrame[], width: number, height: number, { replace, even }: OptimizeOptions): OptimizedFrame[] {
    const size = width * height * 4;
    // the input animation's canvas, and what the optimized animation shows after its last frame (and its disposal)
    const canvas = new Uint8Array(size), canvas32 = new Uint32Array(canvas.buffer);
    const shown = new Uint8Array(size), shown32 = new Uint32Array(shown.buffer);
    const output: OptimizedFrame[] = [];

    const state: State = { canvas, canvas32, shown, shown32, width, replace };
    const same = (p: number): boolean => canvas32[p] === shown32[p] || (canvas[p * 4 + 3] === 0 && shown[p * 4 + 3] === 0);

    for (const f of frames) {
        const saved = f.dispose === 2 ? canvas.slice() : null;
        draw(canvas, width, height, f);

        // the changed area, and the area of changed pixels that blending can't produce
        let changed = bounds(state, false, { x: 0, y: 0, width, height });
        if (!changed) {
            if (output.length) output[output.length - 1].duration += f.duration;
            else output.push({ x: 0, y: 0, width: 1, height: 1, duration: f.duration, dispose: false, blend: true, pixels: new Uint8Array(4) });
        } else {
            let blend = true;
            const unblendable = bounds(state, true, changed);
            if (unblendable && replace) blend = false;
            else if (unblendable) {
                // GIF: the frame before clears an area covering these pixels (it grows by transparent, unchanged
                // pixels if needed), then the frame is blended onto the cleared area
                const last = output[output.length - 1];
                grow(last, union(last, unblendable));
                last.dispose = true;
                clear(shown, width, last);
                changed = bounds(state, false, { x: 0, y: 0, width, height }) as Rect;
            }

            if (even) changed = { x: changed.x & ~1, y: changed.y & ~1, width: changed.width + (changed.x & 1), height: changed.height + (changed.y & 1) };

            // blended frames: the changed pixels, the others transparent ("sparse"). The area as it is ("dense")
            // compresses better when the unchanged pixels are scattered (e.g. in videos): choose the one with fewer
            // changes from pixel to pixel, which estimates the compressed size well and costs a lot less than
            // compressing both. GIFs blend the dense area too (its unchanged pixels are the same or transparent in
            // both), the others replace the area with it
            const { x, y, width: w, height: h } = changed;
            const pixels = new Uint8Array(w * h * 4), pixels32 = new Uint32Array(pixels.buffer);
            let sparseChanges = 0, denseChanges = 0, lastSparse = -1, lastDense = -1;
            for (let row = 0, k = 0; row < h; row++) {
                const start = (y + row) * width + x;
                for (let p = start; p < start + w; p++, k++) {
                    const value = canvas32[p];
                    const sparse = blend && same(p) ? 0 : value;
                    pixels32[k] = sparse;
                    if (sparse !== lastSparse) sparseChanges++;
                    if (value !== lastDense) denseChanges++;
                    lastSparse = sparse;
                    lastDense = value;
                }
                shown.set(canvas.subarray(start * 4, (start + w) * 4), start * 4);
            }
            if (blend && denseChanges < sparseChanges) {
                for (let row = 0; row < h; row++) pixels.set(canvas.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
                if (replace) blend = false;
            }
            output.push({ x, y, width: w, height: h, duration: f.duration, dispose: false, blend, pixels });
        }

        if (f.dispose === 1) clear(canvas, width, clip(f, width, height));
        else if (saved) canvas.set(saved);
    }

    return output;
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

function clip(r: Rect, width: number, height: number): Rect {
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    return { x, y, width: Math.max(0, Math.min(width, r.x + r.width) - x), height: Math.max(0, Math.min(height, r.y + r.height) - y) };
}

function union(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

interface State {
    canvas: Uint8Array;
    canvas32: Uint32Array;
    shown: Uint8Array;
    shown32: Uint32Array;
    width: number;
    replace: boolean;
}

/**
 * The bounding box of the changed pixels within an area. Searches from the edges inwards, so it stops early when much
 * changed
 * @param unblendable only the changed pixels that blending onto what's shown can't produce: blending gives exactly
 *     opaque pixels, for GIFs (which only know opaque and transparent) also anything on a transparent pixel
 */
function bounds({ canvas, canvas32, shown, shown32, width, replace }: State, unblendable: boolean, area: Rect): Rect | null {
    const x0 = area.x, x1 = area.x + area.width, y0 = area.y, y1 = area.y + area.height;
    const test = (p: number): boolean => {
        if (canvas32[p] === shown32[p]) return false;
        const ca = canvas[p * 4 + 3], sa = shown[p * 4 + 3];
        if (ca === 0 && sa === 0) return false;
        return !unblendable || (ca !== 255 && (replace || sa !== 0));
    };
    const rowHas = (y: number, from: number, to: number): number => {
        for (let x = from, p = y * width + from; x < to; x++, p++) if (test(p)) return x;
        return -1;
    };

    let top = y0, first = -1;
    for (; top < y1; top++) if ((first = rowHas(top, x0, x1)) >= 0) break;
    if (top === y1) return null;
    let bottom = y1 - 1;
    while (bottom > top && rowHas(bottom, x0, x1) < 0) bottom--;

    // the columns: only the parts of the rows outside the bounds found so far
    let left = first, right = first;
    for (let y = top; y <= bottom; y++) {
        if (left > x0) {
            const x = rowHas(y, x0, left);
            if (x >= 0) left = x;
        }
        for (let x = x1 - 1, p = y * width + x; x > right; x--, p--)
            if (test(p)) {
                right = x;
                break;
            }
    }
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

// alpha blends a frame onto the canvas, like APNG's "over" (and GIF's transparency)
function draw(canvas: Uint8Array, width: number, height: number, f: InputFrame): void {
    const { x: x0, y: y0, width: w, height: h } = clip(f, width, height);
    const pixels = f.pixels.byteOffset % 4 ? f.pixels.slice() : f.pixels;
    const src = new Uint32Array(pixels.buffer, pixels.byteOffset, f.width * f.height);
    const dst = new Uint32Array(canvas.buffer, canvas.byteOffset, width * height);
    for (let y = y0; y < y0 + h; y++)
        for (let x = x0, s = (y - f.y) * f.width + x - f.x, d = y * width + x; x < x0 + w; x++, s++, d++) {
            const sa = pixels[s * 4 + 3];
            if (sa === 0) continue;
            const da = canvas[d * 4 + 3];
            if (sa === 255 || da === 0) dst[d] = src[s];
            else {
                const u = sa * 255, v = (255 - sa) * da, al = u + v;
                for (let c = 0; c < 3; c++) canvas[d * 4 + c] = (pixels[s * 4 + c] * u + canvas[d * 4 + c] * v) / al | 0;
                canvas[d * 4 + 3] = al / 255 | 0;
            }
        }
}

function clear(canvas: Uint8Array, width: number, r: Rect): void {
    for (let y = r.y; y < r.y + r.height; y++) canvas.fill(0, (y * width + r.x) * 4, (y * width + r.x + r.width) * 4);
}

// grows a frame to a larger area, the new pixels are transparent
function grow(frame: OptimizedFrame, area: Rect): void {
    if (area.x === frame.x && area.y === frame.y && area.width === frame.width && area.height === frame.height) return;
    const pixels = new Uint8Array(area.width * area.height * 4);
    for (let row = 0; row < frame.height; row++)
        pixels.set(frame.pixels.subarray(row * frame.width * 4, (row + 1) * frame.width * 4), ((frame.y - area.y + row) * area.width + frame.x - area.x) * 4);
    Object.assign(frame, area, { pixels });
}
