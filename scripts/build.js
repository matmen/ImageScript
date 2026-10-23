// builds dist (ES modules and type declarations) from src
// CommonJS consumers load it through require(esm), available since Node 22.12
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const tsc = require.resolve('typescript/bin/tsc');
const run = args => execFileSync(process.execPath, [tsc, ...args], { cwd: root, stdio: 'inherit' });

// keep the version in PNG metadata and the one JSR publishes in sync with package.json
require('./version.js').setVersion();

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
// declarations keep the doc comments (editors show them), the JavaScript doesn't need them
run(['-p', 'tsconfig.json', '--emitDeclarationOnly']);
// --source-maps (npm run coverage) maps the built JavaScript back to src
run(['-p', 'tsconfig.json', '--declaration', 'false', '--removeComments', ...process.argv.includes('--source-maps') ? ['--sourceMap'] : []]);

// declarations keep the .ts import specifiers of the sources, point them at the built files
const rewrite = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) rewrite(file);
        else if (file.endsWith('.d.ts'))
            fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(from '\.{1,2}\/[^']*)\.ts'/g, "$1.js'"));
    }
};
rewrite(path.join(root, 'dist'));

// only the declarations the public ones import are needed (the exports field hides the other modules)
const needed = new Set();
const follow = file => {
    if (needed.has(file)) return;
    needed.add(file);
    for (const [, specifier] of fs.readFileSync(file, 'utf8').matchAll(/(?:from |import\()'(\.{1,2}\/[^']*)\.js'/g))
        follow(path.join(path.dirname(file), specifier + '.d.ts'));
};
follow(path.join(root, 'dist/index.d.ts'));
const prune = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) prune(file);
        else if (file.endsWith('.d.ts') && !needed.has(file)) fs.rmSync(file);
    }
};
prune(path.join(root, 'dist'));

// the package itself has no "type", so mark the build as ES modules
fs.writeFileSync(path.join(root, 'dist/package.json'), '{"type":"module"}\n');
