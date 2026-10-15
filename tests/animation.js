const {Image, Frame, Animation, GIF} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

// what the animation looks like, frame by frame: frames are drawn over the canvas, then disposed
function expected(animation) {
    const width = animation.width, height = animation.height;
    let canvas = new Image(width, height);
    return Array.from(animation, frame => {
        const previous = canvas.clone();
        canvas.composite(frame, frame.xOffset, frame.yOffset);
        const shown = canvas.clone();
        if (frame.disposalMode === 'background') canvas.drawBox(frame.xOffset, frame.yOffset, frame.width, frame.height, 0);
        else if (frame.disposalMode === 'previous') canvas = previous;
        return shown;
    });
}

const square = (color, w, h) => new Image(w, h).fill((x, y) => (x + y) % 5 === 0 ? 0 : color);

(async () => {
    for (const variant of [0, 1]) {
        const animation = new Animation([
            Frame.from(new Image(40, 30).fill((x, y) => Image.rgbaToColor(x * 6, y * 8, 128, 255)), 100),
            Frame.from(square(0xff2040ff, 10, 8), 50, variant ? 3 : 4, variant ? 5 : 6, 'background'),
            Frame.from(square(0x20ff40ff, 12, 10), 70, 10, 10, variant ? 'previous' : 'keep'),
            Frame.from(square(0xc8374fff, 8, 8), 30, 20, 2, 'keep')
        ], 2);
        const reference = expected(animation);

        for (const format of ['APNG', 'WebP']) {
            const bytes = await animation[`encode${format}`]();
            const back = await Animation.decode(bytes);
            if (back.length !== 4 || back.loopCount !== 2) panic(`${format}: wrong frame or loop count`);
            if (back.map(f => f.duration).join() !== '100,50,70,30') panic(`${format}: wrong durations`);
            back.forEach((frame, i) => {
                if (!Buffer.from(frame.bitmap).equals(Buffer.from(reference[i].bitmap))) panic(`${format} variant ${variant}: frame ${i} differs`);
            });
        }
    }

    // a plain PNG's default image is what Image.decode returns for an APNG
    const animation = new Animation([Frame.from(new Image(8, 8).fill(0xff0000ff), 100), Frame.from(new Image(8, 8).fill(0x00ff00ff), 100)]);
    const apng = await animation.encodeAPNG();
    const still = await Image.decode(apng);
    if (still.getPixelAt(0, 0) !== 0xff0000ff) panic('APNG: the default image should be the first frame');

    // still images decode to a single frame; GIFs stay GIFs
    const single = await Animation.decode(await still.encode());
    if (single.length !== 1 || single.width !== 8) panic('Animation.decode should accept still images');
    const gif = await Animation.decode(await new GIF([Frame.from(still)]).encode());
    if (!(gif instanceof Animation) || gif.length !== 1) panic('Animation.decode should decode GIFs');
    if (!(gif.slice(0, 1) instanceof Animation)) panic('slice should keep the class');

    // loop counts: -1 forever, 0 once, n repeats
    for (const loopCount of [-1, 0, 5]) {
        const two = new Animation([Frame.from(still), Frame.from(still)], loopCount);
        for (const format of ['APNG', 'WebP', 'GIF'])
            if ((await Animation.decode(await two[`encode${format}`]())).loopCount !== loopCount) panic(`${format}: loop count ${loopCount} not kept`);
    }
})();
