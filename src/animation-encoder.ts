import * as gifCodec from './codecs/gif.ts';
import * as png from './codecs/png.ts';
import * as webp from './codecs/webp.ts';
import { Image } from './image.ts';
import { Frame, FrameOptions } from './frame.ts';
import { Optimizer, Compositor, InputFrame, OptimizeOptions, OptimizedFrame, coverCanvas, fillUnchanged } from './util/optimize.ts';
import { compressAsync, decompressAsync } from './codecs/zlib.ts';
import { Metadata, resolveMetadata, pngText, exifData, gifComments } from './metadata.ts';
import { finite } from './util/options.ts';

// (ImageScript, like GIF, counts repetitions: -1 forever, 0 play once; APNG and WebP count plays, 0 forever)
const toPlays = (loopCount: number): number => loopCount < 0 ? 0 : loopCount + 1;

/** The options all animation encoders of {@link Animation.webpEncoder} and the others have */
export interface AnimationEncoderOptions {
    /** How many times to repeat the animation (-1 = forever, 0 = play once). Default: `-1` */
    loopCount?: number;
    /** Metadata to include, see {@link Metadata} */
    metadata?: Metadata;
    /**
     * Whether to store each frame as the area that changed since the frame before and merge identical frames, like
     * {@link AnimationEncodeOptions.optimize}. Default: `true`
     */
    optimize?: boolean;
}

/** Options of {@link Animation.webpEncoder} */
export interface WebPAnimationEncoderOptions extends AnimationEncoderOptions {
    /** Lossy frames (0-100), see {@link WebPAnimationEncodeOptions.quality}. Without it the frames are lossless */
    quality?: number;
    /** How much effort lossy frames take (0-6), see {@link WebPEncodeOptions.effort}. Default: `2` */
    effort?: number;
}

/** Options of {@link Animation.gifEncoder} */
export interface GIFAnimationEncoderOptions extends AnimationEncoderOptions {
    /** 1-100, scales the palette size from 8 colors (1) to 256 colors (90 and above). Default: `95` */
    quality?: number;
}

/** Options of {@link Animation.apngEncoder} */
export interface APNGAnimationEncoderOptions extends AnimationEncoderOptions {
    /** The zlib compression level (0-9), higher is smaller but slower. Default: `1` */
    compression?: number;
}

// a format's part: takes the frames in order once they can't change anymore, then makes the file
interface Format {
    readonly optimize: OptimizeOptions;
    frame(f: OptimizedFrame | InputFrame, optimized: boolean): Promise<void>;
    file(optimizer: Optimizer | null): Promise<Uint8Array> | Uint8Array;
}

/**
 * Encodes an animation a frame at a time, without keeping all frames in memory: see {@link Animation.webpEncoder},
 * {@link Animation.gifEncoder} and {@link Animation.apngEncoder}. The file is the one an {@link Animation} of the
 * frames encodes to, but for unoptimized WebPs with frames WebP can't store as they are (disposed to the previous
 * frame, or disposed with odd offsets): from the first of them on, the frames are the canvas they show (the same
 * animation, blending rounds differently by 1 at most). APNGs keep their frames compressed until the end: their pixel
 * format depends on all of them
 */
export class AnimationEncoder {
    private optimizer: Optimizer | null;
    private queue: Promise<void> = Promise.resolve();
    private count = 0;
    private finished = false;

    /** @internal */
    constructor(readonly width: number, readonly height: number, private readonly format: Format, optimize: boolean) {
        this.optimizer = optimize ? new Optimizer(width, height, format.optimize) : null;
    }

    /** How many frames were added */
    get frames(): number {
        return this.count;
    }

