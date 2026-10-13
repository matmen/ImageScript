const {Image, Frame, GIF, TextLayout} = require('..');

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
        assert([[0, 0], [7, 0], [0, 7], [7, 7]].every(([x, y]) => (corners.getPixelAt(x, y) & 0xff) === 0)
            && corners.getPixelAt(1, 0) === 0xffffffff && corners.getPixelAt(6, 7) === 0xffffffff, 'roundCorners should be symmetric');
    }

    // text layout accepts the pre 3.0 (swapped) option names
    {
        const legacy = new TextLayout({verticalAlign: 'center', horizontalAlign: 'bottom'});
        assert(legacy.horizontalAlign === 'center' && legacy.verticalAlign === 'bottom', 'TextLayout: legacy names');
        const current = new TextLayout({horizontalAlign: 'right', verticalAlign: 'middle'});
        assert(current.horizontalAlign === 'right' && current.verticalAlign === 'middle', 'TextLayout: names');
    }
})();
