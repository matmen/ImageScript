/*
 Fonts sourced from:
 https://www.1001fonts.com/carbon-font.html
 https://www.1001fonts.com/ethnocentric-font.html
 */

import {Image} from '../ImageScript.js';

const panic = message => {
    console.error(message);
    process.exit(1);
};

(async () => {
    {
        const font = await Image.renderText(await Deno.readFile('./tests/fonts/carbon phyber.ttf'), 128, 'ThE qUiCk');
        const encoded = await font.encode();

        const desired = await Deno.readFile('./tests/targets/font-1.png');
        if (!equal(desired, encoded)) panic('font 1 doesn\'t match');
    }

    {
        const font = await Image.renderText(await Deno.readFile('./tests/fonts/ethnocentric rg.ttf'), 128, 'BrOwN fOx');
        const encoded = await font.encode();

        const desired = await Deno.readFile('./tests/targets/font-2.png');
        if (!equal(desired, encoded)) panic('font 2 doesn\'t match');
    }
})();