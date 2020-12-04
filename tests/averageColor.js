const fs = require('fs').promises;
const {Image} = require('../ImageScript');
(async () => {
    const binary = await fs.readFile('./tests/targets/readme.png');
    const image = await Image.decode(binary);
    const avgColor = image.averageColor();
    if (avgColor !== 0x343c3dff) process.exit(1);
})();