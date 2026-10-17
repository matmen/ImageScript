// Generates src/render/unicode-data.ts from the Unicode Character Database: node scripts/unicode.js <ucd directory>
// (the files of https://www.unicode.org/Public/UCD/latest/ucd/, with the auxiliary, extracted and emoji folders), and
// Microsoft's Universal Shaping Engine data in scripts/ms-use. The shaping categories follow HarfBuzz's table generators
// (gen-indic-table.py, gen-use-table.py, gen-vowel-constraints.py; Copyright © HarfBuzz contributors, Old MIT license,
// see THIRD_PARTY_NOTICES.md)
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
// the property's short name, to translate long value names to the short ones)
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
        values.fill(alias && aliases.get(`${alias}:${fields[field]}`) || fields[field], start, end + 1);
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
add('script', 'Script (ISO 15924 codes)', property('Scripts.txt', { defaultValue: 'Unknown' }).map(v => aliases.get(`sc:${v}`) ?? v), 'Zzzz');
add('graphemeBreak', 'Grapheme_Cluster_Break', property('auxiliary/GraphemeBreakProperty.txt', { defaultValue: 'XX', alias: 'GCB' }), 'XX');
add('conjunctBreak', 'Indic_Conjunct_Break', property('DerivedCoreProperties.txt', { field: 2, filter: f => f[1] === 'InCB', defaultValue: 'None' }), 'None');
add('extendedPictographic', 'Extended_Pictographic', property('emoji/emoji-data.txt', { filter: f => f[1] === 'Extended_Pictographic', defaultValue: 'No' }), 'No');

// joining types of ArabicShaping.txt, X for the others (transparent for marks and format characters, else
// non-joining: decided by the shaper)
const joining = new Array(SIZE).fill('X');
for (const line of read('ArabicShaping.txt').split('\n')) {
    const content = line.split('#')[0].trim();
    if (!content) continue;
    const fields = content.split(';').map(f => f.trim());
    // (the Syriac joining groups Alaph and Dalath Rish join differently)
    joining[parseInt(fields[0], 16)] = fields[3] === 'ALAPH' ? 'ALAPH' : fields[3] === 'DALATH RISH' ? 'DALATH_RISH' : fields[2];
}
add('joiningType', 'Joining_Type (and the Syriac joining groups ALAPH, DALATH_RISH; X if not listed)', joining, 'X');

// the categories of the Indic shapers (Indic, Khmer, Myanmar) and the Universal Shaping Engine, after HarfBuzz's
// gen-indic-table.py and gen-use-table.py (with Microsoft's additions in scripts/ms-use)
const msUse = file => fs.readFileSync(path.join(__dirname, 'ms-use', file), 'utf8');
const listed = (text, field = 1) => {
    const map = new Map();
    for (const line of text.split('\n')) {
        const content = line.split('#')[0].trim();
        if (!content) continue;
        const fields = content.split(';').map(f => f.trim());
        if (fields.length < 2) continue;
        const [start, end] = range(fields[0]);
        for (let u = start; u <= end; u++) map.set(u, fields[field]);
    }
    return map;
};
// the code points with a binary property (files list several properties, a code point can have more than one)
const withProperty = (text, name) => {
    const set = new Set();
    for (const line of text.split('\n')) {
        const fields = line.split('#')[0].split(';').map(f => f.trim());
        if (fields[1] !== name) continue;
        const [start, end] = range(fields[0]);
        for (let u = start; u <= end; u++) set.add(u);
    }
    return set;
};
const syllabic = listed(read('IndicSyllabicCategory.txt')), positional = listed(read('IndicPositionalCategory.txt'));
const blocks = listed(read('Blocks.txt'));
const blockOf = u => blocks.get(u) ?? 'No_Block';

