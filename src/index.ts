import { BinaryData } from './util/mem.ts';
import { Image, DecodeOptions } from './image.ts';
import { GIF } from './gif.ts';
import { Animation, AnimationDecodeOptions } from './animation.ts';
import { isOptions } from './util/options.ts';
import * as webp from './codecs/webp.ts';
import { view } from './util/mem.ts';
import { ImageType } from './image-type.ts';

export { Image } from './image.ts';
export type { Color, ColorFunction, ResizeMode, SVGScaleMode, PNGMetadata, TextStyle, DecodeOptions, CompositeOptions, BlendMode, CropCircleOptions, DominantColorOptions, RotateOptions, ColorToAlphaOptions, ResizeOptions, AdjustOptions, SharpenOptions, PNGEncodeOptions, JPEGEncodeOptions, EncodeOptions, SVGOptions, TextOptions, RoundCornersOptions, FisheyeOptions, TrimOptions } from './image.ts';
export { Frame } from './frame.ts';
export type { FrameDisposalModeName, FrameDisposalModeId, FrameOptions } from './frame.ts';
export { GIF } from './gif.ts';
export { Animation } from './animation.ts';
export type { AnimationOptions, AnimationDecodeOptions, AnimationEncodeOptions, GIFEncodeOptions, APNGEncodeOptions } from './animation.ts';
export { TextLayout } from './text-layout.ts';
export type { TextLayoutOptions, WrapStyle, HorizontalAlign, VerticalAlign } from './text-layout.ts';
export { ImageType } from './image-type.ts';
export type { ImageTypeName } from './image-type.ts';
export type { BinaryData } from './util/mem.ts';
export type { Metadata } from './metadata.ts';

/**
 * Decodes any supported image: GIFs are returned as {@link GIF} (an {@link Animation}), animated WebPs as
 * {@link Animation}, everything else (including APNGs, as their default image) as {@link Image}.
 * {@link Animation.decode} decodes the frames of GIFs, APNGs and WebPs
 * @param data The image data
 * @param options See {@link AnimationDecodeOptions} (for animations) and {@link DecodeOptions} (for images)
 */
export function decode(data: BinaryData, options?: AnimationDecodeOptions & DecodeOptions): Promise<GIF | Animation | Image>;
/**
 * Decodes any supported image: GIFs are returned as {@link GIF} (an {@link Animation}), animated WebPs as
 * {@link Animation}, everything else (including APNGs, as their default image) as {@link Image}.
 * {@link Animation.decode} decodes the frames of GIFs, APNGs and WebPs
 * @param data The image data
 * @param onlyExtractFirstFrame Whether to end animation decoding after the first frame
 */
export function decode(data: BinaryData, onlyExtractFirstFrame?: boolean): Promise<GIF | Animation | Image>;
export function decode(data: BinaryData, onlyFirstFrameOrOptions: boolean | (AnimationDecodeOptions & DecodeOptions) = false): Promise<GIF | Animation | Image> {
    const { onlyFirstFrame = false, applyOrientation, maxPixels } = isOptions(onlyFirstFrameOrOptions) ? onlyFirstFrameOrOptions : { onlyFirstFrame: onlyFirstFrameOrOptions };
    const type = ImageType.getType(data);
    if (type === 'gif') return GIF.decode(data, { onlyFirstFrame, maxPixels });
    if (type === 'webp' && webp.isAnimated(view(data))) return Animation.decode(data, { onlyFirstFrame, maxPixels });
    return Image.decode(data, { applyOrientation, maxPixels });
}
