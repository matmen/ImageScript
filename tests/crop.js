const fs = require('fs').promises;
const {Image, Frame} = require('..');
const samePixels = require('./util/pixels');

(async () => {
    const image = new Image(512, 512);
    image.fill((x, y) => Image.hslToColor((x + y) / (image.width + image.height), 1, .5));
    image.crop(128, 128, 128, 128);

    const encoded = await image.encode(1, {creationTime: 0, software: ''});

    if (process.env.OVERWRITE_TEST)
        await fs.writeFile('./tests/targets/crop.png', encoded);

    const target = await fs.readFile('./tests/targets/crop.png');
    if (!await samePixels(target, encoded)) process.exit(1);

    // region: the same pixels as a new image, the source unchanged; clipped like crop
    const panic = message => {
        console.error(message);
        process.exit(1);
    };
    const source = new Image(512, 512).fill((x, y) => Image.hslToColor((x + y) / 1024, 1, .5));
    const before = Buffer.from(source.bitmap);
    const region = source.region(128, 128, 128, 128);
    if (!await samePixels(target, await region.encode(1, {creationTime: 0, software: ''}))) panic('region: wrong pixels');
    if (!Buffer.from(source.bitmap).equals(before)) panic('region: changed the source');
    region.fill(0);
    if (!Buffer.from(source.bitmap).equals(before)) panic('region: shares memory with the source');

    const clipped = source.region(-10, 500, 30, 30);
    if (clipped.width !== 20 || clipped.height !== 12) panic(`region: clipped to ${clipped.width}x${clipped.height} instead of 20x12`);
    if (clipped.getPixelAt(1, 1) !== source.getPixelAt(1, 501)) panic('region: clipped region has wrong pixels');
    let threw = false;
    try { source.region(600, 0, 10, 10); } catch (err) { threw = err instanceof RangeError; }
    if (!threw) panic('region: a region outside the image should throw a RangeError');

    // a frame's region is a plain image, the frame stays as it is
    const frame = Frame.from(source, {duration: 100, xOffset: 4, yOffset: 6});
    const part = frame.region(0, 0, 10, 10);
    if (part instanceof Frame || part.width !== 10 || frame.width !== 512 || frame.xOffset !== 4) panic('region: frames');
})();
