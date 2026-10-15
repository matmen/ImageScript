// Frame optimization for the animation encoders: the frames are composited, and each is stored as the rectangle that
// changed since the frame before, with the pixels that didn't change transparent (they compress better, and GIFs keep
// their palette for the others). Consecutive identical frames become one. The animation looks the same as before

// a pixel's alpha bits, read as one 32-bit word (whatever the byte order): 0 transparent, ALPHA opaque
const ALPHA = new Int32Array(new Uint8Array([0, 0, 0, 255]).buffer)[0];

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
    /**
     * What the transparent pixels of sparse frames cost when they would be opaque otherwise. "frame" if each frame
     * stores an alpha channel (WebP) or transparent palette index (GIF) only if it needs one. If all frames share one
     * pixel format (APNG): a function that tells how much more an opaque animation costs per pixel with its frames
     * (the transparent pixels are the sparse frames' unchanged ones) than without the transparent pixels
     */
    alpha: 'frame' | ((frames: OptimizedFrame[]) => number);
    /**
     * The palette size if each frame has one (GIF: 256): a frame stays dense if its colors fit, but its sparse pixels
     * (the transparent ones are a color more) don't, so they'd lose colors
     */
    palette?: number;
    /**
     * Whether the first frame has to cover the canvas (GIF: decoders disagree on what's outside it, browsers show it
     * transparent, others the background color)
     */
    cover?: boolean;
}

// what transparent pixels make an opaque frame cost: an alpha channel, 4 channels instead of 3 (or a palette entry
// less in GIFs, which costs about as much)
const ALPHA_COST = 4 / 3;

/**
 * Composites the frames and stores each as the area that changed
 * @param width The canvas width
 * @param height The canvas height
 */
