const fs = require('fs').promises;
const {Image} = require('..');
const samePixels = require('./util/pixels');
(async () => {
        const binary = await fs.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.resize(image.width / 4, Image.RESIZE_AUTO);

        const encoded = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
                await fs.writeFile('./tests/targets/resize.png', encoded);

        const target = await fs.readFile('./tests/targets/resize.png');
        if (!await samePixels(target, encoded)) process.exit(1);

        // the fast resampling (the default) stays within a step of the exact one, and leaves transparent images to it
        const opaque = (await Image.decode(await fs.readFile('./bench/inputs/photo.jpg'))).crop(700, 300, 400, 300);
        // one translucent pixel in the middle, found by the vertical pass
        const photo = opaque.clone();
        photo.bitmap[(photo.height >> 1) * photo.width * 4 + 403] = 128;
        const sizes = [[0.5, 0.5], [1 / 3, 0.4], [2, 1.5], [1, 0.7]];
        for (const source of [opaque, photo])
                for (const mode of [Image.RESIZE_BILINEAR, Image.RESIZE_AREA, Image.RESIZE_BICUBIC])
                        for (const [sx, sy] of sizes) {
                                const width = Math.round(source.width * sx), height = Math.round(source.height * sy);
                                const exact = source.clone().resize(width, height, {mode, fast: false}), fast = source.clone().resize(width, height, {mode});
                                const limit = source === opaque ? 1 : 0;
                                if (exact.bitmap.some((value, i) => Math.abs(value - fast.bitmap[i]) > limit)
                                        || source === opaque && mode !== Image.RESIZE_BICUBIC && sx === 0.5 && exact.bitmap.every((value, i) => value === fast.bitmap[i])) {
                                        console.error('fast resize', mode, sx, sy, source === opaque ? 'opaque' : 'transparent');
                                        process.exit(1);
                                }
                        }
})();
