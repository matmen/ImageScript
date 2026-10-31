# Writes tests/gifs/interlaced.gif (Pillow writes interlaced GIFs; an odd height, so every pass has a short end) and
# prints the sha256 of its RGBA pixels as Pillow decodes them, for tests/gif.js. Needs Pillow:
#   python scripts/gif-fixtures.py
import hashlib
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
out = root / 'tests' / 'gifs' / 'interlaced.gif'
source = Image.open(root / 'tests' / 'jpegs' / 'orig-420-base.jpg').convert('RGB').crop((40, 20, 120, 57))
source.quantize(32).save(out, interlace=True)
print(Image.open(out).size, hashlib.sha256(Image.open(out).convert('RGBA').tobytes()).hexdigest())
