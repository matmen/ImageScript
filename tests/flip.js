const fs = require('fs').promises;
const {Image} = require('../ImageScript');

(async () => {
    const input = await fs.readFile('./tests/targets/external.png');

    {
        const image = await Image.decode(input);
        image.flip('horizontal');

        const output = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/flip-horizontal.png', output);

        const target = await fs.readFile('./tests/targets/flip-horizontal.png');

        if (!Buffer.from(target).equals(Buffer.from(output)))
            process.exit(1);
    }

    {
        const image = await Image.decode(input);
        image.flip('vertical');

        const output = await image.encode(1, {creationTime: 0, software: ''});

        if (process.env.OVERWRITE_TEST)
            await fs.writeFile('./tests/targets/flip-vertical.png', output);

        const target = await fs.readFile('./tests/targets/flip-vertical.png');

        if (!Buffer.from(target).equals(Buffer.from(output)))
            process.exit(1);
    }
})();
