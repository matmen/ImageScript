const fs = require('fs').promises;
const {Image, Frame, Animation, GIF, decode} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const same = (name, a, b) => {
    const x = a.bitmap ?? a, y = b.bitmap ?? b;
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) panic(`${name}: options object and positional arguments differ`);
};

// every method with optional arguments takes them as an options object too, with the same result
(async () => {
    const photo = await Image.decode(await fs.readFile('./tests/targets/external.jpg'));
    const tile = () => photo.clone().resize(64, 48);
    const logo = new Image(16, 16).fill(0xff000080);

    same('scale', tile().scale(0.5, Image.RESIZE_NEAREST_NEIGHBOR), tile().scale(0.5, {mode: Image.RESIZE_NEAREST_NEIGHBOR}));
    for (const method of ['resize', 'contain', 'fit', 'cover'])
        same(method, tile()[method](30, 40, Image.RESIZE_BICUBIC), tile()[method](30, 40, {mode: Image.RESIZE_BICUBIC}));
    // the default mode
    same('resize default', tile().resize(30, 40), tile().resize(30, 40, {}));

    for (const method of ['opacity', 'red', 'green', 'blue', 'lightness', 'saturation']) {
        same(method, tile()[method](0.5, true), tile()[method](0.5, {absolute: true}));
        same(`${method} default`, tile()[method](0.5), tile()[method](0.5, {}));
    }

    same('composite', tile().composite(logo, 5, 7, {opacity: 0.5, mode: 'multiply'}), tile().composite(logo, {x: 5, y: 7, opacity: 0.5, mode: 'multiply'}));
    same('composite default', tile().composite(logo), tile().composite(logo, {}));
    same('sharpen', tile().sharpen(2, 3), tile().sharpen({amount: 2, radius: 3}));
    same('roundCorners', tile().roundCorners(9), tile().roundCorners({radius: 9}));
    same('roundCorners default', tile().roundCorners(), tile().roundCorners({}));
    same('fisheye', tile().fisheye(3), tile().fisheye({strength: 3}));
    same('fisheye default', tile().fisheye(), tile().fisheye({}));

    // encoders: decoded, since the metadata has a creation time
    const pixelsOf = async data => (await Image.decode(data)).bitmap;
    same('encode', await pixelsOf(await tile().encode(9)), await pixelsOf(await tile().encode({compression: 9})));
    same('encodeJPEG', await pixelsOf(await tile().encodeJPEG(40)), await pixelsOf(await tile().encodeJPEG({quality: 40})));
    // metadata as the first argument (3.x), and in the options
    const author = 'options test';
    for (const data of [await tile().encode({author}), await tile().encode({metadata: {author}}), await tile().encode(1, {author})])
        if (!Buffer.from(data).includes(author)) panic('encode: metadata missing');
    if (!Buffer.from(await tile().encodeJPEG({metadata: {author}})).includes(author)) panic('encodeJPEG: metadata missing');
    for (const method of ['encodeWebP', 'encodeTGA'])
        if (!Buffer.from(await tile()[method]({metadata: {author}})).includes(author)) panic(`${method}: metadata missing`);

    const svg = await fs.readFile('./tests/svgs/crown.svg');
    same('renderSVG', await Image.renderSVG(svg, 40, Image.SVG_MODE_WIDTH), await Image.renderSVG(svg, {size: 40, mode: Image.SVG_MODE_WIDTH}));

    const font = await fs.readFile('./tests/fonts/opensans bold.ttf');
    same('renderText', await Image.renderText(font, 24, 'Options', 0x3366ffff, undefined, {strokeWidth: 2, strokeColor: 0xffffffff}),
        await Image.renderText(font, 24, 'Options', {color: 0x3366ffff, strokeWidth: 2, strokeColor: 0xffffffff}));

    // frames and animations
    const a = new Frame(8, 6, 40, 2, 3, 'background'), b = new Frame(8, 6, {duration: 40, xOffset: 2, yOffset: 3, disposalMode: 'background'});
    const c = Frame.from(logo, {duration: 40, xOffset: 2, yOffset: 3, disposalMode: 'background'});
    for (const frame of [b, c])
        if (frame.duration !== 40 || frame.xOffset !== 2 || frame.yOffset !== 3 || frame.disposalMode !== 'background') panic('Frame: options not applied');
    if (new Frame(1, 1, {}).duration !== 100 || new Frame(1, 1, {}).disposalMode !== 'keep') panic('Frame: wrong defaults');
    same('Frame', a, b);

    const frames = () => [Frame.from(tile(), {duration: 50}), Frame.from(tile().invert(), {duration: 50})];
    if (new Animation(frames(), {loopCount: 2}).loopCount !== 2 || new GIF(frames(), {loopCount: 2}).loopCount !== 2) panic('Animation: loopCount not applied');
    const animation = new Animation(frames());
    const sameFrames = async (name, x, y) => {
        const fx = await Animation.decode(x), fy = await Animation.decode(y);
        if (fx.length !== fy.length) panic(`${name}: options object and positional arguments differ`);
        fx.forEach((f, i) => same(`${name} frame ${i}`, f, fy[i]));
    };
    await sameFrames('encodeGIF', await animation.encodeGIF(10), await animation.encodeGIF({quality: 10}));
    await sameFrames('encodeAPNG', await animation.encodeAPNG(9), await animation.encodeAPNG({compression: 9}));
    // (GIFs only store comments)
    for (const method of ['encodeGIF', 'encodeAPNG', 'encodeWebP'])
        if (!Buffer.from(await animation[method]({metadata: {author, comment: author}})).includes(author)) panic(`${method}: metadata missing`);

    same('Animation.resize', (await Animation.decode(await animation.encodeAPNG())).resize(20, 10, Image.RESIZE_NEAREST_NEIGHBOR)[1],
        (await Animation.decode(await animation.encodeAPNG())).resize(20, 10, {mode: Image.RESIZE_NEAREST_NEIGHBOR})[1]);

    const gif = await animation.encodeGIF();
    for (const decoded of [await Animation.decode(gif, {onlyFirstFrame: true}), await GIF.decode(gif, {onlyFirstFrame: true}), await decode(gif, {onlyFirstFrame: true})])
        if (decoded.length !== 1) panic('decode: onlyFirstFrame not applied');
    if ((await decode(gif, {})).length !== 2) panic('decode: wrong default');

    // decode() passes applyOrientation on to Image.decode()
    const rotated = await fs.readFile('./tests/targets/external.jpg');
    same('decode', await decode(rotated, {applyOrientation: false}), await Image.decode(rotated, {applyOrientation: false}));
})();
