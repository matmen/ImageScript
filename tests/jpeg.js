const fs = require('fs').promises;
const crypto = require('crypto');
const {Image} = require('..');

const panic = message => {
	console.error(message);
	process.exit(1);
};

// sha256 of the expected RGBA output, generated with Pillow (libjpeg-turbo)
const expected = {
	'orig-420-base': 'effa4b3d6d07ae18d24beb085653d5e86b9f0e259cecd94986fdc0bf4e01663f', // baseline 4:2:0
	'orig-422-prog': '8246f2462dcc64462f1488da9a659e8c8e5d1ed7ace0f242018ea32c1090ddcb', // progressive 4:2:2
	'gray-prog': 'd759d432ce4f8e008aa979754f2238730c5866b7da5ad40a626963cf796d8697', // progressive greyscale
	'cmyk': 'd0c394b481eb12c88a68835be767330be634269d7e7ad3e55468cb563cae944d', // adobe CMYK
	'rgb-keep': 'e942d039ac0f827dbce4df1df82b40e2d5a44fc0ddd9b52150bc42f4fc9fb110', // RGB without color transform
	'restart': '0e6d2b2b65c65e55bb8b42be66bc601a2394d4bce315f8db8e655465dab4189a', // restart markers
	'tiny-17x9-prog': '3e23bd12158aa8c323b80b7480d401ba3135f2e3dec708b5942d7a1326c57bcf', // partial MCUs
};

(async () => {
	const binary = await fs.readFile('./tests/targets/external.jpg');
	const image = await Image.decode(binary);

	if ([image.width, image.height].some(v => v !== 638))
		panic('dimensions don\'t match');
	if (!Buffer.from(image.bitmap.slice(0, 4)).equals(Buffer.from([70, 65, 61, 255])))
		panic('pixel doesn\'t match');

	for (const [name, hash] of Object.entries(expected)) {
		const decoded = await Image.decode(await fs.readFile(`./tests/jpegs/${name}.jpg`));
		if (crypto.createHash('sha256').update(decoded.bitmap).digest('hex') !== hash)
			panic(`${name}: decoded pixels don't match`);
	}

	try {
		await Image.decode(await fs.readFile('./tests/jpegs/arithmetic.jpg'));
		panic('arithmetic coded JPEG was accepted');
	} catch (err) {
		if (!/arithmetic/.test(err.message)) panic(`unexpected error: ${err.message}`);
	}

	// encoding: higher quality must be larger and closer to the source
	let previous = null;
	for (const quality of [10, 50, 90, 100]) {
		const encoded = await image.encodeJPEG(quality);
		const decoded = await Image.decode(encoded);
		if (decoded.width !== image.width || decoded.height !== image.height)
			panic(`q${quality}: dimensions don't match`);

		let error = 0;
		for (let i = 0; i < image.bitmap.length; i += 4)
			for (let k = 0; k < 3; k++) error += (image.bitmap[i + k] - decoded.bitmap[i + k]) ** 2;
		const psnr = 10 * Math.log10(255 * 255 / (error / (image.width * image.height * 3)));

		if (psnr < 28) panic(`q${quality}: psnr too low (${psnr.toFixed(2)}dB)`);
		if (previous && (encoded.length <= previous.size || psnr <= previous.psnr))
			panic(`q${quality}: not better than the previous quality`);
		previous = {size: encoded.length, psnr};
	}
})();
