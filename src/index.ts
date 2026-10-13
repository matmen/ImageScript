import { BinaryData } from './util/mem.ts';
import { Image } from './image.ts';
import { GIF } from './gif.ts';
import { ImageType } from './image-type.ts';

export { Image } from './image.ts';
export type { Color, ColorFunction, ResizeMode, SVGScaleMode, PNGMetadata, DecodeOptions, CropCircleOptions, DominantColorOptions, RotateOptions } from './image.ts';
export { Frame } from './frame.ts';
export type { FrameDisposalModeName, FrameDisposalModeId } from './frame.ts';
export { GIF } from './gif.ts';
export { TextLayout } from './text-layout.ts';
export type { TextLayoutOptions, WrapStyle, HorizontalAlign, VerticalAlign } from './text-layout.ts';
export { ImageType } from './image-type.ts';
export type { ImageTypeName } from './image-type.ts';
export type { BinaryData } from './util/mem.ts';

/**
 * Decodes any supported image, GIFs are returned as {@link GIF}
 * @param data The image data
 * @param onlyExtractFirstFrame Whether to end GIF decoding after the first frame
 */
export function decode(data: BinaryData, onlyExtractFirstFrame = false): Promise<GIF | Image> {
    if (ImageType.getType(data) === 'gif') return GIF.decode(data, onlyExtractFirstFrame);
    return Image.decode(data);
}
