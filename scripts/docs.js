// builds the documentation site into docs/ with typedoc, then adds what typedoc can't: a description and link previews
// (Open Graph) on every page, the icons browsers look for at the root, the README's wordmark following the docs' theme,
// and redirects from the pages of the old jsdoc site (imagescript.dev/Image.html#resize -> classes/Image.html#resize)
// so existing links keep working
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs');
const typedoc = path.join(path.dirname(require.resolve('typedoc/package.json')), 'bin/typedoc');

fs.rmSync(out, { recursive: true, force: true });
execFileSync(process.execPath, [typedoc], { cwd: root, stdio: 'inherit' });

const site = 'https://imagescript.dev/';
const description = 'Pure TypeScript image processing that runs everywhere: Node.js, Deno, Bun, browsers and edge runtimes';
for (const file of ['favicon.ico', 'apple-touch-icon.png', 'social-preview.png'])
    fs.copyFileSync(path.join(root, 'media', file), path.join(out, file));

const escape = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const pages = fs.readdirSync(out, { recursive: true }).filter(file => file.endsWith('.html'));
for (const page of pages) {
    const file = path.join(out, page);
    let html = fs.readFileSync(file, 'utf8');
    const title = html.match(/<title>(.*?)<\/title>/)?.[1] ?? 'ImageScript';
    const url = site + page.split(path.sep).join('/').replace(/^index\.html$/, '');
    html = html.replace(/<meta name="description" content="[^"]*"\/>/, `<meta name="description" content="${escape(description)}"/>`);
    html = html.replace('</head>', [
        `<meta property="og:type" content="website"/>`,
        `<meta property="og:site_name" content="ImageScript"/>`,
        `<meta property="og:title" content="${title}"/>`,
        `<meta property="og:description" content="${escape(description)}"/>`,
        `<meta property="og:url" content="${url}"/>`,
        `<meta property="og:image" content="${site}social-preview.png"/>`,
        `<meta property="og:image:width" content="1280"/>`,
        `<meta property="og:image:height" content="640"/>`,
        `<meta name="twitter:card" content="summary_large_image"/>`,
        `<link rel="icon" href="/favicon.ico" sizes="48x48"/>`,
        `<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>`,
        '</head>'
    ].join(''));
    // (a <picture> follows the OS's color scheme, the docs have a theme setting of their own: two images, docs.css
    // shows the one for the theme)
    html = html.replace(/<picture>\s*<source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)"\/?>\s*<img ([^>]*?)src="([^"]+)"([^>]*)>\s*<\/picture>/g,
        (_, dark, before, light, after) => `<img ${before}src="${light}"${after} class="wordmark-light"><img ${before}src="${dark}"${after} class="wordmark-dark">`);
    fs.writeFileSync(file, html);
}

// jsdoc anchors were the member names, prefixed with '.' for static members; typedoc lowercases them.
// global.html only documented decode(), which has a page of its own now
const redirects = {
    'Image.html': ['classes/Image.html', true],
    'Frame.html': ['classes/Frame.html', true],
    'GIF.html': ['classes/GIF.html', true],
    'TextLayout.html': ['classes/TextLayout.html', true],
    'global.html': ['functions/decode.html', false]
};

for (const [from, [to, keepAnchor]] of Object.entries(redirects)) {
    const anchor = keepAnchor ? ` + location.hash.replace(/^#+\\.?/, '#').toLowerCase()` : '';
    fs.writeFileSync(path.join(out, from), `<!doctype html>
<meta charset="utf-8">
<title>Moved</title>
<link rel="canonical" href="${to}">
<noscript><meta http-equiv="refresh" content="0; url=${to}"></noscript>
<script>location.replace('${to}'${anchor});</script>
<p>This page moved to <a href="${to}">${to}</a>.</p>
`);
}
