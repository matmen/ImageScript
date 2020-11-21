const png = require('./utils/png');
const gif = require('./utils/gif');

/**
 * Represents an image; provides utility functions
 */
class Image {
    /**
     * This is for internal use.
     * If you intend on creating a new image, use {@link Image.new} instead.
     * @param {SharedArrayBuffer} data
     * @property {number} width The images width
     * @property {number} height The images height
     */
    constructor(data) {
        if (!(data instanceof SharedArrayBuffer))
            throw new TypeError(`${this.constructor.name} is not a constructor. Use \`Image.new\` instead`);

        /** @private */
        this.__array__ = new Uint8ClampedArray(data);

        /**
         * The images RGBA pixel data
         * @type {Uint8ClampedArray}
         */
        this.bitmap = this.__array__.subarray(4, this.__array__.length);

        if (this.bitmap.length !== (this.width * this.height * 4))
            throw new Error('Invalid image data');

        /** @private */
        this.refs = new Array(this.width);

        {
            let row = 0;
            let offset = 0;
            const row_length = 4 * this.width;

            while (offset < this.bitmap.length) {
                this.refs[row++] = new Uint32Array(this.__array__.buffer, 4 + offset, this.width);

                offset += row_length;
            }
        }
    }

    /**
     * @private
     * @returns {string}
     */
    toString() {
        return `Image<${this.width}x${this.height}>`;
    }

    /**
     * Creates a new image with the given dimensions
     * @param {number} width
     * @param {number} height
     * @param {number} [fillColor = 0] (0..0xffffffff)
     * @returns {Image}
     */
    static new(width, height, fillColor = 0) {
        width = ~~width;
        height = ~~height;

        if (width > 0xffff)
            throw new RangeError('Image width cannot exceed 65535 pixels');
        if (width < 1)
            throw new RangeError('Image has to be at least 1 pixel wide');
        if (height > 0xffff)
            throw new RangeError('Image height cannot exceed 65535 pixels');
        if (height < 1)
            throw new RangeError('Image has to be at least 1 pixel high');
        if (width * height > 2048 ** 2)
            throw new RangeError('Invalid image size (<= 2^22px)');

        return Image.__new__(width, height, fillColor);
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} fillColor
     * @returns {Image}
     * @private
     */
    static __new__(width, height, fillColor = 0) {
        const data = new SharedArrayBuffer(width * height * 4 + 4);
        const dataUint8Clamped = new Uint8ClampedArray(data);
        dataUint8Clamped.set([width >> 8 & 0xff, width & 0xff, height >> 8 & 0xff, height & 0xff]);

        const image = new Image(data);

        if (fillColor)
            image.__fast_fill__(Image.colorToRGBA(fillColor));

        return image;
    }

    /**
     * The images width
     * @returns {number}
     */
    get width() {
        return (this.__array__[0] << 8) | this.__array__[1];
    }

