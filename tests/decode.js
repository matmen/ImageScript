import {Image} from '../ImageScript.js';
import * as ImageTest from './image.js';
import {equal} from "https://deno.land/std/bytes/mod.ts";

const panic = message => {
    console.error(message);
    Deno.exit(1);
};

(async () => {
    {
        const binary = await Deno.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);

        const target = await ImageTest.default;
        if (!equal(target.bitmap, image.bitmap)) panic('arrays are unequal');
    }

    {
        const binary = await Deno.readFile('./tests/targets/external.png');
        const image = await Image.decode(binary);

        if ([image.width, image.height].some(v => v !== 638))
            panic('dimensions don\'t match');

        if (!equal(image.bitmap.subarray(0, 4), Uint8Array.from([70, 65, 62, 255])))
            panic('pixel doesn\'t match');
    }
})();