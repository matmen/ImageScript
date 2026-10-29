// the browser test's page script: AVIF and JXL with and without threads (the same files), the codecs' smoke test
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
        results.smoke = await smoke();
    } catch (e) {
        results.error = String(e && e.stack || e);
    }
    globalThis.results = results;
})();