    /**
     * The images height
     * @returns {number}
     */
    get height() {
        return (this.__array__[2] << 8) | this.__array__[3];
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
        for (let y = 1; y <= this.height; y++) {
            for (let x = 1; x <= this.width; x++) {
                yield [x, y, this.getPixelAt(x, y)];
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
     * @private
     */
    static rgbaToHsla(r, g, b, a) {
        return Image.rgbaToHSLA(r, g, b, a);
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
        const i = (~~y - 1) * this.width * 4 + (~~x - 1) * 4;
        const [r, g, b, a] = this.bitmap.subarray(i, i + 4);
        return Image.rgbaToColor(r, g, b, a);
    }

    /**
     * Sets the pixel color for the specified position
     * @param {number} x
     * @param {number} y
     * @param {number} pixelColor
     */
    setPixelAt(x, y, pixelColor) {
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
        const i = (~~y - 1) * this.width * 4 + (~~x - 1) * 4;
        this.bitmap.set(Image.colorToRGBA(pixelColor), i);
    }

    /**
     * @private
     * @param {number} x
     * @param {number} y
     */
    __check_boundaries__(x, y) {
        if (isNaN(x)) throw new TypeError(`Invalid pixel coordinates (x=${x})`);
        if (isNaN(x)) throw new TypeError(`Invalid pixel coordinates (y=${y})`);
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
        const func = typeof color === 'function';
        if (func) {
            for (const [x, y] of this)
                this.__set_pixel__(x, y, color(x, y));
        } else this.__fast_fill__(Image.colorToRGBA(color));

        return this;
    }

    /**
     * @private
     * @param {number[]} rgba
     */
    __fast_fill__(rgba) {
        let x = this.width;
        let y = this.height;
        while (0 <= --x)
            this.bitmap.set(rgba, 4 * x);
        while (0 < --y)
            this.bitmap.copyWithin(4 * (y * this.width), 0, 4 * this.width);
    }

    /**
     * Clones the current image
     * @returns {Image}
     */
    clone() {
        return new Image(this.__toSharedBuffer__().slice());
    }

    /**
     * @private
     * @returns {ArrayBufferLike<SharedArrayBuffer>}
     */
    __toSharedBuffer__() {
        return this.__array__.buffer;
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
        if (factor === 1) return this;
        return this.resize(this.width * factor, this.height * factor, mode);
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
        if (width === Image.RESIZE_AUTO && height === Image.RESIZE_AUTO) throw new Error('RESIZE_AUTO can only be used for either width or height, not for both');
        else if (width === Image.RESIZE_AUTO) width = this.width / this.height * height;
        else if (height === Image.RESIZE_AUTO) height = this.height / this.width * width;

        width = Math.floor(width);
        height = Math.floor(height);

        if (width > 0xffff)
            throw new RangeError('Image width cannot exceed 65535 pixels');
        if (width < 1)
            throw new RangeError('Image has to be at least 1 pixel wide');
        if (height > 0xffff)
            throw new RangeError('Image height cannot exceed 65535 pixels');
        if (height < 1)
            throw new RangeError('Image has to be at least 1 pixel high');
        if (width * height > 2048 ** 2)
            throw new RangeError('Invalid image size (<= 2^22px)');

        if (mode === Image.RESIZE_NEAREST_NEIGHBOR)
            return this.__resize_nearest_neighbor__(width, height);
        else throw new Error('Invalid resize mode');
    }

    /**
     * @private
     * @param {number} width The new width
     * @param {number} height The new height
     */
    __resize_nearest_neighbor__(width, height) {
        const sharedArrayBuffer = new SharedArrayBuffer(width * height * 4 + 4);
        const destinationBuffer = new Uint8ClampedArray(sharedArrayBuffer);
        destinationBuffer.set([width >> 8 & 0xff, width & 0xff, height >> 8 & 0xff, height & 0xff]);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const ySrc = Math.floor((y * this.height) / height);
                const xSrc = Math.floor((x * this.width) / width);

                const destPos = (y * width + x) * 4;
                const srcPos = (ySrc * this.width + xSrc) * 4;

                destinationBuffer.set(this.bitmap.subarray(srcPos, srcPos + 4), destPos + 4);
            }
        }

        return this.__apply__(new Image(sharedArrayBuffer));
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

        const sharedArrayBuffer = new SharedArrayBuffer(width * height * 4 + 4);
        const destinationBuffer = new Uint8ClampedArray(sharedArrayBuffer);
        destinationBuffer.set([width >> 8 & 0xff, width & 0xff, height >> 8 & 0xff, height & 0xff]);

        for (let tY = 0; tY < height; tY++) {
            const idx = ((tY + y) * this.width + x) * 4;
            const tIdx = tY * width * 4;
            destinationBuffer.set(this.bitmap.subarray(idx, idx + width * 4), tIdx + 4);
        }

        return new Image(sharedArrayBuffer);
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
        if (x < 1) {
            width += x;
            x = 1;
        }

        if (y < 1) {
            height += y;
            y = 1;
        }

        const right = Math.max(Math.min(x + width, this.width), 1);
        let xPos = right;
        while (x <= --xPos)
            this.bitmap.set(Image.colorToRGBA(color), 4 * (xPos + y * this.width));
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
        for (let currentY = Math.max(0, y - radius); currentY < Math.min(y + radius, this.height); currentY++) {
            for (let currentX = Math.max(0, x - radius); currentX < Math.min(x + radius, this.width); currentX++) {
                if (Math.min(currentY, currentX) < 1 || currentX > this.width || currentY > this.height)
                    continue;

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
        if (isNaN(opacity) || opacity < 0 || opacity > 1)
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
        if (isNaN(saturation) || saturation < 0 || saturation > 1)
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
        if (isNaN(saturation) || saturation < 0 || saturation > 1)
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
        if (isNaN(saturation) || saturation < 0 || saturation > 1)
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
        return this.fill((x, y) => {
            const [h, s, l, a] = Image.rgbaToHsla(...Image.colorToRGBA(this.getPixelAt(x, y)));
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
        return this.fill((x, y) => {
            const [h, s, l, a] = Image.rgbaToHsla(...Image.colorToRGBA(this.getPixelAt(x, y)));
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
        for (const [sX, sY] of source) {
            const tX = x + sX;
            const tY = y + sY;

            if (Math.min(tX, tY) < 1 || tX > this.width || tY > this.height)
                continue;

            const bgPixel = this.getPixelAt(tX, tY);
            const fgPixel = source.getPixelAt(sX, sY);
            if ((fgPixel & 0xff) === 0xff) this.__set_pixel__(tX, tY, fgPixel);
            if ((fgPixel & 0xff) === 0x00) this.__set_pixel__(tX, tY, bgPixel);
            else this.__set_pixel__(tX, tY, Image.__alpha_blend__(fgPixel, bgPixel));
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
        const fgRGBA = Image.colorToRGBA(fg);
        const bgRGBA = Image.colorToRGBA(bg);

        const alpha = fgRGBA[3] + 1;
        const inv_alpha = 256 - fgRGBA[3];

        const rR = (alpha * fgRGBA[0] + inv_alpha * bgRGBA[0]) >> 8;
        const rG = (alpha * fgRGBA[1] + inv_alpha * bgRGBA[1]) >> 8;
        const rB = (alpha * fgRGBA[2] + inv_alpha * bgRGBA[2]) >> 8;
        const rA = Math.max(fgRGBA[3], bgRGBA[3]);

        return Image.rgbaToColor(rR, rG, rB, rA);
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
            const [h, s, l, a] = Image.rgbaToHsla(...Image.colorToRGBA(color));
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
            const [h, s, l, a] = Image.rgbaToHsla(...Image.colorToRGBA(color));
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
            const [h, s, l, a] = Image.rgbaToHsla(...Image.colorToRGBA(color));
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
            const [h, s, l, a] = Image.rgbaToHsla(...Image.colorToRGBA(color));
            this.__set_pixel__(x, y, Image.hslaToColor((h + degrees / 360) % 1, s, l, a));
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
        for (const [, , color] of this.iterateWithColors()) {
            const rgba = Image.colorToRGBA(color);
            for (let i = 0; i < 3; i++)
                colorAvg[i] += rgba[i];
            divisor += rgba[3] / 255;
        }

        return Image.rgbaToColor(...colorAvg.map(v => v / divisor), 0xff);
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
        this.__array__ = image.__array__;
        this.bitmap = image.bitmap;

        return this;
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
     * Decodes a PNG image
     * @param {Buffer|Uint8Array} buffer The binary data to decode
     * @return {Promise<Image>} The decoded image
     */
    static async decode(buffer) {
        return new Image(await png.decode(new Uint8Array(buffer)));
    }
}

/**
 * Represents a frame in a GIF
 * @extends Image
 */
class Frame extends Image {
    /**
     * This is for internal use.
     * If you intend on creating a frame from an Image, use {@link Frame.from} instead.
     * @param {SharedArrayBuffer} data
     * @param {number} [duration = 100]
     */
    constructor(data, duration = 100) {
        super(data);
        if (isNaN(duration) || duration < 0 || duration > 0xffff)
            throw new RangeError('Invalid frame duration');
        this.duration = duration;
    }

    toString() {
        return `Frame<${this.width}x${this.height}x${this.duration}ms>`;
    }

    /**
     * Creates a new, blank frame
     * @param {number} width
     * @param {number} height
     * @param {number} [duration = 100] The frames duration (in ms)
     * @param {number} [fillColor = 0] (0..0xffffffff)
     * @return {Frame}
     */
    static new(width, height, duration, fillColor) {
        const image = super.new(width, height, fillColor);
        return Frame.from(image, duration);
    }

    /**
     * Converts an Image instance to a Frame
     * @param {Image} image The image to create the frame from
     * @param {number} [duration = 100] The frames duration (in ms)
     * @return {Frame}
     */
    static from(image, duration) {
        if (!(image instanceof Image))
            throw new TypeError('Invalid image passed');
        return new Frame(image.__toSharedBuffer__(), duration);
    }

    /**
     * @private
     */
    __toSharedTimedBuffer__() {
        const imageBuffer = this.__array__;
        const data = new Uint8Array(imageBuffer.byteLength + 2);
        data.set([(this.duration >> 8) & 0xff, this.duration & 0xff], 0);
        data.set(imageBuffer, 2);
        return data;
    }
}

/**
 * Represents a GIF image as an array of frames
 * @extends Array<Frame>
 */
class GIF extends Array {
    /**
     * Creates a new GIF image.
     * The maximum frame count for a GIF is calculated based on its dimensions:
     * ```js
     * const frameCount = Math.max(1, Math.min(240, Math.floor(30 * 512 / Math.sqrt(gif.width * gif.height))));
     * ```
     * @param {Frame[]} frames The frames to create the GIF from
     * @param {number} [loopCount=0] How often to loop the GIF for (0 = unlimited)
     * @property {number} loopCount How often the GIF will loop for
     */
    constructor(frames, loopCount = 0) {
        for (const frame of frames) {
            if (!(frame instanceof Frame))
                throw new TypeError(`Frame ${frames.indexOf(frame)} is not an instance of Frame`);
        }

        if (loopCount < 0 || loopCount > 0xffff)
            throw new RangeError('Invalid loop count');

        super(...frames);
        this.loopCount = loopCount;

        const sizeSqrt = Math.sqrt(this.width * this.height);
        const maxFrames = Math.floor(30 * 512 / sizeSqrt);

        if (Math.max(this.width, this.height) > 0xffff)
            throw new RangeError('Invalid GIF dimensions (<= 65535px)');
        if (this.width * this.height > 2048 ** 2)
            throw new RangeError('Invalid GIF size (<= 2^22px)');
        if (frames.length > maxFrames)
            throw new RangeError(`GIF cannot exceed ${maxFrames} frames at this resolution`);
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
     * The GIFs width
     * @return {number}
     */
    get width() {
        return Math.max(...[...this].map(frame => frame.width));
    }

    /**
     * The GIFs height
     * @return {number}
     */
    get height() {
        return Math.max(...[...this].map(frame => frame.height));
    }

    /**
     * @private
     */
    __toArray__() {
        return [this.loopCount, ...[...this].map(frame => frame.__toSharedTimedBuffer__())];
    }

    /**
     * Encodes the image into a GIF
     * @return {Uint8Array} The encoded data
     */
    encode() {
        const frames = [];
        for (const frame of this) {
            frames.push({
                delay: frame.duration,
                width: frame.width,
                height: frame.height,
                pixels: frame.bitmap
            });
        }

        return gif(frames, {
            width: this.width,
            height: this.height,
            comment: 'powered by ImageScript',
            loop: isNaN(this.loopCount) ? 0 : this.loopCount
        });
    }
}

module.exports = {Image, GIF, Frame};