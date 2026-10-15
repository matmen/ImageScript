import * as gifCodec from './codecs/gif.ts';
import * as png from './codecs/png.ts';
import * as webp from './codecs/webp.ts';
import { BinaryData, view } from './util/mem.ts';
import { Image, ResizeMode, ResizeOptions } from './image.ts';
import { Frame } from './frame.ts';
import { ImageType } from './image-type.ts';
import { optimize, OptimizeOptions, OptimizedFrame } from './util/optimize.ts';
import { Metadata, resolveMetadata, pngText, exifData, gifComments } from './metadata.ts';
import { isOptions } from './util/options.ts';

// loop counts: ImageScript (like GIF) counts repetitions (-1 forever, 0 play once), APNG and WebP count plays (0 forever)
const toPlays = (loopCount: number): number => loopCount < 0 ? 0 : loopCount + 1;
const fromPlays = (plays: number): number => plays === 0 ? -1 : plays - 1;

// frames decoded fully composited, as full canvas frames
function canvasFrames(width: number, height: number, frames: Array<{ pixels: Uint8Array, duration: number }>): Frame[] {
    return frames.map(({ pixels, duration }) => {
        const frame = new Frame(width, height, duration, 0, 0, Frame.DISPOSAL_BACKGROUND);
        frame.bitmap.set(pixels);
        return frame;
    });
}

/** Options of {@link Animation} */
export interface AnimationOptions {
    /** How many times to repeat the animation (-1 = forever, 0 = play once). Default: `-1` */
    loopCount?: number;
}

/** Options of {@link Animation.decode} */
export interface AnimationDecodeOptions {
    /** Whether to stop decoding after the first frame. Default: `false` */
    onlyFirstFrame?: boolean;
}

/** Options of {@link Animation.encodeWebP}, and those all animation encoders have */
export interface AnimationEncodeOptions {
    /** Metadata to include, see {@link Metadata} */
    metadata?: Metadata;
    /**
     * Whether to store each frame as the area that changed since the frame before and merge identical frames, which
     * usually makes files a lot smaller. The file shows the same animation either way, but only decodes to the same
     * frames without it, which also encodes faster when little changes. Default: `true`
     */
    optimize?: boolean;
}

/** Options of {@link Animation.encodeGIF} */
export interface GIFEncodeOptions extends AnimationEncodeOptions {
    /** 1-100, scales the palette size from 8 colors (1) to 256 colors (90 and above). Default: `95` */
    quality?: number;
}

/** Options of {@link Animation.encodeAPNG} */
export interface APNGEncodeOptions extends AnimationEncodeOptions {
    /** The zlib compression level (0-9), higher is smaller but slower. Default: `1` */
    compression?: number;
}

/**
 * An animation: frames ({@link Animation.frames}) that can be decoded from and encoded to GIF, APNG and WebP.
 *
 * The animation itself is an array of its frames too (`animation[0]`, `animation.map(...)`), which is deprecated: in 4.0
 * it won't extend `Array` anymore, use {@link Animation.frames} instead. Array methods like map and filter return
 * plain arrays.
 */
export class Animation extends Array<Frame> {
    /** How many times to repeat the animation (-1 = forever, 0 = play once) */
    loopCount: number;

    /**
     * Creates a new animation
     * @param frames The frames to create the animation from
     * @param options See {@link AnimationOptions}
     */
    constructor(frames: Frame[], options?: AnimationOptions);
    /**
     * Creates a new animation
     * @param frames The frames to create the animation from
     * @param loopCount How many times to repeat the animation (-1 = forever, 0 = play once)
     */
    constructor(frames: Frame[], loopCount?: number);
    constructor(frames: Frame[], loopCountOrOptions: number | AnimationOptions = -1) {
        super();
        const { loopCount = -1 } = isOptions(loopCountOrOptions) ? loopCountOrOptions : { loopCount: loopCountOrOptions };
        // push instead of super(...frames), so a single frame isn't taken as a length
        for (const frame of frames) this.push(frame);

        for (let i = 0; i < this.length; i++)
            if (!(this[i] instanceof Frame))
                throw new TypeError(`Frame ${i} is not an instance of Frame`);

        if (loopCount < -1 || isNaN(loopCount))
            throw new RangeError('Invalid loop count');

        this.loopCount = loopCount;
    }

    /** @internal */
    static override get [Symbol.species](): ArrayConstructor {
        return Array;
    }

