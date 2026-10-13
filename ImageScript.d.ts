/**
 * Colors are 32-bit RGBA integers (`0xRRGGBBAA`), e.g. `0xff0000ff` for opaque red.
 *
 * Coordinates: pixel access ({@link Image.getPixelAt}, {@link Image.setPixelAt}, {@link Image.getRGBAAt}),
 * {@link Image.drawBox}, {@link Image.drawCircle}, iteration and {@link ColorFunction}s use 1-based coordinates,
 * {@link Image.crop} and {@link Image.composite} use 0-based offsets.
 */
export class Image {
  /** The image's RGBA pixel data */
  bitmap: Uint8ClampedArray;

  /**
   * Creates a new, fully transparent image.
   */
  constructor(width: number, height: number);

  get width(): number;

  get height(): number;

  /** Yields the 1-based `[x, y]` coordinates of every pixel. */
  [Symbol.iterator](): Generator<[x: number, y: number], void, unknown>;

  /** Yields `[x, y, color]` for every pixel (1-based coordinates). */
  iterateWithColors(): Generator<[x: number, y: number, color: number], void, unknown>;

  /** Converts RGBA components (`0`-`255`) to a color. */
  static rgbaToColor(r: number, g: number, b: number, a: number): number;

  /** Converts RGB components (`0`-`255`) to an opaque color. */
  static rgbToColor(r: number, g: number, b: number): number;

  /** Converts HSLA components (`0`-`1`) to a color. */
  static hslaToColor(h: number, s: number, l: number, a: number): number;

  /** Converts HSL components (`0`-`1`) to an opaque color. */
  static hslToColor(h: number, s: number, l: number): number;

  /** Converts RGBA components (`0`-`255`) to HSLA components (`0`-`1`). */
  static rgbaToHSLA(r: number, g: number, b: number, a: number): [h: number, s: number, l: number, a: number];

  static colorToRGBA(color: number): [r: number, g: number, b: number, a: number];

  static colorToRGB(color: number): [r: number, g: number, b: number];

  /** Gets the color of a pixel (1-based coordinates). */
  getPixelAt(x: number, y: number): number;

  /** Gets a view of a pixel's RGBA components (1-based coordinates). */
  getRGBAAt(x: number, y: number): Uint8ClampedArray;

  /** Sets the color of a pixel (1-based coordinates). */
  setPixelAt(x: number, y: number, pixelColor: number): this;

  /**
   * Fills the entire image with the supplied color.
   */
  fill(color: number | ColorFunction): this;

  clone(): Image;

  /**
   * Use [Nearest-neighbor](https://en.wikipedia.org/wiki/Image_scaling#Nearest-neighbor_interpolation)
   * resizing.
   */
  static get RESIZE_NEAREST_NEIGHBOR(): "RESIZE_NEAREST_NEIGHBOR";

  /**
   * Used for automatically preserving an image's aspect ratio when resizing,
   * pass it as either the width or the height.
   */
  static get RESIZE_AUTO(): -1;

  /**
   * Resizes the image by the given factor.
   *
   * @param factor The factor to resize the image with
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  scale(factor: number, mode?: ResizeMode): this;

  /**
   * Resizes the image to the given dimensions.
   * Use {@link Image.RESIZE_AUTO} as either width or height to automatically
   * preserve the aspect ratio.
   *
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  resize(width: number, height: number, mode?: ResizeMode): this;

  /**
   * Resizes the image so it is contained in the given bounding box.
   * Can return an image with one axis smaller than the given bounding box.
   *
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  contain(width: number, height: number, mode?: ResizeMode): this;

  /**
   * Resizes the image so it is contained in the given bounding box, placing
   * it in the center of the given bounding box.
   * Always returns the exact dimensions of the bounding box.
   *
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  fit(width: number, height: number, mode?: ResizeMode): this;

  /**
   * Resizes the image so it covers the given bounding box, cropping the
   * overflowing edges.
   * Always returns the exact dimensions of the bounding box.
   *
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  cover(width: number, height: number, mode?: ResizeMode): this;

  /**
   * Crops the image to the given region (0-based offsets).
   * The region is clipped to the image, throws if it doesn't overlap it.
   */
  crop(x: number, y: number, width: number, height: number): this;

  /**
   * Draws a box at the specified coordinates (1-based), clipped to the image.
   */
  drawBox(x: number, y: number, width: number, height: number, color: number | ColorFunction): this;

