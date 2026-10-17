const {Image, Frame, GIF, Animation, TextLayout} = require('..');
const zlib = require('zlib');

const assert = (condition, message) => {
    if (condition) return;
    console.error(message);
    process.exit(1);
};

const rgba = (image, x, y) => Image.colorToRGBA(image.getPixelAt(x, y));

(async () => {
    // rotating non-square images by right angles (#29)
    {
        const image = new Image(3, 2).fill((x, y) => Image.rgbaToColor(x + 1, y + 1, 0, 255));
        const ccw = image.clone().rotate(90);
        assert(ccw.width === 2 && ccw.height === 3, 'rotate(90): dimensions not swapped');
        assert(rgba(ccw, 0, 2).slice(0, 2).join() === '1,1', 'rotate(90): top left should end up bottom left');
        assert(rgba(ccw, 1, 0).slice(0, 2).join() === '3,2', 'rotate(90): bottom right should end up top right');

        const cw = image.clone().rotate(270);
        assert(rgba(cw, 1, 0).slice(0, 2).join() === '1,1', 'rotate(270): top left should end up top right');
        for (const [x, y, color] of cw.iterateWithColors()) assert((color & 0xff) === 255, `rotate(270): hole at ${x},${y}`);
    }

    // free rotation keeps the edges
    {
        const image = new Image(4, 4).fill(0xff0000ff).rotate(0.001, false);
        for (const [x, y, color] of image.iterateWithColors()) assert((color & 0xff) > 250, `rotate: edge pixel ${x},${y} lost`);
    }

    // compositing respects the destination alpha
    {
        const image = new Image(1, 1).composite(new Image(1, 1).fill(Image.rgbaToColor(255, 255, 255, 128)));
        assert(rgba(image, 0, 0).join() === '255,255,255,128', 'composite: semi-transparent white onto transparent turned ' + rgba(image, 0, 0));

        const blend = new Image(1, 1).fill(Image.rgbaToColor(255, 0, 0, 128)).composite(new Image(1, 1).fill(Image.rgbaToColor(0, 0, 255, 128)));
        assert(rgba(blend, 0, 0)[3] === 192, 'composite: alpha should combine to 0.75');
    }

    // cropCircle(max)
    {
        const count = image => [...image.iterateWithColors()].filter(([, , c]) => c & 0xff).length;
        assert(count(new Image(8, 2).fill(0xffffffff).cropCircle(true)) > count(new Image(8, 2).fill(0xffffffff).cropCircle(false)), 'cropCircle: max has no effect');
    }

    // crop is clipped to the image
    {
        const image = new Image(10, 2).fill((x, y) => Image.rgbaToColor(x + 1, y + 1, 0, 255)).crop(5, 0, 10, 2);
        assert(image.width === 5 && image.height === 2, 'crop: region not clipped');
        assert(rgba(image, 0, 1).slice(0, 2).join() === '6,2', 'crop: wrong pixels');

        let threw = false;
        try { new Image(10, 10).crop(20, 20, 5, 5); } catch { threw = true; }
        assert(threw, 'crop: region outside the image should throw');
    }

    // drawBox outside of the image
    {
        new Image(10, 10).drawBox(0, 20, 5, 5, 0xffffffff).drawBox(20, 0, 5, 5, 0xffffffff).drawBox(-10, -10, 5, 5, 0xffffffff);
        const image = new Image(4, 4).drawBox(-2, -2, 3, 3, 0xffffffff);
        assert(image.getPixelAt(0, 0) === 0xffffffff && image.getPixelAt(1, 1) === 0, 'drawBox: clipping failed');
    }

    // averageColor is weighted by alpha
    {
        assert(new Image(2, 2).fill(Image.rgbaToColor(255, 0, 0, 128)).averageColor() === 0xff0000ff, 'averageColor: semi-transparent red');
        const image = new Image(2, 1);
        image.setPixelAt(0, 0, 0x00ff00ff);
        image.setPixelAt(1, 0, 0xff000000);
        assert(image.averageColor() === 0x00ff00ff, 'averageColor: transparent pixels must not count');
    }

    // gradients return unsigned colors like rgbaToColor
    assert(Image.gradient({0: 0xff0000ff, 1: 0xff0000ff})(0.5) === 0xff0000ff, 'gradient: signed color');

    // PNG metadata as the only argument
    {
        const encoded = await new Image(1, 1).encode({title: 'regression'});
        assert(Buffer.from(encoded).includes(Buffer.from('regression')), 'encode(metadata): title missing');
    }

    // frames keep their metadata
    {
        const frame = new Frame(10, 10, 500, 2, 4, Frame.DISPOSAL_BACKGROUND);
        const clone = frame.clone();
        assert(clone instanceof Frame && clone.duration === 500 && clone.xOffset === 2 && clone.disposalMode === 'background', 'Frame.clone lost metadata');

        const resized = frame.resize(5, 5);
        assert(resized === frame && frame.duration === 500 && frame.xOffset === 1 && frame.yOffset === 2, 'Frame.resize lost metadata');
    }

    // GIFs behave like arrays
    {
        const gif = new GIF([new Frame(4, 4), new Frame(4, 4), new Frame(4, 4)], 2);
        assert(gif.slice(1).length === 2 && gif.slice(1).loopCount === 2, 'GIF.slice(start)');
        assert(gif.slice(-1).length === 1, 'GIF.slice(negative)');
        assert(gif.map(frame => frame.width).join() === '4,4,4', 'GIF.map');
        assert(gif.filter(() => true).length === 3, 'GIF.filter');
    }

    // resizing GIFs scales partial frames proportionally
    {
        const gif = new GIF([new Frame(10, 10), new Frame(4, 4, 100, 6, 6)]).resize(5, 5);
        assert(gif.width === 5 && gif.height === 5, `GIF.resize: canvas is ${gif.width}x${gif.height}`);
        assert(gif[1].width === 2 && gif[1].xOffset === 3, 'GIF.resize: partial frame not scaled');
    }

    // coordinates are 0-based everywhere
    {
        const image = new Image(3, 3);
        image.setPixelAt(0, 0, 0xff0000ff);
        assert(image.bitmap[0] === 0xff, 'setPixelAt(0, 0) should set the first pixel');
        assert([...image][0].join() === '0,0' && [...image].pop().join() === '2,2', 'iterator should be 0-based');

        let threw = false;
        try { image.getPixelAt(3, 0); } catch { threw = true; }
        assert(threw, 'getPixelAt(width, 0) should be out of bounds');

        const filled = [];
        new Image(2, 1).fill((x, y) => (filled.push([x, y]), 0));
        assert(filled.join(';') === '0,0;1,0', 'fill callback should be 0-based');

        const box = new Image(3, 3).drawBox(1, 1, 1, 1, 0xffffffff);
        assert(box.getPixelAt(1, 1) === 0xffffffff && box.getPixelAt(0, 0) === 0, 'drawBox should be 0-based');

        const target = new Image(3, 3).composite(new Image(1, 1).fill(0xffffffff), 1, 1);
        assert(target.getPixelAt(1, 1) === 0xffffffff, 'composite and getPixelAt should agree');

        const corners = new Image(8, 8).fill(0xffffffff).roundCorners(3);
        const alpha = (x, y) => corners.getPixelAt(x, y) & 0xff;
        for (let y = 0; y < 8; y++)
            for (let x = 0; x < 8; x++)
                assert(alpha(x, y) === alpha(7 - x, y) && alpha(x, y) === alpha(x, 7 - y), `roundCorners should be symmetric (${x}, ${y})`);
        assert(alpha(0, 0) < 64 && alpha(3, 0) === 255 && alpha(0, 1) > 0 && alpha(0, 1) < 255, 'roundCorners should antialias the arc');
    }

    // text layout accepts the pre 3.0 (swapped) option names
    {
        const legacy = new TextLayout({verticalAlign: 'center', horizontalAlign: 'bottom'});
        assert(legacy.horizontalAlign === 'center' && legacy.verticalAlign === 'bottom', 'TextLayout: legacy names');
        const current = new TextLayout({horizontalAlign: 'right', verticalAlign: 'middle'});
        assert(current.horizontalAlign === 'right' && current.verticalAlign === 'middle', 'TextLayout: names');
    }

    // HSL conversions round instead of truncating, so identity operations keep the image
    {
        const image = new Image(64, 64).fill((x, y) => Image.rgbaToColor(x * 4, y * 4, (x * y) & 255, 255 - x));
        const original = Buffer.from(image.bitmap);
        assert(Buffer.from(image.clone().lightness(1).bitmap).equals(original), 'lightness(1) should not change the image');
        assert(Buffer.from(image.clone().saturation(1).bitmap).equals(original), 'saturation(1) should not change the image');
        assert(Buffer.from(image.clone().hueShift(360).bitmap).equals(original), 'hueShift(360) should not change the image');
    }

    // negative hues wrap around
    {
        const color = Image.rgbToColor(255, 40, 0);
        const shifted = new Image(1, 1).fill(color).hueShift(-300).getPixelAt(0, 0);
        assert(shifted === new Image(1, 1).fill(color).hueShift(60).getPixelAt(0, 0), 'hueShift(-300) should equal hueShift(60), got ' + Image.colorToRGBA(shifted));
    }

    // compositing rounds to the nearest value instead of up
    {
        const image = new Image(1, 1).fill(Image.rgbaToColor(0, 0, 0, 255)).composite(new Image(1, 1).fill(Image.rgbaToColor(100, 100, 100, 51)));
        assert(rgba(image, 0, 0)[0] === 20, 'composite: 100 at 20% over black should be 20, got ' + rgba(image, 0, 0)[0]);
    }

    // cover and contain hit the requested dimensions despite floating point scale factors
    {
        for (let width = 1; width < 200; width++) {
            for (const target of [7, 50, 99, 128]) {
                const covered = new Image(width, 61).cover(target, 33);
                assert(covered.width === target && covered.height === 33, `cover(${target}, 33) of ${width}x61 returned ${covered}`);
                const contained = new Image(width, 61).contain(target, 33);
                assert((contained.width === target || contained.height === 33) && contained.width <= target && contained.height <= 33, `contain(${target}, 33) of ${width}x61 returned ${contained}`);
            }
        }
    }

    // decoding an uncompressed TIFF with a predictor leaves the input untouched
    {
        const entries = [[256, 3, 4], [257, 3, 1], [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 3, 1], [279, 4, 4], [317, 3, 2]];
        const offset = 8 + 2 + entries.length * 12 + 4;
        const data = Buffer.alloc(offset + 4);
        data.write('II*\0', 0, 'latin1');
        data.writeUInt32LE(8, 4);
        data.writeUInt16LE(entries.length, 8);
        entries.forEach(([tag, type, value], i) => {
            const entry = 10 + i * 12;
            data.writeUInt16LE(tag, entry);
            data.writeUInt16LE(type, entry + 2);
            data.writeUInt32LE(1, entry + 4);
            if (type === 3) data.writeUInt16LE(value, entry + 8);
            else data.writeUInt32LE(tag === 273 ? offset : value, entry + 8);
        });
        data.set([10, 10, 10, 10], offset);

        const first = await Image.decode(data), second = await Image.decode(data);
        assert(Buffer.from(first.bitmap).equals(Buffer.from(second.bitmap)), 'TIFF: decoding twice should give the same result');
        assert(rgba(second, 3, 0)[0] === 40, 'TIFF: horizontal predictor not applied correctly');
    }

    // zlib streams with more data than the image needs (and a broken checksum, so the JS inflater is used)
    {
        const chunk = (type, body) => {
            const out = Buffer.alloc(12 + body.length);
            out.writeUInt32BE(body.length);
            out.write(type, 4, 'latin1');
            body.copy(out, 8);
            out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
            return out;
        };
        const stored = (final, bytes) => Buffer.from([final, bytes.length, 0, ~bytes.length & 255, 255, ...bytes]);
        const header = Buffer.alloc(13);
        header.writeUInt32BE(1);
        header.writeUInt32BE(1, 4);
        header.set([8, 6], 8);
        const idat = Buffer.concat([Buffer.from([0x78, 0x01]), stored(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), stored(1, [1, 2, 3, 4, 5]), Buffer.alloc(4)]);
        const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
        const image = await Image.decode(png);
        assert(rgba(image, 0, 0).join() === '1,2,3,4', 'PNG: overlong zlib stream decoded incorrectly');
    }

    // nested entities can't blow up the SVG parser
    {
        let dtd = '<!ENTITY e0 "x">';
        for (let i = 1; i <= 4; i++) dtd += `<!ENTITY e${i} "${`&e${i - 1};`.repeat(40)}">`;
        const svg = `<!DOCTYPE svg [${dtd}]><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><desc>${'&e4;'.repeat(50)}</desc></svg>`;
        let error = null;
        try { await Image.renderSVG(svg); } catch (err) { error = err; }
        assert(error && /entity expansion/.test(error.message), 'SVG: entity expansion should be limited');
    }

    // resizing filters average instead of skipping pixels, in premultiplied alpha
    {
        const checker = new Image(64, 64).fill((x, y) => (x + y) & 1 ? 0xffffffff : 0x000000ff);
        for (const mode of [Image.RESIZE_BILINEAR, Image.RESIZE_BICUBIC, Image.RESIZE_AREA]) {
            const small = checker.clone().resize(8, 8, mode);
            for (const [x, y, color] of small.iterateWithColors())
                assert(Math.abs((color >>> 24) - 128) <= 2, `${mode}: checkerboard should average to grey at ${x},${y}, got ${color >>> 24}`);
        }

        // fully transparent pixels must not bleed their (garbage) color
        const half = new Image(4, 1).fill((x) => x < 2 ? 0xff000000 : 0x0000ffff).resize(2, 1);
        assert(rgba(half, 0, 0).slice(0, 3).join() === '0,0,255', 'resize: transparent pixels bled into the result: ' + rgba(half, 0, 0));

        const nearest = new Image(4, 1).fill((x) => Image.rgbToColor(x, 0, 0)).resize(2, 1, Image.RESIZE_NEAREST_NEIGHBOR);
        assert(rgba(nearest, 0, 0)[0] === 1 && rgba(nearest, 1, 0)[0] === 3, 'nearest neighbor should sample pixel centers');

        let threw = false;
        try { checker.clone().resize(8, 8, 'RESIZE_FOO'); } catch { threw = true; }
        assert(threw, 'resize should reject unknown modes');
    }

    // circles are antialiased and symmetric around the pixel center
    {
        const circle = new Image(9, 9).drawCircle(4, 4, 3.5, 0xffffffff);
        const alpha = (x, y) => circle.getPixelAt(x, y) & 0xff;
        for (let y = 0; y < 9; y++)
            for (let x = 0; x < 9; x++)
                assert(alpha(x, y) === alpha(8 - x, y) && alpha(x, y) === alpha(y, x), `drawCircle should be symmetric (${x}, ${y})`);
        assert(alpha(4, 4) === 255 && alpha(0, 0) === 0 && alpha(1, 2) > 0 && alpha(1, 2) < 255, 'drawCircle should antialias its edge');

        const cropped = new Image(6, 6).fill(0xffffffff).cropCircle();
        const a = (x, y) => cropped.getPixelAt(x, y) & 0xff;
        for (let y = 0; y < 6; y++)
            for (let x = 0; x < 6; x++)
                assert(a(x, y) === a(5 - x, y) && a(x, y) === a(x, 5 - y), `cropCircle should be symmetric (${x}, ${y})`);

        const feathered = new Image(41, 41).fill(0xffffffff).cropCircle(false, 0.5);
        const f = x => feathered.getPixelAt(x, 20) & 0xff;
        assert(f(20) === 255 && f(12) === 255 && f(5) > 0 && f(5) < 255 && f(0) < 32, 'cropCircle feathering should only soften the outer part');
    }

    // dominant colors are exact and dark saturated colors aren't treated as black
    {
        assert(new Image(4, 4).fill(0xff0000ff).dominantColor() === 0xff0000ff, 'dominantColor of pure red');
        assert(new Image(4, 4).fill(0x336699ff).dominantColor() === 0x336699ff, 'dominantColor of #336699');

        const navy = new Image(10, 10).fill(0x00006eff).drawBox(0, 0, 2, 2, 0xc8c800ff);
        assert(navy.dominantColor() === 0x00006eff, 'dominantColor: navy should beat a small yellow area');
        assert(new Image(4, 4).fill(0x000000ff).dominantColor() === 0x000000ff, 'dominantColor: all black falls back to black');
        assert(new Image(4, 4).dominantColor() === 0x000000ff, 'dominantColor: transparent image');
    }

    // PNGs use the smallest lossless color type
    {
        const cases = {
            palette: [new Image(20, 10).fill((x) => x & 1 ? 0xff000080 : 0x00ff00ff), 3],
            greys: [new Image(300, 1).fill((x) => Image.rgbToColor(x & 255, x & 255, x & 255)), 3],
            greyAlpha: [new Image(300, 3).fill((x, y) => Image.rgbaToColor(x & 255, x & 255, x & 255, 100 + y)), 4],
            rgb: [new Image(300, 2).fill((x, y) => Image.rgbToColor(x & 255, x >> 8, y)), 2],
            rgba: [new Image(300, 2).fill((x, y) => Image.rgbaToColor(x & 255, x >> 8, y, 200)), 6]
        };
        for (const [name, [image, type]] of Object.entries(cases)) {
            const encoded = await image.encode();
            const decoded = await Image.decode(encoded);
            assert(Buffer.from(decoded.bitmap).equals(Buffer.from(image.bitmap)), `PNG ${name}: roundtrip failed`);
            assert(encoded[25] === type, `PNG ${name}: expected color type ${type}, got ${encoded[25]}`);
        }

        // truecolor rows are filtered, which makes smooth gradients tiny
        const gradient = new Image(512, 512).fill((x, y) => Image.rgbToColor(x / 2, y / 2, (x + y) / 4));
        const size = (await gradient.encode()).length;
        assert(size < 20000, `PNG: gradient should compress well with row filters, got ${size} bytes`);
        assert(Buffer.from((await Image.decode(await gradient.encode(9))).bitmap).equals(Buffer.from(gradient.bitmap)), 'PNG: filtered roundtrip failed');
    }

    // invertValue inverts HSV value and invertLightness HSL lightness
    {
        const value = new Image(3, 1).fill(x => [Image.rgbaToColor(200, 100, 50, 128), Image.rgbToColor(0, 0, 0), Image.rgbToColor(255, 128, 0)][x]).invertValue();
        assert([0, 1, 2].map(x => rgba(value, x, 0).join(' ')).join() === '55 28 14 128,255 255 255 255,0 0 0 255', 'invertValue should invert HSV value, got ' + [0, 1, 2].map(x => rgba(value, x, 0)));
        const lightness = new Image(1, 1).fill(Image.rgbToColor(200, 100, 50)).invertLightness();
        assert(rgba(lightness, 0, 0).join() === '205,105,55,255', 'invertLightness should invert HSL lightness, got ' + rgba(lightness, 0, 0));
    }

    // encodePNG is an alias of encode
    {
        const image = new Image(3, 3).fill((x, y) => Image.rgbaToColor(x * 80, y * 80, 7, 200));
        const meta = {creationTime: 0, software: 'test'};
        assert(Buffer.from(await image.encodePNG(meta)).equals(Buffer.from(await image.encode(meta))), 'encodePNG(meta) should equal encode(meta)');
        assert(Buffer.from(await image.encodePNG(0, meta)).equals(Buffer.from(await image.encode(0, meta))), 'encodePNG(level, meta) should equal encode(level, meta)');
    }

    // gif frame durations are rounded to centiseconds
    {
        // (different frames: identical ones are merged)
        const gif = new GIF([new Frame(2, 2, 16), new Frame(2, 2, 14).fill(0xff0000ff)]);
        const decoded = await GIF.decode(await gif.encode());
        assert(decoded[0].duration === 20 && decoded[1].duration === 10, `gif durations should round, got ${decoded[0].duration}, ${decoded[1].duration}`);
    }

    // jpegs are rotated as their exif orientation says (fixtures written by Pillow, checked against ImageOps.exif_transpose)
    {
        const fs = require('fs');
        const read = n => fs.readFileSync(`./tests/jpegs/exif-orientation-${n}.jpg`);
        const raw = await Image.decode(read(3), {applyOrientation: false});
        assert(raw.width === 48 && raw.height === 32, 'decode: applyOrientation: false should keep the stored pixels');
        for (const [n, angle] of [[3, 180], [6, 270], [8, 90]]) {
            const oriented = await Image.decode(read(n));
            const expected = (await Image.decode(read(n), {applyOrientation: false})).rotate(angle);
            assert(oriented.width === expected.width && Buffer.from(oriented.bitmap).equals(Buffer.from(expected.bitmap)), `decode: orientation ${n} not applied`);
        }
    }

    // replacing the bitmap keeps every accessor in sync
    {
        const image = new Image(2, 2);
        image.bitmap = new Uint8ClampedArray(16).fill(255);
        assert(image.getPixelAt(1, 1) === 0xffffffff && image.averageColor() === 0xffffffff, 'bitmap setter: views out of sync');
        image.bitmap = new Uint8Array(16);
        assert(image.getPixelAt(0, 0) === 0 && image.bitmap instanceof Uint8ClampedArray, 'bitmap setter: Uint8Array not wrapped');
        let threw = false;
        try { image.bitmap = new Uint8ClampedArray(12); } catch { threw = true; }
        assert(threw, 'bitmap setter should reject a wrong size');
    }

    // color components are rounded and clamped instead of wrapping
    {
        assert(Image.rgbaToColor(256, -1, 127.6, 300) === 0xff0080ff, 'rgbaToColor should clamp and round, got ' + Image.rgbaToColor(256, -1, 127.6, 300).toString(16));
        let threw = false;
        try { Image.rgbToColor(NaN, 0, 0); } catch (e) { threw = e instanceof RangeError; }
        assert(threw, 'rgbToColor(NaN) should throw a RangeError');
    }

    // disposal modes read back as the names they are set with
    {
        const frame = new Frame(1, 1, 100, 0, 0, Frame.DISPOSAL_PREVIOUS);
        assert(frame.disposalMode === 'previous', 'disposalMode should be a name, got ' + frame.disposalMode);
        frame.disposalMode = 0;
        assert(frame.disposalMode === Frame.DISPOSAL_ANY, 'disposalMode set by id should read back as name');
        const decoded = await GIF.decode(await new GIF([new Frame(2, 2, 100, 0, 0, 'background'), new Frame(2, 2).fill(0xff0000ff)]).encode());
        assert(decoded.length === 2, 'gif with disposal modes should roundtrip');
    }

    // options objects as alternatives to positional arguments
    {
        const base = new Image(20, 20).fill(0xff0000ff);
        assert(Buffer.from(base.clone().cropCircle({max: true, feathering: 0.3}).bitmap).equals(Buffer.from(base.clone().cropCircle(true, 0.3).bitmap)), 'cropCircle options');
        assert(base.clone().rotate(45, {resize: false}).width === 20 && base.clone().rotate(45).width > 20, 'rotate options');
        const navy = new Image(10, 10).fill(0x00002aff).drawBox(0, 0, 3, 3, 0xc8c800ff);
        assert(navy.dominantColor({threshold: 0}) === 0x00002aff && navy.dominantColor({ignoreBlack: true}) === navy.dominantColor(true), 'dominantColor options');
    }

    // type checks take any binary data
    {
        const {ImageType} = require('..');
        const png = await new Image(1, 1).encode();
        assert(ImageType.isPNG(png) && ImageType.isPNG(Buffer.from(png)) && ImageType.isPNG(new DataView(png.buffer)) && !ImageType.isGIF(png), 'ImageType checks');
    }

    // blur and sharpen: uniform images stay as they are, transparent pixels don't bleed their color
    {
        const flat = new Image(16, 16).fill(0x336699ff);
        for (const [name, op] of [['blur', i => i.blur(3)], ['blur small', i => i.blur(0.8)], ['sharpen', i => i.sharpen(2, 1.5)]])
            assert(Buffer.from(op(flat.clone()).bitmap).equals(Buffer.from(flat.bitmap)), `${name} changed a uniform image`);
        assert(Buffer.from(flat.clone().blur(0).bitmap).equals(Buffer.from(flat.bitmap)) && Buffer.from(flat.clone().sharpen(0).bitmap).equals(Buffer.from(flat.bitmap)), 'blur(0)/sharpen(0) should do nothing');

        const half = new Image(16, 16).fill((x) => x < 8 ? 0xff000000 : 0x0000ffff).blur(2);
        for (let x = 0; x < 16; x++) {
            const [r, , b, a] = rgba(half, x, 8);
            assert(a === 0 || (r === 0 && b === 255), `blur bled transparent color at ${x}: ${rgba(half, x, 8)}`);
        }

        const edge = new Image(16, 1).fill((x) => x < 8 ? 0x000000ff : 0xffffffff);
        const sharpened = edge.clone().sharpen(1, 1);
        assert(rgba(sharpened, 7, 0)[0] === 0 && rgba(sharpened, 8, 0)[0] === 255, 'sharpen should keep a hard edge hard');
        const soft = new Image(16, 1).fill((x) => Image.rgbToColor(x * 16, x * 16, x * 16)).blur(1);
        const sharp = soft.clone().sharpen(3, 2);
        assert(rgba(sharp, 15, 0)[0] >= rgba(soft, 15, 0)[0] && rgba(sharp, 0, 0)[0] <= rgba(soft, 0, 0)[0], 'sharpen should increase contrast');
    }

    // rgb adjustments
    {
        const image = new Image(64, 4).fill((x, y) => Image.rgbaToColor(x * 4, 255 - x * 4, y * 60, 200));
        for (const [name, op] of [['brightness(1)', i => i.brightness(1)], ['contrast(1)', i => i.contrast(1)], ['gamma(1)', i => i.gamma(1)]])
            assert(Buffer.from(op(image.clone()).bitmap).equals(Buffer.from(image.bitmap)), `${name} should not change the image`);

        const px = color => new Image(1, 1).fill(color);
        assert(rgba(px(0x804020ff).brightness(2), 0, 0).join() === '255,128,64,255', 'brightness(2)');
        assert(rgba(px(0x804020ff).contrast(0), 0, 0).join() === '128,128,128,255', 'contrast(0) should be grey');
        assert(rgba(px(0x40404080).gamma(2), 0, 0).join() === '128,128,128,128', 'gamma(2) should brighten and keep alpha, got ' + rgba(px(0x40404080).gamma(2), 0, 0));
        assert(rgba(px(0xff0000ff).greyscale(), 0, 0).join() === '76,76,76,255', 'greyscale should use the 601 luma');
        assert(rgba(px(0xffffff80).sepia(), 0, 0).join() === '255,255,239,128', 'sepia, got ' + rgba(px(0xffffff80).sepia(), 0, 0));

        let threw = 0;
        for (const op of [i => i.brightness(-1), i => i.contrast(NaN), i => i.gamma(0), i => i.blur(-1), i => i.sharpen(1, 0)])
            try { op(px(0)); } catch { threw++; }
        assert(threw === 5, 'invalid adjustment arguments should throw');
    }

    // composite with opacity and blend modes
    {
        const base = new Image(2, 1).fill((x) => x ? 0x808080ff : 0x00000000);
        const top = new Image(2, 1).fill(0x4080c0ff);
        assert(Buffer.from(base.clone().composite(top, 0, 0, {opacity: 0}).bitmap).equals(Buffer.from(base.bitmap)), 'opacity 0 should change nothing');
        assert(rgba(base.clone().composite(top, 0, 0, {opacity: 0.5}), 1, 0).join() === '96,128,160,255', 'opacity 0.5');
        assert(rgba(base.clone().composite(top, 0, 0, {mode: 'multiply'}), 1, 0).join() === '32,64,96,255', 'multiply');
        assert(rgba(base.clone().composite(top, 0, 0, {mode: 'screen'}), 1, 0).join() === '160,192,224,255', 'screen');
        // over a transparent backdrop blend modes draw the plain source
        assert(rgba(base.clone().composite(top, 0, 0, {mode: 'multiply'}), 0, 0).join() === '64,128,192,255', 'blend over transparency');
        assert(Buffer.from(base.clone().composite(top, 0, 0, {mode: 'normal', opacity: 1}).bitmap).equals(Buffer.from(base.clone().composite(top).bitmap)), 'normal mode');

        let threw = 0;
        for (const options of [{mode: 'foo'}, {mode: 'toString'}, {opacity: 2}, {opacity: NaN}])
            try { base.clone().composite(top, 0, 0, options); } catch { threw++; }
        assert(threw === 4, 'invalid composite options should throw');
    }

    // outlined text grows by the stroke width and puts the stroke color around the glyphs
    {
        const font = require('fs').readFileSync('./tests/fonts/opensans bold.ttf');
        const plain = await Image.renderText(font, 40, 'Hi');
        const outlined = await Image.renderText(font, 40, 'Hi', 0xffffffff, undefined, {strokeWidth: 3, strokeColor: 0xff0000ff});
        assert(outlined.width === plain.width + 6 && outlined.height === plain.height + 6, 'stroke should grow the image');
        let red = 0, white = 0;
        for (const [, , color] of outlined.iterateWithColors()) {
            if (color === 0xff0000ff) red++;
            if (color === 0xffffffff) white++;
        }
        assert(red > 100 && white > 100, `outlined text should contain both colors (${red} red, ${white} white)`);

        // the stroke goes around translucent text, it doesn't show through it
        const translucent = await Image.renderText(font, 40, 'Hi', 0x0000ff80, undefined, {strokeWidth: 3, strokeColor: 0xff0000ff});
        const fill = await Image.renderText(font, 40, 'Hi', 0x0000ff80);
        let inside = 0, tinted = 0;
        // pixels the glyphs cover fully (the stroked image is 3 pixels larger on every side)
        for (const [x, y, color] of fill.iterateWithColors()) {
            if (color !== 0x0000ff80) continue;
            inside++;
            if (translucent.getPixelAt(x + 3, y + 3) !== 0x0000ff80) tinted++;
        }
        assert(inside > 100 && !tinted, `translucent text should show no stroke inside (${tinted} of ${inside} pixels tinted)`);
    }

    // PNGs are oriented by their eXIf chunk, ImageMagick's Exif text or XMP, in that order
    {
        const chunk = (type, body) => {
            const out = Buffer.alloc(12 + body.length);
            out.writeUInt32BE(body.length);
            out.write(type, 4, 'latin1');
            body.copy(out, 8);
            out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
            return out;
        };
        const tiff = orientation => Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0]);
        const xmp = orientation => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/"><tiff:Orientation>${orientation}</tiff:Orientation></rdf:Description></rdf:RDF></x:xmpmeta>`;
        const chunks = {
            exif: o => chunk('eXIf', tiff(o)),
            raw: o => {
                const data = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(o)]);
                return chunk('tEXt', Buffer.from(`Raw profile type exif\0\nexif\n${String(data.length).padStart(8)}\n${data.toString('hex').replace(/.{1,72}/g, '$&\n')}`, 'latin1'));
            },
            xmp: o => chunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\x01\0\0\0', 'latin1'), zlib.deflateSync(xmp(o))])),
        };

        const source = new Image(3, 2).fill((x, y) => Image.rgbaToColor(x * 100, y * 100, 0, 255));
        const encoded = Buffer.from(await source.encode());
        const withChunks = (...extra) => Buffer.concat([encoded.subarray(0, encoded.length - 12), ...extra, encoded.subarray(encoded.length - 12)]);

        for (const [name, make] of Object.entries(chunks)) {
            const image = await Image.decode(withChunks(make(6)));
            assert(image.width === 2 && image.height === 3, `PNG ${name} orientation: not rotated`);
            assert(rgba(image, 1, 0).slice(0, 2).join() === '0,0', `PNG ${name} orientation: top left should end up top right`);
            const stored = await Image.decode(withChunks(make(6)), {applyOrientation: false});
            assert(stored.width === 3, `PNG ${name} orientation: applyOrientation false should keep the stored pixels`);
        }
        const both = await Image.decode(withChunks(chunks.xmp(6), chunks.exif(3)));
        assert(both.width === 3 && rgba(both, 2, 1).slice(0, 2).join() === '0,0', 'PNG orientation: eXIf should win over XMP');
    }

    // colorToAlpha removes the color, so compositing the result over that color gives the original back (#39)
    {
        const image = new Image(40, 40).fill(0xffffffff).drawCircle(20, 20, 12, 0xff0000ff);
        const cut = image.clone().colorToAlpha();
        assert(cut.getPixelAt(0, 0) === 0xffffff00, 'colorToAlpha: the background should become transparent');
        assert(cut.getPixelAt(20, 20) === 0xff0000ff, 'colorToAlpha: other colors should stay opaque');
        const back = new Image(40, 40).fill(0xffffffff).composite(cut);
        assert(Buffer.from(back.bitmap).equals(Buffer.from(image.bitmap)), 'colorToAlpha: compositing over the color should give the original');
        const edge = cut.getRGBAAt(32, 20);
        assert(edge[3] > 0 && edge[3] < 255 && edge[0] === 255 && edge[1] === 0, 'colorToAlpha: antialiased edges should become translucent red');
        const loose = image.clone().colorToAlpha(0xffffffff, {transparencyThreshold: 0.5});
        assert(loose.getRGBAAt(32, 20)[3] < edge[3], 'colorToAlpha: the threshold should make more of the edge transparent');
    }

    // slice-by-16 crc32 matches zlib for every length around the 16 byte steps and for unaligned views (#12)
    {
        const {crc32} = await import('../dist/codecs/crc.js');
        const data = new Uint8Array(1100).map((_, i) => i * 7919 >> 3);
        for (const offset of [0, 1, 3])
            for (let length = 0; length < 70; length++) {
                const view = data.subarray(offset, offset + length);
                assert(crc32(view) === zlib.crc32(view), `crc32: wrong for ${length} bytes at offset ${offset}`);
            }
        assert(crc32(data) === zlib.crc32(data), 'crc32: wrong for a long buffer');
    }

    // damaged fonts (truncated, bytes changed) render or throw a font error, quickly: no runaway memory or time (contours
    // with decreasing end points, composite glyphs containing themselves, huge COLR clip boxes)
    {
        const fs = require('fs');
        let seed = 7;
        const random = () => (seed = Math.imul(seed, 1103515245) + 12345 >>> 0) / 2 ** 32;
        // (a damaged copy of the Noto-COLRv1 subset with 3329 contours of decreasing end points in a glyph ran out of memory)
        const start = Date.now();
        await Image.renderText(fs.readFileSync('./tests/fonts/damaged noto colrv1 subset.ttf'), 40, '😀🔥👍❤️').catch(err => assert(/^Font: /.test(err.message), err.message));
        assert(Date.now() - start < 3000, 'the damaged Noto-COLRv1 subset took too long');
        for (const file of ['sourcesans3 regular.otf', 'opensans bold.ttf', 'noto colrv1 subset.ttf', 'noto color emoji subset.ttf']) {
            const original = fs.readFileSync(`./tests/fonts/${file}`);
            for (let k = 0; k < 30; k++) {
                let data = original.subarray(0, Math.floor(random() * original.length));
                if (k >= 10) {
                    data = Buffer.from(original);
                    for (let n = 0; n < 1 + random() * 20; n++) data[Math.floor(random() * data.length)] = random() * 256;
                }
                const start = Date.now();
                try {
                    await Image.renderText(data, 40, 'Hi office 😀🔥 👍🏽 🇩🇪 1️⃣ e\u0301');
                } catch (err) {
                    assert(/^Font: /.test(err.message), `${file} #${k}: unexpected error for a damaged font: ${err.message}`);
                }
                assert(Date.now() - start < 3000, `${file} #${k}: a damaged font took ${Date.now() - start} ms`);
            }
        }
    }

    // decompression bombs: tiny files declaring huge images throw a RangeError before anything that size is allocated,
    // maxPixels sets the limit; damaged data throws an error saying so
    {
        const chunk = (type, body) => {
            const out = Buffer.alloc(12 + body.length);
            out.writeUInt32BE(body.length);
            out.write(type, 4, 'latin1');
            body.copy(out, 8);
            out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
            return out;
        };
        const png = (width, height) => {
            const header = Buffer.alloc(13);
            header.writeUInt32BE(width);
            header.writeUInt32BE(height, 4);
            header.set([8, 6, 0, 0, 0], 8);
            return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.alloc(64))), chunk('IEND', Buffer.alloc(0))]);
        };
        // a 4000x4000 screen with 50 frames of a pixel
        const frame = Buffer.from([0x21, 0xf9, 4, 0, 1, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0]);
        const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0xa0, 0x0f, 0xa0, 0x0f, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]), ...Array(50).fill(frame), Buffer.from([0x3b])]);
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0xff, 0xdc, 0xff, 0xdc, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
        // 278x374 with 57859 samples per pixel (a damaged TIFF that took 6 GB)
        const entries = [[256, 4, 1, 278], [257, 4, 1, 374], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, 8], [277, 3, 1, 57859], [278, 4, 1, 374], [279, 4, 1, 4]];
        const tiff = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
        tiff.write('II*\0', 0, 'latin1');
        tiff.writeUInt32LE(8, 4);
        tiff.writeUInt16LE(entries.length, 8);
        entries.forEach(([tag, type, count, value], k) => {
            const o = 10 + k * 12;
            tiff.writeUInt16LE(tag, o);
            tiff.writeUInt16LE(type, o + 2);
            tiff.writeUInt32LE(count, o + 4);
            if (type === 3) tiff.writeUInt16LE(value, o + 8);
            else tiff.writeUInt32LE(value, o + 8);
        });

        const tooLarge = async (name, decode) => {
            const start = Date.now();
            let error = null;
            try { await decode(); } catch (err) { error = err; }
            assert(error instanceof RangeError && /too large/.test(error.message), `${name}: should be too large (${error && error.message})`);
            assert(Date.now() - start < 1000, `${name}: took ${Date.now() - start} ms`);
        };
        await tooLarge('png', () => Image.decode(png(30000, 30000)));
        await tooLarge('png animation', () => Animation.decode(png(30000, 30000)));
        await tooLarge('jpeg', () => Image.decode(jpeg));
        await tooLarge('tiff samples', () => Image.decode(tiff));
        await tooLarge('gif frames', () => Animation.decode(gif, {maxPixels: 4000 * 4000 * 10}));
        await tooLarge('gif frames through GIF.decode', () => GIF.decode(gif, {maxPixels: 4000 * 4000 * 10}));
        await tooLarge('maxPixels', () => Image.decode(png(100, 100), {maxPixels: 9999}));

        // without a limit, the PNG gets as far as its data (which is too short)
        let error = null;
        try { await Image.decode(png(30000, 30000), {maxPixels: Infinity}); } catch (err) { error = err; }
        assert(error && /truncated/.test(error.message), `maxPixels: Infinity should lift the limit (${error && error.message})`);
        // the first frame alone fits
        assert((await Animation.decode(gif, {maxPixels: 4000 * 4000 * 10, onlyFirstFrame: true})).length === 1, 'the first frame should fit the limit');

        // damaged data
        error = null;
        try { await Image.decode(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0xff, 0, 0, 0])); } catch (err) { error = err; }
        assert(error && !(error instanceof RangeError), `damaged data should throw an Error, not a RangeError (${error && error.message})`);
    }

    // blur with a huge radius takes about as long as with a small one, infinite ones throw
    {
        const image = new Image(200, 100).fill(x => x < 100 ? 0xff0000ff : 0x0000ffff);
        const start = Date.now();
        image.blur(1e9);
        assert(Date.now() - start < 1000, `blur(1e9) took ${Date.now() - start} ms`);
        let threw = false;
        try { image.blur(Infinity); } catch { threw = true; }
        assert(threw, 'blur(Infinity) should throw');
    }

    // SVGs against denial of service: <use> references multiplying each other ("billion laughs") throw quickly,
    // dash patterns too fine to dash stroke solid, deeply nested elements render
    {
        const NS = 'xmlns="http://www.w3.org/2000/svg"';
        let defs = '<g id="l0"><rect width="1" height="1"/></g>';
        for (let i = 1; i <= 9; i++) defs += `<g id="l${i}">${`<use href="#l${i - 1}"/>`.repeat(10)}</g>`;
        let start = Date.now(), error = null;
        try { await Image.renderSVG(`<svg ${NS} width="100" height="100"><defs>${defs}</defs><use href="#l9"/></svg>`, {size: 100, mode: Image.SVG_MODE_WIDTH}); } catch (err) { error = err; }
        assert(error && /<use> references/.test(error.message) && Date.now() - start < 3000, `billion laughs should throw quickly (${error && error.message}, ${Date.now() - start} ms)`);

        start = Date.now();
        const dashed = await Image.renderSVG(`<svg ${NS} width="100" height="100"><path d="M0 50 L100000000 50" stroke="black" stroke-width="4" stroke-dasharray="0.0001"/></svg>`, {size: 100, mode: Image.SVG_MODE_WIDTH});
        assert(Date.now() - start < 3000 && dashed.getRGBAAt(50, 50)[3] === 255, 'a dash pattern too fine to dash should stroke solid, quickly');

        const nested = await Image.renderSVG(`<svg ${NS} width="100" height="100">${'<g>'.repeat(100000)}<rect width="10" height="10"/>${'</g>'.repeat(100000)}</svg>`, {size: 100, mode: Image.SVG_MODE_WIDTH});
        assert(nested.width === 100, 'deeply nested elements should render');
    }
    {
        // NaN and the infinities throw instead of drawing black, transparent or nothing; numeric strings still work
        const {Frame, Animation, TextLayout} = require('..');
        const image = () => new Image(8, 8).fill(0xff0000ff);
        const calls = {
            rgbaToColor: v => Image.rgbaToColor(v, 0, 0, 255), hslaToColor: v => Image.hslaToColor(v, 0.5, 0.5, 1), colorToRGBA: v => Image.colorToRGBA(v),
            getPixelAt: v => image().getPixelAt(v, 1), setPixelAt: v => image().setPixelAt(1, 1, v), fill: v => image().fill(v), contain: v => image().contain(v, 4),
            crop: v => image().crop(v, 0, 2, 2), trim: v => image().trim(v), drawBox: v => image().drawBox(0, 0, v, 2, 0), drawCircle: v => image().drawCircle(2, 2, v, 0),
            cropCircle: v => image().cropCircle(false, v), opacity: v => image().opacity(v), red: v => image().red(v), lightness: v => image().lightness(v),
            composite: v => image().composite(image(), v, 0), hueShift: v => image().hueShift(v), brightness: v => image().brightness(v), gamma: v => image().gamma(v),
            colorToAlpha: v => image().colorToAlpha(v), rotate: v => image().rotate(v, false), gradient: v => Image.gradient({0: v, 1: 0}),
            roundCorners: v => image().roundCorners(v), fisheye: v => image().fisheye(v), encode: v => image().encode(v), encodeJPEG: v => image().encodeJPEG(v),
            frame: v => new Frame(4, 4, v), animation: v => new Animation([new Frame(4, 4)], v),
        };
        for (const [name, call] of Object.entries(calls))
            for (const value of [NaN, Infinity, -Infinity]) {
                let error = null;
                try {
                    await call(value);
                } catch (e) {
                    error = e;
                }
                if (!(error instanceof RangeError)) panic(`${name}(${value}) should throw a RangeError, got ${error}`);
            }
        const font = require('fs').readFileSync('./tests/fonts/opensans bold.ttf');
        for (const [name, call] of Object.entries({size: v => Image.renderText(font, v, 'a'), color: v => Image.renderText(font, 12, 'a', v),
            maxWidth: v => new TextLayout({maxWidth: v})}))
            if (!await Promise.resolve().then(() => call(NaN)).then(() => false, e => e instanceof RangeError)) panic(`renderText: a NaN ${name} should throw a RangeError`);
        // (no limit is a valid layout)
        new TextLayout({maxWidth: Infinity, maxHeight: Infinity});

        const strings = image().crop('1', '1', '4', '4').rotate('45').opacity('0.5').composite(image(), '1', '2');
        if (strings.width !== 6) panic('numeric strings should keep working');
    }
})();
