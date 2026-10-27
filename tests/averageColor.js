const fs = require('fs').promises;
const {Image} = require('..');
(async () => {
    const binary = await fs.readFile('./tests/targets/readme.png');
    const image = await Image.decode(binary);
    const avgColor = image.averageColor();
    if (avgColor !== 0x715876ff) process.exit(1);
})();