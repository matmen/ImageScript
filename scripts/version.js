// sets the package version and keeps its copies in sync: package.json, jsr.json and src/version.ts (reported in
// PNG metadata). The release workflow sets the version from the release tag, the build syncs the copies.
// usage: node scripts/version.js [version]   (without a version only the copies are synced to package.json)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const readJSON = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const writeJSON = (file, data) => fs.writeFileSync(path.join(root, file), JSON.stringify(data, null, 2) + '\n');

function setVersion(version) {
    const pkg = readJSON('package.json');
    if (version && pkg.version !== version) writeJSON('package.json', { ...pkg, version });
    version = version || pkg.version;

    const jsr = readJSON('jsr.json');
    if (jsr.version !== version) writeJSON('jsr.json', { ...jsr, version });

    const file = path.join(root, 'src/version.ts');
    const source = `// kept in sync with package.json by scripts/version.js\nexport const VERSION = '${version}';\n`;
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== source) fs.writeFileSync(file, source);
    return version;
}

if (require.main === module) {
    const version = process.argv[2];
    if (version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) {
        console.error(`invalid version ${version}`);
        process.exit(1);
    }
    console.log(setVersion(version));
}

module.exports = { setVersion };
