const fs = require('fs').promises;
const {Image} = require('../ImageScript');
const ImageTest = require('./image');

(async () => {
    const binary = await fs.readFile('./tests/image.png');
    const image = await Image.decode(binary);

    const target = await ImageTest;
    process.exit(target.__array__.equals(image.__array__) ? 0 : 1);
})();