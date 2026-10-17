# Generates tests/shaping: font subsets per script (from Noto fonts, SIL OFL) and HarfBuzz's shaping of test texts,
# compared by tests/shaping.js. Needs fontTools and uharfbuzz:
#   python scripts/shaping-reference.py <directory with the Noto fonts> <UDHR corpus.json>
import json, random, sys, os
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
import uharfbuzz as hb

fonts_dir, corpus_file = sys.argv[1], sys.argv[2]
out_dir = os.path.join(os.path.dirname(__file__), '..', 'tests', 'shaping')
FONTS = {'Arab': 'NotoNaskhArabic.ttf', 'Hebr': 'NotoSansHebrew.ttf', 'Deva': 'NotoSansDevanagari.ttf', 'Beng': 'NotoSansBengali.ttf',
         'Taml': 'NotoSansTamil.ttf', 'Telu': 'NotoSansTelugu.ttf', 'Knda': 'NotoSansKannada.ttf', 'Mlym': 'NotoSansMalayalam.ttf',
         'Gujr': 'NotoSansGujarati.ttf', 'Guru': 'NotoSansGurmukhi.ttf', 'Orya': 'NotoSansOriya.ttf', 'Sinh': 'NotoSansSinhala.ttf',
         'Thai': 'NotoSansThai.ttf', 'Laoo': 'NotoSansLao.ttf', 'Khmr': 'NotoSansKhmer.ttf', 'Mymr': 'NotoSansMyanmar.ttf',
         'Syrc': 'NotoSansSyriac.ttf', 'Mong': 'NotoSansMongolian.ttf', 'Nkoo': 'NotoSansNKo.ttf', 'Thaa': 'NotoSansThaana.ttf',
         'Tibt': 'NotoSerifTibetan.ttf', 'Java': 'NotoSansJavanese.ttf', 'Bali': 'NotoSansBalinese.ttf', 'Hang': 'NotoSansKR.ttf',
         'Adlm': 'NotoSansAdlam.ttf'}
RTL = {'Arab', 'Hebr', 'Syrc', 'Nkoo', 'Thaa', 'Adlm'}
random.seed(18)
corpus = json.load(open(corpus_file))
cases, sizes = [], 0
for script, name in FONTS.items():
    texts = [p[:90] for e in corpus if e['script'] == script or (script == 'Hang' and e['script'] == 'Kore') for p in e['paras'][:2]][:3]
    # random sequences of the script's characters with joiners and marks: broken clusters, reordering
    cmap = TTFont(os.path.join(fonts_dir, name), lazy=True)['cmap'].getBestCmap()
    probe = lambda u: (lambda b: (b.add_str(chr(u)), b.guess_segment_properties(), b.script)[2])(hb.Buffer())
    chars = [u for u in cmap if u > 0x7f and probe(u) == script and not 0xfb50 <= u <= 0xfeff]
    if script == 'Hang': chars = random.sample(chars, 40) + list(range(0x1100, 0x1112)) + list(range(0x1161, 0x1170)) + [0x11a8, 0x302e]
    else: chars = random.sample(chars, min(len(chars), 60))
    for _ in range(12):
        texts.append(''.join(chr(random.choice([0x200c, 0x200d, 0x25cc, 0x20]) if random.random() < 0.08 else random.choice(chars)) for _ in range(random.randint(2, 8))))
    used = ''.join(texts) + '◌  '
    options = subset.Options()
    options.layout_features = ['*']
    options.hinting = False
    options.notdef_outline = True
    options.name_IDs = ['*']
    font = TTFont(os.path.join(fonts_dir, name))
    # the default instance of variable fonts
    if 'fvar' in font: font = instancer.instantiateVariableFont(font, {a.axisTag: a.defaultValue for a in font['fvar'].axes})
    sub = subset.Subsetter(options)
    sub.populate(text=used)
    sub.subset(font)
    # shaping needs no outlines (the fonts all position marks with GPOS)
    glyf = font['glyf']
    for g in font.getGlyphOrder():
        glyf[g] = type(glyf[g])()
        glyf[g].numberOfContours = 0
    file = script.lower() + '.ttf'
    font.save(os.path.join(out_dir, file))
    sizes += os.path.getsize(os.path.join(out_dir, file))
    hbfont = hb.Font(hb.Face(hb.Blob.from_file_path(os.path.join(out_dir, file))))
    for text in texts:
        buf = hb.Buffer(); buf.add_str(text)
        buf.script = script; buf.direction = 'rtl' if script in RTL else 'ltr'
        buf.flags = hb.BufferFlags.BOT | hb.BufferFlags.EOT
        hb.shape(hbfont, buf, {})
        cases.append({'font': file, 'script': script, 'text': text,
                      'glyphs': [[i.codepoint, i.cluster, p.x_advance, p.x_offset, p.y_offset] for i, p in zip(buf.glyph_infos, buf.glyph_positions)]})
# the test fonts: Latin with the kern table and marks, CFF outlines, emoji sequences
EXTRA = {'opensans bold.ttf': ['Hello, World! AVATAR Tô Wâ', 'e\u0301 o\u0327 a\u0301\u0323 1\u20442', 'ﬁ fi ffl \u00a0\u2009x'],
         'sourcesans3 regular.otf': ['Quartz glyph job, vex!', 'office affluent Tyrol', 'x\u0301\u0302 \u2003y'],
         'noto color emoji subset.ttf': ['\U0001F469\u200D\U0001F469\u200D\U0001F467', '\U0001F1E9\U0001F1EA\U0001F1EB', '#\uFE0F\u20E3 \u2764\uFE0F \U0001F3FD']}
for file, texts in EXTRA.items():
    hbfont = hb.Font(hb.Face(hb.Blob.from_file_path(os.path.join(out_dir, '..', 'fonts', file))))
    for text in texts:
        buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
        buf.flags = hb.BufferFlags.BOT | hb.BufferFlags.EOT
        hb.shape(hbfont, buf, {})
        cases.append({'font': '../fonts/' + file, 'script': buf.script, 'text': text,
                      'glyphs': [[i.codepoint, i.cluster, p.x_advance, p.x_offset, p.y_offset] for i, p in zip(buf.glyph_infos, buf.glyph_positions)]})

json.dump({'harfbuzz': hb.version_string(), 'cases': cases}, open(os.path.join(out_dir, 'reference.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print(len(cases), 'cases,', sizes, 'bytes of fonts')
