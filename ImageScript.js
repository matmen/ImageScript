const png = require('./png/node.js');
const mem = require('./utils/mem.js');
const {version} = require('./package.json');
const codecs = require('./codecs/node/index.js');
const { default: v2 } = require('./v2/framebuffer.js');

// old
const svglib = require('./wasm/node/svg.js');
const giflib = require('./wasm/node/gif.js');
const pnglib = require('./wasm/node/png.js');
const fontlib = require('./wasm/node/font.js');
const jpeglib = require('./wasm/node/jpeg.js');
const tifflib = require('./wasm/node/tiff.js');

const MAGIC_NUMBERS = {
    PNG: 0x89504e47,
    JPEG: 0xffd8ff,
    TIFF: 0x49492a00,
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
        for (const x of new v2(this.width, this.height, this.bitmap)[Symbol.iterator]()) yield (x[0]++, x[1]++, x)
    }

    /**
     * Yields an [x, y, color] array for every pixel in the image
     * @yields {number[]} The coordinates and color of the pixel ([x, y, color])
     */
    *iterateWithColors() {
        for (const x of new v2(this.width, this.height, this.bitmap).pixels('int')) yield (x[0]++, x[1]++, x);
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
        new v2(this.width, this.height, this.bitmap).fill(color);

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
        const frame = new v2(this.width, this.height, this.bitmap).resize('nearest', width, height);

        image.bitmap.set(frame.u8);

        return image;
    }

    /**
     * Crops an image to the specified dimensions
     * @param {number} x The x offset
     * @param {number} y The y offset
     * @param {number} width The new images width
     * @param {number} height The new images height
     * @returns {Image}
     */
    crop(x, y, width, height) {
        if (width > this.width) width = this.width;
        if (height > this.height) height = this.height;

        return this.__apply__(this.__crop__(~~x, ~~y, ~~width, ~~height));
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
        if (x < 0) {
            width += x;
            x = 0;
        }

        if (y < 0) {
            height += y;
            y = 0;
        }

        const right = Math.max(Math.min(x + width, this.width), 1);
        let xPos = right;
        while (x <= --xPos)
            this.__view__.setUint32(4 * (xPos + y * this.width), color);
        const end = 4 * (right + y * this.width);
        const start = 4 * (x + y * this.width);

        let bottom = Math.max(Math.min(y + height, this.height), 1);
        while (y < --bottom)
            this.bitmap.copyWithin(4 * (x + bottom * this.width), start, end);

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
        new v2(this.width, this.height, this.bitmap).crop('circle', feathering);

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
        new v2(this.width, this.height, this.bitmap).overlay(new v2(source.width, source.height, source.bitmap), x, y);

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
     * Gets the average color of the image
     * @returns {number}
     */
    averageColor() {
        let colorAvg = [0, 0, 0];
        let divisor = 0;
        for (let idx = 0; idx < this.bitmap.length; idx += 4) {
            const rgba = this.bitmap.subarray(idx, idx + 4);
            for (let i = 0; i < 3; i++)
                colorAvg[i] += rgba[i];
            divisor += rgba[3] / 255;
        }

        return Image.rgbaToColor(...colorAvg.map(v => v / divisor), 0xff);
    }

    /**
     * Gets the images dominant color
     * @param {boolean} [ignoreBlack=true] Whether to ignore dark colors below the threshold
     * @param {boolean} [ignoreWhite=true] Whether to ignore light colors above the threshold
     * @param {number} [bwThreshold=0xf] The black/white threshold (0-64)
     * @return {number} The images dominant color
     */
    dominantColor(ignoreBlack = true, ignoreWhite = true, bwThreshold = 0xf) {
        const colorCounts = new Array(0x3ffff);
        for (let i = 0; i < this.bitmap.length; i += 4) {
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

        if (mostProminentValue === -1)
            return this.dominantColor(ignoreBlack, ignoreWhite, bwThreshold - 1);

        const h = (mostProminentValue >>> 12) & 0x3f;
        const s = (mostProminentValue >>> 6) & 0x3f;
        const l = mostProminentValue & 0x3f;

        return Image.hslaToColor(h / 0x3f, s / 0x3f, l / 0x3f, 1);
    }

    /**
     * Rotates the image the given amount of degrees
     * @param {number} angle The angle to rotate the image for (in degrees)
     * @param {boolean} resize Whether to resize the image so it fits all pixels or just ignore outlying pixels
     */
    rotate(angle, resize = true) {
        const frame = new v2(this.width, this.height, this.bitmap).rotate(360 - (angle % 360), resize);

        const out = new Image(frame.width, frame.height);

        out.bitmap.set(frame.u8);
        return this.__apply__(out);
    }

    /**
     * @private
     * @param {Image|Frame} image
     * @returns {Image|Frame}
     */
    __apply__(image) {
        this.__width__ = image.__width__;
        this.__height__ = image.__height__;
        this.__view__ = image.__view__;
        this.__u32__ = image.__u32__;
        this.bitmap = image.bitmap;

        if (image instanceof Frame)
            return Frame.from(this, image.duration, image.xOffset, image.yOffset, image.disposalMode);

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
            return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff));
        };
    }

    fisheye(radius = 2) {
        const r = new Image(this.width, this.height);

        const w = this.width;
        const h = this.height;
        const tu32 = this.__u32__;
        const ru32 = r.__u32__;
        const iw = 1 / w;
        const ih = 1 / h;

        for (const [x, y] of this) {
            const xco = x * iw - .5;
            const yco = y * ih - .5;
            const dfc = Math.sqrt(xco ** 2 + yco ** 2);
            const dis = 2 * dfc ** radius;
            const nx = ((dis * xco / dfc + 0.5) * w) | 0;
            const ny = ((dis * yco / dfc + 0.5) * h) | 0;

            if (nx < 1 || nx > w || ny < 1 || ny > h || isNaN(nx) || isNaN(ny))
                continue;

            ru32[y * w + x] = tu32[w * ny + nx];
        }

        const cO = tu32.length * .5 + w / 2;
        ru32[cO] = tu32[cO];

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
     * @param {number} compression The compression level to use (0-9)
     * @param {PNGMetadata} [meta={}] Image metadata
     * @return {Promise<Uint8Array>} The encoded data
     */
    async encode(compression = 1, {
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
    } = {}) {
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
     * @param {number} [quality=90] The JPEG quality to use (1-100)
     * @return {Promise<Uint8Array>}
     */
    async encodeJPEG(quality = 90) {
        return codecs.jpeg.encode_async(this.bitmap, {
            quality,
            width: this.width,
            height: this.height,
        });
    }

    /**
     * Encodes the image into a WEBP
     * @param {null|number} [quality=null] The WEBP quality to use (0-100) (null is lossless)
     * @return {Promise<Uint8Array>}
     */
    async encodeWEBP(quality = null) {
        return codecs.webp.encode_async(this.bitmap, {
            quality,
            width: this.width,
            height: this.height,
        });
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
            const {width, height, framebuffer} = (await pnglib.init()).decode(data);
            image = new Image(width, height);
            image.bitmap.set(framebuffer);
        } else if (ImageType.isJPEG(view)) { // JPEG
            const framebuffer = (await jpeglib.init()).decode(data);

            const width = framebuffer.width;
            const height = framebuffer.height;
            const pixelType = framebuffer.format;

            image = new Image(width, height);
            const buffer = framebuffer.buffer;

            if (pixelType === 0) {
                const view = new DataView(image.bitmap.buffer);

                for (let i = 0; i < buffer.length; i++) {
                    const pixel = buffer[i];
                    view.setUint32(i * 4, pixel << 24 | pixel << 16 | pixel << 8 | 0xff, false);
                }
            } else if (pixelType === 1) {
                image.bitmap.fill(0xff);
                for (let i = 0; i < width * height; i++)
                    image.bitmap.set(buffer.subarray(i * 3, i * 3 + 3), i * 4);
            } else if (pixelType === 2) {
                for (let i = 0; i < buffer.length; i += 4) {
                    image.bitmap[i] = 0xff * (1 - buffer[i] / 0xff) * (1 - buffer[i + 3] / 0xff);
                    image.bitmap[i + 1] = 0xff * (1 - buffer[i + 1] / 0xff) * (1 - buffer[i + 3] / 0xff);
                    image.bitmap[i + 2] = 0xff * (1 - buffer[i + 2] / 0xff) * (1 - buffer[i + 3] / 0xff);
                    image.bitmap[i + 3] = 0xff;
                }
            }
        } else if (ImageType.isTIFF(view)) { // TIFF
            const framebuffer = (await tifflib.init()).decode(data);
            image = new Image(framebuffer.width, framebuffer.height);

            image.bitmap.set(framebuffer.buffer);
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
     * @param {string} svg The SVG content
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

        if (typeof svg === 'string') svg = Buffer.from(svg);
        const framebuffer = (await svglib.init()).rasterize(svg, mode, size);

        const image = new Image(framebuffer.width, framebuffer.height);

        image.bitmap.set(framebuffer.buffer);

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
        const { Font, Layout } = await fontlib.init();

        font = new Font(scale, font);
        const [r, g, b, a] = Image.colorToRGBA(color);

        const layoutOptions = new Layout();

        layoutOptions.reset({
            max_width: layout.maxWidth,
            max_height: layout.maxHeight,
            wrap_style: layout.wrapStyle,
            vertical_align: layout.verticalAlign,
            horizontal_align: layout.horizontalAlign,
            wrap_hard_breaks: layout.wrapHardBreaks
        });

        layoutOptions.append(font, text, {scale});
        const framebuffer = layoutOptions.rasterize(r, g, b);
        const image = new Image(framebuffer.width, framebuffer.height);

        image.bitmap.set(framebuffer.buffer);

        if (image.height > layout.maxHeight)
            image.crop(0, 0, image.width, Math.floor(layoutOptions.lines() / image.height * layout.maxHeight) * (image.height / layoutOptions.lines()));

        font.free();
        layoutOptions.free();
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

    resize(width, height, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        const originalWidth = this.width;
        const originalHeight = this.height;

        const result = super.resize(width, height, mode);

        this.xOffset *= result.width / originalWidth;
        this.yOffset *= result.height / originalHeight;

        return result;
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
     * @param {number} [loopCount=0] How often to loop the GIF for (-1 = unlimited)
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
     * @returns {Generator<Frame, void, *>}
     */
    * [Symbol.iterator]() {
        for (let i = 0; i < this.length; i++)
            yield this[i];
    }

    slice(start, end) {
        if (end === Infinity)
            end = this.length;
        const frames = new Array(end - start);
        for (let i = 0; i < frames.length; i++)
            frames[i] = this[i + start];
        return new GIF(frames, this.loopCount);
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
     * @param {number} [quality=95] GIF quality 0-100
     * @return {Promise<Uint8Array>} The encoded data
     */
    async encode(quality = 95) {
        const encoder = new codecs.gif.encoder(this.width, this.height);

        for (const frame of this) {
            if (!(frame instanceof Frame)) throw new Error('GIF contains invalid frames');

            encoder.add(frame.bitmap, {
                quality,
                x: frame.xOffset,
                y: frame.yOffset,
                width: frame.width,
                speed: null, // 1-10
                height: frame.height,
                colors: null, // 2-256
                delay: ~~(frame.duration / 10),
                dispose: ['any', 'keep', 'previous', 'background'][frame.disposalMode],
            });
        }

        return encoder.finish({ repeat: -1 === this.loopCount ? null : this.loopCount });
    }

    /**
     * Decodes a GIF image
     * @param {Buffer|Uint8Array} data The binary data to decode
     * @param {boolean} [onlyExtractFirstFrame=false] Whether to end GIF decoding after the first frame
     * @return {Promise<GIF>} The decoded GIF
     */
    static async decode(data, onlyExtractFirstFrame = false) {
        let image;
        data = mem.view(data);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        if (ImageType.isGIF(view)) { // GIF
            const frames = [];
            const decoder = new (await giflib.init()).Decoder(data);

            const gwidth = decoder.width | 0;
            const gheight = decoder.height | 0;
            const u32 = new Uint32Array(decoder.width * decoder.height);
            const u8 = new Uint8Array(u32.buffer, u32.byteOffset, u32.byteLength);

            for (const frame of decoder.frames()) {
                let offset8 = 0 | 0;
                let offset32 = 0 | 0;
                const fx = frame.x | 0;
                const fy = frame.y | 0;
                const f8 = frame.buffer;
                const mode = frame.dispose;
                const width = frame.width | 0;
                const height = frame.height | 0;
                const f32 = new Uint32Array(f8.buffer, f8.byteOffset, width * height);
                const f = frames[frames.push(new Frame(gwidth, gheight, 10 * frame.delay, 0, 0, 3)) - 1];

                const t8 = f.bitmap;
                const t32 = new Uint32Array(t8.buffer);

                t8.set(u8);

                if (2 === mode) {
                    for (let y = 0 | 0; y < height; y++) {
                        const y_offset = fx + gwidth * (y + fy) | 0;

                        for (let x = 0 | 0; x < width; x++) {
                            const x_offset = x + y_offset;

                            if (0 === f8[3 + offset8])
                            t32[x_offset] = u32[x_offset];
                            else t32[x_offset] = f32[offset32];

                            offset32++;
                            offset8 += 4;
                        }
                    }
                }

                else if (3 === mode) {
                    for (let y = 0 | 0; y < height; y++) {
                        const y_offset = fx + gwidth * (y + fy) | 0;

                        for (let x = 0 | 0; x < width; x++) {
                            const x_offset = x + y_offset;

                            if (0 === f8[3 + offset8])
                            t32[x_offset] = u32[x_offset];
                            else t32[x_offset] = f32[offset32];

                            offset32++;
                            offset8 += 4;
                            u32[x_offset] = 0;
                        }
                    }
                }

                else if (0 === mode || 1 === mode) {
                    t8.set(u8);
                    for (let y = 0 | 0; y < height; y++) {
                        const y_offset = fx + gwidth * (y + fy) | 0;

                        for (let x = 0 | 0; x < width; x++) {
                            const x_offset = x + y_offset;

                            if (0 === f8[3 + offset8])
                                t32[x_offset] = u32[x_offset];
                            else t32[x_offset] = f32[offset32];

                            offset32++;
                            offset8 += 4;
                            u32[x_offset] = t32[x_offset];
                        }
                    }
                }

                if (onlyExtractFirstFrame)
                    break;
            }

            image = new GIF(frames);
        } else throw new Error('Unsupported image type');

        return image;
    }

    resize(width, height, mode = Image.RESIZE_NEAREST_NEIGHBOR) {
        for (const frame of this)
            frame.resize(width, height, mode);
    }
}

class TextLayout {
    /**
     * Layout options for {@link Image.renderText}
     * @param {object} [options]
     * @param {number} [options.maxWidth=Infinity] The texts max width
     * @param {number} [options.maxHeight=Infinity] The texts max height
     * @param {string} [options.wrapStyle='word'] The texts wrap style when reaching the max width (word, char)
     * @param {string} [options.verticalAlign='left'] The vertical align mode (left, center, right)
     * @param {string} [options.horizontalAlign='top'] The horizontal align mode (top, middle, bottom)
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

        this.verticalAlign = verticalAlign || 'left';
        if (!['left', 'center', 'right'].includes(this.verticalAlign))
            throw new RangeError('Invalid verticalAlign');

        this.horizontalAlign = horizontalAlign || 'top';
        if (!['top', 'middle', 'bottom'].includes(this.horizontalAlign))
            throw new RangeError('Invalid horizontalAlign');

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
        return view.getUint32(0, false) === MAGIC_NUMBERS.PNG;
    }

    /**
     * @param {DataView} view
     * @returns {boolean}
     */
    static isJPEG(view) {
        return (view.getUint32(0, false) >>> 8) === MAGIC_NUMBERS.JPEG;
    }

    /**
     * @param {DataView} view
     * @returns {boolean}
     */
    static isTIFF(view) {
        return view.getUint32(0, false) === MAGIC_NUMBERS.TIFF;
    }

    /**
     * @param {DataView} view
     * @returns {boolean}
     */
    static isGIF(view) {
        return (view.getUint32(0, false) >>> 8) === MAGIC_NUMBERS.GIF;
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
