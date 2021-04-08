const fs = require('fs').promises;
const {Image} = require('../ImageScript');

(async () => {
    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.invert();

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/invert.png', encoded);

        const target = await fs.readFile('./tests/targets/invert.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.invertValue();

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/invert-value.png', encoded);

        const target = await fs.readFile('./tests/targets/invert-value.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.invertSaturation();

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/invert-saturation.png', encoded);

        const target = await fs.readFile('./tests/targets/invert-saturation.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.invertHue();

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/invert-hue.png', encoded);

        const target = await fs.readFile('./tests/targets/invert-hue.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.hueShift(180);

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/invert-hueshift.png', encoded);

        const target = await fs.readFile('./tests/targets/invert-hueshift.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) process.exit(1);
    }
})();
