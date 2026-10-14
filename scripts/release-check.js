// checks a GitHub release before it is published to npm, run by .github/workflows/release.yml:
// the tag matches package.json, the version is valid semver, newer than what npm has and listed in the changelog,
// prereleases are marked as such. Prints the npm dist-tag to publish under (and writes it to GITHUB_OUTPUT)
// usage: node scripts/release-check.js <tag> [prerelease flag of the GitHub release: true/false]
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { name, version } = require('../package.json');
const [tag = '', prereleaseFlag = 'false'] = process.argv.slice(2);

const errors = [];
const fail = message => errors.push(message);

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parse(v) {
    const m = SEMVER.exec(v);
    return m && { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

// semver precedence: -1, 0 or 1
function compare(a, b) {
    for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
    // a prerelease comes before its release
    if (!a.pre.length && !b.pre.length) return 0;
    if (!a.pre.length) return 1;
    if (!b.pre.length) return -1;
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const x = a.pre[i], y = b.pre[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (x === y) continue;
        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
        if (nx && ny) return +x < +y ? -1 : 1;
        if (nx !== ny) return nx ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

async function main() {
    const current = parse(version);
    if (!current) fail(`package.json version ${version} is not valid semver`);
    if (tag !== `v${version}`) fail(`release tag ${tag || '(none)'} doesn't match package.json, expected v${version}`);

    const prerelease = prereleaseFlag === 'true';
    if (current && prerelease !== current.pre.length > 0)
        fail(current.pre.length ? `${version} is a prerelease version, mark the GitHub release as prerelease`
            : `the GitHub release is marked as prerelease, but ${version} has no prerelease suffix (like -beta.1)`);

    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    if (!changelog.split('\n').some(line => /^##\s/.test(line) && line.replace(/^##\s+v?/, '').trim().split(/\s/)[0] === version))
        fail(`CHANGELOG.md has no "## ${version}" section`);

    // what npm has already
    const res = await fetch(`https://registry.npmjs.org/${name}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
    if (!res.ok && res.status !== 404) throw new Error(`npm registry answered ${res.status}`);
    const meta = res.ok ? await res.json() : { versions: {}, 'dist-tags': {} };
    const published = Object.keys(meta.versions).map(v => [v, parse(v)]).filter(([, p]) => p);
    const latest = meta['dist-tags'].latest && parse(meta['dist-tags'].latest);

    let distTag = 'latest';
    if (current) {
        const sameMajor = published.filter(([, p]) => p.major === current.major);
        const newest = sameMajor.reduce((a, b) => !a || compare(b[1], a[1]) > 0 ? b : a, null);
        if (meta.versions[version]) fail(`${name}@${version} is already published`);
        else if (newest && compare(current, newest[1]) <= 0)
            fail(`${version} isn't newer than ${newest[0]}, the newest published ${current.major}.x version`);

        // a skipped version is allowed (2.x was skipped on purpose), but likely a typo
        const base = newest ? newest[1] : latest;
        if (base && !meta.versions[version] && !current.pre.length && !base.pre.length) {
            const next = [`${base.major}.${base.minor}.${base.patch + 1}`, `${base.major}.${base.minor + 1}.0`, `${base.major + 1}.0.0`];
            const { major, minor, patch } = current;
            if (!next.includes(`${major}.${minor}.${patch}`))
                console.log(`::warning::${version} skips versions, the next ones after ${newest ? newest[0] : meta['dist-tags'].latest} would be ${next.join(', ')}`);
        }

        // prereleases never become latest (3.1.0-beta.1 goes to "beta"), neither do fixes for older major versions
        if (current.pre.length) distTag = /^[a-z]+$/i.test(current.pre[0]) ? current.pre[0].toLowerCase() : 'next';
        else if (latest && compare(current, latest) < 0) distTag = `v${current.major}-latest`;
    }

    if (errors.length) {
        for (const e of errors) console.error(`::error::${e}`);
        process.exit(1);
    }

    console.log(`${name}@${version} can be published under the dist-tag "${distTag}"`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `dist-tag=${distTag}\n`);
}

if (require.main === module) main().catch(e => {
    console.error(`::error::${e.message}`);
    process.exit(1);
});

module.exports = { parse, compare };
