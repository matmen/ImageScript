/** Where lines are wrapped: between words or at any character */
export type WrapStyle = 'word' | 'char';
/** Alignment of the lines relative to the widest line */
export type HorizontalAlign = 'left' | 'center' | 'right';
/** Which lines to keep when the text is cut off at `maxHeight` */
export type VerticalAlign = 'top' | 'middle' | 'bottom';

/** Options of {@link TextLayout} */
export interface TextLayoutOptions {
    /** Longer lines are wrapped. Default: `Infinity` */
    maxWidth?: number;
    /** Lines that don't fit are cut off. Default: `Infinity` */
    maxHeight?: number;
    /** Whether to wrap between words or at any character. Default: `'word'` */
    wrapStyle?: WrapStyle;
    /**
     * Alignment of the lines relative to the widest line. Default: `'left'`
     * (before 3.0 this was called verticalAlign, values are accepted under either name)
     */
    horizontalAlign?: HorizontalAlign | VerticalAlign;
    /**
     * Which lines to keep when cutting off at `maxHeight`. Default: `'top'`
     * (before 3.0 this was called horizontalAlign, values are accepted under either name)
     */
    verticalAlign?: VerticalAlign | HorizontalAlign;
    /** Whether to break lines at newline characters. Default: `true` */
    wrapHardBreaks?: boolean;
}

const HORIZONTAL: readonly string[] = ['left', 'center', 'right'];
const VERTICAL: readonly string[] = ['top', 'middle', 'bottom'];

/**
 * Layout options for {@link Image.renderText}
 */
export class TextLayout {
    /** Longer lines are wrapped */
    maxWidth: number;
    /** Lines that don't fit are cut off */
    maxHeight: number;
    /** Whether to wrap between words or at any character */
    wrapStyle: WrapStyle;
    /** Alignment of the lines relative to the widest line */
    horizontalAlign: HorizontalAlign = 'left';
    /** Which lines to keep when cutting off at `maxHeight` */
    verticalAlign: VerticalAlign = 'top';
    /** Whether to break lines at newline characters */
    wrapHardBreaks: boolean;

    /**
     * Creates a layout, missing options take their defaults
     * @param options See {@link TextLayoutOptions}
     */
    constructor(options: TextLayoutOptions = {}) {
        const { maxWidth, maxHeight, wrapStyle, verticalAlign, horizontalAlign, wrapHardBreaks } = options;

        // (undefined and 0 mean no limit, NaN is invalid)
        this.maxWidth = maxWidth === undefined || maxWidth === 0 ? Infinity : Number(maxWidth);
        if (isNaN(this.maxWidth) || this.maxWidth < 1)
            throw new RangeError('Invalid maxWidth');

        this.maxHeight = maxHeight === undefined || maxHeight === 0 ? Infinity : Number(maxHeight);
        if (isNaN(this.maxHeight) || this.maxHeight < 1)
            throw new RangeError('Invalid maxHeight');

        this.wrapStyle = wrapStyle || 'word';
        if (!['word', 'char'].includes(this.wrapStyle))
            throw new RangeError('Invalid wrapStyle');

        for (const value of [horizontalAlign, verticalAlign]) {
            if (value === undefined) continue;
            if (HORIZONTAL.includes(value)) this.horizontalAlign = value as HorizontalAlign;
            else if (VERTICAL.includes(value)) this.verticalAlign = value as VerticalAlign;
            else throw new RangeError(`Invalid alignment: ${value}`);
        }

        this.wrapHardBreaks = typeof wrapHardBreaks === 'undefined' ? true : wrapHardBreaks;
        if (typeof this.wrapHardBreaks !== 'boolean')
            throw new TypeError('Invalid wrapHardBreaks');
    }
}
