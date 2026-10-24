const fs = require('fs').promises;
const crypto = require('crypto');
const {Image, Animation, Frame} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

// the chunks of a WebP by type
const chunks = data => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength), out = {};
    for (let o = 12; o + 8 <= data.length;) {
        const size = view.getUint32(o + 4, true);
        out[String.fromCharCode(...data.subarray(o, o + 4))] = data.subarray(o + 8, o + 8 + size);
        o += 8 + size + (size & 1);
    }
    return out;
};

// the VP8 chunks cwebp writes with its default settings, or another method (the effort, after the quality;
// scripts/webp-lossy-references.py): the lossy encoder writes the same
const references = {
    'external.png 10': 'c183699ecabe7e2e7e8edabefe7c8ac55d5d84ac4545edbc7fd944535208995b',
    'external.png 75': 'c65d11a3c3b39a817c5930de7287bed1a0b74d424a339481b49f8bc3312e655b',
    'external.png 95': '69a6db62e4d198caf2a1aecabd2525a4b800239dbe072181427beb8eefc1b6db',
    'external.png 75 0': '8d72eccd4c04b63280d7d1d3219cb9635ec99a635bf5104c975b72b54bc91808',
    'external.png 75 1': '54bc209b3f6b667316cd85a1232b5055c46e325e832f6c34850faafe9dc56caf',
    'external.png 75 2': 'ffa7c41217bd4b490b11148e6d958419bb26aa29867b3e33eaf73f7b6ea71192',
    'external.png 75 3': 'ba51738f54fb7081aef38a24b0d1e305db92d58e0a6a6401f724e8c602012c88',
    'external.png 75 5': '09e39995cecde024153049d98f6a382bb9356f034cfdbf3ebc78a4f5684bdf3b',
    'external.png 75 6': '9895ab21ee5f0cf56a4d1174a831282bfb27357926faee45d21de8b99c223c9f',
    'potato.png 10': '2ac93f7e47b24b74ff3c1ec868bce49df64f25cab12851b2e73fc33628735f6c',
    'potato.png 75': '87211a90b235020811862e4826ce8b12e1de36b697fa41215e185ec96fd7b71a',
    'potato.png 95': '1eefc15c7c164a6501ce0363aeee40de5bc2cacb3cf774443e124ad8ad280d12',
    'potato.png 75 0': 'b639a9ce4f3faabcb1e2c9cb90a0c29f25d720a1c13b7fda58db173384e8f9e0',
    'potato.png 75 1': 'c15261d97136d1ca9489ee1230916934c18c0497b628e467ee4ad9d0a2d4e2f6',
    'potato.png 75 2': 'b6dd849a9eacd216c1b1efe625f7a63fe2da79fa2165c17f87f1edff970fe80b',
    'potato.png 75 3': '2d7c57f2032f6b17194bc115e2610d25cd391572378d21227ae10d7713d770e8',
    'potato.png 75 5': '599494465c645f24ee01725ba15d85d54147e20745196bb15ee592043b972ecd',
    'potato.png 75 6': '2f62ebaae6d90195eb8d093c03c1a3fc2a3f5bb9dbe72b01a8bd7ff3efa5f9a2',
    'issues.png 10': '69cafe718d3b7c7871867f77e374bd78db2fdc4329da20550c3c0b248097249d',
    'issues.png 75': 'b834314d5a65f7542c66c227a429b58ee24aaec831579616e0589b301ab5ebee',
    'issues.png 95': '28c512160989364c0f2d9e8e403508199913271400563a1bcd0f7ad0c87983c2',
    'resize.png 10': 'b9dc895dbe5b7b726160653c60e79b46d63f63090c8a98504d0e6014948fa6a1',
    'resize.png 75': '57117d3f821332e8b60ff3080e54e56aee12f406ba54ae47a5f9aff447ebb0cc',
    'resize.png 95': 'da2927043efc7c8c0f452158800bd358f68832206070303ae3faf83d64155572',
    'font-4.png 10': 'dace2359cdc3ddff9bac77124fe08d722689133602a112b0c6fb51487b2bad25',
    'font-4.png 75': 'f110502a0358402527354dc866891c389cd421a5cc1bd4dd31f16b1c91f72a0a',
    'font-4.png 95': 'f8e9d74d1a948e3e402f05839ba4495a87e0fc236d8db9271462a565903fada1',
    'font-4.png 75 0': 'd604f77949a42fabd7e60af927de466520c890bcd2d037c79ac86a6ea460d88e',
    'font-4.png 75 1': '0df005b6fdfb6fbb05227b7d88945fc08213be2ab3a04f4a5c60b128a7efb5c5',
    'font-4.png 75 2': 'b0634fd71fe2a1e9358954363a9c923374314823bf4c46d4ec07d8b02f7d2136',
    'font-4.png 75 3': 'f110502a0358402527354dc866891c389cd421a5cc1bd4dd31f16b1c91f72a0a',
    'font-4.png 75 5': 'f110502a0358402527354dc866891c389cd421a5cc1bd4dd31f16b1c91f72a0a',
    'font-4.png 75 6': 'f110502a0358402527354dc866891c389cd421a5cc1bd4dd31f16b1c91f72a0a',
};

