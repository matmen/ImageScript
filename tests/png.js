const fs = require('fs').promises;
const crypto = require('crypto');
const {Image} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

// sha256 of the expected RGBA output, generated with Pillow
const expected = {
    basi0g01: '661985e83f94a569510ded43e65edb11f4ced1121c611209f7abe9a9c40c71a8', // 1-bit greyscale, interlaced
    basn3p04: 'a7abc212cf1a44c85df377773f3722dc118f0c4159df89fdac2dfe6911abe378', // 4-bit palette
    basi6a16: 'f6912d034804dc6b009afea0108cd07b524f79ac84d670f92ce077eec63bead7', // 16-bit RGBA, interlaced
    tbrn2c08: '053eb9d28b7ac85c3639b5169a175df61856cef7ffdaa7ad218cafdde9646d08', // RGB with tRNS color key
    basi3p02: 'a383497791948d8b7ae8f9158fb7b4e9fead4693814ee758a97bc426dc9a27cf', // 2-bit palette, interlaced
    s01i3p01: 'b7d1b3a1104cc86b1cea310793cf777002db0517281d135a02de079b0ea87c23', // 1x1, interlaced
    s09i3p02: '6ec2074e36de7915abf97990d75400925be8b300c1882a36c0cc759ff0e4e456', // 9x9, interlaced
    tbbn3p08: '444403e441924fcd036c85bac271d92d399859bbba3dceb82f29ff90811fb138', // palette with tRNS alpha
    basn4a08: '76b94a71d3c183a362c2cf6a46ebb50adc9d3a25a89bc0afc46fda6dbb002509', // 8-bit greyscale + alpha
    f04n2c08: 'c13eeb551ab25b0ed841ec1dec22b84d327ecd984ac17ea3961f68e63755e6ec', // all filter types
};

(async () => {
    for (const [name, hash] of Object.entries(expected)) {
        const image = await Image.decode(await fs.readFile(`./tests/pngsuite/${name}.png`));
        const actual = crypto.createHash('sha256').update(new Uint8Array(image.bitmap)).digest('hex');
        if (actual !== hash) panic(`${name}: decoded pixels don't match`);
    }

    // corrupted checksum must be rejected
    try {
        await Image.decode(await fs.readFile('./tests/pngsuite/xcsn0g01.png'));
        panic('xcsn0g01: corrupted chunk was accepted');
    } catch (err) {
        if (!/checksum/.test(err.message)) panic(`xcsn0g01: unexpected error ${err.message}`);
    }

    // encode/decode roundtrip
    const image = new Image(97, 61);
    image.fill((x, y) => Image.rgbaToColor(x * 2, y * 4, (x * y) & 0xff, (x + y) & 0xff));
    const decoded = await Image.decode(await image.encode(3));
    if (!Buffer.from(decoded.bitmap).equals(Buffer.from(image.bitmap))) panic('roundtrip failed');
})();
