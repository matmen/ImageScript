// Measures one library (node --expose-gc bench.js <name>) and prints its results as JSON: operations per second for
// decoding, encoding, the image operations and rendering, and the encoded file sizes. run.js runs every library in
// its own process, so one library's memory can't affect the next one's measurements
import fs from 'node:fs';
import sharp from 'sharp';
import { Bench } from 'tinybench';
import { libraries, referenceDecode, AVIF_QUALITY } from './libs.js';

const lib = libraries.find(l => l.name === process.argv[2]);
if (!lib) throw new Error(`unknown library ${process.argv[2]}, one of: ${libraries.map(l => l.name).join(', ')}`);

const files = {
    'photo.jpg': fs.readFileSync(new URL('./inputs/photo.jpg', import.meta.url)),
    'graphic.png': fs.readFileSync(new URL('./inputs/graphic.png', import.meta.url)),
    'overlay.png': fs.readFileSync(new URL('./inputs/overlay.png', import.meta.url)),
    'animation.gif': fs.readFileSync(new URL('./inputs/animation.gif', import.meta.url))
};
files['photo.png'] = await sharp(files['photo.jpg']).png().toBuffer();
files['photo.webp'] = await sharp(files['photo.jpg']).webp({ quality: 80 }).toBuffer();
// (and AVIF by libaom, JPEG XL by libjxl: sharp's and jsquash's encoders at the benchmark's qualities)
files['photo.avif'] = await sharp(files['photo.jpg']).avif({ quality: AVIF_QUALITY }).toBuffer();
const rawOf = async file => { const { data, info } = await sharp(files[file]).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, width: info.width, height: info.height }; };
const pixels = { 'photo.jpg': await rawOf('photo.jpg'), 'graphic.png': await rawOf('graphic.png'), 'overlay.png': await rawOf('overlay.png') };
files['photo.jxl'] = new Uint8Array(await (libraries.find(l => l.name === 'jsquash').encode.jxl)({ ...pixels['photo.jpg'], data: new Uint8ClampedArray(pixels['photo.jpg'].data) }));

const speed = {}, sizes = {};
const formatName = format => ({ jpeg: 'JPEG', png: 'PNG', webp: 'WebP', avif: 'AVIF', jxl: 'JPEG XL' })[format];

// collect: canvases (native memory) and Photon images (WebAssembly memory) hold their pixels outside the V8 heap and
// only free them in finalizers that run on a later event-loop turn, which tinybench's loop never yields to. So between
// iterations (outside the measured time) garbage is collected and the loop gets a turn, instead of the pixels piling
// up until the process is killed (or Photon runs out of its 4 GB)
async function measure(task, fn) {
    const bench = new Bench({ time: 1500, iterations: 3, warmupTime: 300, warmupIterations: 1 });
    bench.add(task, fn, lib.collect && globalThis.gc ? { afterEach: async () => { globalThis.gc(); await new Promise(setImmediate); } } : {});
    await bench.run();
    const r = bench.tasks[0].result;
    if (r.error) throw r.error;
    const ms = r.latency?.mean ?? r.mean;
    speed[task] = { opsPerSecond: Math.round(1000 / ms * 100) / 100, ms: Math.round(ms * 100) / 100, samples: r.latency?.samples?.length ?? r.samples?.length };
    console.error(`${task.padEnd(16)} ${lib.name.padEnd(16)} ${(1000 / ms).toFixed(2).padStart(10)} ops/s  ${ms.toFixed(2).padStart(9)} ms`);
}

const decode = data => Promise.resolve().then(() => lib.decode(data));
// (libraries without the inputs' formats get their pixels)
const input = file => lib.fromPixels ? lib.fromPixels(pixels[file]) : decode(files[file]);
const photo = await input('photo.jpg'), overlay = await input('overlay.png');

// a format the library reads but not this file (PureJsImage's JPEG XL) is recorded as failing
for (const [task, file, format] of [['decode JPEG', 'photo.jpg'], ['decode PNG', 'photo.png'], ['decode WebP', 'photo.webp'], ['decode AVIF', 'photo.avif', 'avif'], ['decode JPEG XL', 'photo.jxl', 'jxl']]) {
    const error = await decode(files[file]).then(() => null, e => e);
    if (!error) await measure(task, () => decode(files[file]));
    else if (lib.decodes?.includes(format)) speed[task] = { error: String(error.message ?? error) };
}
for (const [format, encode] of Object.entries(lib.encode))
    await measure(`encode ${formatName(format)}`, () => encode(photo));
for (const op of ['resize', 'rotate', 'blur', 'composite', 'crop', 'clone'])
    if (lib[op]) await measure(op, () => lib[op](photo, overlay));
// a library that has the feature but fails on this input (ImageScript 1 on the SVG) is recorded as failing
for (const op of ['text', 'svg']) {
    if (!lib[op]) continue;
    const error = await Promise.resolve().then(() => lib[op]()).then(() => null, e => e);
    if (error) speed[op] = { error: String(error.message ?? error) };
    else await measure(op, () => lib[op]());
}
if (lib.animation) {
    const animation = await lib.animation.decode(files['animation.gif']);
    await measure('decode GIF', () => lib.animation.decode(files['animation.gif']));
    await measure('encode GIF', () => lib.animation.encode(animation));
}

// encoded sizes, with each library's default settings (JPEG at quality 80, WebP lossless, AVIF and JPEG XL at the same
// quality: with their PSNR, of the color over black, as libavif and libjxl decode them)
const quality = {};
const psnr = (a, b) => {
    let se = 0;
    for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) {
        const d = a[i + c] * a[i + 3] / 255 - b[i + c] * b[i + 3] / 255;
        se += d * d;
    }
    return Math.round(10 * Math.log10(255 * 255 * 3 * a.length / 4 / se) * 10) / 10;
};
for (const [name, file] of [['photo', 'photo.jpg'], ['graphic', 'graphic.png']]) {
    const image = await input(file);
    for (const [format, encode] of Object.entries(lib.encode)) {
        const encoded = new Uint8Array(await encode(image));
        sizes[`${name} ${formatName(format)}`] = encoded.length;
        if (format === 'avif' || format === 'jxl') quality[`${name} ${formatName(format)}`] = psnr(pixels[file].data, await referenceDecode(encoded, format));
    }
}
if (lib.animation) sizes['animation GIF'] = (await lib.animation.encode(await lib.animation.decode(files['animation.gif']))).length;

console.log(JSON.stringify({ speed, sizes, quality }));