const INDIC_SINGLES = [0x00a0, 0x25cc];
const INDIC_BLOCKS = new Set(['Basic Latin', 'Latin-1 Supplement', 'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada',
    'Malayalam', 'Myanmar', 'Khmer', 'Vedic Extensions', 'General Punctuation', 'Superscripts and Subscripts', 'Devanagari Extended', 'Myanmar Extended-B',
    'Myanmar Extended-A', 'Myanmar Extended-C']);
const INDIC_CATEGORY = { Other: 'X', Avagraha: 'Symbol', Bindu: 'SM', Brahmi_Joining_Number: 'PLACEHOLDER', Cantillation_Mark: 'A', Consonant: 'C',
    Consonant_Dead: 'C', Consonant_Final: 'CM', Consonant_Head_Letter: 'C', Consonant_Initial_Postfixed: 'C', Consonant_Killer: 'M', Consonant_Medial: 'CM',
    Consonant_Placeholder: 'PLACEHOLDER', Consonant_Preceding_Repha: 'Repha', Consonant_Prefixed: 'X', Consonant_Subjoined: 'CM',
    Consonant_Succeeding_Repha: 'CM', Consonant_With_Stacker: 'CS', Gemination_Mark: 'SM', Invisible_Stacker: 'H', Joiner: 'ZWJ', Modifying_Letter: 'X',
    Non_Joiner: 'ZWNJ', Nukta: 'N', Number: 'PLACEHOLDER', Number_Joiner: 'PLACEHOLDER', Pure_Killer: 'M', Register_Shifter: 'RS', Syllable_Modifier: 'SM',
    Tone_Letter: 'X', Tone_Mark: 'N', Virama: 'H', Visarga: 'SM', Vowel: 'V', Vowel_Dependent: 'M', Vowel_Independent: 'V' };
const INDIC_POSITION = { Not_Applicable: 'END', Left: 'PRE_C', Top: 'ABOVE_C', Bottom: 'BELOW_C', Right: 'POST_C', Bottom_And_Right: 'POST_C',
    Left_And_Right: 'POST_C', Top_And_Bottom: 'BELOW_C', Top_And_Bottom_And_Left: 'BELOW_C', Top_And_Bottom_And_Right: 'POST_C', Top_And_Left: 'ABOVE_C',
    Top_And_Left_And_Right: 'POST_C', Top_And_Right: 'POST_C', Overstruck: 'AFTER_MAIN', Visual_order_left: 'PRE_M' };
const INDIC_OVERRIDES = {};
const override = (category, ...codepoints) => { for (const u of codepoints) INDIC_OVERRIDES[u] = category; };
override('VS', ...Array.from({ length: 16 }, (_, i) => 0xfe00 + i));
override('PLACEHOLDER', 0x2015, 0x2022, 0x25fb, 0x25fc, 0x25fd, 0x25fe, 0x09fc, 0x0c80, 0x0d04, 0x17d9, 0x104a);
override('Ra', 0x0930, 0x09b0, 0x09f0, 0x0a30, 0x0ab0, 0x0b30, 0x0bb0, 0x0c30, 0x0cb0, 0x0d30, 0x179a, 0x1004, 0x101b, 0x105a);
override('SM', 0x0953, 0x0954, 0x11301, 0x11302, 0x11303, 0x1038, 0x1087, 0x1088, 0x1089, 0x108a, 0x108b, 0x108c, 0x108d, 0x108f, 0x109a, 0x109b, 0x109c);
override('MPst', 0x0a40);
override('C', 0x0a72, 0x0a73, 0x104e);
override('A', 0x1ce2, 0x1ce3, 0x1ce4, 0x1ce5, 0x1ce6, 0x1ce7, 0x1ce8, 0x1ced, 0x1032, 0x1036);
override('Symbol', 0xa8f2, 0xa8f3, 0xa8f4, 0xa8f5, 0xa8f6, 0xa8f7, 0x1ce9, 0x1cea, 0x1ceb, 0x1cec, 0x1cee, 0x1cef, 0x1cf0, 0x1cf1);
override('M', 0x0a51);
override('N', 0x1133b, 0x1133c, 0x0afb, 0x0b55);
override('DOTTEDCIRCLE', 0x25cc);
override('Robatic', 0x17cc, 0x17c9, 0x17ca);
override('Xgroup', 0x17c6, 0x17cb, 0x17cd, 0x17ce, 0x17cf, 0x17d0, 0x17d1);
override('Ygroup', 0x17c7, 0x17c8, 0x17dd, 0x17d3);
override('As', 0x103a);
override('MH', 0x103e);
override('ML', 0x1060);
override('MR', 0x103c);
override('MW', 0x103d, 0x1082);
override('MY', 0x103b, 0x105e, 0x105f);
override('PT', 0x1063, 0x1064, 0x1069, 0x106a, 0x106b, 0x106c, 0x106d, 0xaa7b);
const INDIC_POSITION_OVERRIDES = { 0x0a51: 'BELOW_C', 0x0b01: 'BEFORE_SUB' };

