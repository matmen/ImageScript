const fs = require('fs').promises;
const {Image, Frame, Animation} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const metadata = {creationTime: 0, software: ''};

// the incremental encoders (Animation.webpEncoder, gifEncoder, apngEncoder) make the files the Animation encoders make
(async () => {
    const frames = [];
    for (let i = 0; i < 6; i++) {
        const f = new Frame(20 + i, 15, {duration: 50 + i * 10, xOffset: i * 3, yOffset: i, disposalMode: ['keep', 'previous', 'background', 'keep', 'any', 'background'][i]});
        f.fill((x, y) => Image.rgbaToColor((x * 30 + i * 40) & 255, y * 15, i * 40, (x + y + i) % 5 ? 255 : 100));
        frames.push(f);
    }
    // offsets, every disposal, translucent pixels; a decoded GIF
    const synthetic = new Animation([new Frame(40, 30, {duration: 20}).fill(0x203040ff), ...frames], 2);
    const decoded = await Animation.decode(await fs.readFile('./tests/targets/gif.gif'));

    for (const [name, animation] of [['synthetic', synthetic], ['gif.gif', decoded]])
        for (const optimize of [true, false])
            for (const [format, options, reference] of [
                ['gif', {}, a => a.encodeGIF({optimize, metadata})],
                ['webp', {}, a => a.encodeWebP({optimize, metadata})],
                ['webp', {quality: 80}, a => a.encodeWebP({optimize, metadata, quality: 80})],
                ['apng', {}, a => a.encodeAPNG({optimize, metadata})]]) {
                const encoder = Animation[`${format}Encoder`](animation.width, animation.height, {...options, optimize, metadata, loopCount: animation.loopCount});
                for (const frame of animation) await encoder.add(frame);
                if (encoder.frames !== animation.length) panic(`${name} ${format}: ${encoder.frames} frames added`);
                const file = await encoder.finish(), expected = await reference(animation);
                if (equal(file, expected)) continue;
                // unoptimized WebPs with frames disposed to the previous one: the frames from there on show the canvas,
                // the animation looks the same (blending rounds by 1 at most, lossy frames differ by their encoding)
                if (format !== 'webp' || optimize || name !== 'synthetic') panic(`${name} ${format} ${JSON.stringify(options)} (optimize ${optimize}): not the same file`);
                const a = await Animation.decode(file), b = await Animation.decode(expected);
                const differs = (f, g) => options.quality === undefined ? f.bitmap.some((v, k) => Math.abs(v - g.bitmap[k]) > 1)
                    : f.bitmap.reduce((sum, v, k) => sum + Math.abs(v - g.bitmap[k]), 0) / f.bitmap.length > 4;
                if (a.length !== b.length || a.some((f, i) => f.duration !== b[i].duration || differs(f, b[i])))
                    panic(`${name} ${format} ${JSON.stringify(options)}: doesn't show the same animation`);
            }

    // images with options, options overriding a frame's, the pixels copied when added
    {
        const image = new Image(8, 8).fill(0xff0000ff);
        const encoder = Animation.apngEncoder(8, 8, {metadata});
        const added = encoder.add(image, {duration: 70});
        image.fill(0x00ff00ff);
        await added;
        await encoder.add(new Frame(4, 4, {duration: 10}).fill(0x0000ffff), {duration: 30, xOffset: 2, yOffset: 2});
        const file = await encoder.finish();
        const expected = await new Animation([Frame.from(new Image(8, 8).fill(0xff0000ff), {duration: 70}),
            new Frame(4, 4, {duration: 30, xOffset: 2, yOffset: 2}).fill(0x0000ffff)]).encodeAPNG({metadata});
        if (!equal(file, expected)) panic('images and options: not the same file');
    }

    // errors
    const rejects = async (name, f) => {
        let error = null;
        try { await f(); } catch (err) { error = err; }
        if (!error) panic(`${name} should throw`);
    };
    await rejects('no frames', () => Animation.webpEncoder(4, 4).finish());
    await rejects('an invalid canvas', () => Animation.gifEncoder(0, 4));
    await rejects('an invalid quality', () => Animation.webpEncoder(4, 4, {quality: 101}));
    await rejects('an invalid duration', () => Animation.gifEncoder(4, 4).add(new Image(4, 4), {duration: -1}));
    await rejects('not an image', () => Animation.gifEncoder(4, 4).add({width: 4, height: 4}));
    const finished = Animation.gifEncoder(4, 4);
    await finished.add(new Image(4, 4));
    await finished.finish();
    await rejects('adding after finishing', () => finished.add(new Image(4, 4)));
    await rejects('finishing twice', () => finished.finish());
})();
