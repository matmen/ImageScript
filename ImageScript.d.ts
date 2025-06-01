export class Image {
  private __width__: number;
  private __height__: number;
  private __buffer__: ArrayBuffer;
  private __view__: DataView;
  private __u32__: Uint32Array;
  bitmap: Uint8ClampedArray;

  constructor(width: number, height: number);

  private toString(): `Image<${number}x${number}>`;

  get width(): number;

  get height(): number;

  *[Symbol.iterator](): void;

  *iterateWithColors(): Generator<
    [x: number, y: number, color: number],
    void,
    unknown
>;
  static rgbaToColor(r: number, g: number, b: number, a: number): number;

  static rgbToColor(r: number, g: number, b: number): number;

  static hslaToColor(h: number, s: number, l: number, a: number): number;

  static hslToColor(h: number, s: number, l: number): number;

  static rgbaToHSLA(r: number, g: number, b: number, a: number): number[];

  static colorToRGBA(color: number): number[];

  static colorToRGB(color: number): number[];

  getPixelAt(x: number, y: number): number;

  getRGBAAt(x: number, y: number): Uint8ClampedArray;

  setPixelAt(x: number, y: number, pixelColor: number): this;

  private __set_pixel__(x: number, y: number, pixelColor: number): void;

  private __check_boundaries__(x: number, y: number): void;

  private static get __out_of_bounds__(): string;

  /**
   * Fills the entire image with the supplied color.
   *
   * @param color
   */
  fill(color: number | ColorFunction): this;

  clone(): Image;

  /**
   * Use
   * {@link https://en.wikipedia.org/wiki/Image_scaling#Nearest-neighbor_interpolation Nearest-neighbor}
   * resizing.
   */
  static get RESIZE_NEAREST_NEIGHBOR(): "RESIZE_NEAREST_NEIGHBOR";

  /**
   * Used for automatically preserving an image's aspect ratio when resizing.
   */
  static get RESIZE_AUTO(): -1;

  /**
   * Resizes the image by the given factor.
   *
   * @param factor Fraction, where:
   *     - `0.5` is "50%" (half)
   *     - `1.0` is "100%" (same size)
   *     - `2.0` is "200%" (double)
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  scale(factor: number, mode?: ResizeMode): this;

  private __scale__(factor: number, mode?: ResizeMode);

  /**
   * Resizes the image to the given dimensions.
   * Use {@link Image.RESIZE_AUTO} as either width or height to automatically
   * preserve the aspect ratio.
   *
   * @param width The new width.
   * @param height The new height.
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  resize(width: number, height: number, mode?: ResizeMode): this;

  /**
   * Resizes the image so it is contained in the given bounding box.
   * Can return an image with one axis smaller than the given bounding box.
   *
   * @param width The width of the bounding box
   * @param height The height of the bounding box
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  contain(width: number, height: number, mode?: ResizeMode): this;

  /**
   * Resizes the image so it is contained in the given bounding box, placing it in the center of the given bounding box.
   * Always returns the exact dimensions of the bounding box.
   *
   * @param width The width of the bounding box
   * @param height The height of the bounding box
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  fit(width: number, height: number, mode?: ResizeMode): this;

  /**
   * Resizes the image so it covers the given bounding box, cropping the overflowing edges.
   * Always returns the exact dimensions of the bounding box.
   *
   * @param width The width of the bounding box
   * @param height The height of the bounding box
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  cover(width: number, height: number, mode?: ResizeMode): this;

  private __resize__(width: number, height: number, mode?: ResizeMode): this;

  private __resize_nearest_neighbor__(width: number, height: number): this;

  crop(x: number, y: number, width: number, height: number): this;

  private __crop__(x: number, y: number, width: number, height: number): this;

  /**
   * Draws a box at the specified coordinates.
   */
  drawBox(
    x: number,
    y: number,
    width: number,
    height: number,
    color: number | ColorFunction
  ): this;

  private __fast_box__(
    x: number,
    y: number,
    width: number,
    height: number,
    color: number
  ): this;

  /**
   * Draws a circle at the specified coordinates with the specified radius.
   */
  drawCircle(
    x: number,
    y: number,
    radius: number,
    color: number | ColorFunction
  ): this;

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
   * Set the red channel's saturation value.
   *
   * @param saturation `0`-`1`
   * @param absolute Whether to scale the current saturation (`false`) or
   *     just set the new saturation (`true`). Default: `false`
   */
  red(saturation: number, absolute?: boolean): this;

  /**
   * Set the green channel's saturation value.
   *
   * @param saturation `0`-`1`
   * @param absolute Whether to scale the current saturation (`false`) or
   *     just set the new saturation (`true`). Default: `false`
   */
  green(saturation: number, absolute?: boolean): this;

  /**
   * Set the blue channel's saturation value.
   *
   * @param saturation `0`-`1`
   * @param absolute Whether to scale the current saturation (`false`) or
   *     just set the new saturation (`true`). Default: `false`
   */
  blue(saturation: number, absolute?: boolean): this;

  private __set_channel_value__(
    value: number,
    absolute: boolean,
    offset: number
  ): void;

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
   * Composites (overlays) the {@link source} onto this image at the
   * specified coordinates.
   */
  composite(source: this, x?: number, y?: number): this;

  /**
   * Inverts the image's colors.
   */
  invert(): this;

  /**
   * Inverts the image's value (lightness).
   */
  invertValue(): this;

  /**
   * Inverts the image's saturation.
   */
  invertSaturation(): this;

  /**
   * Inverts the image's hue.
   */
  invertHue(): this;

  /**
   * Shifts the image's hue.
   */
  hueShift(degrees: number): this;

  /**
   * Gets the average color of the image.
   */
  averageColor(): number;

  /**
   * Gets the image's dominant color.
   *
   * @param ignoreBlack Whether to ignore dark colors below the threshold.
   *     Default: `true`
   * @param ignoreWhite Whether to ignore light colors above the threshold.
   *     Default: `true`
   * @param bwThreshold The black/white threshold (`0`-`64`).
   *     Default: `0xf` (`15`)
   */
  dominantColor(
    ignoreBlack?: boolean,
    ignoreWhite?: boolean,
    bwThreshold?: number
  ): number;

  /**
   * Rotates the image the given amount of degrees.
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

  private __apply__(image: this | Frame): this | Frame;

  /**
   * Creates a multi-point gradient generator.
   *
   * @param colors The gradient points to use
   *     (e.g. `{0: 0xff0000ff, 1: 0x00ff00ff}`).
   * @returns The gradient generator. The function argument is the position
   *     in the gradient (`0`-`1`).
   */
  static gradient(colors: {
    [position: number]: number;
  }): (position: number) => number;

  /**
   * Rounds the image's corners.
   *
   * @param radius Default: `min(width, height) / 4`
   */
  roundCorners(radius?: number): this;

  private static __gradient__(startColor: number, endColor: number): number;

  /**
   * @param radius Default: `2`
   */
  fisheye(radius?: number): this;

  /**
   * Encodes the image into a PNG.
   *
   * @param compression `0`-`9`, where `0` is no compression and `9` is highest
   *     compression (default: `1`)
   * @param metadata
   */
  async encode(
    compression?: PNGCompressionLevel,
    metadata?: PNGMetadata
  ): Promise<Uint8Array>;
  async encode(metadata?: PNGMetadata): Promise<Uint8Array>;

  /**
   * Encodes the image into a JPEG.
   *
   * @param quality `1`-`100`, where `1` is lowest quality (highest compression)
   *     and `100` is highest quality (lowest compression). Default: `90`
   */
  async encodeJPEG(quality?: JPEGQuality): Promise<Uint8Array>;

  /**
   * Encodes the image into a WEBP.
   *
   * @param quality `0`-`100`, or `null` for lossless. `0` is lowest quality
   *     (highest compression) and `100` is highest quality (lowest compression).
   *     Default: `null`
   */
  async encodeWEBP(quality?: null | WEBPQuality): Promise<Uint8Array>;

  /**
   * Decodes an image (PNG, JPEG or TIFF).
   *
   * @param data The binary data to decode
   * @returns The decoded image
   */
  static async decode(data: Buffer | Uint8Array): Promise<Image>;

  /**
   * Scale the SVG by the given amount. For use with {@link Image.renderSVG}.
   */
  static get SVG_MODE_SCALE(): 1;

  /**
   * Scale the SVG to fit the given width. For use with {@link Image.renderSVG}.
   */
  static get SVG_MODE_WIDTH(): 2;

  /**
   * Scale the SVG to fit the given height. For use with {@link Image.renderSVG}.
   */
  static get SVG_MODE_HEIGHT(): 3;

  /**
   * Creates a new image from the given SVG.
   *
   * @param svg
   * @param size
   * @param mode {@link Image.SVG_MODE_SCALE}, {@link Image.SVG_MODE_WIDTH}, or
   *     {@link Image.SVG_MODE_HEIGHT}.
   *
   * @returns New bitmap image with the rendered {@link svg}.
   */
  static async renderSVG(
    svg: string,
    size?: number,
    mode?: SVGScaleMode
  ): Promise<Image>;

  /**
   * Creates a new image containing the rendered text.
   *
   * @param font TrueType (ttf/ttc) or OpenType (otf) font buffer to use.
   * @param scale
   * @param text
   * @param color
   * @param layout
   *
   * @returns New image with the rendered {@link text}.
   */
  static async renderText(
    font: Uint8Array,
    scale: number,
    text: string,
    color?: number,
    layout?: TextLayout
  ): Promise<Image>;
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

  private static __convert_disposal_mode__(
    mode: FrameDisposalModeName | FrameDisposalModeId
  ): FrameDisposalModeId;

  /**
   * Creates a new, blank frame.
   *
   * @param width
   * @param height
   * @param duration Milliseconds (default: `100`)
   * @param xOffset Offset on the X-axis (default: `0`)
   * @param yOffset Offset on the y-axis (default: `0`)
   * @param disposalMode The frame's disposal mode (default: `'keep'`)
   */
  constructor(
    width: number,
    height: number,
    duration: number,
    xOffset?: number,
    yOffset?: number,
    disposalMode?: FrameDisposalModeName | FrameDisposalModeId
  );

  /**
   * Milliseconds.
   */
  duration: number;

  xOffset: number;

  yOffset: number;

  get disposalMode(): FrameDisposalModeId;

  set disposalMode(disposalMode: FrameDisposalModeName | FrameDisposalModeId);

  toString(): `Frame<${number}x${number}x${number}ms>`;

  /**
   * Converts an Image instance to a Frame, cloning it in the process
   * @param image The image to create the frame from
   * @param duration Milliseconds (default: `100`)
   * @param xOffset Offset on the X-axis (default: `0`)
   * @param yOffset Offset on the y-axis (default: `0`)
   * @param disposalMode The frame's disposal mode (default: `'keep'`)
   */
  static from(
    image: Image,
    duration?: number,
    xOffset?: number,
    yOffset?: number,
    disposalMode?: FrameDisposalModeName | FrameDisposalModeId
  ): Frame;

  /**
   * @param width
   * @param height
   * @param mode Default: {@link Frame.DISPOSAL_KEEP}
   */
  resize(
    width: number,
    height: number,
    mode?: typeof Image.RESIZE_NEAREST_NEIGHBOR | string
  ): Image;
}

