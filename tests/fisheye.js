import {Image} from '../ImageScript.js';
import {equals} from '@std/bytes';

(async () => {
	const input = await Deno.readFile('./tests/targets/external.png');

	const image = await Image.decode(input);
	image.fisheye();

	const output = await image.encode();
	const target = await Deno.readFile('./tests/targets/fisheye.png');

	if (!equals(output, target))
		process.exit(1);
})();
