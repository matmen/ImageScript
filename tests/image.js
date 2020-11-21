const fs = require('fs').promises;
const {Image} = require('../ImageScript');

(async () => {
    const image = Image.new(128, 128);
    image.fill(x => Image.hslToColor(x / image.width, 1, 0.5));

    const encoded = await image.encode();
    const desired = await fs.readFile('./tests/image.png');
    process.exit(desired.equals(encoded) ? 0 : 1);
})();