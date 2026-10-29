import * as png from './codecs/png.ts';
import * as jpeg from './codecs/jpeg.ts';
import * as tiff from './codecs/tiff.ts';
import * as webp from './codecs/webp.ts';
import * as gif from './codecs/gif.ts';
import * as tga from './codecs/tga.ts';
import * as bmp from './codecs/bmp.ts';
import * as ico from './codecs/ico.ts';
import * as qoi from './codecs/qoi.ts';
import * as netpbm from './codecs/netpbm.ts';
import * as hdr from './codecs/hdr.ts';
import * as avif from './codecs/avif.ts';
import * as avifEnc from './codecs/avif-enc.ts';
import { availableThreads } from './util/threads.ts';

// (worker threads: the processors available, at most 8)
const defaultThreads = (): number => Math.max(1, Math.min(availableThreads(), 8));
const checkThreads = (threads: number): void => {
    if (!Number.isInteger(threads) || threads < 1) throw new RangeError(`threads must be a positive integer, not ${threads}`);
};
import * as jxl from './codecs/jxl.ts';
import type { ToneMapping } from './codecs/hdr.ts';
import * as quantize from './codecs/quantize.ts';
import * as textRenderer from './render/text.ts';
import * as svgRenderer from './render/svg.ts';
import { BinaryData, view } from './util/mem.ts';
import { profileTransform } from './util/icc.ts';
import { ImageType } from './image-type.ts';
import { TextLayout } from './text-layout.ts';
import { Metadata, resolveMetadata, pngText, exifData } from './metadata.ts';
import { encode as utf8 } from './util/utf8.ts';
import { resample, BOX, TRIANGLE, CUBIC } from './util/resample.ts';
import { rotateBilinear } from './util/rotate.ts';
import { gaussianBlur, boxBlurRGBA, premultiply, unpremultiply } from './util/blur.ts';
import { isOptions, finite, color as checkColor } from './util/options.ts';
import { MAX_PIXELS, decoding } from './util/limits.ts';

/** A color as a 32-bit RGBA integer (`0xRRGGBBAA`) */
export type Color = number;

/** Called with a pixel's (0-based) coordinates, returns its color */
export type ColorFunction = (x: number, y: number) => Color;

/** Resampling filters for {@link Image.resize} and the other scaling functions, see {@link Image.RESIZE_BILINEAR} etc. */
export type ResizeMode = 'RESIZE_NEAREST_NEIGHBOR' | 'RESIZE_BILINEAR' | 'RESIZE_BICUBIC' | 'RESIZE_AREA';

/** How {@link Image.renderSVG} scales: {@link Image.SVG_MODE_SCALE}, {@link Image.SVG_MODE_WIDTH} or {@link Image.SVG_MODE_HEIGHT} */
export type SVGScaleMode = 1 | 2 | 3;

/** Blend modes of {@link Image.composite}, named like CSS' mix-blend-mode values */
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
    | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'add';

/** Options of {@link Image.composite} */
export interface CompositeOptions {
    /** The x position to place the source at, if the options are the second argument. Default: `0` */
    x?: number;
    /** The y position to place the source at, if the options are the second argument. Default: `0` */
    y?: number;
    /** Opacity of the source (0..1). Default: `1` */
    opacity?: number;
    /** How the colors are mixed. Default: `'normal'` */
    mode?: BlendMode;
}

/** Options of {@link Image.scale}, {@link Image.resize}, {@link Image.contain}, {@link Image.fit} and {@link Image.cover} */
export interface ResizeOptions {
    /** The resizing mode. Default: {@link Image.RESIZE_BILINEAR} */
    mode?: ResizeMode;
    /**
     * Whether to round to 8 bits between the two passes, so two channels share the multiplications of both: about
     * 15-25% faster for opaque images, with 10-25% of the channel values a step off the precise result (instead of
     * about 1%, never more than 1). Transparent images are premultiplied to 8 bits like browsers do, which makes them
     * about twice as fast: what shows once they're composited differs by up to about 2 steps, pixels that are almost
     * transparent keep less of their color. Only affects {@link Image.RESIZE_BILINEAR} and {@link Image.RESIZE_AREA},
     * down to about a third of the size. Default: `true`
     */
    fast?: boolean;
}

/**
 * Options of {@link Image.opacity}, {@link Image.red}, {@link Image.green}, {@link Image.blue}, {@link Image.lightness}
 * and {@link Image.saturation}
 */
export interface AdjustOptions {
    /** Whether to set the value (true) or scale the current one (false). Default: `false` */
    absolute?: boolean;
}

/** Options of {@link Image.sharpen} */
export interface SharpenOptions {
    /** How strongly to sharpen (0 does nothing). Default: `1` */
    amount?: number;
    /** The radius of the blur the image is compared with (larger values sharpen coarser details). Default: `1` */
    radius?: number;
}

/** Options of {@link Image.encode} */
export interface PNGEncodeOptions {
    /** The compression level (0-9). Default: `1` */
    compression?: number;
    /** Metadata to include, see {@link Metadata} */
    metadata?: Metadata;
}

/** Options of {@link Image.encodeJPEG} */
export interface JPEGEncodeOptions {
    /** The JPEG quality (1-100), chroma subsampling is disabled above 90. Default: `90` */
    quality?: number;
    /** Metadata to include, see {@link Metadata} */
    metadata?: Metadata;
}

/** Options of {@link Image.encodeWebP} */
export interface WebPEncodeOptions {
    /**
     * Lossy compression (0-100, like libwebp's quality: 75 is its default): the image is encoded like cwebp encodes it
     * (with `-m` set to the effort), much smaller than lossless. Without it the image is encoded losslessly
     */
    quality?: number;
    /**
     * How much effort lossy compression takes (0-6, libwebp's method): higher is smaller but slower. 0-2 pick the
     * predictions by how close they are, 3 and up also by how many bits they take, 5 and 6 also optimize the
     * quantized values. Default: `2`: about a quarter of the time of 4 (cwebp's default) for files about 5% larger
     */
    effort?: number;
    /**
     * For lossy compression: convert to YUV like libwebp's sharp conversion (cwebp's `-sharp_yuv`, the same file),
     * which picks the color planes so that colored edges (red text on blue, thin colored lines) stay sharp instead of
     * bleeding. It takes about twice the time at the default effort; photos get about as large, images with many
     * hard color edges a lot larger (1200x800 red and blue squares: 2.7 times). Default: `false`
     */
    sharpYuv?: boolean;
    /**
     * For lossy compression, the alpha plane's quality (0-100, like cwebp's `-alpha_q`): below 100 its levels are
     * reduced (to 2-16 up to 70, 16-256 above), which makes it compress better; the alpha plane is lossless otherwise.
     * Default: `100`
     */
    alphaQuality?: number;
    /** Metadata to include, see {@link Metadata} */
    metadata?: Metadata;
}

/** Options of {@link Image.encodeTGA} */
export interface EncodeOptions {
    /** Metadata to include, see {@link Metadata} */
    metadata?: Metadata;
}

/** Options of {@link Image.roundCorners} */
export interface RoundCornersOptions {
    /** The radius of the corners. Default: a quarter of the smaller side */
    radius?: number;
}

/** Options of {@link Image.fisheye} */
export interface FisheyeOptions {
    /** The distortion strength (exponent of the radial mapping), higher values bulge the center more. Default: `2` */
    strength?: number;
}

/** Options of {@link Image.renderSVG} */
export interface SVGOptions {
    /** The scale, or the width or height in pixels, see `mode`. Default: `1` */
    size?: number;
    /**
     * What `size` is: one of {@link Image.SVG_MODE_SCALE}, {@link Image.SVG_MODE_WIDTH}, {@link Image.SVG_MODE_HEIGHT}.
     * Default: {@link Image.SVG_MODE_SCALE}
     */
    mode?: SVGScaleMode;
    /**
     * Fonts for `<text>` (TrueType, OpenType): each text gets the face its `font-family`, `font-weight`, `font-style`
     * and `font-stretch` match best among them, by the names, weights and styles in the fonts (like browsers match
     * installed fonts). Generic families (`serif`, `sans-serif`, `monospace`, ...) are the first font that fits them,
     * other families and text without one get the first font's family; characters a face doesn't have come from the
     * other fonts. Fonts the SVG embeds with `@font-face` (in data: URIs, also WOFF) are used too, before these for
     * their family names. Without any fonts text isn't rendered. Default: `[]`
     */
    fonts?: BinaryData[];
}

/** Options of {@link Image.renderText}: the text color and layout, and its style (see {@link TextStyle}) */
export interface TextOptions extends TextStyle {
    /** The text color. Default: `0xffffffff` */
    color?: Color;
    /** The text layout. Default: `new TextLayout()` */
    layout?: TextLayout;
}

/** Options of {@link Image.decode} */
export interface DecodeOptions {
    /** Whether to rotate/mirror JPEGs, TIFFs, PNGs and WebPs as their orientation tag (Exif or XMP) says. Default: `true` */
    applyOrientation?: boolean;
    /**
     * Whether to convert the colors of images with an embedded ICC profile (PNG, JPEG, WebP, AVIF, TIFF) to sRGB, like
     * browsers show them: wide gamut photos (Display P3 from phones, Adobe RGB, ProPhoto) look as intended instead of
     * washed out. Matrix/TRC profiles (RGB and gray) are applied, relative colorimetric (colors outside sRGB are
     * clipped); profiles with only lookup tables, CMYK ones and ones that are sRGB anyway leave the pixels as they are.
     * Default: `true`
     */
    applyColorProfile?: boolean;
    /**
     * The most pixels to decode: larger images throw a RangeError before anything that size is allocated, so small
     * files declaring huge images (decompression bombs) can't exhaust the memory. Default: `268402689` (16383², like
     * sharp), `Infinity` for no limit
     */
    maxPixels?: number;
    /**
     * How Radiance HDRs, PFMs and HDR (PQ or HLG) AVIFs and JPEG XLs, whose light can be brighter than (SDR) white,
     * become 8 bit sRGB: `'reinhard'` compresses the brightest parts like Reinhard's tone mapping operator does (the
     * brightest pixel becomes white, images no brighter than white stay as they are), `'clamp'` clamps everything
     * brighter than white. Default: `'reinhard'`
     */
    toneMapping?: ToneMapping;
}

/** Options of {@link Image.encodeJXL} */
export interface JXLEncodeOptions {
    /**
     * Lossy compression (0-100, like cjxl's `-q`: 90 is visually lossless, 100 lossless): higher is better and larger.
     * Without it the image is encoded losslessly
     */
    quality?: number;
    /**
     * How hard lossy compression searches for the best transforms: 0-2, faster to smaller. 0 uses 8x8 DCTs only (like
     * `cjxl -e 3`), 1 and 2 search their sizes like `cjxl -e 5` (2 tries more of the small ones), and 2 also stores
     * text-like features that repeat (the glyphs of screenshots) once, as patches like `cjxl -e 7`. Default: `1`
     */
    effort?: number;
    /**
     * At most this many worker threads search the transforms of lossy compression in parallel (the same file, faster),
     * `1` for none. Effort 0 (no search), small images (under about 512x512 pixels at effort 1, 384x384 at 2), and
     * runtimes whose workers can't share memory (browsers without cross-origin isolation) encode without them.
     * Default: the processors available, at most 8
     */
    threads?: number;
    /** Metadata to include, see {@link Metadata} */
    metadata?: Metadata;
}

/** Options of {@link Image.encodeAVIF} */
export interface AVIFEncodeOptions {
    /** 0-100, like avifenc's: higher is better and larger, 100 is lossless. Default: `60` */
    quality?: number;
    /** The quality of the alpha channel (if the image has transparency), like avifenc's. Default: `100` (lossless) */
    alphaQuality?: number;
    /** Chroma subsampling: `'4:4:4'` keeps the full color resolution, `'4:2:0'` halves it (smaller). Default: `'4:4:4'` */
    subsampling?: '4:4:4' | '4:2:0';
    /** How hard the encoder searches for the best modes: 0-2, faster to smaller. Default: `1` */
    effort?: number;
    /**
     * At most this many worker threads encode in parallel (the same file, faster: 2.9 times with 8 on a 1920x1080
     * photo at effort 1), `1` for none. Small images (under about 640x640 pixels at effort 0, 448x448 at 1, 320x320
     * at 2), and runtimes whose workers can't share memory (browsers without cross-origin isolation), encode without
     * them. Default: the processors available, at most 8
     */
    threads?: number;
    /** Metadata to include, see {@link Metadata} */
    metadata?: Metadata;
}

/** Text style options of {@link Image.renderText} */
export interface TextStyle {
    /** Width of an outline around the glyphs in pixels. Default: `0` */
    strokeWidth?: number;
    /** Color of the outline. Default: `0x000000ff` */
    strokeColor?: Color;
    /**
     * Whether to run the hinting instructions of TrueType fonts, which align stems and edges with the pixel grid for
     * crisper text at small sizes (like Windows renders text); the glyphs of hinted fonts are then placed on whole
     * pixels. Fonts without instructions (and CFF/OpenType outlines) aren't affected. Default: `true`
     */
    hinting?: boolean;
    /**
     * OpenType features by their tags, for the whole text: `true` turns one on (like `tnum` for tabular numbers,
     * `smcp` for small caps, `ss01` for a stylistic set), `false` off (also the ones on by default, like `liga` or
     * `kern`), a number picks an alternate (`salt: 2`). Fonts without a feature ignore it. Default: `{}`
     */
    features?: Record<string, boolean | number>;
}

/** Options of {@link Image.cropCircle} */
export interface CropCircleOptions {
    /** Whether to use the larger dimension for the size. Default: `false` */
    max?: boolean;
    /** Share of the radius (0..1) over which the edge fades out. Default: `0` */
    feathering?: number;
}

