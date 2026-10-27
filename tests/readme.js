// the image in the README: a weather card of frosted glass over an SVG landscape
const {Image} = require('..');
const fs = require('fs');
const samePixels = require('./util/pixels');

const font = name => fs.readFileSync('./tests/fonts/' + name);

(async () => {
    const W = 1000, H = 600;
    const bold = font('opensans bold.ttf'), regular = font('sourcesans3 regular.otf');
    const scripts = [regular, font('noto naskh arabic subset.ttf'), font('noto sans devanagari subset.ttf'), font('noto colrv1 subset.ttf')];

    // background: an SVG landscape at sunrise
    const image = await Image.renderSVG(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <defs>
            <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#2b3a8c"/><stop offset="0.55" stop-color="#e2729a"/><stop offset="1" stop-color="#ffc58a"/>
            </linearGradient>
            <radialGradient id="sun"><stop offset="0" stop-color="#fff6d0"/><stop offset="0.5" stop-color="#ffd27a"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/></radialGradient>
            <linearGradient id="far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a4d8c"/><stop offset="1" stop-color="#4a3366"/></linearGradient>
            <linearGradient id="near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c2347"/><stop offset="1" stop-color="#16122a"/></linearGradient>
        </defs>
        <rect width="${W}" height="${H}" fill="url(#sky)"/>
        <circle cx="760" cy="330" r="190" fill="url(#sun)"/>
        <circle cx="760" cy="330" r="62" fill="#fff3c4"/>
        <path d="M0 420 L120 330 L210 380 L330 280 L470 390 L560 340 L700 410 L820 320 L1000 400 L1000 600 L0 600 Z" fill="url(#far)"/>
        <path d="M0 500 C150 430 260 470 380 440 S620 380 760 460 S920 470 1000 440 L1000 600 L0 600 Z" fill="url(#near)"/>
    </svg>`);

    // a frosted glass card: the background behind it, blurred and lightened, with a soft shadow
    const card = {x: 40, y: 40, width: 520, height: 520, radius: 28};
    const shadow = new Image(card.width + 80, card.height + 80).drawBox(40, 48, card.width, card.height, 0x00000060).blur(16);
    image.composite(shadow, card.x - 40, card.y - 40);
    const glass = image.region(card.x, card.y, card.width, card.height).blur(24)
        .composite(new Image(card.width, card.height).fill(0xffffffff), 0, 0, {opacity: 0.18})
        .roundCorners(card.radius);
    image.composite(glass, card.x, card.y);

    const text = async (fonts, size, string, color, x, y) => {
        const rendered = await Image.renderText(fonts, size, string, {color});
        image.composite(rendered, x, y);
        return rendered;
    };
    const left = card.x + 40;
    await text(bold, 44, 'Lisbon', 0xffffffff, left, card.y + 32);
    await text(regular, 26, 'Sunrise, clearing up later', 0xffffffd0, left, card.y + 92);
    const temperature = await text(bold, 132, '21°', 0xffffffff, left - 6, card.y + 128);

    // a sun behind a cloud
    const icon = await Image.renderSVG(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">
        <defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe27a"/><stop offset="1" stop-color="#ff9a3c"/></linearGradient>
        <linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dfe6f5"/></linearGradient></defs>
        <circle cx="62" cy="48" r="34" fill="url(#s)"/>
        <path d="M44 108 a26 26 0 0 1 4 -52 a34 34 0 0 1 64 8 a22 22 0 0 1 6 44 Z" fill="url(#c)"/>
    </svg>`);
    image.composite(icon, card.x + card.width - 40 - icon.width, card.y + 150);

    // the week: bars from the lowest to the highest temperature, in a gradient from cool to warm
    const days = [['Mon', 14, 21], ['Tue', 13, 19], ['Wed', 15, 23], ['Thu', 16, 25], ['Fri', 14, 22], ['Sat', 12, 18], ['Sun', 13, 20]];
    const gradient = Image.gradient({0: 0x5ac8faff, 0.5: 0xffd166ff, 1: 0xff7a59ff});
    const chart = {top: card.y + 300, height: 100, min: 10, max: 26};
    const step = (card.width - 80) / days.length;
    for (const [i, [day, low, high]] of days.entries()) {
        const cx = left + step * i + step / 2;
        const y0 = chart.top + chart.height * (1 - (high - chart.min) / (chart.max - chart.min));
        const y1 = chart.top + chart.height * (1 - (low - chart.min) / (chart.max - chart.min));
        const track = new Image(14, chart.height).fill(0xffffff30).roundCorners(7);
        image.composite(track, cx - 7, chart.top);
        const bar = new Image(14, y1 - y0).fill((x, y) => gradient((chart.max - (y0 + y - chart.top) / chart.height * (chart.max - chart.min) - chart.min) / (chart.max - chart.min)));
        image.composite(bar.roundCorners(7), cx - 7, y0);
        const label = await Image.renderText(regular, 20, day, {color: 0xffffffc0});
        image.composite(label, cx - label.width / 2, chart.top + chart.height + 10);
    }

    // a divider, then greetings in a few scripts
    image.drawBox(left, card.y + 446, card.width - 80, 1, 0xffffff40);
    const greeting = await Image.renderText(scripts, 26, 'Bom dia · مرحبا · नमस्ते 😀', {color: 0xffffffe0});
    image.composite(greeting, left, card.y + 446 + (card.height - 446 - greeting.height) / 2);

    image.roundCorners(24);
    const encoded = await image.encode({metadata: {creationTime: 0, software: ''}});

    if (process.env.OVERWRITE_TEST)
        fs.writeFileSync('./tests/targets/readme.png', encoded);

    if (!await samePixels(fs.readFileSync('./tests/targets/readme.png'), encoded))
        process.exit(1);
})();
