const fs = require('fs').promises;
const crypto = require('crypto');
const {Image, ImageType} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const sha = image => crypto.createHash('sha256').update(new Uint8Array(image.bitmap)).digest('hex');

// sha256 of the expected RGBA output, as Pillow decodes the same image (scripts/format-fixtures.py); the pixels the
// AND mask makes transparent are transparent black
const bits24 = 'b5fa3f2de13337692e5672fa711981eecf939311942c9d042719665c55d4b23a';
const expected = {
    '1bit.ico': ['ico', 32, '52124dcb35bc47f2dcf23c98b193a723e1f4e7a136d8ee4ddb90dba544952aed'],
    '4bit.ico': ['ico', 32, 'a6922eb94f2a74743f074ceeb155cc48ad0098a2043e3f66772df6d8d4848bc5'],
    '8bit.ico': ['ico', 32, '55d71be52c8bde8b3a6f57c8656d3692da7484e0c2017dd7d295200689b92b48'],
    '24bit.ico': ['ico', 32, bits24],
    // with alpha, the AND mask isn't used
    '32bit.ico': ['ico', 32, '0a03c438922ffc2569acdad888c3255d4776f267db402cbd95675d5b46ba1240'],
    // alpha that is zero everywhere isn't used, the AND mask is (like for 24 bits)
    '32bit-zero-alpha.ico': ['ico', 32, bits24],
    // the largest image, and of those as large the one with the most bits (not the first)
    'sizes.ico': ['ico', 48, '2b93ec7aab249551358a004f9e362bdc10b21e2b0b3b1d060dc856d76836be1a'],
    // a PNG
    'png.ico': ['ico', 64, '07f56f345c3e9bbbc1f7b69fd9b7ff509d0b3a676f3be417bb9088c0fbae796a'],
    'cursor.cur': ['cur', 32, '0a03c438922ffc2569acdad888c3255d4776f267db402cbd95675d5b46ba1240'],
};

(async () => {
    for (const [name, [type, size, hash]] of Object.entries(expected)) {
        const binary = await fs.readFile(`./tests/ico/${name}`);
        if (ImageType.getType(binary) !== type) panic(`${name}: not detected as ${type}`);
        if (!ImageType.isICO(binary)) panic(`${name}: isICO should be true`);
        const image = await Image.decode(binary);
        if (image.width !== size || image.height !== size) panic(`${name}: ${image.width}x${image.height} instead of ${size}x${size}`);
        if (sha(image) !== hash) panic(`${name}: decoded pixels don't match`);
    }

    // wrong sizes in the directory: the data up to the end is used
    const icon = await fs.readFile('./tests/ico/24bit.ico');
    icon.writeUInt32LE(8, 14);
    if (sha(await Image.decode(icon)) !== bits24) panic('an icon with a wrong size in its directory should decode');
    // an entry outside the data is skipped
    const sizes = await fs.readFile('./tests/ico/sizes.ico');
    sizes.writeUInt32LE(sizes.length + 100, 6 + 2 * 16 + 12);
    if ((await Image.decode(sizes)).width !== 48) panic('the other 48x48 entry should be used');
})();
