// Turns results.json (run.js) and installs.json (installs.js) into charts/*.svg and README.md
import fs from 'node:fs';

const results = JSON.parse(fs.readFileSync(new URL('./results.json', import.meta.url)));
const installs = JSON.parse(fs.readFileSync(new URL('./installs.json', import.meta.url)));
const { libraries, TEXT, TEXT_SIZE, SVG_WIDTH } = await import('./libs.js');
const LIBS = libraries.map(l => l.name);
const KIND = Object.fromEntries(libraries.map(l => [l.name, l.kind]));
const HIGHLIGHT = 'ImageScript 3';
fs.mkdirSync(new URL('./charts/', import.meta.url), { recursive: true });

// light and dark values of every color the charts use: one accent for ImageScript, neutral gray for the others
const STYLE = `
  .surface { fill: #fcfcfb } .text { fill: #0b0b0b } .muted { fill: #52514e } .grid { stroke: #e4e3df }
  .bar { fill: #8a8983 } .bar.highlight { fill: #2a78d6 }
  @media (prefers-color-scheme: dark) {
    .surface { fill: #1a1a19 } .text { fill: #f0efec } .muted { fill: #c3c2b7 } .grid { stroke: #383835 }
    .bar { fill: #6d6c66 } .bar.highlight { fill: #3987e5 }
  }
  text { font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif }
  .title { font-weight: 600; font-size: 14px } .bold { font-weight: 600 } .small { font-size: 11px }`;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const number = v => v >= 100 ? Math.round(v).toLocaleString('en') : v >= 10 ? v.toFixed(1) : v.toFixed(2);
const bytes = b => b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`;

// a bar whose data end (right) is rounded by 4px and whose baseline end (left) is square
const bar = (x, y, w, h, cls) => w <= 0 ? '' : w <= 4
    ? `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`
    : `<path class="${cls}" d="M${x},${y}h${w - 4}a4,4 0 0 1 4,4v${h - 8}a4,4 0 0 1 -4,4h${-(w - 4)}z"/>`;

/**
 * Groups of horizontal bars, one per measurement, each on its own scale (they range from a few to 100,000 per
 * second); libraries keep their row in every group, so they're easy to follow
 * @param groups [{ title, values: { library: number }, format }]
 */
function barChart(title, subtitle, groups, file) {
    const W = 760, labelW = 190, barW = 440, rowH = 22, barH = 14, groupGap = 18, pad = 20;
    let y = pad + 58, body = '';
    for (const group of groups) {
        const max = Math.max(...Object.values(group.values).filter(v => typeof v === 'number'));
        body += `<text class="text title" x="${pad}" y="${y}">${esc(group.title)}</text>`;
        if (group.note) body += `<text class="muted small" x="${W - pad}" y="${y}" text-anchor="end">${esc(group.note)}</text>`;
        y += 10;
        body += `<line class="grid" x1="${pad + labelW}" x2="${pad + labelW}" y1="${y}" y2="${y + LIBS.length * rowH}" stroke-width="1"/>`;
        for (const lib of LIBS) {
            const v = group.values[lib], hl = lib === HIGHLIGHT;
            const cy = y + rowH / 2;
            body += `<text class="${hl ? 'text bold' : 'muted'}" x="${pad + labelW - 10}" y="${cy + 4}" text-anchor="end">${esc(lib)}</text>`;
            if (typeof v !== 'number') body += `<text class="muted small" x="${pad + labelW + 8}" y="${cy + 4}">${esc(v ?? 'not supported')}</text>`;
            else {
                const w = Math.max(2, v / max * barW);
                body += bar(pad + labelW + 1, cy - barH / 2, w, barH, hl ? 'bar highlight' : 'bar');
                body += `<text class="${hl ? 'text bold' : 'text'}" x="${pad + labelW + w + 8}" y="${cy + 4}">${esc(group.format(v))}</text>`;
            }
            y += rowH;
        }
        y += groupGap;
    }
    const H = y + pad - groupGap + 10;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title><style>${STYLE}</style>
<rect class="surface" width="${W}" height="${H}" rx="8"/>
<text class="text title" x="${pad}" y="${pad + 8}" style="font-size:16px">${esc(title)}</text>
<text class="muted" x="${pad}" y="${pad + 26}">${esc(subtitle)}</text>
${body}
</svg>
`;
    fs.writeFileSync(new URL(`./charts/${file}`, import.meta.url), svg);
}

