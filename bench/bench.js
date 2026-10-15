// Measures one library (node --expose-gc bench.js <name>) and prints its results as JSON: operations per second for
// decoding, encoding, the image operations and rendering, and the encoded file sizes. run.js runs every library in
// its own process, so one library's memory can't affect the next one's measurements
import fs from 'node:fs';
import sharp from 'sharp';
import { Bench } from 'tinybench';
import { libraries } from './libs.js';

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

const speed = {}, sizes = {};
const formatName = format => ({ jpeg: 'JPEG', png: 'PNG', webp: 'WebP' })[format];

// collect: canvases hold their pixels in native memory that V8 doesn't count and only free it in finalizers that run
// on a later event-loop turn, which tinybench's loop never yields to. So between iterations (outside the measured
// time) garbage is collected and the loop gets a turn, instead of the pixels piling up until the process is killed
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
const photo = await decode(files['photo.jpg']), overlay = await decode(files['overlay.png']);

for (const [task, file] of [['decode JPEG', 'photo.jpg'], ['decode PNG', 'photo.png'], ['decode WebP', 'photo.webp']])
    if (await decode(files[file]).then(() => true, () => false)) await measure(task, () => decode(files[file]));
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

// encoded sizes, with each library's default settings (JPEG at quality 80, WebP lossless)
for (const [name, file] of [['photo', 'photo.jpg'], ['graphic', 'graphic.png']]) {
    const image = await decode(files[file]);
    for (const [format, encode] of Object.entries(lib.encode)) sizes[`${name} ${formatName(format)}`] = (await encode(image)).length;
}
if (lib.animation) sizes['animation GIF'] = (await lib.animation.encode(await lib.animation.decode(files['animation.gif']))).length;

console.log(JSON.stringify({ speed, sizes }));