/** Options of {@link Image.dominantColor} */
export interface DominantColorOptions {
    /** Whether to ignore dark colors (all channels below the threshold). Default: `true` */
    ignoreBlack?: boolean;
    /** Whether to ignore light colors (all channels above 255 minus the threshold). Default: `true` */
    ignoreWhite?: boolean;
    /** The black/white threshold (0-64, in steps of 4 channel values). Default: `15` */
    threshold?: number;
}

/** Options of {@link Image.rotate} */
export interface RotateOptions {
    /** Whether to resize the image so it fits all pixels or just ignore outlying pixels. Default: `true` */
    resize?: boolean;
    /**
     * Whether to sample with 8-bit weights on 8-bit premultiplied pixels (like {@link ResizeOptions.fast}), about twice
     * as fast: opaque pixels stay within a step of the precise result, what shows of translucent ones (also the
     * faded edges) within about 2.5 steps (pixels that are almost transparent keep less of their color). Only affects
     * angles that aren't multiples of 90°. Default: `true`
     */
    fast?: boolean;
}

/** Options of {@link Image.trim} */
export interface TrimOptions {
    /**
     * How far (0-1) a pixel's channels may be from the color for it to be trimmed, e.g. for JPEG artifacts or
     * antialiasing. Default: `0`
     */
    tolerance?: number;
}

/** Options of {@link Image.colorToAlpha} */
export interface ColorToAlphaOptions {
    /** Pixels at most this far from the color (0-1) become fully transparent. Default: 0 */
    transparencyThreshold?: number;
    /** Pixels at least this far from the color (0-1) stay fully opaque. Default: 1 */
    opacityThreshold?: number;
}

/**
 * Text metadata written into PNGs
 * @deprecated Use {@link Metadata}, which all encoders take
 */
export type PNGMetadata = Metadata;

// OpenType features as tags and values (tags are 4 printable ASCII characters)
function featureList(features: Record<string, boolean | number>): Array<[string, number]> {
    if (typeof features !== 'object' || features === null) throw new TypeError('Features must be an object');
    return Object.entries(features).map(([tag, value]) => {
        if (!/^[\x20-\x7e]{4}$/.test(tag)) throw new RangeError(`Invalid OpenType feature tag: ${JSON.stringify(tag)}`);
        if (typeof value === 'boolean') return [tag, value ? 1 : 0];
        if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError(`Invalid value of the OpenType feature ${tag}: ${value}`);
        return [tag, value];
    });
}

/**
 * An RGBA image; provides the codecs and the manipulation functions. Methods that change the image modify it in place
 * and return it, so calls can be chained
 */
export class Image {
    /**
     * @internal
     * @ignore
     */
    protected __width__: number;
    /**
     * @internal
     * @ignore
     */
    protected __height__: number;
    /**
     * @internal
     * @ignore
     */
    protected __view__!: DataView;
    /**
     * @internal
     * @ignore
     */
    protected __u32__!: Uint32Array;
    /**
     * @internal
     * @ignore
     */
    protected __bitmap__!: Uint8ClampedArray;

    /**
     * Creates a new image with the given dimensions
     * @param width
     * @param height
     */
    constructor(width: number, height: number) {
        width = ~~width;
        height = ~~height;

        if (width < 1)
            throw new RangeError('Image has to be at least 1 pixel wide');
        if (height < 1)
            throw new RangeError('Image has to be at least 1 pixel high');

        this.__width__ = width;
        this.__height__ = height;
        this.__set_bitmap__(new Uint8ClampedArray(width * height * 4));
    }

    /**
     * The image's RGBA pixel data. It can be replaced by any 8-bit array with width * height * 4 bytes
     * (it is used as is, without copying)
     */
    get bitmap(): Uint8ClampedArray {
        return this.__bitmap__;
    }

    /** Replaces the pixel data, the array has to hold width * height * 4 bytes */
    set bitmap(bitmap: Uint8ClampedArray | Uint8Array) {
        if (!(bitmap instanceof Uint8ClampedArray || bitmap instanceof Uint8Array))
            throw new TypeError('The bitmap has to be a Uint8ClampedArray or Uint8Array');
        if (bitmap.length !== this.width * this.height * 4)
            throw new RangeError(`The bitmap has to have ${this.width * this.height * 4} bytes (width * height * 4), got ${bitmap.length}`);

        this.__set_bitmap__(bitmap instanceof Uint8ClampedArray ? bitmap : new Uint8ClampedArray(bitmap.buffer, bitmap.byteOffset, bitmap.length));
    }

    /**
     * Sets the pixel data and the views on it
     * @internal
     * @ignore
     */
    protected __set_bitmap__(bitmap: Uint8ClampedArray): void {
        // 32-bit views need an aligned offset
        if (bitmap.byteOffset % 4) bitmap = bitmap.slice();
        this.__bitmap__ = bitmap;
        this.__view__ = new DataView(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength);
        this.__u32__ = new Uint32Array(bitmap.buffer, bitmap.byteOffset, bitmap.length >> 2);
    }

    /** A short description for debugging, e.g. `Image<64x64>` */
    toString(): string {
        return `Image<${this.width}x${this.height}>`;
    }

    /**
     * The images width
     */
    get width(): number {
        return this.__width__;
    }

    /**
     * The images height
     */
    get height(): number {
        return this.__height__;
    }

    /**
     * Yields an [x, y] array for every pixel in the image (0-based)
     * @yields The coordinates of the pixel ([x, y])
     */
    *[Symbol.iterator](): Generator<[x: number, y: number], void, undefined> {
        for (let y = 0; y < this.height; y++)
            for (let x = 0; x < this.width; x++)
                yield [x, y];
    }

    /**
     * Yields an [x, y, color] array for every pixel in the image (0-based)
     * @yields The coordinates and color of the pixel ([x, y, color])
     */
    *iterateWithColors(): Generator<[x: number, y: number, color: Color], void, undefined> {
        const view = new DataView(this.bitmap.buffer, this.bitmap.byteOffset, this.bitmap.byteLength);
        let offset = 0;
        for (let y = 0; y < this.height; y++)
            for (let x = 0; x < this.width; x++, offset += 4)
                yield [x, y, view.getUint32(offset, false)];
    }

    /**
     * Converts RGBA components to an RGBA value, values are rounded and clamped to 0..255
     * @param r red (0..255)
     * @param g green (0..255)
     * @param b blue (0..255)
     * @param a alpha (0..255)
     * @returns RGBA value
     */
    static rgbaToColor(r: number, g: number, b: number, a: number): Color {
        r = finite(r, 'red');
        g = finite(g, 'green');
        b = finite(b, 'blue');
        a = finite(a, 'alpha');
        return (channel(r) << 24 | channel(g) << 16 | channel(b) << 8 | channel(a)) >>> 0;
    }

    /**
     * Converts RGB components to an RGBA value (assuming alpha = 255)
     * @param r red (0..255)
     * @param g green (0..255)
     * @param b blue (0..255)
     * @returns RGBA value
     */
    static rgbToColor(r: number, g: number, b: number): Color {
        return Image.rgbaToColor(r, g, b, 0xff);
    }

