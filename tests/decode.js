const fs = require('fs').promises;
const {Image} = require('../ImageScript');
const ImageTest = require('./image');

const panic = message => {
    console.error(message);
    process.exit(1);
};

(async () => {
    {
        const binary = await fs.readFile('./tests/image.png');
        const image = await Image.decode(binary);

        const target = await ImageTest;
        if (!Buffer.from(target.bitmap).equals(Buffer.from(image.bitmap))) process.exit(1);
    }

    {
        const binary = await fs.readFile('./tests/external.png');
        const image = await Image.decode(binary);

        if ([image.width, image.height].some(v => v !== 638))
            panic('dimensions don\'t match');

        if (!Buffer.from(image.bitmap.subarray(0, 4)).equals(Buffer.from([70, 65, 62, 255])))
            panic('pixel doesn\'t match');
    }
})();