const {Image} = require('../ImageScript');
const fs = require('fs').promises;

(async () => {
    const svg = await fs.readFile('./tests/twemoji.svg');
    const image = await Image.renderSVG(svg, 1024, 1024);
    const encoded = await image.encode();

    const target = await fs.readFile('./tests/targets/twemoji.png');
    if (!Buffer.from(target).equals(Buffer.from(encoded))) process.exit(1);
})();