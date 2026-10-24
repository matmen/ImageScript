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
    'yuv420': '405544e4c21a8ed19c9d8f2143cbb43adbea3a73d59ff7a7b8742da0d59c6588',
    'yuv420-12bit': '9e563ff3f8597fafad1a4bdce52f93a350e4037f5dd7bb5f0b2b67bd0d753d2b',
    'yuv422-10bit': '53793513daa157cbe173221964b41c21f6a5b0d584515d99145b17640bdaa828',
    'yuv444': '6065428fd239cffa63075de349d60cd018da36c087237f3e2bbec4cf7428f7d2',
    'mono': '622fc95436c83d80dd7a0c563c3f8136f6d1c8cb5ecb8e44c755508244558e9e',
    'tools': '9800a057d96dff45046995e28f8639c9c9f793172784f6d74ee39c95c0321d8e',
    'segments': '03450e40e17ac1c9000f5a947da7977085c5de7faae1163fc63fa8d06b1a1bbd',
    'grain': 'fa558082b532265a9b26e678effd887f705ec809f253ff2775a1923347d8fd3a',
    'superres': 'b918a7dd27236f4f162d9fbcdbcb795266c40962f4e7366f999dab291534c4f6',
    'screen': '61ba64c8e8625e60b4d59208e6fac09cff5262ebfded088db6fe141cfbf2ab5a',
    'alpha': '9ba0669388bed8df1614aeeaba344cd0668731bf59016fdb596ae5d38b894e6a',
    'alpha-premultiplied': '857c21b5cff307239ab994ac2329d18a0af7746972cef0b921915b65478905ce',
    'grid': '08d32f7cb34e783f4f5cb4c0d595771bec261d79010d78f702b9e681c3196ac2',
    'transforms': '1a00ce63fc61032f0efcf1e9bb2f6e6a44f3835e085a4d0331dff11db04f730a',
    'sequence': 'ae85e62c2d5eb0db1f15430602cdfa41798fcbd5c7a006382efc23c615e54121',
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
