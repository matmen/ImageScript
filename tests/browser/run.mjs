// runs tests/browser/page.mjs in Chromium (Playwright), bundled by Vite (which has to find the worker's module), on a
// page with cross-origin isolation (threads: workers must start and write the same file) and one without (no
// SharedArrayBuffer: the same file without threads). Needs the build and
//   npm install --no-save vite playwright && npx playwright install chromium
// (CHROMIUM: a Chromium to use instead of Playwright's)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url)), out = path.join(here, 'dist');
fs.writeFileSync(path.join(here, 'index.html'), '<!doctype html><script type="module" src="./page.mjs"></script>\n');
try {
    await build({
        root: here, logLevel: 'error', build: { outDir: out, emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1e9, assetsInlineLimit: 0 },
        resolve: { alias: { imagescript: path.join(here, '../../dist/index.js') } },
        assetsInclude: ['**/*.ttf'],
        plugins: [{ name: 'binary', enforce: 'pre', load: id => /\.(png|ttf)$/.test(id) ? `export default Uint8Array.from(atob('${fs.readFileSync(id).toString('base64')}'), c => c.charCodeAt(0));` : null }],
    });
} finally {
    fs.rmSync(path.join(here, 'index.html'));
}
if (!fs.readdirSync(path.join(out, 'assets')).some(f => f.startsWith('worker'))) throw new Error('Vite did not bundle the worker');

let failed = false;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
try {
    for (const isolated of [true, false]) {
        const server = http.createServer((request, response) => {
            const file = path.join(out, request.url === '/' ? 'index.html' : decodeURIComponent(request.url));
            if (!file.startsWith(out) || !fs.existsSync(file)) return response.writeHead(404).end();
            response.writeHead(200, {
                'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html',
                ...isolated && { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
            });
            fs.createReadStream(file).pipe(response);
        }).listen(0);
        const page = await browser.newPage();
        let workers = 0;
        page.on('worker', () => workers++);
        page.on('pageerror', e => console.log('page error:', e.message));
        await page.goto(`http://localhost:${server.address().port}/`);
        await page.waitForFunction(() => globalThis.results, null, { timeout: 120000 });
        const r = await page.evaluate(() => globalThis.results);
        await page.close();
        server.close();
        const problems = [];
        if (r.error) problems.push(r.error);
        if (r.isolated !== isolated) problems.push(`crossOriginIsolated ${r.isolated}`);
        if (r.single !== r.threaded) problems.push('threads wrote a different file');
        if (r.jxlSingle !== r.jxlThreaded) problems.push('threads wrote a different JPEG XL');
        if (r.decodeSingle !== r.decodeThreaded) problems.push('threads decoded a JPEG XL differently');
        if (isolated ? workers < 2 : workers) problems.push(`${workers} workers started`);
        for (const [step, result] of Object.entries(r.smoke ?? {})) if (String(result).startsWith('FAIL')) problems.push(`${step}: ${result}`);
        console.log(`${isolated ? 'cross-origin isolated' : 'not isolated'}: ${workers} workers, ${problems.length ? problems.join('\n  ') : 'ok'}`);
        if (problems.length) failed = true;
    }
} finally {
    await browser.close();
    fs.rmSync(out, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('browser passed');
