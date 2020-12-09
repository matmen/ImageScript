import {Image} from '../ImageScript.js';

(async () => {
    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.invert();

        const encoded = await image.encode();

        const target = await Deno.readFile('./tests/targets/invert.png');
        if (!equals(encoded, target)) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.invertValue();

        const encoded = await image.encode();

        const target = await Deno.readFile('./tests/targets/invert-value.png');
        if (!equals(encoded, target)) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.invertSaturation();

        const encoded = await image.encode();

        const target = await Deno.readFile('./tests/targets/invert-saturation.png');
        if (!equals(encoded, target)) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.invertHue();

        const encoded = await image.encode();

        const target = await Deno.readFile('./tests/targets/invert-hue.png');
        if (!equals(encoded, target)) process.exit(1);
    }

    {
        const image = new Image(512, 512);
        image.fill(0xff8000ff);
        image.hueShift(180);

        const encoded = await image.encode();

        const target = await Deno.readFile('./tests/targets/invert-hueshift.png');
        if (!equals(encoded, target)) process.exit(1);
    }
})();