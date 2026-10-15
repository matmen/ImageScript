import { BinaryData, view } from './util/mem.ts';
import { Frame } from './frame.ts';
import { ImageType } from './image-type.ts';
import { Animation } from './animation.ts';

/**
 * Represents a GIF image as an array of frames, an {@link Animation} whose `encode()` and `decode()` work with GIFs.
 * Array methods like map and filter return plain arrays.
 * @deprecated Use {@link Animation}, which works the same and also handles APNG: `new Animation(frames, loopCount)`,
 *     {@link Animation.decode} and {@link Animation.encodeGIF}. `GIF` will be removed in 4.0
 */
export class GIF extends Animation {
    /**
     * Creates a new GIF image
     * @param frames The frames to create the GIF from
     * @param loopCount How many times to repeat the GIF (-1 = forever, 0 = play once)
     */
    constructor(frames: Frame[], loopCount = -1) {
        super(frames, loopCount);
    }

    override toString(): string {
        return `GIF<${this.width}x${this.height}x${this.duration}ms>`;
    }

    /**
     * Encodes the GIF
     * @param quality 1-100, scales the palette size from 8 colors (1) to 256 colors (90 and above)
     * @deprecated Use {@link Animation.encodeGIF}
     */
    async encode(quality = 95): Promise<Uint8Array> {
        return this.encodeGIF(quality);
    }

    /**
     * Decodes a GIF into fully composited frames
     * @param input The binary data to decode
     * @param onlyExtractFirstFrame Whether to end GIF decoding after the first frame
     * @deprecated Use {@link Animation.decode}, which decodes APNGs too
     */
    static override async decode(input: BinaryData, onlyExtractFirstFrame = false): Promise<GIF> {
        const data = view(input);
        if (!ImageType.isGIF(new DataView(data.buffer, data.byteOffset, data.byteLength))) throw new Error('Unsupported image type');
        return Animation.__fromGIF__(data, onlyExtractFirstFrame, GIF);
    }
}
