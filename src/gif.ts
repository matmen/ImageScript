import * as codec from './codecs/gif.ts';
import { BinaryData, view } from './util/mem.ts';
import { Image, ResizeMode } from './image.ts';
import { Frame } from './frame.ts';
import { ImageType } from './image-type.ts';

/**
 * Represents a GIF image as an array of frames.
 * Array methods like map and filter return plain arrays.
 */
export class GIF extends Array<Frame> {
    /** How many times to repeat the GIF (-1 = forever, 0 = play once) */
    loopCount: number;

    /**
     * Creates a new GIF image
     * @param frames The frames to create the GIF from
     * @param loopCount How many times to repeat the GIF (-1 = forever, 0 = play once)
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

    /** The GIF's width */
    get width(): number {
        let max = 0;
        for (const frame of this) max = Math.max(max, frame.width + frame.xOffset);
        return max;
    }

    /** The GIF's height */
    get height(): number {
        let max = 0;
        for (const frame of this) max = Math.max(max, frame.height + frame.yOffset);
        return max;
    }

    /** The GIF's duration (in ms) */
    get duration(): number {
        let duration = 0;
        for (const frame of this) duration += frame.duration;
        return duration;
    }

    override toString(): string {
        return `GIF<${this.width}x${this.height}x${this.duration}ms>`;
    }

    /**
     * Returns a new GIF containing a range of this GIF's frames (same semantics as Array.prototype.slice)
     */
    override slice(start?: number, end?: number): GIF {
        return new GIF(Array.prototype.slice.call(this, start, end) as Frame[], this.loopCount);
    }

    /**
     * Encodes the GIF
     * @param quality 1-100, scales the palette size from 8 colors (1) to 256 colors (90 and above)
     */
    async encode(quality = 95): Promise<Uint8Array> {
        const frames: codec.GIFFrame[] = [];

        for (const frame of this) {
            if (!(frame instanceof Frame)) throw new Error('GIF contains invalid frames');

            frames.push({
                x: frame.xOffset,
                y: frame.yOffset,
                width: frame.width,
                height: frame.height,
                // gifs store centiseconds; rounding keeps e.g. 16 ms (60 fps) from becoming 10 ms
                delay: Math.round(frame.duration / 10),
                dispose: frame.disposalMode,
                pixels: new Uint8Array(frame.bitmap.buffer, frame.bitmap.byteOffset, frame.bitmap.byteLength)
            });
        }

        return codec.encode({ width: this.width, height: this.height, loopCount: this.loopCount, frames }, quality);
    }

    /**
     * Decodes a GIF into fully composited frames
     * @param input The binary data to decode
     * @param onlyExtractFirstFrame Whether to end GIF decoding after the first frame
     */
    static async decode(input: BinaryData, onlyExtractFirstFrame = false): Promise<GIF> {
        const data = view(input);
        if (!ImageType.isGIF(new DataView(data.buffer, data.byteOffset, data.byteLength))) throw new Error('Unsupported image type');

        const decoded = codec.decode(data, onlyExtractFirstFrame);
        const frames = codec.composite(decoded).map(({ pixels, delay }) => {
            const frame = new Frame(decoded.width, decoded.height, 10 * delay, 0, 0, Frame.DISPOSAL_BACKGROUND);
            frame.bitmap.set(pixels);
            return frame;
        });

        return new GIF(frames, decoded.loopCount);
    }

    /**
     * Resizes the GIF to the given dimensions, scaling every frame and its offsets proportionally.
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
}
