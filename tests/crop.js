const fs = require('fs').promises;
const {Image} = require('..');
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
})();
