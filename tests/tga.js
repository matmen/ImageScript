const {Image, ImageType} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

// builds a TGA: header fields, optional color map, pixel data
function tga({type, depth, width, height, descriptor = 0, map = null, mapFirst = 0, mapDepth = 0, id = []}, data) {
    const header = [id.length, map ? 1 : 0, type, mapFirst & 255, mapFirst >> 8, map ? map.length / (mapDepth / 8) & 255 : 0,
        map ? map.length / (mapDepth / 8) >> 8 : 0, mapDepth, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, depth, descriptor];
    return Uint8Array.from([...header, ...id, ...(map || []), ...data]);
}

const rgba = (image, x, y) => image.getRGBAAt(x, y).join();

(async () => {
    // uncompressed 24 bit, default bottom left origin: the first stored row is the bottom one
    {
        const file = tga({type: 2, depth: 24, width: 2, height: 2, id: [1, 2, 3]}, [
            0, 0, 255, 0, 255, 0, // bottom row: red, green (BGR)
            255, 0, 0, 255, 255, 255 // top row: blue, white
        ]);
        if (ImageType.getType(file) !== 'tga') panic('TGA not recognized');
        const image = await Image.decode(file);
        if (rgba(image, 0, 0) !== '0,0,255,255' || rgba(image, 1, 0) !== '255,255,255,255') panic('TGA: top row wrong');
        if (rgba(image, 0, 1) !== '255,0,0,255' || rgba(image, 1, 1) !== '0,255,0,255') panic('TGA: bottom row wrong');
    }

    // color mapped (with a first map index), top right origin
    {
        const file = tga({type: 1, depth: 8, width: 3, height: 1, descriptor: 0x30, mapFirst: 2, mapDepth: 24, map: [0, 0, 255, 0, 255, 0]}, [2, 3, 2]);
        const image = await Image.decode(file);
        if ([0, 1, 2].map(x => rgba(image, x, 0)).join(' ') !== '255,0,0,255 0,255,0,255 255,0,0,255') panic('TGA: color map wrong');
    }

    // run length encoded greyscale with alpha, packets crossing scan lines, top left origin
    {
        const file = tga({type: 11, depth: 16, width: 3, height: 2, descriptor: 0x28}, [
            0x83, 10, 255, // 4x (10, opaque)
            0x01, 20, 128, 30, 0 // raw: (20, half), (30, transparent)
        ]);
        const image = await Image.decode(file);
        const row = y => [0, 1, 2].map(x => rgba(image, x, y)).join(' ');
        if (row(0) !== '10,10,10,255 10,10,10,255 10,10,10,255' || row(1) !== '10,10,10,255 20,20,20,128 30,30,30,0') panic('TGA: RLE wrong');
    }

    // 16 bit: 5 bits per channel, the attribute bit is ignored
    {
        const image = await Image.decode(tga({type: 2, depth: 16, width: 1, height: 1, descriptor: 1}, [0x1f, 0x80]));
        if (rgba(image, 0, 0) !== '0,0,255,255') panic('TGA: 16 bit wrong');
    }

    // encoding round trips, opaque images are stored with 24 bits
    for (const image of [
        new Image(50, 7).fill((x, y) => Image.rgbaToColor(x * 5, y * 30, (x >> 2) * 40, x % 3 ? 255 : 100)),
        new Image(300, 2).fill(0x336699ff),
        new Image(1, 1).fill(0x00000000)
    ]) {
        const encoded = await image.encodeTGA();
        if (ImageType.getType(encoded) !== 'tga') panic('encoded TGA not recognized');
        const back = await Image.decode(encoded);
        if (!Buffer.from(back.bitmap).equals(Buffer.from(image.bitmap))) panic(`TGA: ${image.width}x${image.height} didn't round trip`);
    }
    const opaque = await new Image(4, 4).fill(0xff0000ff).encodeTGA();
    if (opaque[16] !== 24) panic('TGA: opaque images should be stored with 24 bits');

    // truncated data is rejected, not read past
    try {
        await Image.decode(tga({type: 10, depth: 24, width: 4, height: 4}, [0x83, 1, 2, 3]).subarray(0, 21));
        panic('TGA: truncated data accepted');
    } catch (err) {
        if (!/TGA|Unsupported/.test(err.message)) panic(`TGA: unexpected error ${err.message}`);
    }
})();