    /**
     * Converts HSLA colors to RGBA colors
     * @param h hue (0..1)
     * @param s saturation (0..1)
     * @param l lightness (0..1)
     * @param a opacity (0..1)
     * @returns color
     */
    static hslaToColor(h: number, s: number, l: number, a: number): Color {
        h = wrapHue(finite(h, 'hue'));
        s = finite(s, 'saturation');
        l = finite(l, 'lightness');
        a = finite(a, 'alpha');
        s = Math.min(1, Math.max(0, s));
        l = Math.min(1, Math.max(0, l));
        a = Math.min(1, Math.max(0, a));

        let r: number, g: number, b: number;

        if (s === 0) {
            r = g = b = l;
        } else {
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;

            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }

        return Image.rgbaToColor(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), Math.round(a * 255));
    }

    /**
     * Converts HSL colors to RGBA colors (assuming an opacity of 255)
     * @param h hue (0..1)
     * @param s saturation (0..1)
     * @param l lightness (0..1)
     * @returns color
     */
    static hslToColor(h: number, s: number, l: number): Color {
        return Image.hslaToColor(h, s, l, 1);
    }

    /**
     * Converts an RGBA value to an array of HSLA values
     * @param r {number} (0..255)
     * @param g {number} (0..255)
     * @param b {number} (0..255)
     * @param a {number} (0..255)
     * @returns The HSLA values ([H, S, L, A])
     */
    static rgbaToHSLA(r: number, g: number, b: number, a: number): [h: number, s: number, l: number, a: number] {
        r = finite(r, 'red') / 255;
        g = finite(g, 'green') / 255;
        b = finite(b, 'blue') / 255;
        a = finite(a, 'alpha');

        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s: number;
        const l = (max + min) / 2;

        if (max === min) {
            h = s = 0;
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r:
                    h = (g - b) / d + (g < b ? 6 : 0);
                    break;
                case g:
                    h = (b - r) / d + 2;
                    break;
                case b:
                    h = (r - g) / d + 4;
                    break;
            }

            h /= 6;
        }

        return [h, s, l, a / 255];
    }

    /**
     * Converts a color value to an array of RGBA values
     * @param color The color value to convert
     * @returns The RGBA values ([R, G, B, A])
     */
    static colorToRGBA(color: Color): [r: number, g: number, b: number, a: number] {
        color = checkColor(color);
        return [(color >> 24) & 0xff, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
    }

    /**
     * Converts a color value to an array of RGB values (ignoring the colors alpha)
     * @param color The color value to convert
     * @returns The RGB values ([R, G, B])
     */
    static colorToRGB(color: Color): [r: number, g: number, b: number] {
        const [r, g, b] = Image.colorToRGBA(color);
        return [r, g, b];
    }

    /**
     * Gets the pixel color at the specified position (0-based)
     * @param x
     * @param y
     * @returns The color value
     */
    getPixelAt(x: number, y: number): Color {
        x = ~~finite(x, 'x');
        y = ~~finite(y, 'y');
        this.__check_boundaries__(x, y);
        return this.__view__.getUint32((y * this.width + x) * 4, false);
    }

    /**
     * Gets a view of the RGBA components of the pixel at the specified position (0-based)
     * @param x
     * @param y
     * @returns The RGBA value
     */
    getRGBAAt(x: number, y: number): Uint8ClampedArray {
        x = ~~finite(x, 'x');
        y = ~~finite(y, 'y');
        this.__check_boundaries__(x, y);
        const idx = (y * this.width + x) * 4;
        return this.bitmap.subarray(idx, idx + 4);
    }

    /**
     * Sets the pixel color for the specified position (0-based)
     * @param x
     * @param y
     * @param pixelColor
     */
    setPixelAt(x: number, y: number, pixelColor: Color): this {
        x = ~~finite(x, 'x');
        y = ~~finite(y, 'y');
        this.__check_boundaries__(x, y);
        this.__set_pixel__(x, y, checkColor(pixelColor));
        return this;
    }

    /**
     * @private
     * @param x
     * @param y
     * @param pixelColor
     */
    /**
     * @internal
     * @ignore
     */
    protected __set_pixel__(x: number, y: number, pixelColor: Color): void {
        this.__view__.setUint32((y * this.width + x) * 4, pixelColor, false);
    }

    /**
     * @private
     * @param x
     * @param y
     */
    /**
     * @internal
     * @ignore
     */
    protected __check_boundaries__(x: number, y: number): void {
        if (isNaN(x)) throw new TypeError(`Invalid pixel coordinates (x=${x})`);
        if (isNaN(y)) throw new TypeError(`Invalid pixel coordinates (y=${y})`);
        if (x < 0)
            throw new RangeError(`${Image.__out_of_bounds__} (x=${x})<0`);
        if (x >= this.width)
            throw new RangeError(`${Image.__out_of_bounds__} (x=${x})>=(width=${this.width})`);
        if (y < 0)
            throw new RangeError(`${Image.__out_of_bounds__} (y=${y})<0`);
        if (y >= this.height)
            throw new RangeError(`${Image.__out_of_bounds__} (y=${y})>=(height=${this.height})`);
    }

    /**
     * @private
     */
    /**
     * @internal
     * @ignore
     */
    protected static get __out_of_bounds__(): string {
        return 'Tried referencing a pixel outside of the images boundaries:';
    }

    /**
     * @callback colorFunction
     * @param x 0-based x coordinate
     * @param y 0-based y coordinate
     * @returns pixel color
     */

    /**
     * Fills the image data with the supplied color
     * @param color
     */
    fill(color: Color | ColorFunction): this {
        const view = new DataView(this.bitmap.buffer, this.bitmap.byteOffset, this.bitmap.byteLength);

        if (typeof color === 'function') {
            let offset = 0;
            for (let y = 0; y < this.height; y++)
                for (let x = 0; x < this.width; x++, offset += 4)
                    view.setUint32(offset, color(x, y), false);
        } else {
            color = checkColor(color);
            if (!this.bitmap.length) return this;
            view.setUint32(0, color, false);
            const u32 = new Uint32Array(this.bitmap.buffer, this.bitmap.byteOffset, this.bitmap.byteLength / 4);
            u32.fill(u32[0]);
        }

        return this;
    }

    /**
     * Clones the current image
     */
    clone(): Image {
        // copying in the constructor of the array saves zeroing the memory first
        const image = new Image(1, 1);
        image.__width__ = this.width;
        image.__height__ = this.height;
        image.__set_bitmap__(new Uint8ClampedArray(this.bitmap));
        return image;
    }

    /**
     * Use {@link https://en.wikipedia.org/wiki/Image_scaling#Nearest-neighbor_interpolation Nearest-neighbor} resizing.
     */
    static get RESIZE_NEAREST_NEIGHBOR(): 'RESIZE_NEAREST_NEIGHBOR' {
        return 'RESIZE_NEAREST_NEIGHBOR';
    }

    /**
     * Bilinear resizing (the default). When shrinking, the filter widens with the scale factor, so every source pixel contributes
     */
    static get RESIZE_BILINEAR(): 'RESIZE_BILINEAR' {
        return 'RESIZE_BILINEAR';
    }

    /**
     * Bicubic (Catmull-Rom) resizing, sharper than bilinear, especially when enlarging
     */
    static get RESIZE_BICUBIC(): 'RESIZE_BICUBIC' {
        return 'RESIZE_BICUBIC';
    }

    /**
     * Area averaging (box filter): every output pixel is the average of the source pixels it covers. Meant for shrinking
     */
    static get RESIZE_AREA(): 'RESIZE_AREA' {
        return 'RESIZE_AREA';
    }

    /**
     * Used for automatically preserving an images aspect ratio when resizing.
     */
    static get RESIZE_AUTO(): -1 {
        return -1;
    }

    /**
     * Resizes the image by the given factor
     * @param factor The factor to resize the image with
     * @param options See {@link ResizeOptions}
     */
    scale(factor: number, options?: ResizeOptions): this;
    /**
     * Resizes the image by the given factor
     * @param factor The factor to resize the image with
     * @param [mode=Image.RESIZE_BILINEAR] The resizing mode to use
     */
    scale(factor: number, mode?: ResizeMode): this;
    scale(factor: number, modeOrOptions?: ResizeMode | ResizeOptions): this {
        const { mode, fast } = resizeOptions(modeOrOptions);
        const image = this.__scale__(factor, mode, fast);
        return this.__apply__(image);
    }

    /** @private */
    /**
     * @internal
     * @ignore
     */
    protected __scale__(factor: number, mode: ResizeMode = Image.RESIZE_BILINEAR, fast = true): Image {
        if (factor === 1) return this;
        return this.__resize__(this.width * factor, this.height * factor, mode, fast);
    }

    /**
     * Resizes the image to the given dimensions.
     * Use {@link Image.RESIZE_AUTO} as either width or height to automatically preserve the aspect ratio.
     * @param width The new width
     * @param height The new height
     * @param options See {@link ResizeOptions}
     * @returns The resized image
     */
    resize(width: number, height: number, options?: ResizeOptions): this;
    /**
     * Resizes the image to the given dimensions.
     * Use {@link Image.RESIZE_AUTO} as either width or height to automatically preserve the aspect ratio.
     * @param width The new width
     * @param height The new height
     * @param [mode=Image.RESIZE_BILINEAR] The resizing mode to use
     * @returns The resized image
     */
    resize(width: number, height: number, mode?: ResizeMode): this;
    resize(width: number, height: number, modeOrOptions?: ResizeMode | ResizeOptions): this {
        const { mode, fast } = resizeOptions(modeOrOptions);
        const image = this.__resize__(width, height, mode, fast);
        return this.__apply__(image);
    }

    /**
     * Resizes the image so it is contained in the given bounding box.
     * Can return an image with one axis smaller than the given bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param options See {@link ResizeOptions}
     * @returns The resized image
     */
    contain(width: number, height: number, options?: ResizeOptions): this;
    /**
     * Resizes the image so it is contained in the given bounding box.
     * Can return an image with one axis smaller than the given bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param [mode=Image.RESIZE_BILINEAR] The resizing mode to use
     * @returns The resized image
     */
    contain(width: number, height: number, mode?: ResizeMode): this;
    contain(width: number, height: number, modeOrOptions?: ResizeMode | ResizeOptions): this {
        const options = resizeOptions(modeOrOptions);
        width = Math.floor(finite(width, 'width'));
        height = Math.floor(finite(height, 'height'));
        // round instead of flooring the scaled size, so the limiting axis matches the box exactly
        const scale = Math.min(width / this.width, height / this.height);
        return this.resize(Math.max(1, Math.min(width, Math.round(this.width * scale))), Math.max(1, Math.min(height, Math.round(this.height * scale))), options);
    }

    /**
     * Resizes the image so it is contained in the given bounding box, placing it in the center of the given bounding box.
     * Always returns the exact dimensions of the bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param options See {@link ResizeOptions}
     * @returns The resized image
     */
    fit(width: number, height: number, options?: ResizeOptions): this;
    /**
     * Resizes the image so it is contained in the given bounding box, placing it in the center of the given bounding box.
     * Always returns the exact dimensions of the bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param [mode=Image.RESIZE_BILINEAR] The resizing mode to use
     * @returns The resized image
     */
    fit(width: number, height: number, mode?: ResizeMode): this;
    fit(width: number, height: number, modeOrOptions?: ResizeMode | ResizeOptions): this {
        const options = resizeOptions(modeOrOptions);
        const result = new Image(width, height);
        this.contain(width, height, options);
        result.composite(this, (width - this.width) / 2, (height - this.height) / 2);
        return this.__apply__(result);
    }

    /**
     * Resizes the image so it covers the given bounding box, cropping the overflowing edges.
     * Always returns the exact dimensions of the bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param options See {@link ResizeOptions}
     * @returns The resized image
     */
    cover(width: number, height: number, options?: ResizeOptions): this;
    /**
     * Resizes the image so it covers the given bounding box, cropping the overflowing edges.
     * Always returns the exact dimensions of the bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param [mode=Image.RESIZE_BILINEAR] The resizing mode to use
     * @returns The resized image
     */
    cover(width: number, height: number, mode?: ResizeMode): this;
    cover(width: number, height: number, modeOrOptions?: ResizeMode | ResizeOptions): this {
        const options = resizeOptions(modeOrOptions);
        width = Math.floor(width);
        height = Math.floor(height);
        const scale = Math.max(width / this.width, height / this.height);
        this.resize(Math.max(width, Math.round(this.width * scale)), Math.max(height, Math.round(this.height * scale)), options);
        return this.crop((this.width - width) / 2, (this.height - height) / 2, width, height);
    }

    /** @private */
    /**
     * @internal
     * @ignore
     */
    protected __resize__(width: number, height: number, mode: ResizeMode = Image.RESIZE_BILINEAR, fast = true): Image {
        if (width === Image.RESIZE_AUTO && height === Image.RESIZE_AUTO) throw new Error('RESIZE_AUTO can only be used for either width or height, not for both');
        else if (width === Image.RESIZE_AUTO) width = Math.max(1, Math.round(this.width / this.height * Math.floor(height)));
        else if (height === Image.RESIZE_AUTO) height = Math.max(1, Math.round(this.height / this.width * Math.floor(width)));

        width = Math.floor(width);
        height = Math.floor(height);
        if (width < 1)
            throw new RangeError('Image has to be at least 1 pixel wide');
        if (height < 1)
            throw new RangeError('Image has to be at least 1 pixel high');

        if (mode === Image.RESIZE_NEAREST_NEIGHBOR) return this.__resize_nearest_neighbor__(width, height);

        const filter = mode === Image.RESIZE_BILINEAR ? TRIANGLE : mode === Image.RESIZE_BICUBIC ? CUBIC : mode === Image.RESIZE_AREA ? BOX : null;
        if (!filter) throw new Error('Invalid resize mode');

        const image = new Image(width, height);
        resample(this.bitmap, this.width, this.height, width, height, filter, image.bitmap, fast);
        return image;
    }

    /**
     * @private
     * @param width The new width
     * @param height The new height
     */
    /**
     * @internal
     * @ignore
     */
    protected __resize_nearest_neighbor__(width: number, height: number): Image {
        const image = new Image(width, height);
        const src = this.__u32__;
        const dst = image.__u32__;

        // sample at the centers of the output pixels
        for (let y = 0; y < height; y++) {
            const row = this.width * ((y + 0.5) * (this.height / height) | 0);
            for (let x = 0; x < width; x++)
                dst[y * width + x] = src[row + ((x + 0.5) * (this.width / width) | 0)];
        }

        return image;
    }

    /**
     * Crops an image to the specified dimensions.
     * The region is clipped to the image, so the result can be smaller than the requested size
     * @param x The x offset (0-based)
     * @param y The y offset (0-based)
     * @param width The new images width
     * @param height The new images height
     */
    crop(x: number, y: number, width: number, height: number): this {
        return this.__apply__(this.__crop__(...this.__crop_bounds__(x, y, width, height)));
    }

    /**
     * Copies a region of the image into a new image, this one stays unchanged (like {@link Image.crop} on a clone,
     * without copying the whole image). The region is clipped to the image, so the result can be smaller than the
     * requested size
     * @param x The x offset (0-based)
     * @param y The y offset (0-based)
     * @param width The region's width
     * @param height The region's height
     */
    region(x: number, y: number, width: number, height: number): Image {
        return this.__crop__(...this.__crop_bounds__(x, y, width, height));
    }

    /**
     * A crop region clipped to the image as [x, y, width, height]
     * @internal
     * @ignore
     */
    protected __crop_bounds__(x: number, y: number, width: number, height: number): [number, number, number, number] {
        x = ~~finite(x, 'x');
        y = ~~finite(y, 'y');
        width = ~~finite(width, 'width');
        height = ~~finite(height, 'height');

        const left = Math.max(0, x), top = Math.max(0, y);
        const right = Math.min(this.width, x + width), bottom = Math.min(this.height, y + height);
        if (right <= left || bottom <= top)
            throw new RangeError('Crop region does not overlap the image');

        return [left, top, right - left, bottom - top];
    }

    /**
     * Removes borders of one color, e.g. the empty space around rendered text or around a logo on a solid background.
     * Frames keep their position: their offsets move by the trimmed amount. An image that only has the color stays
     * unchanged
     * @param color The border color, by default the color of the top left pixel. Fully transparent pixels count as the
     *     same color whatever their RGB values
     * @param options See {@link TrimOptions}
     */
    trim(color?: Color, options: TrimOptions = {}): this {
        const bounds = this.__trim_bounds__(color, options);
        return bounds ? this.__apply__(this.__crop__(...bounds)) : this;
    }

    /**
     * The area that remains after trimming as [x, y, width, height], null if nothing would remain
     * @internal
     * @ignore
     */
    protected __trim_bounds__(color: Color | undefined, { tolerance = 0 }: TrimOptions): [number, number, number, number] | null {
        if (!(tolerance >= 0 && tolerance <= 1)) throw new RangeError('Invalid tolerance, it has to be between 0 and 1');

        const bitmap = this.bitmap;
        const { width, height } = this;
        if (color !== undefined) color = checkColor(color);
        const c = color === undefined ? [bitmap[0], bitmap[1], bitmap[2], bitmap[3]] : [color >>> 24, color >> 16 & 255, color >> 8 & 255, color & 255];
        const limit = tolerance * 255;
        const matches = (x: number, y: number): boolean => {
            const i = (y * width + x) * 4;
            if (Math.abs(bitmap[i + 3] - c[3]) > limit) return false;
            // transparent pixels have no color
            if (bitmap[i + 3] === 0 && c[3] === 0) return true;
            return Math.abs(bitmap[i] - c[0]) <= limit && Math.abs(bitmap[i + 1] - c[1]) <= limit && Math.abs(bitmap[i + 2] - c[2]) <= limit;
        };
        const rowMatches = (y: number): boolean => {
            for (let x = 0; x < width; x++) if (!matches(x, y)) return false;
            return true;
        };
        const columnMatches = (x: number, top: number, bottom: number): boolean => {
            for (let y = top; y < bottom; y++) if (!matches(x, y)) return false;
            return true;
        };

        let top = 0, bottom = height;
        while (top < height && rowMatches(top)) top++;
        if (top === height) return null;
        while (rowMatches(bottom - 1)) bottom--;
        let left = 0, right = width;
        while (columnMatches(left, top, bottom)) left++;
        while (columnMatches(right - 1, top, bottom)) right--;
        return [left, top, right - left, bottom - top];
    }

    /**
     * @param x
     * @param y
     * @param width
     * @param height
     * @private
     */
    /**
     * @internal
     * @ignore
     */
    protected __crop__(x: number, y: number, width: number, height: number): Image {
        x = ~~x;
        y = ~~y;

        const image = new Image(width, height);

        for (let tY = 0; tY < height; tY++) {
            const idx = (tY + y) * this.width + x;
            image.__u32__.set(this.__u32__.subarray(idx, idx + width), tY * width);
        }

        return image;
    }

    /**
     * Draws a box at the specified coordinates (0-based), clipped to the image
     * @param x The x offset
     * @param y The y offset
     * @param width The box width
     * @param height The box height
     * @param color The color to fill the box in with, a function gets coordinates relative to the box
     */
    drawBox(x: number, y: number, width: number, height: number, color: Color | ColorFunction): this {
        x = ~~finite(x, 'x');
        y = ~~finite(y, 'y');
        width = ~~finite(width, 'width');
        height = ~~finite(height, 'height');

        if (typeof color !== 'function') return this.__fast_box__(x, y, width, height, checkColor(color));

        for (let tY = Math.max(0, -y); tY < height && tY + y < this.height; tY++)
            for (let tX = Math.max(0, -x); tX < width && tX + x < this.width; tX++)
                this.__set_pixel__(tX + x, tY + y, color(tX, tY));

        return this;
    }

    /**
     * @private
     * @param x
     * @param y
     * @param width
     * @param height
     * @param color
     */
    /**
     * @internal
     * @ignore
     */
    protected __fast_box__(x: number, y: number, width: number, height: number, color: Color): this {
        const left = Math.max(0, x), top = Math.max(0, y);
        const right = Math.min(this.width, x + width), bottom = Math.min(this.height, y + height);
        if (right <= left || bottom <= top) return this;

        // fill the first row, then copy it to the others
        for (let xPos = left; xPos < right; xPos++)
            this.__view__.setUint32(4 * (xPos + top * this.width), color);

        const start = 4 * (left + top * this.width);
        const end = 4 * (right + top * this.width);
        for (let row = top + 1; row < bottom; row++)
            this.bitmap.copyWithin(4 * (left + row * this.width), start, end);

        return this;
    }

    /**
     * Draws an antialiased circle around the center of the specified pixel (0-based)
     * @param x The center x position
     * @param y The center y position
     * @param radius The circles radius in pixels
     * @param color The color, a function gets coordinates relative to the circle's bounding box
     */
    drawCircle(x: number, y: number, radius: number, color: Color | ColorFunction): this {
        x = ~~finite(x, 'x');
        y = ~~finite(y, 'y');
        radius = finite(radius, 'radius');
        if (typeof color !== 'function') color = checkColor(color);
        // the circle is centered on the pixel's center, its edge is antialiased
        const cx = x + 0.5, cy = y + 0.5;

        for (let py = Math.max(0, Math.floor(cy - radius)); py < Math.min(this.height, Math.ceil(cy + radius)); py++) {
            for (let px = Math.max(0, Math.floor(cx - radius)); px < Math.min(this.width, Math.ceil(cx + radius)); px++) {
                const coverage = circleCoverage(px, py, cx, cy, radius);
                if (coverage <= 0) continue;

                const value = typeof color === 'function' ? color(px - x + radius, py - y + radius) : color;
                if (coverage >= 1) this.__set_pixel__(px, py, value);
                else this.__blend_pixel__(px, py, value, coverage);
            }
        }

        return this;
    }

    /**
     * Moves a pixel towards a color by the given amount (with premultiplied alpha)
     * @internal
     * @ignore
     */
    protected __blend_pixel__(x: number, y: number, color: Color, amount: number): void {
        const i = (y * this.width + x) * 4, b = this.bitmap;
        const sa = (color & 0xff) / 255 * amount, da = b[i + 3] / 255 * (1 - amount);
        const a = sa + da;
        if (a <= 0) {
            b[i] = b[i + 1] = b[i + 2] = b[i + 3] = 0;
            return;
        }

        b[i] = ((color >>> 24) * sa + b[i] * da) / a;
        b[i + 1] = ((color >> 16 & 0xff) * sa + b[i + 1] * da) / a;
        b[i + 2] = ((color >> 8 & 0xff) * sa + b[i + 2] * da) / a;
        b[i + 3] = a * 255;
    }

    /**
     * Crops the image into a circle with an antialiased edge
     * @param options See {@link CropCircleOptions}
     */
    cropCircle(options?: CropCircleOptions): this;
    /**
     * Crops the image into a circle with an antialiased edge
     * @param max Whether to use the larger dimension for the size. Default: `false`
     * @param feathering Share of the radius (0..1) over which the edge fades out. Default: `0`
     */
    cropCircle(max?: boolean, feathering?: number): this;
    cropCircle(maxOrOptions: boolean | CropCircleOptions = false, featheringArgument = 0): this {
        const { max = false, feathering = 0 } = typeof maxOrOptions === 'object' && maxOrOptions !== null
            ? maxOrOptions : { max: maxOrOptions, feathering: featheringArgument };
        finite(feathering, 'feathering');
        const radius = (max ? Math.max : Math.min)(this.width, this.height) / 2;
        const cx = this.width / 2, cy = this.height / 2;
        // width of the soft edge, at least the one pixel of antialiasing
        const band = Math.min(1, Math.max(0, feathering)) * radius;

        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const alpha = 4 * (y * this.width + x) + 3;
                const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
                // pixels well inside keep their alpha
                if (dx * dx + dy * dy <= (radius - Math.max(band, 1)) ** 2) continue;

                const factor = band > 1
                    ? Math.min(1, Math.max(0, (radius - Math.hypot(dx, dy)) / band))
                    : circleCoverage(x, y, cx, cy, radius);
                if (factor < 1) this.bitmap[alpha] *= factor;
            }
        }

        return this;
    }

    /**
     * Sets the images opacity
     * @param opacity The opacity to apply (0..1)
     * @param options See {@link AdjustOptions}
     */
    opacity(opacity: number, options?: AdjustOptions): this;
    /**
     * Sets the images opacity
     * @param opacity The opacity to apply (0..1)
     * @param absolute Whether to scale the current opacity (false) or just set the new opacity (true)
     */
    opacity(opacity: number, absolute?: boolean): this;
    opacity(opacity: number, absoluteOrOptions: boolean | AdjustOptions = false): this {
        const absolute = isOptions(absoluteOrOptions) ? absoluteOrOptions.absolute ?? false : absoluteOrOptions;
        opacity = finite(opacity, 'opacity value');
        if (opacity < 0)
            throw new RangeError('Invalid opacity value');

        this.__set_channel_value__(opacity, absolute, 3);

        return this;
    }

    /**
     * Scales or sets the red channel
     * @param factor The factor to multiply the channel with (>= 0, results are clamped), or the value (0..1) to set it to
     * @param options See {@link AdjustOptions}
     */
    red(factor: number, options?: AdjustOptions): this;
    /**
     * Scales or sets the red channel
     * @param factor The factor to multiply the channel with (>= 0, results are clamped), or the value (0..1) to set it to
     * @param absolute Whether to scale the current value (false) or set every pixel's red channel to `factor` * 255 (true)
     */
    red(factor: number, absolute?: boolean): this;
    red(factor: number, absoluteOrOptions: boolean | AdjustOptions = false): this {
        const absolute = isOptions(absoluteOrOptions) ? absoluteOrOptions.absolute ?? false : absoluteOrOptions;
        factor = finite(factor, 'red factor');
        if (factor < 0)
            throw new RangeError('Invalid red factor');

        this.__set_channel_value__(factor, absolute, 0);

        return this;
    }

    /**
     * Scales or sets the green channel
     * @param factor The factor to multiply the channel with (>= 0, results are clamped), or the value (0..1) to set it to
     * @param options See {@link AdjustOptions}
     */
    green(factor: number, options?: AdjustOptions): this;
    /**
     * Scales or sets the green channel
     * @param factor The factor to multiply the channel with (>= 0, results are clamped), or the value (0..1) to set it to
     * @param absolute Whether to scale the current value (false) or set every pixel's green channel to `factor` * 255 (true)
     */
    green(factor: number, absolute?: boolean): this;
    green(factor: number, absoluteOrOptions: boolean | AdjustOptions = false): this {
        const absolute = isOptions(absoluteOrOptions) ? absoluteOrOptions.absolute ?? false : absoluteOrOptions;
        factor = finite(factor, 'green factor');
        if (factor < 0)
            throw new RangeError('Invalid green factor');

        this.__set_channel_value__(factor, absolute, 1);

        return this;
    }

    /**
     * Scales or sets the blue channel
     * @param factor The factor to multiply the channel with (>= 0, results are clamped), or the value (0..1) to set it to
     * @param options See {@link AdjustOptions}
     */
    blue(factor: number, options?: AdjustOptions): this;
    /**
     * Scales or sets the blue channel
     * @param factor The factor to multiply the channel with (>= 0, results are clamped), or the value (0..1) to set it to
     * @param absolute Whether to scale the current value (false) or set every pixel's blue channel to `factor` * 255 (true)
     */
    blue(factor: number, absolute?: boolean): this;
    blue(factor: number, absoluteOrOptions: boolean | AdjustOptions = false): this {
        const absolute = isOptions(absoluteOrOptions) ? absoluteOrOptions.absolute ?? false : absoluteOrOptions;
        factor = finite(factor, 'blue factor');
        if (factor < 0)
            throw new RangeError('Invalid blue factor');

        this.__set_channel_value__(factor, absolute, 2);

        return this;
    }

    /**
     * @private
     * @param value
     * @param absolute
     * @param offset
     */
    /**
     * @internal
     * @ignore
     */
    protected __set_channel_value__(value: number, absolute: boolean, offset: number): void {
        for (let i = offset; i < this.bitmap.length; i += 4)
            this.bitmap[i] = value * (absolute ? 255 : this.bitmap[i]);
    }

    /**
     * Sets the brightness of the image
     * @param value The lightness to apply (0..1)
     * @param options See {@link AdjustOptions}
     */
    lightness(value: number, options?: AdjustOptions): this;
    /**
     * Sets the brightness of the image
     * @param value The lightness to apply (0..1)
     * @param absolute Whether to scale the current lightness (false) or just set the new lightness (true)
     */
    lightness(value: number, absolute?: boolean): this;
    lightness(value: number, absoluteOrOptions: boolean | AdjustOptions = false): this {
        const absolute = isOptions(absoluteOrOptions) ? absoluteOrOptions.absolute ?? false : absoluteOrOptions;
        value = finite(value, 'lightness value');
        if (value < 0)
            throw new RangeError('Invalid lightness value');

        return this.__map_hsla__(c => { c.l = value * (absolute ? 1 : c.l); });
    }

    /**
     * Sets the saturation of the image
     * @param value The saturation to apply (0..1)
     * @param options See {@link AdjustOptions}
     */
    saturation(value: number, options?: AdjustOptions): this;
    /**
     * Sets the saturation of the image
     * @param value The saturation to apply (0..1)
     * @param absolute Whether to scale the current saturation (false) or just set the new saturation (true)
     */
    saturation(value: number, absolute?: boolean): this;
    saturation(value: number, absoluteOrOptions: boolean | AdjustOptions = false): this {
        const absolute = isOptions(absoluteOrOptions) ? absoluteOrOptions.absolute ?? false : absoluteOrOptions;
        value = finite(value, 'saturation value');
        if (value < 0)
            throw new RangeError('Invalid saturation value');

        return this.__map_hsla__(c => { c.s = value * (absolute ? 1 : c.s); });
    }

    /**
     * Composites (overlays) the source onto this image
     * @param source The image to place
     * @param options Position, opacity and blend mode, see {@link CompositeOptions}
     */
    composite(source: Image, options?: CompositeOptions): this;
    /**
     * Composites (overlays) the source onto this image at the specified coordinates
     * @param source The image to place
     * @param [x=0] The x position to place the image at
     * @param [y=0] The y position to place the image at
     * @param options Opacity and blend mode, see {@link CompositeOptions}
     */
    composite(source: Image, x?: number, y?: number, options?: CompositeOptions): this;
    composite(source: Image, xOrOptions: number | CompositeOptions = 0, yArgument = 0, optionsArgument: CompositeOptions = {}): this {
        const options = isOptions(xOrOptions) ? xOrOptions : optionsArgument;
        const { opacity = 1, mode = 'normal' } = options;
        let x = isOptions(xOrOptions) ? xOrOptions.x ?? 0 : xOrOptions, y = isOptions(xOrOptions) ? xOrOptions.y ?? 0 : yArgument;
        x = finite(x, 'x') | 0;
        y = finite(y, 'y') | 0;

        if (isNaN(opacity) || opacity < 0 || opacity > 1)
            throw new RangeError('Invalid composite opacity');
        const blend = BLEND_MODES[mode];
        if (!blend || !Object.prototype.hasOwnProperty.call(BLEND_MODES, mode))
            throw new RangeError(`Invalid blend mode: ${mode}`);
        if (mode !== 'normal') return this.__blend__(source, x, y, opacity, blend);
        if (opacity === 0) return this;

        const left = Math.max(0, x), top = Math.max(0, y);
        const right = Math.min(this.width, x + source.width), bottom = Math.min(this.height, y + source.height);
        const dst = this.bitmap, src = source.bitmap;

        for (let row = top; row < bottom; row++) {
            for (let column = left, s = 4 * ((row - y) * source.width + left - x), d = 4 * (row * this.width + left); column < right; column++, s += 4, d += 4) {
                const sa = src[s + 3];
                if (sa === 0) continue;

                const da = dst[d + 3];
                if ((sa === 255 && opacity === 1) || da === 0) {
                    dst[d] = src[s];
                    dst[d + 1] = src[s + 1];
                    dst[d + 2] = src[s + 2];
                    dst[d + 3] = sa * opacity;
                    continue;
                }

                // source over with straight alpha (the source's scaled by the opacity), the clamped bitmap rounds on
                // assignment
                const fa = sa / 255 * opacity, ba = da / 255 * (1 - fa);
                const a = fa + ba;
                dst[d] = (src[s] * fa + dst[d] * ba) / a;
                dst[d + 1] = (src[s + 1] * fa + dst[d + 1] * ba) / a;
                dst[d + 2] = (src[s + 2] * fa + dst[d + 2] * ba) / a;
                dst[d + 3] = a * 255;
            }
        }

        return this;
    }

    /**
     * Composites with opacity and a blend mode (the W3C compositing model: the blended color is drawn source-over)
     * @internal
     * @ignore
     */
    protected __blend__(source: Image, x: number, y: number, opacity: number, blend: (backdrop: number, source: number) => number): this {
        const left = Math.max(0, x), top = Math.max(0, y);
        const right = Math.min(this.width, x + source.width), bottom = Math.min(this.height, y + source.height);
        const dst = this.bitmap, src = source.bitmap;

        for (let row = top; row < bottom; row++) {
            for (let column = left; column < right; column++) {
                const s = 4 * ((row - y) * source.width + column - x);
                const as = src[s + 3] / 255 * opacity;
                if (as <= 0) continue;

                const d = 4 * (row * this.width + column);
                const ab = dst[d + 3] / 255;
                const ao = as + ab * (1 - as);

                for (let c = 0; c < 3; c++) {
                    const cs = src[s + c] / 255, cb = dst[d + c] / 255;
                    // where the backdrop is transparent the source color is used unblended
                    const cr = (1 - ab) * cs + ab * blend(cb, cs);
                    // the clamped bitmap rounds on assignment
                    dst[d + c] = (as * cr + ab * (1 - as) * cb) / ao * 255;
                }
                dst[d + 3] = ao * 255;
            }
        }

        return this;
    }

    /**
     * Inverts the images colors
     */
    invert(): this {
        const bitmap = this.bitmap;
        for (let i = 0; i < bitmap.length; i += 4) {
            bitmap[i] = 255 - bitmap[i];
            bitmap[i + 1] = 255 - bitmap[i + 1];
            bitmap[i + 2] = 255 - bitmap[i + 2];
        }

        return this;
    }

    /**
     * Inverts the images lightness (HSL), keeping hue and saturation: dark colors become light and vice versa
     */
    invertLightness(): this {
        return this.__map_hsla__(c => { c.l = 1 - c.l; });
    }

    /**
     * Inverts the images value (HSV), keeping hue and saturation: the brightest channel `v` becomes `255 - v`
     * and the others scale along, black becomes white
     */
    invertValue(): this {
        const bitmap = this.bitmap;
        for (let i = 0; i < bitmap.length; i += 4) {
            const max = Math.max(bitmap[i], bitmap[i + 1], bitmap[i + 2]);
            if (max === 0) {
                bitmap[i] = bitmap[i + 1] = bitmap[i + 2] = 255;
                continue;
            }

            // the clamped bitmap rounds on assignment
            const factor = (255 - max) / max;
            bitmap[i] *= factor;
            bitmap[i + 1] *= factor;
            bitmap[i + 2] *= factor;
        }

        return this;
    }

    /**
     * Shifts the images hue
     * @param degrees How many degrees to shift the hue by
     */
    hueShift(degrees: number): this {
        degrees = finite(degrees, 'hue shift');
        return this.__map_hsla__(c => { c.h += degrees / 360; });
    }

    /**
     * Converts every pixel to HSLA, lets `map` adjust the components in place and converts back
     * (the same math as {@link Image.rgbaToHSLA} and {@link Image.hslaToColor}, without allocating per pixel)
     * @internal
     * @ignore
     */
    protected __map_hsla__(map: (hsla: HSLA) => void): this {
        const bitmap = this.bitmap;
        const hsla: HSLA = { h: 0, s: 0, l: 0, a: 0 };
        const pixels = new Uint32Array(bitmap.buffer, bitmap.byteOffset, bitmap.length >> 2);

        // results of recently seen colors (direct mapped by a hash of the color), images often repeat colors
        const keys = new Uint32Array(4096), values = new Uint32Array(4096);
        keys[0] = 1; // so the empty slot 0 can't match the color 0

        for (let i = 0; i < bitmap.length; i += 4) {
            const color = pixels[i >> 2];
            const slot = Math.imul(color, 0x9e3779b1) >>> 20;
            if (keys[slot] === color) {
                pixels[i >> 2] = values[slot];
                continue;
            }

            const r = bitmap[i] / 255, g = bitmap[i + 1] / 255, b = bitmap[i + 2] / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const l = (max + min) / 2;
            let h = 0, s = 0;

            if (max !== min) {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
                else if (max === g) h = (b - r) / d + 2;
                else h = (r - g) / d + 4;
                h /= 6;
            }

            hsla.h = h;
            hsla.s = s;
            hsla.l = l;
            hsla.a = bitmap[i + 3] / 255;
            map(hsla);

            // see hslaToColor
            const nh = wrapHue(hsla.h);
            const ns = Math.min(1, Math.max(0, hsla.s));
            const nl = Math.min(1, Math.max(0, hsla.l));
            const na = Math.min(1, Math.max(0, hsla.a));

            if (ns === 0) bitmap[i] = bitmap[i + 1] = bitmap[i + 2] = Math.round(nl * 255);
            else {
                const q = nl < 0.5 ? nl * (1 + ns) : nl + ns - nl * ns;
                const p = 2 * nl - q;
                bitmap[i] = Math.round(hue2rgb(p, q, nh + 1 / 3) * 255);
                bitmap[i + 1] = Math.round(hue2rgb(p, q, nh) * 255);
                bitmap[i + 2] = Math.round(hue2rgb(p, q, nh - 1 / 3) * 255);
            }
            bitmap[i + 3] = Math.round(na * 255);

            keys[slot] = color;
            values[slot] = pixels[i >> 2];
        }

        return this;
    }

    /**
     * Blurs the image with a gaussian blur (transparent pixels don't bleed their color)
     * @param radius The blur radius: the gaussian's standard deviation in pixels, like CSS' blur()
     */
    blur(radius: number): this {
        if (!Number.isFinite(radius) || radius < 0)
            throw new RangeError('Invalid blur radius');

        if (boxBlurRGBA(this.bitmap, this.width, this.height, radius)) return this;
        const pixels = premultiply(this.bitmap);
        gaussianBlur(pixels, this.width, this.height, radius);
        unpremultiply(pixels, this.bitmap);
        return this;
    }

    /**
     * Sharpens the image with an unsharp mask: the difference to a blurred copy is amplified
     * @param options See {@link SharpenOptions}
     */
    sharpen(options?: SharpenOptions): this;
    /**
     * Sharpens the image with an unsharp mask: the difference to a blurred copy is amplified
     * @param [amount=1] How strongly to sharpen (0 does nothing)
     * @param [radius=1] The radius of the blur the image is compared with (larger values sharpen coarser details)
     */
    sharpen(amount?: number, radius?: number): this;
    sharpen(amountOrOptions: number | SharpenOptions = 1, radiusArgument = 1): this {
        const { amount = 1, radius = 1 } = isOptions(amountOrOptions) ? amountOrOptions : { amount: amountOrOptions, radius: radiusArgument };
        if (!Number.isFinite(amount) || amount < 0)
            throw new RangeError('Invalid sharpen amount');
        if (!Number.isFinite(radius) || radius <= 0)
            throw new RangeError('Invalid sharpen radius');

        const blurred = premultiply(this.bitmap);
        gaussianBlur(blurred, this.width, this.height, radius);

        const bitmap = this.bitmap;
        for (let i = 0; i < bitmap.length; i += 4) {
            const a = blurred[i + 3];
            if (a < 0.5 || bitmap[i + 3] === 0) continue;

            // the clamped bitmap rounds and clamps
            const f = 255 / a;
            bitmap[i] += amount * (bitmap[i] - blurred[i] * f);
            bitmap[i + 1] += amount * (bitmap[i + 1] - blurred[i + 1] * f);
            bitmap[i + 2] += amount * (bitmap[i + 2] - blurred[i + 2] * f);
        }

        return this;
    }

    /**
     * Multiplies the color channels, e.g. 1.2 makes the image 20% brighter
     * @param factor The factor (>= 0, 1 keeps the image)
     */
    brightness(factor: number): this {
        factor = finite(factor, 'brightness factor');
        if (factor < 0)
            throw new RangeError('Invalid brightness factor');
        return this.__map_channels__(v => v * factor);
    }

    /**
     * Scales the color channels' distance from mid grey, e.g. 1.5 increases the contrast, 0.5 reduces it
     * @param factor The factor (>= 0, 1 keeps the image, 0 makes it grey)
     */
    contrast(factor: number): this {
        factor = finite(factor, 'contrast factor');
        if (factor < 0)
            throw new RangeError('Invalid contrast factor');
        return this.__map_channels__(v => (v - 127.5) * factor + 127.5);
    }

    /**
     * Applies a gamma correction, values above 1 brighten the dark tones, values below 1 darken them
     * @param gamma The gamma (> 0, 1 keeps the image)
     */
    gamma(gamma: number): this {
        gamma = finite(gamma, 'gamma');
        if (gamma <= 0)
            throw new RangeError('Invalid gamma');
        return this.__map_channels__(v => 255 * (v / 255) ** (1 / gamma));
    }

    /**
     * Converts the image to greyscale by its luma (ITU-R 601, like Pillow), keeping the alpha
     */
    greyscale(): this {
        const bitmap = this.bitmap;
        for (let i = 0; i < bitmap.length; i += 4)
            bitmap[i] = bitmap[i + 1] = bitmap[i + 2] = bitmap[i] * 19595 + bitmap[i + 1] * 38470 + bitmap[i + 2] * 7471 + 0x8000 >> 16;
        return this;
    }

    /**
     * Applies a sepia tone
     */
    sepia(): this {
        const bitmap = this.bitmap;
        for (let i = 0; i < bitmap.length; i += 4) {
            const r = bitmap[i], g = bitmap[i + 1], b = bitmap[i + 2];
            bitmap[i] = 0.393 * r + 0.769 * g + 0.189 * b;
            bitmap[i + 1] = 0.349 * r + 0.686 * g + 0.168 * b;
            bitmap[i + 2] = 0.272 * r + 0.534 * g + 0.131 * b;
        }
        return this;
    }

    /**
     * Makes a color transparent, like GIMP's "Color to Alpha": the color is removed from every pixel and replaced by
     * transparency, so pixels that are partly the color (e.g. antialiased edges against a background) become
     * semi-transparent instead of keeping a fringe of it.
     * The color is removed everywhere in the image, not only from a connected background: removing a white
     * background also makes white areas inside the subject (e.g. eyes in a logo) transparent
     * @param color The color to remove, by default the color of the top left pixel (e.g. a background)
     * @param options See {@link ColorToAlphaOptions}
     */
    colorToAlpha(color?: Color, options: ColorToAlphaOptions = {}): this {
        const { transparencyThreshold = 0, opacityThreshold = 1 } = options;
        if (!(transparencyThreshold >= 0 && opacityThreshold <= 1 && transparencyThreshold < opacityThreshold))
            throw new RangeError('Invalid thresholds, they have to satisfy 0 <= transparencyThreshold < opacityThreshold <= 1');

        const bitmap = this.bitmap;
        if (color !== undefined) color = checkColor(color);
        const c = color === undefined ? [bitmap[0], bitmap[1], bitmap[2]] : [color >>> 24, color >> 16 & 255, color >> 8 & 255];

        for (let i = 0; i < bitmap.length; i += 4) {
            // how far the pixel is from the color: the alpha it needs to be "pixel = alpha * X + (1 - alpha) * color"
            let distance = 0;
            for (let k = 0; k < 3; k++) {
                const d = bitmap[i + k] - c[k];
                const a = d > 0 ? d / (255 - c[k]) : d < 0 ? -d / c[k] : 0;
                if (a > distance) distance = a;
            }

            const alpha = distance <= transparencyThreshold ? 0 : distance >= opacityThreshold ? 1
                : (distance - transparencyThreshold) / (opacityThreshold - transparencyThreshold);

            // unmix the color, so it looks the same over the removed color
            if (alpha > 0) for (let k = 0; k < 3; k++) bitmap[i + k] = Math.round((bitmap[i + k] - c[k]) / alpha + c[k]);
            bitmap[i + 3] = Math.round(bitmap[i + 3] * alpha);
        }

        return this;
    }

    /**
     * Maps every color channel value through a function (evaluated once per value 0..255), alpha is kept
     * @internal
     * @ignore
     */
    protected __map_channels__(map: (value: number) => number): this {
        const lut = new Uint8ClampedArray(256);
        for (let v = 0; v < 256; v++) lut[v] = map(v);

        const bitmap = this.bitmap;
        for (let i = 0; i < bitmap.length; i += 4) {
            bitmap[i] = lut[bitmap[i]];
            bitmap[i + 1] = lut[bitmap[i + 1]];
            bitmap[i + 2] = lut[bitmap[i + 2]];
        }

        return this;
    }

    /**
     * Gets the average color of the image, weighting each pixel by its opacity
     * @returns The average color (fully opaque), black for fully transparent images
     */
    averageColor(): Color {
        let r = 0, g = 0, b = 0, weight = 0;
        for (let i = 0; i < this.bitmap.length; i += 4) {
            const a = this.bitmap[i + 3];
            r += this.bitmap[i] * a;
            g += this.bitmap[i + 1] * a;
            b += this.bitmap[i + 2] * a;
            weight += a;
        }

        if (!weight) return Image.rgbaToColor(0, 0, 0, 0xff);
        return Image.rgbaToColor(Math.round(r / weight), Math.round(g / weight), Math.round(b / weight), 0xff);
    }

    /**
     * Gets the image's dominant color: the colors are grouped into a few clusters (median cut and k-means),
     * the average color of the largest one is returned
     * @param options Which colors to ignore, see {@link DominantColorOptions}
     * @return The image's dominant color (fully opaque); mostly transparent pixels are ignored.
     *     If every pixel is ignored as black or white, the filter is dropped
     */
    dominantColor(options?: DominantColorOptions): Color;
    /**
     * Gets the image's dominant color, see {@link Image.dominantColor | the variant with options}
     * @param ignoreBlack Whether to ignore dark colors (all channels below the threshold). Default: `true`
     * @param ignoreWhite Whether to ignore light colors (all channels above 255 minus the threshold). Default: `true`
     * @param bwThreshold The black/white threshold (0-64, in steps of 4 channel values). Default: `15`
     * @return The image's dominant color (fully opaque)
     */
    dominantColor(ignoreBlack?: boolean, ignoreWhite?: boolean, bwThreshold?: number): Color;
    dominantColor(ignoreBlackOrOptions: boolean | DominantColorOptions = true, ignoreWhiteArgument = true, thresholdArgument = 0xf): Color {
        const { ignoreBlack = true, ignoreWhite = true, threshold: bwThreshold = 0xf } = typeof ignoreBlackOrOptions === 'object' && ignoreBlackOrOptions !== null
            ? ignoreBlackOrOptions : { ignoreBlack: ignoreBlackOrOptions, ignoreWhite: ignoreWhiteArgument, threshold: thresholdArgument };
        const threshold = Math.min(64, Math.max(0, bwThreshold)) * 4;
        const pixels = this.__bytes__();

        const color = quantize.dominantColor(pixels, (r, g, b) =>
            !(ignoreBlack && Math.max(r, g, b) < threshold) && !(ignoreWhite && Math.min(r, g, b) > 255 - threshold))
            || quantize.dominantColor(pixels, () => true);

        return color ? Image.rgbToColor(...color) : Image.rgbaToColor(0, 0, 0, 0xff);
    }

    /**
     * Rotates the image counterclockwise by the given amount of degrees
     * @param angle The angle to rotate the image for (in degrees)
     * @param options See {@link RotateOptions}
     */
    rotate(angle: number, options?: RotateOptions): this;
    /**
     * Rotates the image counterclockwise by the given amount of degrees
     * @param angle The angle to rotate the image for (in degrees)
     * @param resize Whether to resize the image so it fits all pixels or just ignore outlying pixels. Default: `true`
     */
    rotate(angle: number, resize?: boolean): this;
    rotate(angle: number, resizeOrOptions: boolean | RotateOptions = true): this {
        const { resize = true, fast = true } = typeof resizeOrOptions === 'object' && resizeOrOptions !== null ? resizeOrOptions : { resize: resizeOrOptions };
        angle = ((finite(angle, 'angle') % 360) + 360) % 360;
        if (angle === 0) return this;

        const {width, height} = this;
        const src = this.__u32__;

        // right angles are exact pixel permutations
        if (angle === 90 || angle === 180 || angle === 270) {
            const out = new Image(angle === 180 ? width : height, angle === 180 ? height : width);
            const dst = out.__u32__;

            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    const i = src[y * width + x];
                    if (angle === 90) dst[(width - 1 - x) * height + y] = i;
                    else if (angle === 180) dst[(height - 1 - y) * width + width - 1 - x] = i;
                    else dst[x * height + height - 1 - y] = i;
                }

            return this.__apply__(out);
        }

        const rad = angle * Math.PI / 180;
        const sin = Math.sin(rad), cos = Math.cos(rad);
        const outWidth = resize ? Math.round(Math.abs(width * cos) + Math.abs(height * sin)) : width;
        const outHeight = resize ? Math.round(Math.abs(width * sin) + Math.abs(height * cos)) : height;
        const out = new Image(outWidth, outHeight);
        if (fast && rotateBilinear(this.bitmap, width, height, out.bitmap, outWidth, outHeight, sin, cos)) return this.__apply__(out);
        const s8 = this.bitmap, d8 = out.bitmap;

        // bilinear sampling of the counterclockwise rotated source, with premultiplied alpha
        for (let oy = 0; oy < outHeight; oy++) {
            for (let ox = 0; ox < outWidth; ox++) {
                const dx = ox + 0.5 - outWidth / 2, dy = oy + 0.5 - outHeight / 2;
                const sx = dx * cos - dy * sin + width / 2 - 0.5;
                const sy = dx * sin + dy * cos + height / 2 - 0.5;
                const x0 = Math.floor(sx), y0 = Math.floor(sy);
                if (x0 < -1 || y0 < -1 || x0 >= width || y0 >= height) continue;

                const fx = sx - x0, fy = sy - y0;
                const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
                let r = 0, g = 0, b = 0, a = 0;

                // taps outside the source are skipped (zero weight taps add nothing either way)
                const left = x0 >= 0, right = x0 + 1 < width, top = y0 >= 0, bottom = y0 + 1 < height;
                let i = 4 * (y0 * width + x0);
                if (top && left) {
                    const wa = w00 * s8[i + 3];
                    r += wa * s8[i];
                    g += wa * s8[i + 1];
                    b += wa * s8[i + 2];
                    a += wa;
                }
                if (top && right) {
                    const wa = w10 * s8[i + 7];
                    r += wa * s8[i + 4];
                    g += wa * s8[i + 5];
                    b += wa * s8[i + 6];
                    a += wa;
                }
                i += 4 * width;
                if (bottom && left) {
                    const wa = w01 * s8[i + 3];
                    r += wa * s8[i];
                    g += wa * s8[i + 1];
                    b += wa * s8[i + 2];
                    a += wa;
                }
                if (bottom && right) {
                    const wa = w11 * s8[i + 7];
                    r += wa * s8[i + 4];
                    g += wa * s8[i + 5];
                    b += wa * s8[i + 6];
                    a += wa;
                }

                if (a <= 0) continue;
                // the clamped bitmap rounds on assignment
                const o = 4 * (oy * outWidth + ox);
                d8[o] = r / a;
                d8[o + 1] = g / a;
                d8[o + 2] = b / a;
                d8[o + 3] = a;
            }
        }

        return this.__apply__(out);
    }

    /**
     * Flips / mirrors the image horizontally or vertically
     * @param direction The direction to flip
     */
    flip(direction: 'horizontal' | 'vertical'): this {
        const u32 = this.__u32__;
        const {width, height} = this;

        if (direction === 'horizontal') {
            for (let y = 0; y < height; y++) u32.subarray(y * width, (y + 1) * width).reverse();
        } else if (direction === 'vertical') {
            for (let y = 0; y < height >> 1; y++) {
                const top = u32.slice(y * width, (y + 1) * width);
                u32.copyWithin(y * width, (height - 1 - y) * width, (height - y) * width);
                u32.set(top, (height - 1 - y) * width);
            }
        } else throw new RangeError('Invalid flip direction');

        return this;
    }

    /**
     * @private
     * @param image
     */
    /**
     * @internal the bitmap as a plain byte view
     * @ignore
     */
    protected __bytes__(): Uint8Array {
        return new Uint8Array(this.bitmap.buffer, this.bitmap.byteOffset, this.bitmap.byteLength);
    }

    /**
     * @internal
     * @ignore
     */
    protected __apply__(image: Image): this {
        this.__width__ = image.__width__;
        this.__height__ = image.__height__;
        this.__bitmap__ = image.__bitmap__;
        this.__view__ = image.__view__;
        this.__u32__ = image.__u32__;

        return this;
    }

    /**
     * Creates a multi-point gradient generator
     * @param colors The gradient points to use (e.g. `{0: 0xff0000ff, 1: 0x00ff00ff}`)
     * @return The gradient generator. The function argument is the position in the gradient (0..1).
     */
    static gradient(colors: Record<number, Color>): (position: number) => Color {
        const entries = Object.entries(colors).sort((a, b) => Number(a[0]) - Number(b[0]));
        const positions = entries.map(e => finite(parseFloat(e[0]), 'gradient position'));
        const values = entries.map(e => checkColor(e[1]));

        if (positions.length === 0) throw new RangeError('Invalid gradient point count');
        else if (positions.length === 1) {
            return () => values[0];
        } else if (positions.length === 2) {
            const gradient = this.__gradient__(values[0], values[1]);
            return position => {
                if (position <= positions[0]) return values[0];
                if (position >= positions[1]) return values[1];
                return gradient((position - positions[0]) / (positions[1] - positions[0]));
            };
        }

        const minDef = Math.min(...positions);
        const maxDef = Math.max(...positions);
        const gradients: Array<{ min: number, max: number, gradient: (position: number) => Color }> = [];

        for (let i = 0; i < positions.length; i++) {
            const minPos = positions[i - 1];
            if (minPos === undefined) continue;

            const maxPos = positions[i];

            let minVal = values[i - 1];
            if (minVal === undefined) minVal = values[i];

            const maxVal = values[i];
            const gradient = this.__gradient__(minVal, maxVal);

            gradients.push({min: minPos, max: maxPos, gradient});
        }

        return position => {
            if (position <= minDef) return gradients[0].gradient(0);
            if (position >= maxDef) return gradients[gradients.length - 1].gradient(1);

            for (const gradient of gradients)
                if (position >= gradient.min && position <= gradient.max)
                    return gradient.gradient((position - gradient.min) / (gradient.max - gradient.min));
            throw new RangeError(`Invalid gradient position: ${position}`);
        };
    }

    /**
     * Rounds the images corners, with antialiased edges
     * @param options See {@link RoundCornersOptions}
     */
    roundCorners(options?: RoundCornersOptions): this;
    /**
     * Rounds the images corners, with antialiased edges
     * @param [radius=min(width,height)/4] The radius of the corners
     */
    roundCorners(radius?: number): this;
    roundCorners(radiusOrOptions?: number | RoundCornersOptions): this {
        let radius = (isOptions(radiusOrOptions) ? radiusOrOptions.radius : radiusOrOptions) ?? Math.min(this.width, this.height) / 4;
        radius = finite(radius, 'radius');
        radius = Math.max(0, Math.min(radius, this.width / 2, this.height / 2));
        const size = Math.ceil(radius);

        // coverage of the top left corner, mirrored onto the others
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const coverage = pixelCoverage(x, y, (sx, sy) => sx >= radius || sy >= radius || (sx - radius) ** 2 + (sy - radius) ** 2 <= radius * radius);
                if (coverage >= 1) continue;

                // corners can share the middle row/column of odd sized images
                const corners = new Set([[x, y], [this.width - 1 - x, y], [x, this.height - 1 - y], [this.width - 1 - x, this.height - 1 - y]].map(([px, py]) => py * this.width + px));
                for (const pixel of corners) this.bitmap[pixel * 4 + 3] *= coverage;
            }
        }

        return this;
    }

    /**
     * @private
     */
    /**
     * @internal
     * @ignore
     */
    protected static __gradient__(startColor: Color, endColor: Color): (position: number) => Color {
        const sr = startColor >>> 24;
        const sg = startColor >> 16 & 0xff;
        const sb = startColor >> 8 & 0xff;
        const sa = startColor & 0xff;
        const er = (endColor >>> 24) - sr;
        const eg = (endColor >> 16 & 0xff) - sg;
        const eb = (endColor >> 8 & 0xff) - sb;
        const ea = (endColor & 0xff) - sa;

        return position => {
            const r = sr + position * er;
            const g = sg + position * eg;
            const b = sb + position * eb;
            const a = sa + position * ea;
            return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff)) >>> 0;
        };
    }

    /**
     * Applies a fisheye (barrel distortion) effect
     * @param options See {@link FisheyeOptions}
     */
    fisheye(options?: FisheyeOptions): this;
    /**
     * Applies a fisheye (barrel distortion) effect
     * @param [strength=2] The distortion strength (exponent of the radial mapping), higher values bulge the center more
     */
    fisheye(strength?: number): this;
    fisheye(strengthOrOptions?: number | FisheyeOptions): this {
        const strength = finite((isOptions(strengthOrOptions) ? strengthOrOptions.strength : strengthOrOptions) ?? 2, 'strength');
        const r = new Image(this.width, this.height);

        const w = this.width;
        const h = this.height;
        const tu32 = this.__u32__;
        const ru32 = r.__u32__;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const xco = (x + 0.5) / w - 0.5;
                const yco = (y + 0.5) / h - 0.5;
                const dfc = Math.sqrt(xco ** 2 + yco ** 2);

                if (dfc === 0) {
                    ru32[y * w + x] = tu32[y * w + x];
                    continue;
                }

                const dis = 2 * dfc ** strength;
                const nx = Math.floor((dis * xco / dfc + 0.5) * w);
                const ny = Math.floor((dis * yco / dfc + 0.5) * h);
                if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

                ru32[y * w + x] = tu32[ny * w + nx];
            }
        }

        return this.__apply__(r);
    }


    /**
     * Encodes the image into a PNG, with the smallest lossless color type (a palette for up to 256 colors,
     * greyscale or RGB, alpha only if needed). Uses the runtime's native zlib when available
     * @param options See {@link PNGEncodeOptions}
     * @return The encoded data
     */
    encode(options?: PNGEncodeOptions): Promise<Uint8Array>;
    /**
     * Encodes the image into a PNG
     * @param compression The compression level (0-9). Default: `1`
     * @param metadata Metadata to include, see {@link Metadata}
     * @return The encoded data
     */
    encode(compression?: number, metadata?: Metadata): Promise<Uint8Array>;
    /**
     * Encodes the image into a PNG with compression level 1
     * @param metadata Metadata to include, see {@link Metadata}
     * @return The encoded data
     */
    encode(metadata?: Metadata): Promise<Uint8Array>;
    async encode(compressionOrOptions: number | PNGEncodeOptions | Metadata = 1, metadataArgument: Metadata = {}): Promise<Uint8Array> {
        let compression = 1, metadata = metadataArgument;
        if (!isOptions(compressionOrOptions)) compression = compressionOrOptions;
        // the options and the metadata have no key in common: an object with neither is empty, the same either way
        else if ('compression' in compressionOrOptions || 'metadata' in compressionOrOptions)
            ({ compression = 1, metadata = {} } = compressionOrOptions);
        else metadata = compressionOrOptions as Metadata;

        const level = Math.min(9, Math.max(0, ~~finite(compression, 'compression level')));
        return png.encodeRGBA(this.__bytes__(), this.width, this.height, level, pngText(resolveMetadata(metadata)));
    }

    /**
     * Encodes the image into a PNG, an alias of {@link Image.encode}
     */
    encodePNG(options?: PNGEncodeOptions): Promise<Uint8Array>;
    /**
     * Encodes the image into a PNG, an alias of {@link Image.encode}
     * @param compression The compression level (0-9). Default: `1`
     * @param metadata Metadata to include, see {@link Metadata}
     */
    encodePNG(compression?: number, metadata?: Metadata): Promise<Uint8Array>;
    /**
     * Encodes the image into a PNG, an alias of {@link Image.encode}
     * @param metadata Metadata to include, see {@link Metadata}
     */
    encodePNG(metadata?: Metadata): Promise<Uint8Array>;
    encodePNG(compressionOrOptions?: number | PNGEncodeOptions | Metadata, metadata?: Metadata): Promise<Uint8Array> {
        return this.encode(compressionOrOptions as number, metadata);
    }

    /**
     * Encodes the image into a JPEG
     * @param options See {@link JPEGEncodeOptions}
     */
    encodeJPEG(options?: JPEGEncodeOptions): Promise<Uint8Array>;
    /**
     * Encodes the image into a JPEG
     * @param [quality=90] The JPEG quality to use (1-100), chroma subsampling is disabled above 90
     */
    encodeJPEG(quality?: number): Promise<Uint8Array>;
    async encodeJPEG(qualityOrOptions: number | JPEGEncodeOptions = 90): Promise<Uint8Array> {
        const { quality = 90, metadata = {} } = isOptions(qualityOrOptions) ? qualityOrOptions : { quality: qualityOrOptions };
        const m = resolveMetadata(metadata);
        return jpeg.encode(this.__bytes__(), this.width, this.height, finite(quality, 'quality'), { exif: exifData(m), comment: m.comment ? utf8(m.comment) : undefined });
    }

    /**
     * Encodes the image as WebP: lossless (usually 20-30% smaller than PNG, but slower to encode), or lossy with a
     * quality
     * @param options See {@link WebPEncodeOptions}
     */
    async encodeWebP({ quality, effort = 2, sharpYuv = false, alphaQuality = 100, metadata = {} }: WebPEncodeOptions = {}): Promise<Uint8Array> {
        const exif = exifData(resolveMetadata(metadata));
        const lossy = webp.lossyOptions(quality, effort, sharpYuv, alphaQuality);
        if (!lossy) return webp.encode(this.__bytes__(), this.width, this.height, exif);
        return webp.encodeLossy(this.__bytes__(), this.width, this.height, lossy, exif);
    }

    /**
     * Encodes the image as run length encoded TGA (32 bit, or 24 bit if the image is opaque)
     * @param options See {@link EncodeOptions}
     */
    async encodeTGA({ metadata = {} }: EncodeOptions = {}): Promise<Uint8Array> {
        const { author, comment, creationTime: time, software } = resolveMetadata(metadata);
        return tga.encode(this.__bytes__(), this.width, this.height, { author, comment, time, software });
    }

    /**
     * Encodes the image as BMP: with a palette if it is opaque and has at most 256 colors, else with 24 bit pixels, or
     * 32 bit ones if it has transparency
     */
    async encodeBMP(): Promise<Uint8Array> {
        return bmp.encode(this.__bytes__(), this.width, this.height);
    }

    /**
     * Encodes the image as QOI (3 channels if the image is opaque)
     */
    async encodeQOI(): Promise<Uint8Array> {
        return qoi.encode(this.__bytes__(), this.width, this.height);
    }

    /**
     * Encodes the image as AVIF (AV1, with an alpha image if the image has transparency)
     * @param options See {@link AVIFEncodeOptions}
     */
    async encodeAVIF({ quality = 60, alphaQuality = 100, subsampling = '4:4:4', effort = 1, threads = defaultThreads(), metadata = {} }: AVIFEncodeOptions = {}): Promise<Uint8Array> {
        checkThreads(threads);
        const exif = exifData(resolveMetadata(metadata));
        return avifEnc.encode(this.__bytes__(), this.width, this.height, { quality: finite(quality, 'quality'), alphaQuality: finite(alphaQuality, 'alphaQuality'), subsampling, effort, exif, threads });
    }

    /**
     * Encodes the image as JPEG XL: losslessly (the default), the codestream byte for byte like libjxl's `cjxl -e 1` on
     * CPUs with AVX2 or NEON (its fast lossless mode: the gradient predictor, a palette if the image has at most 511
     * colors besides black, else YCoCg; greyscale if the image is), or lossy with a quality (like `cjxl -q`: XYB,
     * varblocks of libjxl's search, chroma from luma, the edge preserving filter). Alpha (if the image has
     * transparency) is lossless either way. The codestream is in the container, with the metadata as Exif
     * @param options See {@link JXLEncodeOptions}
     */
    async encodeJXL({ quality, effort = 1, threads = defaultThreads(), metadata = {} }: JXLEncodeOptions = {}): Promise<Uint8Array> {
        if (!Number.isInteger(effort) || effort < 0 || effort > 2) throw new RangeError(`effort must be an integer 0-2, not ${effort}`);
        checkThreads(threads);
        let distance = 0;
        if (quality !== undefined) {
            const q = finite(quality, 'quality');
            if (q < 0 || q > 100) throw new RangeError(`quality must be 0-100, not ${q}`);
            // (cjxl's distance of a quality)
            distance = q >= 100 ? 0 : q >= 30 ? 0.1 + (100 - q) * 0.09 : 53 / 3000 * q * q - 23 / 20 * q + 25;
        }
        return jxl.encode(this.__bytes__(), this.width, this.height, exifData(resolveMetadata(metadata)), distance, effort, threads);
    }

    /**
     * Encodes the image as the smallest fitting Netpbm format: PBM for black and white images, PGM for greyscale ones,
     * PPM for others, PAM if the image has transparency
     */
    async encodePNM(): Promise<Uint8Array> {
        return netpbm.encode(this.__bytes__(), this.width, this.height);
    }

    /**
     * Decodes an image (PNG, JPEG, TIFF, WebP, BMP, ICO, CUR, QOI, PBM, PGM, PPM, PAM, PFM, Radiance HDR, TGA, AVIF or
     * JPEG XL). For APNGs this is the default image; animated WebPs and GIFs have no single image, decode those with
     * {@link Animation.decode}; for icons and cursors it's their largest image, for AVIF image sequences and JPEG XL
     * animations their first frame
     * @param input The binary data to decode
     * @param options See {@link DecodeOptions}. JPEGs, TIFFs and PNGs are rotated/mirrored as their orientation tag
     *     (Exif, for PNGs also XMP) says by default: photos taken with a rotated camera are stored sideways
     * @return The decoded image
     */
    static async decode(input: BinaryData, options: DecodeOptions = {}): Promise<Image> {
        const { applyOrientation = true, applyColorProfile = true, maxPixels = MAX_PIXELS, toneMapping = 'reinhard' } = options;
        if (toneMapping !== 'reinhard' && toneMapping !== 'clamp') throw new TypeError(`toneMapping must be 'reinhard' or 'clamp', not ${String(toneMapping)}`);
        const data = view(input);
        const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

        const decoded: { width: number, height: number, pixels: Uint8Array, orientation?: number, icc?: Uint8Array } = await decoding(() => {
            if (ImageType.isPNG(dataView)) return png.decode(data, maxPixels);
            if (ImageType.isJPEG(dataView)) return jpeg.decode(data, { maxPixels });
            if (ImageType.isTIFF(dataView)) return tiff.decode(data, maxPixels);
            if (ImageType.isWebP(dataView)) {
                if (webp.isAnimated(data)) throw new Error('Animated WebPs have to be decoded with Animation.decode()');
                return webp.decode(data, maxPixels);
            }
            // bitmaps can hold a JPEG or PNG, icons PNGs
            const bitmap = async (decoded: bmp.Decoded): Promise<{ width: number, height: number, pixels: Uint8Array }> => {
                if (!('embedded' in decoded)) return decoded;
                // (without their orientation tags)
                const { width, height, pixels } = decoded.embedded === 'png' ? await png.decode(decoded.data, maxPixels) : jpeg.decode(decoded.data, { maxPixels });
                return { width, height, pixels };
            };
            if (ImageType.isAVIF(dataView)) return avif.decode(data, maxPixels, toneMapping);
            if (ImageType.isJXL(dataView)) return jxl.decode(data, maxPixels, toneMapping);
            if (ImageType.isBMP(dataView)) return bitmap(bmp.decode(data, maxPixels));
            if (ImageType.isICO(dataView)) return bitmap(ico.decode(data, maxPixels));
            if (ImageType.isQOI(dataView)) return qoi.decode(data, maxPixels);
            if (ImageType.isPNM(dataView)) return netpbm.decode(data, maxPixels, toneMapping);
            if (ImageType.isHDR(dataView)) return hdr.decode(data, maxPixels, toneMapping);
            if (ImageType.isTGA(dataView)) return tga.decode(data, maxPixels);
            throw new Error('Unsupported image type');
        });

        if (applyColorProfile && decoded.icc) profileTransform(decoded.icc)?.(decoded.pixels);
        // the decoded pixels become the bitmap, without a copy
        const image = new Image(decoded.width, decoded.height);
        image.bitmap = decoded.pixels;
        return applyOrientation && decoded.orientation ? image.__orient__(decoded.orientation) : image;
    }

    /**
     * Applies an Exif orientation (1-8), turning the stored pixels into the displayed ones
     * @internal
     * @ignore
     */
    __orient__(orientation: number): this {
        if (orientation <= 1 || orientation > 8) return this;

        const w = this.width, h = this.height;
        const swap = orientation >= 5;
        const out = new Image(swap ? h : w, swap ? w : h);
        const src = this.__u32__, dst = out.__u32__;
        const ow = out.width, oh = out.height;

        // source pixel of every output pixel (X, Y)
        for (let Y = 0; Y < oh; Y++) {
            for (let X = 0; X < ow; X++) {
                let x: number, y: number;
                switch (orientation) {
                    case 2: x = w - 1 - X; y = Y; break; // mirrored horizontally
                    case 3: x = w - 1 - X; y = h - 1 - Y; break; // rotated 180
                    case 4: x = X; y = h - 1 - Y; break; // mirrored vertically
                    case 5: x = Y; y = X; break; // transposed
                    case 6: x = Y; y = h - 1 - X; break; // needs a 90 degree clockwise rotation
                    case 7: x = w - 1 - Y; y = h - 1 - X; break; // transversed
                    default: x = w - 1 - Y; y = X; break; // 8, needs a 90 degree counterclockwise rotation
                }
                dst[Y * ow + X] = src[y * w + x];
            }
        }

        return this.__apply__(out);
    }

    /**
     * Scale the SVG by the given amount. For use with {@link Image.renderSVG}
     */
    static get SVG_MODE_SCALE(): 1 {
        return 1;
    }

    /**
     * Scale the SVG to fit the given width. For use with {@link Image.renderSVG}
     */
    static get SVG_MODE_WIDTH(): 2 {
        return 2;
    }

    /**
     * Scale the SVG to fit the given height. For use with {@link Image.renderSVG}
     */
    static get SVG_MODE_HEIGHT(): 3 {
        return 3;
    }

    /**
     * Creates a new image from the given SVG
     * Supports shapes, paths, transforms, use/symbol, CSS styles, gradients, patterns, strokes, markers, clip paths,
     * masks, opacity, blend modes, filters (all primitives and the filter functions) and images embedded as data URIs
     * (PNG, JPEG, GIF, WebP, SVG), and text with the given or embedded fonts (see {@link SVGOptions.fonts})
     * @param svg The SVG content
     * @param options See {@link SVGOptions}
     * @return The rendered SVG graphic
     */
    static renderSVG(svg: string | BinaryData, options?: SVGOptions): Promise<Image>;
    /**
     * Creates a new image from the given SVG
     * @param svg The SVG content
     * @param size The size to use
     * @param mode The SVG resizing mode to use (one of {@link SVG_MODE_SCALE}, {@link SVG_MODE_WIDTH}, {@link SVG_MODE_HEIGHT})
     * @return The rendered SVG graphic
     */
    static renderSVG(svg: string | BinaryData, size?: number, mode?: SVGScaleMode): Promise<Image>;
    static async renderSVG(svg: string | BinaryData, sizeOrOptions: number | SVGOptions = 1, modeArgument: SVGScaleMode = Image.SVG_MODE_SCALE): Promise<Image> {
        const { size = 1, mode = Image.SVG_MODE_SCALE, fonts = [] } = isOptions(sizeOrOptions) ? sizeOrOptions : { size: sizeOrOptions, mode: modeArgument };
        if (![1, 2, 3].includes(mode))
            throw new Error('Invalid SVG scaling mode');

        if (mode === Image.SVG_MODE_SCALE && size <= 0)
            throw new RangeError('SVG scale must be > 0');
        if (mode !== Image.SVG_MODE_SCALE && size < 1)
            throw new RangeError('SVG size must be >= 1');

        // the raster images it embeds are decoded first (decoding can be asynchronous), the SVG is rendered at once
        const source = typeof svg === 'string' ? svg : view(svg);
        const images = new Map<string, svgRenderer.RasterImage>();
        for (const { href, data } of svgRenderer.embeddedImages(source)) {
            if (images.has(href)) continue;
            try {
                if (ImageType.getType(data) === 'gif') {
                    // (a GIF's first frame)
                    const decoded = gif.decode(data, true);
                    images.set(href, { width: decoded.width, height: decoded.height, pixels: gif.composite(decoded)[0].pixels });
                } else {
                    const image = await Image.decode(data);
                    images.set(href, { width: image.width, height: image.height, pixels: image.bitmap });
                }
            } catch {
                // (images that can't be decoded aren't drawn, like resvg's)
            }
        }

        const {width, height, pixels} = svgRenderer.render(source, mode, size, images, fonts.map(font => view(font)));
        const image = new Image(width, height);
        image.bitmap.set(pixels);

        return image;
    }

    /**
     * Creates a new image containing the rendered text.
     * @param font TrueType (ttf/ttc) or OpenType (otf) font buffer to use, or several by priority: every character
     *     comes from the first font that has it (e.g. `[text, emoji]`), the first one sets the line height. Color
     *     glyphs (COLR layers and paints, CBDT and sbix bitmaps, as in emoji fonts) keep their colors. Text in any script
     *     is shaped like browsers do (right to left and bidirectional text, Arabic joining, Indic conjuncts, marks)
     * @param size Font size in pixels (per em)
     * @param text Text to render
     * @param options Color, layout and style, see {@link TextOptions}; the image grows by the outline width on every
     *     side
     * @return The rendered text
     */
    static renderText(font: BinaryData | BinaryData[], size: number, text: string, options?: TextOptions): Promise<Image>;
    /**
     * Creates a new image containing the rendered text.
     * @param font TrueType (ttf/ttc) or OpenType (otf) font buffer to use, or several by priority: every character
     *     comes from the first font that has it (e.g. `[text, emoji]`), the first one sets the line height. Color
     *     glyphs (COLR layers and paints, CBDT and sbix bitmaps, as in emoji fonts) keep their colors. Text in any script
     *     is shaped like browsers do (right to left and bidirectional text, Arabic joining, Indic conjuncts, marks)
     * @param size Font size in pixels (per em)
     * @param text Text to render
     * @param [color=0xffffffff] Text color to use
     * @param [layout] The text layout to use
     * @param style Outline, see {@link TextStyle}; the image grows by the outline width on every side
     * @return The rendered text
     */
    static renderText(font: BinaryData | BinaryData[], size: number, text: string, color?: Color, layout?: TextLayout, style?: TextStyle): Promise<Image>;
    static async renderText(font: BinaryData | BinaryData[], size: number, text: string, colorOrOptions: Color | TextOptions = 0xffffffff, layoutArgument?: TextLayout, styleArgument: TextStyle = {}): Promise<Image> {
        const options: TextOptions = isOptions(colorOrOptions) ? colorOrOptions : { ...styleArgument, color: colorOrOptions, layout: layoutArgument };
        const { color = 0xffffffff, layout = new TextLayout(), strokeWidth = 0, strokeColor = 0x000000ff, hinting = true, features = {} } = options;
        size = finite(size, 'font size');
        if (finite(strokeWidth, 'stroke width') < 0)
            throw new RangeError('Invalid stroke width');
        const fonts = Array.isArray(font) ? font : [font];
        if (!fonts.length) throw new RangeError('No font given');

        const [r, g, b, a] = Image.colorToRGBA(color);
        // color glyph layers in the text color take it without its alpha, which applies to the whole color glyph
        const rendered = await textRenderer.render(fonts.map(view), size, text, layout, hinting, (r << 24 | g << 16 | b << 8 | 255) >>> 0, featureList(features));

        // the outline needs room around the glyphs
        const pad = Math.ceil(strokeWidth);
        const width = rendered.width + 2 * pad, height = rendered.height + 2 * pad;
        const coverage = new Uint8Array(width * height);
        for (let y = 0; y < rendered.height; y++)
            coverage.set(rendered.coverage.subarray(y * rendered.width, (y + 1) * rendered.width), (y + pad) * width + pad);
        let colored: Uint8ClampedArray | null = null;
        if (rendered.color) {
            colored = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < rendered.height; y++)
                colored.set(rendered.color.subarray(y * rendered.width * 4, (y + 1) * rendered.width * 4), ((y + pad) * width + pad) * 4);
        }

        const image = new Image(width, height);
        const bitmap = image.bitmap;

        if (!strokeWidth && !colored) {
            // the pixel for each coverage value, written as one word
            const pixels = new Uint32Array(bitmap.buffer, bitmap.byteOffset, bitmap.length >> 2), lut = new Uint32Array(256);
            const bytes = new Uint8ClampedArray(lut.buffer);
            for (let v = 1; v < 256; v++) bytes.set([r, g, b, v * a / 255], v * 4);
            for (let i = 0; i < coverage.length; i++) if (coverage[i]) pixels[i] = lut[coverage[i]];
            return image;
        }

        // the outline goes around the color glyphs as well
        let shape = coverage;
        if (colored) {
            shape = coverage.slice();
            for (let i = 0; i < shape.length; i++) shape[i] = Math.max(shape[i], colored[i * 4 + 3]);
        }
        const stroke = strokeWidth ? outline(shape, width, height, strokeWidth) : null;
        const [sr, sg, sb, sa] = Image.colorToRGBA(strokeColor);

        // color glyphs over the text (premultiplied, with the text's alpha), both within their outline
        for (let i = 0; i < coverage.length; i++) {
            let af = coverage[i] / 255 * a / 255, pr = r * af, pg = g * af, pb = b * af;
            if (colored && colored[i * 4 + 3]) {
                const ca = colored[i * 4 + 3] / 255 * a / 255, keep = 1 - ca, f = a / 255;
                pr = colored[i * 4] * f + pr * keep;
                pg = colored[i * 4 + 1] * f + pg * keep;
                pb = colored[i * 4 + 2] * f + pb * keep;
                af = ca + af * keep;
            }
            if (stroke) {
                // the outline shows around the glyphs only, not through translucent ones (for opaque text it's the
                // same as drawing the glyphs over it)
                const as = stroke[i] * sa / 255 * (1 - shape[i] / 255);
                pr += sr * as;
                pg += sg * as;
                pb += sb * as;
                af += as;
            }
            if (af <= 0) continue;

            bitmap[i * 4] = pr / af;
            bitmap[i * 4 + 1] = pg / af;
            bitmap[i * 4 + 2] = pb / af;
            bitmap[i * 4 + 3] = af * 255;
        }

        return image;
    }

}

