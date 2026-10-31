// the code paths for big endian machines: where the fast paths read pixels as little endian 32-bit words, the others
// read bytes (and run on either byte order). Forced on here, they must give the same results, or for resizing,
// blurring and rotating (whose fast paths round a little differently, blurring's approximates the Gaussian with
// boxes) the same within 2 premultiplied
const fs = require('fs').promises;
const crypto = require('crypto');
const {Image} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const sha = data => crypto.createHash('sha256').update(new Uint8Array(data)).digest('hex');
const close = (a, b) => {
    for (let i = 0; i < a.length; i += 4)
        for (let c = 0; c < 4; c++)
            if (Math.abs((c < 3 ? a[i + c] * a[i + 3] / 255 : a[i + 3]) - (c < 3 ? b[i + c] * b[i + 3] / 255 : b[i + 3])) > 2) return false;
    return true;
};

(async () => {
    const {littleEndian, useLittleEndian} = await import('../dist/util/alpha.js');
    if (!littleEndian) return; // (the other paths are the ones that run)

    const photo = await Image.decode(await fs.readFile('./tests/targets/external.png'));
    const operations = {
        'JPEG decoding': async () => (await Image.decode(await fs.readFile('./tests/jpegs/orig-420-base.jpg'))).bitmap,
        'PNG decoding': async () => (await Image.decode(await fs.readFile('./tests/pngsuite/f04n2c08.png'))).bitmap,
        'WebP decoding': async () => (await Image.decode(await fs.readFile('./tests/webp/lossy.webp'))).bitmap,
        'JPEG XL decoding': async () => (await Image.decode(await fs.readFile('./tests/jxl/jpeg.jxl'))).bitmap,
        'JPEG encoding': () => photo.encodeJPEG({quality: 80, metadata: {creationTime: 0}}),
        'WebP encoding': () => photo.encodeWebP({quality: 75, metadata: {creationTime: 0}}),
        resizing: () => photo.clone().resize(317, Image.RESIZE_AUTO).bitmap,
        blurring: () => photo.clone().blur(4).bitmap,
        rotating: () => photo.clone().rotate(30).bitmap,
    };

    const results = {};
    for (const [name, operation] of Object.entries(operations)) results[name] = new Uint8Array(await operation());
    useLittleEndian(false);
    try {
        for (const [name, operation] of Object.entries(operations)) {
            const a = results[name], b = new Uint8Array(await operation());
            if (!(['resizing', 'blurring', 'rotating'].includes(name) ? close(a, b) : sha(a) === sha(b))) panic(`${name}: the big endian path differs`);
        }
    } finally {
        useLittleEndian(true);
    }
})();