    /**
     * The animation's frames: an array that changes the animation when it's changed (e.g. `push()`, `splice()`, or
     * setting an index), and can be replaced as a whole
     */
    get frames(): Frame[] {
        return this;
    }

    /** Replaces the animation's frames */
    set frames(frames: Frame[]) {
        frames = Array.from(frames);
        frames.forEach((frame, i) => {
            if (!(frame instanceof Frame)) throw new TypeError(`Frame ${i} is not an instance of Frame`);
        });
        this.length = 0;
        for (const frame of frames) this.push(frame);
    }

    /** The animation's width */
    get width(): number {
        let max = 0;
        for (const frame of this) max = Math.max(max, frame.width + frame.xOffset);
        return max;
    }

    /** The animation's height */
    get height(): number {
        let max = 0;
        for (const frame of this) max = Math.max(max, frame.height + frame.yOffset);
        return max;
    }

    /** The animation's duration (in ms) */
    get duration(): number {
        let duration = 0;
        for (const frame of this) duration += frame.duration;
        return duration;
    }

    override toString(): string {
        return `Animation<${this.width}x${this.height}x${this.duration}ms>`;
    }

    /**
     * Returns a new animation of the same class containing a range of this one's frames
     * (same semantics as Array.prototype.slice)
     * @deprecated Use `new Animation(animation.frames.slice(start, end), animation.loopCount)`: in 4.0 animations
     *     aren't arrays anymore
     */
    override slice(start?: number, end?: number): this {
        const Class = this.constructor as new (frames: Frame[], loopCount: number) => this;
        return new Class(Array.prototype.slice.call(this, start, end) as Frame[], this.loopCount);
    }

    /**
     * Resizes the animation to the given dimensions, scaling every frame and its offsets proportionally.
     * Use {@link Image.RESIZE_AUTO} as either width or height to automatically preserve the aspect ratio.
     */
    resize(width: number, height: number, options?: ResizeOptions): this;
    /**
     * Resizes the animation to the given dimensions, scaling every frame and its offsets proportionally.
     * Use {@link Image.RESIZE_AUTO} as either width or height to automatically preserve the aspect ratio.
     */
    resize(width: number, height: number, mode?: ResizeMode): this;
    resize(width: number, height: number, modeOrOptions?: ResizeMode | ResizeOptions): this {
        const mode = (isOptions(modeOrOptions) ? modeOrOptions.mode : modeOrOptions) ?? Image.RESIZE_BILINEAR;
        const originalWidth = this.width, originalHeight = this.height;
        if (width === Image.RESIZE_AUTO && height === Image.RESIZE_AUTO) throw new Error('RESIZE_AUTO can only be used for either width or height, not for both');
        if (width === Image.RESIZE_AUTO) width = originalWidth / originalHeight * height;
        if (height === Image.RESIZE_AUTO) height = originalHeight / originalWidth * width;

        const sx = width / originalWidth, sy = height / originalHeight;
        for (const frame of this) {
            // scale both edges so adjacent frames stay aligned
            const left = Math.round(frame.xOffset * sx), top = Math.round(frame.yOffset * sy);
            const right = Math.round((frame.xOffset + frame.width) * sx), bottom = Math.round((frame.yOffset + frame.height) * sy);
            Image.prototype.resize.call(frame, Math.max(1, right - left), Math.max(1, bottom - top), mode);
            frame.xOffset = left;
            frame.yOffset = top;
        }

        return this;
    }

    /** @internal */
    protected __validate__(): void {
        for (const frame of this)
            if (!(frame instanceof Frame)) throw new Error('Animation contains invalid frames');
    }

