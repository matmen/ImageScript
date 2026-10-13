const fs = require('fs').promises;
const {Frame, GIF} = require('../ImageScript');

const panic = message => {
    console.error(message);
    process.exit(1);
};

(async () => {
    const frames = [];
    for (let i = 0; i < 30; i++) {
        const frame = new Frame(256, 256);
        frame.fill(x => Frame.hslToColor(x / frame.width + i / 30, 1, 0.5));
        frames.push(frame);
    }

    const gif = new GIF(frames);

    if (process.env.OVERWRITE_TEST)
        await fs.writeFile('./tests/targets/gif.gif', await gif.encode(1));

    {
        const binary = await fs.readFile('./tests/targets/gif.gif');
        const decoded = await GIF.decode(binary);
        if (decoded.width !== gif.width)
            panic('decode: incorrect width');
        if (decoded.height !== gif.height)
            panic('decode: incorrect height');
        if (decoded.length !== gif.length)
            panic('decode: incorrect frame count');

        for (let i = 0; i < gif.length; i++) {
            if (gif[i].bitmap.length !== decoded[i].bitmap.length)
                panic('decode: incorrect frame bitmap length');
        }

        const first = await GIF.decode(binary, true);
        if (first.length !== 1)
            panic('decode: onlyExtractFirstFrame returned more than one frame');
    }

    {
        // frames with <= 256 colors survive a roundtrip losslessly
        const decoded = await GIF.decode(await gif.encode());
        for (let i = 0; i < gif.length; i++)
            if (!Buffer.from(decoded[i].bitmap).equals(Buffer.from(gif[i].bitmap)))
                panic(`roundtrip: frame ${i} differs`);
        if (decoded[0].duration !== gif[0].duration)
            panic('roundtrip: incorrect duration');
        if (decoded.loopCount !== -1)
            panic('roundtrip: incorrect loop count');
    }

    {
        // offsets, transparency, disposal modes and finite loop counts
        const black = Frame.rgbaToColor(0, 0, 0, 255);
        const white = Frame.rgbaToColor(255, 255, 255, 255);

        const background = new Frame(4, 4, 100);
        background.fill(black);
        const dot = new Frame(1, 1, 100, 1, 1, Frame.DISPOSAL_PREVIOUS);
        dot.fill(white);
        const hole = new Frame(2, 2, 100, 2, 2, Frame.DISPOSAL_BACKGROUND);
        hole.fill((x, y) => x === y ? white : 0);
        const last = new Frame(1, 1, 100, 0, 0);
        last.fill(white);

        const decoded = await GIF.decode(await new GIF([background, dot, hole, last], 2).encode());
        if (decoded.loopCount !== 2)
            panic('disposal: incorrect loop count');

        const expect = (frame, pixels) => {
            for (let y = 0; y < 4; y++)
                for (let x = 0; x < 4; x++) {
                    const want = pixels[y * 4 + x];
                    const got = decoded[frame].getPixelAt(x, y);
                    if (want === 'B' ? got !== black : want === 'W' ? got !== white : got !== 0)
                        panic(`disposal: frame ${frame} pixel ${x},${y} is ${got.toString(16)}`);
                }
        };

        expect(0, 'BBBBBBBBBBBBBBBB');
        expect(1, 'BBBBBWBBBBBBBBBB'); // dot is restored afterwards
        expect(2, 'BBBBBBBBBBWBBBBW'); // transparent pixels keep the background
        expect(3, 'WBBBBBBBBB__BB__'); // hole is cleared to transparent
    }
})();
