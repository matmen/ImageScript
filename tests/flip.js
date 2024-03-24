import {Image} from '../ImageScript.js';
import {equals} from 'https://deno.land/std@0.80.0/bytes/mod.ts';

(async () => {
    const input = await Deno.readFile('./tests/targets/external.png');

    {
        const image = await Image.decode(input);
        image.flip('horizontal');

        const output = await image.encode(1, {creationTime: 0, software: ''});

        const target = await Deno.readFile('./tests/targets/flip-horizontal.png');

        if (!equals(output, target))
            process.exit(1);
    }

    {
        const image = await Image.decode(input);
        image.flip('vertical');

        const output = await image.encode(1, {creationTime: 0, software: ''});

        const target = await Deno.readFile('./tests/targets/flip-vertical.png');

        if (!equals(output, target))
            process.exit(1);
    }
})();
