const fs = require('fs').promises;
const {Image} = require('../ImageScript');

(async () => {
    const image = await Image.decode(await fs.readFile('./tests/external.png'));
    const overlay = await Image.decode(await fs.readFile('./tests/issues.png'));

    image.crop(228, 20, 152, 171);

    overlay.resize(image.width, Image.RESIZE_AUTO);
    overlay.opacity(0.8, true);
    image.composite(overlay, 0, image.height - overlay.height);

    const encoded = await image.encode();

    if (!(await fs.readFile('./tests/readme.png')).equals(Buffer.from(encoded)))
        process.exit(1);
})();