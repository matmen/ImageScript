const png = require('./utils/png');
const fontlib = require('./utils/wasm/font');
const svglib = require('./utils/wasm/svg');
const jpeglib = require('./utils/wasm/jpeg');
const tifflib = require('./utils/wasm/tiff');
const giflib = require('./utils/wasm/gif');

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

    /** @private */
    static new(width, height) {
        return new this(width, height);
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
     * Yields an [x,y] array for every pixel in the image
     * @yields {[number, number]} The coordinates of the pixel
     * @returns {void}
     */
    * [Symbol.iterator]() {
        for (let y = 1; y <= this.height; y++) {
            for (let x = 1; x <= this.width; x++) {
                yield [x, y];
            }
        }
    }

    /**
     * Yields an [x,y,color] array for every pixel in the image
     * @yields {[number, number, number]} The coordinates and color of the pixel
     * @returns {void}
     */
    * iterateWithColors() {
        let offset = 0;
        for (let y = 1; y <= this.height; y++) {
            for (let x = 1; x <= this.width; x++) {
                yield [x, y, this.__view__.getUint32(offset, false)];
                offset += 4;
            }
        }
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
     * @returns {(number)[]} The HSLA values ([H, S, L, A])
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
        return this.__view__.getUint32((~~y - 1) * this.width + (~~x - 1), false);
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
        const type = typeof color;
        if (type !== 'function') {
            this.__view__.setUint32(0, color, false);
            this.__u32__.fill(this.__u32__[0]);
        } else {
            let offset = 0;
            for (let y = 1; y <= this.height; y++) {
                for (let x = 1; x <= this.width; x++) {
                    this.__view__.setUint32(offset, color(x, y), false);
                    offset += 4;
                }
            }
        }

        return this;
    }

    /**
     * Clones the current image
     * @returns {Image}
     */
    clone() {
        const image = Image.new(this.width, this.height);
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

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const ySrc = Math.floor((y * this.height) / height);
                const xSrc = Math.floor((x * this.width) / width);

                const destPos = (y * width + x) * 4;
                const srcPos = (ySrc * this.width + xSrc) * 4;

                image.__view__.setUint32(destPos, this.__view__.getUint32(srcPos, false), false);
            }
        }

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

        return this.__apply__(this.__crop__(x, y, width, height));
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
        x -= 1;
        y -= 1;

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
            x = 1;
        }

        if (y < 0) {
            height += y;
            y = 1;
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
        const rad = Math[max ? 'max' : 'min'](this.width, this.height) / 2;
        const radSquared = rad ** 2;
        const centerX = this.width / 2;
        const centerY = this.height / 2;

        for (const [x, y] of this) {
            const distanceFromCenter = (x - centerX) ** 2 + (y - centerY) ** 2;
            const alphaIdx = ((y - 1) * this.width + (x - 1)) * 4 + 3;
            if (distanceFromCenter > radSquared)
                this.bitmap[alphaIdx] = 0;
            else if (feathering)
                this.bitmap[alphaIdx] *= Math.max(0, Math.min(1, 1 - (distanceFromCenter / radSquared) * feathering ** (1 / 2)));
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
        x = ~~x;
        y = ~~y;

        for (let yy = 0; yy < source.height; yy++) {
            let y_offset = y + yy;
            if (y_offset < 0) continue;
            if (y_offset >= this.height) break;

            for (let xx = 0; xx < source.width; xx++) {
                let x_offset = x + xx;
                if (x_offset < 0) continue;
                if (x_offset >= this.width) break;

                const offset = 4 * (x_offset + y_offset * this.width);
                const fg = source.__view__.getUint32(4 * (xx + yy * source.width), false);
                const bg = this.__view__.getUint32(offset, false);

                if ((fg & 0xff) === 0xff) this.__view__.setUint32(offset, fg, false);
                else if ((fg & 0xff) === 0x00) this.__view__.setUint32(offset, bg, false);
                else this.__view__.setUint32(offset, Image.__alpha_blend__(fg, bg), false);
            }
        }

        return this;
    }

    /**
     * @private
     * @param {number} fg
     * @param {number} bg
     * @returns {number}
     */
    static __alpha_blend__(fg, bg) {
        const fa = fg & 0xff;
        const alpha = fa + 1;
        const inv_alpha = 256 - fa;
        const r = (alpha * (fg >>> 24) + inv_alpha * (bg >>> 24)) >> 8;
        const b = (alpha * (fg >> 8 & 0xff) + inv_alpha * (bg >> 8 & 0xff)) >> 8;
        const g = (alpha * (fg >> 16 & 0xff) + inv_alpha * (bg >> 16 & 0xff)) >> 8;
        return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (Math.max(fa, bg & 0xff) & 0xff));
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
        if (angle % 360 === 0) return this;
        if (angle % 180 === 0) return this.__rotate_180__();

        const rad = Math.PI * (angle / 180);

        const sin = Math.sin(rad);
        const cos = Math.cos(rad);

        const width = resize
            ? Math.abs(this.width * sin) + Math.abs(this.height * cos)
            : this.width;
        const height = resize
            ? Math.abs(this.width * cos) + Math.abs(this.height * sin)
            : this.height;

        const out = Image.new(width, height);

        const out_cx = width / 2 - .5;
        const out_cy = height / 2 - .5;
        const src_cx = this.width / 2 - .5;
        const src_cy = this.height / 2 - .5;

        let h = 0;
        do {
            let w = 0;
            const ysin = src_cx - sin * (h - out_cy);
            const ycos = src_cy + cos * (h - out_cy);

            do {
                const xf = ysin + cos * (w - out_cx);
                const yf = ycos + sin * (w - out_cx);
                Image.__interpolate__(this, out, w, h, xf, yf);
            } while (w++ < width);
        } while (h++ < height);

        return this.__apply__(out);
    }

    /**
     * @returns {Image}
     * @private
     */
    __rotate_180__() {
        let offset = 0;
        this.bitmap.reverse();
        while (offset < this.bitmap.length) this.bitmap.subarray(offset, offset += 4).reverse();

        return this;
    }

    /**
     * @param {Image} src
     * @param {Image} out
     * @param {number} x0
     * @param {number} y0
     * @param {number} x1
     * @param {number} y1
     * @private
     */
    static __interpolate__(src, out, x0, y0, x1, y1) {
        const x2 = ~~x1;
        const y2 = ~~y1;
        const xq = x1 - x2;
        const yq = y1 - y2;
        const out_slice = out.bitmap.subarray(4 * (x0 + y0 * out.width), -4);

        const ref = {
            r: 0,
            g: 0,
            b: 0,
            a: 0,
        };

        Image.__pawn__(x2, y2, (1 - xq) * (1 - yq), ref, src);
        Image.__pawn__(1 + x2, y2, xq * (1 - yq), ref, src);
        Image.__pawn__(x2, 1 + y2, (1 - xq) * yq, ref, src);
        Image.__pawn__(1 + x2, 1 + y2, xq * yq, ref, src);

        out_slice[3] = ref.a;
        out_slice[0] = ref.r / ref.a;
        out_slice[1] = ref.g / ref.a;
        out_slice[2] = ref.b / ref.a;
    }

    /** @private */
    static __pawn__(point0, point1, weight, ref, src) {
        if (
            point0 > 0
            && point1 > 0
            && point0 < src.width
            && point1 < src.height
        ) {
            const offset = 4 * (point0 + point1 * src.width);
            const src_slice = src.bitmap.subarray(offset, offset + 4);

            const wa = weight * src_slice[3];

            ref.a += wa;
            ref.r += wa * src_slice[0];
            ref.g += wa * src_slice[1];
            ref.b += wa * src_slice[2];
        }
    }

    /**
     * @private
     * @param {Image} image
     * @returns {Image}
     */
    __apply__(image) {
        this.__width__ = image.__width__;
        this.__height__ = image.__height__;
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
            return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff));
        };
    }

    /**
     * Encodes the image into a PNG
     * @param {number} compression The compression level to use (0-3)
     * @return {Promise<Uint8Array>} The encoded data
     */
    async encode(compression = 1) {
        return await png.encode(this.bitmap, {width: this.width, height: this.height, level: compression, channels: 4});
    }

    /**
     * Encodes the image into a JPEG
     * @param {number} [quality=90] The JPEG quality to use
     * @return {Promise<Uint8Array>}
     */
    async encodeJPEG(quality = 90) {
        quality = Math.max(1, Math.min(100, quality));
        const jpegCanvas = new this.constructor(this.width, this.height);
        jpegCanvas.fill(0xff);
        jpegCanvas.composite(this);
        return jpeglib.encode(this.width, this.height, quality, jpegCanvas.bitmap);
    }

    /**
     * Decodes an image (PNG, JPEG or TIFF)
     * @param {Buffer|Uint8Array} data The binary data to decode
     * @return {Promise<Image>} The decoded image
     */
    static async decode(data) {
        let image;

        let view;
        if (!ArrayBuffer.isView(data)) {
            data = new Uint8Array(data);
            view = new DataView(data.buffer);
        } else {
            data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        }

        if (view.getUint32(0, false) === 0x89504e47) { // PNG
            const {width, height, pixels} = await png.decode(data);
            image = new this(width, height);
            image.bitmap.set(pixels);
        } else if ((view.getUint32(0, false) >>> 8) === 0xffd8ff) { // JPEG
            const status = await jpeglib.decode(0, data, 0, 0);
            if (status === 1) throw new Error('Failed decoding JPEG image');
            const [pixelType, width, height] = jpeglib.meta(0);
            image = new this(width, height);
            const buffer = jpeglib.buffer(0);
            jpeglib.free(0);

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
        } else if (view.getUint32(0, false) === 0x49492a00) {
            const status = await tifflib.decode(0, data);
            if (status === 1) throw new Error('Failed decoding TIFF image');
            const meta = tifflib.meta(0);
            const buffer = tifflib.buffer(0);
            tifflib.free(0);

            image = new this(...meta);
            image.bitmap.set(buffer);
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

        if (typeof svg !== 'string')
            svg = svg.toString();

        const status = await svglib.rgba(0, svg, mode, size, size, size);
        if (status === 1) throw new Error('Failed parsing SVG');
        if (status === 2) throw new Error('Failed rendering SVG');
        const meta = svglib.meta(0);
        const image = new this(...meta);
        image.bitmap.set(svglib.buffer(0));
        svglib.free(0);
        return image;
    }

    /**
     * Wrap at individual characters. For use with {@link Image.renderText}
     * @return {boolean}
     */
    static get WRAP_STYLE_CHAR() {
        return true;
    }

    /**
     * Wrap at word ends. For use with {@link Image.renderText}
     * @return {boolean}
     */
    static get WRAP_STYLE_WORD() {
        return false;
    }

    /**
     * Creates a new image containing the rendered text.
     * @param {Uint8Array} font TrueType (ttf/ttc) or OpenType (otf) font buffer to use
     * @param {number} scale Font size to use
     * @param {string} text Text to render
     * @param {number} color Text color to use
     * @param {number} wrapWidth Image width before wrapping
     * @param {boolean} wrapStyle Whether to break at words ({@link WRAP_STYLE_WORD}) or at characters ({@link WRAP_STYLE_CHAR})
     * @return {Promise<Image>} The rendered text
     */
    static async renderText(font, scale, text, color = 0xffffffff, wrapWidth = Infinity, wrapStyle = this.WRAP_STYLE_WORD) {
        const [r, g, b, a] = Image.colorToRGBA(color);
        await fontlib.load(0, font, scale);
        fontlib.render(0, 0, scale, r, g, b, text, wrapWidth === Infinity ? null : wrapWidth, wrapStyle);
        const buffer = fontlib.buffer(0);
        const [width, height] = fontlib.meta(0);
        fontlib.free(0);
        const image = new this(width, height);
        image.bitmap.set(buffer);
        image.opacity(a / 0xff);

        return image;
    }

}