const matraPosition = (u, position, block) => {
    if (position === 'PRE_C') return 'PRE_M';
    if (position === 'POST_C') return { Devanagari: 'AFTER_SUB', Bengali: 'AFTER_POST', Gurmukhi: 'AFTER_POST', Gujarati: 'AFTER_POST', Oriya: 'AFTER_POST',
        Tamil: 'AFTER_POST', Telugu: u <= 0x0c42 ? 'BEFORE_SUB' : 'AFTER_SUB', Kannada: u < 0x0cc3 || u > 0x0cd6 ? 'BEFORE_SUB' : 'AFTER_SUB',
        Malayalam: 'AFTER_POST' }[block] ?? 'AFTER_SUB';
    if (position === 'ABOVE_C') return { Devanagari: 'AFTER_SUB', Gurmukhi: 'AFTER_POST', Gujarati: 'AFTER_SUB', Oriya: 'AFTER_MAIN', Tamil: 'AFTER_SUB',
        Telugu: 'BEFORE_SUB', Kannada: 'BEFORE_SUB' }[block] ?? 'AFTER_SUB';
    if (position === 'BELOW_C') return { Devanagari: 'AFTER_SUB', Bengali: 'AFTER_SUB', Gurmukhi: 'AFTER_POST', Gujarati: 'AFTER_POST', Oriya: 'AFTER_SUB',
        Tamil: 'AFTER_POST', Telugu: 'BEFORE_SUB', Kannada: 'BEFORE_SUB', Malayalam: 'AFTER_POST' }[block] ?? 'AFTER_SUB';
    throw new Error(`matra position ${position}`);
};

const indic = new Array(SIZE).fill('X/END');
{
    const data = new Map();
    for (const u of new Set([...syllabic.keys(), ...positional.keys()])) {
        const block = blockOf(u);
        if (!INDIC_SINGLES.includes(u) && !INDIC_BLOCKS.has(block)) continue;
        let category = INDIC_CATEGORY[syllabic.get(u) ?? 'Other'];
        const position = positional.get(u) ?? 'Not_Applicable';
        if (category === 'SM' && position === 'Not_Applicable') category = 'SMPst';
        data.set(u, [category, INDIC_POSITION[position], block]);
    }
    for (const [u, category] of Object.entries(INDIC_OVERRIDES)) {
        const [, position] = data.get(+u) ?? ['X', 'END'];
        data.set(+u, [category, position, blockOf(+u)]);
    }
    for (const [u, [category, position, block]] of data) {
        let c = category, p = position;
        if (!['CM', 'SM', 'RS', 'H', 'M', 'MPst'].includes(c)) p = 'END';
        if (['C', 'CS', 'Ra', 'CM', 'V', 'PLACEHOLDER', 'DOTTEDCIRCLE'].includes(c)) p = 'BASE_C';
        else if (c === 'M' || c === 'MPst') {
            if (block.startsWith('Khmer') || block.startsWith('Myanmar')) c = { PRE_C: 'VPre', ABOVE_C: 'VAbv', BELOW_C: 'VBlw', POST_C: 'VPst' }[p];
            else p = matraPosition(u, p, block);
        } else if (['SM', 'SMPst', 'VD', 'A', 'Symbol'].includes(c)) p = 'SMVD';
        data.set(u, [c, p, block]);
    }
    for (const [u, position] of Object.entries(INDIC_POSITION_OVERRIDES)) {
        const [category] = data.get(+u) ?? ['X'];
        data.set(+u, [category, position, blockOf(+u)]);
    }
    for (const [u, [category, position]] of data) indic[u] = `${category}/${position}`;
}

