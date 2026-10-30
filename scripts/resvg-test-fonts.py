# Writes tests/fonts/resvg: resvg's test fonts (github.com/linebender/resvg, crates/resvg/tests/fonts, with their
# licenses) subset to the characters of the test cases in tests/svgs/resvg and the ones their letters and
# marks compose to (the shaper composes them where a font has them), with all names and layout features (and the
# variations of Roboto Flex). Its other small subsets (emoji, CFF and sbix) are copied as they are. Needs fontTools:
#   RESVG_FONTS=path/to/resvg/crates/resvg/tests/fonts python scripts/resvg-test-fonts.py
import os, re, shutil, unicodedata
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
source = Path(os.environ['RESVG_FONTS'])
target = root / 'tests' / 'fonts' / 'resvg'
target.mkdir(parents=True, exist_ok=True)

used = {chr(c) for c in range(0x20, 0x7f)}
for case in (root / 'tests' / 'svgs' / 'resvg').rglob('*.svg'):
    content = case.read_text(encoding='utf-8')
    if '<text' in content:
        used |= set(content)
# (Roboto Flex, variable with many axes, only the characters of the cases that use it)
flex = set()
for case in (root / 'tests' / 'svgs' / 'resvg').rglob('*.svg'):
    content = case.read_text(encoding='utf-8')
    if 'Roboto Flex' in content:
        flex |= set(''.join(re.findall(r'>([^<]*)</text>', content)))
marks = [c for c in used if unicodedata.combining(c)]
composed = {unicodedata.normalize('NFC', b + m) for b in used for m in marks}
characters = sorted(ord(c) for c in used | {c for c in composed if len(c) == 1})

for path in sorted(source.iterdir()):
    name = path.name
    if path.suffix not in ('.ttf', '.otf'):
        if 'LICENSE' in name or 'OFL' in name:
            shutil.copy(path, target / name)
        continue
    if ('.subset.' in name and not name.startswith('RobotoFlex')) or name.startswith('CFF-and-SBIX'):
        shutil.copy(path, target / name)
        continue
    options = subset.Options()
    options.layout_features = ['*']
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.name_legacy = True
    options.notdef_outline = True
    options.hinting = True
    options.legacy_kern = True
    font = TTFont(path)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=sorted(ord(c) for c in flex) if name.startswith('RobotoFlex') else characters)
    subsetter.subset(font)
    font.save(target / name)