    /**
     * Adds the next frame: a {@link Frame} (with its duration, offsets and disposal) or an image (a frame of 100 ms by
     * default). The options override the frame's. The pixels are copied right away, the image can change afterwards
     * @param frame The frame or image
     * @param options See {@link FrameOptions}
     */
    add(frame: Frame | Image, options: FrameOptions = {}): Promise<void> {
        if (this.finished) throw new Error('The animation encoder is finished');
        if (!(frame instanceof Image)) throw new TypeError('Invalid frame passed');
        const own = frame instanceof Frame ? frame : null;
        const duration = options.duration ?? own?.duration ?? 100;
        const x = options.xOffset ?? own?.xOffset ?? 0, y = options.yOffset ?? own?.yOffset ?? 0;
        if (finite(duration, 'frame duration') < 0) throw new RangeError('Invalid frame duration');
        finite(x, 'x offset');
        finite(y, 'y offset');
        const disposal = options.disposalMode !== undefined ? Frame.__convert_disposal_mode__(options.disposalMode) : own ? own.__disposal_id__ : 1;
        const input: InputFrame & { disposal: number } = {
            x, y, width: frame.width, height: frame.height, duration, disposal,
            // (0 none, 1 background, 2 previous, like APNG)
            dispose: [0, 0, 2, 1][disposal],
            pixels: new Uint8Array(frame.bitmap.buffer, frame.bitmap.byteOffset, frame.bitmap.byteLength).slice()
        };
        this.count++;
        return this.queue = this.queue.then(async () => {
            if (!this.optimizer) return this.format.frame(input, false);
            this.optimizer.push(input);
            for (const f of this.optimizer.take()) await this.format.frame(f, true);
        });
    }

    /** Encodes the rest and returns the file. The encoder can't be used afterwards */
    async finish(): Promise<Uint8Array> {
        if (this.finished) throw new Error('The animation encoder is finished');
        this.finished = true;
        await this.queue;
        if (!this.count) throw new Error('An animation needs at least one frame');
        if (this.optimizer) for (const f of this.optimizer.end()) await this.format.frame(f, true);
        const optimizer = this.optimizer;
        this.optimizer = null;
        return this.format.file(optimizer);
    }

    /** @internal */
    static __webp__(width: number, height: number, { loopCount = -1, metadata = {}, optimize = true, quality, effort = 2 }: WebPAnimationEncoderOptions): AnimationEncoder {
        canvas(width, height, loopCount);
        if (width > 1 << 24 || height > 1 << 24) throw new RangeError('WebP: canvas too large');
        if (quality !== undefined) {
            const q = finite(quality, 'quality');
            if (q < 0 || q > 100) throw new RangeError(`quality must be 0-100, not ${q}`);
            if (!Number.isInteger(effort) || effort < 0 || effort > 6) throw new RangeError(`effort must be an integer 0-6, not ${effort}`);
        }
        const resolved = resolveMetadata(metadata), chunks: Uint8Array[] = [];
        let alpha = false;
        // without optimizing: frames WebP can't store (disposed to the previous frame, or disposed with odd offsets) are
        // stored as the canvas they show, replacing it, and so are all after them
        const compositor = optimize ? null : new Compositor(width, height);
        let full = false;
        const add = (f: webp.WebPEncodeFrame): void => {
            alpha ||= webp.needsAlpha(f, !chunks.length, width, height);
            chunks.push(webp.frameChunk(f, quality, effort));
        };
        return new AnimationEncoder(width, height, {
            optimize: { replace: true, even: true, alpha: 'frame', tolerance: quality === undefined ? undefined : webp.lossyTolerance(quality) },
            async frame(f, optimized) {
                if (optimized) return add(f as OptimizedFrame);
                const input = f as InputFrame & { disposal: number };
                const shown = (compositor as Compositor).push(input);
                full ||= input.dispose === 2 || (input.dispose === 1 && !!(input.x & 1 || input.y & 1));
                if (full) return add({ x: 0, y: 0, width, height, duration: input.duration, dispose: true, blend: false, pixels: shown });
                add(webpFrame(input));
            },
            file: () => webp.animationFile(chunks, width, height, toPlays(loopCount), alpha, exifData(resolved))
        }, optimize);
    }

    /** @internal */
    static __gif__(width: number, height: number, { loopCount = -1, metadata = {}, optimize = true, quality = 95 }: GIFAnimationEncoderOptions): AnimationEncoder {
        canvas(width, height, loopCount);
        const comments = gifComments(resolveMetadata(metadata));
        // (the first frame is encoded last: it needs a transparent index if any frame restores the background)
        let first: gifCodec.GIFFrame | null = null, restores = false;
        const rest: Uint8Array[] = [];
        return new AnimationEncoder(width, height, {
            optimize: { replace: false, even: false, alpha: 'frame', palette: 256, cover: true },
            async frame(f, optimized) {
                if (!first && optimized) coverCanvas(f as OptimizedFrame, width, height);
                const gif: gifCodec.GIFFrame = { x: f.x, y: f.y, width: f.width, height: f.height, pixels: f.pixels,
                    dispose: optimized ? ((f as OptimizedFrame).dispose ? 3 : 1) : (f as InputFrame & { disposal: number }).disposal,
                    // gifs store centiseconds; rounding keeps e.g. 16 ms (60 fps) from becoming 10 ms
                    delay: Math.round(f.duration / 10) };
                restores ||= gif.dispose === 3;
                if (!first) first = gif;
                else rest.push(gifCodec.encodeFrame(gif, quality, gif.dispose === 3));
            },
            file() {
                const f = first as gifCodec.GIFFrame;
                return concat([gifCodec.header(width, height, loopCount, comments), gifCodec.encodeFrame(f, quality, f.dispose === 3 || restores), ...rest, new Uint8Array([0x3b])]);
            }
        }, optimize);
    }

