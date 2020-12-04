const {Image} = require('../ImageScript');
const fs = require('fs').promises;

(async () => {
    const svg = await fs.readFile('./tests/svgs/potato.svg');
    const image = await Image.renderSVG(svg.toString(), 256 / 36, Image.SVG_MODE_SCALE);
    const encoded = await image.encode();

    const target = await fs.readFile('./tests/targets/potato.png');
    if (!Buffer.from(target).equals(Buffer.from(encoded))) process.exit(1);
})();