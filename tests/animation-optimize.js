const {Image, Frame, Animation} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

// what an animation shows: its composited frames, consecutive identical ones merged (transparent pixels compare equal
// whatever their color)
async function timeline(animation) {
    const decoded = animation instanceof Animation ? animation : await Animation.decode(animation);
    const result = [];
    for (const frame of decoded) {
        const pixels = Buffer.from(frame.bitmap);
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] === 0) pixels.fill(0, i, i + 4);
        const last = result[result.length - 1];
        if (last && last.pixels.equals(pixels)) last.duration += frame.duration;
        else result.push({pixels, duration: frame.duration});
    }
    return result;
}

// the input animation's composited frames, as APNG decoders composite them (blending "over", disposal)
async function composite(animation) {
    const png = await import('../dist/codecs/png.js');
    const {width, height} = animation;
    const canvases = png.compositeAnimation({width, height, frames: animation.__apngFrames__()});
    return new Animation(canvases.map(({pixels, duration}) => {
        const frame = new Frame(width, height, duration);
        frame.bitmap.set(pixels);
        return frame;
    }));
}

const same = (a, b) => a.length === b.length && a.every((f, i) => f.pixels.equals(b[i].pixels) && f.duration === b[i].duration);

// GIF only has opaque and transparent pixels and a palette: compare transparency exactly, colors on average
function gifMatches(expected, actual) {
    if (expected.length !== actual.length) return `${actual.length} frames instead of ${expected.length}`;
    for (let k = 0; k < expected.length; k++) {
        const a = expected[k].pixels, b = actual[k].pixels;
        let error = 0, opaque = 0;
        for (let i = 0; i < a.length; i += 4) {
            if ((a[i + 3] >= 128) !== (b[i + 3] === 255)) return `frame ${k}: transparency differs at pixel ${i / 4}`;
            if (!b[i + 3]) continue;
            error += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
            opaque++;
        }
        if (opaque && error / opaque / 3 > 8) return `frame ${k}: colors differ by ${(error / opaque / 3).toFixed(1)} on average`;
    }
    return null;
}

async function check(name, animation) {
    const expected = await timeline(await composite(animation));
    for (const format of ['APNG', 'WebP']) {
        const actual = await timeline(await animation[`encode${format}`]());
        if (!same(expected, actual)) panic(`${name}: ${format} doesn't show the same animation`);
    }
    // GIF: opaque/transparent only, compare with the animation's transparency rounded (gifMatches)
    const error = gifMatches(expected, await timeline(await animation.encodeGIF()));
    if (error) panic(`${name}: GIF ${error}`);
}

// an antialiased disc
const disc = (size, color) => new Image(size, size).fill((x, y) => {
    const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) - size / 2 + 1;
    return d <= 0 ? color : d >= 1 ? 0 : (color & ~255) | Math.round((1 - d) * (color & 255));
});

