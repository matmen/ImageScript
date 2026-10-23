// turns coverage/coverage-summary.json (npm run coverage) into coverage/report.md for the CI's job summary and
// comments: the totals and the files with the most untested lines, and with the summary of a base commit
// (node scripts/coverage-report.js <base summary> <base checkout>) how they changed and which files changed most
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// per file (relative to its checkout) the line, branch and function coverage, and the untested lines
const read = (file, checkout) => {
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
    const files = new Map();
    for (const [name, s] of Object.entries(summary))
        if (name !== 'total') files.set(path.relative(checkout, name), {...s, missing: s.lines.total - s.lines.covered});
    return {total: summary.total, files};
};

const head = read(path.join(root, 'coverage/coverage-summary.json'), root);
const base = process.argv[2] ? read(process.argv[2], process.argv[3]) : null;

const percent = ({pct}) => `${pct.toFixed(1)}%`;
const change = (now, before) => {
    if (!before) return '';
    const d = now.pct - before.pct;
    return Math.abs(d) < 0.05 ? '' : ` (${d > 0 ? '+' : ''}${d.toFixed(1)})`;
};
const row = (name, s, b) => `| ${name} | ${percent(s.lines)}${change(s.lines, b?.lines)} | ${percent(s.branches)}${change(s.branches, b?.branches)} | ${percent(s.functions)}${change(s.functions, b?.functions)} |`;
const header = ['| | Lines | Branches | Functions |', '|---|--:|--:|--:|'];

const report = ['<!-- coverage -->', '### Test coverage', ''];
if (base) report.push(`Compared with ${process.env.BASE_NAME || 'the base commit'}.`, '');
report.push(...header, row('**total**', head.total, base?.total));
const untested = [...head.files].sort((a, b) => b[1].missing - a[1].missing).slice(0, 10);
for (const [file, s] of untested) report.push(row(`\`${file}\` (${s.missing} lines untested)`, s, base?.files.get(file)));

if (base) {
    // the files whose line coverage changed, new and removed ones
    const changed = [];
    for (const [file, s] of head.files) {
        const b = base.files.get(file);
        if (!b) changed.push([file, Infinity, `| \`${file}\` (new) | ${percent(s.lines)} | ${percent(s.branches)} | ${percent(s.functions)} |`]);
        else if (Math.abs(s.lines.pct - b.lines.pct) >= 0.05) changed.push([file, Math.abs(s.lines.pct - b.lines.pct), row(`\`${file}\``, s, b)]);
    }
    for (const file of base.files.keys()) if (!head.files.has(file)) changed.push([file, Infinity, `| \`${file}\` (removed) | | | |`]);
    changed.sort((a, b) => b[1] - a[1]);
    report.push('', changed.length ? '#### Changed' : 'No file\'s line coverage changed.');
    if (changed.length) report.push('', ...header, ...changed.slice(0, 20).map(c => c[2]));
    if (changed.length > 20) report.push('', `and ${changed.length - 20} more`);
}
report.push('');

fs.writeFileSync(path.join(root, 'coverage/report.md'), report.join('\n'));
console.log(report.join('\n'));
