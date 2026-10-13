const fs = require('fs').promises;
const {Image} = require('..');
const samePixels = require('./util/pixels');

(async () => {
	const input = await fs.readFile('./tests/targets/external.png');

	const image = await Image.decode(input);
	image.fisheye();

	const output = await image.encode(1, {creationTime: 0, software: ''});

	if (process.env.OVERWRITE_TEST)
		await fs.writeFile('./tests/targets/fisheye.png', output);

	const target = await fs.readFile('./tests/targets/fisheye.png');

	if (!await samePixels(target, output))
		process.exit(1);
})();
