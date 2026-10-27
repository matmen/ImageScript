const fs = require('fs').promises;
const crypto = require('crypto');
const {Image, ImageType, decode} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const sha = image => crypto.createHash('sha256').update(new Uint8Array(image.bitmap)).digest('hex');

// the HDRs of scripts/format-fixtures.py: the same pixels in every orientation and encoding (none brighter than white,
// so tone mapping doesn't change them), as OpenCV decodes rle.hdr (linear light clamped to 0..1 as sRGB)
(async () => {
    const rle = '30e3c8514c13c83d1b5fb420bada90a7ad96025b0db97072e7a9b0f802e4b45a';
    for (const name of ['rle', 'flat', 'old-rle', 'bottom-up', 'mirrored', 'columns', 'columns-flipped']) {
        const binary = await fs.readFile(`./tests/hdr/${name}.hdr`);
        if (ImageType.getType(binary) !== 'hdr') panic(`${name}: not detected as HDR`);
        const image = await Image.decode(binary);
        if (image.width !== 23 || image.height !== 9) panic(`${name}: ${image.width}x${image.height} instead of 23x9`);
        if (sha(image) !== rle) panic(`${name}: decoded pixels don't match`);
    }
    // old run length encoding of runs longer than 255 (repetitions shifted by 8 bits)
    if (sha(await Image.decode(await fs.readFile('./tests/hdr/old-rle-long.hdr'))) !== 'cf12a691a67f13351a03b2838d76a6d34ef356df56951eb40fadc753dc73127f') panic('old-rle-long: decoded pixels don\'t match');

    // brighter than white: tone mapped by default (scripts/format-fixtures.py computes Reinhard's operator), or clamped
    // like OpenCV decodes it
    const bright = await fs.readFile('./tests/hdr/bright.hdr');
    if (sha(await Image.decode(bright)) !== 'a1a2b278f6c6b3cc4f49c6524bbbc27764a8ae864c5171cb4537a7eea2a4cc03') panic('bright: tone mapped pixels don\'t match');
    if (sha(await Image.decode(bright, {toneMapping: 'clamp'})) !== '5d034eaf0755d5be5e15ca7a259d81d933ce0f4d5427d2c322b7470db013bf58') panic('bright: clamped pixels don\'t match');
    if (sha(await decode(bright, {toneMapping: 'clamp'})) !== '5d034eaf0755d5be5e15ca7a259d81d933ce0f4d5427d2c322b7470db013bf58') panic('decode() should pass toneMapping on');
    if (!await Image.decode(bright, {toneMapping: 'aces'}).then(() => false, e => e instanceof TypeError)) panic('an unknown toneMapping should throw');

    // XYZE: the same pixels as CIE XYZ, by Radiance's primaries (rounded differently by the shared exponents)
    const [xyz, rgb] = await Promise.all(['xyze', 'rle'].map(async name => Image.decode(await fs.readFile(`./tests/hdr/${name}.hdr`))));
    let max = 0;
    for (let i = 0; i < rgb.bitmap.length; i++) max = Math.max(max, Math.abs(xyz.bitmap[i] - rgb.bitmap[i]));
    if (max > 3) panic(`xyze: differs by ${max} from the RGB pixels`);

    // invalid data throws
    for (const text of ['#?RADIANCE\nFORMAT=32-bit_rle_cmyk\n\n-Y 1 +X 1\n\0\0\0\0', '#?RADIANCE\n\n-Y 1 -Y 1\n\0\0\0\0', '#?RADIANCE\n\n-Y 2 +X 8\n\x02\x02\x00\x09']) {
        const data = Uint8Array.from(text, c => c.charCodeAt(0));
        if (!await Image.decode(data).then(() => false, e => /HDR/.test(e.message))) panic(`invalid HDR accepted: ${JSON.stringify(text)}`);
    }
})();
