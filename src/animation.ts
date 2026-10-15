import * as gifCodec from './codecs/gif.ts';
import * as png from './codecs/png.ts';
import { BinaryData, view } from './util/mem.ts';
import { Image, ResizeMode } from './image.ts';
import { Frame } from './frame.ts';
import { ImageType } from './image-type.ts';

// loop counts: ImageScript (like GIF) counts repetitions (-1 forever, 0 play once), APNG counts plays (0 forever)
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

/**
 * An animation: an array of frames that can be decoded from and encoded to GIF and APNG.
 * Array methods like map and filter return plain arrays.
 */
export class Animation extends Array<Frame> {
    /** How many times to repeat the animation (-1 = forever, 0 = play once) */
    loopCount: number;

    /**
     * Creates a new animation
     * @param frames The frames to create the animation from
     * @param loopCount How many times to repeat the animation (-1 = forever, 0 = play once)
     */
    constructor(frames: Frame[], loopCount = -1) {
        super();
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
     */
    override slice(start?: number, end?: number): this {
        const Class = this.constructor as new (frames: Frame[], loopCount: number) => this;
        return new Class(Array.prototype.slice.call(this, start, end) as Frame[], this.loopCount);
    }

    /**
     * Resizes the animation to the given dimensions, scaling every frame and its offsets proportionally.
     * Use {@link Image.RESIZE_AUTO} as either width or height to automatically preserve the aspect ratio.
     */
    resize(width: number, height: number, mode: ResizeMode = Image.RESIZE_BILINEAR): this {
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
     * Encodes the animation as GIF
     * @param quality 1-100, scales the palette size from 8 colors (1) to 256 colors (90 and above)
     */
    async encodeGIF(quality = 95): Promise<Uint8Array> {
        this.__validate__();
        const frames: gifCodec.GIFFrame[] = [];

        for (const frame of this)
            frames.push({
                x: frame.xOffset,
                y: frame.yOffset,
                width: frame.width,
                height: frame.height,
                // gifs store centiseconds; rounding keeps e.g. 16 ms (60 fps) from becoming 10 ms
                delay: Math.round(frame.duration / 10),
                dispose: frame.__disposal_id__,
                pixels: new Uint8Array(frame.bitmap.buffer, frame.bitmap.byteOffset, frame.bitmap.byteLength)
            });

        return gifCodec.encode({ width: this.width, height: this.height, loopCount: this.loopCount, frames }, quality);
    }

    /**
     * Encodes the animation as APNG (animated PNG, lossless and with full alpha). Viewers without APNG support show
     * the first frame
     * @param compression The zlib compression level (0-9), higher is smaller but slower
     */
    async encodeAPNG(compression = 1): Promise<Uint8Array> {
        this.__validate__();
        if (!this.length) throw new Error('An animation needs at least one frame');

        return png.encodeAnimation(this.__apngFrames__(), this.width, this.height, toPlays(this.loopCount), compression);
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
     * Decodes an animated GIF or APNG into fully composited frames (still images become a single frame)
     * @param input The binary data to decode
     * @param onlyExtractFirstFrame Whether to stop decoding after the first frame
     */
    static async decode(input: BinaryData, onlyExtractFirstFrame = false): Promise<Animation> {
        const data = view(input);
        const type = ImageType.getType(data);

        if (type === 'gif') return Animation.__fromGIF__(data, onlyExtractFirstFrame, Animation);

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