// samples per pixel axis for antialiased edges
const SUBSAMPLES = 4;

// share of the pixel's area for which inside(x, y) holds, estimated on a regular grid
function pixelCoverage(px: number, py: number, inside: (x: number, y: number) => boolean): number {
    let count = 0;
    for (let j = 0; j < SUBSAMPLES; j++)
        for (let i = 0; i < SUBSAMPLES; i++)
            if (inside(px + (i + 0.5) / SUBSAMPLES, py + (j + 0.5) / SUBSAMPLES)) count++;
    return count / (SUBSAMPLES * SUBSAMPLES);
}

// share of the pixel covered by a circle, only edge pixels are sampled
function circleCoverage(px: number, py: number, cx: number, cy: number, radius: number): number {
    const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
    if (d <= radius - Math.SQRT1_2) return 1;
    if (d >= radius + Math.SQRT1_2) return 0;
    return pixelCoverage(px, py, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius);
}

// rounds and clamps a channel value to 0..255 (NaN becomes 0)
function channel(value: number): number {
    return value > 255 ? 255 : value > 0 ? Math.round(value) : 0;
}

interface HSLA {
    h: number;
    s: number;
    l: number;
    a: number;
}

// wraps a hue into 0..1 (negative hues included), exactly like (h % 1 + 1) % 1 but without the slow float modulo
function wrapHue(h: number): number {
    const t = h - Math.trunc(h) + 1;
    return t < 1 ? t : t < 2 ? t - 1 : 0;
}

