const {Image} = require('..');
const fs = require('fs').promises;
const samePixels = require('./util/pixels');

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
        if (!await samePixels(target, encoded)) panic('potato doesn\'t match');
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
        if (!await samePixels(target, encoded)) panic('features don\'t match');
    }

    // resvg's test cases (but the filters, see svg-filters.js): XML entities, style sheets, switch, nested svg and
    // aspect ratios, gradients, patterns, clip paths, masks, markers, images, colors, lines, arcs, caps, symbols
    await require('./util/resvg')(file => !file.startsWith('filters/'), panic);

    {
        // images embedded as data URIs: placed at their size, the pixels are the decoded image's
        const {Animation, Frame} = require('..');
        const pixel = (x, y, alpha) => Image.rgbaToColor(x * 10, y * 15, 128, alpha && x > 20 ? 0 : 255);
        const source = new Image(24, 16), opaque = new Image(24, 16);
        for (let y = 0; y < 16; y++)
            for (let x = 0; x < 24; x++) {
                source.setPixelAt(x, y, pixel(x, y, true));
                opaque.setPixelAt(x, y, pixel(x, y, false));
            }
        const rect = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="12" height="16" fill="#0f0"/></svg>';
        const gif = await new Animation([Frame.from(opaque)]).encodeGIF();
        const jpeg = await opaque.encodeJPEG(90);
        const cases = [
            ['image/png', await source.encode(1), source],
            ['image/webp', await source.encodeWebP(), source],
            ['image/gif', gif, (await Animation.decode(gif))[0]],
            ['image/jpeg', jpeg, await Image.decode(jpeg)],
            ['image/svg+xml', require('zlib').gzipSync(rect), await Image.renderSVG(rect)]
        ];
        for (const [type, data, expected] of cases) {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><image href="data:${type};base64,${Buffer.from(data).toString('base64')}"/></svg>`;
            const image = await Image.renderSVG(svg);
            for (let i = 0; i < image.bitmap.length; i += 4) {
                const a = image.bitmap[i + 3], b = expected.bitmap[i + 3];
                if (a !== b || (a && [0, 1, 2].some(c => image.bitmap[i + c] !== expected.bitmap[i + c]))) panic(`embedded ${type}: pixel ${i / 4} differs`);
            }
        }
    }

    {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1cm"/>';
        const image = await Image.renderSVG(svg);
        if (image.width !== 192 || image.height !== 38) panic('units: unexpected size');
    }
})();
