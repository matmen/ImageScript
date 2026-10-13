const fs = require('fs').promises;
const {Image} = require('..');
const samePixels = require('./util/pixels');
(async () => {
        const binary = await fs.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.resize(image.width / 4, Image.RESIZE_AUTO);

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
                await fs.writeFile('./tests/targets/resize.png', encoded);

        const target = await fs.readFile('./tests/targets/resize.png');
        if (!await samePixels(target, encoded)) process.exit(1);
})();
