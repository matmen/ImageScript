const fs = require('fs').promises;
const {Image} = require('../ImageScript');

(async () => {
    const image = new Image(512, 512);
    image.fill((x, y) => Image.hslToColor((x + y) / (image.width + image.height), 1, .5));
    image.crop(128, 128, 128, 128);

    const encoded = await image.encode();

    const target = await fs.readFile('./tests/crop.png');
    if (!Buffer.from(target).equals(Buffer.from(encoded))) process.exit(1);
})();