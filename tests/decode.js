const fs = require('fs').promises;
const {Image} = require('../ImageScript');

(async () => {
    const binary = await fs.readFile('./tests/image.png');
    const image = await Image.decode(binary);

    console.log(image);
})();