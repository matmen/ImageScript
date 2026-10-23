# Builds "tests/fonts/hinting instructions.ttf", a TrueType font whose glyph programs use the instructions other test
# fonts don't (vectors, ISECT, ALIGNPTS, UTP, FLIPPT, the round states, MSIRP, SHZ, SCFS, GC, DELTAP2/3, DELTAC,
# IDEF, JROT/JROF, GETINFO, INSTCTRL, ...) and point matching in composite glyphs, and writes FreeType's hinted
# outlines of it (v35 interpreter, as ImageScript's) to tests/fonts/hinting-instructions.json, which tests/font.js
# compares with. Needs fontTools and freetype-py: python3 scripts/hinting-fixtures.py
import array, ctypes, json, os
import freetype
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables import ttProgram
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphComponent

fonts = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fonts')
FILE = os.path.join(fonts, 'hinting instructions.ttf')
SIZES = [11, 13, 16, 24]

OPS = {
    'SVTCA0': 0x00, 'SVTCA1': 0x01, 'SPVTCA0': 0x02, 'SPVTCA1': 0x03, 'SFVTCA0': 0x04, 'SFVTCA1': 0x05,
    'SPVTL0': 0x06, 'SPVTL1': 0x07, 'SFVTL0': 0x08, 'SFVTL1': 0x09, 'SPVFS': 0x0a, 'SFVFS': 0x0b, 'GPV': 0x0c,
    'GFV': 0x0d, 'SFVTPV': 0x0e, 'ISECT': 0x0f, 'SRP0': 0x10, 'SRP1': 0x11, 'SRP2': 0x12, 'SZP0': 0x13, 'SZP1': 0x14,
    'SZP2': 0x15, 'SZPS': 0x16, 'SLOOP': 0x17, 'RTG': 0x18, 'RTHG': 0x19, 'SMD': 0x1a, 'ELSE': 0x1b, 'JMPR': 0x1c,
    'SCVTCI': 0x1d, 'SSWCI': 0x1e, 'SSW': 0x1f, 'DUP': 0x20, 'POP': 0x21, 'CLEAR': 0x22, 'SWAP': 0x23, 'DEPTH': 0x24,
    'CINDEX': 0x25, 'MINDEX': 0x26, 'ALIGNPTS': 0x27, 'UTP': 0x29, 'LOOPCALL': 0x2a, 'CALL': 0x2b, 'FDEF': 0x2c,
    'ENDF': 0x2d, 'MDAP0': 0x2e, 'MDAP1': 0x2f, 'IUP0': 0x30, 'IUP1': 0x31, 'SHP0': 0x32, 'SHP1': 0x33, 'SHC0': 0x34,
    'SHC1': 0x35, 'SHZ0': 0x36, 'SHZ1': 0x37, 'SHPIX': 0x38, 'IP': 0x39, 'MSIRP0': 0x3a, 'MSIRP1': 0x3b,
    'ALIGNRP': 0x3c, 'RTDG': 0x3d, 'MIAP0': 0x3e, 'MIAP1': 0x3f, 'WS': 0x42, 'RS': 0x43, 'WCVTP': 0x44, 'RCVT': 0x45,
    'GC0': 0x46, 'GC1': 0x47, 'SCFS': 0x48, 'MD0': 0x49, 'MD1': 0x4a, 'MPPEM': 0x4b, 'MPS': 0x4c, 'FLIPON': 0x4d,
    'FLIPOFF': 0x4e, 'LT': 0x50, 'LTEQ': 0x51, 'GT': 0x52, 'GTEQ': 0x53, 'EQ': 0x54, 'NEQ': 0x55, 'ODD': 0x56,
    'EVEN': 0x57, 'IF': 0x58, 'EIF': 0x59, 'AND': 0x5a, 'OR': 0x5b, 'NOT': 0x5c, 'DELTAP1': 0x5d, 'SDB': 0x5e,
    'SDS': 0x5f, 'ADD': 0x60, 'SUB': 0x61, 'DIV': 0x62, 'MUL': 0x63, 'ABS': 0x64, 'NEG': 0x65, 'FLOOR': 0x66,
    'CEILING': 0x67, 'ROUND0': 0x68, 'NROUND0': 0x6c, 'WCVTF': 0x70, 'DELTAP2': 0x71, 'DELTAP3': 0x72,
    'DELTAC1': 0x73, 'DELTAC2': 0x74, 'DELTAC3': 0x75, 'SROUND': 0x76, 'S45ROUND': 0x77, 'JROT': 0x78, 'JROF': 0x79,
    'ROFF': 0x7a, 'RUTG': 0x7c, 'RDTG': 0x7d, 'SANGW': 0x7e, 'FLIPPT': 0x80, 'FLIPRGON': 0x81, 'FLIPRGOFF': 0x82,
    'SCANCTRL': 0x85, 'SDPVTL0': 0x86, 'SDPVTL1': 0x87, 'GETINFO': 0x88, 'IDEF': 0x89, 'ROLL': 0x8a, 'MAX': 0x8b,
    'MIN': 0x8c, 'SCANTYPE': 0x8d, 'INSTCTRL': 0x8e,
}
MDRP = lambda flags: 0xc0 | flags  # 5 bits: set rp0, keep minimum distance, round, distance type
MIRP = lambda flags: 0xe0 | flags