  /**
   * Draws a circle around the specified center (1-based) with the specified radius.
   */
  drawCircle(x: number, y: number, radius: number, color: number | ColorFunction): this;

  /**
   * Crops the image into a circle.
   *
   * @param max Whether to use the larger dimension for the size. Default: `false`
   * @param feathering How much feathering to apply to the edges. Default: `0`
   */
  cropCircle(max?: boolean, feathering?: number): this;

  /**
   * Sets the image's opacity.
   *
   * @param opacity `0`-`1`, where `0` is completely transparent and
   *     `1` is completely opaque.
   * @param absolute Whether to scale the current opacity (`false`) or
   *     just set the new opacity (`true`). Default: `false`
   */
  opacity(opacity: number, absolute?: boolean): this;

  /**
   * Sets the red channel's saturation value.
   *
   * @param saturation `0`-`1`
   * @param absolute Whether to scale the current saturation (`false`) or
   *     just set the new saturation (`true`). Default: `false`
   */
  red(saturation: number, absolute?: boolean): this;

  /**
   * Sets the green channel's saturation value.
   *
   * @param saturation `0`-`1`
   * @param absolute Whether to scale the current saturation (`false`) or
   *     just set the new saturation (`true`). Default: `false`
   */
  green(saturation: number, absolute?: boolean): this;

  /**
   * Sets the blue channel's saturation value.
   *
   * @param saturation `0`-`1`
   * @param absolute Whether to scale the current saturation (`false`) or
   *     just set the new saturation (`true`). Default: `false`
   */
  blue(saturation: number, absolute?: boolean): this;

  /**
   * Sets the brightness of the image.
   *
   * @param value `0`-`1`
   * @param absolute Whether to scale the current lightness (`false`) or
   *     just set the new lightness (`true`). Default: `false`
   */
  lightness(value: number, absolute?: boolean): this;

  /**
   * Sets the saturation of the image.
   *
   * @param value `0`-`1`
   * @param absolute Whether to scale the current saturation (`false`) or
   *     just set the new saturation (`true`). Default: `false`
   */
  saturation(value: number, absolute?: boolean): this;

  /**
   * Composites (overlays) the source onto this image at the specified
   * 0-based offset, using source-over alpha blending.
   */
  composite(source: Image, x?: number, y?: number): this;

  /** Inverts the image's colors. */
  invert(): this;

  /** Inverts the image's value (lightness). */
  invertValue(): this;

  /** Inverts the image's saturation. */
  invertSaturation(): this;

  /** Inverts the image's hue. */
  invertHue(): this;

  /** Shifts the image's hue by the given amount of degrees. */
  hueShift(degrees: number): this;

  /**
   * Gets the average color of the image, weighting each pixel by its
   * opacity. The result is opaque, black for fully transparent images.
   */
  averageColor(): number;

  /**
   * Gets the image's dominant color, fully transparent pixels are ignored.
   *
   * @param ignoreBlack Whether to ignore dark colors below the threshold.
   *     Default: `true`
   * @param ignoreWhite Whether to ignore light colors above the threshold.
   *     Default: `true`
   * @param bwThreshold The black/white threshold (`0`-`64`).
   *     Default: `0xf` (`15`)
   */
  dominantColor(ignoreBlack?: boolean, ignoreWhite?: boolean, bwThreshold?: number): number;

  /**
   * Rotates the image counterclockwise by the given amount of degrees.
   *
   * @param angle The angle to rotate the image for (in degrees)
   * @param resize Whether to resize the image so it fits all pixels (`true`) or
   *     just ignore outlying pixels (`false`). Default: `true`
   */
  rotate(angle: number, resize?: boolean): this;

  /**
   * Flips / mirrors the image horizontally or vertically.
   */
  flip(direction: "horizontal" | "vertical"): this;

  /**
   * Creates a multi-point gradient generator.
   *
   * @param colors The gradient points to use
   *     (e.g. `{0: 0xff0000ff, 1: 0x00ff00ff}`).
   * @returns The gradient generator. The function argument is the position
   *     in the gradient (`0`-`1`).
   */
  static gradient(colors: { [position: number]: number }): (position: number) => number;

  /**
   * Rounds the image's corners.
   *
   * @param radius Default: `min(width, height) / 4`
   */
  roundCorners(radius?: number): this;

  /**
   * Applies a fisheye (barrel distortion) effect.
   *
   * @param radius The distortion strength. Default: `2`
   */
  fisheye(radius?: number): this;

