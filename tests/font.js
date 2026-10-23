/*
 Fonts sourced from:
 https://www.1001fonts.com/carbon-font.html
 https://www.1001fonts.com/ethnocentric-font.html
 https://github.com/adobe-fonts/source-sans (SIL OFL, see OFL-SourceSans3.md)
 https://notofonts.github.io (subsets of Noto Sans Hebrew, Noto Naskh Arabic and Noto Sans Devanagari, SIL OFL, see
   ../shaping/OFL-Noto.md)
 https://github.com/googlefonts/noto-emoji (subsets of Noto Color Emoji and Noto-COLRv1, SIL OFL, see OFL-NotoColorEmoji.md;
   damaged noto colrv1 subset.ttf is a damaged copy for tests/regressions.js)
 colrv1 paints.ttf is built by colrv1-paints.py, sbix.ttf by sbix.py, hinting instructions.ttf by scripts/hinting-fixtures.py
 https://github.com/mozilla/twemoji-colr (subset, CC-BY 4.0, see CC-BY-Twemoji.md)
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

        // the instructions the fonts above don't use (vectors, ISECT, ALIGNPTS, FLIPPT, round states, deltas, IDEF, ...)
        // and point matching: "hinting instructions.ttf" and FreeType's outlines of it from scripts/hinting-fixtures.py,
        // also which points are on and off the curve
        {
            const font = new Font(await fs.readFile('./tests/fonts/hinting instructions.ttf'));
            const hinter = new Hinter(font);
            const names = ['vectors', 'isect', 'flip', 'round', 'coords', 'deltas', 'logic', 'point-matched'];
            for (const [key, {advance, points}] of Object.entries(JSON.parse(await fs.readFile('./tests/fonts/hinting-instructions.json', 'utf8')))) {
                const [size, name] = key.split(':');
                const hinted = hinter.glyph(font.glyphIndex(0xe000 + names.indexOf(name)), +size);
                if (!hinted || hinted.advance * 64 !== advance) panic(`hinting instructions ${key}: not hinted or a wrong advance`);
                const on = new Set(), off = new Set();
                const at = (x, y) => `${Math.round(x * 64)},${Math.round(y * 64)}`;
                for (const command of hinted.path) {
                    if (command[0] === 'Q') {
                        off.add(at(command[1], command[2]));
                        on.add(at(command[3], command[4]));
                    } else if (command.length > 1) on.add(at(command[1], command[2]));
                }
                for (const [x, y, onCurve] of points)
                    if (!(onCurve ? on : off).has(`${x},${y}`)) panic(`hinting instructions ${key}: ${onCurve ? 'on' : 'off'} curve point ${x},${y} missing`);
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

    {
        // color glyphs from fallback fonts: CBDT bitmaps (Noto Color Emoji), COLR layers (Twemoji) and paints (Noto-COLRv1),
        // emoji sequences
        const sans = await fs.readFile('./tests/fonts/sourcesans3 regular.otf');
        for (const [file, target] of [['noto color emoji subset.ttf', 'emoji-cbdt'], ['twemoji mozilla subset.ttf', 'emoji-colr'], ['noto colrv1 subset.ttf', 'emoji-colrv1']]) {
            const emoji = await fs.readFile(`./tests/fonts/${file}`);
            const image = await Image.renderText([sans, emoji], 48, 'Hi 😀🔥 👍🏽 🇩🇪 1️⃣ ❤️ 👨‍👩‍👧', {color: 0x000000ff});
            const encoded = await image.encode(1, {creationTime: 0, software: ''});
            if (process.env.OVERWRITE_TEST)
                await fs.writeFile(`./tests/targets/${target}.png`, encoded);
            if (!await samePixels(await fs.readFile(`./tests/targets/${target}.png`), encoded)) panic(`${target} doesn't match`);

            // black text, so colored pixels come from the emoji
            let colored = 0;
            for (let i = 0; i < image.bitmap.length; i += 4) if (image.bitmap[i + 3] > 128 && image.bitmap[i] > 128) colored++;
            if (colored < 500) panic(`${file}: emoji should keep their colors`);

            // joiners and variation selectors take no room, even where the font has glyphs for them
            const plain = await Image.renderText([sans, emoji], 48, '😀😀'), joined = await Image.renderText([sans, emoji], 48, '😀\u200d\ufe0f😀');
            if (plain.width !== joined.width) panic(`${file}: invisible characters should take no room (${plain.width} vs ${joined.width})`);

            // sequences are one glyph (GSUB ligatures): skin tones, flags, keycaps, joined ones
            const one = (await Image.renderText(emoji, 48, '👍')).width;
            for (const sequence of ['👍🏽', '🇩🇪', '1️⃣', '👨‍👩‍👧'])
                if ((await Image.renderText([sans, emoji], 48, sequence)).width > one * 1.2) panic(`${file}: ${sequence} should be a single glyph`);

            // the emoji variation selector picks the color glyph over the text font's heart
            const heart = await Image.renderText([sans, emoji], 48, '❤️', {color: 0x000000ff});
            let red = 0;
            for (let i = 0; i < heart.bitmap.length; i += 4) if (heart.bitmap[i + 3] > 128 && heart.bitmap[i] > 150 && heart.bitmap[i + 1] < 100) red++;
            if (red < 100) panic(`${file}: ❤️ should be the red emoji`);

            // characters the emoji font doesn't have come from the next font (the first one still sets the line height)
            const fallback = await Image.renderText([emoji, sans], 48, 'Hi'), direct = await Image.renderText(sans, 48, 'Hi');
            const ink = image => image.bitmap.reduce((sum, v, i) => (i & 3) === 3 ? sum + v : sum, 0);
            if (fallback.width !== direct.width || ink(fallback) !== ink(direct)) panic(`${file}: missing characters should come from the next font`);
        }

        // fonts with only bitmap glyphs render on their own
        const bitmapOnly = await Image.renderText(await fs.readFile('./tests/fonts/noto color emoji subset.ttf'), 32, '🔥');
        if (bitmapOnly.width < 20) panic('bitmap font should render on its own');
    }

    {
        // every COLR version 1 paint feature: gradients, transforms, composite modes, the text color
        const font = await fs.readFile('./tests/fonts/colrv1 paints.ttf');
        const glyphs = Array.from({length: 17}, (_, k) => String.fromCodePoint(0xe000 + k)).join('');
        const image = await Image.renderText(font, 48, glyphs, {color: 0x00aaaaff});
        const encoded = await image.encode(1, {creationTime: 0, software: ''});
        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/colrv1-paints.png', encoded);
        if (!await samePixels(await fs.readFile('./tests/targets/colrv1-paints.png'), encoded)) panic('colrv1-paints doesn\'t match');

        // the linear gradient runs from red (left) to blue (right), the last glyph's square is in the text color
        const linear = await Image.renderText(font, 100, '\ue000');
        const [lr, , lb] = linear.getRGBAAt(Math.round(linear.width * 0.15), linear.height >> 1), [rr, , rb] = linear.getRGBAAt(Math.round(linear.width * 0.85), linear.height >> 1);
        if (!(lr > 150 && lb < 100 && rb > 150 && rr < 100)) panic(`colrv1: linear gradient should go from red to blue (${lr},${lb} -> ${rr},${rb})`);
        const foreground = await Image.renderText(font, 100, '\ue010', {color: 0x00aaaaff});
        const [fr, fg, fb, fa] = foreground.getRGBAAt(Math.round(foreground.width * 0.12), foreground.height >> 1);
        if (fr > 2 || Math.abs(fg - 0xaa) > 2 || Math.abs(fb - 0xaa) > 2 || fa < 253) panic(`colrv1: layers in the text color should take it (${fr},${fg},${fb},${fa})`);

        // the other blend modes: a disc (source) over a square (backdrop), both opaque, where they overlap (the center,
        // 500/400 in font units) the blended color (W3C Compositing and Blending)
        const backdrop = [64, 128, 192].map(v => v / 255), source = [230, 76, 120].map(v => v / 255);
        const hardLight = (b, s) => s <= 0.5 ? b * 2 * s : 1 - (1 - b) * (2 - 2 * s);
        const lum = c => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
        const clip = c => {
            const l = lum(c), n = Math.min(...c), x = Math.max(...c);
            return c.map(v => n < 0 ? l + (v - l) * l / (l - n) : x > 1 ? l + (v - l) * (1 - l) / (x - l) : v);
        };
        const setLum = (c, l) => clip(c.map(v => v + l - lum(c)));
        const sat = c => Math.max(...c) - Math.min(...c);
        const setSat = (c, s) => c.map(v => (v - Math.min(...c)) * s / (Math.max(...c) - Math.min(...c)));
        const separable = f => (b, s) => b.map((v, i) => f(v, s[i]));
        const blends = {
            screen: separable((b, s) => b + s - b * s),
            overlay: separable((b, s) => hardLight(s, b)),
            'color dodge': separable((b, s) => b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
            'color burn': separable((b, s) => b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
            difference: separable((b, s) => Math.abs(b - s)),
            exclusion: separable((b, s) => b + s - 2 * b * s),
            saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
            color: (b, s) => setLum(s, lum(b)),
            luminosity: (b, s) => setLum(b, lum(s))
        };
        let glyph = 0xe011;
        for (const [name, blend] of Object.entries(blends)) {
            const image = await Image.renderText(font, 100, String.fromCodePoint(glyph++));
            const actual = image.getRGBAAt(image.width >> 1, 50), expected = blend(backdrop, source).map(v => Math.round(v * 255));
            if (expected.some((v, i) => Math.abs(v - actual[i]) > 1) || actual[3] !== 255) panic(`colrv1 ${name}: ${actual} instead of ${expected}`);
        }

        // a radial gradient whose circles touch (red at the left edge of the inner one, blue around the outer one), a
        // solid paint (green) inside a disc, and a glyph without a clip box sized by its outlines
        const touching = await Image.renderText(font, 100, '\ue01a');
        const [tr, , tb] = touching.getRGBAAt(31, 50), [, , ob] = touching.getRGBAAt(88, 50);
        if (!(tr > 200 && tb < 50 && ob > 200)) panic(`colrv1: touching radial gradient (${tr},${tb} / ${ob})`);
        const solidFill = await Image.renderText(font, 100, '\ue01b');
        if (solidFill.getRGBAAt(solidFill.width >> 1, 50).join() !== '0,153,0,255' || solidFill.getRGBAAt(12, 85)[3] !== 0)
            panic(`colrv1: a solid paint should fill the disc only (${solidFill.getRGBAAt(solidFill.width >> 1, 50)})`);
        const unclipped = await Image.renderText(font, 100, '\ue01c');
        if (unclipped.width < 80 || unclipped.width > 110) panic(`colrv1: a glyph without a clip box should be sized by its outlines (${unclipped.width})`);
    }

    {
        // sbix bitmaps: the PNG placed by its origin offset (8, -4 at 64 ppem), and a 'dupe' of it
        const font = await fs.readFile('./tests/fonts/sbix.ttf');
        const square = await Image.renderText(font, 64, '\ue000'), dupe = await Image.renderText(font, 64, '\ue001');
        if (!Buffer.from(square.bitmap).equals(Buffer.from(dupe.bitmap))) panic('sbix: a dupe should render as the glyph it refers to');
        // the baseline is at the ascender (0.9 em), the bitmap's bottom 4 pixels below it, its left edge at 8
        const [r, g, b] = square.getRGBAAt(8 + 24, Math.ceil(0.9 * 64) + 4 - 24), [cr, , cb] = square.getRGBAAt(8 + 4, Math.ceil(0.9 * 64) + 4 - 44);
        if (!(r > 200 && g < 50 && b < 50 && cb > 200 && cr < 50)) panic(`sbix: the bitmap should be placed by its origin offset (${r},${g},${b} / ${cr},${cb})`);
        if (square.getRGBAAt(8 - 2, 30)[3] !== 0) panic('sbix: nothing left of the bitmap');
    }

    {
        // text without anything to show renders a transparent pixel wide, it doesn't throw
        const font = await fs.readFile('./tests/fonts/sourcesans3 regular.otf');
        for (const text of ['', ' ', '\u200b\ufe0f'])
            if ((await Image.renderText(font, 32, text)).width !== 1) panic(`empty text: ${JSON.stringify(text)} should render a pixel wide`);

        // combining sequences are composed where the font has the composed character
        const composed = await Image.renderText(font, 32, 'Café Müller'), decomposed = await Image.renderText(font, 32, 'Cafe\u0301 Mu\u0308ller');
        if (!Buffer.from(composed.bitmap).equals(Buffer.from(decomposed.bitmap))) panic('combining sequences should render like the composed characters');
    }

    {
        // bidirectional text with fallback fonts: Hebrew and Arabic in a left to right paragraph, a right to left
        // paragraph with numbers and mirrored brackets, Devanagari conjuncts and reph, wrapped and right aligned
        const fonts = await Promise.all(['opensans bold.ttf', 'noto sans hebrew subset.ttf', 'noto naskh arabic subset.ttf', 'noto sans devanagari subset.ttf']
            .map(name => fs.readFile(`./tests/fonts/${name}`)));
        const text = 'Hi שָׁלוֹם עוֹלָם (2024) and مرحبا بالعالم!\nمرحبا بالعالم، هذا نص (2024)!\nनमस्ते क्षत्रिय र्क्ष';
        const font = await Image.renderText(fonts, 40, text, 0xffffffff, new TextLayout({maxWidth: 420, horizontalAlign: 'right'}));
        const encoded = await font.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/font-bidi.png', encoded);

        const desired = await fs.readFile('./tests/targets/font-bidi.png');
        if (!await samePixels(desired, encoded)) panic('bidirectional text doesn\'t match');

        // a right to left paragraph's line starts on the right: its first word is the rightmost
        const line = await Image.renderText(fonts, 40, 'مرحبا Hi', 0xffffffff);
        const arabic = await Image.renderText(fonts, 40, 'مرحبا', 0xffffffff);
        const right = line.clone().crop(line.width - arabic.width, 0, arabic.width, line.height);
        if (!await samePixels(await arabic.encode(1, {creationTime: 0, software: ''}), await right.encode(1, {creationTime: 0, software: ''})))
            panic('the right to left paragraph should start on the right');
    }
})();