// the Universal Shaping Engine's categories
const use = new Array(SIZE).fill('O');
{
    const additionalSyllabic = listed(msUse('IndicSyllabicCategory-Additional.txt')), additionalPositional = listed(msUse('IndicPositionalCategory-Additional.txt'));
    const joiningTypes = listed(read('ArabicShaping.txt'), 2);
    const ignorable = withProperty(read('DerivedCoreProperties.txt'), 'Default_Ignorable_Code_Point');
    // (general categories of UnicodeData.txt's lines, the ranges aren't expanded, like HarfBuzz's generator)
    const categories = listed(read('UnicodeData.txt'), 2);
    const scripts = listed(read('Scripts.txt'));
    for (const [u, v] of additionalSyllabic) syllabic.set(u, v === 'Consonant_Final_Modifier' ? 'Syllable_Modifier' : v);
    for (const [u, v] of additionalPositional) positional.set(u, v === 'NA' ? 'Not_Applicable' : v);
    const DISABLED = new Set(['Arabic', 'Lao', 'Samaritan', 'Syriac', 'Thai']);

    const is = {
        BASE: (U, ISC, UDI, GC, JT) => ['Number', 'Consonant', 'Consonant_Head_Letter', 'Tone_Letter', 'Vowel_Independent'].includes(ISC)
            || ['C', 'D', 'L', 'R'].includes(JT) && ISC !== 'Joiner'
            || GC === 'Lo' && ['Avagraha', 'Bindu', 'Consonant_Final', 'Consonant_Medial', 'Consonant_Subjoined', 'Vowel', 'Vowel_Dependent'].includes(ISC),
        BASE_NUM: (U, ISC) => ISC === 'Brahmi_Joining_Number',
        BASE_OTHER: (U, ISC) => ISC === 'Consonant_Placeholder' || [0x2015, 0x2022, 0x25fb, 0x25fc, 0x25fd, 0x25fe].includes(U),
        CGJ: (U, ISC, UDI, GC) => ISC === 'Joiner' || UDI && ['Mc', 'Me', 'Mn'].includes(GC),
        CONS_FINAL: (U, ISC, UDI, GC) => ISC === 'Consonant_Final' && GC !== 'Lo' || ISC === 'Consonant_Succeeding_Repha',
        CONS_FINAL_MOD: (U, ISC) => ISC === 'Syllable_Modifier',
        CONS_MED: (U, ISC, UDI, GC) => ISC === 'Consonant_Medial' && GC !== 'Lo' || ISC === 'Consonant_Initial_Postfixed',
        CONS_MOD: (U, ISC) => ['Nukta', 'Gemination_Mark', 'Consonant_Killer'].includes(ISC),
        CONS_SUB: (U, ISC, UDI, GC) => ISC === 'Consonant_Subjoined' && GC !== 'Lo',
        CONS_WITH_STACKER: (U, ISC) => ISC === 'Consonant_With_Stacker',
        HALANT: (U, ISC) => ISC === 'Virama' && U !== 0x0dca,
        HALANT_OR_VOWEL_MODIFIER: U => U === 0x0dca,
        HALANT_NUM: (U, ISC) => ISC === 'Number_Joiner',
        HIEROGLYPH: (U, ISC) => ISC === 'Hieroglyph',
        HIEROGLYPH_JOINER: (U, ISC) => ISC === 'Hieroglyph_Joiner',
        HIEROGLYPH_MIRROR: (U, ISC) => ISC === 'Hieroglyph_Mirror',
        HIEROGLYPH_MOD: (U, ISC) => ISC === 'Hieroglyph_Modifier',
        HIEROGLYPH_SEGMENT_BEGIN: (U, ISC) => ['Hieroglyph_Mark_Begin', 'Hieroglyph_Segment_Begin'].includes(ISC),
        HIEROGLYPH_SEGMENT_END: (U, ISC) => ['Hieroglyph_Mark_End', 'Hieroglyph_Segment_End'].includes(ISC),
        INVISIBLE_STACKER: (U, ISC) => ISC === 'Invisible_Stacker' && U !== 0x1a60,
        ZWNJ: (U, ISC) => ISC === 'Non_Joiner',
        OTHER: (...a) => (a[3] === 'Po' || ['Consonant_Dead', 'Joiner', 'Modifying_Letter', 'Other'].includes(a[1]))
            && !is.BASE(...a) && !is.BASE_OTHER(...a) && !is.CGJ(...a) && !is.SYM_MOD(...a) && !is.Word_Joiner(...a),
        REORDERING_KILLER: (U, ISC) => ISC === 'Reordering_Killer',
        REPHA: (U, ISC) => ['Consonant_Preceding_Repha', 'Consonant_Prefixed'].includes(ISC),
        SAKOT: U => U === 0x1a60,
        SYM_MOD: (U, ISC) => ISC === 'Symbol_Modifier',
        VOWEL: (U, ISC, UDI, GC) => ISC === 'Pure_Killer' || GC !== 'Lo' && ['Vowel', 'Vowel_Dependent'].includes(ISC),
        VOWEL_MOD: (U, ISC, UDI, GC) => ['Tone_Mark', 'Cantillation_Mark', 'Register_Shifter', 'Visarga'].includes(ISC) || GC !== 'Lo' && ISC === 'Bindu',
        Word_Joiner: (...a) => a[2] && ![0x115f, 0x1160, 0x3164, 0xffa0, 0x1bca0, 0x1bca1, 0x1bca2, 0x1bca3].includes(a[0]) && a[1] === 'Other' && !is.CGJ(...a) || a[3] === 'Cn',
    };
    const mapping = { B: is.BASE, N: is.BASE_NUM, GB: is.BASE_OTHER, CGJ: is.CGJ, F: is.CONS_FINAL, FM: is.CONS_FINAL_MOD, M: is.CONS_MED, CM: is.CONS_MOD,
        SUB: is.CONS_SUB, CS: is.CONS_WITH_STACKER, H: is.HALANT, HVM: is.HALANT_OR_VOWEL_MODIFIER, HN: is.HALANT_NUM, IS: is.INVISIBLE_STACKER, G: is.HIEROGLYPH,
        HM: is.HIEROGLYPH_MOD, HR: is.HIEROGLYPH_MIRROR, J: is.HIEROGLYPH_JOINER, SB: is.HIEROGLYPH_SEGMENT_BEGIN, SE: is.HIEROGLYPH_SEGMENT_END, ZWNJ: is.ZWNJ,
        O: is.OTHER, RK: is.REORDERING_KILLER, R: is.REPHA, Sk: is.SAKOT, SM: is.SYM_MOD, V: is.VOWEL, VM: is.VOWEL_MOD, WJ: is.Word_Joiner };
    const positions = {
        F: { Abv: ['Top'], Blw: ['Bottom'], Pst: ['Right'] },
        M: { Abv: ['Top'], Blw: ['Bottom', 'Bottom_And_Left', 'Bottom_And_Right'], Pst: ['Right'], Pre: ['Left', 'Top_And_Bottom_And_Left'] },
        CM: { Abv: ['Top'], Blw: ['Bottom', 'Overstruck'] },
        V: { Abv: ['Top', 'Top_And_Bottom', 'Top_And_Bottom_And_Right', 'Top_And_Right'], Blw: ['Bottom', 'Overstruck', 'Bottom_And_Right'], Pst: ['Right'],
            Pre: ['Left', 'Top_And_Left', 'Top_And_Left_And_Right', 'Left_And_Right'] },
        VM: { Abv: ['Top'], Blw: ['Bottom', 'Overstruck'], Pst: ['Right'], Pre: ['Left'] },
        SM: { Abv: ['Top'], Blw: ['Bottom'] },
        FM: { Abv: ['Top'], Blw: ['Bottom'], Pst: ['Not_Applicable'] },
    };
    const NO_POSITION = ['H', 'HM', 'HR', 'HVM', 'IS', 'B', 'R', 'RK', 'SUB'];

    for (const u of new Set([...syllabic.keys(), ...positional.keys(), ...joiningTypes.keys(), ...ignorable.keys()])) {
        if (DISABLED.has(scripts.get(u) ?? 'Unknown')) continue;
        let ISC = syllabic.get(u) ?? 'Other', IPC = positional.get(u) ?? 'Not_Applicable';
        const JT = joiningTypes.get(u) ?? 'X', UDI = ignorable.has(u), GC = categories.get(u) ?? 'Cn';
        if (u >= 0x1ce2 && u <= 0x1ce8) ISC = 'Cantillation_Mark';
        if (u >= 0x0f18 && u <= 0x0f19 || u >= 0x0f3e && u <= 0x0f3f) ISC = 'Vowel_Dependent';
        if (u === 0x1ced) ISC = 'Tone_Mark';
        const matches = Object.entries(mapping).filter(([, f]) => f(u, ISC, UDI, GC, JT)).map(([k]) => k);
        if (matches.length !== 1) throw new Error(`USE category of ${u.toString(16)}: ${matches}`);
        let category = matches[0];
        if ([0x11302, 0x11303, 0x114c1].includes(u)) IPC = 'Top';
        const byPosition = positions[category];
        if (byPosition) {
            const suffixes = Object.entries(byPosition).filter(([, v]) => v.includes(IPC)).map(([k]) => k);
            if (suffixes.length !== 1) throw new Error(`USE position of ${u.toString(16)}: ${IPC} ${category}`);
            category += suffixes[0];
        } else if (!NO_POSITION.includes(category) && !['Not_Applicable', 'Visual_Order_Left'].includes(IPC) && u !== 0x0f7f)
            throw new Error(`USE position of ${u.toString(16)}: ${IPC} ${category}`);
        use[u] = category;
    }
}

