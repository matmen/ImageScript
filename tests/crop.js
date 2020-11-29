import {Image} from '../ImageScript.js';
import {equal} from "https://deno.land/std/bytes/mod.ts";

(async () => {
    const image = new Image(512, 512);
    image.fill((x, y) => Image.hslToColor((x + y) / (image.width + image.height), 1, .5));
    image.crop(128, 128, 128, 128);

    const encoded = await image.encode();

    const target = await Deno.readFile('./tests/targets/crop.png');
    if (!equal(encoded, target)) process.exit(1);
})();