// OpenType shaping compared with HarfBuzz's (tests/shaping/reference.json, made by scripts/shaping-reference.py from
// subsets of Noto fonts, SIL OFL, see OFL-Noto.md, and by scripts/shaping-fallbacks.py and shaping-features.py from
// fonts they build): glyphs, clusters and positions of texts in many scripts, every lookup type and the fallbacks
const fs = require('fs');

const panic = message => {
    console.error(message);
    process.exit(1);
};

(async () => {
    const {Font} = await import('../dist/render/font.js');
    const {shapeFont, shapeRun} = await import('../dist/render/shape.js');
    await import('../dist/render/shapers/index.js');

    const {cases} = JSON.parse(fs.readFileSync('./tests/shaping/reference.json', 'utf8'));
    const fonts = new Map();
    const RTL = ['Arab', 'Hebr', 'Syrc', 'Nkoo', 'Thaa', 'Adlm'];
    for (const {font, script, direction, text, glyphs} of cases) {
        let f = fonts.get(font);
        if (!f) fonts.set(font, f = shapeFont(new Font(new Uint8Array(fs.readFileSync(`./tests/shaping/${font}`)))));
        const codepoints = Array.from(text, c => c.codePointAt(0));
        const rtl = direction ? direction === 'rtl' : RTL.includes(script);
        const shaped = shapeRun(f, codepoints, script, rtl ? 5 : 4).map(g => [g.codepoint, g.cluster, g.xAdvance, g.xOffset, g.yOffset]);
        if (JSON.stringify(shaped) !== JSON.stringify(glyphs))
            panic(`${font} (${script}) ${codepoints.map(c => c.toString(16)).join(' ')}:\n  got      ${JSON.stringify(shaped)}\n  expected ${JSON.stringify(glyphs)}`);
    }
    if (cases.length < 300) panic(`only ${cases.length} cases`);
})();
