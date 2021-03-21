const fs = require('fs').promises;
const {Image} = require('../ImageScript');

(async () => {
	const input = await fs.readFile('./tests/targets/external.png');

	const image = await Image.decode(input);
	image.fisheye();

	const output = await image.encode();
	const target = await fs.readFile('./tests/targets/fisheye.png');

	if (!Buffer.from(target).equals(Buffer.from(output)))
		process.exit(1);
})();
