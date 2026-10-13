import * as png from './codecs/png.ts';
import * as jpeg from './codecs/jpeg.ts';
import * as tiff from './codecs/tiff.ts';
import * as quantize from './codecs/quantize.ts';
import * as textRenderer from './render/text.ts';
import * as svgRenderer from './render/svg.ts';
import { BinaryData, view } from './util/mem.ts';
import { ImageType } from './image-type.ts';
import { TextLayout } from './text-layout.ts';
import { VERSION } from './version.ts';
import { resample, BOX, TRIANGLE, CUBIC } from './util/resample.ts';
import { gaussianBlur, premultiply, unpremultiply } from './util/blur.ts';

/**
 * Represents an image; provides utility functions
 */
/** A color as a 32-bit RGBA integer (`0xRRGGBBAA`) */
export type Color = number;

/** Called with a pixel's (0-based) coordinates, returns its color */
export type ColorFunction = (x: number, y: number) => Color;

export type ResizeMode = 'RESIZE_NEAREST_NEIGHBOR' | 'RESIZE_BILINEAR' | 'RESIZE_BICUBIC' | 'RESIZE_AREA';

export type SVGScaleMode = 1 | 2 | 3;

/** Blend modes of {@link Image.composite}, named like CSS' mix-blend-mode values */
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
    | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'add';

export interface CompositeOptions {
    /** Opacity of the source (0..1). Default: `1` */
    opacity?: number;
    /** How the colors are mixed. Default: `'normal'` */
    mode?: BlendMode;
}

export interface DecodeOptions {
    /** Whether to rotate/mirror JPEGs and TIFFs as their orientation tag (Exif) says. Default: `true` */
    applyOrientation?: boolean;
}

export interface TextStyle {
    /** Width of an outline around the glyphs in pixels. Default: `0` */
    strokeWidth?: number;
    /** Color of the outline. Default: `0x000000ff` */
    strokeColor?: Color;
}

export interface CropCircleOptions {
    /** Whether to use the larger dimension for the size. Default: `false` */
    max?: boolean;
    /** Share of the radius (0..1) over which the edge fades out. Default: `0` */
    feathering?: number;
}

export interface DominantColorOptions {
    /** Whether to ignore dark colors (all channels below the threshold). Default: `true` */
    ignoreBlack?: boolean;
    /** Whether to ignore light colors (all channels above 255 minus the threshold). Default: `true` */
    ignoreWhite?: boolean;
    /** The black/white threshold (0-64, in steps of 4 channel values). Default: `15` */
    threshold?: number;
}

export interface RotateOptions {
    /** Whether to resize the image so it fits all pixels or just ignore outlying pixels. Default: `true` */
    resize?: boolean;
}

export interface PNGMetadata {
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
}

export class Image {
    /** @internal */
    protected __width__: number;
    /** @internal */
    protected __height__: number;
    /** @internal */
    protected __view__!: DataView;
    /** @internal */
    protected __u32__!: Uint32Array;
    /** @internal */
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
     */
    protected __set_bitmap__(bitmap: Uint8ClampedArray): void {
        // 32-bit views need an aligned offset
        if (bitmap.byteOffset % 4) bitmap = bitmap.slice();
        this.__bitmap__ = bitmap;
        this.__view__ = new DataView(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength);
        this.__u32__ = new Uint32Array(bitmap.buffer, bitmap.byteOffset, bitmap.length >> 2);
    }

