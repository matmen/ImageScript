import {Image} from '../ImageScript.js';
import {equal} from "https://deno.land/std/bytes/mod.ts";

(async () => {
    const binary = await Deno.readFile('./tests/targets/image.png');
    const image = await Image.decode(binary);
    image.resize(image.width / 4, Image.RESIZE_AUTO);

    const encoded = await image.encode();
    const target = await Deno.readFile('./tests/targets/resize.png');
    if (!equal(encoded, target)) process.exit(1);
})();