add('indicCategory', 'Indic shaper category/position (HarfBuzz)', indic, 'X/END');
add('useCategory', 'Universal Shaping Engine category (HarfBuzz)', use, 'O');

// canonical decompositions (to one or two code points) and the pairs that compose (Hangul syllables are algorithmic)
const decompositions = [];
{
    const excluded = withProperty(read('DerivedNormalizationProps.txt'), 'Full_Composition_Exclusion');
    for (const line of read('UnicodeData.txt').split('\n')) {
        if (!line) continue;
        const fields = line.split(';');
        if (!fields[5] || fields[5].startsWith('<')) continue;
        const u = parseInt(fields[0], 16), [a, b = 0] = fields[5].split(' ').map(h => parseInt(h, 16));
        // (code point, its parts, whether they compose to it)
        decompositions.push(u, a, b, b && !excluded.has(u) ? 1 : 0);
    }
}
const varints = numbers => {
    const bytes = [];
    for (let n of numbers) {
        for (; n >= 128; n = Math.floor(n / 128)) bytes.push(n & 127 | 128);
        bytes.push(n);
    }
    return Buffer.from(bytes).toString('base64');
};
// (zigzag encoded differences: code point to the previous one, parts to the code point)
const zigzag = n => n < 0 ? -2 * n - 1 : 2 * n;
const decompositionData = [];
for (let i = 0, previous = 0; i < decompositions.length; i += 4) {
    const [u, a, b, composes] = decompositions.slice(i, i + 4);
    decompositionData.push(u - previous, zigzag(a - u), b ? zigzag(b - u) * 2 + composes + 2 : 0);
    previous = u;
}

