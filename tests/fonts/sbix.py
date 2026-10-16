# builds "sbix.ttf" (python sbix.py sbix.ttf, needs fontTools): an sbix test font, U+E000 a red square PNG with a blue
# corner, U+E001 the same bitmap through a 'dupe' record, one strike at 64 ppem
import sys, struct, zlib
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.sbixStrike import Strike
from fontTools.ttLib.tables.sbixGlyph import Glyph as SbixGlyph

def png(width, height, pixel):
    rows = b''.join(b'\0' + b''.join(bytes(pixel(x, y)) for x in range(width)) for y in range(height))
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')

names = ['.notdef', 'square', 'dupe']
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap({0xE000: 'square', 0xE001: 'dupe'})
fb.setupGlyf({n: TTGlyphPen(None).glyph() for n in names})
fb.setupHorizontalMetrics({n: (1000, 0) for n in names})
fb.setupHorizontalHeader(ascent=900, descent=-100)
fb.setupNameTable({'familyName': 'sbix Test', 'styleName': 'Regular'})
fb.setupOS2(); fb.setupPost()
image = png(48, 48, lambda x, y: (0, 0, 255, 255) if x < 12 and y < 12 else (255, 0, 0, 255))
strike = Strike(ppem=64, resolution=72)
strike.glyphs['square'] = SbixGlyph(glyphName='square', graphicType='png ', originOffsetX=8, originOffsetY=-4, imageData=image)
strike.glyphs['dupe'] = SbixGlyph(glyphName='dupe', graphicType='dupe', referenceGlyphName='square')
sbix = newTable('sbix'); sbix.version = 1; sbix.flags = 1; sbix.strikes = {64: strike}
fb.font['sbix'] = sbix
fb.save(sys.argv[1])
