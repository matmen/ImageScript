export type WrapStyle = 'word' | 'char';
export type HorizontalAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';

export interface TextLayoutOptions {
    /** Longer lines are wrapped. Default: `Infinity` */
    maxWidth?: number;
    /** Lines that don't fit are cut off. Default: `Infinity` */
    maxHeight?: number;
    /** Default: `'word'` */
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
    maxWidth: number;
    maxHeight: number;
    wrapStyle: WrapStyle;
    horizontalAlign: HorizontalAlign = 'left';
    verticalAlign: VerticalAlign = 'top';
    wrapHardBreaks: boolean;

    constructor(options: TextLayoutOptions = {}) {
        const { maxWidth, maxHeight, wrapStyle, verticalAlign, horizontalAlign, wrapHardBreaks } = options;

        this.maxWidth = maxWidth || Infinity;
        if (isNaN(this.maxWidth) || this.maxWidth < 1)
            throw new RangeError('Invalid maxWidth');

        this.maxHeight = maxHeight || Infinity;
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