// vowel sequences of the Universal Shaping Engine's specification that get a dotted circle before their last character
const constraints = [];
for (const line of msUse('IndicShapingInvalidCluster.txt').split('\n')) {
    const sequence = line.split('#')[0].split(';')[0].trim();
    if (sequence) constraints.push(sequence.split(/\s+/).map(h => parseInt(h, 16)));
}

// Arabic presentation forms for fonts without OpenType Arabic shaping (after HarfBuzz's gen-arabic-table.py): the
// initial, medial, final and isolated form per character, and the ligatures of those forms
const ARABIC_LIGATURES = new Set([0xF2EE, 0xFC08, 0xFC0E, 0xFC12, 0xFC32, 0xFC3F, 0xFC40, 0xFC41, 0xFC42, 0xFC43, 0xFC44, 0xFC4E, 0xFC5E, 0xFC60,
    0xFC61, 0xFC62, 0xFC6A, 0xFC6D, 0xFC6F, 0xFC70, 0xFC73, 0xFC75, 0xFC86, 0xFC8F, 0xFC91, 0xFC94, 0xFC9C, 0xFC9D, 0xFC9E, 0xFC9F, 0xFCA1, 0xFCA2,
    0xFCA3, 0xFCA4, 0xFCA8, 0xFCAA, 0xFCAC, 0xFCB0, 0xFCC9, 0xFCCA, 0xFCCB, 0xFCCC, 0xFCCD, 0xFCCE, 0xFCCF, 0xFCD0, 0xFCD1, 0xFCD2, 0xFCD3, 0xFCD5,
    0xFCDA, 0xFCDB, 0xFCDC, 0xFCDD, 0xFD30, 0xFD88, 0xFEF5, 0xFEF6, 0xFEF7, 0xFEF8, 0xFEF9, 0xFEFA, 0xFEFB, 0xFEFC, 0xF201, 0xF211, 0xF2EE]);
