const fs = require('fs').promises;
const {Image} = require('../ImageScript');
const panic = msg => {
    console.error(msg);
    process.exit(1);
}

(async () => {
    {
        const binary = await fs.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(45);

        const encoded = await image.encode();

        await fs.writeFile('./tests/targets/rotate-45.png', encoded);
        const target = await fs.readFile('./tests/targets/rotate-45.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) panic('rotate 45 failed');
    }

    {
        const binary = await fs.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(45, false);

        const encoded = await image.encode();

        await fs.writeFile('./tests/targets/rotate-45-noresize.png', encoded);
        const target = await fs.readFile('./tests/targets/rotate-45-noresize.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) panic('rotate 45 noresize failed');
    }

    {
        const binary = await fs.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(180);

        const encoded = await image.encode();

        await fs.writeFile('./tests/targets/rotate-180.png', encoded);
        const target = await fs.readFile('./tests/targets/rotate-180.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) panic('rotate 180 failed');
    }

    {
        const image = new Image(512, 512);
        image.fill((x) => Image.hslToColor(x / image.width, 1, .5));
        if (!Buffer.from(image.bitmap).equals(Buffer.from(image.rotate(360).bitmap)))
            panic('rotate 360 failed');
    }
})();