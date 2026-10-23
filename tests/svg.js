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

    {
        // test cases of resvg (tests/svgs/resvg, see its LICENSE) next to resvg's renderings: XML entities, style
        // sheets, switch, nested svg and aspect ratios, gradients, clip paths, masks, colors, lines, arcs, caps, symbols.
        // Antialiasing differs a little: at most 0.5% of the pixels may differ by more than 24 (premultiplied)
        const root = './tests/svgs/resvg';
        const files = fs.readdir(root, {recursive: true}).then(list => list.filter(f => f.endsWith('.svg')));
        for (const file of await files) {
            const reference = await Image.decode(await fs.readFile(`${root}/${file.replace(/\.svg$/, '.png')}`));
            const image = await Image.renderSVG(await fs.readFile(`${root}/${file}`, 'utf8'), reference.width, Image.SVG_MODE_WIDTH);
            if (image.width !== reference.width || image.height !== reference.height) panic(`resvg ${file}: ${image.width}x${image.height} instead of ${reference.width}x${reference.height}`);
            const a = image.bitmap, b = reference.bitmap;
            let differing = 0;
            for (let i = 0; i < a.length; i += 4)
                for (let c = 0; c < 4; c++) {
                    const x = c < 3 ? a[i + c] * a[i + 3] / 255 : a[i + 3], y = c < 3 ? b[i + c] * b[i + 3] / 255 : b[i + 3];
                    if (Math.abs(x - y) > 24) {
                        differing++;
                        break;
                    }
                }
            if (differing > a.length / 4 * 0.005) panic(`resvg ${file}: ${differing} pixels differ from resvg's rendering`);
        }
    }

    {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1cm"/>';
        const image = await Image.renderSVG(svg);
        if (image.width !== 192 || image.height !== 38) panic('units: unexpected size');
    }
})();