(async () => {
    // a sticker: an antialiased disc moving over a transparent background (pixels become transparent again)
    await check('moving sticker', new Animation(Array.from({length: 8}, (_, i) =>
        Frame.from(new Image(48, 32).composite(disc(16, 0xff8800ff), i * 4, 4 + (i & 1)), 60))));

    // fading out: pixels get more transparent
    await check('fade out', new Animation(Array.from({length: 6}, (_, i) =>
        Frame.from(new Image(20, 20).drawBox(4, 4, 12, 12, 0x3366ff00 | 255 - i * 50), 100))));

    // frames with offsets and disposal modes, odd offsets (WebP stores them halved)
    await check('offsets and disposal', new Animation([
        Frame.from(new Image(30, 30).fill(0x202020ff), 100),
        new Frame(5, 7, 100, 3, 9, 'previous').fill(0xff0000ff),
        new Frame(9, 3, 100, 11, 1, 'background').fill(0x00ff0080),
        new Frame(4, 4, 100, 21, 21, 'keep').fill(0x0000ffff),
        new Frame(30, 30, 100, 0, 0, 'background').fill(0),
        new Frame(1, 1, 100, 29, 29).fill(0xffffffff)
    ]));

    // a frame that only clears: GIF can't blend pixels to transparent, the frame before clears its area instead
    await check('cleared frame', new Animation([
        Frame.from(new Image(12, 12).drawBox(2, 2, 6, 6, 0xff0000ff), 100, 0, 0, 'background'),
        new Frame(12, 12, 100),
        Frame.from(new Image(12, 12).drawBox(4, 4, 6, 6, 0x00ff00ff), 100)
    ]));

    // an empty first frame, and identical frames, which become one with their durations added up (the empty last
    // frame doesn't clear the canvas, so it shows the same too)
    {
        const dot = Frame.from(new Image(10, 10).setPixelAt(5, 5, 0xffffffff), 100);
        const animation = new Animation([new Frame(10, 10, 40), dot, dot.clone(), Frame.from(dot, 25), new Frame(10, 10, 30)]);
        await check('empty and identical frames', animation);
        const decoded = await Animation.decode(await animation.encodeAPNG());
        if (decoded.length !== 2 || decoded[0].duration !== 40 || decoded[1].duration !== 255) panic(`identical frames: ${decoded.length} frames, durations ${Array.from(decoded, f => f.duration)}`);
    }

    // an opaque animation whose frames are smaller sparse, but not by enough to pay for an alpha channel in every APNG
    // frame: they're filled in again
    {
        const background = new Image(40, 20).fill((x, y) => Image.rgbaToColor(y * 6, 100, 200 - y * 4, 255));
        const animation = new Animation(Array.from({length: 6}, (_, i) => Frame.from(background.clone()
            .drawBox(1, 1, 6, 6, Image.rgbaToColor(255, i * 40, 0, 255))
            .drawBox(32, 13, 6, 6, Image.rgbaToColor(0, 255, i * 40, 255)), 100)));
        await check('opaque animation', animation);
        // with transparency for free, the frames are sparse; with an alpha channel that costs as much as RGBA instead of RGB
        // (APNG), they're filled in
        if (!animation.__optimized__({replace: true, even: false, alpha: () => 1}).slice(1).every(f => f.blend)) panic('opaque animation: expected sparse frames');
        if (animation.__optimized__({replace: true, even: false, alpha: () => 4 / 3}).some(f => f.blend)) panic('opaque animation: frames weren\'t filled in');
    }

    // a GIF frame stays dense when its colors fill the palette and its sparse pixels wouldn't fit (they'd need one more
    // color for the unchanged pixels): it stays lossless. The blocks around the center change color, the center doesn't
    {
        const color = index => Image.rgbaToColor(index, 255 - index, index * 37 & 255, 255);
        // 24×24 blocks: the ring around the center has all 256 colors in turn, the center some of them
        const ring = (i, j) => i < 4 || i > 19 || j < 4 || j > 19;
        const grid = shift => {
            const blocks = [];
            for (let j = 0, k = 0; j < 24; j++) for (let i = 0; i < 24; i++) blocks.push(ring(i, j) ? (k++ + shift) & 255 : (i * 7 + j * 13) & 255);
            return new Image(96, 96).fill((x, y) => color(blocks[(y >> 2) * 24 + (x >> 2)]));
        };
        const animation = new Animation([Frame.from(grid(0), 100), Frame.from(grid(1), 100)]);
        const decoded = await Animation.decode(await animation.encodeGIF());
        decoded.forEach((frame, i) => {
            if (frame.bitmap.some((v, k) => v !== animation[i].bitmap[k])) panic(`palette: GIF frame ${i} lost colors`);
        });
    }

    // optimize: false stores the frames as they are: same animation, but no frames merged or cut
    {
        const dot = Frame.from(new Image(10, 10).setPixelAt(5, 5, 0xffffffff), 100);
        const animation = new Animation([new Frame(10, 10, 40), dot, dot.clone(), new Frame(4, 4, {duration: 30, xOffset: 3, yOffset: 1}).fill(0xff0000ff)]);
        for (const format of ['GIF', 'APNG', 'WebP']) {
            const plain = await Animation.decode(await animation[`encode${format}`]({optimize: false}));
            if (plain.length !== 4) panic(`optimize false: ${format} has ${plain.length} frames instead of 4`);
            const expected = await composite(animation);
            if (format === 'APNG' && plain.some((f, i) => f.bitmap.some((v, k) => v !== expected[i].bitmap[k]))) panic('optimize false: APNG frames differ');
        }
        await check('optimize false', animation);
    }

    // a mostly static animation (like a screen recording) only stores what changes
    {
        const background = new Image(160, 120).fill((x, y) => Image.rgbaToColor(x * 7 ^ y * 13, x * y, y * 5, 255));
        const animation = new Animation(Array.from({length: 20}, (_, i) =>
            Frame.from(background.clone().drawBox(10 + i * 6, 50, 8, 8, 0xffffffff), 50)));
        await check('screen recording', animation);
        const still = (await background.encode()).length;
        for (const format of ['APNG', 'WebP', 'GIF']) {
            const size = (await animation[`encode${format}`]()).length;
            if (size > 3 * (format === 'GIF' ? (await new Animation([Frame.from(background)]).encodeGIF()).length : still))
                panic(`screen recording: ${format} is ${size} bytes, the changes aren't stored alone`);
        }
    }
})();
