import { BinaryData } from './util/mem.ts';
import { Image } from './image.ts';
import { GIF } from './gif.ts';
import { ImageType } from './image-type.ts';

export { Image } from './image.ts';
export type { Color, ColorFunction, ResizeMode, SVGScaleMode, PNGMetadata, TextStyle, DecodeOptions, CompositeOptions, BlendMode, CropCircleOptions, DominantColorOptions, RotateOptions } from './image.ts';
export { Frame } from './frame.ts';
export type { FrameDisposalModeName, FrameDisposalModeId } from './frame.ts';
export { GIF } from './gif.ts';
export { Animation } from './animation.ts';
export { TextLayout } from './text-layout.ts';
export type { TextLayoutOptions, WrapStyle, HorizontalAlign, VerticalAlign } from './text-layout.ts';
export { ImageType } from './image-type.ts';
export type { ImageTypeName } from './image-type.ts';
export type { BinaryData } from './util/mem.ts';

/**
 * Decodes any supported image: GIFs are returned as {@link GIF}, everything else (including APNGs, as their default
 * image) as {@link Image}. {@link Animation.decode} decodes the frames of APNGs
 * @param data The image data
 * @param onlyExtractFirstFrame Whether to end animation decoding after the first frame
 */
export function decode(data: BinaryData, onlyExtractFirstFrame = false): Promise<GIF | Image> {
    const type = ImageType.getType(data);
    if (type === 'gif') return GIF.decode(data, onlyExtractFirstFrame);
    return Image.decode(data);
}
