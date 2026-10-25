const fs = require('fs').promises;
const {Image} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

// the PSNR of the visible pixels' RGB (the color of transparent ones doesn't matter), the largest alpha difference
const compare = (a, b) => {
    let se = 0, n = 0, alpha = 0;
    for (let i = 0; i < a.bitmap.length; i += 4) {
        alpha = Math.max(alpha, Math.abs(a.bitmap[i + 3] - b.bitmap[i + 3]));
        if (!a.bitmap[i + 3]) continue;
        for (let c = 0; c < 3; c++) {
            const d = a.bitmap[i + c] - b.bitmap[i + c];
            se += d * d;
            n++;
        }
    }
    return [se ? 10 * Math.log10(255 * 255 * n / se) : Infinity, alpha];
};

(async () => {
    const photo = (await Image.decode(await fs.readFile('./tests/targets/external.png'))).resize(160, 160);
    const potato = (await Image.decode(await fs.readFile('./tests/targets/potato.png'))).resize(128, 128);

    // quality: larger and better; 4:2:0 smaller than 4:4:4
    let last = 0, lastPsnr = 0;
    for (const quality of [20, 60, 90]) {
        const avif = await photo.encodeAVIF({quality, effort: 0});
        const [psnr] = compare(photo, await Image.decode(avif));
        if (avif.length <= last || psnr <= lastPsnr) panic(`quality ${quality}: ${avif.length} bytes, ${psnr.toFixed(2)} dB`);
        last = avif.length;
        lastPsnr = psnr;
    }
    if (lastPsnr < 40) panic(`quality 90: ${lastPsnr.toFixed(2)} dB`);
    const sub = await photo.encodeAVIF({subsampling: '4:2:0', effort: 0}), full = await photo.encodeAVIF({effort: 0});
    if (sub.length >= full.length || compare(photo, await Image.decode(sub))[0] < 30) panic('4:2:0');
    // effort: the searches give smaller files of about the same quality
    const e2 = await photo.encodeAVIF({effort: 2});
    if (e2.length > full.length * 1.02) panic(`effort 2: ${e2.length} bytes instead of ${full.length}`);

    // transparency: lossless alpha by default, lossy if asked; lossless color
    const [psnr, alpha] = compare(potato, await Image.decode(await potato.encodeAVIF({effort: 0})));
    if (alpha || psnr < 35) panic(`alpha: ${psnr.toFixed(2)} dB, alpha off by ${alpha}`);
    const [, lossyAlpha] = compare(potato, await Image.decode(await potato.encodeAVIF({alphaQuality: 50, effort: 0})));
    if (!lossyAlpha) panic('lossy alpha is lossless');
    const lossless = await Image.decode(await potato.encodeAVIF({quality: 100, effort: 0}));
    if (Buffer.compare(Buffer.from(lossless.bitmap), Buffer.from(potato.bitmap))) panic('quality 100 isn\'t lossless');

    // odd sizes, a pixel, wider than a tile (4096 pixels)
    for (const [w, h] of [[1, 1], [7, 3], [65, 130], [4100, 8]]) {
        const image = new Image(w, h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) image.setPixelAt(x, y, Image.rgbaToColor(x * 37 & 255, y * 71 & 255, (x + y) * 5 & 255, 255));
        const back = await Image.decode(await image.encodeAVIF({quality: 90, effort: 0}));
        if (back.width !== w || back.height !== h || compare(image, back)[0] < 28) panic(`${w}x${h}: ${compare(image, back)[0].toFixed(2)} dB`);
    }
})();
