import {Image} from '../ImageScript.js';

(async () => {
    const binary = await Deno.readFile('./tests/targets/readme.png');
    const image = await Image.decode(binary);
    const avgColor = image.averageColor();
    if (avgColor !== 0x343c3dff) process.exit(1);
})();