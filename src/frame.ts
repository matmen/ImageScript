import { Image, ResizeMode } from './image.ts';

export type FrameDisposalModeName = 'any' | 'keep' | 'previous' | 'background';
export type FrameDisposalModeId = 0 | 1 | 2 | 3;

const DISPOSAL_MODES: readonly FrameDisposalModeName[] = ['any', 'keep', 'previous', 'background'];

/**
 * Represents a frame in a GIF
 */
export class Frame extends Image {
    /**
     * Milliseconds. GIFs store hundredths of a second, so this is rounded to 10 ms when encoding;
     * note that browsers play frames shorter than 20 ms with 100 ms
     */
    duration: number;
    xOffset: number;
    yOffset: number;
    /** @internal */
    private __disposalMode__: FrameDisposalModeId = 1;

    /** GIF frame disposal mode ANY: the decoder decides (in practice like KEEP). For use with {@link Frame} */
    static get DISPOSAL_ANY(): 'any' {
        return 'any';
    }

    /** GIF frame disposal mode KEEP. For use with {@link Frame} */
    static get DISPOSAL_KEEP(): 'keep' {
        return 'keep';
    }

    /** GIF frame disposal mode PREVIOUS. For use with {@link Frame} */
    static get DISPOSAL_PREVIOUS(): 'previous' {
        return 'previous';
    }

    /** GIF frame disposal mode BACKGROUND. For use with {@link Frame} */
    static get DISPOSAL_BACKGROUND(): 'background' {
        return 'background';
    }

    /** @internal */
    private static __convert_disposal_mode__(mode: FrameDisposalModeName | FrameDisposalModeId): FrameDisposalModeId {
        const id = typeof mode === 'string' ? DISPOSAL_MODES.indexOf(mode) : mode;
        if (!(id >= 0 && id <= 3))
            throw new RangeError('Invalid disposal mode');

        return id as FrameDisposalModeId;
    }

    /**
     * Creates a new, blank frame
     * @param duration The frame's duration (in ms)
     * @param xOffset The frame's offset on the x-axis
     * @param yOffset The frame's offset on the y-axis
     * @param disposalMode The frame's disposal mode
     */
    constructor(width: number, height: number, duration = 100, xOffset = 0, yOffset = 0, disposalMode: FrameDisposalModeName | FrameDisposalModeId = Frame.DISPOSAL_KEEP) {
        if (isNaN(duration) || duration < 0)
            throw new RangeError('Invalid frame duration');

        super(width, height);
        this.duration = duration;
        this.xOffset = xOffset;
        this.yOffset = yOffset;
        this.disposalMode = disposalMode;
    }

    /** The frame's disposal mode (`'any'`, `'keep'`, `'previous'` or `'background'`); also settable by id (0-3) */
    get disposalMode(): FrameDisposalModeName {
        return DISPOSAL_MODES[this.__disposalMode__];
    }

    /**
     * The frame's disposal mode as id (0 any, 1 keep, 2 previous, 3 background)
     * @internal
     */
    get __disposal_id__(): FrameDisposalModeId {
        return this.__disposalMode__;
    }

    set disposalMode(disposalMode: FrameDisposalModeName | FrameDisposalModeId) {
        this.__disposalMode__ = Frame.__convert_disposal_mode__(disposalMode);
    }

    override toString(): string {
        return `Frame<${this.width}x${this.height}x${this.duration}ms>`;
    }

    /**
     * Converts an Image instance to a Frame, cloning it in the process
     * @param image The image to create the frame from
     * @param duration The frame's duration (in ms)
     * @param xOffset The frame's offset on the x-axis
     * @param yOffset The frame's offset on the y-axis
     * @param disposalMode The frame's disposal mode
     */
    static from(image: Image, duration?: number, xOffset?: number, yOffset?: number, disposalMode: FrameDisposalModeName | FrameDisposalModeId = Frame.DISPOSAL_KEEP): Frame {
        if (!(image instanceof Image))
            throw new TypeError('Invalid image passed');

        const frame = new Frame(image.width, image.height, duration, xOffset, yOffset, disposalMode);
        frame.bitmap.set(image.bitmap);

        return frame;
    }

    /**
     * Clones the frame, including its duration, offsets and disposal mode
     */
    override clone(): Frame {
        return Frame.from(this, this.duration, this.xOffset, this.yOffset, this.disposalMode);
    }

    /**
     * Resizes the frame, scaling its offsets along with it
     */
    override resize(width: number, height: number, mode: ResizeMode = Image.RESIZE_BILINEAR): this {
        const originalWidth = this.width;
        const originalHeight = this.height;

        super.resize(width, height, mode);

        this.xOffset = Math.round(this.xOffset * this.width / originalWidth);
        this.yOffset = Math.round(this.yOffset * this.height / originalHeight);

        return this;
    }
}
