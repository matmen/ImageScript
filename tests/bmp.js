const fs = require('fs').promises;
const crypto = require('crypto');
const {Image, ImageType} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const sha = image => crypto.createHash('sha256').update(new Uint8Array(image.bitmap)).digest('hex');

// sha256 of the expected RGBA output: the same as BMP Suite's reference images, except where noted
const pal8 = '9f33d52c158d285928d5c27e5b59b84aaa26a53ab5d204383d72889c6f6d9051';
const rgb24 = 'ac4dbaf6110c3f2c88edb4221e90dd2567525b25cd1c1c736aafd584b206d053';
const rgba32 = '71ff34dcb94a17b8a7b939e98c897776799cbf55ae74d724387fbd4f32fa584c';
const expected = {
    'pal1bg': 'e1f6f0b4b6dcbc8a12399ff252b870cec77e693891e8cce2e6ce222fb39d54d7', // 1 bit, two colors
    'pal2color': '4456fcd6af728b89a7810f6c15b7dcd8a5b052586196f454df3e0c53d75bf291', // 2 bits (Windows CE)
    'pal4': '2b322fe79adba0175a70554025496bcb2140a63a08121e977c6027a1ef2161d6',
    'pal4rle': '2b322fe79adba0175a70554025496bcb2140a63a08121e977c6027a1ef2161d6',
    'pal4rlecut': 'a500564072969e0760d0a3bb1e6f846b80f3bc13b234b4a58543944ad8c906d6', // early line and bitmap ends: transparent
    'pal8': pal8,
    'pal8os2': pal8, // OS/2 1.x header, 3 byte palette entries
    'pal8os2v2-16': pal8, // OS/2 2.x header of 16 bytes
    'pal8topdown': pal8,
    'pal8rle': pal8,
    'rletopdown': pal8, // (not allowed, but readable)
    'pal8rletrns': '5ace1963d709082330efe0b3ae3e1a45d77d3b0b5e970661a2ec5a61018555fd', // pixels skipped by deltas: transparent
    'pal8w125': 'cf4d45fe07f4e82ecfbcba4fdcb450cfad35fdae515ae3977732725ed309f2f8', // rows padded
    'rgb16-565': '2a018aed0053eb0783adb970dbcb7f6c373459fdfbdb16ad855d407bf33e754e', // scaled to full white, not shifted
    'rgb16-231': '658effd0494b902d5ad5c10e8e74e52894671f8c61115be9a21f491cf5438139',
    'rgb16-880': '1d59bddfa5820426da9b8e79e84f42af8ddca360c0478e500d44ef08188fdc36', // an empty blue mask
    'rgb24': rgb24,
    'rgb32bf': rgb24, // bit fields in an unusual order
    'rgb32h52': rgb24, // 52 byte header with the masks
    'rgb32fakealpha': rgb24, // the unused byte isn't alpha
    'rgb32-7187': '1e4aa69ba28fcaad26feff3d014da0effee70cbca99d71a3043402707e3d3200', // 18 bit green, rounded (the reference truncates)
    'rgb24png': rgb24, // an embedded PNG
    'rgb24jpeg': '0e749191351feb8e5dbd73f420b36a65e1956ee55fdce18cf6f2002ba4a5235c', // an embedded JPEG, as its decoding
    'rgba16-1924': 'a2ab9ff4d1c29dc2b155dc3d1809b21d795063a6aa13a5ae1774b919ab0c48a1', // 16 bits with alpha
    'rgba32-1': rgba32,
    'rgba32abf': rgba32, // BI_ALPHABITFIELDS
    'rgba64': 'bdf52692efeb99858caa6626ed4fb8fa0b01141d72c873bc5b9a46bff2b56406', // linear 2.13 fixed point, within 1 of the reference
};

(async () => {
    for (const [name, hash] of Object.entries(expected)) {
        const binary = await fs.readFile(`./tests/bmp/${name}.bmp`);
        if (ImageType.getType(binary) !== 'bmp') panic(`${name}: not detected as BMP`);
        const image = await Image.decode(binary);
        if (sha(image) !== hash) panic(`${name}: decoded pixels don't match`);
    }
    const withJPEG = await fs.readFile('./tests/bmp/rgb24jpeg.bmp');
    const jpeg = await Image.decode(withJPEG.subarray(withJPEG.readUInt32LE(10)));
    if (sha(jpeg) !== expected.rgb24jpeg) panic('the embedded JPEG decodes differently than by itself');

    // damaged files throw, or decode as far as they can
    for (const [name, error] of [['shortfile', /truncated/], ['badbitcount', /bit depth/], ['reallybig', /too large/]]) {
        if (!await Image.decode(await fs.readFile(`./tests/bmp/${name}.bmp`)).then(() => false, e => error.test(e.message))) panic(`${name} should throw ${error}`);
    }
    for (const name of ['badrle4', 'pal8badindex']) await Image.decode(await fs.readFile(`./tests/bmp/${name}.bmp`));

    // encoding: the smallest bit depth that holds the image, alpha with a version 4 header
    const cases = [
        [new Image(13, 5).fill((x, y) => (x + y) & 1 ? 0xffffffff : 0x000000ff), 1],
        [new Image(17, 6).fill((x, y) => Image.rgbaToColor(x % 4 * 80, y % 4 * 80, 40, 255)), 4],
        [new Image(33, 9).fill((x, y) => Image.rgbaToColor(x * 7, y % 7 * 30, 99, 255)), 8],
        [new Image(31, 9).fill((x, y) => Image.rgbaToColor(x * 8, y * 28, (x * 13 + y * 7) & 255, 255)), 24],
        [new Image(29, 6).fill((x, y) => Image.rgbaToColor(x * 8, 200 - y * 30, x * y, (x * 9) & 255)), 32],
        [new Image(1, 1).fill(0x123456ff), 1],
    ];
    for (const [image, bits] of cases) {
        const encoded = await image.encodeBMP();
        if (ImageType.getType(encoded) !== 'bmp') panic('encoded BMP not detected');
        if (encoded[28] !== bits) panic(`${image.width}x${image.height}: ${encoded[28]} bits instead of ${bits}`);
        if (bits === 32 && encoded[14] !== 108) panic('32 bit BMPs should have a version 4 header');
        const back = await Image.decode(encoded);
        if (!Buffer.from(back.bitmap).equals(Buffer.from(image.bitmap))) panic(`BMP: ${image.width}x${image.height} didn't round trip`);
    }
})();
