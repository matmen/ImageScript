const fs = require('fs').promises;
const crypto = require('crypto');
const {Image} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

// what cjxl -e 1 writes (scripts/jxl-lossless-references.py): on CPUs with AVX2 or NEON (chunks of 16 pixels, what
// encodeJXL writes), and without SIMD (chunks of 8)
const references = {
    16: {
        'external.png': '58a26107a26d63d1a4e38aae9143c23072d1ccb627035c6a306fcf38334d4b47',
        'circle.png': 'cef97c2ac1002fb7303dd133b77013bf38d9df094fb68cf5377f9820d165ff45',
        'readme.png': 'bf6d939ac373e8c57d86429e9935ceeac55b5bf9619782fd1e2a1111eaa0b328',
        'potato.png': 'e5f9166c9468f4477c175238aa0b422db0c785fc23349441d0bb73e0327b7fc3',
        'external.png grey': '6d127dcd6055a4c753ef4b9c0d17680efc5009c0276c2482e46e4c3622e123f3'
    },
    8: {
        'external.png': '4bf1c60af3ec0166962d34e843bed45ad93dccadd8911167a10970d530c18270',
        'circle.png': '9e50886f2f1cca31d509fc305ffcf1fa90fe80e2c0c0e53ee61f800e319cfe05',
        'readme.png': 'baa03b62a243e1c5cf8e54e8fb1a903b424893b0d3f992f8dc91017af821055f',
        'potato.png': 'd0a2806f68b4ee0cc933a1221d46855b15ca23af8a970a227a6c7a00978a8ba1',
        'external.png grey': 'e88fd972b6d54ba5a5cc9b42a1da9082ed15375e4a9076688820ee56d92d7f10'
    }
};

// the samples of the channels encodeJXL picks
const samples = image => {
    const rgba = image.bitmap, n = image.width * image.height;
    let grey = true, opaque = true;
    for (let i = 0; i < 4 * n; i += 4) {
        if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) grey = false;
        if (rgba[i + 3] !== 255) opaque = false;
    }
    const channels = [0, ...(grey ? [] : [1, 2]), ...(opaque ? [] : [3])], px = new Uint8Array(n * channels.length);
    for (let i = 0, k = 0; i < n; i++) for (const c of channels) px[k++] = rgba[4 * i + c];
    return [px, channels.length];
};

// the codestream of a container: the content of its last box, jxlc
const codestream = jxl => {
    let o = 0;
    while (o + Buffer.from(jxl).readUInt32BE(o) < jxl.length) o += Buffer.from(jxl).readUInt32BE(o);
    return jxl.subarray(o + 8);
};

(async () => {
    const {encode} = await import('../dist/codecs/jxl/fast-lossless.js');
    for (const [name, grey] of [['external.png'], ['circle.png'], ['readme.png'], ['potato.png'], ['external.png', true]]) {
        const key = name + (grey ? ' grey' : '');
        const image = await Image.decode(await fs.readFile(`./tests/targets/${name}`));
        // (grey: the red channel)
        if (grey) for (let i = 0; i < image.bitmap.length; i += 4) image.bitmap[i + 1] = image.bitmap[i + 2] = image.bitmap[i];
        const jxl = await image.encodeJXL();
        if (sha256(codestream(jxl)) !== references[16][key]) panic(`${key}: not what cjxl -e 1 writes`);
        const [px, channels] = samples(image);
        if (sha256(encode(px, image.width, image.height, channels, 8)) !== references[8][key]) panic(`${key}: not what cjxl -e 1 writes without SIMD`);
        const decoded = await Image.decode(jxl);
        if (Buffer.compare(Buffer.from(decoded.bitmap), Buffer.from(image.bitmap)) !== 0) panic(`${key}: not lossless`);
    }

    // two colors of the same hash in the palette detection's chunk of 8 pixels (libjxl misses that, losing a color)
    const image = new Image(16, 16).fill(0xc86432ff);
    image.setPixelAt(1, 1, 0x010000ff);
    image.setPixelAt(2, 1, 0x76c500ff);
    const decoded = await Image.decode(await image.encodeJXL());
    if (decoded.getPixelAt(1, 1) !== 0x010000ff || decoded.getPixelAt(2, 1) !== 0x76c500ff) panic('colors of the same hash');
    // a pixel; transparent grey
    for (const [w, h, color] of [[1, 1, 0x123456ff], [5, 3, 0x80808040]]) {
        const small = new Image(w, h).fill(color);
        const back = await Image.decode(await small.encodeJXL());
        if (back.width !== w || back.height !== h || back.getPixelAt(0, 0) !== color) panic(`${w}x${h}: not lossless`);
    }

    // lossy: better and larger with the quality, alpha lossless (in the global stream for one group, else in the
    // groups'), sizes of several groups and partial blocks; 100 is lossless
    const psnr = (a, b) => {
        let se = 0, n = 0;
        for (let i = 0; i < a.bitmap.length; i++) if ((i & 3) !== 3) {
            se += (a.bitmap[i] - b.bitmap[i]) ** 2;
            n++;
        }
        return 10 * Math.log10(255 * 255 * n / se);
    };
    const photo = (await Image.decode(await fs.readFile('./tests/targets/external.png'))).resize(300, 211);
    let last = 0, lastPsnr = 0;
    for (const quality of [30, 75, 95]) {
        const jxl = await photo.encodeJXL({quality});
        const p = psnr(photo, await Image.decode(jxl));
        if (jxl.length <= last || p <= lastPsnr) panic(`quality ${quality}: not larger and better (${jxl.length} B, ${p.toFixed(2)} dB)`);
        if (p < {30: 29, 75: 32, 95: 38.5}[quality]) panic(`quality ${quality}: ${p.toFixed(2)} dB`);
        last = jxl.length;
        lastPsnr = p;
    }
    for (const [w, h] of [[300, 211], [100, 60]]) {
        const image = photo.clone().crop(0, 0, w, h);
        for (let i = 3; i < image.bitmap.length; i += 4) image.bitmap[i] = (i >> 2) % 251;
        const back = await Image.decode(await image.encodeJXL({quality: 90}));
        for (let i = 3; i < image.bitmap.length; i += 4) if (back.bitmap[i] !== image.bitmap[i]) panic(`${w}x${h}: lossy alpha`);
    }
    const pixel = await Image.decode(await new Image(1, 1).fill(0x336699ff).encodeJXL({quality: 90}));
    if (pixel.width !== 1 || Math.abs((pixel.getPixelAt(0, 0) >>> 24) - 0x33) > 2) panic('1x1 lossy');
    const lossless = await Image.decode(await photo.encodeJXL({quality: 100}));
    if (Buffer.compare(Buffer.from(lossless.bitmap), Buffer.from(photo.bitmap))) panic('quality 100 isn\'t lossless');
    for (const quality of [-1, 101, NaN]) if (!await photo.encodeJXL({quality}).then(() => false, e => e instanceof RangeError)) panic(`quality ${quality} should throw`);
})();
