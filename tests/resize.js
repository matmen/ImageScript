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

        // the fast resampling (the default) stays within a step of the precise one for opaque images, transparent ones
        // within 2.5 steps where it shows (premultiplied, alpha within 2), bicubic resizing is left to the precise one
        const opaque = (await Image.decode(await fs.readFile('./bench/inputs/photo.jpg'))).crop(700, 300, 400, 300);
        const transparent = opaque.clone();
        for (let i = 0; i < transparent.bitmap.length; i += 4) transparent.bitmap[i + 3] = (i >> 2) % transparent.width * 255 / (transparent.width - 1);
        const sizes = [[0.5, 0.5], [1 / 3, 0.4], [2, 1.5], [1, 0.7]];
        for (const source of [opaque, transparent])
                for (const mode of [Image.RESIZE_BILINEAR, Image.RESIZE_AREA, Image.RESIZE_BICUBIC])
                        for (const [sx, sy] of sizes) {
                                const width = Math.round(source.width * sx), height = Math.round(source.height * sy);
                                const a = source.clone().resize(width, height, {mode, fast: false}).bitmap, b = source.clone().resize(width, height, {mode}).bitmap;
                                const limit = mode === Image.RESIZE_BICUBIC ? 0 : source === opaque ? 1 : 2.5;
                                let max = 0, differ = false;
                                for (let i = 0; i < a.length; i++) {
                                        if (a[i] === b[i]) continue;
                                        differ = true;
                                        const alpha = (i & 3) === 3, al = a[i | 3], bl = b[i | 3];
                                        max = Math.max(max, source === opaque || alpha ? Math.abs(a[i] - b[i]) : Math.abs(a[i] * al - b[i] * bl) / 255);
                                }
                                if (max > limit || mode !== Image.RESIZE_BICUBIC && sx === 0.5 && !differ) {
                                        console.error('fast resize', mode, sx, sy, source === opaque ? 'opaque' : 'transparent', max);
                                        process.exit(1);
                                }
                        }
})();
