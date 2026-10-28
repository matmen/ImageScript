const {Image} = require('../..');
const fs = require('fs').promises;

// test cases of resvg (tests/svgs/resvg, see its LICENSE) next to resvg's renderings, of the directories some returns
// true for. Antialiasing differs a little: at most 0.5% of the pixels may differ by more than 24 (premultiplied)
module.exports = async (some, panic) => {
    const root = './tests/svgs/resvg';
    const files = (await fs.readdir(root, {recursive: true})).filter(f => f.endsWith('.svg') && some(f.replace(/\\/g, '/')));
    for (const file of files) {
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
};
