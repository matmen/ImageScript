/*
 Fonts sourced from:
 https://www.1001fonts.com/carbon-font.html
 https://www.1001fonts.com/ethnocentric-font.html
 */

const fs = require('fs').promises;
const {Image} = require('../ImageScript');

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
})();