const SPEED = [
    ['decode JPEG', 'decode JPEG'], ['decode PNG', 'decode PNG'], ['decode WebP', 'decode WebP (lossy)'],
    ['encode JPEG', 'encode JPEG (quality 80)'], ['encode PNG', 'encode PNG'], ['encode WebP', 'encode WebP (lossless)'],
    ['resize', 'resize to half'], ['rotate', 'rotate by 30°'], ['blur', 'blur (radius 5)'],
    ['composite', 'composite an overlay'], ['crop', 'crop'], ['clone', 'clone'],
    ['text', 'render text'], ['svg', 'render SVG'],
    ['decode GIF', 'decode animated GIF'], ['encode GIF', 'encode animated GIF']
].filter(([key]) => results.speed[key]);
const ops = key => Object.fromEntries(Object.entries(results.speed[key]).map(([lib, r]) => [lib, r.error ? 'fails on this input' : r.opsPerSecond]));

const cpu = results.cpu.replace(/\((R|TM)\)|\bCPU\b|@.*$/g, '').replace(/\s+/g, ' ').trim();
const NOTES = { resize: 'ImageScript 1: nearest neighbor only, others bilinear' };
const split = (keys, file, title, input = 'on a 1920×1080 photo') => barChart(title, `operations per second ${input}, more is faster · Node.js ${results.node.match(/\d+/)[0]}, ${cpu}`,
    SPEED.filter(([key]) => keys.includes(key)).map(([key, label]) => ({ title: label, note: NOTES[key], values: ops(key), format: number })), file);
split(['decode JPEG', 'decode PNG', 'decode WebP', 'encode JPEG', 'encode PNG', 'encode WebP'], 'codecs.svg', 'Decoding and encoding');
split(['resize', 'rotate', 'blur', 'composite', 'crop', 'clone'], 'operations.svg', 'Image operations');
split(['text', 'svg'], 'rendering.svg', 'Rendering', `(text at ${TEXT_SIZE}px, SVG ${SVG_WIDTH} wide)`);
split(['decode GIF', 'encode GIF'], 'animation.svg', 'Animations', 'on a 300×300 GIF with 101 frames');

barChart('Install size', 'node_modules after npm install in an empty project (all dependencies and native binaries), less is better',
    [{ title: 'install size', values: Object.fromEntries(LIBS.map(l => [l, installs[l].bytes])), format: bytes }], 'install.svg');
barChart('File sizes', 'encoded with each library\'s default settings, less is better',
    Object.keys(results.sizes).map(key => ({ title: key.replace('JPEG', 'JPEG (quality 80)').replace('WebP', 'WebP (lossless)'), values: results.sizes[key], format: bytes })), 'sizes.svg');

// tables: the same numbers, to read exactly
const table = (rows, columns, cell) => [
    `| | ${columns.map(c => `**${c}**`).join(' | ')} |`,
    `|---|${columns.map(() => '--:').join('|')}|`,
    ...rows.map(([key, label]) => `| ${label} | ${columns.map(c => cell(key, c)).join(' | ')} |`)
].join('\n');
const speedCell = (key, lib) => { const r = results.speed[key][lib]; return r?.error ? 'fails' : r ? (lib === HIGHLIGHT ? `**${number(r.opsPerSecond)}**` : number(r.opsPerSecond)) : '–'; };

