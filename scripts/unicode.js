// Generates src/render/unicode-data.ts from the Unicode Character Database: node scripts/unicode.js <ucd directory>
// (the files of https://www.unicode.org/Public/UCD/latest/ucd/, with the auxiliary, extracted and emoji folders)
//
// Every property is a list of ranges of code points with their value (ranges of the default value left out),
// varint encoded (gap to the previous range, length, value) and stored as base64, decoded when first used
const fs = require('fs');
const path = require('path');

const ucd = process.argv[2];
if (!ucd) throw new Error('usage: node scripts/unicode.js <ucd directory>');
const read = file => fs.readFileSync(path.join(ucd, file), 'utf8');
const SIZE = 0x110000;
const version = read('UnicodeData.txt') && (read('DerivedCoreProperties.txt').match(/DerivedCoreProperties-([\d.]+)\.txt/) || [])[1];

const range = text => {
    const [start, end] = text.trim().split('..').map(h => parseInt(h, 16));
    return [start, end ?? start];
};

// long value names -> short ones per property (the @missing lines use the long ones)
const aliases = new Map();
for (const line of read('PropertyValueAliases.txt').split('\n')) {
    const content = line.split('#')[0].trim();
    if (!content) continue;
    const [property, short, long, ...more] = content.split(';').map(f => f.trim());
    for (const name of [long, ...more]) aliases.set(`${property}:${name}`, short);
}