def push(*values):
    if any(v < 0 or v > 255 for v in values):
        out = [0x41, len(values)]
        for v in values: out += [v >> 8 & 255, v & 255]
        return out
    return [0x40, len(values)] + list(values)


def asm(*items):
    """items: opcode names, raw opcodes (ints), or lists of bytes (pushes)"""
    out = []
    for item in items:
        if isinstance(item, str): out.append(OPS[item])
        elif isinstance(item, int): out.append(item)
        else: out += item
    return out


def program(code):
    p = ttProgram.Program()
    p.fromBytecode(bytes(code))
    return p


# every glyph: an octagon (points 0-7) and a square inside it (8-11)
def outline():
    pen = TTGlyphPen(None)
    for contour in [[(100, 0), (500, 0), (600, 100), (600, 600), (500, 700), (100, 700), (0, 600), (0, 100)],
                    [(200, 200), (400, 200), (400, 400), (200, 400)]]:
        pen.moveTo(contour[0])
        for point in contour[1:]: pen.lineTo(point)
        pen.closePath()
    return pen.glyph()


skipped = asm(push(3, 200), 'SHPIX')  # moves point 3 a lot: must not run
items = {
    # projection and freedom vectors from lines, the stack and each other, dual vectors, MD on both outlines
    'vectors': (push(0, 2), 'SPVTL0', push(1, 3), 'SFVTL1', push(4, 40), 'SHPIX', 'GPV', 'SFVFS', 'GFV', 'SPVFS',
                   push(6, 24), 'SHPIX', 'SFVTPV', push(2, 9), 'SDPVTL1', push(5, 0, 7), 'MD1', 'SHPIX',
                   push(8, 0, 7), 'MD0', push(4), 'DIV', 'SHPIX', push(9, 3), 'SDPVTL0', push(10, 30), 'SHPIX',
                   'SPVTCA1', 'SFVTCA0', push(3, 32), 'SHPIX', 'SVTCA1', 'IUP1', 'IUP0'),
    # intersections (and parallel lines: the middle), aligning points, untouching
    'isect': (push(9, 0, 3, 1, 6), 'ISECT', push(8, 0, 1, 4, 5), 'ISECT', 'SVTCA1', push(10, 11), 'ALIGNPTS',
                 push(1, 48), 'SHPIX', push(1), 'UTP', push(2, 40), 'SHPIX', 'IUP1', 'IUP0'),
    # on and off curve flips
    'flip': (push(2), 'FLIPPT', push(4, 6), 'FLIPRGOFF', push(9, 10), 'FLIPRGON', push(10), 'FLIPPT'),
    # round states with MDRP, MSIRP, minimum distance, cut-ins, single width, auto flip
    'round': ('SVTCA1', push(0), 'MDAP1', push(0x4a), 'SROUND', push(3), MDRP(0b00100), push(0x8e), 'S45ROUND',
                 push(4), MDRP(0b00100), 'RTDG', push(5), MDRP(0b00100), 'RDTG', push(6), MDRP(0b00100), 'RUTG',
                 push(7), MDRP(0b00100), 'ROFF', push(1), MDRP(0b00100), 'RTHG', push(96), 'SMD', push(2), MDRP(0b01100),
                 'RTG', push(17), 'SCVTCI', push(40), 'SSWCI', push(100), 'SSW', 'FLIPOFF', push(9, 0), MIRP(0b10100),
                 'FLIPON', push(10, 1), MIRP(0b00100), push(11, 300), 'MSIRP1', push(8, 150), 'MSIRP0', 'SVTCA0',
                 push(0), 'MDAP1', push(2, 100), 'MSIRP0', 'IUP0'),
    # coordinates: SCFS, GC on both outlines, SHZ, SHC, MIAP into the twilight zone
    'coords': ('SVTCA1', push(3, 500), 'SCFS', push(4), 'GC0', push(5), 'SWAP', 'SCFS', push(6), 'GC1', push(64),
                  'ADD', push(7), 'SWAP', 'SCFS', push(0), 'SZP0', push(0, 1), 'MIAP0', push(1), 'SZP0', push(1), 'SZP2',
                  push(0), 'SRP1', push(2), 'SRP2', push(1), 'SHZ1', push(0), 'SHC0', push(1), 'SZPS', 'IUP1'),
    # deltas: DELTAP1-3 at 11, 13 (base 0, shift 3), 16 and 24 ppem, DELTAC on a control value used by MIRP
    'deltas': ('SVTCA1', push(3), 'SDS', push(0), 'SDB', push(0xbf, 1, 0xd0, 2, 2), 'DELTAP1',
                  push(0x0f, 3, 1), 'DELTAP2', push(0x80, 4, 1), 'DELTAP3', push(8), 'SDB',
                  push(0x5f, 5, 0x3c, 6, 2), 'DELTAP1', push(0x8f, 7, 1), 'DELTAP2', push(0x0d, 0, 0x50, 1, 2),
                  'DELTAC1', push(0x86, 1, 1), 'DELTAC2', push(0x0a, 0, 1), 'DELTAC3', push(0), 'MDAP1', push(8, 0),
                  MIRP(0b00100), push(9, 1), MIRP(0b00100), 'IUP1'),
    # arithmetic, logic and stack instructions computing shifts, a user defined instruction, jumps, GETINFO
    'logic': ('SVTCA1', push(1, 7), 'ODD', push(64), 'MUL', push(2, 128), 'EVEN', push(32), 'MUL', 'ADD', 'SHPIX',
                 push(2, 30, 90), 'MIN', push(20), 'MAX', push(5), 'NEG', 'ABS', 'ADD', 'SHPIX',
                 push(4, 1, 2, 3), 'ROLL', 'SUB', 'SUB', push(16), 'MUL', 'SHPIX',
                 push(5, 75), 'CEILING', push(6, 75), 'FLOOR', 'SHPIX', 'SHPIX',
                 push(1, 0), 'OR', push(1), 'AND', 'NOT', 'NOT', 'IF', push(6, 16), 'SHPIX', 'EIF',
                 push(len(skipped) + 1, 1), 'JROT', skipped, push(len(skipped) + 1, 0), 'JROF', skipped,
                 push(0, 1), 'JROF', push(7, 8), 'SHPIX',
                 0x93, push(8), push(0x3f), 'GETINFO', push(255), 'AND', 'SHPIX', 'MPS', 'POP',
                 push(0, 0), 'SCANCTRL', 'SCANTYPE', 'IUP1'),
}
glyphs = {name: asm(*code) for name, code in items.items()}

