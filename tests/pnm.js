const {Image, ImageType} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const ascii = text => Uint8Array.from(text, c => c.charCodeAt(0));
const bytes = (header, data) => Uint8Array.from([...ascii(header), ...data]);
const pixels = image => Array.from({length: image.width * image.height}, (_, i) => Array.from(image.bitmap.subarray(i * 4, i * 4 + 4)).join()).join(' ');

(async () => {
    const check = async (name, data, width, height, want) => {
        if (ImageType.getType(data) !== 'pnm') panic(`${name}: not detected as Netpbm`);
        const image = await Image.decode(data);
        if (image.width !== width || image.height !== height) panic(`${name}: ${image.width}x${image.height} instead of ${width}x${height}`);
        if (pixels(image) !== want) panic(`${name}: ${pixels(image)} instead of ${want}`);
    };
    const W = '255,255,255,255', B = '0,0,0,255';

    // plain formats with comments, PBM digits without whitespace between them
    await check('P1', ascii('P1\n# comment\n3 2\n010\n1 1\n0'), 3, 2, [W, B, W, B, B, W].join(' '));
    await check('P2', ascii('P2 2 2 # comment\n 10\n0 5\n10 3\n'), 2, 2, '0,0,0,255 128,128,128,255 255,255,255,255 77,77,77,255');
    await check('P3', ascii('P3\n2 1\n255\n255 0 0  0 0 255\n'), 2, 1, '255,0,0,255 0,0,255,255');
    // raw: a PBM row 10 pixels wide, 16 bit PGM (big endian), PPM
    await check('P4', bytes('P4\n10 2\n', [0b10100000, 0b01000000, 0b00000000, 0b11000000]), 10, 2,
        [B, W, B, W, W, W, W, W, W, B, W, W, W, W, W, W, W, W, B, B].join(' '));
    await check('P5', bytes('P5\n2 1\n65535\n', [0xff, 0xff, 0x80, 0x00]), 2, 1, '255,255,255,255 128,128,128,255');
    await check('P6', bytes('P6\n1 2\n255\n', [1, 2, 3, 4, 5, 6]), 1, 2, '1,2,3,255 4,5,6,255');
    // PAM: greyscale with alpha, RGB with alpha, BLACKANDWHITE (1 is white, unlike PBM)
    await check('P7 GRAYSCALE_ALPHA', bytes('P7\nWIDTH 2\nHEIGHT 1\nDEPTH 2\nMAXVAL 255\nTUPLTYPE GRAYSCALE_ALPHA\nENDHDR\n', [10, 20, 30, 40]), 2, 1, '10,10,10,20 30,30,30,40');
    await check('P7 RGB_ALPHA', bytes('P7\n# comment\nWIDTH 1\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n', [1, 2, 3, 4]), 1, 1, '1,2,3,4');
    await check('P7 BLACKANDWHITE', bytes('P7\nWIDTH 2\nHEIGHT 1\nDEPTH 1\nMAXVAL 1\nTUPLTYPE BLACKANDWHITE\nENDHDR\n', [0, 1]), 2, 1, `${B} ${W}`);

    // PFM: linear floats to sRGB, rows from the bottom up, little endian for a negative scale, clamped to 0..1
    const floats = (values, little) => {
        const view = new DataView(new ArrayBuffer(values.length * 4));
        values.forEach((v, i) => view.setFloat32(i * 4, v, little));
        return new Uint8Array(view.buffer);
    };
    await check('PF', bytes('PF\n2 1\n-1.0\n', floats([1, 0.5, 0.2, 2, -1, 0], true)), 2, 1, '255,188,124,255 255,0,0,255');
    await check('Pf', bytes('Pf\n1 2\n1.0\n', floats([0.2, 1], false)), 1, 2, '255,255,255,255 124,124,124,255');
    // brighter than white: tone mapped (the brightest pixel is white, 0.5 becomes 0.5 (1 + 0.5 / 16) / 1.5), or clamped
    await check('Pf tone mapped', bytes('Pf\n2 1\n-1.0\n', floats([4, 0.5], true)), 2, 1, '255,255,255,255 158,158,158,255');
    if (pixels(await Image.decode(bytes('Pf\n2 1\n-1.0\n', floats([4, 0.5], true)), {toneMapping: 'clamp'})) !== '255,255,255,255 188,188,188,255') panic('PFM: clamping doesn\'t match');

    // XV thumbnails (P7 332) aren't PAM
    if (ImageType.getType(ascii('P7 332\n#XVVERSION:Version 2.28\n')) !== null) panic('XV thumbnails detected as PAM');
    // truncated and invalid data throws
    for (const data of [bytes('P6\n2 2\n255\n', [1, 2, 3]), ascii('P2\n2 1\n255\n0 256\n'), ascii('P5\n0 1\n255\n')]) {
        if (!await Image.decode(data).then(() => false, e => /Netpbm/.test(e.message))) panic(`invalid data accepted: ${String.fromCharCode(...data.subarray(0, 12))}`);
    }

    // encoding: PBM for black and white, PGM for greyscale, PPM, PAM with alpha
    const cases = [
        [new Image(13, 5).fill((x, y) => (x + y) & 1 ? 0xffffffff : 0x000000ff), 'P4'],
        [new Image(15, 4).fill((x, y) => Image.rgbaToColor(x * 17, x * 17, x * 17, 255)), 'P5'],
        [new Image(7, 3).fill((x, y) => Image.rgbaToColor(x * 30, y * 80, 7, 255)), 'P6'],
        [new Image(5, 2).fill((x, y) => Image.rgbaToColor(x * 50, x * 50, x * 50, y * 99)), 'P7', 'GRAYSCALE_ALPHA'],
        [new Image(5, 2).fill((x, y) => Image.rgbaToColor(x * 50, 3, 9, y * 99)), 'P7', 'RGB_ALPHA'],
    ];
    for (const [image, magic, type] of cases) {
        const encoded = await image.encodePNM();
        const header = String.fromCharCode(...encoded.subarray(0, 80));
        if (!header.startsWith(magic) || (type && !header.includes(`TUPLTYPE ${type}\n`))) panic(`${image.width}x${image.height} should be ${magic} ${type || ''}`);
        const back = await Image.decode(encoded);
        if (!Buffer.from(back.bitmap).equals(Buffer.from(image.bitmap))) panic(`${magic}: ${image.width}x${image.height} didn't round trip`);
    }
})();