/**
 * Represents a GIF image as an array of frames.
 */
export class GIF extends Array<Frame> {
  /**
   * @param frames
   * @param loopCount How many times to loop the GIF for (`-1` = unlimited).
   */
  constructor(frames: Frame[], loopCount?: number);

  get width(): number;

  get height(): number;

  toString(): `GIF<${number}x${number}x${number}ms>`;

  *[Symbol.iterator](): Generator<Frame, void, *>;

  slice(start: number, end: number): GIF;

  /**
   * Milliseconds.
   */
  get duration(): number;

  /**
   * @param quality GIF quality `0`-`100` (default: `95`)
   */
  async encode(quality?: GIFQuality): Promise<Uint8Array>;

  /**
   * @param data
   * @param onlyExtractFirstFrame Whether to end GIF decoding after the first
   *     frame (default: `false`)
   */
  static async decode(
    data: Buffer | Uint8Array,
    onlyExtractFirstFrame?: boolean
  ): Promise<GIF>;

  /**
   * @param width
   * @param height
   * @param mode Default: {@link Image.RESIZE_NEAREST_NEIGHBOR}
   */
  resize(width: number, height: number, mode?: ResizeMode): void;
}

export type WrapStyle = "word" | "char";

export type VerticalAlign = "left" | "center" | "right";

