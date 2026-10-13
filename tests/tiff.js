const fs = require('fs').promises;
const crypto = require('crypto');
const {Image, ImageType} = require('../ImageScript');

const panic = message => {
    console.error(message);
    process.exit(1);
};

// sha256 of the expected RGBA output, generated with Pillow (16-bit samples use the high byte)
const expected = {
    'bw-tiff_deflate': 'bddeb89fcf5946ab3da243b483b3518f193ef3823cb22ec2f743a7315193d6fa', // 1-bit, deflate
    'cmyk-tiff_lzw-pred': '528738c07a1d81ee4b7e78cb90ca63da67b15a8f39f16715fc980729f3cdd2c9', // CMYK, LZW + horizontal predictor
    'f-tiff_adobe_deflate-pred': '16297996850e2361bf2d6e630efa25e25e44fc624880897e684979647caf906a', // 32-bit float, floating point predictor
    'i16b': 'ffbb919c37e84964bc8725db998b14a8ffde7c41bd2b26d700c73fcac5181c59', // big endian, 16-bit
    'la-tiff_lzw': '16297996850e2361bf2d6e630efa25e25e44fc624880897e684979647caf906a', // greyscale + alpha
    'p-packbits': '42a6b92f00c20dbd1ae352b9897a8f2318bd52aa0a895acb94e5d3a88f02d559', // palette, PackBits
    'rgb-bigtiff': '528738c07a1d81ee4b7e78cb90ca63da67b15a8f39f16715fc980729f3cdd2c9', // BigTIFF
    'rgb-jpeg': '4fc45173fe10c26acea8e1cb79fcabe3afeb66f48d3628498ffc4bfa6f414587', // JPEG compression
    'rgba-tiff_lzw-pred': '528738c07a1d81ee4b7e78cb90ca63da67b15a8f39f16715fc980729f3cdd2c9', // RGBA, LZW + horizontal predictor
};

(async () => {
    for (const [name, hash] of Object.entries(expected)) {
        const binary = await fs.readFile(`./tests/tiffs/${name}.tif`);
        if (ImageType.getType(binary) !== 'tiff') panic(`${name}: not detected as TIFF`);

        const image = await Image.decode(binary);
        if (image.width !== 157 || image.height !== 101) panic(`${name}: dimensions don't match`);
        if (crypto.createHash('sha256').update(image.bitmap).digest('hex') !== hash) panic(`${name}: decoded pixels don't match`);
    }
})();
