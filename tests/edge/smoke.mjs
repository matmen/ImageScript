// the codecs and renderers once each, for runtimes without file access: the fixtures are bundled (see run.mjs)
import { Image, Animation, Frame } from '../../dist/index.js';
import png from '../targets/external.png';
import font from '../fonts/opensans bold.ttf';

export async function smoke() {
    const results = {};
    const step = async (name, test) => {
        try {
            results[name] = await test();
        } catch (e) {
            results[name] = `FAIL ${e && e.stack || e}`;
        }
    };
    const photo = (await Image.decode(png)).resize(256, Image.RESIZE_AUTO), alpha = photo.clone();
    for (let i = 3; i < alpha.bitmap.length; i += 4) alpha.bitmap[i] = (i >> 2) % 256;
    // (decoded back, the same size)
    const back = async data => {
        const image = await Image.decode(data);
        if (image.width !== photo.width || image.height !== photo.height) throw new Error(`decoded as ${image.width}x${image.height}`);
        return `${data.length} B`;
    };
    await step('png', async () => back(await alpha.encode()));
    await step('jpeg', async () => back(await photo.encodeJPEG(80)));
    await step('webp lossless', async () => back(await alpha.encodeWebP()));
    await step('webp lossy', async () => back(await alpha.encodeWebP({ quality: 75 })));
    await step('avif', async () => back(await alpha.encodeAVIF({ effort: 0 })));
    await step('jxl lossless', async () => back(await alpha.encodeJXL()));
    await step('jxl lossy', async () => back(await alpha.encodeJXL({ quality: 85, effort: 2 })));
    await step('tga, bmp, qoi, pnm', async () => (await Promise.all([photo.encodeTGA(), photo.encodeBMP(), photo.encodeQOI(), photo.encodePNM()].map(async d => back(await d)))).join(', '));
    const frames = [Frame.from(photo.clone().resize(64, 64), 100), Frame.from(photo.clone().resize(64, 64).invert(), 100)];
    for (const [name, encode] of [['gif', a => a.encodeGIF()], ['apng', a => a.encodeAPNG()], ['animated webp', a => a.encodeWebP({ quality: 70 })]]) {
        await step(name, async () => {
            const decoded = await Animation.decode(await encode(new Animation(frames)));
            if (decoded.length !== 2) throw new Error(`${decoded.length} frames`);
            return '2 frames';
        });
    }
    await step('text', async () => {
        const text = await Image.renderText(font, 24, 'Edge äöü fi', 0x000000ff);
        return `${text.width}x${text.height}`;
    });
    await step('svg', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>'
            + '<rect width="200" height="80" fill="url(#g)" filter="drop-shadow(2px 2px 2px black)"/><text x="10" y="50" font-size="30" fill="white">Hallo</text></svg>';
        const image = await Image.renderSVG(svg, { fonts: [font] });
        return `${image.width}x${image.height}`;
    });
    return results;
}
