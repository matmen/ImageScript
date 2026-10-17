// the Unicode conformance tests (tests/unicode, samples of the bigger ones): the bidirectional algorithm, line
// breaking and grapheme clusters
const fs = require('fs');

const panic = message => {
    console.error(message);
    process.exit(1);
};

(async () => {
    const {resolve, lineLevels, visualOrder, classOf, BIDI_CLASSES} = await import('../dist/render/bidi.js');
    const {lineBreaks} = await import('../dist/render/linebreak.js');
    const {graphemeBoundaries} = await import('../dist/render/segment.js');
    const lines = file => fs.readFileSync(`./tests/unicode/${file}`, 'utf8').split('\n').filter(line => line.trim() && !line.startsWith('#'));
    const format = (levels, order) => `${Array.from(levels, l => l < 0 ? 'x' : l).join(' ')} / ${order.join(' ')}`;

    // BidiTest.txt: classes, paragraph directions (1 auto, 2 left to right, 4 right to left)
    let levels = '', reorder = '', count = 0;
    for (const line of lines('BidiTest.txt')) {
        if (line.startsWith('@Levels:')) { levels = line.slice(8).trim().split(/\s+/).join(' '); continue; }
        if (line.startsWith('@Reorder:')) { reorder = line.slice(9).trim().split(/\s+/).filter(Boolean).join(' '); continue; }
        const [input, bits] = line.split(';').map(s => s.trim());
        const classes = input.split(/\s+/).map(c => BIDI_CLASSES[c]);
        for (const [bit, direction] of [[1, -1], [2, 0], [4, 1]]) {
            if (!(parseInt(bits, 16) & bit)) continue;
            const result = lineLevels(resolve(classes, null, direction), 0, classes.length);
            const got = format(result, visualOrder(result));
            if (got !== `${levels} / ${reorder}`) panic(`BidiTest ${input} (${direction}): ${got}, expected ${levels} / ${reorder}`);
            count++;
        }
    }

    // BidiCharacterTest.txt: code points, direction (2 auto), paragraph level, levels, order
    for (const line of lines('BidiCharacterTest.txt')) {
        const [text, direction, level, expectedLevels, expectedOrder] = line.split(';').map(s => s.trim());
        const codepoints = text.split(' ').map(h => parseInt(h, 16));
        const paragraph = resolve(codepoints.map(classOf), codepoints, direction === '2' ? -1 : +direction);
        const result = lineLevels(paragraph, 0, codepoints.length);
        const got = `${paragraph.level}: ${format(result, visualOrder(result))}`;
        if (got !== `${level}: ${expectedLevels} / ${expectedOrder}`) panic(`BidiCharacterTest ${text} (${direction}): ${got}, expected ${level}: ${expectedLevels} / ${expectedOrder}`);
        count++;
    }

    // LineBreakTest.txt: × no break, ÷ break before each code point
    for (const line of lines('LineBreakTest.txt')) {
        const tokens = line.split(/\s+/);
        const codepoints = [];
        for (let i = 1; i < tokens.length; i += 2) codepoints.push(parseInt(tokens[i], 16));
        const breaks = lineBreaks(codepoints);
        for (let i = 1; i < codepoints.length; i++)
            if ((breaks[i] > 0) !== (tokens[2 * i] === '÷')) panic(`LineBreakTest ${line}: position ${i}`);
        count++;
    }

    // GraphemeBreakTest.txt: × no boundary, ÷ boundary before each code point
    for (const line of lines('GraphemeBreakTest.txt')) {
        const tokens = line.split(/\s+/);
        const codepoints = [];
        for (let i = 1; i < tokens.length; i += 2) codepoints.push(parseInt(tokens[i], 16));
        const boundaries = graphemeBoundaries(codepoints);
        for (let i = 1; i < codepoints.length; i++)
            if ((boundaries[i] === 1) !== (tokens[2 * i] === '÷')) panic(`GraphemeBreakTest ${line}: position ${i}`);
        count++;
    }

    if (count < 5000) panic(`only ${count} conformance tests ran`);
})();
