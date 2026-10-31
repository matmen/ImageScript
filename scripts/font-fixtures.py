# Writes the fonts of tests/fonts that test the font parser's rarer paths, and FreeType's view of them to
# tests/fonts/font-features.json, which tests/font.js compares with:
# - "cff flex.otf" and "source han sans cid subset.otf": copies of cff1_flex.otf (all four flex operators) and
#   SourceHanSans-Regular.41,4C2E.nosubrs.nohints.otf (CID-keyed CFF) of HarfBuzz's test fonts (test/api/fonts)
# - "font features.ttf", built here: composite glyphs scaling their components (by one factor, x and y, a 2x2
#   matrix), a variation sequence with a glyph of its own (cmap format 14), a weight axis whose gvar moves the phantom
#   points (no HVAR: the advances vary by them), cvar, and a glyph program measuring a control value and using the
#   twilight zone (MIRP and MSIRP into it, MDRP from it)
# - "cmap format 0.ttf" and "cmap format 6.ttf": character maps of those formats only
# FreeType's outlines are unhinted ones in font units, and hinted ones (v35 interpreter, as ImageScript's) of
# "font features.ttf" at 16 px at the default and the heaviest weight. Needs fontTools and freetype-py, and a HarfBuzz
# checkout: python3 scripts/font-fixtures.py <harfbuzz>
import array, ctypes, json, os, shutil, sys
import freetype
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.ttLib.tables import ttProgram
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphComponent
from fontTools.ttLib.tables.TupleVariation import TupleVariation

fonts = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fonts')
harfbuzz = os.path.join(sys.argv[1], 'test', 'api', 'fonts')
shutil.copy(os.path.join(harfbuzz, 'cff1_flex.otf'), os.path.join(fonts, 'cff flex.otf'))
shutil.copy(os.path.join(harfbuzz, 'SourceHanSans-Regular.41,4C2E.nosubrs.nohints.otf'), os.path.join(fonts, 'source han sans cid subset.otf'))


def contour(points):
    pen = TTGlyphPen(None)
    pen.moveTo(points[0])
    for p in points[1:]: pen.lineTo(p)
    pen.closePath()
    return pen.glyph()


def composite(transform, offset):
    c = GlyphComponent()
    c.glyphName, c.x, c.y, c.flags = 'square', offset[0], offset[1], 0
    if transform: c.transform = transform
    g = Glyph()
    g.numberOfContours, g.components = -1, [c]
    return g