    /**
     * Encodes the animation as GIF. Like all encoders, it stores each frame as the area that changed since the frame
     * before and merges identical frames (unless the `optimize` option is false), so the file decodes to what the
     * animation shows, but not necessarily to the same frames. Semi-transparent pixels become opaque or transparent
     * after the frames are composited
     * @param options See {@link GIFEncodeOptions}
     */
    encodeGIF(options?: GIFEncodeOptions): Promise<Uint8Array>;
    /**
     * Encodes the animation as GIF. Like all encoders, it stores each frame as the area that changed since the frame
     * before and merges identical frames (unless the `optimize` option is false), so the file decodes to what the
     * animation shows, but not necessarily to the same frames. Semi-transparent pixels become opaque or transparent
     * after the frames are composited
     * @param quality 1-100, scales the palette size from 8 colors (1) to 256 colors (90 and above)
     */
    encodeGIF(quality?: number): Promise<Uint8Array>;
    async encodeGIF(qualityOrOptions: number | GIFEncodeOptions = 95): Promise<Uint8Array> {
        const { quality = 95, metadata = {}, optimize = true } = isOptions(qualityOrOptions) ? qualityOrOptions : { quality: qualityOrOptions };
        this.__validate__();
        const frames = optimize
            ? this.__optimized__({ replace: false, even: false, alpha: 'frame', palette: 256, cover: true }).map(f => ({ ...f, dispose: f.dispose ? 3 : 1 }))
            : Array.from(this, frame => ({
                x: frame.xOffset,
                y: frame.yOffset,
                width: frame.width,
                height: frame.height,
                duration: frame.duration,
                dispose: frame.__disposal_id__,
                pixels: new Uint8Array(frame.bitmap.buffer, frame.bitmap.byteOffset, frame.bitmap.byteLength)
            }));
        // gifs store centiseconds; rounding keeps e.g. 16 ms (60 fps) from becoming 10 ms
        const gifFrames = frames.map(({ duration, ...f }) => ({ ...f, delay: Math.round(duration / 10) }));

        return gifCodec.encode({ width: this.width, height: this.height, loopCount: this.loopCount, frames: gifFrames }, quality, gifComments(resolveMetadata(metadata)));
    }

    /**
     * Encodes the animation as APNG (animated PNG, lossless and with full alpha). Viewers without APNG support show
     * the first frame. Each frame is stored as the area that changed since the frame before, identical frames are
     * merged (unless the `optimize` option is false): the file shows exactly the same animation, but doesn't
     * necessarily decode to the same frames
     * @param options See {@link APNGEncodeOptions}
     */
    encodeAPNG(options?: APNGEncodeOptions): Promise<Uint8Array>;
    /**
     * Encodes the animation as APNG (animated PNG, lossless and with full alpha). Viewers without APNG support show
     * the first frame. Each frame is stored as the area that changed since the frame before, identical frames are
     * merged (unless the `optimize` option is false): the file shows exactly the same animation, but doesn't
     * necessarily decode to the same frames
     * @param compression The zlib compression level (0-9), higher is smaller but slower
     */
    encodeAPNG(compression?: number): Promise<Uint8Array>;
    async encodeAPNG(compressionOrOptions: number | APNGEncodeOptions = 1): Promise<Uint8Array> {
        const { compression = 1, metadata = {}, optimize = true } = isOptions(compressionOrOptions) ? compressionOrOptions : { compression: compressionOrOptions };
        this.__validate__();
        if (!this.length) throw new Error('An animation needs at least one frame');

        const frames = optimize
            ? this.__optimized__({ replace: true, even: false, alpha: frames => png.alphaCost(frames.map(f => f.pixels)) }).map(f => ({ ...f, dispose: f.dispose ? 1 : 0 }))
            : this.__apngFrames__().map(({ blend: _, ...f }) => f); // blended, the encoder's default
        return png.encodeAnimation(frames, this.width, this.height, toPlays(this.loopCount), compression, pngText(resolveMetadata(metadata)));
    }

    /**
     * Encodes the animation as lossless animated WebP. Each frame is stored as the area that changed since the frame
     * before, identical frames are merged (unless the `optimize` option is false): the file shows exactly the same
     * animation, but doesn't necessarily decode to the same frames
     * @param options See {@link AnimationEncodeOptions}
     */
    async encodeWebP({ metadata = {}, optimize = true }: AnimationEncodeOptions = {}): Promise<Uint8Array> {
        this.__validate__();
        if (!this.length) throw new Error('An animation needs at least one frame');

        const frames = optimize ? this.__optimized__({ replace: true, even: true, alpha: 'frame' }) : this.__webpFrames__();
        return webp.encodeAnimation(frames, this.width, this.height, toPlays(this.loopCount), exifData(resolveMetadata(metadata)));
    }

