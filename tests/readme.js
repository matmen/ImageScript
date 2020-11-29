import {Image} from '../ImageScript.js';
import { equal } from "https://deno.land/std/bytes/mod.ts";

(async () => {
    const image = await Image.decode(await Deno.readFile('./tests/targets/external.png'));
    const overlay = await Image.decode(await Deno.readFile('./tests/targets/issues.png'));

    image.crop(228, 20, 152, 171);

    overlay.resize(image.width, Image.RESIZE_AUTO);
    overlay.opacity(0.8, true);
    image.composite(overlay, 0, image.height - overlay.height);

    const encoded = await image.encode();

    if (!equal(await Deno.readFile('./tests/targets/readme.png'), encoded))
        process.exit(1);
})();