import * as png from './codecs/png.ts';
import * as jpeg from './codecs/jpeg.ts';
import * as tiff from './codecs/tiff.ts';
import * as textRenderer from './render/text.ts';
import * as svgRenderer from './render/svg.ts';
import { BinaryData, view } from './util/mem.ts';
import { ImageType } from './image-type.ts';
import { TextLayout } from './text-layout.ts';
import { VERSION } from './version.ts';

/**
 * Represents an image; provides utility functions
 */
/** A color as a 32-bit RGBA integer (`0xRRGGBBAA`) */
export type Color = number;

/** Called with a pixel's (0-based) coordinates, returns its color */
export type ColorFunction = (x: number, y: number) => Color;

export type ResizeMode = 'RESIZE_NEAREST_NEIGHBOR';

export type SVGScaleMode = 1 | 2 | 3;

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
    protected __buffer__: ArrayBuffer;
    /** @internal */
    protected __view__: DataView;
    /** @internal */
    protected __u32__: Uint32Array;
    /** The image's RGBA pixel data */
    bitmap: Uint8ClampedArray;

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
        this.__buffer__ = new ArrayBuffer(width * height * 4);
        this.__view__ = new DataView(this.__buffer__);
        this.__u32__ = new Uint32Array(this.__buffer__);
        this.bitmap = new Uint8ClampedArray(this.__buffer__);
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
     * Converts RGBA components to an RGBA value
     * @param r red (0..255)
     * @param g green (0..255)
     * @param b blue (0..255)
     * @param a alpha (0..255)
     * @returns RGBA value
     */
    static rgbaToColor(r: number, g: number, b: number, a: number): Color {
        return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff)) >>> 0;
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
        h %= 1;
        s = Math.min(1, Math.max(0, s));
        l = Math.min(1, Math.max(0, l));
        a = Math.min(1, Math.max(0, a));

        let r: number, g: number, b: number;

        if (s === 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p: number, q: number, t: number): number => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };

            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;

            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }

        return Image.rgbaToColor(r * 255, g * 255, b * 255, a * 255);
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
     * Used for automatically preserving an images aspect ratio when resizing.
     */
    static get RESIZE_AUTO(): -1 {
        return -1;
    }

    /**
     * Resizes the image by the given factor
     * @param factor The factor to resize the image with
     * @param [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     */
    scale(factor: number, mode: ResizeMode = Image.RESIZE_NEAREST_NEIGHBOR): this {
        const image = this.__scale__(factor, mode);
        return this.__apply__(image);
    }

    /** @private */
    /** @internal */
    protected __scale__(factor: number, mode: ResizeMode = Image.RESIZE_NEAREST_NEIGHBOR): Image {
        if (factor === 1) return this;
        return this.__resize__(this.width * factor, this.height * factor, mode);
    }

    /**
     * Resizes the image to the given dimensions.
     * Use {@link Image.RESIZE_AUTO} as either width or height to automatically preserve the aspect ratio.
     * @param width The new width
     * @param height The new height
     * @param [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns The resized image
     */
    resize(width: number, height: number, mode: ResizeMode = Image.RESIZE_NEAREST_NEIGHBOR): this {
        const image = this.__resize__(width, height, mode);
        return this.__apply__(image);
    }

    /**
     * Resizes the image so it is contained in the given bounding box.
     * Can return an image with one axis smaller than the given bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns The resized image
     */
    contain(width: number, height: number, mode: ResizeMode = Image.RESIZE_NEAREST_NEIGHBOR): this {
        const scaleFactor = width / height > this.width / this.height ? height / this.height : width / this.width;
        return this.scale(scaleFactor, mode);
    }

    /**
     * Resizes the image so it is contained in the given bounding box, placing it in the center of the given bounding box.
     * Always returns the exact dimensions of the bounding box.
     * @param width The width of the bounding box
     * @param height The height of the bounding box
     * @param [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns The resized image
     */
    fit(width: number, height: number, mode: ResizeMode = Image.RESIZE_NEAREST_NEIGHBOR): this {
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
     * @param [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns The resized image
     */
    cover(width: number, height: number, mode: ResizeMode = Image.RESIZE_NEAREST_NEIGHBOR): this {
        const scaleFactor = width / height > this.width / this.height ? width / this.width : height / this.height;
        const result = this.scale(scaleFactor, mode);
        return result.crop((result.width - width) / 2, (result.height - height) / 2, width, height);
    }

    /** @private */
    /** @internal */
    protected __resize__(width: number, height: number, mode: ResizeMode = Image.RESIZE_NEAREST_NEIGHBOR): Image {
        if (width === Image.RESIZE_AUTO && height === Image.RESIZE_AUTO) throw new Error('RESIZE_AUTO can only be used for either width or height, not for both');
        else if (width === Image.RESIZE_AUTO) width = this.width / this.height * height;
        else if (height === Image.RESIZE_AUTO) height = this.height / this.width * width;

        width = Math.floor(width);
        height = Math.floor(height);
        if (width < 1)
            throw new RangeError('Image has to be at least 1 pixel wide');
        if (height < 1)
            throw new RangeError('Image has to be at least 1 pixel high');

        let image: Image;
        if (mode === Image.RESIZE_NEAREST_NEIGHBOR)
            image = this.__resize_nearest_neighbor__(width, height);
        else throw new Error('Invalid resize mode');

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

        for (let y = 0; y < height; y++) {
            const row = this.width * (y * (this.height / height) | 0);
            for (let x = 0; x < width; x++)
                dst[y * width + x] = src[row + (x * (this.width / width) | 0)];
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
     * Draws a circle around the specified center (0-based) with the specified radius
     * @param x The center x position
     * @param y The center y position
     * @param radius The circles radius
     * @param color The color, a function gets coordinates relative to the circle's bounding box
     */
    drawCircle(x: number, y: number, radius: number, color: Color | ColorFunction): this {
        x = ~~x;
        y = ~~y;
        const radSquared = radius ** 2;
        for (let currentY = Math.max(0, Math.ceil(y - radius)); currentY < Math.min(y + radius, this.height); currentY++) {
            for (let currentX = Math.max(0, Math.ceil(x - radius)); currentX < Math.min(x + radius, this.width); currentX++) {
                if ((currentX - x) ** 2 + (currentY - y) ** 2 < radSquared)
                    this.__set_pixel__(currentX, currentY, typeof color === 'function' ? color(currentX - x + radius, currentY - y + radius) : color);
            }
        }

        return this;
    }

    /**
     * Crops the image into a circle
     * @param [max=false] Whether to use the larger dimension for the size
     * @param [feathering=0] How much feathering to apply to the edges
     */
    cropCircle(max = false, feathering = 0): this {
        const radius = (max ? Math.max : Math.min)(this.width, this.height) / 2;
        const radiusSquared = radius ** 2;
        const centerX = this.width / 2;
        const centerY = this.height / 2;
        const featheringRoot = Math.sqrt(feathering);

        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const distance = (y - centerY) ** 2 + (x - centerX) ** 2;
                const alpha = 4 * (y * this.width + x) + 3;
                if (distance > radiusSquared) this.bitmap[alpha] = 0;
                else if (feathering) this.bitmap[alpha] *= Math.max(0, Math.min(1, 1 - distance / radiusSquared * featheringRoot));
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
     * Sets the red channels saturation
     * @param saturation The saturation to apply (0..1)
     * @param absolute Whether to scale the current saturation (false) or just set the new saturation (true)
     */
    red(saturation: number, absolute = false): this {
        if (isNaN(saturation) || saturation < 0)
            throw new RangeError('Invalid saturation value');

        this.__set_channel_value__(saturation, absolute, 0);

        return this;
    }

    /**
     * Sets the green channels saturation
     * @param saturation The saturation to apply (0..1)
     * @param absolute Whether to scale the current saturation (false) or just set the new saturation (true)
     */
    green(saturation: number, absolute = false): this {
        if (isNaN(saturation) || saturation < 0)
            throw new RangeError('Invalid saturation value');

        this.__set_channel_value__(saturation, absolute, 1);

        return this;
    }

    /**
     * Sets the blue channels saturation
     * @param saturation The saturation to apply (0..1)
     * @param absolute Whether to scale the current saturation (false) or just set the new saturation (true)
     */
    blue(saturation: number, absolute = false): this {
        if (isNaN(saturation) || saturation < 0)
            throw new RangeError('Invalid saturation value');

        this.__set_channel_value__(saturation, absolute, 2);

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

        return this.fill((x, y) => {
            const [h, s, l, a] = Image.rgbaToHSLA(...Image.colorToRGBA(this.getPixelAt(x, y)));
            return Image.hslaToColor(h, s, value * (absolute ? 1 : l), a);
        });
    }

    /**
     * Sets the saturation of the image
     * @param value The saturation to apply (0..1)
     * @param absolute Whether to scale the current saturation (false) or just set the new saturation (true)
     */
    saturation(value: number, absolute = false): this {
        if (isNaN(value) || value < 0)
            throw new RangeError('Invalid saturation value');

        return this.fill((x, y) => {
            const [h, s, l, a] = Image.rgbaToHSLA(...Image.colorToRGBA(this.getPixelAt(x, y)));
            return Image.hslaToColor(h, value * (absolute ? 1 : s), l, a);
        });
    }

    /**
     * Composites (overlays) the source onto this image at the specified coordinates
     * @param source The image to place
     * @param [x=0] The x position to place the image at
     * @param [y=0] The y position to place the image at
     */
    composite(source: Image, x = 0, y = 0): this {
        x |= 0;
        y |= 0;

        const left = Math.max(0, x), top = Math.max(0, y);
        const right = Math.min(this.width, x + source.width), bottom = Math.min(this.height, y + source.height);
        const dst = this.bitmap, src = source.bitmap;

        for (let row = top; row < bottom; row++) {
            for (let column = left; column < right; column++) {
                const s = 4 * ((row - y) * source.width + column - x);
                const sa = src[s + 3];
                if (sa === 0) continue;

                const d = 4 * (row * this.width + column);
                const da = dst[d + 3];
                if (sa === 255 || da === 0) {
                    dst[d] = src[s];
                    dst[d + 1] = src[s + 1];
                    dst[d + 2] = src[s + 2];
                    dst[d + 3] = sa;
                    continue;
                }

                // source over with straight alpha
                const fa = sa / 255, ba = da / 255 * (1 - fa);
                const a = fa + ba;
                dst[d] = (src[s] * fa + dst[d] * ba) / a + 0.5;
                dst[d + 1] = (src[s + 1] * fa + dst[d + 1] * ba) / a + 0.5;
                dst[d + 2] = (src[s + 2] * fa + dst[d + 2] * ba) / a + 0.5;
                dst[d + 3] = a * 255 + 0.5;
            }
        }

        return this;
    }

    /**
     * Inverts the images colors
     */
    invert(): this {
        for (const [x, y, color] of this.iterateWithColors())
            this.__set_pixel__(x, y, ((0xffffffff - color) & 0xffffff00) | (color & 0xff));

        return this;
    }

    /**
     * Inverts the images value (lightness)
     */
    invertValue(): this {
        for (const [x, y, color] of this.iterateWithColors()) {
            const [h, s, l, a] = Image.rgbaToHSLA(...Image.colorToRGBA(color));
            this.__set_pixel__(x, y, Image.hslaToColor(h, s, 1 - l, a));
        }

        return this;
    }

    /**
     * Inverts the images saturation
     */
    invertSaturation(): this {
        for (const [x, y, color] of this.iterateWithColors()) {
            const [h, s, l, a] = Image.rgbaToHSLA(...Image.colorToRGBA(color));
            this.__set_pixel__(x, y, Image.hslaToColor(h, 1 - s, l, a));
        }

        return this;
    }

    /**
     * Inverts the images hue
     */
    invertHue(): this {
        for (const [x, y, color] of this.iterateWithColors()) {
            const [h, s, l, a] = Image.rgbaToHSLA(...Image.colorToRGBA(color));
            this.__set_pixel__(x, y, Image.hslaToColor(1 - h, s, l, a));
        }

        return this;
    }

    /**
     * Shifts the images hue
     * @param degrees How many degrees to shift the hue by
     */
    hueShift(degrees: number): this {
        for (const [x, y, color] of this.iterateWithColors()) {
            const [h, s, l, a] = Image.rgbaToHSLA(...Image.colorToRGBA(color));
            this.__set_pixel__(x, y, Image.hslaToColor(h + degrees / 360, s, l, a));
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
     * Gets the images dominant color
     * @param [ignoreBlack=true] Whether to ignore dark colors below the threshold
     * @param [ignoreWhite=true] Whether to ignore light colors above the threshold
     * @param [bwThreshold=0xf] The black/white threshold (0-64)
     * @return The images dominant color (fully transparent pixels are ignored)
     */
    dominantColor(ignoreBlack = true, ignoreWhite = true, bwThreshold = 0xf): Color {
        const colorCounts: number[] = new Array(0x40000);
        for (let i = 0; i < this.bitmap.length; i += 4) {
            if (this.bitmap[i + 3] === 0) continue;
            const color = this.__view__.getUint32(i, false);
            const [h, s, l] = Image.rgbaToHSLA(...Image.colorToRGBA(color)).map(v => (~~(v * 0x3f)));
            if (ignoreBlack && l < bwThreshold) continue;
            if (ignoreWhite && l > 0x3f - bwThreshold) continue;
            const key = h << 12 | s << 6 | l;
            colorCounts[key] = (colorCounts[key] || 0) + 1;
        }

        let maxColorCount = -1;
        let mostProminentValue = 0;
        colorCounts.forEach((el, i) => {
            if (el < maxColorCount) return;
            maxColorCount = el;
            mostProminentValue = i;
        });

        // nothing left after ignoring dark/light colors: relax the threshold
        if (maxColorCount === -1) {
            if (bwThreshold > 0 && (ignoreBlack || ignoreWhite))
                return this.dominantColor(ignoreBlack, ignoreWhite, bwThreshold - 1);
            return Image.rgbaToColor(0, 0, 0, 0xff);
        }

        const h = (mostProminentValue >>> 12) & 0x3f;
        const s = (mostProminentValue >>> 6) & 0x3f;
        const l = mostProminentValue & 0x3f;

        return Image.hslaToColor(h / 0x3f, s / 0x3f, l / 0x3f, 1);
    }

    /**
     * Rotates the image counterclockwise by the given amount of degrees
     * @param angle The angle to rotate the image for (in degrees)
     * @param resize Whether to resize the image so it fits all pixels or just ignore outlying pixels
     */
    rotate(angle: number, resize = true): this {
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
                const fx = sx - x0, fy = sy - y0;

                let r = 0, g = 0, b = 0, a = 0;
                for (const [px, py, weight] of [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]] as Array<[number, number, number]>) {
                    if (px < 0 || py < 0 || px >= width || py >= height || weight === 0) continue;
                    const i = 4 * (py * width + px);
                    const wa = weight * s8[i + 3];
                    r += wa * s8[i];
                    g += wa * s8[i + 1];
                    b += wa * s8[i + 2];
                    a += wa;
                }

                if (a <= 0) continue;
                const o = 4 * (oy * outWidth + ox);
                d8[o] = r / a + 0.5;
                d8[o + 1] = g / a + 0.5;
                d8[o + 2] = b / a + 0.5;
                d8[o + 3] = a + 0.5;
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
        this.__buffer__ = image.__buffer__;
        this.__view__ = image.__view__;
        this.__u32__ = image.__u32__;
        this.bitmap = image.bitmap;

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
     * Rounds the images corners
     * @param [radius=min(width,height)/4] The radius of the corners
     */
    roundCorners(radius: number = Math.min(this.width, this.height) / 4): this {
        radius = Math.min(radius, this.width / 2, this.height / 2);
        const size = Math.ceil(radius);

        // pixels whose center lies outside the corner circle become transparent
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = radius - (x + 0.5), dy = radius - (y + 0.5);
                if (dx <= 0 || dy <= 0 || dx * dx + dy * dy <= radius * radius) continue;

                for (const [px, py] of [[x, y], [this.width - 1 - x, y], [x, this.height - 1 - y], [this.width - 1 - x, this.height - 1 - y]])
                    this.bitmap[(py * this.width + px) * 4 + 3] = 0;
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
     * @param [radius=2] The distortion strength, higher values bulge the center more
     */
    fisheye(radius = 2): this {
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

                const dis = 2 * dfc ** radius;
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
     * @param [compression=1] The compression level to use (0-9), or the metadata
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

        return png.encode(this.__bytes__(), {
            width: this.width,
            height: this.height,
            level,
            channels: 4,
            text: {
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
            }
        });
    }

    /**
     * Encodes the image into a JPEG
     * @param [quality=90] The JPEG quality to use (1-100), chroma subsampling is disabled above 90
     */
    async encodeJPEG(quality = 90): Promise<Uint8Array> {
        return jpeg.encode(this.__bytes__(), this.width, this.height, quality);
    }

    /**
     * WebP encoding was removed when ImageScript became dependency free, use PNG or JPEG instead
     * @deprecated
     */
    async encodeWEBP(): Promise<never> {
        throw new Error('WebP encoding is no longer supported, use encode() (PNG) or encodeJPEG() instead');
    }

    /**
     * Decodes an image (PNG, JPEG or TIFF)
     * @param data The binary data to decode
     * @return The decoded image
     */
    static async decode(input: BinaryData): Promise<Image> {
        let image: Image;

        const data = view(input);
        const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

        if (ImageType.isPNG(dataView)) { // PNG
            const {width, height, pixels} = await png.decode(data);
            image = new Image(width, height);
            image.bitmap.set(pixels);
        } else if (ImageType.isJPEG(dataView)) { // JPEG
            const {width, height, pixels} = jpeg.decode(data);
            image = new Image(width, height);
            image.bitmap.set(pixels);
        } else if (ImageType.isTIFF(dataView)) { // TIFF
            const {width, height, pixels} = await tiff.decode(data);
            image = new Image(width, height);
            image.bitmap.set(pixels);
        } else throw new Error('Unsupported image type');

        return image;
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
     * @param scale Font size to use
     * @param text Text to render
     * @param [color=0xffffffff] Text color to use
     * @param [layout] The text layout to use
     * @return The rendered text
     */
    static async renderText(font: BinaryData, scale: number, text: string, color: Color = 0xffffffff, layout: TextLayout = new TextLayout()): Promise<Image> {
        const {width, height, coverage} = textRenderer.render(view(font), scale, text, layout);
        const [r, g, b, a] = Image.colorToRGBA(color);

        const image = new Image(width, height);
        for (let i = 0; i < coverage.length; i++) {
            if (!coverage[i]) continue;
            image.bitmap[i * 4] = r;
            image.bitmap[i * 4 + 1] = g;
            image.bitmap[i * 4 + 2] = b;
            image.bitmap[i * 4 + 3] = coverage[i];
        }

        return image.opacity(a / 0xff);
    }

}

