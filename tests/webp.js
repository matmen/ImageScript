const fs = require('fs').promises;
const crypto = require('crypto');
const {Image, Animation, ImageType, decode} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

// sha256 of the RGBA output of libwebp (through Pillow) for files written by libwebp
const expected = {
    lossy: 'c015437d073e901626218276568b0e275d6e486b1024ad70bcd76ddeebe82b95', // VP8
    'lossy-alpha': 'f20e9fec03a515321cec9901ccd7ba9bbc4a10b9371119da7e580150fda47f93', // VP8X + ALPH + VP8
    lossless: 'a3d6d80178932c33e744693b9ec6149f8bbbf0f84f2efc6a31cccc30bfe5f8f6' // VP8L
};

const animated = [
    '4e8bee3d04fd577a2d8e28be4b3db1c79c12be8b53050e45310851b35d4ba21c',
    'ad57ef20633236b1284b090451cae3f5e82d45bba656ba966950f0803cc052a9',
    '0c985b39077eb7ff7715e97f8362e207b0bb700a3d8f3e19d0acb26ff89eae34',
    'b853de342e12ba2cb5403a45caf8d306788597e00702b83ee13b79c364670e00'
];

(async () => {
    for (const [name, hash] of Object.entries(expected)) {
        const data = await fs.readFile(`./tests/webp/${name}.webp`);
        if (ImageType.getType(data) !== 'webp') panic(`${name}: not detected as WebP`);
        const image = await Image.decode(data);
        if (image.width !== 96 || image.height !== 72) panic(`${name}: wrong dimensions`);
        if (sha256(image.bitmap) !== hash) panic(`${name}: decoded pixels don't match libwebp`);
    }

    // animated WebPs: Image.decode refuses them, Animation.decode composites the frames
    const data = await fs.readFile('./tests/webp/animated.webp');
    try {
        await Image.decode(data);
        panic('Image.decode should reject animated WebPs');
    } catch (err) {
        if (!/Animation\.decode/.test(err.message)) panic(`unexpected error ${err.message}`);
    }
    const animation = await Animation.decode(data);
    if (!(await decode(data) instanceof Animation)) panic('decode() should return an Animation for animated WebPs');
    if (animation.length !== 4 || animation.loopCount !== -1) panic('animated WebP: wrong frame or loop count');
    if (animation.map(f => f.duration).join() !== '80,120,80,200') panic('animated WebP: wrong durations');
    animation.forEach((frame, i) => {
        if (sha256(frame.bitmap) !== animated[i]) panic(`animated WebP: frame ${i} doesn't match libwebp`);
    });

    // lossless encoding: photo-like content (predictor), few colors (palette), alpha, odd sizes
    const photo = await Image.decode(await fs.readFile('./tests/webp/lossy.webp'));
    const cases = [
        photo,
        new Image(37, 23).fill((x, y) => (x ^ y) & 4 ? 0xff0000ff : 0x00000000),
        new Image(64, 9).fill((x, y) => Image.rgbaToColor(x * 4, y * 28, 7, (x * 9) & 255)),
        new Image(1, 1).fill(0x12345678)
    ];
    for (const image of cases) {
        const encoded = await image.encodeWebP();
        const back = await Image.decode(encoded);
        if (back.width !== image.width || back.height !== image.height || !Buffer.from(back.bitmap).equals(Buffer.from(image.bitmap)))
            panic(`encodeWebP: ${image.width}x${image.height} didn't round trip`);
    }
})();