    /** @internal */
    static __apng__(width: number, height: number, { loopCount = -1, metadata = {}, optimize = true, compression = 1 }: APNGAnimationEncoderOptions): AnimationEncoder {
        canvas(width, height, loopCount);
        const text = pngText(resolveMetadata(metadata));
        // the frames are kept compressed (quickly): the pixel format, and whether opaque animations are stored without
        // transparency, depend on all of them; then they are converted and compressed one at a time, like encodeAPNG
        const stored: Array<{ frame: Omit<png.APNGEncodeFrame, 'pixels'>, packed: Uint8Array }> = [];
        const cost = new png.AlphaCost();
        let blended = false;
        return new AnimationEncoder(width, height, {
            optimize: { replace: true, even: false, alpha: () => cost.cost() },
            async frame(f, optimized) {
                let frame: png.APNGEncodeFrame;
                if (optimized) {
                    const o = f as OptimizedFrame;
                    cost.add(o.pixels);
                    blended ||= o.blend;
                    frame = { x: o.x, y: o.y, width: o.width, height: o.height, duration: o.duration, dispose: o.dispose ? 1 : 0, blend: o.blend, pixels: o.pixels };
                } else {
                    frame = { x: f.x, y: f.y, width: f.width, height: f.height, duration: f.duration, dispose: (f as InputFrame).dispose, pixels: f.pixels };
                    png.checkFrame(stored.length ? frame : png.coverCanvas(frame, width, height), width, height);
                }
                const { pixels, ...rest } = frame;
                stored.push({ frame: rest, packed: await compressAsync(pixels, 1) });
            },
            async file(optimizer) {
                const fill = !!optimizer && optimizer.opaque && blended && optimizer.denseTotal < optimizer.chosenTotal * cost.cost();
                // the frames as encodeAPNG stores them, one at a time
                const frames = async function* (): AsyncGenerator<png.APNGEncodeFrame> {
                    const shown32 = new Int32Array(width * height);
                    for (const [i, { frame, packed }] of stored.entries()) {
                        let f: png.APNGEncodeFrame = { ...frame, pixels: await decompressAsync(packed, frame.width * frame.height * 4) };
                        if (fill) fillUnchanged(f, shown32, width);
                        if (i === 0) f = png.coverCanvas(f, width, height);
                        yield f;
                    }
                };
                const scanner = new png.FormatScanner();
                for await (const f of frames()) scanner.add(f.pixels);
                const format = scanner.format(), encoded: png.EncodedAPNGFrame[] = [];
                for await (const { pixels, ...f } of frames()) encoded.push({ ...f, data: await png.frameData(pixels, f.width, f.height, format, compression) });
                return png.animationFile(encoded, width, height, toPlays(loopCount), format, text);
            }
        }, optimize);
    }
}

function canvas(width: number, height: number, loopCount: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError(`Invalid canvas size: ${width}x${height}`);
    if (!Number.isInteger(loopCount) || loopCount < -1) throw new RangeError('Invalid loop count');
}

// a frame in the WebP codec's terms (odd offsets: one transparent pixel more on the left/top, blending makes it
// invisible)
function webpFrame(f: InputFrame): webp.WebPEncodeFrame {
    let { x, y, width: w, height: h, pixels } = f;
    if (x & 1 || y & 1) {
        const dx = x & 1, dy = y & 1;
        const padded = new Uint8Array((w + dx) * (h + dy) * 4);
        for (let row = 0; row < h; row++) padded.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((row + dy) * (w + dx) + dx) * 4);
        pixels = padded;
        x -= dx; y -= dy; w += dx; h += dy;
    }
    return { x, y, width: w, height: h, duration: f.duration, dispose: f.dispose === 1, pixels };
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

