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
const bits24 = '30f8827e84129d1e46acd729b29e4f51f5e62792bde515d6a06f28dfc8e5c1ea';
const expected = {
    '1bit.ico': ['ico', 32, '81ffeaa556f91d42c2ee594637e4578049721197f856d5b991ae9017dc8a385d'],
    '4bit.ico': ['ico', 32, '82b6e7d666b1c8a25dd9df9f825f447505986a95f3bd665fb8d0a5b8d9c0c30f'],
    '8bit.ico': ['ico', 32, 'c5b122413ec511ef9ce56c6f7d7d7ad2c49fd4959607b2e44d8e68f06e799909'],
    '24bit.ico': ['ico', 32, bits24],
    // with alpha, the AND mask isn't used
    '32bit.ico': ['ico', 32, '1ef374e8b807462e3da6cb1e0d3b26f4ea4c574cedf73ba6ccd7cc3c5aefd41b'],
    // alpha that is zero everywhere isn't used, the AND mask is (like for 24 bits)
    '32bit-zero-alpha.ico': ['ico', 32, bits24],
    // the largest image, and of those as large the one with the most bits (not the first)
    'sizes.ico': ['ico', 48, '3cbce1e96af38a9dd273eedf192f1b89c6fd9ff69f6dd45d1bdb99769f247ca4'],
    // a PNG
    'png.ico': ['ico', 64, 'b813ea755cdd849729a15e70af7935e01a62e608bced18f9f7c20a679b41fc8a'],
    'cursor.cur': ['cur', 32, '1ef374e8b807462e3da6cb1e0d3b26f4ea4c574cedf73ba6ccd7cc3c5aefd41b'],
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
