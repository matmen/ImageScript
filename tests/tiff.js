const fs = require('fs').promises;
const crypto = require('crypto');
const {Image, ImageType} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

// sha256 of the expected RGBA output, generated with Pillow (16-bit samples use the high byte)
const expected = {
    'bw-tiff_deflate': '31d256641e8bd8552bbd19a752500b19e37c4bb44073a1fe8340a8e99d49f701', // 1-bit, deflate
    'cmyk-tiff_lzw-pred': '3fab24dae8ad00a3b6581691b75776069a44f856c799c85f7f620fd408160511', // CMYK, LZW + horizontal predictor
    'f-tiff_adobe_deflate-pred': 'a18b345aa134ea5f1f394291ffae3c23bac069274467172d54f40e7500b5b1be', // 32-bit float, floating point predictor
    'i16b': 'a18b345aa134ea5f1f394291ffae3c23bac069274467172d54f40e7500b5b1be', // big endian, 16-bit
    'la-tiff_lzw': 'a18b345aa134ea5f1f394291ffae3c23bac069274467172d54f40e7500b5b1be', // greyscale + alpha
    'p-packbits': '95625ae65e88486eaea0e8cb08c3f4f7c964f5e06708ced18da1b29cf61d7c02', // palette, PackBits
    'rgb-bigtiff': '3fab24dae8ad00a3b6581691b75776069a44f856c799c85f7f620fd408160511', // BigTIFF, deflate
    'rgb-jpeg': '6754ace0e464d3929fdc283c8f8ff84c71fe095f6ae4f6be5d26486da9f9746e', // JPEG compression
    'rgba-tiff_lzw-pred': '3fab24dae8ad00a3b6581691b75776069a44f856c799c85f7f620fd408160511', // RGBA, LZW + horizontal predictor
    // written by scripts/tiff-fixtures.py, mostly the pixels of the ones above stored another way
    'rgb16-pred-be': '3fab24dae8ad00a3b6581691b75776069a44f856c799c85f7f620fd408160511', // 16-bit big endian, horizontal predictor
    'rgb-oldlzw': '3fab24dae8ad00a3b6581691b75776069a44f856c799c85f7f620fd408160511', // LZW of libtiff before 5.0
    'l32': 'a18b345aa134ea5f1f394291ffae3c23bac069274467172d54f40e7500b5b1be', // 32-bit unsigned greyscale
    'bw-fillorder2': '31d256641e8bd8552bbd19a752500b19e37c4bb44073a1fe8340a8e99d49f701', // 1-bit, least significant bit first
    'bw-tiles12': '31d256641e8bd8552bbd19a752500b19e37c4bb44073a1fe8340a8e99d49f701', // 1-bit tiles 12 pixels wide
    'l2': 'f6469f1e0b81d41ae3709d91dc523343d5a6382221a79f564fa84fea68caaf10', // 2-bit greyscale
    'rgba-associated': '17f1aa035c8cf3ea6af8b9854a919f7feb38d288736871c6d382c9a6b7d8bed0', // premultiplied alpha
    'f32-range': 'a18b345aa134ea5f1f394291ffae3c23bac069274467172d54f40e7500b5b1be', // floats from 48.5 to 832.5, normalized
    'ycbcr-22': 'b2c68a2df365c06e3cec9b4dd8a215a3ae89ffbab27c985ba9e2e5a700aa1ea6', // YCbCr 4:2:0, the same as libtiff
    'ycbcr-21': 'fccc2cb6270b5398398a65b4ffe6264269484e7a8171f42854cb090f75b82e05', // YCbCr 4:2:2, the same as libtiff
    'ycbcr-11': 'a6278a32e7d15935eb4147a6e432ffd383448fb70a8fa1e651b0714971b89eed', // YCbCr 4:4:4, within 1 of libtiff's tables
};

(async () => {
    for (const [name, hash] of Object.entries(expected)) {
        const binary = await fs.readFile(`./tests/tiffs/${name}.tif`);
        if (ImageType.getType(binary) !== 'tiff') panic(`${name}: not detected as TIFF`);

        const image = await Image.decode(binary);
        if (image.width !== 157 || image.height !== 101) panic(`${name}: dimensions don't match`);
        if (crypto.createHash('sha256').update(new Uint8Array(image.bitmap)).digest('hex') !== hash) panic(`${name}: decoded pixels don't match`);
    }

    // a byte order other than II or MM (Image.decode doesn't detect such data as TIFF, the decoder checks anyway)
    const tiff = await import('../dist/codecs/tiff.js');
    const broken = await fs.readFile('./tests/tiffs/l2.tif');
    broken[0] = broken[1] = 0x58;
    if (!await tiff.decode(broken).then(() => false, error => /byte order/.test(error.message))) panic('an invalid byte order should throw');
})();