    /** @internal the frames as they are, in the WebP codec's terms */
    __webpFrames__(): webp.WebPEncodeFrame[] {
        const width = this.width, height = this.height;
        // WebP knows no "previous" disposal and stores offsets halved: such animations are stored as full frames
        const fullFrames = this.some(f => f.disposalMode === 'previous' || (f.disposalMode === 'background' && (f.xOffset & 1 || f.yOffset & 1)));
        if (fullFrames)
            return png.compositeAnimation({ width, height, frames: this.__apngFrames__() })
                .map(c => ({ x: 0, y: 0, width, height, duration: c.duration, dispose: true, pixels: c.pixels }));

        return Array.from(this, frame => {
            let { xOffset: x, yOffset: y, width: w, height: h } = frame;
            let pixels = new Uint8Array(frame.bitmap.buffer, frame.bitmap.byteOffset, frame.bitmap.byteLength);
            // odd offsets: one transparent pixel more on the left/top (blending makes it invisible)
            if (x & 1 || y & 1) {
                const dx = x & 1, dy = y & 1;
                const padded = new Uint8Array((w + dx) * (h + dy) * 4);
                for (let row = 0; row < h; row++) padded.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((row + dy) * (w + dx) + dx) * 4);
                pixels = padded;
                x -= dx; y -= dy; w += dx; h += dy;
            }
            return { x, y, width: w, height: h, duration: frame.duration, dispose: frame.disposalMode === 'background', pixels };
        });
    }

    /**
     * The frames as the encoders store them: each frame only covers what changed since the one before (see
     * util/optimize.ts)
     * @internal
     */
    __optimized__(options: OptimizeOptions): OptimizedFrame[] {
        return optimize(this.__apngFrames__(), this.width, this.height, options);
    }

    /** @internal frames in the APNG codec's terms (alpha blended, disposal 0 none, 1 background, 2 previous) */
    __apngFrames__(): png.APNGFrame[] {
        const dispose = [0, 0, 2, 1];
        return Array.from(this, frame => ({
            x: frame.xOffset,
            y: frame.yOffset,
            width: frame.width,
            height: frame.height,
            duration: frame.duration,
            dispose: dispose[frame.__disposal_id__],
            blend: 1,
            pixels: new Uint8Array(frame.bitmap.buffer, frame.bitmap.byteOffset, frame.bitmap.byteLength)
        }));
    }

    /**
     * Decodes an animated GIF, APNG or WebP into fully composited frames (still images become a single frame)
     * @param input The binary data to decode
     * @param options See {@link AnimationDecodeOptions}
     */
    static decode(input: BinaryData, options?: AnimationDecodeOptions): Promise<Animation>;
    /**
     * Decodes an animated GIF, APNG or WebP into fully composited frames (still images become a single frame)
     * @param input The binary data to decode
     * @param onlyExtractFirstFrame Whether to stop decoding after the first frame
     */
    static decode(input: BinaryData, onlyExtractFirstFrame?: boolean): Promise<Animation>;
    static async decode(input: BinaryData, onlyFirstFrameOrOptions: boolean | AnimationDecodeOptions = false): Promise<Animation> {
        const onlyExtractFirstFrame = isOptions(onlyFirstFrameOrOptions) ? onlyFirstFrameOrOptions.onlyFirstFrame ?? false : onlyFirstFrameOrOptions;
        const data = view(input);
        const type = ImageType.getType(data);

        if (type === 'gif') return Animation.__fromGIF__(data, onlyExtractFirstFrame, Animation);

        if (type === 'webp') {
            const decoded = webp.decodeAnimation(data, onlyExtractFirstFrame);
            const frames = canvasFrames(decoded.width, decoded.height, webp.composite(decoded));
            return new Animation(frames, fromPlays(decoded.loopCount));
        }

        if (type === 'png') {
            const decoded = await png.decodeAnimation(data, onlyExtractFirstFrame);
            const frames = canvasFrames(decoded.width, decoded.height, png.compositeAnimation(decoded));
            return new Animation(frames, decoded.frames.length > 1 ? fromPlays(decoded.plays) : -1);
        }

        if (type) return new Animation([Frame.from(await Image.decode(data), 0)]);
        throw new Error('Unsupported image type');
    }

    /** @internal */
    static __fromGIF__<T extends Animation>(data: Uint8Array, onlyExtractFirstFrame: boolean, Class: new (frames: Frame[], loopCount: number) => T): T {
        const decoded = gifCodec.decode(data, onlyExtractFirstFrame);
        const frames = gifCodec.composite(decoded).map(({ pixels, delay }) => ({ pixels, duration: 10 * delay }));
        return new Class(canvasFrames(decoded.width, decoded.height, frames), decoded.loopCount);
    }
}
