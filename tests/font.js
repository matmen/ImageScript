/*
 Fonts sourced from:
 https://www.1001fonts.com/carbon-font.html
 https://www.1001fonts.com/ethnocentric-font.html
 https://github.com/adobe-fonts/source-sans (SIL OFL, see OFL-SourceSans3.md)
 */

const fs = require('fs').promises;
const {Image, TextLayout} = require('..');
const samePixels = require('./util/pixels');

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
        if (!await samePixels(desired, encoded)) panic('font 1 doesn\'t match');
    }

    {
        const font = await Image.renderText(await fs.readFile('./tests/fonts/ethnocentric rg.ttf'), 128, 'BrOwN fOx');
        const encoded = await font.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/font-2.png', encoded);

        const desired = await fs.readFile('./tests/targets/font-2.png');
        if (!await samePixels(desired, encoded)) panic('font 2 doesn\'t match');
    }

    {
        const font = await Image.renderText(await fs.readFile('./tests/fonts/opensans bold.ttf'), 128, 'Extra\n-Test\nnewline');
        const encoded = await font.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/font-3.png', encoded);

        const desired = await fs.readFile('./tests/targets/font-3.png');
        if (!await samePixels(desired, encoded)) panic('font 3 doesn\'t match');
    }

    {
        // OpenType font with CFF outlines
        const font = await Image.renderText(await fs.readFile('./tests/fonts/sourcesans3 regular.otf'), 64, 'Quartz glyph job, vex!');
        const encoded = await font.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/font-4.png', encoded);

        const desired = await fs.readFile('./tests/targets/font-4.png');
        if (!await samePixels(desired, encoded)) panic('font 4 doesn\'t match');
    }

    {
        const font = await fs.readFile('./tests/fonts/opensans bold.ttf');
        // (unhinted: the layout places glyphs with subpixel precision)
        const render = (text, options) => Image.renderText(font, 40, text, 0xffffffff, new TextLayout(options), {hinting: false});
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
        const big = text => Image.renderText(font, 200, text, 0xffffffff, undefined, {hinting: false});
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
    // TrueType hinting (#31): hinted outlines match FreeType's (v35 interpreter) point for point
    {
        const {Font} = await import('../dist/render/font.js');
        const {Hinter} = await import('../dist/render/hinting.js');
        // 26.6 coordinates and advances from FreeType
        const expected = {"opensans bold.ttf":{"11:H":{"advance":512,"points":[[448,0],[342,0],[342,231],[170,231],[170,0],[63,0],[63,512],[170,512],[170,320],[342,320],[342,512],[448,512]]},"11:a":{"advance":448,"points":[[322,0],[302,59],[299,59],[270,26],[209,0],[160,0],[99,0],[30,66],[30,127],[30,190],[124,251],[218,254],[291,256],[291,267],[291,306],[226,306],[175,306],[107,278],[69,349],[139,384],[225,384],[307,384],[395,318],[395,251],[395,0],[291,195],[243,194],[190,192],[137,159],[137,125],[137,77],[197,77],[240,77],[291,123],[291,161]]},"11:g":{"advance":384,"points":[[375,384],[375,331],[316,315],[332,288],[332,255],[332,195],[249,128],[176,128],[159,129],[145,131],[131,119],[131,105],[131,84],[186,84],[248,84],[308,84],[371,24],[371,-35],[371,-110],[263,-192],[161,-192],[84,-192],[2,-128],[2,-70],[2,-31],[45,23],[87,34],[71,41],[46,71],[46,87],[46,108],[71,136],[94,150],[65,163],[31,219],[31,257],[31,317],[109,384],[182,384],[198,384],[240,384],[246,384],[93,-64],[93,-92],[132,-124],[166,-124],[219,-124],[278,-84],[278,-49],[278,-21],[243,0],[206,0],[156,0],[129,0],[93,-35],[131,255],[131,226],[156,192],[182,192],[208,192],[232,226],[232,255],[232,320],[182,320],[131,320]]},"16:e":{"advance":576,"points":[[297,467],[255,467],[207,390],[204,320],[389,320],[388,390],[339,467],[316,0],[189,0],[46,148],[46,284],[46,423],[179,576],[296,576],[407,576],[532,429],[532,299],[532,218],[201,218],[203,169],[269,114],[328,114],[374,114],[456,130],[501,147],[501,37],[463,18],[378,0]]},"16:&":{"advance":768,"points":[[768,0],[580,0],[522,57],[427,0],[306,0],[184,0],[41,109],[41,202],[41,269],[102,363],[175,404],[137,450],[103,535],[103,585],[103,668],[220,768],[317,768],[410,768],[522,675],[522,597],[522,533],[453,427],[376,379],[518,243],[553,298],[579,384],[738,384],[720,318],[657,192],[617,144],[202,217],[202,176],[266,128],[317,128],[380,128],[430,157],[264,313],[235,292],[202,247],[381,583],[381,614],[345,650],[316,650],[283,650],[244,612],[244,578],[244,526],[292,464],[335,492],[381,547]]}},"ethnocentric rg.ttf":{"12:R":{"advance":768,"points":[[777,0],[564,0],[450,128],[206,128],[206,0],[47,0],[47,260],[494,260],[531,260],[581,291],[581,319],[581,349],[535,380],[494,380],[47,380],[151,512],[481,512],[525,512],[618,496],[695,453],[745,382],[745,325],[745,295],[727,240],[692,197],[642,166],[611,160],[624,150],[656,121],[683,95]]},"12:S":{"advance":768,"points":[[525,320],[619,320],[717,248],[717,174],[717,134],[693,68],[639,24],[555,0],[497,0],[18,0],[121,132],[509,132],[538,132],[564,145],[564,160],[564,175],[538,188],[509,188],[230,188],[180,188],[108,211],[60,251],[37,309],[37,344],[37,382],[62,444],[115,488],[199,512],[257,512],[703,512],[601,380],[245,380],[217,380],[190,367],[190,350],[190,334],[217,320],[245,320]]}}};

        for (const [file, glyphs] of Object.entries(expected)) {
            const font = new Font(await fs.readFile(`./tests/fonts/${file}`));
            const hinter = new Hinter(font);
            for (const [key, {advance, points}] of Object.entries(glyphs)) {
                const [size, char] = key.split(':');
                const hinted = hinter.glyph(font.glyphIndex(char.codePointAt(0)), +size);
                if (!hinted) panic(`hinting ${file} ${key}: not hinted`);
                if (hinted.advance * 64 !== advance) panic(`hinting ${file} ${key}: advance ${hinted.advance * 64}, expected ${advance}`);
                // the path's on and off curve points in contour order: compare them as a set
                const ours = new Set();
                for (const command of hinted.path)
                    for (let i = 1; i < command.length; i += 2) ours.add(`${Math.round(command[i] * 64)},${Math.round(command[i + 1] * 64)}`);
                for (const [x, y] of points)
                    if (!ours.has(`${x},${y}`)) panic(`hinting ${file} ${key}: point ${x},${y} missing`);
            }
        }

        // rendering: hinted glyphs sit on whole pixels, so repeated letters look identical (without hinting they are
        // placed with subpixel precision and differ), and there are fewer blurry pixels
        const data = await fs.readFile('./tests/fonts/opensans bold.ttf');
        const blurry = image => {
            let count = 0;
            for (let i = 3; i < image.bitmap.length; i += 4) if (image.bitmap[i] > 20 && image.bitmap[i] < 235) count++;
            return count;
        };
        // the alpha of each column, as a string per column
        const columns = image => Array.from({length: image.width}, (_, x) => Array.from({length: image.height}, (_, y) => image.getRGBAAt(x, y)[3]).join());
        const repeats = image => {
            const cols = columns(image).filter(c => c.split(',').some(v => +v));
            return new Set(cols).size;
        };
        const plain = await Image.renderText(data, 11, 'lllll', 0x000000ff, undefined, {hinting: false});
        const hinted = await Image.renderText(data, 11, 'lllll', 0x000000ff);
        if (repeats(hinted) >= repeats(plain)) panic(`hinting: repeated glyphs should render identically (${repeats(hinted)} vs ${repeats(plain)} distinct columns)`);
        const word = await Image.renderText(data, 11, 'Hamburg', 0x000000ff);
        if (blurry(word) >= blurry(await Image.renderText(data, 11, 'Hamburg', 0x000000ff, undefined, {hinting: false}))) panic('hinting: text should be crisper');

        // fonts without TrueType instructions (CFF, or TrueType without them) render as without hinting
        for (const file of ['sourcesans3 regular.otf', 'carbon phyber.ttf']) {
            const font = await fs.readFile(`./tests/fonts/${file}`);
            const on = await Image.renderText(font, 11, 'Hamburg', 0x000000ff);
            const off = await Image.renderText(font, 11, 'Hamburg', 0x000000ff, undefined, {hinting: false});
            if (!Buffer.from(on.bitmap).equals(Buffer.from(off.bitmap))) panic(`hinting: ${file} has no instructions and should render unchanged`);
        }
    }
})();
