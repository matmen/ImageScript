# Adds every OpenType lookup type to tests/shaping: features.ttf (built here from a feature file: all GSUB and GPOS
# lookup types and formats, lookup flags, extension lookups, feature variations) and latin-fallback.ttf (no GSUB and
# GPOS: the fallback spaces, hyphen and mark positioning), with HarfBuzz's shaping of texts using them. Needs fontTools
# and uharfbuzz; run after scripts/shaping-reference.py: python scripts/shaping-features.py
import json, os
from fontTools.fontBuilder import FontBuilder
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.pens.ttGlyphPen import TTGlyphPen
import uharfbuzz as hb

out_dir = os.path.join(os.path.dirname(__file__), '..', 'tests', 'shaping')


def rect(x0, y0, x1, y1):
    pen = TTGlyphPen(None)
    pen.moveTo((x0, y0)); pen.lineTo((x0, y1)); pen.lineTo((x1, y1)); pen.lineTo((x1, y0)); pen.closePath()
    return pen.glyph()


def build(file, glyphs, cmap, fea=None, axes=None):
    """glyphs: {name: (advance, outline box or None)}"""
    names = ['.notdef'] + [n for n in glyphs if n != '.notdef']
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    outlines, metrics = {}, {}
    for name in names:
        advance, box = glyphs.get(name, (500, (50, 0, 450, 700)))
        outlines[name] = rect(*box) if box else TTGlyphPen(None).glyph()
        metrics[name] = (advance, box[0] if box else 0)
    fb.setupGlyf(outlines)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=900, descent=-300)
    fb.setupNameTable({'familyName': 'Shaping ' + file, 'styleName': 'Regular'})
    fb.setupOS2(); fb.setupPost()
    if axes: fb.setupFvar(axes, [])
    if fea: addOpenTypeFeaturesFromString(fb.font, fea)
    fb.font.recalcTimestamp = False
    fb.font['head'].created = fb.font['head'].modified = 0
    fb.save(os.path.join(out_dir, file))


cases = []
def shape(file, script, direction, texts):
    hbfont = hb.Font(hb.Face(hb.Blob.from_file_path(os.path.join(out_dir, file))))
    for text in texts:
        buf = hb.Buffer(); buf.add_str(text)
        buf.script = script; buf.direction = direction
        buf.flags = hb.BufferFlags.BOT | hb.BufferFlags.EOT
        hb.shape(hbfont, buf, {})
        cases.append({'font': file, 'script': script, 'direction': direction, 'text': text,
                      'glyphs': [[i.codepoint, i.cluster, p.x_advance, p.x_offset, p.y_offset] for i, p in zip(buf.glyph_infos, buf.glyph_positions)]})


# ---- every lookup type
letters = 'abcdefghijklmnopqrstuvwxyz'
glyphs = {'space': (300, None)}
for i, c in enumerate(letters): glyphs[c] = (400 + i * 10, (40, 0, 360 + i * 10, 500 + i * 10))
for name in ['acutecomb', 'gravecomb', 'dotbelowcomb', 'macroncomb']:
    glyphs[name] = (0, (-300, 600, -100, 750) if name != 'dotbelowcomb' else (-250, -150, -150, -50))
for name in ['a.alt1', 'a.alt2', 'a.alt3', 'b.alt', 'c.sc', 'n.heavy', 'f_i', 'f_f_i', 'l_l', 'd.ctx1', 'd.ctx2', 'e.ctx3', 'g.ext']:
    glyphs[name] = (600, (40, 0, 560, 600))