    /**
     * @private
     */
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
        h = wrapHue(h);
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
        r /= 255;
        g /= 255;
        b /= 255;

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
        x = ~~x;
        y = ~~y;
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
        x = ~~x;
        y = ~~y;
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
        x = ~~x;
        y = ~~y;
        this.__check_boundaries__(x, y);
        this.__set_pixel__(x, y, pixelColor);
        return this;
    }

    /**
     * @private
     * @param x
     * @param y
     * @param pixelColor
     */
    /** @internal */
    protected __set_pixel__(x: number, y: number, pixelColor: Color): void {
        this.__view__.setUint32((y * this.width + x) * 4, pixelColor, false);
    }

    /**
     * @private
     * @param x
     * @param y
     */
    /** @internal */
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
    /** @internal */
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
        const image = new Image(this.width, this.height);
        image.bitmap.set(this.bitmap);
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
     * @param [mode=Image.RESIZE_BILINEAR] The resizing mode to use
     */
    scale(factor: number, mode: ResizeMode = Image.RESIZE_BILINEAR): this {
        const image = this.__scale__(factor, mode);
        return this.__apply__(image);
    }

    /** @private */
    /** @internal */
    protected __scale__(factor: number, mode: ResizeMode = Image.RESIZE_BILINEAR): Image {
        if (factor === 1) return this;
        return this.__resize__(this.width * factor, this.height * factor, mode);
    }

    /**
     * Resizes the image to the given dimensions.
     * Use {@link Image.RESIZE_AUTO} as either width or height to automatically preserve the aspect ratio.
     * @param width The new width
     * @param height The new height
     * @param [mode=Image.RESIZE_BILINEAR] The resizing mode to use
     * @returns The resized image
     */
    resize(width: number, height: number, mode: ResizeMode = Image.RESIZE_BILINEAR): this {
        const image = this.__resize__(width, height, mode);
        return this.__apply__(image);
    }

    /**
     * Resizes the image so it is contained in the given bounding box.
     * Can return an image with one axis smaller than the given bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param [mode=Image.RESIZE_BILINEAR] The resizing mode to use
     * @returns The resized image
     */
    contain(width: number, height: number, mode: ResizeMode = Image.RESIZE_BILINEAR): this {
        width = Math.floor(width);
        height = Math.floor(height);
        // round instead of flooring the scaled size, so the limiting axis matches the box exactly
        const scale = Math.min(width / this.width, height / this.height);
        return this.resize(Math.max(1, Math.min(width, Math.round(this.width * scale))), Math.max(1, Math.min(height, Math.round(this.height * scale))), mode);
    }

    /**
     * Resizes the image so it is contained in the given bounding box, placing it in the center of the given bounding box.
     * Always returns the exact dimensions of the bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param [mode=Image.RESIZE_BILINEAR] The resizing mode to use
     * @returns The resized image
     */
    fit(width: number, height: number, mode: ResizeMode = Image.RESIZE_BILINEAR): this {
        const result = new Image(width, height);
        this.contain(width, height, mode);
        result.composite(this, (width - this.width) / 2, (height - this.height) / 2);
        return this.__apply__(result);
    }

    /**
     * Resizes the image so it covers the given bounding box, cropping the overflowing edges.
     * Always returns the exact dimensions of the bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param [mode=Image.RESIZE_BILINEAR] The resizing mode to use
     * @returns The resized image
     */
    cover(width: number, height: number, mode: ResizeMode = Image.RESIZE_BILINEAR): this {
        width = Math.floor(width);
        height = Math.floor(height);
        const scale = Math.max(width / this.width, height / this.height);
        this.resize(Math.max(width, Math.round(this.width * scale)), Math.max(height, Math.round(this.height * scale)), mode);
        return this.crop((this.width - width) / 2, (this.height - height) / 2, width, height);
    }

    /** @private */
    /** @internal */
    protected __resize__(width: number, height: number, mode: ResizeMode = Image.RESIZE_BILINEAR): Image {
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
        resample(this.bitmap, this.width, this.height, width, height, filter, image.bitmap);
        return image;
    }

    /**
     * @private
     * @param width The new width
     * @param height The new height
     */
    /** @internal */
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
        x = ~~x;
        y = ~~y;
        width = ~~width;
        height = ~~height;

        const left = Math.max(0, x), top = Math.max(0, y);
        const right = Math.min(this.width, x + width), bottom = Math.min(this.height, y + height);
        if (right <= left || bottom <= top)
            throw new RangeError('Crop region does not overlap the image');

        return this.__apply__(this.__crop__(left, top, right - left, bottom - top));
    }

    /**
     * @param x
     * @param y
     * @param width
     * @param height
     * @private
     */
    /** @internal */
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
        x = ~~x;
        y = ~~y;
        width = ~~width;
        height = ~~height;

        if (typeof color !== 'function') return this.__fast_box__(x, y, width, height, color);

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
    /** @internal */
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
        x = ~~x;
        y = ~~y;
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
     * @param [max=false] Whether to use the larger dimension for the size (or the options)
     * @param [feathering=0] Share of the radius (0..1) over which the edge fades out
     */
    cropCircle(options?: CropCircleOptions): this;
    cropCircle(max?: boolean, feathering?: number): this;
    cropCircle(maxOrOptions: boolean | CropCircleOptions = false, featheringArgument = 0): this {
        const { max = false, feathering = 0 } = typeof maxOrOptions === 'object' && maxOrOptions !== null
            ? maxOrOptions : { max: maxOrOptions, feathering: featheringArgument };
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
     * @param absolute Whether to scale the current opacity (false) or just set the new opacity (true)
     */
    opacity(opacity: number, absolute = false): this {
        if (isNaN(opacity) || opacity < 0)
            throw new RangeError('Invalid opacity value');

        this.__set_channel_value__(opacity, absolute, 3);

        return this;
    }

    /**
     * Scales or sets the red channel
     * @param factor The factor to multiply the channel with (>= 0, results are clamped), or the value (0..1) to set it to
     * @param absolute Whether to scale the current value (false) or set every pixel's red channel to `factor` * 255 (true)
     */
    red(factor: number, absolute = false): this {
        if (isNaN(factor) || factor < 0)
            throw new RangeError('Invalid red factor');

        this.__set_channel_value__(factor, absolute, 0);

        return this;
    }

    /**
     * Scales or sets the green channel
     * @param factor The factor to multiply the channel with (>= 0, results are clamped), or the value (0..1) to set it to
     * @param absolute Whether to scale the current value (false) or set every pixel's green channel to `factor` * 255 (true)
     */
    green(factor: number, absolute = false): this {
        if (isNaN(factor) || factor < 0)
            throw new RangeError('Invalid green factor');

        this.__set_channel_value__(factor, absolute, 1);

        return this;
    }

    /**
     * Scales or sets the blue channel
     * @param factor The factor to multiply the channel with (>= 0, results are clamped), or the value (0..1) to set it to
     * @param absolute Whether to scale the current value (false) or set every pixel's blue channel to `factor` * 255 (true)
     */
    blue(factor: number, absolute = false): this {
        if (isNaN(factor) || factor < 0)
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
    /** @internal */
    protected __set_channel_value__(value: number, absolute: boolean, offset: number): void {
        for (let i = offset; i < this.bitmap.length; i += 4)
            this.bitmap[i] = value * (absolute ? 255 : this.bitmap[i]);
    }

    /**
     * Sets the brightness of the image
     * @param value The lightness to apply (0..1)
     * @param absolute Whether to scale the current lightness (false) or just set the new lightness (true)
     */
    lightness(value: number, absolute = false): this {
        if (isNaN(value) || value < 0)
            throw new RangeError('Invalid lightness value');

        return this.__map_hsla__(c => { c.l = value * (absolute ? 1 : c.l); });
    }

    /**
     * Sets the saturation of the image
     * @param value The saturation to apply (0..1)
     * @param absolute Whether to scale the current saturation (false) or just set the new saturation (true)
     */
    saturation(value: number, absolute = false): this {
        if (isNaN(value) || value < 0)
            throw new RangeError('Invalid saturation value');

        return this.__map_hsla__(c => { c.s = value * (absolute ? 1 : c.s); });
    }

    /**
     * Composites (overlays) the source onto this image at the specified coordinates
     * @param source The image to place
     * @param [x=0] The x position to place the image at
     * @param [y=0] The y position to place the image at
     * @param [options.opacity=1] Opacity of the source (0..1)
     * @param [options.mode='normal'] How the colors are mixed, like CSS' mix-blend-mode
     */
    composite(source: Image, x = 0, y = 0, { opacity = 1, mode = 'normal' }: CompositeOptions = {}): this {
        x |= 0;
        y |= 0;

        if (isNaN(opacity) || opacity < 0 || opacity > 1)
            throw new RangeError('Invalid composite opacity');
        const blend = BLEND_MODES[mode];
        if (!blend || !Object.prototype.hasOwnProperty.call(BLEND_MODES, mode))
            throw new RangeError(`Invalid blend mode: ${mode}`);
        if (opacity !== 1 || mode !== 'normal') return this.__blend__(source, x, y, opacity, blend);

        const left = Math.max(0, x), top = Math.max(0, y);
        const right = Math.min(this.width, x + source.width), bottom = Math.min(this.height, y + source.height);
        const dst = this.bitmap, src = source.bitmap;
        // whole pixels are copied through 32-bit views
        const dst32 = new Uint32Array(dst.buffer, dst.byteOffset, dst.length >> 2);
        const src32 = new Uint32Array(src.buffer, src.byteOffset, src.length >> 2);

        for (let row = top; row < bottom; row++) {
            for (let column = left; column < right; column++) {
                const sp = (row - y) * source.width + column - x, s = 4 * sp;
                const sa = src[s + 3];
                if (sa === 0) continue;

                const dp = row * this.width + column, d = 4 * dp;
                const da = dst[d + 3];
                if (sa === 255 || da === 0) {
                    dst32[dp] = src32[sp];
                    continue;
                }

                // source over with straight alpha, the clamped bitmap rounds on assignment
                const fa = sa / 255, ba = da / 255 * (1 - fa);
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
        return this.__map_hsla__(c => { c.h += degrees / 360; });
    }

    /**
     * Converts every pixel to HSLA, lets `map` adjust the components in place and converts back
     * (the same math as {@link Image.rgbaToHSLA} and {@link Image.hslaToColor}, without allocating per pixel)
     * @internal
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
        if (isNaN(radius) || radius < 0)
            throw new RangeError('Invalid blur radius');

        const pixels = premultiply(this.bitmap);
        gaussianBlur(pixels, this.width, this.height, radius);
        unpremultiply(pixels, this.bitmap);
        return this;
    }

    /**
     * Sharpens the image with an unsharp mask: the difference to a blurred copy is amplified
     * @param [amount=1] How strongly to sharpen (0 does nothing)
     * @param [radius=1] The radius of the blur the image is compared with (larger values sharpen coarser details)
     */
    sharpen(amount = 1, radius = 1): this {
        if (isNaN(amount) || amount < 0)
            throw new RangeError('Invalid sharpen amount');
        if (isNaN(radius) || radius <= 0)
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
        if (isNaN(factor) || factor < 0)
            throw new RangeError('Invalid brightness factor');
        return this.__map_channels__(v => v * factor);
    }

    /**
     * Scales the color channels' distance from mid grey, e.g. 1.5 increases the contrast, 0.5 reduces it
     * @param factor The factor (>= 0, 1 keeps the image, 0 makes it grey)
     */
    contrast(factor: number): this {
        if (isNaN(factor) || factor < 0)
            throw new RangeError('Invalid contrast factor');
        return this.__map_channels__(v => (v - 127.5) * factor + 127.5);
    }

    /**
     * Applies a gamma correction, values above 1 brighten the dark tones, values below 1 darken them
     * @param gamma The gamma (> 0, 1 keeps the image)
     */
    gamma(gamma: number): this {
        if (isNaN(gamma) || gamma <= 0)
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
     * Maps every color channel value through a function (evaluated once per value 0..255), alpha is kept
     * @internal
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
     * Gets the images dominant color: the colors are grouped into a few clusters (median cut and k-means),
     * the average color of the largest one is returned
     * @param [ignoreBlack=true] Whether to ignore dark colors (all channels below the threshold), or the options
     * @param [ignoreWhite=true] Whether to ignore light colors (all channels above 255 minus the threshold)
     * @param [bwThreshold=0xf] The black/white threshold (0-64, in steps of 4 channel values)
     * @return The images dominant color (fully opaque); mostly transparent pixels are ignored.
     *     If every pixel is ignored as black or white, the filter is dropped
     */
    dominantColor(options?: DominantColorOptions): Color;
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
     * @param [resize=true] Whether to resize the image so it fits all pixels or just ignore outlying pixels (or the options)
     */
    rotate(angle: number, options?: RotateOptions): this;
    rotate(angle: number, resize?: boolean): this;
    rotate(angle: number, resizeOrOptions: boolean | RotateOptions = true): this {
        const { resize = true } = typeof resizeOrOptions === 'object' && resizeOrOptions !== null ? resizeOrOptions : { resize: resizeOrOptions };
        angle = ((angle % 360) + 360) % 360;
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
    /** @internal the bitmap as a plain byte view */
    protected __bytes__(): Uint8Array {
        return new Uint8Array(this.bitmap.buffer, this.bitmap.byteOffset, this.bitmap.byteLength);
    }

    /** @internal */
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
        const positions = entries.map(e => parseFloat(e[0]));
        const values = entries.map(e => e[1]);

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
            let minPos = positions[i - 1];
            if (minPos === undefined) continue;

            let maxPos = positions[i];

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
     * @param [radius=min(width,height)/4] The radius of the corners
     */
    roundCorners(radius: number = Math.min(this.width, this.height) / 4): this {
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
    /** @internal */
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
     * @param [strength=2] The distortion strength (exponent of the radial mapping), higher values bulge the center more
     */
    fisheye(strength = 2): this {
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
     * @typedef {object} PNGMetadata
     * @property [title] The images title
     * @property [author] The images author
     * @property [description] The images description
     * @property [copyright] The images copyright info
     * @property [creationTime=Date.now()] The images creation timestamp
     * @property [software="github.com/matmen/ImageScript vX.X.X"] The software used to create this image
     * @property [disclaimer] A disclaimer for the image
     * @property [warning] A warning for the image
     * @property [source] The images source
     * @property [comment] A comment for the image
     */

    /**
     * Encodes the image into a PNG
     * @param [compression=1] The compression level (0-9), or the metadata. Uses the runtime's native zlib when available
     * @param [meta={}] Image metadata
     * @return The encoded data
     */
    encode(compression?: number, metadata?: PNGMetadata): Promise<Uint8Array>;
    encode(metadata?: PNGMetadata): Promise<Uint8Array>;
    async encode(compression: number | PNGMetadata = 1, meta: PNGMetadata = {}): Promise<Uint8Array> {
        if (typeof compression === 'object' && compression !== null) {
            meta = compression;
            compression = 1;
        }

        const level = Math.min(9, Math.max(0, ~~compression));
        const {
        title,
        author,
        description,
        copyright,
        creationTime,
        software,
        disclaimer,
        warning,
        source,
        comment
    } = meta || {};

        return png.encodeRGBA(this.__bytes__(), this.width, this.height, level, {
            Title: title,
            Author: author,
            Description: description,
            Copyright: copyright,
            'Creation Time': new Date(creationTime === undefined ? Date.now() : creationTime).toUTCString(),
            Software: software === undefined ? `github.com/matmen/ImageScript v${VERSION}` : software,
            Disclaimer: disclaimer,
            Warning: warning,
            Source: source,
            Comment: comment
        });
    }

    /**
     * Encodes the image into a PNG, an alias of {@link Image.encode}
     */
    encodePNG(compression?: number, metadata?: PNGMetadata): Promise<Uint8Array>;
    encodePNG(metadata?: PNGMetadata): Promise<Uint8Array>;
    encodePNG(compression?: number | PNGMetadata, metadata?: PNGMetadata): Promise<Uint8Array> {
        return this.encode(compression as number, metadata);
    }

    /**
     * Encodes the image into a JPEG
     * @param [quality=90] The JPEG quality to use (1-100), chroma subsampling is disabled above 90
     */
    async encodeJPEG(quality = 90): Promise<Uint8Array> {
        return jpeg.encode(this.__bytes__(), this.width, this.height, quality);
    }

    /**
     * Decodes an image (PNG, JPEG or TIFF)
     * @param data The binary data to decode
     * @param [options.applyOrientation=true] Whether to rotate/mirror JPEGs and TIFFs as their orientation tag (Exif) says,
     *     like browsers do: photos taken with a rotated camera are stored sideways and only displayed upright
     * @return The decoded image
     */
    static async decode(input: BinaryData, { applyOrientation = true }: DecodeOptions = {}): Promise<Image> {
        const data = view(input);
        const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

        let decoded: { width: number, height: number, pixels: Uint8Array, orientation?: number };
        if (ImageType.isPNG(dataView)) decoded = await png.decode(data);
        else if (ImageType.isJPEG(dataView)) decoded = jpeg.decode(data);
        else if (ImageType.isTIFF(dataView)) decoded = await tiff.decode(data);
        else throw new Error('Unsupported image type');

        const image = new Image(decoded.width, decoded.height);
        image.bitmap.set(decoded.pixels);
        return applyOrientation && decoded.orientation ? image.__orient__(decoded.orientation) : image;
    }

    /**
     * Applies an Exif orientation (1-8), turning the stored pixels into the displayed ones
     * @internal
     */
    protected __orient__(orientation: number): this {
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
     * Supports shapes, paths, transforms, use/symbol, CSS styles, gradients, strokes, clip paths, masks and opacity;
     * text, images, filters and patterns are not rendered
     * @param svg The SVG content
     * @param size The size to use
     * @param mode The SVG resizing mode to use (one of {@link SVG_MODE_SCALE}, {@link SVG_MODE_WIDTH}, {@link SVG_MODE_HEIGHT})
     * @return The rendered SVG graphic
     */
    static async renderSVG(svg: string | BinaryData, size = 1, mode: SVGScaleMode = Image.SVG_MODE_SCALE): Promise<Image> {
        if (![1, 2, 3].includes(mode))
            throw new Error('Invalid SVG scaling mode');

        if (mode === Image.SVG_MODE_SCALE && size <= 0)
            throw new RangeError('SVG scale must be > 0');
        if (mode !== Image.SVG_MODE_SCALE && size < 1)
            throw new RangeError('SVG size must be >= 1');

        const {width, height, pixels} = svgRenderer.render(typeof svg === 'string' ? svg : view(svg), mode, size);
        const image = new Image(width, height);
        image.bitmap.set(pixels);

        return image;
    }

    /**
     * Creates a new image containing the rendered text.
     * @param font TrueType (ttf/ttc) or OpenType (otf) font buffer to use
     * @param size Font size in pixels (per em)
     * @param text Text to render
     * @param [color=0xffffffff] Text color to use
     * @param [layout] The text layout to use
     * @param [style.strokeWidth=0] Width of an outline around the glyphs in pixels; the image grows by it on every side
     * @param [style.strokeColor=0x000000ff] Color of the outline
     * @return The rendered text
     */
    static async renderText(font: BinaryData, size: number, text: string, color: Color = 0xffffffff, layout: TextLayout = new TextLayout(), { strokeWidth = 0, strokeColor = 0x000000ff }: TextStyle = {}): Promise<Image> {
        if (isNaN(strokeWidth) || strokeWidth < 0)
            throw new RangeError('Invalid stroke width');

        const rendered = textRenderer.render(view(font), size, text, layout);
        const [r, g, b, a] = Image.colorToRGBA(color);

        // the outline needs room around the glyphs
        const pad = Math.ceil(strokeWidth);
        const width = rendered.width + 2 * pad, height = rendered.height + 2 * pad;
        const coverage = new Uint8Array(width * height);
        for (let y = 0; y < rendered.height; y++)
            coverage.set(rendered.coverage.subarray(y * rendered.width, (y + 1) * rendered.width), (y + pad) * width + pad);

        const image = new Image(width, height);
        const bitmap = image.bitmap;

        if (!strokeWidth) {
            for (let i = 0; i < coverage.length; i++) {
                if (!coverage[i]) continue;
                bitmap[i * 4] = r;
                bitmap[i * 4 + 1] = g;
                bitmap[i * 4 + 2] = b;
                bitmap[i * 4 + 3] = coverage[i] * a / 255;
            }
            return image;
        }

        const stroke = outline(coverage, width, height, strokeWidth);
        const [sr, sg, sb, sa] = Image.colorToRGBA(strokeColor);

        // the glyphs drawn over their outline
        for (let i = 0; i < coverage.length; i++) {
            const af = coverage[i] / 255 * a / 255, as = stroke[i] * sa / 255;
            const ao = af + as * (1 - af);
            if (ao <= 0) continue;

            bitmap[i * 4] = (r * af + sr * as * (1 - af)) / ao;
            bitmap[i * 4 + 1] = (g * af + sg * as * (1 - af)) / ao;
            bitmap[i * 4 + 2] = (b * af + sb * as * (1 - af)) / ao;
            bitmap[i * 4 + 3] = ao * 255;
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
 * transform, so the cost doesn't depend on the radius)
 * @return the outline's coverage (0..1) per pixel, including the area under the glyphs
 */
function outline(coverage: Uint8Array, width: number, height: number, radius: number): Float32Array {
    const count = width * height;
    // squared distance to the nearest pixel that is at least half covered
    const distance = new Float64Array(count);
    for (let i = 0; i < count; i++) distance[i] = coverage[i] >= 128 ? 0 : Infinity;

    const size = Math.max(width, height);
    const line = new Float64Array(size), result = new Float64Array(size);
    const parabolas = new Int32Array(size), bounds = new Float64Array(size + 1);

    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) line[y] = distance[y * width + x];
        distanceTransform(line, height, result, parabolas, bounds);
        for (let y = 0; y < height; y++) distance[y * width + x] = result[y];
    }

    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) line[x] = distance[row + x];
        distanceTransform(line, width, result, parabolas, bounds);
        for (let x = 0; x < width; x++) distance[row + x] = result[x];
    }

    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        // pixels next to the glyph edge are covered by the glyph's own antialiasing
        const d = Math.sqrt(distance[i]);
        out[i] = Math.max(coverage[i] / 255, Math.min(1, Math.max(0, radius + 0.5 - d)));
    }

    return out;
}

// 1D squared euclidean distance transform (Felzenszwalb & Huttenlocher): lower envelope of parabolas
function distanceTransform(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
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
    }
}
