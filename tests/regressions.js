const {Image, Frame, GIF, TextLayout} = require('..');
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
        assert(clone instanceof Frame && clone.duration === 500 && clone.xOffset === 2 && clone.disposalMode === 3, 'Frame.clone lost metadata');

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
})();
