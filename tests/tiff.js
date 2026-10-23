const fs = require('fs').promises;
const crypto = require('crypto');
const {Image, ImageType} = require('..');

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
    'rgb-bigtiff': '528738c07a1d81ee4b7e78cb90ca63da67b15a8f39f16715fc980729f3cdd2c9', // BigTIFF, deflate
    'rgb-jpeg': '4fc45173fe10c26acea8e1cb79fcabe3afeb66f48d3628498ffc4bfa6f414587', // JPEG compression
    'rgba-tiff_lzw-pred': '528738c07a1d81ee4b7e78cb90ca63da67b15a8f39f16715fc980729f3cdd2c9', // RGBA, LZW + horizontal predictor
    // written by scripts/tiff-fixtures.py, mostly the pixels of the ones above stored another way
    'rgb16-pred-be': '528738c07a1d81ee4b7e78cb90ca63da67b15a8f39f16715fc980729f3cdd2c9', // 16-bit big endian, horizontal predictor
    'rgb-oldlzw': '528738c07a1d81ee4b7e78cb90ca63da67b15a8f39f16715fc980729f3cdd2c9', // LZW of libtiff before 5.0
    'l32': '16297996850e2361bf2d6e630efa25e25e44fc624880897e684979647caf906a', // 32-bit unsigned greyscale
    'bw-fillorder2': 'bddeb89fcf5946ab3da243b483b3518f193ef3823cb22ec2f743a7315193d6fa', // 1-bit, least significant bit first
    'bw-tiles12': 'bddeb89fcf5946ab3da243b483b3518f193ef3823cb22ec2f743a7315193d6fa', // 1-bit tiles 12 pixels wide
    'l2': '45294fa9775a514f313da1bea95fa5a04a49b3e04cd46d9305010fbba87be1bb', // 2-bit greyscale
    'rgba-associated': '559d7f504ea8542d1eeb83419814dbbed411c2d00dd2aba4fbd3e68fe26153d8', // premultiplied alpha
    'f32-range': '6a62ad9bec7bd2b177a276be9ffff84f6e64ada9f1558c53de51776dacba42ba', // floats from 48.5 to 832.5, normalized
    'ycbcr-22': 'c58a333579fce2f01b1063ebc9b36ef27194b67e01e7d9abe51bc61520bad60e', // YCbCr 4:2:0, the same as libtiff
    'ycbcr-21': 'a83a7995387cdccbc6b30231018b899afb2b965bff383faac0fbe24ba6dd49ad', // YCbCr 4:2:2, the same as libtiff
    'ycbcr-11': 'aee34d2b59275f7b7571da49e2f63f64697737a0b62146816a6f3247225ac5b2', // YCbCr 4:4:4, within 1 of libtiff's tables
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
