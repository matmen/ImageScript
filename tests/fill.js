const fs = require('fs').promises;
const {Image} = require('../ImageScript');

const panic = message => {
    console.error(message);
    process.exit(1);
};

(async () => {
    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);

        const encoded = await image.encode();

        const target = await fs.readFile('./tests/targets/fill-static.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) panic('fill static doesn\'t equal');
    }

    {
        const image = new Image(512, 512);
        image.fill((x, y) => Image.hslToColor((x + y) / (image.width + image.height), 1, .5));

        const encoded = await image.encode();

        const target = await fs.readFile('./tests/targets/fill-func.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) panic('fill func doesn\'t equal');
    }
})();