const readme = `# ImageScript benchmark

How [ImageScript](https://github.com/matmen/ImageScript) compares to other image libraries for Node.js: speed, file
sizes and what installing each takes. ImageScript is plain JavaScript with no dependencies, so it runs wherever
JavaScript does, like Jimp, image-js and PureJsImage; sharp and @napi-rs/canvas wrap native libraries (libvips, Skia),
Photon and ImageScript 1 are WebAssembly.

<img src="charts/install.svg" alt="Install size of each library">

<img src="charts/codecs.svg" alt="Decoding and encoding speed">

<img src="charts/operations.svg" alt="Speed of image operations">

<img src="charts/rendering.svg" alt="Text and SVG rendering speed">

<img src="charts/animation.svg" alt="Animated GIF decoding and encoding speed">

<img src="charts/sizes.svg" alt="Encoded file sizes">

## Numbers

Operations per second (more is faster), measured ${results.date} with Node.js ${results.node} on ${results.cpu}, ImageScript ${results.versions['ImageScript 3']}.

${table(SPEED, LIBS, speedCell)}

Encoded sizes:

${table(Object.keys(results.sizes).map(k => [k, k]), LIBS, (key, lib) => results.sizes[key][lib] ? bytes(results.sizes[key][lib]) : '–')}

| | ${LIBS.map(l => `**${l}**`).join(' | ')} |
|---|${LIBS.map(() => '---').join('|')}|
| kind | ${LIBS.map(l => KIND[l]).join(' | ')} |
| package | ${LIBS.map(l => `\`${installs[l].package}\``).join(' | ')} |
| install size | ${LIBS.map(l => bytes(installs[l].bytes)).join(' | ')} |
| packages | ${LIBS.map(l => installs[l].packages).join(' | ')} |

## Method

- Inputs (in \`inputs/\`, sources in [inputs/SOURCES.md](inputs/SOURCES.md)): a 1920×1080 photo (JPEG, and made from it
  when the benchmark starts, PNG and lossy WebP), a 1434×1434 graphic with transparency (PNG), a 445×445 diagram with
  transparency placed on the photo (PNG), a 300×300 GIF with 101 frames.
- Rendering: "${TEXT}" in Source Sans 3 at ${TEXT_SIZE}px, and \`tests/svgs/features.svg\` (gradients, clipping,
  CSS) at ${SVG_WIDTH} pixels wide. Jimp, image-js, PureJsImage and Photon can't render TrueType/OpenType fonts or SVGs; ImageScript 1 crashes
  on this SVG; @napi-rs/canvas (Skia's SVG module) ignores its CSS, so it draws a little less.
- Every operation starts from the same decoded image and returns a new one: libraries that change images in place
  clone first, sharp runs a pipeline from raw pixels back to raw pixels, PureJsImage (which has no decoded images) one
  from a BMP back to a BMP, @napi-rs/canvas draws into a new canvas. PureJsImage has no blur, composite, rendering or
  animated GIFs.
- Where the library lets you choose, resizing is bilinear (ImageScript 1 only has nearest neighbor), blurring is
  gaussian with a radius or sigma of 5, rotating grows the image to fit. Each library uses its own defaults
  otherwise, e.g. its PNG compression level.
- Threads: ImageScript uses worker threads where they pay off (the processors available, at most 8), and sharp gets
  as many (\`sharp.concurrency()\`; its default on glibc Linux without jemalloc, like on CI, is one). The other
  libraries run on one thread.
- [tinybench](https://github.com/tinylibs/tinybench), at least 1.5 seconds and 3 runs per measurement, every library
  in its own process.
- The release workflow runs the benchmark for every release and commits the results, on a GitHub Actions runner;
  runners vary, so compare libraries within one run rather than between runs.
- Install sizes: \`npm install <library>\` in an empty project, the apparent size of \`node_modules\`.

Run it: \`npm install\` in this directory, then \`node run.js\` (on an idle machine; \`IMAGESCRIPT=local\` measures
this checkout after \`npm run build\` instead of the version from npm), \`node installs.js\` and \`node report.js\`.
`;
fs.writeFileSync(new URL('./README.md', import.meta.url), readme);
console.log('charts/ and README.md written');