def build(glyphs, file, sizes, json_file=None):
    glyph_order = ['.notdef'] + list(glyphs) + ['point-matched']
    outlines = {name: outline() for name in glyph_order}
    for name, code in glyphs.items(): outlines[name].program = program(code)
    outlines['.notdef'].program = program([])
    # a composite glyph: a component placed by matching its point 8 to point 2 of the first one, and its own program
    composite = Glyph()
    composite.numberOfContours = -1
    first, second = GlyphComponent(), GlyphComponent()
    first.glyphName, first.x, first.y, first.flags = 'vectors', 0, 0, 0x0001 | 0x0002 | 0x0004
    second.glyphName, second.firstPt, second.secondPt, second.flags = 'isect', 2, 8, 0x0001 | 0x0004
    composite.components = [first, second]
    composite.program = program(asm('SVTCA1', push(14, 32), 'SHPIX'))
    outlines['point-matched'] = composite

    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({0xe000 + i: name for i, name in enumerate(glyph_order[1:])})
    fb.setupGlyf(outlines)
    fb.setupHorizontalMetrics({name: (700, 0) for name in glyph_order})
    fb.setupHorizontalHeader(ascent=900, descent=-200)
    fb.setupNameTable({'familyName': 'Hinting Instructions', 'styleName': 'Regular'})
    fb.setupOS2(); fb.setupPost()
    font = fb.font
    # reproducible: no timestamps
    font.recalcTimestamp = False
    font['head'].created = font['head'].modified = 0
    cvt = newTable('cvt ')
    cvt.values = array.array('h', [80, 120, 300])
    font['cvt '] = cvt
    # the user defined instruction 0x93 shifts point 11; the control value program sets INSTCTRL (no effect) and a value
    fpgm = newTable('fpgm')
    fpgm.program = program(asm(push(0x93), 'IDEF', push(11, 20), 'SHPIX', 'ENDF'))
    font['fpgm'] = fpgm
    prep = newTable('prep')
    prep.program = program(asm(push(0, 2), 'INSTCTRL', push(2, 280), 'WCVTF', push(2), 'RCVT', 'POP'))
    font['prep'] = prep
    maxp = font['maxp']
    maxp.maxZones, maxp.maxTwilightPoints, maxp.maxStorage = 2, 4, 8
    maxp.maxFunctionDefs, maxp.maxInstructionDefs, maxp.maxStackElements = 4, 4, 64
    maxp.maxSizeOfInstructions = max(len(c) for c in glyphs.values())
    font.save(file)

    # FreeType's hinted outlines (v35 interpreter): 26.6 points with their on curve flags, and advances
    lib = freetype.get_handle()
    version = ctypes.c_uint(35)
    assert freetype.raw.FT_Property_Set(lib, b'truetype', b'interpreter-version', ctypes.byref(version)) == 0
    face = freetype.Face(file)
    expected = {}
    for size in sizes:
        face.set_char_size(size * 64, 0, 72, 72)
        for i, name in enumerate(glyph_order[1:]):
            face.load_char(chr(0xe000 + i), freetype.FT_LOAD_NO_AUTOHINT | freetype.FT_LOAD_NO_BITMAP)
            o = face.glyph.outline
            expected[f'{size}:{name}'] = {'advance': face.glyph.advance.x,
                                          'points': [[x, y, t & 1] for (x, y), t in zip(o.points, o.tags)]}
    if json_file:
        json.dump(expected, open(json_file, 'w'), separators=(',', ':'))
        print(len(expected), 'outlines')

    return expected


if __name__ == '__main__':
    build(glyphs, FILE, SIZES, os.path.join(fonts, 'hinting-instructions.json'))
