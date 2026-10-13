const fs = require('fs').promises;
const {Image} = require('..');
const samePixels = require('./util/pixels');

(async () => {
    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.invert();

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/invert.png', encoded);

        const target = await fs.readFile('./tests/targets/invert.png');
        if (!await samePixels(target, encoded)) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.invertLightness();

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/invert-lightness.png', encoded);

        const target = await fs.readFile('./tests/targets/invert-lightness.png');
        if (!await samePixels(target, encoded)) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill((x, y) => Image.rgbToColor(x / 2, y / 2, 255 - x / 2));
        image.invertValue();

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/invert-value.png', encoded);

        const target = await fs.readFile('./tests/targets/invert-value.png');
        if (!await samePixels(target, encoded)) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.hueShift(180);

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/invert-hueshift.png', encoded);

        const target = await fs.readFile('./tests/targets/invert-hueshift.png');
        if (!await samePixels(target, encoded)) process.exit(1);
    }
})();
