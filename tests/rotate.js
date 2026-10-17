const fs = require('fs').promises;
const {Image} = require('..');
const samePixels = require('./util/pixels');
const panic = msg => {
    console.error(msg);
    process.exit(1);
};

(async () => {
    {
        const binary = await fs.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(45);

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/rotate-45.png', encoded);
        const target = await fs.readFile('./tests/targets/rotate-45.png');
        if (!await samePixels(target, encoded)) panic('rotate 45 failed');
    }

    {
        const binary = await fs.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(45, false);

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/rotate-45-noresize.png', encoded);

        const target = await fs.readFile('./tests/targets/rotate-45-noresize.png');
        if (!await samePixels(target, encoded)) panic('rotate 45 noresize failed');
    }

    {
        const binary = await fs.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(90);

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/rotate-90.png', encoded);
        const target = await fs.readFile('./tests/targets/rotate-90.png');
        if (!await samePixels(target, encoded)) panic('rotate 90 failed');
    }

    {
        const binary = await fs.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(180);

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/rotate-180.png', encoded);
        const target = await fs.readFile('./tests/targets/rotate-180.png');
        if (!await samePixels(target, encoded)) panic('rotate 180 failed');
    }

    {
        const binary = await fs.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(270);

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/rotate-270.png', encoded);
        const target = await fs.readFile('./tests/targets/rotate-270.png');
        if (!await samePixels(target, encoded)) panic('rotate 270 failed');
    }

    {
        const image = new Image(512, 512);
        image.fill((x) => Image.hslToColor(x / image.width, 1, .5));
        if (!Buffer.from(image.bitmap).equals(Buffer.from(image.rotate(360).bitmap)))
            panic('rotate 360 failed');
    }

    // the fast sampling (the default) stays within a step of the precise one for opaque pixels, transparent ones
    // within 2.5 steps where it shows (premultiplied, alpha within 2)
    {
        const photo = (await Image.decode(await fs.readFile('./bench/inputs/photo.jpg'))).crop(700, 300, 400, 300);
        const transparent = photo.clone();
        for (let i = 0; i < transparent.bitmap.length; i += 4) transparent.bitmap[i + 3] = (i >> 2) % transparent.width * 255 / (transparent.width - 1);
        for (const source of [photo, transparent])
            for (const [angle, resize] of [[30, true], [-17.5, true], [123, false], [0.3, true]]) {
                const a = source.clone().rotate(angle, {resize, fast: false}).bitmap, b = source.clone().rotate(angle, {resize}).bitmap;
                let opaque = 0, shown = 0;
                for (let i = 0; i < a.length; i++) {
                    if (a[i] === b[i]) continue;
                    const al = a[i | 3], bl = b[i | 3];
                    if ((i & 3) === 3) shown = Math.max(shown, Math.abs(a[i] - b[i]));
                    else if (al === 255 && bl === 255) opaque = Math.max(opaque, Math.abs(a[i] - b[i]));
                    else shown = Math.max(shown, Math.abs(a[i] * al - b[i] * bl) / 255);
                }
                if (opaque > 1 || shown > 2.5) panic(`fast rotate ${angle}: ${opaque} (opaque), ${shown} (shown)`);
            }
    }
})();
