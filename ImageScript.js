const png = require('./formats/png.js');
const gif = require('./formats/gif.js');
const jpeg = require('./formats/jpeg.js');
const tiff = require('./formats/tiff.js');
const textRenderer = require('./formats/text.js');
const svgRenderer = require('./formats/svg.js');
const mem = require('./utils/mem.js');
const {version} = require('./package.json');

// old

const MAGIC_NUMBERS = {
    PNG: 0x89504e47,
    JPEG: 0xffd8ff,
    TIFF_LE: 0x49492a00,
    TIFF_BE: 0x4d4d002a,
    BIGTIFF_LE: 0x49492b00,
    BIGTIFF_BE: 0x4d4d002b,
    GIF: 0x474946
};

/**
 * Represents an image; provides utility functions
 */
class Image {
    /**
     * Creates a new image with the given dimensions
     * @param {number} width
     * @param {number} height
     * @returns {Image}
     */
    constructor(width, height) {
        width = ~~width;
        height = ~~height;

        if (width < 1)
            throw new RangeError('Image has to be at least 1 pixel wide');
        if (height < 1)
            throw new RangeError('Image has to be at least 1 pixel high');

        /** @private */
        this.__width__ = width;
        /** @private */
        this.__height__ = height;
        /** @private */
        this.__buffer__ = new ArrayBuffer(width * height * 4);
        /** @private */
        this.__view__ = new DataView(this.__buffer__);
        /** @private */
        this.__u32__ = new Uint32Array(this.__buffer__);
        /**
         * The images RGBA pixel data
         * @type {Uint8ClampedArray}
         */
        this.bitmap = new Uint8ClampedArray(this.__buffer__);
    }

    /**
     * @private
     * @returns {string}
     */
    toString() {
        return `Image<${this.width}x${this.height}>`;
    }

    /**
     * The images width
     * @returns {number}
     */
    get width() {
        return this.__width__;
    }

    /**
     * The images height
     * @returns {number}
     */
    get height() {
        return this.__height__;
    }

    /**
     * Yields an [x, y] array for every pixel in the image
     * @yields {number[]} The coordinates of the pixel ([x, y])
     * @returns {void}
     */
    *[Symbol.iterator]() {
        for (let y = 1; y <= this.height; y++)
            for (let x = 1; x <= this.width; x++)
                yield [x, y];
    }

    /**
     * Yields an [x, y, color] array for every pixel in the image
     * @yields {number[]} The coordinates and color of the pixel ([x, y, color])
     */
    *iterateWithColors() {
        const view = new DataView(this.bitmap.buffer, this.bitmap.byteOffset, this.bitmap.byteLength);
        let offset = 0;
        for (let y = 1; y <= this.height; y++)
            for (let x = 1; x <= this.width; x++, offset += 4)
                yield [x, y, view.getUint32(offset, false)];
    }

