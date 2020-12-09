const {Image, Frame, GIF} = require('../ImageScript');
const panic = msg => {
    console.error(msg);
    process.exit(1);
}

try {
    new Image(0, 1);
    panic('width 0 failed');
} catch {
}

try {
    new Image(1, 0);
    panic('height 0 failed');
} catch {
}

if (new Image(1, 1).toString() !== 'Image<1x1>')
    panic('toString failed');

for (const [x, y] of new Image(1, 1))
    if (x !== 1 || y !== 1) panic('Symbol.iterator failed');

for (const [x, y, color] of new Image(1, 1).fill(0xff8000ff).iterateWithColors())
    if (x !== 1 || y !== 1 || color !== 0xff8000ff) panic('iterateWithColors failed');

if (Image.rgbToColor(0xff, 0x80, 0x00) !== 0xff8000ff)
    panic('rgbToColor failed');

if (Image.hslaToColor(0, 0, 1, 0xff) !== 0xffffffff)
    panic('hslaToColor for s=0 failed');

{
    for (const rgba of [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0x000000ff, 0xffffffff].map(x => Image.colorToRGBA(x))) {
        const hsla = Image.rgbaToHSLA(...rgba);
        const rgbaBacktransform = Image.colorToRGBA(Image.hslaToColor(...hsla));
        for (let i = 0; i < 4; i++)
            if (rgba[i] !== rgbaBacktransform[i])
                panic('rgbaToHSLA failed');
    }
}

{
    const rgb = Image.colorToRGB(0xff8000ff);
    const target = [0xff, 0x80, 0x00];
    for (let i = 0; i < 3; i++)
        if (rgb[i] !== target[i])
            panic('colorToRGB failed');
}

{
    const image = new Image(1, 1);
    image.setPixelAt(1, 1, 0xff8000ff);

    const pixel = image.getPixelAt(1, 1);
    if (pixel !== 0xff8000ff) panic('getPixelAt fails');

    const rgba = image.getRGBAAt(1, 1);
    const target = [0xff, 0x80, 0x00, 0xff];
    for (let i = 0; i < 4; i++)
        if (rgba[i] !== target[i])
            panic('colorToRGB failed');
}

{
    const image = new Image(1, 1);
    try {
        image.__check_boundaries__('a', 1);
        panic('check boundaries for x as NaN failed');
    } catch {
    }
    try {
        image.__check_boundaries__(1, 'a');
        panic('check boundaries for y as NaN failed');
    } catch {
    }
    try {
        image.__check_boundaries__(0, 1);
        panic('check boundaries for x as 0 failed');
    } catch {
    }
    try {
        image.__check_boundaries__(1, 0);
        panic('check boundaries for y as 0 failed');
    } catch {
    }
    try {
        image.__check_boundaries__(2, 1);
        panic('check boundaries for x as 2 failed');
    } catch {
    }
    try {
        image.__check_boundaries__(1, 2);
        panic('check boundaries for y as 2 failed');
    } catch {
    }
}

{
    const image = new Image(1, 1);
    image.fill(0xff8000ff);

    const clone = image.clone();

    if (!Buffer.from(clone.bitmap).equals(Buffer.from(image.bitmap)))
        panic('clone failed');
}

{
    const image = new Image(2, 2);
    image.scale(.5);
    if (image.width !== 1 || image.height !== 1)
        panic('resize failed');

    image.scale(1);
    if (image.width !== 1 || image.height !== 1)
        panic('resize failed');

    try {
        image.resize(0, 1);
        panic('resize for x = 0 failed');
    } catch {
    }
    try {
        image.resize(1, 0);
        panic('resize for y = 0 failed');
    } catch {
    }
    try {
        image.resize(1, 1, 'garbage');
        panic('resize with invalid mode failed');
    } catch {
    }
    try {
        image.resize(Image.RESIZE_AUTO, Image.RESIZE_AUTO);
        panic('resize with RESIZE_AUTO for both x and y failed');
    } catch {
    }
}

{
    const image = new Image(1, 1);
    image.drawBox(1, 1, 1, 1, 0xff8000ff);
    if (image.getPixelAt(1, 1) !== 0xff8000ff)
        panic('static drawBox failed');

    image.drawBox(1, 1, 1, 1, () => 0x00ff00ff);
    if (image.getPixelAt(1, 1) !== 0x00ff00ff)
        panic('fn drawBox failed');
}

{
    const image = new Image(1, 1);
    const toFail = ['a', -1];
    const funcs = [image.red, image.green, image.blue, image.opacity, image.lightness, image.saturation];
    for (const func of funcs)
        for (const value of toFail)
            try {
                func.call(image, toFail);
                panic(`${func.name} failed with value ${JSON.stringify(value)}`);
            } catch {
            }

    const toPass = [[1, true], [1, false], [0, true], [0, false]];
    for (const func of funcs)
        for (const value of toPass)
            func.call(image, ...value);
}

{
    const image = new Image(512, 256);
    const overlay = new Image(1024, 512);
    image.composite(overlay, -512, -256);
    overlay.fill(0x80);
    image.composite(overlay, -512, -256);
    overlay.fill(0xff);
    image.composite(overlay, -512, -256);
}

try {
    new Frame(1, 1, -1);
    panic('frame duration failed');
} catch {
}

if (new Frame(1, 2, 3).toString() !== 'Frame<1x2x3ms>') panic('frame toString failed');

{
    const image = new Image(512, 512);
    Frame.from(image, 10);
    try {
        Frame.from({}, 10);
        panic('frame instanceof image failed');
    } catch {
    }
}

try {
    new GIF([{}]);
    panic('gif frame instanceof failed');
} catch {
}

{
    const frame = new Frame(512, 128, 123);
    const gif = new GIF([frame]);
    if (gif.toString() !== 'GIF<512x128x123ms>') panic('gif tostring failed');
    if (gif.duration !== 123) panic('gif duration failed');
}