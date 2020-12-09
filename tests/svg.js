import {Image} from '../ImageScript.js';

(async () => {
    const svg = await Deno.readFile('./tests/svgs/potato.svg');
    const image = Image.renderSVG(Deno.core.decode(svg), 256 / 36, Image.SVG_MODE_SCALE);
    const encoded = await image.encode();

    const target = await Deno.readFile('./tests/targets/potato.png');
    if (!equals(encoded, target)) process.exit(1);
})();