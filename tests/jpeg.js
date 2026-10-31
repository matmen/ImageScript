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
	// scripts/jpeg-fixtures.py
	'sub-440': '96b504d1858876b6b7fa8c0bdb7487ed5b5be1f7c5685570d03ba407b0859880', // 4:4:0 (chroma halved vertically)
	'sub-411': 'c8148adc76174a33a76192ca6bca99b009e107707b75a52d1a71b1fa5fdc8d26', // 4:1:1 (chroma replicated)
	'ycck': '713ebfa5853a4c11e8d8808017ee3216805770a08eacca908932b936ead6e771', // Adobe YCCK
	'fill-bytes': 'effa4b3d6d07ae18d24beb085653d5e86b9f0e259cecd94986fdc0bf4e01663f', // 0xff fill bytes before markers
};

// sha256 of cjpeg -quality <q> -baseline -optimize (-sample 1x1 above 90) of the decoded images, libjpeg-turbo 2.1.5:
// the encoder writes the same bytes, but for its Exif segment
const encoded = {
	'external@10': 'd1c9d6f323aace423439f3133aa161fad2b7b30a8fd72d7dc4f0cfe620a15a45',
	'external@50': 'babb66fd617da2773d57e849b949051e9a90c790f888a4b79d83261388997d78',
	'external@90': '05e8d09c19e04d9abd77fe4a957b5cc9b7cb095ec3d0eae1ac0903b092bea648',
	'external@100': 'c2b61dcda49efa9cd998bb84b5de7a820f62395840ce8cfbda648fbde2b924ec',
	'tiny-17x9-prog@10': 'd4397b2b63d57a8effc18a76073c012a7cf204a29e20ecb2ef9a76f04dd3240e',
	'tiny-17x9-prog@50': 'a486ba21b4354bc52f4ccf0ce71bfc6b6675c0a8d9684db87f61573b959b6a8e',
	'tiny-17x9-prog@90': 'dd4d05fa35270afdbe6e6ae4947d8816f3a75280387cedf1d3fd2812de116ff0',
	'tiny-17x9-prog@100': 'f938598c831005837ac429312fa659d0022a776c1933d23a824975df436ca8bf',
};

// removes the APP1 (Exif) segment following SOI and APP0
const withoutExif = data => {
	if (data[20] !== 0xff || data[21] !== 0xe1) panic('no Exif segment after APP0');
	return Buffer.concat([data.subarray(0, 20), data.subarray(22 + (data[22] << 8 | data[23]))]);
};

(async () => {
	for (const [key, hash] of Object.entries(encoded)) {
		const [name, quality] = key.split('@');
		const file = name === 'external' ? './tests/targets/external.jpg' : `./tests/jpegs/${name}.jpg`;
		const data = withoutExif(await (await Image.decode(await fs.readFile(file))).encodeJPEG(Number(quality)));
		if (crypto.createHash('sha256').update(data).digest('hex') !== hash)
			panic(`${key}: encoded bytes don't match cjpeg's`);
	}

	const binary = await fs.readFile('./tests/targets/external.jpg');
	const image = await Image.decode(binary);

	if ([image.width, image.height].some(v => v !== 638))
		panic('dimensions don\'t match');
	if (!Buffer.from(image.bitmap.slice(0, 4)).equals(Buffer.from([220, 227, 219, 255])))
		panic('pixel doesn\'t match');

	for (const [name, hash] of Object.entries(expected)) {
		const decoded = await Image.decode(await fs.readFile(`./tests/jpegs/${name}.jpg`));
		if (crypto.createHash('sha256').update(new Uint8Array(decoded.bitmap)).digest('hex') !== hash)
			panic(`${name}: decoded pixels don't match`);
	}

	// stray bytes between segments are skipped
	{
		const data = await fs.readFile('./tests/jpegs/orig-420-base.jpg');
		const dqt = data.indexOf(Buffer.from([0xff, 0xdb]));
		const stray = Buffer.concat([data.subarray(0, dqt), Buffer.from([0x12, 0x34, 0x00]), data.subarray(dqt)]);
		const decoded = await Image.decode(stray);
		if (crypto.createHash('sha256').update(new Uint8Array(decoded.bitmap)).digest('hex') !== expected['orig-420-base'])
			panic('stray bytes: decoded pixels don\'t match');
	}

	// a scan with restart markers that ends early (cut, then EOI): what was decoded is kept
	{
		const data = await fs.readFile('./tests/jpegs/restart.jpg');
		const sos = data.indexOf(Buffer.from([0xff, 0xda]));
		const cut = Buffer.concat([data.subarray(0, sos + (data.length - sos >> 1)), Buffer.from([0xff, 0xd9])]);
		const decoded = await Image.decode(cut);
		if (decoded.width !== 227 || decoded.height !== 149) panic('early ending scan: dimensions don\'t match');
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

		// (libjpeg gets 27.7 dB at quality 10 on this photo)
		if (psnr < 27) panic(`q${quality}: psnr too low (${psnr.toFixed(2)}dB)`);
		if (previous && (encoded.length <= previous.size || psnr <= previous.psnr))
			panic(`q${quality}: not better than the previous quality`);
		previous = {size: encoded.length, psnr};
	}
})();