const arabicForms = { shapes: new Map(), ligatures2: new Map(), ligaturesMark: new Map(), ligatures3: new Map() };
{
    const lines = read('UnicodeData.txt').split('\n').concat([
        'F201;PUA ARABIC LIGATURE LELLAH ISOLATED FORM;Lo;0;AL;<isolated> 0644 0644 0647;;;;N;;;;;',
        'F211;PUA ARABIC LIGATURE LAM WITH MEEM WITH JEEM INITIAL FORM;Lo;0;AL;<initial> 0644 0645 062C;;;;N;;;;;',
        'F2EE;PUA ARABIC LIGATURE SHADDA WITH FATHATAN ISOLATED FORM;Lo;0;AL;<isolated> 0020 064B 0651;;;;N;;;;;',
    ]);
    const { shapes } = arabicForms, ligatures = new Map();
    for (const line of lines) {
        const fields = line.split(';');
        if (!fields[5] || !fields[5].startsWith('<')) continue;
        let [shape, ...rest] = fields[5].split(' ');
        shape = shape.slice(1, -1);
        let items = rest.map(h => parseInt(h, 16));
        const c = parseInt(fields[0], 16);
        if (!['initial', 'medial', 'isolated', 'final'].includes(shape)) continue;
        if (items.length !== 1) {
            // (mark ligatures start with a space and are in visual order)
            if (items[0] === 0x20) {
                items = items.slice(1).reverse();
                shape = null;
            }
            if (!ARABIC_LIGATURES.has(c)) continue;
            const key = items.join(',');
            if (!ligatures.has(key)) ligatures.set(key, new Map());
            ligatures.get(key).set(shape, c);
        } else {
            if (!shapes.has(items[0])) shapes.set(items[0], {});
            shapes.get(items[0])[shape] = c;
        }
    }
    const push = (map, key, value) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(value);
    };
    for (const [key, byShape] of ligatures) {
        const k = key.split(',').map(Number);
        for (const [shape, c] of byShape) {
            const form = (u, f) => shapes.get(u)[f];
            if (k.length === 3) {
                const liga = shape === 'isolated' ? [form(k[0], 'initial'), form(k[1], 'medial'), form(k[2], 'final')]
                    : shape === 'final' ? [form(k[0], 'medial'), form(k[1], 'medial'), form(k[2], 'final')]
                        : [form(k[0], 'initial'), form(k[1], 'medial'), form(k[2], 'medial')];
                push(arabicForms.ligatures3, liga[0], [liga[1], liga[2], c]);
            } else if (shape === null) push(arabicForms.ligaturesMark, k[0], [k[1], c]);
            else {
                const liga = shape === 'isolated' ? [form(k[0], 'initial'), form(k[1], 'final')]
                    : shape === 'final' ? [form(k[0], 'medial'), form(k[1], 'final')] : [form(k[0], 'initial'), form(k[1], 'medial')];
                push(arabicForms.ligatures2, liga[0], [liga[1], c]);
            }
        }
    }
}
const shapingFirst = Math.min(...arabicForms.shapes.keys()), shapingLast = Math.max(...arabicForms.shapes.keys());
const arabicShapingTable = [];
for (let u = shapingFirst; u <= shapingLast; u++) {
    const forms = arabicForms.shapes.get(u) ?? {};
    arabicShapingTable.push(...['initial', 'medial', 'final', 'isolated'].map(f => forms[f] ?? 0));
}
const sortedLigatures = map => [...map].sort((a, b) => a[0] - b[0]).map(([first, ligs]) => [first, ligs]);

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
out += `\n/** canonical decompositions, see scripts/unicode.js */\nexport const decompositions = '${varints(decompositionData)}';\n`;
out += `\n/** Arabic presentation forms from U+${shapingFirst.toString(16).toUpperCase()}: initial, medial, final, isolated (0 if none) */\nexport const ARABIC_SHAPING_FIRST = ${shapingFirst};\nexport const arabicShaping: number[] = ${JSON.stringify(arabicShapingTable)};\n`;
out += `\n/** ligatures of presentation forms: [first, [[second, ligature]...]], [first, [[second, third, ligature]...]], marks [first, [[second, ligature]...]] */\nexport const arabicLigatures: Array<[number, number[][]]> = ${JSON.stringify(sortedLigatures(arabicForms.ligatures2))};\nexport const arabicLigatures3: Array<[number, number[][]]> = ${JSON.stringify(sortedLigatures(arabicForms.ligatures3))};\nexport const arabicMarkLigatures: Array<[number, number[][]]> = ${JSON.stringify(sortedLigatures(arabicForms.ligaturesMark))};\n`;
out += `\n/** vowel sequences that get a dotted circle before their last character (Microsoft's IndicShapingInvalidCluster.txt) */\nexport const vowelConstraints: number[][] = ${JSON.stringify(constraints)};\n`;

fs.writeFileSync(path.join(__dirname, '../src/render/unicode-data.ts'), out);
for (const [name, t] of Object.entries(tables)) console.log(name.padEnd(22), String(t.ranges).padStart(6), 'ranges', String(t.data.length).padStart(7), 'bytes', t.names.length, 'values');
console.log('total', out.length, 'bytes');