(async () => {
    for (const [key, reference] of Object.entries(references)) {
        const [name, quality, effort = '4'] = key.split(' ');
        const image = await Image.decode(await fs.readFile(`./tests/targets/${name}`));
        const webp = await image.encodeWebP({quality: Number(quality), effort: Number(effort)});
        const c = chunks(webp);
        if (!c['VP8 '] || sha256(c['VP8 ']) !== reference) panic(`${key}: the VP8 chunk differs from cwebp's`);

        // alpha is lossless, color close
        const back = await Image.decode(webp);
        let alpha = 0, color = 0;
        for (let i = 0; i < image.bitmap.length; i += 4) {
            alpha = Math.max(alpha, Math.abs(back.bitmap[i + 3] - image.bitmap[i + 3]));
            if (image.bitmap[i + 3] === 255) color += Math.abs(back.bitmap[i] - image.bitmap[i]) + Math.abs(back.bitmap[i + 1] - image.bitmap[i + 1]);
        }
        if (alpha) panic(`${key}: alpha differs by ${alpha}`);
        if (!!c.ALPH !== image.bitmap.some((v, i) => (i & 3) === 3 && v !== 255)) panic(`${key}: ALPH chunk only for transparent images`);
        if (Number(quality) === 95 && color / (image.width * image.height * 2) > 6) panic(`${key}: decodes too different from the image`);
    }

    // noisy alpha: stored uncompressed (smaller than compressed), still lossless
    let seed = 1;
    const random = () => (seed = seed * 1103515245 + 12345 >>> 0) >>> 24;
    const noisy = new Image(24, 24).fill((x, y) => Image.rgbaToColor(x * 10, y * 10, 99, random()));
    const noisyWebp = await noisy.encodeWebP({quality: 50});
    if (chunks(noisyWebp).ALPH[0] !== 0) panic('noisy alpha should be stored uncompressed and unfiltered');
    const noisyBack = await Image.decode(noisyWebp);
    for (let i = 3; i < noisy.bitmap.length; i += 4) if (noisyBack.bitmap[i] !== noisy.bitmap[i]) panic('noisy alpha: differs');

    // the quality and effort are validated, lossless stays the default
    const image = new Image(20, 10).fill(0x336699ff);
    for (const quality of [-1, 101, NaN]) {
        if (!await image.encodeWebP({quality}).then(() => false, e => e instanceof RangeError)) panic(`quality ${quality} should throw`);
    }
    for (const effort of [-1, 7, 1.5]) {
        if (!await image.encodeWebP({quality: 75, effort}).then(() => false, e => e instanceof RangeError)) panic(`effort ${effort} should throw`);
    }
    if (!chunks(await image.encodeWebP()).VP8L) panic('without a quality WebPs should be lossless');

    // lossy animations
    const frames = [0xff0000ff, 0x00ff00ff, 0x0000ff80].map((color, i) => {
        const frame = new Image(40, 30).fill(color);
        frame.drawBox(i * 10, 5, 10, 10, 0xffffffff);
        return frame;
    });
    const animation = new Animation(frames.map(f => Frame.from(f, 100)), 0);
    const lossy = await animation.encodeWebP({quality: 80});
    const decoded = await Animation.decode(lossy);
    if (decoded.length !== 3) panic(`lossy animation: ${decoded.length} frames instead of 3`);
    if (!String.fromCharCode(...lossy).includes('VP8 ')) panic('lossy animation: no VP8 frames');
    // (the last frame is half transparent: it's blended over the one before)
    const lossless = await Animation.decode(await animation.encodeWebP());
    for (let f = 0; f < 3; f++) {
        const [r, g, b, a] = Image.colorToRGBA(decoded[f].getPixelAt(1, 1));
        const [er, eg, eb, ea] = Image.colorToRGBA(lossless[f].getPixelAt(1, 1));
        if (Math.abs(r - er) + Math.abs(g - eg) + Math.abs(b - eb) > 12 || a !== ea) panic(`lossy animation: frame ${f} decodes to ${[r, g, b, a]}`);
    }
    if (!await animation.encodeWebP({quality: 200}).then(() => false, e => e instanceof RangeError)) panic('animation quality 200 should throw');
})();
