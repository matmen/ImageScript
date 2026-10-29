// runs the smoke test (smoke.mjs) in edge runtimes, bundled like their deployments are: Cloudflare's workerd (through
// Miniflare, with and without Node.js compatibility) and Vercel's Edge Runtime. Needs the build and
//   npm install --no-save esbuild miniflare edge-runtime
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { EdgeRuntime } from 'edge-runtime';

const bundle = async (entry, format) => (await build({
    entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, write: false, format, target: 'es2022', platform: 'neutral',
    loader: { '.png': 'binary', '.ttf': 'binary' }, logLevel: 'error',
})).outputFiles[0].text;

let failed = false;
const report = (name, results) => {
    console.log(name);
    for (const [step, result] of Object.entries(results)) {
        console.log(`  ${step}: ${result}`);
        if (result.startsWith('FAIL')) failed = true;
    }
};

const worker = await bundle('./workerd.mjs', 'esm');
for (const flags of [[], ['nodejs_compat']]) {
    const mf = new Miniflare({ modules: true, script: worker, compatibilityDate: '2026-08-01', compatibilityFlags: flags });
    try {
        const response = await mf.dispatchFetch('http://localhost/');
        report(`workerd${flags.length ? ` (${flags.join(', ')})` : ''}`, await response.json());
    } finally {
        await mf.dispose();
    }
}

const runtime = new EdgeRuntime({ initialCode: await bundle('./edge-runtime.mjs', 'iife') });
report('edge-runtime', await (await runtime.dispatchFetch('http://localhost/')).json());

if (failed) process.exit(1);
console.log('edge runtimes passed');