export function optimize(frames: InputFrame[], width: number, height: number, { replace, even, alpha, palette, cover }: OptimizeOptions): OptimizedFrame[] {
    const size = width * height * 4;
    // the input animation's canvas, and what the optimized animation shows after its last frame (and its disposal)
    const canvas = new Uint8Array(size), canvas32 = new Int32Array(canvas.buffer);
    const shown = new Uint8Array(size), shown32 = new Int32Array(shown.buffer);
    const output: OptimizedFrame[] = [];

    const state: State = { canvas32, shown32, width, replace };

    // for a shared pixel format: whether the animation is opaque when all frames are stored dense, and the changes
    // from pixel to pixel all dense and as chosen
    let opaque = true, denseTotal = 0, chosenTotal = 0;

    // stores what the canvas shows now as the next frame
    const add = (duration: number): void => {
        let changed = bounds(state, { x: 0, y: 0, width, height });
        if (!changed) {
            if (output.length) output[output.length - 1].duration += duration;
            else {
                output.push(empty(duration));
                opaque = false;
            }
            return;
        }
        if (even) changed = evenArea(changed);
        let area = sparse(state, changed);
        let blend = true;
        if (area.unblendable && replace) blend = false;
        else if (area.unblendable) {
            // GIF: the frame before clears an area covering these pixels (it grows by transparent, unchanged pixels
            // if needed), then the frame is blended onto the cleared area
            const last = output[output.length - 1];
            grow(last, union(last, area.unblendable));
            last.dispose = true;
            clear(shown, width, last);
            changed = bounds(state, { x: 0, y: 0, width, height });
            // the pixels only became transparent: clearing them is all the frame shows, it only takes its time
            if (!changed) return void output.push(empty(duration));
            if (even) changed = evenArea(changed);
            area = sparse(state, changed);
        }

        // blended frames: the changed pixels, the others transparent ("sparse"). The area as it is ("dense")
        // compresses better when the unchanged pixels are scattered (e.g. in videos): choose the one with fewer
        // changes from pixel to pixel, which estimates the compressed size well and costs a lot less than compressing
        // both. GIFs blend the dense area too (its unchanged pixels are the same or transparent in both), the others
        // replace the area with it
        const { x, y, width: w, height: h } = changed;
        const pixels = area.pixels;
        if (!output.length && (w !== width || h !== height)) opaque = false;
        if (!area.denseOpaque) opaque = false;
        const sparseCost = alpha === 'frame' && area.denseOpaque ? area.sparseChanges * ALPHA_COST : area.sparseChanges;
        const dense = !blend || area.denseChanges < sparseCost
            || (palette !== undefined && colors(new Int32Array(pixels.buffer), w, { x: 0, y: 0, width: w, height: h }, palette + 1) > palette
                && colors(canvas32, width, changed, palette + 1) <= palette);
        denseTotal += area.denseChanges;
        chosenTotal += dense ? area.denseChanges : area.sparseChanges;
        if (dense) {
            for (let row = 0; row < h; row++) pixels.set(canvas.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
            if (replace) blend = false;
        }
        for (let row = 0; row < h; row++) {
            const start = ((y + row) * width + x) * 4;
            shown.set(canvas.subarray(start, start + w * 4), start);
        }
        output.push({ x, y, width: w, height: h, duration, dispose: false, blend, pixels });
    };

    // the area of the canvas that is all transparent (frames are copied onto it): decoded animations clear each full
    // frame before the next
    let cleared: Rect | null = { x: 0, y: 0, width, height };
    for (const f of frames) {
        const saved = f.dispose === 2 ? canvas.slice() : null;
        const area = clip(f, width, height);
        if (cleared && contains(cleared, area)) copy(canvas, width, f, area);
        else draw(canvas, width, height, f);
        cleared = null;
        add(f.duration);
        if (f.dispose === 1) {
            clear(canvas, width, area);
            cleared = area;
        } else if (saved) canvas.set(saved);
    }

    // an opaque animation with sparse frames needs transparency in its pixel format, for every frame: when that costs
    // more than storing them dense, the unchanged pixels are filled in again
    if (typeof alpha === 'function' && opaque && output.some(f => f.blend) && denseTotal < chosenTotal * alpha(output)) {
        shown.fill(0);
        for (const f of output) {
            const pixels32 = new Int32Array(f.pixels.buffer, f.pixels.byteOffset, f.width * f.height);
            for (let row = 0, k = 0; row < f.height; row++, k += f.width) {
                const start = (f.y + row) * width + f.x;
                if (!f.blend) shown32.set(pixels32.subarray(k, k + f.width), start);
                else
                    for (let i = k, p = start, end = k + f.width; i < end; i++, p++) {
                        if ((pixels32[i] & ALPHA) === 0) pixels32[i] = shown32[p];
                        else shown32[p] = pixels32[i];
                    }
            }
            f.blend = false;
        }
    }

    if (cover && output.length) grow(output[0], { x: 0, y: 0, width, height });
    return output;
}

// how many colors an area of an image has, counted up to a limit
function colors(image32: Int32Array, width: number, { x, y, width: w, height: h }: Rect, limit: number): number {
    const seen = new Set<number>();
    for (let row = y; row < y + h; row++) {
        let previous: number | undefined;
        for (let p = row * width + x, end = p + w; p < end; p++) {
            const value = image32[p];
            if (value === previous) continue;
            previous = value;
            seen.add(value);
            if (seen.size >= limit) return seen.size;
        }
    }
    return seen.size;
}

// a frame that doesn't change anything
const empty = (duration: number): OptimizedFrame => ({ x: 0, y: 0, width: 1, height: 1, duration, dispose: false, blend: true, pixels: new Uint8Array(4) });

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

function contains(a: Rect, b: Rect): boolean {
    return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
}

function union(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

interface State {
    canvas32: Int32Array;
    shown32: Int32Array;
    width: number;
    replace: boolean;
}

// the area grown to even offsets (WebP stores them halved)
function evenArea({ x, y, width, height }: Rect): Rect {
    return { x: x & ~1, y: y & ~1, width: width + (x & 1), height: height + (y & 1) };
}

interface SparseArea {
    /** RGBA */
    pixels: Uint8Array;
    sparseChanges: number;
    denseChanges: number;
    unblendable: Rect | null;
    /** whether the area as it is has no transparent pixels */
    denseOpaque: boolean;
}

/**
 * The area's changed pixels, the others transparent, and how many times the color changes from pixel to pixel in that
 * and in the area as it is. Also finds the area of the changed pixels that blending onto what's shown can't produce:
 * blending gives exactly opaque pixels, for GIFs (which only know opaque and transparent) also anything on a
 * transparent pixel
 */
function sparse({ canvas32, shown32, width, replace }: State, { x, y, width: w, height: h }: Rect): SparseArea {
    const pixels = new Uint8Array(w * h * 4), pixels32 = new Int32Array(pixels.buffer);
    let sparseChanges = 0, denseChanges = 0, lastSparse = -1, lastDense = -1;
    let left = w, right = -1, top = h, bottom = -1, translucent = 0;
    for (let row = 0, k = 0; row < h; row++) {
        const start = (y + row) * width + x;
        for (let i = 0, p = start; i < w; i++, p++, k++) {
            const value = canvas32[p], before = shown32[p];
            // unchanged: the same, or transparent in both
            if (value === before || ((value | before) & ALPHA) === 0) {
                if (lastSparse !== 0) sparseChanges++;
                lastSparse = 0;
            } else {
                pixels32[k] = value;
                if (value !== lastSparse) sparseChanges++;
                lastSparse = value;
                if ((value & ALPHA) !== ALPHA && (replace || (before & ALPHA) !== 0)) {
                    if (i < left) left = i;
                    if (i > right) right = i;
                    if (row < top) top = row;
                    bottom = row;
                }
            }
            if (value !== lastDense) {
                denseChanges++;
                translucent |= ~value & ALPHA;
            }
            lastDense = value;
        }
    }
    const unblendable: Rect | null = right < 0 ? null : { x: x + left, y: y + top, width: right - left + 1, height: bottom - top + 1 };
    return { pixels, sparseChanges, denseChanges, unblendable, denseOpaque: translucent === 0 };
}

/**
 * The bounding box of the changed pixels within an area. Searches from the edges inwards, so it stops early when much
 * changed
 */
function bounds({ canvas32, shown32, width }: State, area: Rect): Rect | null {
    const x0 = area.x, x1 = area.x + area.width, y0 = area.y, y1 = area.y + area.height;
    const test = (p: number): boolean => {
        const c = canvas32[p], s = shown32[p];
        return c !== s && ((c | s) & ALPHA) !== 0;
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
    const src = new Int32Array(pixels.buffer, pixels.byteOffset, f.width * f.height);
    const dst = new Int32Array(canvas.buffer, canvas.byteOffset, width * height);
    for (let y = y0; y < y0 + h; y++)
        for (let x = x0, s = (y - f.y) * f.width + x - f.x, d = y * width + x; x < x0 + w; x++, s++, d++) {
            // opaque pixels replace the canvas: runs of them are copied at once (much faster)
            let n = 0;
            while (n < x0 + w - x && (src[s + n] & ALPHA) === ALPHA) n++;
            if (n) {
                if (n >= 16) dst.set(src.subarray(s, s + n), d);
                else for (let i = 0; i < n; i++) dst[d + i] = src[s + i];
                x += n - 1; s += n - 1; d += n - 1;
                continue;
            }
            const value = src[s], alpha = value & ALPHA;
            if (alpha === 0) continue;
            if (alpha === ALPHA || (dst[d] & ALPHA) === 0) dst[d] = value;
            else {
                const sa = pixels[s * 4 + 3], da = canvas[d * 4 + 3];
                const u = sa * 255, v = (255 - sa) * da, al = u + v;
                for (let c = 0; c < 3; c++) canvas[d * 4 + c] = (pixels[s * 4 + c] * u + canvas[d * 4 + c] * v) / al | 0;
                canvas[d * 4 + 3] = al / 255 | 0;
            }
        }
}

// draws a frame onto a transparent area: blending only copies its pixels (transparent ones as 0, like draw())
function copy(canvas: Uint8Array, width: number, f: InputFrame, { x, y, width: w, height: h }: Rect): void {
    const canvas32 = new Int32Array(canvas.buffer, canvas.byteOffset, width * (y + h));
    for (let row = y; row < y + h; row++) {
        const s = ((row - f.y) * f.width + x - f.x) * 4, d = row * width + x;
        canvas.set(f.pixels.subarray(s, s + w * 4), d * 4);
        for (let p = d; p < d + w; p++) if ((canvas32[p] & ALPHA) === 0) canvas32[p] = 0;
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
