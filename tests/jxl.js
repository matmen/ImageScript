const fs = require('fs').promises;
const {Image, ImageType, Animation} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

// the largest difference of RGBA (premultiplied like djxl writes it, if asked) to a reference's samples: every step-th
// of a frame
const difference = (bitmap, width, height, reference, step = 1, premultiplied = false) => {
    let max = 0;
    const rw = reference.width;
    for (let y = 0; y * step < height; y++) {
        for (let x = 0; x * step < width; x++) {
            const i = 4 * (y * step * width + x * step), j = 4 * (y * rw + x);
            const alpha = bitmap[i + 3];
            for (let c = 0; c < 4; c++) {
                const v = premultiplied && c < 3 ? Math.round(bitmap[i + c] * alpha / 255) : bitmap[i + c];
                max = Math.max(max, Math.abs(v - reference.bitmap[j + c]));
            }
        }
    }
    return max;
};

(async () => {
    const sampled = JSON.parse(await fs.readFile('./tests/jxl/sampled.json', 'utf8'));
    const names = (await fs.readdir('./tests/jxl')).filter(f => f.endsWith('.jxl')).map(f => f.slice(0, -4));
    if (names.length < 28) panic(`only ${names.length} JPEG XLs`);
    for (const name of names) {
        const binary = await fs.readFile(`./tests/jxl/${name}.jxl`);
        if (ImageType.getType(binary) !== 'jxl') panic(`${name}: not detected as JPEG XL`);
        const reference = await Image.decode(await fs.readFile(`./tests/jxl/${name}.png`));
        const {step = 1} = sampled[name] ?? {};
        const premultiplied = name === 'alpha-premultiplied';
        // what djxl decodes (as 8-bit sRGB), within rounding: the first frame shown (of the conformance files every
        // step-th sample), and the frames of cjxl's animations
        const image = await Image.decode(binary);
        let max = difference(image.bitmap, image.width, image.height, reference, step, premultiplied);
        if (name.startsWith('animation') && !sampled[name]) {
            const animation = await Animation.decode(binary);
            const references = await Animation.decode(await fs.readFile(`./tests/jxl/${name}.png`));
            if (animation.length !== references.length) panic(`${name}: ${animation.length} frames instead of ${references.length}`);
            animation.forEach((frame, i) => {
                if (frame.duration !== references[i].duration) panic(`${name}: frame ${i} lasts ${frame.duration} ms instead of ${references[i].duration}`);
                max = Math.max(max, difference(frame.bitmap, frame.width, frame.height, references[i]));
            });
        }
        if (max > (premultiplied ? 2 : 1)) panic(`${name}: differs by ${max} from djxl's`);
    }

    // the first frame only; Animation.decode of a still image
    const first = await Animation.decode(await fs.readFile('./tests/jxl/animation.jxl'), {onlyFirstFrame: true});
    if (first.length !== 1) panic(`onlyFirstFrame: ${first.length} frames`);
    const still = await Animation.decode(await fs.readFile('./tests/jxl/lossy.jxl'));
    if (still.length !== 1 || still[0].width !== 64) panic('a still JPEG XL as an animation');

    // truncated or corrupted data throws
    const lossy = await fs.readFile('./tests/jxl/lossy.jxl');
    for (const cut of [10, 100, lossy.length - 50]) {
        if (await Image.decode(lossy.subarray(0, cut)).then(() => true, () => false)) panic(`decoding ${cut} of ${lossy.length} bytes didn't throw`);
    }
    // the pixel limit
    if (await Image.decode(lossy, {maxPixels: 100}).then(() => true, () => false)) panic('maxPixels was ignored');
})();
