const fs = require('fs').promises;
const {Image} = require('../ImageScript');

const panic = message => {
	console.error(message);
	process.exit(1);
};

(async () => {
	const binary = await fs.readFile('./tests/targets/external.jpg');
	const image = await Image.decode(binary);

	if ([image.width, image.height].some(v => v !== 638))
		panic('dimensions don\'t match');
	if (!Buffer.from(image.bitmap.slice(0, 4)).equals(Buffer.from([70, 65, 61, 255])))
		panic('pixel doesn\'t match');

	await image.encodeJPEG(100);
})();