export type HorizontalAlign = "top" | "middle" | "bottom";

export class TextLayout {
  /**
   * @param options Defaults:
   * ```js
   * {
   *   maxWidth: Infinity,
   *   maxHeight: Infinity,
   *   wrapStyle: 'word',
   *   verticalAlign: 'left',
   *   horizontalAlign: 'top',
   *   wrapHardBreaks: true,
   * }
   * ```
   */
  constructor(options?: {
    /** @default Infinity */
    maxWidth?: number;

    /** @default Infinity */
    maxHeight?: number;

    /** @default 'word' */
    wrapStyle?: WrapStyle;

    /** @default 'left' */
    verticalAlign?: VerticalAlign;

    /** @default 'top' */
    horizontalAlign?: HorizontalAlign;

    /** @default true */
    wrapHardBreaks?: boolean;
  });
}

export type ImageTypeName = "png" | "jpeg" | "tiff" | "gif";

export class ImageType {
  static getType(data: Buffer | Uint8Array): ImageTypeName | null;

  static isPNG(view: DataView): boolean;

  static isJPEG(view: DataView): boolean;

  static isTIFF(view: DataView): boolean;

  static isGIF(view: DataView): boolean;
}

/**
 * @param data
 * @param onlyExtractFirstFrame Whether to end GIF decoding after the first
 *     frame (default: `false`)
 */
