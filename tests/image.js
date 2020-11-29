const fs = require('fs').promises;
const {Image} = require('../ImageScript');

module.exports = (async () => {
    const image = Image.new(128, 128);
    image.fill(x => Image.hslToColor(x / image.width, 1, 0.5));

    const encoded = await image.encode();
    const desired = await fs.readFile('./tests/targets/image.png');
    if (process.argv[1].slice(-8) === 'image.js') process.exit(desired.equals(encoded) ? 0 : 1);

    return image;
})();