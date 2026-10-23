# Adds the fallbacks of the script shapers to tests/shaping: fonts without GSUB and GPOS (made here, rectangles as
# outlines) and HarfBuzz's shaping of texts with them. Thai positions marks with private use glyphs (Windows and Mac
# ones), Hangul composes and decomposes syllables by the glyphs the font has, Hebrew uses presentation forms; marks
# are placed by the fallback positioning. Needs fontTools and uharfbuzz; run after scripts/shaping-reference.py:
#   python scripts/shaping-fallbacks.py
import json, os, random
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
import uharfbuzz as hb

out_dir = os.path.join(os.path.dirname(__file__), '..', 'tests', 'shaping')
random.seed(18)


def rect(x0, y0, x1, y1):
    pen = TTGlyphPen(None)
    pen.moveTo((x0, y0)); pen.lineTo((x0, y1)); pen.lineTo((x1, y1)); pen.lineTo((x1, y0)); pen.closePath()
    return pen.glyph()


def build(file, chars, mark_above, mark_below, zero_width=()):
    """chars: code points; marks get no advance and an outline above or below the base, the others a box"""
    names = ['.notdef'] + [f'u{u:04X}' for u in chars]
    outlines, metrics = {'.notdef': rect(50, 0, 450, 700)}, {'.notdef': (500, 50)}
    for u in chars:
        name = f'u{u:04X}'
        if u in mark_above: outlines[name], metrics[name] = rect(-350, 750, -150, 950), (0, -350)
        elif u in mark_below: outlines[name], metrics[name] = rect(-350, -250, -150, -50), (0, -350)
        elif u in zero_width: outlines[name], metrics[name] = rect(-300, 300, -100, 500), (0, -300)
        else: outlines[name], metrics[name] = rect(50, 0, 550, 700), (600, 50)
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({u: f'u{u:04X}' for u in chars})
    fb.setupGlyf(outlines)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1000, descent=-300)
    fb.setupNameTable({'familyName': 'Fallback ' + file, 'styleName': 'Regular'})
    fb.setupOS2(); fb.setupPost()
    fb.save(os.path.join(out_dir, file))


cases = []
def shape(file, script, direction, texts):
    hbfont = hb.Font(hb.Face(hb.Blob.from_file_path(os.path.join(out_dir, file))))
    for text in texts:
        buf = hb.Buffer(); buf.add_str(text)
        buf.script = script; buf.direction = direction
        buf.flags = hb.BufferFlags.BOT | hb.BufferFlags.EOT
        hb.shape(hbfont, buf, {})
        cases.append({'font': file, 'script': script, 'text': text,
                      'glyphs': [[i.codepoint, i.cluster, p.x_advance, p.x_offset, p.y_offset] for i, p in zip(buf.glyph_infos, buf.glyph_positions)]})


# Thai: consonants, vowels and marks, and the private use glyphs of one vendor
thai = list(range(0x0e01, 0x0e2f)) + list(range(0x0e30, 0x0e3b)) + list(range(0x0e40, 0x0e4f))
above = {0x0e31, 0x0e34, 0x0e35, 0x0e36, 0x0e37, 0x0e47, 0x0e48, 0x0e49, 0x0e4a, 0x0e4b, 0x0e4c, 0x0e4d, 0x0e4e}
below = {0x0e38, 0x0e39, 0x0e3a}
windows = list(range(0xf700, 0xf71b))
mac = list(range(0xf884, 0xf89f))
build('thai-pua-windows.ttf', thai + windows, above | {u for u in windows if u not in (0xf700, 0xf70f) and not 0xf718 <= u <= 0xf71a}, below | {0xf718, 0xf719, 0xf71a})
build('thai-pua-mac.ttf', thai + mac, above | {u for u in mac if u not in (0xf89a, 0xf89e) and not 0xf89b <= u <= 0xf89d}, below | {0xf89b, 0xf89c, 0xf89d})
thai_texts = [
    'ปิ่น', 'ฝั่ง', 'ฟื้น', 'ป่า', 'ป้ำ', 'ฎุ', 'ฏู', 'ญุ', 'ฐู', 'กั่ก', 'ก่ำ', 'ปั๊ม', 'ปํ่า', 'ฟุ้ง', 'ป็่', 'ฬ้',
    'กิ่ ปี้ ฝึ๊ ฟื๋', 'ญู่ ฐุ้', 'ปุ่ ฎิ่',
]
# and random sequences of the Thai characters
thai_texts += [''.join(chr(random.choice(thai)) for _ in range(random.randint(2, 7))) for _ in range(10)]
for file in ['thai-pua-windows.ttf', 'thai-pua-mac.ttf']:
    shape(file, 'Thai', 'ltr', thai_texts)

# Hangul: jamo, some syllables (the others decompose, jamo sequences compose where the syllable is there), tone marks
# (one with an advance), the dotted circle
syllables = [0xac00, 0xac01, 0xb098, 0xb2e4, 0xd55c, 0xae00, 0xd0dc]  # 가 각 나 다 한 글 태
jamo = list(range(0x1100, 0x1113)) + list(range(0x1161, 0x1176)) + list(range(0x11a8, 0x11c3)) + [0xd7cb]
build('hang-jamo.ttf', syllables + jamo + [0x302e, 0x302f, 0x25cc], set(), set(), zero_width={0x302e})
hangul_texts = [
    '가', '각', '나', '한', '개', '갤',
    '한국어', '각', '간', '각', '갂', '가ퟋ', '가ퟋ', '한〮', '한〯', '〮한', '〯',
    '나ᅡ', '가각', '태극기', '글〯자', '가〮',
]
shape('hang-jamo.ttf', 'Hang', 'ltr', hangul_texts)

# Hebrew: letters, points and the presentation forms (no GPOS mark positioning, so they're used)
letters = list(range(0x05d0, 0x05eb))
points = list(range(0x05b0, 0x05bd)) + [0x05bf, 0x05c1, 0x05c2, 0x05c4, 0x05c5, 0x05c7]
forms = [u for u in range(0xfb1d, 0xfb50) if u not in (0xfb37, 0xfb3d, 0xfb3f, 0xfb42, 0xfb45)]
build('hebr-forms.ttf', letters + points + [0x05bd] + forms, {0x05b9, 0x05bf, 0x05c1, 0x05c2, 0x05c4}, set(points) - {0x05b9, 0x05bf, 0x05c1, 0x05c2, 0x05c4} | {0x05bd})
hebrew_texts = [
    'בּ', 'שׁ', 'שׂ', 'שּׁ', 'שּׂ', 'אַ', 'אָ', 'וֹ', 'יִ', 'ײַ', 'בֿ', 'כֿ', 'פֿ', 'תּוֹרָה', 'שָׁלוֹם',
    'בָּֽ', 'בָֽ', 'אִָֽ', 'בַּֽ', 'רְ', 'ךּ', 'ןּ', 'שִׁ',
]
shape('hebr-forms.ttf', 'Hebr', 'rtl', hebrew_texts)

reference = os.path.join(out_dir, 'reference.json')
data = json.load(open(reference))
fallback_fonts = {c['font'] for c in cases}
data['cases'] = [c for c in data['cases'] if c['font'] not in fallback_fonts] + cases
json.dump(data, open(reference, 'w'), ensure_ascii=False, separators=(',', ':'))
print(len(cases), 'fallback cases,', sum(os.path.getsize(os.path.join(out_dir, f)) for f in fallback_fonts), 'bytes of fonts')