function hue2rgb(p: number, q: number, t: number): number {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}

// the resize mode of a positional argument or options object
function resizeOptions(modeOrOptions?: ResizeMode | ResizeOptions): { mode: ResizeMode, fast: boolean } {
    const options = isOptions(modeOrOptions) ? modeOrOptions : { mode: modeOrOptions };
    return { mode: options.mode ?? Image.RESIZE_BILINEAR, fast: options.fast ?? true };
}

// separable blend functions of normalized channel values (W3C Compositing and Blending Level 1)
const hardLight = (b: number, s: number): number => s <= 0.5 ? b * 2 * s : 1 - (1 - b) * (1 - (2 * s - 1));

const BLEND_MODES: Record<BlendMode, (backdrop: number, source: number) => number> = {
    'normal': (_b, s) => s,
    'multiply': (b, s) => b * s,
    'screen': (b, s) => b + s - b * s,
    'overlay': (b, s) => hardLight(s, b),
    'darken': (b, s) => Math.min(b, s),
    'lighten': (b, s) => Math.max(b, s),
    'color-dodge': (b, s) => b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s)),
    'color-burn': (b, s) => b === 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s),
    'hard-light': hardLight,
    'soft-light': (b, s) => {
        if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
        const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
        return b + (2 * s - 1) * (d - b);
    },
    'difference': (b, s) => Math.abs(b - s),
    'exclusion': (b, s) => b + s - 2 * b * s,
    'add': (b, s) => Math.min(1, b + s)
};