    /**
     * Converts RGBA components to an RGBA value
     * @param {number} r red (0..255)
     * @param {number} g green (0..255)
     * @param {number} b blue (0..255)
     * @param {number} a alpha (0..255)
     * @returns {number} RGBA value
     */
    static rgbaToColor(r, g, b, a) {
        return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff)) >>> 0;
    }

    /**
     * Converts RGB components to an RGBA value (assuming alpha = 255)
     * @param {number} r red (0..255)
     * @param {number} g green (0..255)
     * @param {number} b blue (0..255)
     * @returns {number} RGBA value
     */
    static rgbToColor(r, g, b) {
        return Image.rgbaToColor(r, g, b, 0xff);
    }

    /**
     * Converts HSLA colors to RGBA colors
     * @param {number} h hue (0..1)
     * @param {number} s saturation (0..1)
     * @param {number} l lightness (0..1)
     * @param {number} a opacity (0..1)
     * @returns {number} color
     */
    static hslaToColor(h, s, l, a) {
        h %= 1;
        s = Math.min(1, Math.max(0, s));
        l = Math.min(1, Math.max(0, l));
        a = Math.min(1, Math.max(0, a));

        let r, g, b;

        if (s === 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p, q, t) => {
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
     * @param {number} h hue (0..1)
     * @param {number} s saturation (0..1)
     * @param {number} l lightness (0..1)
     * @returns {number} color
     */
    static hslToColor(h, s, l) {
        return Image.hslaToColor(h, s, l, 1);
    }

    /**
     * Converts an RGBA value to an array of HSLA values
     * @param r {number} (0..255)
     * @param g {number} (0..255)
     * @param b {number} (0..255)
     * @param a {number} (0..255)
     * @returns {number[]} The HSLA values ([H, S, L, A])
     */
    static rgbaToHSLA(r, g, b, a) {
        r /= 255;
        g /= 255;
        b /= 255;

        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;

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
     * @param {number} color The color value to convert
     * @returns {number[]} The RGBA values ([R, G, B, A])
     */
    static colorToRGBA(color) {
        return [(color >> 24) & 0xff, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
    }

    /**
     * Converts a color value to an array of RGB values (ignoring the colors alpha)
     * @param {number} color The color value to convert
     * @returns {number[]} The RGB values ([R, G, B])
     */
    static colorToRGB(color) {
        return Image.colorToRGBA(color).slice(0, 3);
    }

    /**
     * Gets the pixel color at the specified position
     * @param {number} x
     * @param {number} y
     * @returns {number} The color value
     */
    getPixelAt(x, y) {
        this.__check_boundaries__(x, y);
        return this.__view__.getUint32(((~~y - 1) * this.width + (~~x - 1)) * 4, false);
    }

    /**
     * Gets the pixel color at the specified position
     * @param {number} x
     * @param {number} y
     * @returns {Uint8ClampedArray} The RGBA value
     */
    getRGBAAt(x, y) {
        this.__check_boundaries__(x, y);
        const idx = ((~~y - 1) * this.width + (~~x - 1)) * 4;
        return this.bitmap.subarray(idx, idx + 4);
    }

    /**
     * Sets the pixel color for the specified position
     * @param {number} x
     * @param {number} y
     * @param {number} pixelColor
     */
    setPixelAt(x, y, pixelColor) {
        x = ~~x;
        y = ~~y;
        this.__check_boundaries__(x, y);
        this.__set_pixel__(x, y, pixelColor);
        return this;
    }

    /**
     * @private
     * @param {number} x
     * @param {number} y
     * @param {number} pixelColor
     */
    __set_pixel__(x, y, pixelColor) {
        this.__view__.setUint32(((y - 1) * this.width + (x - 1)) * 4, pixelColor, false);
    }

    /**
     * @private
     * @param {number} x
     * @param {number} y
     */
    __check_boundaries__(x, y) {
        if (isNaN(x)) throw new TypeError(`Invalid pixel coordinates (x=${x})`);
        if (isNaN(y)) throw new TypeError(`Invalid pixel coordinates (y=${y})`);
        if (x < 1)
            throw new RangeError(`${Image.__out_of_bounds__} (x=${x})<1`);
        if (x > this.width)
            throw new RangeError(`${Image.__out_of_bounds__} (x=${x})>(width=${this.width})`);
        if (y < 1)
            throw new RangeError(`${Image.__out_of_bounds__} (y=${y})<1`);
        if (y > this.height)
            throw new RangeError(`${Image.__out_of_bounds__} (y=${y})>(height=${this.height})`);
    }

    /**
     * @private
     */
    static get __out_of_bounds__() {
        return 'Tried referencing a pixel outside of the images boundaries:';
    }

    /**
     * @callback colorFunction
     * @param {number} x
     * @param {number} y
     * @returns {number} pixel color
     */

    /**
     * Fills the image data with the supplied color
     * @param {number|colorFunction} color
     * @returns {Image}
     */
    fill(color) {
        const view = new DataView(this.bitmap.buffer, this.bitmap.byteOffset, this.bitmap.byteLength);

        if (typeof color === 'function') {
            let offset = 0;
            for (let y = 1; y <= this.height; y++)
                for (let x = 1; x <= this.width; x++, offset += 4)
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
     * @returns {Image}
     */
    clone() {
        const image = new Image(this.width, this.height);
        image.bitmap.set(this.bitmap);
        return image;
    }

    /**
     * Use {@link https://en.wikipedia.org/wiki/Image_scaling#Nearest-neighbor_interpolation Nearest-neighbor} resizing.
     * @returns {string}
     */
    static get RESIZE_NEAREST_NEIGHBOR() {
        return 'RESIZE_NEAREST_NEIGHBOR';
    }

    /**
     * Used for automatically preserving an images aspect ratio when resizing.
     * @returns {number}
     */
    static get RESIZE_AUTO() {
        return -1;
    }

    /**
     * Resizes the image by the given factor
     * @param {number} factor The factor to resize the image with
     * @param {string} [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns {Image}
     */
    scale(factor, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        const image = this.__scale__(factor, mode);
        return this.__apply__(image);
    }

    /** @private */
    __scale__(factor, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        if (factor === 1) return this;
        return this.__resize__(this.width * factor, this.height * factor, mode);
    }

    /**
     * Resizes the image to the given dimensions.
     * Use {@link Image.RESIZE_AUTO} as either width or height to automatically preserve the aspect ratio.
     * @param {number} width The new width
     * @param {number} height The new height
     * @param {string} [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns {Image} The resized image
     */
    resize(width, height, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        const image = this.__resize__(width, height, mode);
        return this.__apply__(image);
    }

    /**
     * Resizes the image so it is contained in the given bounding box.
     * Can return an image with one axis smaller than the given bounding box.
     * @param {number} width The width of the bounding box
     * @param {number} height The height of the bounding box
     * @param {string} [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns {Image} The resized image
     */
    contain(width, height, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        const scaleFactor = width / height > this.width / this.height ? height / this.height : width / this.width;
        return this.scale(scaleFactor, mode);
    }

    /**
     * Resizes the image so it is contained in the given bounding box, placing it in the center of the given bounding box.
     * Always returns the exact dimensions of the bounding box.
     * @param {number} width The width of the bounding box
     * @param {number} height The height of the bounding box
     * @param {string} [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns {Image} The resized image
     */
    fit(width, height, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        const result = new Image(width, height);
        this.contain(width, height, mode);
        result.composite(this, (width - this.width) / 2, (height - this.height) / 2);
        return this.__apply__(result);
    }

    /**
     * Resizes the image so it covers the given bounding box, cropping the overflowing edges.
     * Always returns the exact dimensions of the bounding box.
     * @param {number} width The width of the bounding box
     * @param {number} height The height of the bounding box
     * @param {string} [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns {Image} The resized image
     */
    cover(width, height, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        const scaleFactor = width / height > this.width / this.height ? width / this.width : height / this.height;
        const result = this.scale(scaleFactor, mode);
        return result.crop((result.width - width) / 2, (result.height - height) / 2, width, height);
    }

    /** @private */
    __resize__(width, height, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        if (width === Image.RESIZE_AUTO && height === Image.RESIZE_AUTO) throw new Error('RESIZE_AUTO can only be used for either width or height, not for both');
        else if (width === Image.RESIZE_AUTO) width = this.width / this.height * height;
        else if (height === Image.RESIZE_AUTO) height = this.height / this.width * width;

        width = Math.floor(width);
        height = Math.floor(height);
        if (width < 1)
            throw new RangeError('Image has to be at least 1 pixel wide');
        if (height < 1)
            throw new RangeError('Image has to be at least 1 pixel high');

        let image;
        if (mode === Image.RESIZE_NEAREST_NEIGHBOR)
            image = this.__resize_nearest_neighbor__(width, height);
        else throw new Error('Invalid resize mode');

        return image;
    }

    /**
     * @private
     * @param {number} width The new width
     * @param {number} height The new height
     */
    __resize_nearest_neighbor__(width, height) {
        const image = new this.constructor(width, height);
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
     * @param {number} x The x offset (0-based)
     * @param {number} y The y offset (0-based)
     * @param {number} width The new images width
     * @param {number} height The new images height
     * @returns {Image}
     */
    crop(x, y, width, height) {
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
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @returns {Image}
     * @private
     */
    __crop__(x, y, width, height) {
        x = ~~x;
        y = ~~y;

        const image = new this.constructor(width, height);

        for (let tY = 0; tY < height; tY++) {
            const idx = (tY + y) * this.width + x;
            image.__u32__.set(this.__u32__.subarray(idx, idx + width), tY * width);
        }

        return image;
    }

    /**
     * Draws a box at the specified coordinates
     * @param {number} x The x offset
     * @param {number} y The y offset
     * @param {number} width The box width
     * @param {number} height The box height
     * @param {number|colorFunction} color The color to fill the box in with
     * @returns {Image}
     */
    drawBox(x, y, width, height, color) {
        x = ~~(x - 1);
        y = ~~(y - 1);
        width = ~~width;
        height = ~~height;

        if (typeof color === 'function') {
            for (let tY = 1; tY <= height; tY++) {
                for (let tX = 1; tX <= width; tX++) {
                    const nX = tX + x;
                    const nY = tY + y;
                    if (Math.min(nX, nY) < 1 || nX > this.width || nY > this.height)
                        continue;

                    const tC = color(tX, tY);
                    this.__set_pixel__(nX, nY, tC);
                }
            }
        } else return this.__fast_box__(x, y, width, height, color);

        return this;
    }

    /**
     * @private
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {number} color
     */
    __fast_box__(x, y, width, height, color) {
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
     * Draws a circle at the specified coordinates with the specified radius
     * @param {number} x The center x position
     * @param {number} y The center y position
     * @param {number} radius The circles radius
     * @param {number|colorFunction} color
     * @returns {Image}
     */
    drawCircle(x, y, radius, color) {
        const radSquared = radius ** 2;
        for (let currentY = Math.max(1, y - radius); currentY <= Math.min(y + radius, this.height); currentY++) {
            for (let currentX = Math.max(1, x - radius); currentX <= Math.min(x + radius, this.width); currentX++) {
                if ((currentX - x) ** 2 + (currentY - y) ** 2 < radSquared)
                    this.__set_pixel__(currentX, currentY, typeof color === 'function' ? color(currentX - x + radius, currentY - y + radius) : color);
            }
        }

        return this;
    }

    /**
     * Crops the image into a circle
     * @param {boolean} [max=false] Whether to use the larger dimension for the size
     * @param {number} [feathering=0] How much feathering to apply to the edges
     * @returns {Image}
     */
    cropCircle(max = false, feathering = 0) {
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
     * @param {number} opacity The opacity to apply (0..1)
     * @param {boolean} absolute Whether to scale the current opacity (false) or just set the new opacity (true)
     * @returns {Image}
     */
    opacity(opacity, absolute = false) {
        if (isNaN(opacity) || opacity < 0)
            throw new RangeError('Invalid opacity value');

        this.__set_channel_value__(opacity, absolute, 3);

        return this;
    }

    /**
     * Sets the red channels saturation
     * @param {number} saturation The saturation to apply (0..1)
     * @param {boolean} absolute Whether to scale the current saturation (false) or just set the new saturation (true)
     * @returns {Image}
     */
    red(saturation, absolute = false) {
        if (isNaN(saturation) || saturation < 0)
            throw new RangeError('Invalid saturation value');

        this.__set_channel_value__(saturation, absolute, 0);

        return this;
    }

    /**
     * Sets the green channels saturation
     * @param {number} saturation The saturation to apply (0..1)
     * @param {boolean} absolute Whether to scale the current saturation (false) or just set the new saturation (true)
     * @returns {Image}
     */
    green(saturation, absolute = false) {
        if (isNaN(saturation) || saturation < 0)
            throw new RangeError('Invalid saturation value');

        this.__set_channel_value__(saturation, absolute, 1);

        return this;
    }

    /**
     * Sets the blue channels saturation
     * @param {number} saturation The saturation to apply (0..1)
     * @param {boolean} absolute Whether to scale the current saturation (false) or just set the new saturation (true)
     * @returns {Image}
     */
    blue(saturation, absolute = false) {
        if (isNaN(saturation) || saturation < 0)
            throw new RangeError('Invalid saturation value');

        this.__set_channel_value__(saturation, absolute, 2);

        return this;
    }

    /**
     * @private
     * @param {number} value
     * @param {boolean} absolute
     * @param {number} offset
     */
    __set_channel_value__(value, absolute, offset) {
        for (let i = offset; i < this.bitmap.length; i += 4)
            this.bitmap[i] = value * (absolute ? 255 : this.bitmap[i]);
    }

    /**
     * Sets the brightness of the image
     * @param {number} value The lightness to apply (0..1)
     * @param {boolean} absolute Whether to scale the current lightness (false) or just set the new lightness (true)
     * @returns {Image}
     */
    lightness(value, absolute = false) {
        if (isNaN(value) || value < 0)
            throw new RangeError('Invalid lightness value');

        return this.fill((x, y) => {
            const [h, s, l, a] = Image.rgbaToHSLA(...this.getRGBAAt(x, y));
            return Image.hslaToColor(h, s, value * (absolute ? 1 : l), a);
        });
    }

    /**
     * Sets the saturation of the image
     * @param {number} value The saturation to apply (0..1)
     * @param {boolean} absolute Whether to scale the current saturation (false) or just set the new saturation (true)
     * @returns {Image}
     */
    saturation(value, absolute = false) {
        if (isNaN(value) || value < 0)
            throw new RangeError('Invalid saturation value');

        return this.fill((x, y) => {
            const [h, s, l, a] = Image.rgbaToHSLA(...this.getRGBAAt(x, y));
            return Image.hslaToColor(h, value * (absolute ? 1 : s), l, a);
        });
    }

    /**
     * Composites (overlays) the source onto this image at the specified coordinates
     * @param {Image} source The image to place
     * @param {number} [x=0] The x position to place the image at
     * @param {number} [y=0] The y position to place the image at
     * @returns {Image}
     */
    composite(source, x = 0, y = 0) {
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
     * @returns {Image}
     */
    invert() {
        for (const [x, y, color] of this.iterateWithColors())
            this.__set_pixel__(x, y, ((0xffffffff - color) & 0xffffff00) | (color & 0xff));

        return this;
    }

    /**
     * Inverts the images value (lightness)
     * @returns {Image}
     */
    invertValue() {
        for (const [x, y, color] of this.iterateWithColors()) {
            const [h, s, l, a] = Image.rgbaToHSLA(...Image.colorToRGBA(color));
            this.__set_pixel__(x, y, Image.hslaToColor(h, s, 1 - l, a));
        }

        return this;
    }

    /**
     * Inverts the images saturation
     * @returns {Image}
     */
    invertSaturation() {
        for (const [x, y, color] of this.iterateWithColors()) {
            const [h, s, l, a] = Image.rgbaToHSLA(...Image.colorToRGBA(color));
            this.__set_pixel__(x, y, Image.hslaToColor(h, 1 - s, l, a));
        }

        return this;
    }

    /**
     * Inverts the images hue
     * @returns {Image}
     */
    invertHue() {
        for (const [x, y, color] of this.iterateWithColors()) {
            const [h, s, l, a] = Image.rgbaToHSLA(...Image.colorToRGBA(color));
            this.__set_pixel__(x, y, Image.hslaToColor(1 - h, s, l, a));
        }

        return this;
    }

    /**
     * Shifts the images hue
     * @param {number} degrees How many degrees to shift the hue by
     */
    hueShift(degrees) {
        for (const [x, y, color] of this.iterateWithColors()) {
            const [h, s, l, a] = Image.rgbaToHSLA(...Image.colorToRGBA(color));
            this.__set_pixel__(x, y, Image.hslaToColor(h + degrees / 360, s, l, a));
        }

        return this;
    }

    /**
     * Gets the average color of the image, weighting each pixel by its opacity
     * @returns {number} The average color (fully opaque), black for fully transparent images
     */
    averageColor() {
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
     * @param {boolean} [ignoreBlack=true] Whether to ignore dark colors below the threshold
     * @param {boolean} [ignoreWhite=true] Whether to ignore light colors above the threshold
     * @param {number} [bwThreshold=0xf] The black/white threshold (0-64)
     * @return {number} The images dominant color (fully transparent pixels are ignored)
     */
    dominantColor(ignoreBlack = true, ignoreWhite = true, bwThreshold = 0xf) {
        const colorCounts = new Array(0x40000);
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
     * @param {number} angle The angle to rotate the image for (in degrees)
     * @param {boolean} resize Whether to resize the image so it fits all pixels or just ignore outlying pixels
     */
    rotate(angle, resize = true) {
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
                for (const [px, py, weight] of [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]]) {
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
     * @param {'horizontal' | 'vertical'} direction The direction to flip
     */
    flip(direction) {
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
     * @param {Image|Frame} image
     * @returns {Image|Frame}
     */
    __apply__(image) {
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
     * @param {Object<number, number>} colors The gradient points to use (e.g. `{0: 0xff0000ff, 1: 0x00ff00ff}`)
     * @return {(function(number): number)} The gradient generator. The function argument is the position in the gradient (0..1).
     */
    static gradient(colors) {
        const entries = Object.entries(colors).sort((a, b) => a[0] - b[0]);
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
        let gradients = [];

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
     * @param {number} [radius=min(width,height)/4] The radius of the corners
     * @return {Image}
     */
    roundCorners(radius = Math.min(this.width, this.height) / 4) {
        const radSquared = radius ** 2;
        for (let x = 1; x <= radius; x++) {
            const xRad = (x - radius) ** 2;
            for (let y = 1; y <= radius; y++) {
                if (xRad + (y - radius) ** 2 > radSquared)
                    this.bitmap[((y - 1) * this.width + x - 1) * 4 + 3] = 0;
            }
        }

        for (let x = 1; x <= radius; x++) {
            const xRad = (x - radius) ** 2;
            for (let y = this.height - radius; y <= this.height; y++) {
                if (xRad + ((this.height - y) - radius) ** 2 > radSquared)
                    this.bitmap[((y - 1) * this.width + x - 1) * 4 + 3] = 0;
            }
        }

        for (let x = this.width - radius; x <= this.width; x++) {
            const xRad = ((this.width - x) - radius) ** 2;
            for (let y = 1; y <= radius; y++) {
                if (xRad + (y - radius) ** 2 > radSquared)
                    this.bitmap[((y - 1) * this.width + x - 1) * 4 + 3] = 0;
            }
        }

        for (let x = this.width - radius; x <= this.width; x++) {
            const xRad = ((this.width - x) - radius) ** 2;
            for (let y = this.height - radius; y <= this.height; y++) {
                if (xRad + ((this.height - y) - radius) ** 2 > radSquared)
                    this.bitmap[((y - 1) * this.width + x - 1) * 4 + 3] = 0;
            }
        }

        return this;
    }

    /**
     * @private
     */
    static __gradient__(startColor, endColor) {
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
     * @param {number} [radius=2] The distortion strength, higher values bulge the center more
     * @returns {Image}
     */
    fisheye(radius = 2) {
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
     * @property {string} [title] The images title
     * @property {string} [author] The images author
     * @property {string} [description] The images description
     * @property {string} [copyright] The images copyright info
     * @property {string|number|Date} [creationTime=Date.now()] The images creation timestamp
     * @property {string} [software="github.com/matmen/ImageScript vX.X.X"] The software used to create this image
     * @property {string} [disclaimer] A disclaimer for the image
     * @property {string} [warning] A warning for the image
     * @property {string} [source] The images source
     * @property {string} [comment] A comment for the image
     */

    /**
     * Encodes the image into a PNG
     * @param {number|PNGMetadata} [compression=1] The compression level to use (0-9), or the metadata
     * @param {PNGMetadata} [meta={}] Image metadata
     * @return {Promise<Uint8Array>} The encoded data
     */
    async encode(compression = 1, meta = {}) {
        if (typeof compression === 'object' && compression !== null) {
            meta = compression;
            compression = 1;
        }

        compression = Math.min(9, Math.max(0, ~~compression));
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

        return png.encode(this.bitmap, {
            width: this.width,
            height: this.height,
            level: compression,
            channels: 4,
            text: {
                Title: title,
                Author: author,
                Description: description,
                Copyright: copyright,
                'Creation Time': new Date(creationTime === undefined ? Date.now() : creationTime).toUTCString(),
                Software: software === undefined ? `github.com/matmen/ImageScript v${version}` : software,
                Disclaimer: disclaimer,
                Warning: warning,
                Source: source,
                Comment: comment
            }
        });
    }

    /**
     * Encodes the image into a JPEG
     * @param {number} [quality=90] The JPEG quality to use (1-100), chroma subsampling is disabled above 90
     * @return {Promise<Uint8Array>}
     */
    async encodeJPEG(quality = 90) {
        return jpeg.encode(this.bitmap, this.width, this.height, quality);
    }

    /**
     * WebP encoding was removed when ImageScript became dependency free, use PNG or JPEG instead
     * @deprecated
     * @return {Promise<never>}
     */
    async encodeWEBP() {
        throw new Error('WebP encoding is no longer supported, use encode() (PNG) or encodeJPEG() instead');
    }

    /**
     * Decodes an image (PNG, JPEG or TIFF)
     * @param {Buffer|Uint8Array} data The binary data to decode
     * @return {Promise<Image>} The decoded image
     */
    static async decode(data) {
        let image;

        data = mem.view(data);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        if (ImageType.isPNG(view)) { // PNG
            const {width, height, pixels} = png.decode(data);
            image = new Image(width, height);
            image.bitmap.set(pixels);
        } else if (ImageType.isJPEG(view)) { // JPEG
            const {width, height, pixels} = jpeg.decode(data);
            image = new Image(width, height);
            image.bitmap.set(pixels);
        } else if (ImageType.isTIFF(view)) { // TIFF
            const {width, height, pixels} = tiff.decode(data);
            image = new Image(width, height);
            image.bitmap.set(pixels);
        } else throw new Error('Unsupported image type');

        return image;
    }

    /**
     * Scale the SVG by the given amount. For use with {@link Image.renderSVG}
     * @return {number}
     */
    static get SVG_MODE_SCALE() {
        return 1;
    }

    /**
     * Scale the SVG to fit the given width. For use with {@link Image.renderSVG}
     * @return {number}
     */
    static get SVG_MODE_WIDTH() {
        return 2;
    }

    /**
     * Scale the SVG to fit the given height. For use with {@link Image.renderSVG}
     * @return {number}
     */
    static get SVG_MODE_HEIGHT() {
        return 3;
    }

    /**
     * Creates a new image from the given SVG
     * Supports shapes, paths, transforms, use/symbol, CSS styles, gradients, strokes, clip paths, masks and opacity;
     * text, images, filters and patterns are not rendered
     * @param {string|Uint8Array} svg The SVG content
     * @param {number} size The size to use
     * @param {number} mode The SVG resizing mode to use (one of {@link SVG_MODE_SCALE}, {@link SVG_MODE_WIDTH}, {@link SVG_MODE_HEIGHT})
     * @return {Promise<Image>} The rendered SVG graphic
     */
    static async renderSVG(svg, size = 1, mode = this.SVG_MODE_SCALE) {
        if (![this.SVG_MODE_WIDTH, this.SVG_MODE_HEIGHT, this.SVG_MODE_SCALE].includes(mode))
            throw new Error('Invalid SVG scaling mode');

        if (mode === this.SVG_MODE_SCALE && size <= 0)
            throw new RangeError('SVG scale must be > 0');
        if (mode !== this.SVG_MODE_SCALE && size < 1)
            throw new RangeError('SVG size must be >= 1')

        const {width, height, pixels} = svgRenderer.render(typeof svg === 'string' ? svg : mem.view(svg), mode, size);
        const image = new Image(width, height);
        image.bitmap.set(pixels);

        return image;
    }

    /**
     * Creates a new image containing the rendered text.
     * @param {Uint8Array} font TrueType (ttf/ttc) or OpenType (otf) font buffer to use
     * @param {number} scale Font size to use
     * @param {string} text Text to render
     * @param {number} [color=0xffffffff] Text color to use
     * @param {TextLayout} [layout] The text layout to use
     * @return {Promise<Image>} The rendered text
     */
    static async renderText(font, scale, text, color = 0xffffffff, layout = new TextLayout()) {
        const {width, height, coverage} = textRenderer.render(mem.view(font), scale, text, layout);
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

/**
 * Represents a frame in a GIF
 * @extends Image
 */
class Frame extends Image {
    /**
     * GIF frame disposal mode KEEP. For use with {@link Frame}
     * @returns {string}
     */
    static get DISPOSAL_KEEP() {
        return 'keep';
    }

    /**
     * GIF frame disposal mode PREVIOUS. For use with {@link Frame}
     * @returns {string}
     */
    static get DISPOSAL_PREVIOUS() {
        return 'previous';
    }

    /**
     * GIF frame disposal mode BACKGROUND. For use with {@link Frame}
     * @returns {string}
     */
    static get DISPOSAL_BACKGROUND() {
        return 'background';
    }

    static __convert_disposal_mode__(mode) {
        if (typeof mode === 'string')
            mode = ['any', 'keep', 'previous', 'background'].indexOf(mode);
        if (mode < 0 || mode > 3)
            throw new RangeError('Invalid disposal mode');

        return mode;
    }

    /**
     * Creates a new, blank frame
     * @param {number} width
     * @param {number} height
     * @param {number} [duration = 100] The frames duration (in ms)
     * @param {number} [xOffset=0] The frames offset on the x-axis
     * @param {number} [yOffset=0] The frames offset on the y-axis
     * @param {string|number} [disposalMode=Frame.DISPOSAL_KEEP] The frame's disposal mode ({@link Frame.DISPOSAL_KEEP}, {@link Frame.DISPOSAL_PREVIOUS} or {@link Frame.DISPOSAL_BACKGROUND})
     * @return {Frame}
     */
    constructor(width, height, duration = 100, xOffset = 0, yOffset = 0, disposalMode = Frame.DISPOSAL_KEEP) {
        if (isNaN(duration) || duration < 0)
            throw new RangeError('Invalid frame duration');

        super(width, height);
        this.duration = duration;
        this.xOffset = xOffset;
        this.yOffset = yOffset;
        this.disposalMode = disposalMode;
    }

    /**
     * The Frame's disposal mode
     * @returns {number}
     */
    get disposalMode() {
        return this.__disposalMode__;
    }

    /**
     * Sets the frame's disposal mode, converting it to the internal numeric value.
     * @param {string|number} disposalMode The frame's disposal mode
     */
    set disposalMode(disposalMode) {
        this.__disposalMode__ = Frame.__convert_disposal_mode__(disposalMode);
    }

    toString() {
        return `Frame<${this.width}x${this.height}x${this.duration}ms>`;
    }

    /**
     * Converts an Image instance to a Frame, cloning it in the process
     * @param {Image} image The image to create the frame from
     * @param {number} [duration = 100] The frames duration (in ms)
     * @param {number} [xOffset=0] The frames offset on the x-axis
     * @param {number} [yOffset=0] The frames offset on the y-axis
     * @param {string|number} [disposalMode=Frame.DISPOSAL_KEEP] The frames disposal mode ({@link Frame.DISPOSAL_KEEP}, {@link Frame.DISPOSAL_PREVIOUS} or {@link Frame.DISPOSAL_BACKGROUND})
     * @return {Frame}
     */
    static from(image, duration, xOffset, yOffset, disposalMode = Frame.DISPOSAL_KEEP) {
        if (!(image instanceof Image))
            throw new TypeError('Invalid image passed');

        const frame = new Frame(image.width, image.height, duration, xOffset, yOffset, disposalMode);
        frame.bitmap.set(image.bitmap);

        return frame;
    }

    /**
     * Clones the frame, including its duration, offsets and disposal mode
     * @returns {Frame}
     */
    clone() {
        return Frame.from(this, this.duration, this.xOffset, this.yOffset, this.disposalMode);
    }

    /**
     * Resizes the frame, scaling its offsets along with it
     * @param {number} width The new width
     * @param {number} height The new height
     * @param {string} [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns {Frame}
     */
    resize(width, height, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        const originalWidth = this.width;
        const originalHeight = this.height;

        super.resize(width, height, mode);

        this.xOffset = Math.round(this.xOffset * this.width / originalWidth);
        this.yOffset = Math.round(this.yOffset * this.height / originalHeight);

        return this;
    }
}

/**
 * Represents a GIF image as an array of frames
 * @extends Array<Frame>
 */
class GIF extends Array {
    /**
     * Creates a new GIF image.
     * @param {Frame[]} frames The frames to create the GIF from
     * @param {number} [loopCount=-1] How often to loop the GIF for (-1 = unlimited)
     * @property {number} loopCount How often the GIF will loop for
     */
    constructor(frames, loopCount = -1) {
        super(...frames);

        for (const frame of this)
            if (!(frame instanceof Frame))
                throw new TypeError(`Frame ${this.indexOf(frame)} is not an instance of Frame`);

        if (loopCount < -1 || isNaN(loopCount))
            throw new RangeError('Invalid loop count');

        this.loopCount = loopCount;
    }

    /**
     * The GIFs width
     * @returns {number}
     */
    get width() {
        let max = 0;
        for (const frame of this) {
            let width = frame.width + frame.xOffset;
            if (max < width)
                max = width;
        }

        return max;
    }

    /**
     * The GIFs height
     * @returns {number}
     */
    get height() {
        let max = 0;
        for (const frame of this) {
            let height = frame.height + frame.yOffset;
            if (max < height)
                max = height;
        }

        return max;
    }

    toString() {
        return `GIF<${this.width}x${this.height}x${this.duration}ms>`;
    }

    /**
     * Array methods like map and filter return plain arrays
     * @private
     */
    static get [Symbol.species]() {
        return Array;
    }

    /**
     * @returns {Generator<Frame, void, *>}
     */
    * [Symbol.iterator]() {
        for (let i = 0; i < this.length; i++)
            yield this[i];
    }

    /**
     * Returns a new GIF containing a range of this GIFs frames (same semantics as Array.prototype.slice)
     * @param {number} [start=0]
     * @param {number} [end=this.length]
     * @returns {GIF}
     */
    slice(start, end) {
        return new GIF(Array.prototype.slice.call(this, start, end), this.loopCount);
    }

    /**
     * The GIFs duration (in ms)
     * @return {number}
     */
    get duration() {
        return this.reduce((acc, frame) => acc + frame.duration, 0);
    }

    /**
     * Encodes the image into a GIF
     * @param {number} [quality=95] GIF quality 1-100, scales the palette size (1 = 8 colors, 50 = 55, 90 and above = 256)
     * @return {Promise<Uint8Array>} The encoded data
     */
    async encode(quality = 95) {
        const frames = [];

        for (const frame of this) {
            if (!(frame instanceof Frame)) throw new Error('GIF contains invalid frames');

            frames.push({
                x: frame.xOffset,
                y: frame.yOffset,
                width: frame.width,
                height: frame.height,
                delay: ~~(frame.duration / 10),
                dispose: frame.disposalMode,
                pixels: frame.bitmap
            });
        }

        return gif.encode({width: this.width, height: this.height, loopCount: this.loopCount, frames}, quality);
    }

    /**
     * Decodes a GIF image
     * @param {Buffer|Uint8Array} data The binary data to decode
     * @param {boolean} [onlyExtractFirstFrame=false] Whether to end GIF decoding after the first frame
     * @return {Promise<GIF>} The decoded GIF
     */
    static async decode(data, onlyExtractFirstFrame = false) {
        data = mem.view(data);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (!ImageType.isGIF(view)) throw new Error('Unsupported image type');

        const decoded = gif.decode(data, onlyExtractFirstFrame);
        const frames = gif.composite(decoded).map(({pixels, delay}) => {
            const frame = new Frame(decoded.width, decoded.height, 10 * delay, 0, 0, Frame.DISPOSAL_BACKGROUND);
            frame.bitmap.set(pixels);
            return frame;
        });

        return new GIF(frames, decoded.loopCount);
    }

    /**
     * Resizes the GIF to the given dimensions, scaling every frame and its offsets proportionally.
     * Use {@link Image.RESIZE_AUTO} as either width or height to automatically preserve the aspect ratio.
     * @param {number} width The new width
     * @param {number} height The new height
     * @param {string} [mode=Image.RESIZE_NEAREST_NEIGHBOR] The resizing mode to use
     * @returns {GIF}
     */
    resize(width, height, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        const originalWidth = this.width, originalHeight = this.height;
        if (width === Image.RESIZE_AUTO && height === Image.RESIZE_AUTO) throw new Error('RESIZE_AUTO can only be used for either width or height, not for both');
        if (width === Image.RESIZE_AUTO) width = originalWidth / originalHeight * height;
        if (height === Image.RESIZE_AUTO) height = originalHeight / originalWidth * width;

        const sx = width / originalWidth, sy = height / originalHeight;
        for (const frame of this) {
            // scale both edges so adjacent frames stay aligned
            const left = Math.round(frame.xOffset * sx), top = Math.round(frame.yOffset * sy);
            const right = Math.round((frame.xOffset + frame.width) * sx), bottom = Math.round((frame.yOffset + frame.height) * sy);
            Image.prototype.resize.call(frame, Math.max(1, right - left), Math.max(1, bottom - top), mode);
            frame.xOffset = left;
            frame.yOffset = top;
        }

        return this;
    }
}

class TextLayout {
    /**
     * Layout options for {@link Image.renderText}
     * @param {object} [options]
     * @param {number} [options.maxWidth=Infinity] The texts max width, longer lines are wrapped
     * @param {number} [options.maxHeight=Infinity] The texts max height, lines that don't fit are cut off
     * @param {string} [options.wrapStyle='word'] The texts wrap style when reaching the max width (word, char)
     * @param {string} [options.horizontalAlign='left'] The horizontal alignment of the lines (left, center, right), relative to the widest line
     * @param {string} [options.verticalAlign='top'] Which lines to keep when cutting off at the max height (top, middle, bottom)
     * @param {boolean} [options.wrapHardBreaks=true] Whether to force wrap at new line characters
     */
    constructor(options) {
        const {maxWidth, maxHeight, wrapStyle, verticalAlign, horizontalAlign, wrapHardBreaks} = options || {};

        this.maxWidth = maxWidth || Infinity;
        if (isNaN(this.maxWidth) || this.maxWidth < 1)
            throw new RangeError('Invalid maxWidth');

        this.maxHeight = maxHeight || Infinity;
        if (isNaN(this.maxHeight) || this.maxHeight < 1)
            throw new RangeError('Invalid maxHeight');

        this.wrapStyle = wrapStyle || 'word';
        if (!['word', 'char'].includes(this.wrapStyle))
            throw new RangeError('Invalid wrapStyle');

        // before 3.0 the two alignment options had each other's names, accept those values too
        const horizontal = ['left', 'center', 'right'];
        const vertical = ['top', 'middle', 'bottom'];
        this.horizontalAlign = 'left';
        this.verticalAlign = 'top';

        for (const value of [horizontalAlign, verticalAlign]) {
            if (value === undefined) continue;
            if (horizontal.includes(value)) this.horizontalAlign = value;
            else if (vertical.includes(value)) this.verticalAlign = value;
            else throw new RangeError(`Invalid alignment: ${value}`);
        }

        this.wrapHardBreaks = typeof wrapHardBreaks === 'undefined' ? true : wrapHardBreaks;
        if (typeof this.wrapHardBreaks !== 'boolean')
            throw new TypeError('Invalid wrapHardBreaks');
    }
}

class ImageType {
    /**
     * Gets an images type (png, jpeg, tiff, gif)
     * @param {Buffer|Uint8Array} data The image binary to get the type of
     * @returns {string|null} The image type (png, jpeg, tiff, gif, null)
     */
    static getType(data) {
        let view;
        if (!ArrayBuffer.isView(data)) {
            data = new Uint8Array(data);
            view = new DataView(data.buffer);
        } else {
            data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        }

        if (this.isPNG(view)) return 'png';
        if (this.isJPEG(view)) return 'jpeg';
        if (this.isTIFF(view)) return 'tiff';
        if (this.isGIF(view)) return 'gif';
        return null;
    }

    /**
     * @param {DataView} view
     * @returns {boolean}
     */
    static isPNG(view) {
        return view.byteLength >= 4 && view.getUint32(0, false) === MAGIC_NUMBERS.PNG;
    }

    /**
     * @param {DataView} view
     * @returns {boolean}
     */
    static isJPEG(view) {
        return view.byteLength >= 4 && (view.getUint32(0, false) >>> 8) === MAGIC_NUMBERS.JPEG;
    }

    /**
     * @param {DataView} view
     * @returns {boolean}
     */
    static isTIFF(view) {
        if (view.byteLength < 4) return false;
        const magic = view.getUint32(0, false);
        return magic === MAGIC_NUMBERS.TIFF_LE || magic === MAGIC_NUMBERS.TIFF_BE || magic === MAGIC_NUMBERS.BIGTIFF_LE || magic === MAGIC_NUMBERS.BIGTIFF_BE;
    }

    /**
     * @param {DataView} view
     * @returns {boolean}
     */
    static isGIF(view) {
        return view.byteLength >= 4 && (view.getUint32(0, false) >>> 8) === MAGIC_NUMBERS.GIF;
    }
}

/**
 * Decodes the given image binary
 * @param {Uint8Array|Buffer} data The image data
 * @param {boolean} [onlyExtractFirstFrame] Whether to end GIF decoding after the first frame
 * @returns {Promise<GIF|Image>} The decoded image
 */
function decode(data, onlyExtractFirstFrame) {
    const type = ImageType.getType(data);

    if (type === 'gif')
        return GIF.decode(data, onlyExtractFirstFrame);
    return Image.decode(data);
}

module.exports = {Image, GIF, Frame, TextLayout, ImageType, decode};
