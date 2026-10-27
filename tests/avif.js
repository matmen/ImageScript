const fs = require('fs').promises;
const crypto = require('crypto');
const {Image, ImageType, Animation} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const sha = image => crypto.createHash('sha256').update(new Uint8Array(image.bitmap)).digest('hex');
const maxDifference = (a, b) => {
    let max = 0;
    for (let i = 0; i < a.bitmap.length; i++) max = Math.max(max, Math.abs(a.bitmap[i] - b.bitmap[i]));
    return max;
};

// the AVIFs of scripts/avif-fixtures.py as libavif decodes them (with dav1d)
const references = {
    'yuv420': '8538965a0f7e917daac4f08481d827f8ab64b7db15d61c591fb3680c25547481',
    'yuv420-12bit': '90e1db5bd40f2418d01b6cff2f0a370c77270fcb6a86eb498b3eaf6228fb4232',
    'yuv422-10bit': 'd6191a34034304d914921b21cb4ddc9233cf85754461875c0837338c44674012',
    'yuv444': '5b9fdf4ea98158c29fb9551dc6186f0ae8042eea298ed21e246ed9e2198510d4',
    'mono': '2e14306840020f2e831088a9f3c5d59034d1f7f047b00e6b8988c6e096a6a8b8',
    'tools': '5cbb7c24c81ca6481ee6f4b8e9bdd6d00bd9854b120d12e9f52a3133905bb0e9',
    'segments': '012e024cc536ac4f3c2dcc326b064740546e45053863eff072a3465ca83fcd4d',
    'grain': 'c7a420818c09a0db23feca2a2404bc08fa9623f7c208ddb3b3c6e27698cd3082',
    'superres': 'b098e3ddc1828f5565ad1ab4bd11ea74c8d0fd31ecae675d0249c80ad289cc27',
    'screen': '4fac188ded63f814be85a2a5846cc4306e65b580dcebb91e9883ba67f927e77e',
    'alpha': '75997458251525c3c06ec8ef2149a90e32726831f1a599b1356c658d98bc849d',
    'alpha-premultiplied': 'ad09ce797bed32479ad72523ab188a39441ebc85976a284ab3da121702b19b46',
    'grid': 'b6f5c3be81ac52daabe55e9b0f5a4f6e9a5f1b4adcf82c013cdcc2588d542f74',
    'transforms': '38a9ade925431f685369468071feed32b90e3e2f5c855ea8040142ef1e0051cc',
    'sequence': '1b62b5829e6d56d35ff7f0cfa6b7fef6da9c5f85e58799ea5b679f2864eef125',
};

(async () => {
    for (const [name, reference] of Object.entries(references)) {
        const binary = await fs.readFile(`./tests/avif/${name}.avif`);
        if (ImageType.getType(binary) !== 'avif') panic(`${name}: not detected as AVIF`);
        const image = await Image.decode(binary);
        if (sha(image) !== reference) panic(`${name}: decoded pixels don't match`);
    }
    const transformed = await Image.decode(await fs.readFile('./tests/avif/transforms.avif'));
    if (transformed.width !== 20 || transformed.height !== 30) panic(`transforms: ${transformed.width}x${transformed.height} instead of 20x30`);

    // lossless RGB is the source's pixels; the PQ and HLG ones (BT.2020) are close to them as sRGB, SDR white being
    // white
    const source = await Image.decode(await fs.readFile('./tests/avif/source.png'));
    const lossless = await Image.decode(await fs.readFile('./tests/avif/lossless.avif'));
    if (maxDifference(lossless, source)) panic('lossless: differs from the source');
    for (const name of ['pq', 'hlg']) {
        const binary = await fs.readFile(`./tests/avif/${name}.avif`);
        for (const toneMapping of ['clamp', 'reinhard']) {
            const max = maxDifference(await Image.decode(binary, {toneMapping}), source);
            if (max > 2) panic(`${name}: differs by ${max} from the source (${toneMapping})`);
        }
    }

    // image sequences decode as their first frame
    const animation = await Animation.decode(await fs.readFile('./tests/avif/sequence.avif'));
    if (animation.length !== 1 || sha(animation[0]) !== references.sequence) panic('sequence: Animation.decode should give its first frame');

    // invalid data throws
    const binary = await fs.readFile('./tests/avif/yuv420.avif');
    for (const [what, data] of [['truncated', binary.subarray(0, binary.length - 100)], ['without its meta box', binary.subarray(0, 32)]]) {
        try {
            await Image.decode(data);
            panic(`${what} AVIF accepted`);
        } catch (err) {
            if (!/AVIF|AV1/.test(err.message)) panic(`${what}: unexpected error ${err.message}`);
        }
    }
})();
