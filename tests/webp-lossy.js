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

// the VP8 chunks cwebp writes with its default settings, or another method (the effort, after the quality), or with
// -sharp_yuv (scripts/webp-lossy-references.py): the lossy encoder writes the same
const references = {
    'external.png 10': 'f9fd519b84f414de2399f7c3dc1c6bbb7bafd2838a35e629a8958288e868fc88',
    'external.png 75': '5ae6287861d2ce309cf9b2e207ceaed2ee90a0fd9a65c82d8a931343b753620d',
    'external.png 95': '6d7f3c20a5e7875d5c5697dd8be4837eac7596e0bf62e237c0e36bbbf2170e45',
    'external.png 75 0': '26c700b687c6a1cf797f7e94e3bf43d4084332b0f7122917af53073a2b2a1f89',
    'external.png 75 1': 'b8a638986e094eeb33b547f3bc7b0134eb578de0983b3ba4e2fe28694b151c85',
    'external.png 75 2': '0e95cd964d370213d612601b9e5a26e707e71be915caf55ca686e56ec59f6c33',
    'external.png 75 3': '33f258a10915117ef294f3e9b3d85b995cb1f8a5cdfae0e09e06aa23cda96718',
    'external.png 75 5': '287edc16f0cea16638bbf3634e100098bccb49e414b7c4d6fd12de764e93ef31',
    'external.png 75 6': 'ead4782bd2ac34acdc4f297e11d10a98e22a5c1a2bf78adb72b0200e7bdd0078',
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
    'external.png 75 4 sharp': '0c9f537ad2177daa75e40cc278614bbcecdcd8ed6dea6afde136092e3d114169',
    'external.png 75 2 sharp': 'b246bf92b292473b50bc6d30032ddac0fb182072328d37f7e2e1c5e372dfb821',
    'potato.png 75 4 sharp': '3d7f5b78a1cada1a81928cc8481916cd91406bcce037fc7d1328e8ffa4bdae8f',
    'potato.png 75 2 sharp': '4093a615d675cbdabc82b8fd2778c585779a8a9dd0e29bb34e31020890509e66',
    'font-4.png 75 4 sharp': 'f110502a0358402527354dc866891c389cd421a5cc1bd4dd31f16b1c91f72a0a',
    'font-4.png 75 2 sharp': 'b0634fd71fe2a1e9358954363a9c923374314823bf4c46d4ec07d8b02f7d2136',
};

// the alpha planes of cwebp's files with -alpha_q (at quality 75, scripts/webp-lossy-references.py): alphaQuality
// reduces the levels to the same values
const alphaReferences = {
    'potato.png alpha 0': '9bfd0225c5cf2b10c1cd655e2faf55b8eac9f5aaa3f0730d99cb068ca9f46afa',
    'potato.png alpha 30': '74016b8d07a95768da0de928dbfd236718c3612971d6a691aca6f30942ea446b',
    'potato.png alpha 70': '627b3304829190b2c877840eb8b156b5ed827bcfd4d55f6ef0109cf946b423de',
    'potato.png alpha 90': '0ab9d442f426f33c9496d8cdc9ac582cf3d5035f238608adfde747f914e57f2e',
    'font-4.png alpha 0': '3cf8b15dd90f0d2c309ab16c6beb2efccbee967a0231d395860b8429ccfdd9f5',
    'font-4.png alpha 30': '8e61c330255abc7b81b55bbdf947e5a4fe531f2678528ad2723ac93d41e0b452',
    'font-4.png alpha 70': '1e02666c2d51f2003e24a8e6fb4f93c2322841b4ca477c0671e231bda19a9479',
    'font-4.png alpha 90': 'fde0979974df4af6c9947ae1ba0043eb4e24e96459ea56d03431cdd6ecdb07b4',
};

(async () => {
    for (const [key, reference] of Object.entries(references)) {
        const [name, quality, effort = '4', sharp] = key.split(' ');
        const image = await Image.decode(await fs.readFile(`./tests/targets/${name}`));
        const webp = await image.encodeWebP({quality: Number(quality), effort: Number(effort), sharpYuv: sharp === 'sharp'});
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

    for (const [key, reference] of Object.entries(alphaReferences)) {
        const [name, , alphaQuality] = key.split(' ');
        const image = await Image.decode(await fs.readFile(`./tests/targets/${name}`));
        const webp = await image.encodeWebP({quality: 75, alphaQuality: Number(alphaQuality)});
        const back = await Image.decode(webp);
        const plane = new Uint8Array(back.width * back.height);
        for (let i = 0; i < plane.length; i++) plane[i] = back.bitmap[i * 4 + 3];
        if (sha256(plane) !== reference) panic(`${key}: the alpha plane differs from cwebp's`);
        // (marked as preprocessed)
        if (!(chunks(webp).ALPH[0] & 16)) panic(`${key}: the ALPH chunk should say its levels were reduced`);
    }
    {
        const image = await Image.decode(await fs.readFile('./tests/targets/potato.png'));
        const sizes = await Promise.all([100, 50].map(async alphaQuality => chunks(await image.encodeWebP({quality: 75, alphaQuality})).ALPH.length));
        if (!(sizes[1] < sizes[0])) panic(`alphaQuality 50 should make a smaller alpha plane: ${sizes}`);
        for (const alphaQuality of [-1, 101, NaN]) {
            if (!await image.encodeWebP({quality: 75, alphaQuality}).then(() => false, e => e instanceof RangeError)) panic(`alphaQuality ${alphaQuality} should throw`);
        }
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

    // alphaQuality for animations, also encoded a frame at a time
    const faded = new Animation([0, 1].map(i => Frame.from(new Image(40, 30).fill((x, y) => Image.rgbaToColor(200, 50 * i, 9, x * 6 + y)), 100)), 0);
    const fadedWebp = await faded.encodeWebP({quality: 80, alphaQuality: 0, optimize: false});
    const encoder = Animation.webpEncoder(40, 30, {loopCount: 0, quality: 80, alphaQuality: 0, optimize: false});
    for (const frame of faded) await encoder.add(frame);
    if (sha256(await encoder.finish()) !== sha256(fadedWebp)) panic('alphaQuality: the incremental encoder writes another file');
    for (const frame of await Animation.decode(fadedWebp)) {
        const levels = new Set();
        for (let i = 3; i < frame.bitmap.length; i += 4) levels.add(frame.bitmap[i]);
        if (levels.size > 2) panic(`alphaQuality 0: ${levels.size} alpha levels instead of 2`);
    }
    if (!await faded.encodeWebP({quality: 80, alphaQuality: 101}).then(() => false, e => e instanceof RangeError)) panic('animation alphaQuality 101 should throw');
})();