  /**
   * Encodes the image into a PNG.
   *
   * @param compression `0`-`9`, where `0` is no compression and `9` is highest
   *     compression. Default: `1`
   */
  encode(compression?: PNGCompressionLevel, metadata?: PNGMetadata): Promise<Uint8Array>;
  encode(metadata?: PNGMetadata): Promise<Uint8Array>;

  /**
   * Encodes the image into a baseline JPEG, alpha is ignored.
   *
   * @param quality `1`-`100`, where `1` is lowest quality (highest compression)
   *     and `100` is highest quality (lowest compression). Chroma subsampling
   *     is disabled above `90`. Default: `90`
   */
  encodeJPEG(quality?: number): Promise<Uint8Array>;

  /**
   * WebP encoding is no longer supported, this always rejects.
   * @deprecated Use {@link Image.encode} (PNG) or {@link Image.encodeJPEG} instead.
   */
  encodeWEBP(quality?: number | null): Promise<never>;

  /**
   * Decodes a PNG, JPEG or TIFF image. Use {@link GIF.decode} or the
   * top-level {@link decode} for GIFs.
   *
   * @param data The binary data to decode
   */
  static decode(data: ArrayBuffer | ArrayBufferView): Promise<Image>;

  /** Scale the SVG by the given factor. For use with {@link Image.renderSVG}. */
  static get SVG_MODE_SCALE(): 1;

  /** Scale the SVG to the given width. For use with {@link Image.renderSVG}. */
  static get SVG_MODE_WIDTH(): 2;

  /** Scale the SVG to the given height. For use with {@link Image.renderSVG}. */
  static get SVG_MODE_HEIGHT(): 3;

  /**
   * Renders an SVG. Shapes, paths, transforms, use/symbol, CSS styles,
   * gradients, strokes, clip paths, masks and opacity are supported; text,
   * images, filters and patterns are not rendered.
   *
   * @param svg The SVG source
   * @param size The scale factor, width or height depending on the mode. Default: `1`
   * @param mode Default: {@link Image.SVG_MODE_SCALE}
   */
  static renderSVG(svg: string | ArrayBuffer | ArrayBufferView, size?: number, mode?: SVGScaleMode): Promise<Image>;

  /**
   * Renders text. The image spans from the pen origin to the furthest glyph
   * edge, with one line height per line.
   *
   * @param font TrueType (ttf/ttc) or OpenType (otf) font data
   * @param scale Font size in pixels
   * @param text The text to render
   * @param color Default: `0xffffffff` (white)
   * @param layout Wrapping and alignment options
   */
  static renderText(font: ArrayBuffer | ArrayBufferView, scale: number, text: string, color?: number, layout?: TextLayout): Promise<Image>;
}

export type FrameDisposalModeName = "any" | "keep" | "previous" | "background";

export type FrameDisposalModeId = 0 | 1 | 2 | 3;

/**
 * Represents a frame in a GIF.
 */
export class Frame extends Image {
  static get DISPOSAL_KEEP(): "keep";

  static get DISPOSAL_PREVIOUS(): "previous";

  static get DISPOSAL_BACKGROUND(): "background";

  /**
   * Creates a new, blank frame.
   *
   * @param duration Milliseconds. Default: `100`
   * @param xOffset Offset on the x-axis. Default: `0`
   * @param yOffset Offset on the y-axis. Default: `0`
   * @param disposalMode The frame's disposal mode. Default: `'keep'`
   */
  constructor(
    width: number,
    height: number,
    duration?: number,
    xOffset?: number,
    yOffset?: number,
    disposalMode?: FrameDisposalModeName | FrameDisposalModeId
  );

  /** Milliseconds */
  duration: number;

  xOffset: number;

  yOffset: number;

  get disposalMode(): FrameDisposalModeId;

  set disposalMode(disposalMode: FrameDisposalModeName | FrameDisposalModeId);

  /**
   * Converts an Image instance to a Frame, cloning it in the process.
   *
   * @param duration Milliseconds. Default: `100`
   * @param xOffset Offset on the x-axis. Default: `0`
   * @param yOffset Offset on the y-axis. Default: `0`
   * @param disposalMode The frame's disposal mode. Default: `'keep'`
   */
  static from(
    image: Image,
    duration?: number,
    xOffset?: number,
    yOffset?: number,
    disposalMode?: FrameDisposalModeName | FrameDisposalModeId
  ): Frame;