def build(file, cmap=None, subtable=None, features=False):
    order = ['.notdef', 'square', 'alt', 'scaled', 'xyscaled', 'matrix']
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(order)
    glyphs = {
        '.notdef': contour([(50, 0), (50, 700), (450, 700), (450, 0)]),
        'square': contour([(100, 0), (100, 600), (500, 600), (500, 0)]),
        'alt': contour([(80, 0), (300, 700), (520, 0)]),
        'scaled': composite([[0.5, 0], [0, 0.5]], (40, 30)),
        'xyscaled': composite([[0.5, 0], [0, 0.75]], (60, 0)),
        'matrix': composite([[0.75, 0.25], [-0.25, 0.75]], (100, 50)),
    }
    fb.setupGlyf(glyphs)
    glyf = fb.font['glyf']
    for name in order: glyf[name].recalcBounds(glyf)
    fb.setupHorizontalMetrics({name: (600, glyf[name].xMin) for name in order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupCharacterMap(cmap or {0x41: 'square', 0x42: 'scaled', 0x43: 'xyscaled', 0x44: 'matrix'},
                 uvs=[(0x41, 0xfe00, 'alt')] if features else None)
    fb.setupNameTable({'familyName': 'Font Features', 'styleName': 'Regular'})
    fb.setupOS2()
    fb.setupPost()
    if subtable is not None:
        # (that one subtable only)
        t = CmapSubtable.newSubtable(subtable[0])
        t.platformID, t.platEncID, t.language, t.cmap = subtable[1], subtable[2], 0, dict(fb.font['cmap'].getBestCmap())
        fb.font['cmap'].tables = [t]
    if features:
        fb.setupFvar(axes=[('wght', 100, 400, 900, 'Weight')], instances=[])
        # the heaviest weight moves the square's right side bearing phantom point, and its top right corner
        fb.setupGvar({'square': [TupleVariation({'wght': (0, 1, 1)}, [(0, 0), (0, 0), (60, 40), (60, 0), (0, 0), (120, 0), (0, 0), (0, 0)])]})
        fb.font['cvt '] = newTable('cvt ')
        fb.font['cvt '].values = array.array('h', [400, 300])
        fb.font['cvar'] = newTable('cvar')
        fb.font['cvar'].version = 0x00010000
        fb.font['cvar'].variations = [TupleVariation({'wght': (0, 1, 1)}, [96, None])]
        for tag in ('fpgm', 'prep'):
            fb.font[tag] = newTable(tag)
            fb.font[tag].program = ttProgram.Program()
            fb.font[tag].program.fromBytecode(b'')
        code = bytes([
            0x01,                    # SVTCA x
            0xb8, 0x7f, 0xff, 0x1d,  # PUSHW 32767, SCVTCI: the control values always win
            0xb0, 0x00, 0x10,        # PUSHB 0, SRP0
            0xb1, 0x02, 0x00, 0xe0,  # PUSHB 2 0, MIRP: point 2 at cvt 0 from point 0
            0xb0, 0x00, 0x14,        # PUSHB 0, SZP1: twilight zone
            0xb1, 0x00, 0x01, 0xe0,  # PUSHB 0 1, MIRP: twilight point 0 at cvt 1 from point 0
            0xb1, 0x01, 0x20, 0x3a,  # PUSHB 1 32, MSIRP: twilight point 1 half a pixel from point 0
            0xb0, 0x00, 0x13,        # PUSHB 0, SZP0: twilight zone
            0xb0, 0x01, 0x14,        # PUSHB 1, SZP1: the glyph
            0xb0, 0x01, 0x10,        # PUSHB 1, SRP0: twilight point 1
            0xb0, 0x03, 0xc0,        # PUSHB 3, MDRP: point 3 from it
        ])
        glyph = fb.font['glyf']['square']
        glyph.program = ttProgram.Program()
        glyph.program.fromBytecode(code)
        for name in order:
            if not hasattr(fb.font['glyf'][name], 'program'):
                fb.font['glyf'][name].program = ttProgram.Program()
                fb.font['glyf'][name].program.fromBytecode(b'')
        maxp = fb.font['maxp']
        maxp.maxTwilightPoints, maxp.maxStackElements, maxp.maxZones, maxp.maxSizeOfInstructions = 2, 16, 2, len(code)
        maxp.maxStorage = maxp.maxFunctionDefs = maxp.maxInstructionDefs = 0
    fb.save(file)


feature_file = os.path.join(fonts, 'font features.ttf')
build(feature_file, features=True)
build(os.path.join(fonts, 'cmap format 0.ttf'), {0x41: 'square', 0x42: 'alt'}, (0, 1, 0))
build(os.path.join(fonts, 'cmap format 6.ttf'), {0x41: 'square', 0x42: 'alt', 0x43: 'scaled'}, (6, 3, 1))

lib = freetype.get_handle()
version = ctypes.c_uint(35)
assert freetype.raw.FT_Property_Set(lib, b'truetype', b'interpreter-version', ctypes.byref(version)) == 0


def points(outline, scale=1):
    return [[round(x * scale), round(y * scale), tag & 1] for (x, y), tag in zip(outline.points, outline.tags)]


expected = {'outlines': {}, 'boxes': {}, 'cmaps': {}, 'variants': [], 'advances': {}, 'hinted': {}}
for file, glyphs in [('cff flex.otf', [1]), ('source han sans cid subset.otf', [1, 2]), ('font features.ttf', [1, 2, 3, 4, 5])]:
    face = freetype.Face(os.path.join(fonts, file))
    for g in glyphs:
        face.load_glyph(g, freetype.FT_LOAD_NO_SCALE)
        expected['outlines'][f'{file}:{g}'] = points(face.glyph.outline)
        box = face.glyph.outline.get_cbox()
        expected['boxes'][f'{file}:{g}'] = [box.xMin, box.yMin, box.xMax, box.yMax]

for file in ['cmap format 0.ttf', 'cmap format 6.ttf', 'source han sans cid subset.otf']:
    face = freetype.Face(os.path.join(fonts, file))
    if 'format 0' in file: face.select_charmap(freetype.FT_ENCODING_APPLE_ROMAN)
    expected['cmaps'][file] = {str(c): face.get_char_index(c) for c in [0x41, 0x42, 0x43, 0x44, 0x4c2e]}

face = freetype.Face(feature_file)
variant = freetype.raw.FT_Face_GetCharVariantIndex
variant.restype = ctypes.c_uint
expected['variants'] = [[c, s, variant(face._FT_Face, c, s)] for c, s in [(0x41, 0xfe00), (0x41, 0xfe01), (0x42, 0xfe00)]]
for weight in [400, 650, 900]:
    face = freetype.Face(feature_file)
    face.set_var_design_coords([weight])
    face.load_glyph(1, freetype.FT_LOAD_NO_SCALE)
    expected['advances'][str(weight)] = face.glyph.advance.x
    face.set_char_size(16 * 64, 0, 72, 72)
    face.load_glyph(1, freetype.FT_LOAD_NO_AUTOHINT | freetype.FT_LOAD_NO_BITMAP)
    expected['hinted'][str(weight)] = {'advance': face.glyph.advance.x, 'points': points(face.glyph.outline)}

with open(os.path.join(fonts, 'font-features.json'), 'w') as f:
    json.dump(expected, f, separators=(',', ':'))
print(json.dumps(expected)[:1500])
