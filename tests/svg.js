import {Image} from '../ImageScript.js';
import {equal} from "https://deno.land/std/bytes/mod.ts";

(async () => {
    const svg = await Deno.readFile('./tests/twemoji.svg');
    const image = Image.renderSVG(Deno.core.decode(svg), 256 / 36, Image.SVG_MODE_SCALE);
    const encoded = await image.encode();

    const target = await Deno.readFile('./tests/targets/twemoji.png');
    if (!equal(encoded, target)) process.exit(1);
})();