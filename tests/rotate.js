import {Image} from '../ImageScript.js';
import {equal} from "https://deno.land/std/bytes/mod.ts";

const panic = msg => {
    console.error(msg);
    process.exit(1);
}

(async () => {
    {
        const binary = await Deno.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(45);

        const encoded = await image.encode();

        const target = await Deno.readFile('./tests/targets/rotate-45.png');
        if (!equal(encoded, target)) panic('rotate 45 failed');
    }

    {
        const binary = await Deno.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(45, false);

        const encoded = await image.encode();

        const target = await Deno.readFile('./tests/targets/rotate-45-noresize.png');
        if (!equal(encoded, target)) panic('rotate 45 noresize failed');
    }

    {
        const binary = await Deno.readFile('./tests/targets/image.png');
        const image = await Image.decode(binary);
        image.rotate(180);

        const encoded = await image.encode();

        const target = await Deno.readFile('./tests/targets/rotate-180.png');
        if (!equal(encoded, target)) panic('rotate 180 failed');
    }

    {
        const image = new Image(512, 512);
        image.fill((x) => Image.hslToColor(x / image.width, 1, .5));
        if (!equal(image.bitmap, image.rotate(360).bitmap))
            panic('rotate 360 failed');
    }
})();