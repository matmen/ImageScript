/*
 Fonts sourced from:
 https://www.1001fonts.com/carbon-font.html
 https://www.1001fonts.com/ethnocentric-font.html
 https://github.com/adobe-fonts/source-sans (SIL OFL, see OFL-SourceSans3.md)
 */

const fs = require('fs').promises;
const {Image, TextLayout} = require('..');

const panic = message => {
    console.error(message);
    process.exit(1);
};

(async () => {
    {
        const font = await Image.renderText(await fs.readFile('./tests/fonts/carbon phyber.ttf'), 128, 'ThE qUiCk');
        const encoded = await font.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/font-1.png', encoded);

        const desired = await fs.readFile('./tests/targets/font-1.png');
        if (!desired.equals(Buffer.from(encoded))) panic('font 1 doesn\'t match');
    }

    {
        const font = await Image.renderText(await fs.readFile('./tests/fonts/ethnocentric rg.ttf'), 128, 'BrOwN fOx');
        const encoded = await font.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/font-2.png', encoded);

        const desired = await fs.readFile('./tests/targets/font-2.png');
        if (!desired.equals(Buffer.from(encoded))) panic('font 2 doesn\'t match');
    }

    {
        const font = await Image.renderText(await fs.readFile('./tests/fonts/opensans bold.ttf'), 128, 'Extra\n-Test\nnewline');
        const encoded = await font.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/font-3.png', encoded);

        const desired = await fs.readFile('./tests/targets/font-3.png');
        if (!desired.equals(Buffer.from(encoded))) panic('font 3 doesn\'t match');
    }

    {
        // OpenType font with CFF outlines
        const font = await Image.renderText(await fs.readFile('./tests/fonts/sourcesans3 regular.otf'), 64, 'Quartz glyph job, vex!');
        const encoded = await font.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/font-4.png', encoded);

        const desired = await fs.readFile('./tests/targets/font-4.png');
        if (!desired.equals(Buffer.from(encoded))) panic('font 4 doesn\'t match');
    }

    {
        const font = await fs.readFile('./tests/fonts/opensans bold.ttf');
        const render = (text, options) => Image.renderText(font, 40, text, 0xffffffff, new TextLayout(options));
        // first column with ink in the given row
        const inkStart = (image, y) => {
            for (let x = 0; x < image.width; x++)
                if (image.getPixelAt(x, y) & 0xff) return x;
            return -1;
        };

        // line metrics match the previous (fontdue based) renderer, glyphs are placed with subpixel precision
        const single = await render('Hi');
        if (single.width !== 40 || single.height !== 55) panic(`layout: unexpected size ${single.width}x${single.height}`);

        // alignment is relative to the widest line
        const left = await render('Hi\nHello there');
        const center = await render('Hi\nHello there', {horizontalAlign: 'center'});
        const right = await render('Hi\nHello there', {verticalAlign: 'right'}); // pre 3.0 option name
        const row = 30;
        if (!(inkStart(left, row) < inkStart(center, row) && inkStart(center, row) < inkStart(right, row)))
            panic('layout: horizontal alignment has no effect');

        // kerning pulls 'To' together (without it, the pair is wider than both glyphs' ink)
        const big = text => Image.renderText(font, 200, text);
        if ((await big('To')).width > (await big('T')).width + (await big('o')).width - 5) panic('layout: kerning has no effect');

        // wrapping
        const word = await render('Hello world foo bar', {maxWidth: 160});
        const char = await render('Hello world foo bar', {maxWidth: 160, wrapStyle: 'char'});
        if (word.height !== 3 * 55 || word.width > 160) panic('layout: word wrapping failed');
        if (char.width > 160 || char.width <= word.width) panic('layout: char wrapping failed');

        // maxHeight keeps whole lines, chosen by the vertical alignment
        const top = await render('one\ntwo\nthree\nfour\nfive', {maxHeight: 120});
        const bottom = await render('one\ntwo\nthree\nfour\nfive', {maxHeight: 120, verticalAlign: 'bottom'});
        if (top.height !== 110 || bottom.height !== 110) panic('layout: maxHeight failed');
        if (Buffer.from(top.bitmap).equals(Buffer.from(bottom.bitmap))) panic('layout: vertical alignment has no effect');
    }
})();
