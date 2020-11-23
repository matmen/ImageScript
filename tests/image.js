import {Image} from '../ImageScript.js';
import { equal } from "https://deno.land/std/bytes/mod.ts";

export default (async () => {
    const image = Image.new(128, 128);
    image.fill(x => Image.hslToColor(x / image.width, 1, 0.5));

    const encoded = await image.encode();
    const desired = await Deno.readFile('./tests/image.png');
    if (import.meta.main) Deno.exit(equal(desired, encoded) ? 0 : 1);

    return image;
})();