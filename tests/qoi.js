const fs = require('fs').promises;
const {Image, ImageType} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

// rgb.qoi and rgba.qoi are written like the reference encoder (scripts/format-fixtures.py): decoding them gives the
// PNGs' pixels, encoding those gives the same bytes
(async () => {
    for (const name of ['rgb', 'rgba']) {
        const qoi = await fs.readFile(`./tests/qoi/${name}.qoi`);
        if (ImageType.getType(qoi) !== 'qoi') panic(`${name}: not detected as QOI`);
        const image = await Image.decode(qoi);
        const png = await Image.decode(await fs.readFile(`./tests/qoi/${name}.png`));
        if (!Buffer.from(image.bitmap).equals(Buffer.from(png.bitmap))) panic(`${name}: decoded pixels don't match`);
        if (!Buffer.from(await png.encodeQOI()).equals(qoi)) panic(`${name}: encoded differently than the reference encoder`);
    }

    // every operation: runs of 62 and longer, the index, small and larger differences, alpha changes
    const image = new Image(97, 3).fill((x, y) => y === 0 ? 0x336699ff
        : y === 1 ? [0x336699ff, 0x346799ff, 0x50779aff, 0x336699ff, 0x33669980, 0xffffff00][x % 6]
            : Image.rgbaToColor(x * 37 & 255, x * 11 & 255, 255 - x, x & 1 ? 255 : 200));
    const back = await Image.decode(await image.encodeQOI());
    if (!Buffer.from(back.bitmap).equals(Buffer.from(image.bitmap))) panic('QOI didn\'t round trip');
    const opaque = await new Image(4, 4).fill(0xff0000ff).encodeQOI();
    if (opaque[12] !== 3) panic('opaque images should be stored with 3 channels');

    try {
        await Image.decode((await image.encodeQOI()).subarray(0, 40));
        panic('truncated QOI accepted');
    } catch (err) {
        if (!/QOI/.test(err.message)) panic(`QOI: unexpected error ${err.message}`);
    }
})();