// a property file with "range ; value" lines (field picks the value column), @missing lines set defaults (alias is
// the property's short name, to translate their long value names)
function property(file, { field = 1, filter = null, defaultValue, alias = null } = {}) {
    const values = new Array(SIZE).fill(defaultValue);
    const text = read(file);
    for (const line of text.split('\n')) {
        const missing = line.match(/^#\s*@missing:\s*([0-9A-F.]+)\s*;\s*(?:InCB\s*;\s*)?([^;#]+)/);
        if (missing) {
            const [start, end] = range(missing[1]);
            const name = missing[2].trim();
            values.fill(alias && aliases.get(`${alias}:${name}`) || name, start, end + 1);
        }
    }
    for (const line of text.split('\n')) {
        const content = line.split('#')[0].trim();
        if (!content) continue;
        const fields = content.split(';').map(f => f.trim());
        if (filter && !filter(fields)) continue;
        const [start, end] = range(fields[0]);
        values.fill(fields[field], start, end + 1);
    }
    return values;
}

// UnicodeData.txt: a field per code point, "First>"/"Last>" pairs for ranges
function unicodeData(field, defaultValue) {
    const values = new Array(SIZE).fill(defaultValue);
    let first = -1;
    for (const line of read('UnicodeData.txt').split('\n')) {
        if (!line) continue;
        const fields = line.split(';'), code = parseInt(fields[0], 16);
        if (fields[1].endsWith(', First>')) first = code;
        else if (fields[1].endsWith(', Last>')) values.fill(fields[field], first, code + 1);
        else values[code] = fields[field];
    }
    return values;
}

// ranges of equal values (the default left out) -> { values, data }
function encode(values, defaultValue) {
    const names = [defaultValue, ...[...new Set(values)].filter(v => v !== defaultValue).sort()];
    const index = new Map(names.map((name, i) => [name, i]));
    const bytes = [];
    const varint = n => {
        for (; n >= 128; n = Math.floor(n / 128)) bytes.push(n & 127 | 128);
        bytes.push(n);
    };
    let previous = 0, ranges = 0;
    for (let start = 0; start < SIZE;) {
        let end = start;
        while (end + 1 < SIZE && values[end + 1] === values[start]) end++;
        if (values[start] !== defaultValue) {
            varint(start - previous);
            varint(end - start);
            varint(index.get(values[start]));
            previous = end + 1;
            ranges++;
        }
        start = end + 1;
    }
    return { names, data: Buffer.from(bytes).toString('base64'), ranges };
}

const tables = {};
const add = (name, description, values, defaultValue) => {
    tables[name] = { description, ...encode(values, defaultValue) };
};

const gc = unicodeData(2, 'Cn');
add('generalCategory', 'General_Category', gc, 'Cn');
add('combiningClass', 'Canonical_Combining_Class', unicodeData(3, '0'), '0');
add('bidiClass', 'Bidi_Class', property('extracted/DerivedBidiClass.txt', { defaultValue: 'L', alias: 'bc' }), 'L');
add('lineBreak', 'Line_Break', property('LineBreak.txt', { defaultValue: 'XX', alias: 'lb' }), 'XX');
add('eastAsianWidth', 'East_Asian_Width', property('EastAsianWidth.txt', { defaultValue: 'N', alias: 'ea' }), 'N');
add('script', 'Script', property('Scripts.txt', { defaultValue: 'Unknown' }), 'Unknown');
add('graphemeBreak', 'Grapheme_Cluster_Break', property('auxiliary/GraphemeBreakProperty.txt', { defaultValue: 'XX', alias: 'GCB' }), 'XX');
add('conjunctBreak', 'Indic_Conjunct_Break', property('DerivedCoreProperties.txt', { field: 2, filter: f => f[1] === 'InCB', defaultValue: 'None' }), 'None');
add('extendedPictographic', 'Extended_Pictographic', property('emoji/emoji-data.txt', { filter: f => f[1] === 'Extended_Pictographic', defaultValue: 'No' }), 'No');
add('indicSyllabic', 'Indic_Syllabic_Category', property('IndicSyllabicCategory.txt', { defaultValue: 'Other' }), 'Other');
add('indicPositional', 'Indic_Positional_Category', property('IndicPositionalCategory.txt', { defaultValue: 'NA' }), 'NA');

// joining types: listed ones, else T for marks and format characters, else U (ArabicShaping.txt header)
const joining = gc.map(c => c === 'Mn' || c === 'Me' || c === 'Cf' ? 'T' : 'U');
for (const line of read('ArabicShaping.txt').split('\n')) {
    const content = line.split('#')[0].trim();
    if (!content) continue;
    const fields = content.split(';').map(f => f.trim());
    joining[parseInt(fields[0], 16)] = fields[2];
}
add('joiningType', 'Joining_Type', joining, 'U');

// paired brackets and mirrored glyphs as pairs of code points
const brackets = [];
for (const line of read('BidiBrackets.txt').split('\n')) {
    const content = line.split('#')[0].trim();
    if (!content) continue;
    const [code, pair, type] = content.split(';').map(f => f.trim());
    brackets.push([parseInt(code, 16), parseInt(pair, 16), type === 'o' ? 1 : 2]);
}
const mirrors = [];
for (const line of read('BidiMirroring.txt').split('\n')) {
    const content = line.split('#')[0].trim();
    if (!content) continue;
    const [code, mirror] = content.split(';').map(f => parseInt(f.trim(), 16));
    mirrors.push([code, mirror]);
}

let out = `/*!
 * Generated by scripts/unicode.js from the Unicode Character Database ${version}, don't edit. The data is
 * Copyright © 1991-${new Date().getUTCFullYear()} Unicode, Inc., Unicode License v3 (see THIRD_PARTY_NOTICES.md and
 * licenses/Unicode-3.0.txt)
 */

/** a property: the names of its values (the first is the default) and its ranges (see scripts/unicode.js) */
export interface EncodedProperty {
    names: string[];
    data: string;
}

export const UNICODE_VERSION = '${version}';
`;
for (const [name, t] of Object.entries(tables))
    out += `\n/** ${t.description} (${t.ranges} ranges) */\nexport const ${name}: EncodedProperty = {\n    names: ${JSON.stringify(t.names)},\n    data: '${t.data}'\n};\n`;
out += `\n/** Bidi_Paired_Bracket: [code point, its pair, 1 opening / 2 closing] */\nexport const brackets: number[] = ${JSON.stringify(brackets.flat())};\n`;
out += `\n/** Bidi_Mirroring_Glyph: [code point, its mirror] */\nexport const mirrors: number[] = ${JSON.stringify(mirrors.flat())};\n`;

fs.writeFileSync(path.join(__dirname, '../src/render/unicode-data.ts'), out);
for (const [name, t] of Object.entries(tables)) console.log(name.padEnd(22), String(t.ranges).padStart(6), 'ranges', String(t.data.length).padStart(7), 'bytes', t.names.length, 'values');
console.log('total', out.length, 'bytes');
