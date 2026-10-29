// Runs bench.js for every library (or the ones named: node run.js sharp "ImageScript 3"), each in its own process,
// and writes results.json. Libraries that aren't run keep their results from the last run. Run on an idle machine
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { libraries } from './libs.js';

const file = new URL('./results.json', import.meta.url);
const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { speed: {}, sizes: {} };
previous.quality ??= {};
const names = process.argv.length > 2 ? process.argv.slice(2) : libraries.map(l => l.name);

// os.cpus() reports "unknown" inside some containers, /proc/cpuinfo still has the model
const cpu = os.cpus()[0]?.model;
const results = {
    date: new Date().toISOString().slice(0, 10),
    node: process.version,
    cpu: cpu && cpu !== 'unknown' ? cpu : fs.readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.+)/)?.[1] ?? 'unknown',
    versions: { ...previous.versions },
    speed: previous.speed,
    sizes: previous.sizes,
    quality: previous.quality
};

for (const name of names) {
    const lib = libraries.find(l => l.name === name);
    if (!lib) throw new Error(`unknown library ${name}`);
    const output = execFileSync(process.execPath, ['--expose-gc', new URL('./bench.js', import.meta.url).pathname, name],
        { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 24 });
    const { speed, sizes, quality } = JSON.parse(output);
    for (const table of [results.speed, results.sizes, results.quality]) for (const task in table) delete table[task][name];
    for (const [task, r] of Object.entries(speed)) (results.speed[task] ??= {})[name] = r;
    for (const [task, size] of Object.entries(sizes)) (results.sizes[task] ??= {})[name] = size;
    for (const [task, db] of Object.entries(quality)) (results.quality[task] ??= {})[name] = db;
    results.versions[name] = process.env.IMAGESCRIPT === 'local' && lib.package === 'imagescript'
        ? 'local' : JSON.parse(fs.readFileSync(new URL(`./node_modules/${lib.package}/package.json`, import.meta.url))).version;
}

fs.writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
console.log('results.json written');
