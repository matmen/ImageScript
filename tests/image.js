import {Image} from '../ImageScript.js';
import {equals} from "https://deno.land/std@0.80.0/bytes/mod.ts";

export default (async () => {
    const image = new Image(128, 128);
    image.fill(x => Image.hslToColor(x / image.width, 1, 0.5));

    const encoded = await image.encode();
    const desired = await Deno.readFile('./tests/targets/image.png');
    if (import.meta.main) Deno.exit(equals(desired, encoded) ? 0 : 1);

    return image;
})();