  /** Clones the frame, including its duration, offsets and disposal mode. */
  clone(): Frame;

  /** Resizes the frame, scaling its offsets along with it. */
  resize(width: number, height: number, mode?: ResizeMode): this;
}

/**
 * Represents a GIF image as an array of frames.
 * Array methods like `map` and `filter` return plain arrays.
 */
export class GIF extends Array<Frame> {
  /**
   * @param loopCount How many times to repeat the GIF (`-1` = forever,
   *     `0` = play once). Default: `-1`
   */
  constructor(frames: Frame[], loopCount?: number);

  loopCount: number;

  get width(): number;

  get height(): number;

  /** The GIF's duration in milliseconds */
  get duration(): number;

  /** Returns a new GIF containing a range of frames (like `Array.prototype.slice`). */
  slice(start?: number, end?: number): GIF;

  /**
   * Encodes the GIF.
   *
   * @param quality `1`-`100`, scales the palette size from 8 colors (`1`) to
   *     256 colors (`90` and above). Default: `95`
   */
  encode(quality?: number): Promise<Uint8Array>;

  /**
   * Decodes a GIF into fully composited frames.
   *
   * @param onlyExtractFirstFrame Whether to end GIF decoding after the first
   *     frame. Default: `false`
   */
  static decode(data: ArrayBuffer | ArrayBufferView, onlyExtractFirstFrame?: boolean): Promise<GIF>;

  /**
   * Resizes the GIF, scaling every frame and its offsets proportionally.
   * Use {@link Image.RESIZE_AUTO} as either width or height to preserve the
   * aspect ratio.
   */
  resize(width: number, height: number, mode?: ResizeMode): this;
}

export type WrapStyle = "word" | "char";

export type HorizontalAlign = "left" | "center" | "right";

export type VerticalAlign = "top" | "middle" | "bottom";

export class TextLayout {
  /**
   * Layout options for {@link Image.renderText}.
   * Before 3.0 the alignment options had each other's names; values are
   * still accepted under either name.
   */
  constructor(options?: {
    /** Longer lines are wrapped. Default: `Infinity` */
    maxWidth?: number;

    /** Lines that don't fit are cut off. Default: `Infinity` */
    maxHeight?: number;

    /** Default: `'word'` */
    wrapStyle?: WrapStyle;

    /** Alignment of the lines relative to the widest line. Default: `'left'` */
    horizontalAlign?: HorizontalAlign | VerticalAlign;

    /** Which lines to keep when cutting off at `maxHeight`. Default: `'top'` */
    verticalAlign?: VerticalAlign | HorizontalAlign;

    /** Whether to break lines at newline characters. Default: `true` */
    wrapHardBreaks?: boolean;
  });

  maxWidth: number;
  maxHeight: number;
  wrapStyle: WrapStyle;
  horizontalAlign: HorizontalAlign;
  verticalAlign: VerticalAlign;
  wrapHardBreaks: boolean;
}

export type ImageTypeName = "png" | "jpeg" | "tiff" | "gif";

export class ImageType {
  static getType(data: ArrayBuffer | ArrayBufferView): ImageTypeName | null;

  static isPNG(view: DataView): boolean;

  static isJPEG(view: DataView): boolean;

  static isTIFF(view: DataView): boolean;

  static isGIF(view: DataView): boolean;
}

/**
 * Decodes any supported image, GIFs are returned as {@link GIF}.
 *
 * @param onlyExtractFirstFrame Whether to end GIF decoding after the first
 *     frame. Default: `false`
 */
export function decode(data: ArrayBuffer | ArrayBufferView, onlyExtractFirstFrame?: boolean): Promise<GIF | Image>;

export type PNGMetadata = {
  title?: string;
  author?: string;
  description?: string;
  copyright?: string;
  creationTime?: string | number | Date;
  software?: string;
  disclaimer?: string;
  warning?: string;
  source?: string;
  comment?: string;
};

/** Called with 1-based coordinates, returns a color. */
export type ColorFunction = (x: number, y: number) => number;

export type ResizeMode = "RESIZE_NEAREST_NEIGHBOR";

/**
 * - `0` = no compression
 * - `9` = highest compression
 */
export type PNGCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * {@link Image.SVG_MODE_SCALE}, {@link Image.SVG_MODE_WIDTH}, or
 * {@link Image.SVG_MODE_HEIGHT}.
 */
export type SVGScaleMode = 1 | 2 | 3;