/**
 * Grows a coverage mask by a radius, using the distance of every pixel to the glyphs (an exact euclidean distance
 * transform, so the cost doesn't depend on the radius). Near the outline's edge, the distance goes to the glyph edge
 * within the pixels around the nearest covered one (estimated from their coverage and its gradient, like Gustavson's
 * antialiased distance transform), so the outline follows the antialiased edge instead of the pixels
 * @return the outline's coverage (0..1) per pixel, including the area under the glyphs
 */
// covered pixels around the nearest one (on either side) whose edge points the outline's edge is measured to
const OUTLINE_WINDOW = 1;

function outline(coverage: Uint8Array, width: number, height: number, radius: number): Float32Array {
    const count = width * height;
    // squared distance to the nearest pixel that is at least half covered, and that pixel's coordinates
    const distance = new Float64Array(count);
    for (let i = 0; i < count; i++) distance[i] = coverage[i] >= 128 ? 0 : Infinity;
    const nearestY = new Int32Array(count), nearestX = new Int32Array(count);

    const size = Math.max(width, height);
    const line = new Float64Array(size), result = new Float64Array(size), nearest = new Int32Array(size);
    const parabolas = new Int32Array(size), bounds = new Float64Array(size + 1);

    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) line[y] = distance[y * width + x];
        distanceTransform(line, height, result, parabolas, bounds, nearest);
        for (let y = 0; y < height; y++) {
            distance[y * width + x] = result[y];
            nearestY[y * width + x] = nearest[y];
        }
    }

    // distances beyond the outline don't matter: leaving them out of the rows saves most of their work
    const far = (radius + 2) ** 2;
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) line[x] = distance[row + x] < far ? distance[row + x] : Infinity;
        distanceTransform(line, width, result, parabolas, bounds, nearest);
        for (let x = 0; x < width; x++) {
            distance[row + x] = result[x];
            nearestX[row + x] = nearest[x];
        }
    }

    // where the glyph edge crosses an edge pixel (partly covered, or covered next to an uncovered one): from its
    // center along the outward normal (the coverage gradient) to where a straight edge would cover it as much. The
    // coverage has an empty border (the outline's room), so covered pixels have all their neighbors
    const pointX = new Float32Array(count), pointY = new Float32Array(count), isEdge = new Uint8Array(count);
    for (let y = 1; y < height - 1; y++)
        for (let x = 1, e = y * width + 1; x < width - 1; x++, e++) {
            const c = coverage[e];
            if (!c || c === 255 && coverage[e - 1] >= 128 && coverage[e + 1] >= 128 && coverage[e - width] >= 128 && coverage[e + width] >= 128) continue;
            // Sobel gradient, pointing inwards
            const above = e - width, below = e + width;
            const gx = coverage[above + 1] + 2 * coverage[e + 1] + coverage[below + 1] - coverage[above - 1] - 2 * coverage[e - 1] - coverage[below - 1];
            const gy = coverage[below - 1] + 2 * coverage[below] + coverage[below + 1] - coverage[above - 1] - 2 * coverage[above] - coverage[above + 1];
            const length = Math.sqrt(gx * gx + gy * gy);
            if (!length) continue;
            // the center lies 1/2 - c outside the edge
            const outside = 0.5 - c / 255;
            pointX[e] = x + outside * gx / length;
            pointY[e] = y + outside * gy / length;
            isEdge[e] = 1;
        }

    // the distance to the nearest covered pixel's center is within a pixel of the distance to the edge: outside of that
    // band around the outline's edge, a pixel is fully covered or not at all
    // (pixels next to the glyph edge are covered by the glyph's own antialiasing)
    const out = new Float32Array(count);
    const inner = radius - 1.5, near = inner > 0 ? inner * inner : -1;
    for (let y = 0, i = 0; y < height; y++)
        for (let x = 0; x < width; x++, i++) {
            const d2 = distance[i];
            if (d2 <= near) out[i] = 1;
            if (d2 <= near || d2 >= far) {
                if (d2 >= far) out[i] = coverage[i] / 255;
                continue;
            }

            // the closest edge point around the nearest covered pixel
            const qx = nearestX[i], qy = nearestY[y * width + qx];
            let closest = Infinity;
            for (let wy = Math.max(0, qy - OUTLINE_WINDOW); wy <= Math.min(height - 1, qy + OUTLINE_WINDOW); wy++)
                for (let wx = Math.max(0, qx - OUTLINE_WINDOW), e = wy * width + wx; wx <= Math.min(width - 1, qx + OUTLINE_WINDOW); wx++, e++) {
                    if (!isEdge[e]) continue;
                    const ex = x - pointX[e], ey = y - pointY[e];
                    closest = Math.min(closest, ex * ex + ey * ey);
                }
            closest = closest === Infinity ? Math.sqrt(d2) - 0.5 : Math.sqrt(closest);
            out[i] = Math.max(coverage[i] / 255, Math.min(1, Math.max(0, radius + 0.5 - closest)));
        }

    return out;
}

// 1D squared euclidean distance transform (Felzenszwalb & Huttenlocher): lower envelope of parabolas, also the index
// of the nearest sample
function distanceTransform(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array, nearest: Int32Array): void {
    let k = -1;
    for (let q = 0; q < n; q++) {
        if (f[q] === Infinity) continue;
        let s = 0;
        while (k >= 0) {
            s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            if (s > z[k]) break;
            k--;
        }
        k++;
        v[k] = q;
        z[k] = k === 0 ? -Infinity : s;
        z[k + 1] = Infinity;
    }

    if (k < 0) {
        d.fill(Infinity, 0, n);
        return;
    }

    for (let q = 0, j = 0; q < n; q++) {
        while (z[j + 1] < q) j++;
        d[q] = (q - v[j]) ** 2 + f[v[j]];
        nearest[q] = v[j];
    }
}
