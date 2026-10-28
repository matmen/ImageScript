import { Image, ResizeMode, ResizeOptions, Color, TrimOptions } from './image.ts';
import { isOptions, finite } from './util/options.ts';

/** Names of the frame disposal modes, see {@link Frame.disposalMode} */
export type FrameDisposalModeName = 'any' | 'keep' | 'previous' | 'background';
/** Ids of the frame disposal modes, as GIFs store them (0 any, 1 keep, 2 previous, 3 background) */
export type FrameDisposalModeId = 0 | 1 | 2 | 3;

const DISPOSAL_MODES: readonly FrameDisposalModeName[] = ['any', 'keep', 'previous', 'background'];

/** Options of {@link Frame} and {@link Frame.from} */
export interface FrameOptions {
    /** The frame's duration in milliseconds. Default: `100` */
    duration?: number;
    /** The frame's offset on the x-axis. Default: `0` */
    xOffset?: number;
    /** The frame's offset on the y-axis. Default: `0` */
    yOffset?: number;
    /** The frame's disposal mode, see {@link Frame.disposalMode}. Default: `'keep'` */
    disposalMode?: FrameDisposalModeName | FrameDisposalModeId;
}

/**
 * Represents a frame of an {@link Animation}
 */
export class Frame extends Image {
    /**
     * Milliseconds. GIFs store hundredths of a second, so this is rounded to 10 ms when encoding a GIF;
     * note that browsers play frames shorter than 20 ms with 100 ms
     */
    duration: number;
    /** The frame's horizontal offset in the animation */
    xOffset: number;
    /** The frame's vertical offset in the animation */
    yOffset: number;
    /**
     * @internal
     * @ignore
     */
    private __disposalMode__: FrameDisposalModeId = 1;

    /** Frame disposal mode ANY: the decoder decides (in practice like KEEP). For use with {@link Frame} */
    static get DISPOSAL_ANY(): 'any' {
        return 'any';
    }

    /** Frame disposal mode KEEP. For use with {@link Frame} */
    static get DISPOSAL_KEEP(): 'keep' {
        return 'keep';
    }

    /** Frame disposal mode PREVIOUS. For use with {@link Frame} */
    static get DISPOSAL_PREVIOUS(): 'previous' {
        return 'previous';
    }

    /** Frame disposal mode BACKGROUND. For use with {@link Frame} */
    static get DISPOSAL_BACKGROUND(): 'background' {
        return 'background';
    }

    /**
     * @internal
     * @ignore
     */
    static __convert_disposal_mode__(mode: FrameDisposalModeName | FrameDisposalModeId): FrameDisposalModeId {
        const id = typeof mode === 'string' ? DISPOSAL_MODES.indexOf(mode) : mode;
        if (!(id >= 0 && id <= 3))
            throw new RangeError('Invalid disposal mode');

        return id as FrameDisposalModeId;
    }

    /**
     * Creates a new, blank frame
     * @param options See {@link FrameOptions}
     */
    constructor(width: number, height: number, options?: FrameOptions);
    /**
     * Creates a new, blank frame
     * @param duration The frame's duration (in ms)
     * @param xOffset The frame's offset on the x-axis
     * @param yOffset The frame's offset on the y-axis
     * @param disposalMode The frame's disposal mode
     */
    constructor(width: number, height: number, duration?: number, xOffset?: number, yOffset?: number, disposalMode?: FrameDisposalModeName | FrameDisposalModeId);
    constructor(width: number, height: number, durationOrOptions?: number | FrameOptions, xOffset?: number, yOffset?: number, disposalMode?: FrameDisposalModeName | FrameDisposalModeId) {
        const { duration = 100, xOffset: x = 0, yOffset: y = 0, disposalMode: disposal = Frame.DISPOSAL_KEEP } =
            isOptions(durationOrOptions) ? durationOrOptions : { duration: durationOrOptions, xOffset, yOffset, disposalMode };
        if (finite(duration, 'frame duration') < 0)
            throw new RangeError('Invalid frame duration');
        finite(x, 'x offset');
        finite(y, 'y offset');

        super(width, height);
        this.duration = duration;
        this.xOffset = x;
        this.yOffset = y;
        this.disposalMode = disposal;
    }

    /** The frame's disposal mode (`'any'`, `'keep'`, `'previous'` or `'background'`); also settable by id (0-3) */
    get disposalMode(): FrameDisposalModeName {
        return DISPOSAL_MODES[this.__disposalMode__];
    }

    /**
     * The frame's disposal mode as id (0 any, 1 keep, 2 previous, 3 background)
     * @internal
     * @ignore
     */
    get __disposal_id__(): FrameDisposalModeId {
        return this.__disposalMode__;
    }

    /** Sets the disposal mode by name or id (0-3) */
    set disposalMode(disposalMode: FrameDisposalModeName | FrameDisposalModeId) {
        this.__disposalMode__ = Frame.__convert_disposal_mode__(disposalMode);
    }

    /** A short description for debugging, e.g. `Frame<64x64x100ms>` */
    override toString(): string {
        return `Frame<${this.width}x${this.height}x${this.duration}ms>`;
    }

    /**
     * Converts an Image instance to a Frame, cloning it in the process
     * @param image The image to create the frame from
     * @param options See {@link FrameOptions}
     */
    static from(image: Image, options?: FrameOptions): Frame;
    /**
     * Converts an Image instance to a Frame, cloning it in the process
     * @param image The image to create the frame from
     * @param duration The frame's duration (in ms)
     * @param xOffset The frame's offset on the x-axis
     * @param yOffset The frame's offset on the y-axis
     * @param disposalMode The frame's disposal mode
     */
    static from(image: Image, duration?: number, xOffset?: number, yOffset?: number, disposalMode?: FrameDisposalModeName | FrameDisposalModeId): Frame;
    static from(image: Image, durationOrOptions?: number | FrameOptions, xOffset?: number, yOffset?: number, disposalMode?: FrameDisposalModeName | FrameDisposalModeId): Frame {
        if (!(image instanceof Image))
            throw new TypeError('Invalid image passed');

        const options = isOptions(durationOrOptions) ? durationOrOptions : { duration: durationOrOptions, xOffset, yOffset, disposalMode };
        const frame = new Frame(image.width, image.height, options);
        frame.bitmap.set(image.bitmap);

        return frame;
    }

    /**
     * Clones the frame, including its duration, offsets and disposal mode
     */
    override clone(): Frame {
        return Frame.from(this, { duration: this.duration, xOffset: this.xOffset, yOffset: this.yOffset, disposalMode: this.disposalMode });
    }

    /**
     * Removes borders of one color, moving the frame's offsets so the remaining pixels stay in place
     * @param color The border color, by default the color of the top left pixel
     * @param options See {@link TrimOptions}
     */
    override trim(color?: Color, options: TrimOptions = {}): this {
        const bounds = this.__trim_bounds__(color, options);
        if (!bounds) return this;
        this.xOffset += bounds[0];
        this.yOffset += bounds[1];
        return this.__apply__(this.__crop__(...bounds));
    }

    /**
     * Resizes the frame, scaling its offsets along with it
     */
    override resize(width: number, height: number, modeOrOptions?: ResizeMode | ResizeOptions): this {
        const originalWidth = this.width;
        const originalHeight = this.height;

        super.resize(width, height, modeOrOptions as ResizeMode);

        this.xOffset = Math.round(this.xOffset * this.width / originalWidth);
        this.yOffset = Math.round(this.yOffset * this.height / originalHeight);

        return this;
    }
}
