// Measures what installing each library takes: npm install <package>@<version> in an empty project (the versions
// installed here), then the apparent size of node_modules and the number of packages in it. Writes installs.json
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { libraries } from './libs.js';

const size = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const p = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? size(p) : entry.isFile() ? fs.statSync(p).size : 0);
}, 0);

const installs = {};
for (const lib of libraries) {
    const installed = JSON.parse(fs.readFileSync(new URL(`./node_modules/${lib.package}/package.json`, import.meta.url)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagescript-bench-'));
    try {
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        execFileSync('npm', ['install', `${installed.name}@${installed.version}`, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio: 'inherit' });
        const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json')));
        installs[lib.name] = {
            package: `${installed.name}@${installed.version}`,
            bytes: size(path.join(dir, 'node_modules')),
            // the lockfile also lists optional packages for other platforms, which aren't installed
            packages: Object.keys(lock.packages).filter(p => p.startsWith('node_modules/') && fs.existsSync(path.join(dir, p))).length
        };
        console.log(lib.name, installs[lib.name]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
fs.writeFileSync(new URL('./installs.json', import.meta.url), JSON.stringify(installs, null, 2) + '\n');