export function decode(
  data: Uint8Array | Buffer,
  onlyExtractFirstFrame?: boolean
): Promise<GIF | Image>;

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

export type ColorFunction = (x: number, y: number) => number;

export type ResizeMode = "RESIZE_NEAREST_NEIGHBOR" | -1;

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

/**
 * - `0` = **lowest** quality (smallest file size)
 * - `100` = **highest** quality (largest file size)
 */
export type WEBPQuality =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26
  | 27
  | 28
  | 29
  | 30
  | 31
  | 32
  | 33
  | 34
  | 35
  | 36
  | 37
  | 38
  | 39
  | 40
  | 41
  | 42
  | 43
  | 44
  | 45
  | 46
  | 47
  | 48
  | 49
  | 50
  | 51
  | 52
  | 53
  | 54
  | 55
  | 56
  | 57
  | 58
  | 59
  | 60
  | 61
  | 62
  | 63
  | 64
  | 65
  | 66
  | 67
  | 68
  | 69
  | 70
  | 71
  | 72
  | 73
  | 74
  | 75
  | 76
  | 77
  | 78
  | 79
  | 80
  | 81
  | 82
  | 83
  | 84
  | 85
  | 86
  | 87
  | 88
  | 89
  | 90
  | 91
  | 92
  | 93
  | 94
  | 95
  | 96
  | 97
  | 98
  | 99
  | 100;

/**
 * - `0` = **lowest** quality (smallest file size)
 * - `100` = **highest** quality (largest file size)
 */
export type JPEGQuality =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26
  | 27
  | 28
  | 29
  | 30
  | 31
  | 32
  | 33
  | 34
  | 35
  | 36
  | 37
  | 38
  | 39
  | 40
  | 41
  | 42
  | 43
  | 44
  | 45
  | 46
  | 47
  | 48
  | 49
  | 50
  | 51
  | 52
  | 53
  | 54
  | 55
  | 56
  | 57
  | 58
  | 59
  | 60
  | 61
  | 62
  | 63
  | 64
  | 65
  | 66
  | 67
  | 68
  | 69
  | 70
  | 71
  | 72
  | 73
  | 74
  | 75
  | 76
  | 77
  | 78
  | 79
  | 80
  | 81
  | 82
  | 83
  | 84
  | 85
  | 86
  | 87
  | 88
  | 89
  | 90
  | 91
  | 92
  | 93
  | 94
  | 95
  | 96
  | 97
  | 98
  | 99
  | 100;

/**
 * - `0` = **lowest** quality (smallest file size)
 * - `100` = **highest** quality (largest file size)
 */
export type GIFQuality =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26
  | 27
  | 28
  | 29
  | 30
  | 31
  | 32
  | 33
  | 34
  | 35
  | 36
  | 37
  | 38
  | 39
  | 40
  | 41
  | 42
  | 43
  | 44
  | 45
  | 46
  | 47
  | 48
  | 49
  | 50
  | 51
  | 52
  | 53
  | 54
  | 55
  | 56
  | 57
  | 58
  | 59
  | 60
  | 61
  | 62
  | 63
  | 64
  | 65
  | 66
  | 67
  | 68
  | 69
  | 70
  | 71
  | 72
  | 73
  | 74
  | 75
  | 76
  | 77
  | 78
  | 79
  | 80
  | 81
  | 82
  | 83
  | 84
  | 85
  | 86
  | 87
  | 88
  | 89
  | 90
  | 91
  | 92
  | 93
  | 94
  | 95
  | 96
  | 97
  | 98
  | 99
  | 100;
