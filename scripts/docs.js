// builds the documentation site into docs/ with typedoc, plus redirects from the pages of the old jsdoc site
// (imagescript.dev/Image.html#resize -> classes/Image.html#resize) so existing links keep working
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs');
const typedoc = path.join(path.dirname(require.resolve('typedoc/package.json')), 'bin/typedoc');

fs.rmSync(out, { recursive: true, force: true });
execFileSync(process.execPath, [typedoc], { cwd: root, stdio: 'inherit' });

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
