# builds "colrv1 paints.ttf" (python colrv1-paints.py "colrv1 paints.ttf", needs fontTools): a COLRv1 test font with one
# glyph per paint feature, on U+E000 onwards
import sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.ttLib.tables.otTables import PaintFormat as F, ExtendMode, CompositeMode

UPM = 1000
def rect(x0, y0, x1, y1):
    pen = TTGlyphPen(None)
    pen.moveTo((x0, y0)); pen.lineTo((x0, y1)); pen.lineTo((x1, y1)); pen.lineTo((x1, y0)); pen.closePath()
    return pen.glyph()
def circle(cx, cy, r):
    import math
    pen = TTGlyphPen(None)
    n = 16
    pts = [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n)]
    pen.moveTo(pts[0])
    for k in range(1, n): pen.lineTo(pts[k])
    pen.closePath()
    return pen.glyph()

names = ['.notdef', 'square', 'disc', 'bar']
outlines = {'.notdef': rect(100, 0, 900, 800), 'square': rect(100, 0, 900, 800), 'disc': circle(500, 400, 350), 'bar': rect(450, 0, 550, 800)}
features = ['linear', 'linear_p2', 'radial', 'sweep', 'repeat', 'reflect', 'rotate', 'skew', 'transform', 'scale_center', 'colrglyph', 'var_solid', 'multiply', 'src_in', 'xor', 'hue', 'foreground']
for f in features: names.append(f); outlines[f] = rect(0, 0, 0, 0) if False else TTGlyphPen(None).glyph()

palette = [(1, 0, 0, 1), (0, 0.6, 0, 1), (0, 0, 1, 1), (1, 0.8, 0, 1), (0.5, 0, 0.5, 0.6)]
def line(stops, extend=ExtendMode.PAD):
    return {'Extend': extend, 'ColorStop': [{'StopOffset': o, 'PaletteIndex': i, 'Alpha': 1.0} for o, i in stops]}
rgb = [(0, 0), (0.5, 1), (1, 2)]
glyph = lambda name, paint: {'Format': F.PaintGlyph, 'Glyph': name, 'Paint': paint}
solid = lambda i, a=1.0: {'Format': F.PaintSolid, 'PaletteIndex': i, 'Alpha': a}
paints = {
    'linear': glyph('square', {'Format': F.PaintLinearGradient, 'ColorLine': line(rgb), 'x0': 100, 'y0': 0, 'x1': 900, 'y1': 0, 'x2': 100, 'y2': 800}),
    'linear_p2': glyph('square', {'Format': F.PaintLinearGradient, 'ColorLine': line(rgb), 'x0': 100, 'y0': 0, 'x1': 900, 'y1': 0, 'x2': 900, 'y2': 800}),
    'radial': glyph('square', {'Format': F.PaintRadialGradient, 'ColorLine': line(rgb), 'x0': 500, 'y0': 400, 'r0': 50, 'x1': 500, 'y1': 400, 'r1': 400}),
    'sweep': glyph('disc', {'Format': F.PaintSweepGradient, 'ColorLine': line([(0, 0), (0.33, 1), (0.66, 2), (1, 0)]), 'centerX': 500, 'centerY': 400, 'startAngle': 0, 'endAngle': 360}),
    'repeat': glyph('square', {'Format': F.PaintLinearGradient, 'ColorLine': line([(0, 0), (1, 3)], ExtendMode.REPEAT), 'x0': 400, 'y0': 0, 'x1': 600, 'y1': 0, 'x2': 400, 'y2': 800}),
    'reflect': glyph('square', {'Format': F.PaintLinearGradient, 'ColorLine': line([(0, 0), (1, 3)], ExtendMode.REFLECT), 'x0': 400, 'y0': 0, 'x1': 600, 'y1': 0, 'x2': 400, 'y2': 800}),
    'rotate': {'Format': F.PaintRotateAroundCenter, 'angle': 30, 'centerX': 500, 'centerY': 400, 'Paint': glyph('bar', solid(2))},
    'skew': {'Format': F.PaintSkewAroundCenter, 'xSkewAngle': 20, 'ySkewAngle': 0, 'centerX': 500, 'centerY': 400, 'Paint': glyph('square', solid(1))},
    'transform': {'Format': F.PaintTransform, 'Transform': {'xx': 0.5, 'yx': 0, 'xy': 0, 'yy': 0.5, 'dx': 250, 'dy': 200}, 'Paint': glyph('square', solid(0))},
    'scale_center': {'Format': F.PaintScaleAroundCenter, 'scaleX': 0.5, 'scaleY': 1, 'centerX': 500, 'centerY': 400, 'Paint': glyph('disc', solid(3))},
    'colrglyph': {'Format': F.PaintColrLayers, 'Layers': [glyph('square', solid(3)), {'Format': F.PaintColrGlyph, 'Glyph': 'rotate'}]},
    'var_solid': glyph('disc', {'Format': F.PaintVarSolid, 'PaletteIndex': 0, 'Alpha': 0.5, 'VarIndexBase': 0xFFFFFFFF}),
    'multiply': {'Format': F.PaintComposite, 'CompositeMode': CompositeMode.MULTIPLY, 'SourcePaint': glyph('disc', solid(3)), 'BackdropPaint': glyph('square', solid(2))},
    'src_in': {'Format': F.PaintComposite, 'CompositeMode': CompositeMode.SRC_IN, 'SourcePaint': glyph('square', {'Format': F.PaintLinearGradient, 'ColorLine': line(rgb), 'x0': 100, 'y0': 0, 'x1': 900, 'y1': 0, 'x2': 100, 'y2': 800}), 'BackdropPaint': glyph('disc', solid(0))},
    'xor': {'Format': F.PaintComposite, 'CompositeMode': CompositeMode.XOR, 'SourcePaint': glyph('disc', solid(0)), 'BackdropPaint': glyph('square', solid(2))},
    'hue': {'Format': F.PaintComposite, 'CompositeMode': CompositeMode.HSL_HUE, 'SourcePaint': glyph('disc', solid(1)), 'BackdropPaint': glyph('square', solid(0))},
    'foreground': {'Format': F.PaintColrLayers, 'Layers': [glyph('square', solid(0xFFFF)), glyph('disc', solid(4))]},
}
fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap({0xE000 + k: f for k, f in enumerate(features)})
fb.setupGlyf(outlines)
fb.setupHorizontalMetrics({n: (1000, 0) for n in names})
fb.setupHorizontalHeader(ascent=900, descent=-100)
fb.setupNameTable({'familyName': 'COLRv1 Test', 'styleName': 'Regular'})
fb.setupOS2(); fb.setupPost()
fb.font['COLR'] = buildCOLR(paints, glyphMap=fb.font.getReverseGlyphMap(), clipBoxes={f: (0, -100, 1000, 900) for f in features})
fb.font['CPAL'] = buildCPAL([palette])
fb.save(sys.argv[1])
print('features', features)
