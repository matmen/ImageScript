const fs = require('fs').promises;
const {Image} = require('../ImageScript');
const ImageTest = require('./image');

(async () => {
    {
        const binary = await fs.readFile('./tests/image.png');
        const image = await Image.decode(binary);

        const target = await ImageTest;
        if (!Buffer.from(target.__array__).equals(Buffer.from(image.__array__))) process.exit(1);
    }

    {
        const binary = await fs.readFile('./tests/external.png');
        const image = await Image.decode(binary);
        if ([image.width, image.height].some(v => v !== 638)) process.exit(1);
    }
})();