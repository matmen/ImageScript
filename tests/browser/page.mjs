// the browser test's page script: AVIF and JXL with and without threads (the same files and pixels), the codecs' smoke
// test
import { Image } from 'imagescript';
import { smoke } from '../edge/smoke.mjs';

const digest = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join('');
(async () => {
    const results = { isolated: self.crossOriginIsolated };
    try {
        const image = new Image(640, 512);
        for (let y = 0; y < 512; y++) for (let x = 0; x < 640; x++) image.setPixelAt(x, y, Image.rgbaToColor(x * 3 & 255, y * 5 & 255, (x ^ y) & 255, 255));
        results.single = await digest(await image.encodeAVIF({ effort: 1, threads: 1, metadata: { creationTime: 0 } }));
        results.threaded = await digest(await image.encodeAVIF({ effort: 1, threads: 4, metadata: { creationTime: 0 } }));
        results.jxlSingle = await digest(await image.encodeJXL({ quality: 85, threads: 1, metadata: { creationTime: 0 } }));
        results.jxlThreaded = await digest(await image.encodeJXL({ quality: 85, threads: 4, metadata: { creationTime: 0 } }));
        // (decoding from 4 megapixels)
        const big = image.clone().resize(2304, 2048), jxl = await big.encodeJXL({ quality: 80, effort: 0 });
        results.decodeSingle = await digest((await Image.decode(jxl, { threads: 1 })).bitmap);
        results.decodeThreaded = await digest((await Image.decode(jxl, { threads: 4 })).bitmap);
        results.smoke = await smoke();
    } catch (e) {
        results.error = String(e && e.stack || e);
    }
    globalThis.results = results;
})();
