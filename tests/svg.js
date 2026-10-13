const {Image} = require('../ImageScript');
const fs = require('fs').promises;

const panic = message => {
    console.error(message);
    process.exit(1);
};

(async () => {
    {
        const svg = await fs.readFile('./tests/svgs/potato.svg');
        const image = await Image.renderSVG(svg.toString(), 256 / 36, Image.SVG_MODE_SCALE);
        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/potato.png', encoded);

        const target = await fs.readFile('./tests/targets/potato.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) panic('potato doesn\'t match');
    }

    {
        // gradients, clip paths, masks, style sheets, symbols, strokes and fill rules
        const svg = await fs.readFile('./tests/svgs/features.svg');
        const image = await Image.renderSVG(svg, 480, Image.SVG_MODE_WIDTH);
        if (image.width !== 480 || image.height !== 320) panic('features: unexpected size');

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/svg-features.png', encoded);

        const target = await fs.readFile('./tests/targets/svg-features.png');
        if (!Buffer.from(target).equals(Buffer.from(encoded))) panic('features don\'t match');
    }

    {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1cm"/>';
        const image = await Image.renderSVG(svg);
        if (image.width !== 192 || image.height !== 38) panic('units: unexpected size');
    }
})();