cmap = {ord(c): c for c in letters}
cmap.update({0x20: 'space', 0x301: 'acutecomb', 0x300: 'gravecomb', 0x323: 'dotbelowcomb', 0x304: 'macroncomb'})
fea = '''
languagesystem DFLT dflt;
languagesystem latn dflt;
languagesystem hebr dflt;

@LETTERS = [a b c d e f g h i j k l m n o p q r s t u v w x y z];
markClass [acutecomb gravecomb macroncomb] <anchor 250 700> @TOP;
markClass [dotbelowcomb] <anchor 200 -100> @BOTTOM;

# GSUB 2: multiple, also deleting
lookup MULTIPLE { sub c by c d; sub x by NULL; } MULTIPLE;
feature ccmp { lookup MULTIPLE; } ccmp;
# GSUB 3: alternates, chosen randomly (rand)
feature rand { sub a from [a.alt1 a.alt2 a.alt3]; } rand;
# GSUB 4: ligatures, one skipping marks (marks between its components)
lookup LIGATURES { sub f f i by f_f_i; sub f i by f_i; } LIGATURES;
lookup MARKED_LIGATURES { lookupflag IgnoreMarks; sub l l by l_l; } MARKED_LIGATURES;
feature liga { lookup LIGATURES; lookup MARKED_LIGATURES; } liga;
# GSUB 1 and 6: contexts by glyphs (format 1), classes (format 2) and coverages (format 3)
lookup TO_ALT { sub b by b.alt; sub d by d.ctx1; sub e by e.ctx3; } TO_ALT;
feature calt {
    sub q b' lookup TO_ALT r;
    sub q b' lookup TO_ALT s;
    sub [s t] d' lookup TO_ALT [u v];
    sub [w y] [z] e' lookup TO_ALT [o p] [m];
} calt;
# GSUB 8: reverse chaining
feature clig { rsub [h j] c' k by c.sc; } clig;
# GSUB 7: extension
lookup EXTENDED useExtension { sub g by g.ext; } EXTENDED;
feature rlig { lookup EXTENDED; } rlig;

# GPOS 1 (both formats) and 2 (glyph pairs and classes)
lookup SINGLES { pos t <10 0 20 0>; } SINGLES;
lookup SINGLES2 { pos u 15; pos w 25; } SINGLES2;
lookup PAIRS { pos a v -40; pos v a -30; } PAIRS;
lookup CLASS_PAIRS { pos [o p] [q r] -20; pos [h] [o p] 12; } CLASS_PAIRS;
feature kern { lookup SINGLES; lookup SINGLES2; lookup PAIRS; lookup CLASS_PAIRS; } kern;
# GPOS 3: cursive, left to right and right to left
lookup CURSIVE { pos cursive k <anchor 0 100> <anchor 450 300>; pos cursive m <anchor 0 300> <anchor 500 150>; } CURSIVE;
lookup CURSIVE_RTL { lookupflag RightToLeft; pos cursive y <anchor 0 300> <anchor 500 50>; pos cursive z <anchor 0 50> <anchor 500 400>; } CURSIVE_RTL;
feature curs { lookup CURSIVE; lookup CURSIVE_RTL; } curs;
# GPOS 4, 5, 6: marks on bases, on ligature components, on marks; a mark filtering set
lookup MARK_BASE { pos base @LETTERS <anchor 200 650> mark @TOP <anchor 200 0> mark @BOTTOM; } MARK_BASE;
lookup MARK_LIGATURE { pos ligature l_l <anchor 150 650> mark @TOP ligComponent <anchor 450 650> mark @TOP; } MARK_LIGATURE;
lookup MARK_MARK { lookupflag UseMarkFilteringSet [acutecomb gravecomb]; pos mark [acutecomb gravecomb] <anchor 250 900> mark @TOP; } MARK_MARK;
feature mark { lookup MARK_BASE; lookup MARK_LIGATURE; } mark;
feature mkmk { lookup MARK_MARK; } mkmk;
# GPOS 8: chained context positioning
lookup NUDGE { pos s 30; } NUDGE;
feature dist { pos r s' lookup NUDGE t; pos [i j] s' lookup NUDGE; } dist;
# a feature variation: with the default weight (in 300..500), rvrn swaps n
conditionset middle { wght 300 500; } middle;
variation rvrn middle { sub n by n.heavy; } rvrn;
'''
build('features.ttf', glyphs, cmap, fea, axes=[('wght', 100, 400, 900, 'Weight')])
feature_texts = [
    'cxc cab', 'aaaa aaaa', 'ffi fi fifi', 'll ĺl ĺ̀l', 'qbr qbs qbt', 'sdu tdv sdw', 'wzeom yzepm wzeo',
    'hck jck hc', 'gag', 'tuw av va', 'oq pr hop ho', 'kmk mkm', 'rst is js', 'nan', 'á̀ ḅ́ ā́',
    'ĺḷ', 'xax',
]
shape('features.ttf', 'Latn', 'ltr', feature_texts)
shape('features.ttf', 'Hebr', 'rtl', ['yzy zyz', 'kmk yz', 'áb'])

# ---- the fallbacks of fonts without layout tables
fallback = {'space': (250, None), 'hyphen': (300, (30, 250, 270, 330)), 'period': (220, (60, 0, 160, 100)),
            'comma': (230, (60, -80, 160, 100)), 'fraction': (150, (0, 0, 150, 700))}
fcmap = {0x20: 'space', 0x2010: 'hyphen', 0x2e: 'period', 0x2c: 'comma', 0x2044: 'fraction'}
for d in range(10):
    fallback[f'digit{d}'] = (520, (40, 0, 480, 700)); fcmap[0x30 + d] = f'digit{d}'
for c in 'abcdeiouxyAIO':
    fallback[c] = (480 if c.islower() else 640, (40, 0, 440 if c.islower() else 600, 500 if c.islower() else 700)); fcmap[ord(c)] = c
# combining marks of many classes (above, below, attached, double, iota subscript, overlays), drawn left of 0
marks = {0x301: 'above', 0x316: 'below', 0x31b: 'horn', 0x345: 'iota', 0x358: 'aboveright', 0x35c: 'doublebelow',
         0x35d: 'doubleabove', 0x328: 'ogonek', 0x327: 'cedilla', 0x334: 'tilde_overlay', 0x302: 'circumflex',
         0x323: 'dotbelow', 0x315: 'commaright', 0x31a: 'leftangle', 0x339: 'ringhalf', 0x34f: 'cgj'}
for u, name in marks.items():
    fallback[name] = (0, (-300, -200, -120, -40) if name in ('below', 'iota', 'doublebelow', 'ogonek', 'cedilla', 'dotbelow', 'ringhalf') else (-300, 550, -120, 720))
    fcmap[u] = name
del fallback['cgj']; del fcmap[0x34f]
build('latin-fallback.ttf', fallback, fcmap)
fallback_texts = [
    'a b c d e i o u x y a b c d',
    'a‑b ‒ x', '1⁄2 3⁄4', 'á͏̖ o̖͏́ u͏',
    'a︀b x\U000e0100y', 'á a̖ a̛ A̛ aͅ a͘ a͜ b a͝ b', 'ą ȩ i̴ Ố',
    'x̣̂ y̕ a̚ o̹', 'á́́ i̖̖', '́a ̖', 'aÍ Iî',
]
shape('latin-fallback.ttf', 'Latn', 'ltr', fallback_texts)
shape('latin-fallback.ttf', 'Latn', 'rtl', ['áb̖', 'a͝b'])

reference = os.path.join(out_dir, 'reference.json')
data = json.load(open(reference))
files = {c['font'] for c in cases}
data['cases'] = [c for c in data['cases'] if c['font'] not in files] + cases
json.dump(data, open(reference, 'w'), ensure_ascii=False, separators=(',', ':'))
print(len(cases), 'cases,', sum(os.path.getsize(os.path.join(out_dir, f)) for f in files), 'bytes of fonts')