/**
 * Represents a frame in a GIF
 * @extends Image
 */
class Frame extends Image {
    /**
     * Creates a new, blank frame
     * @param {number} width
     * @param {number} height
     * @param {number} [duration = 100] The frames duration (in ms)
     * @return {Frame}
     */
    constructor(width, height, duration = 100) {
        if (isNaN(duration) || duration < 0)
            throw new RangeError('Invalid frame duration');

        super(width, height);
        this.duration = duration;
    }

    toString() {
        return `Frame<${this.width}x${this.height}x${this.duration}ms>`;
    }

    /**
     * Converts an Image instance to a Frame, cloning it in the process
     * @param {Image} image The image to create the frame from
     * @param {number} [duration = 100] The frames duration (in ms)
     * @return {Frame}
     */
    static from(image, duration) {
        if (!(image instanceof Image))
            throw new TypeError('Invalid image passed');
        const frame = new Frame(image.width, image.height, duration);
        frame.bitmap.set(image.bitmap);

        return frame;
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

        this.width = frames[0].width;
        this.height = frames[0].height;

        for (const frame of this) {
            if (!(frame instanceof Frame))
                throw new TypeError(`Frame ${this.indexOf(frame)} is not an instance of Frame`);

            if (frame.width !== this.width) throw new Error('Frames have different widths');
            if (frame.height !== this.height) throw new Error('Frames have different heights');
        }

        if (loopCount < -1 || isNaN(loopCount))
            throw new RangeError('Invalid loop count');

        this.loopCount = loopCount;
    }

    toString() {
        return `GIF<${this.width}x${this.height}x${this.duration}ms>`;
    }

    /**
     * The GIFs duration (in ms)
     * @return {number}
     */
    get duration() {
        return [...this].reduce((acc, frame) => acc + frame.duration, 0);
    }

    /**
     * Encodes the image into a GIF
     * @param {number} [quality=10] GIF quality ((best) 1..30 (worst))
     * @return {Promise<Uint8Array>} The encoded data
     */
    async encode(quality = 10) {
        const encoder = await giflib.GIFEncoder.initialize(this.width, this.height, this.loopCount);
        for (const frame of this) {
            if (!(frame instanceof Frame)) throw new Error('GIF contains invalid frames');
            encoder.add(~~(frame.duration / 10), quality, frame.bitmap);
        }

        const encoded = encoder.buffer();
        encoder.free();
        return encoded;
    }
}

module.exports = {Image, GIF, Frame};
