# Prints the SHA-256 of what cjxl -e 1 (libjxl's fast lossless mode) writes for the images of tests/jxl-encode.js:
# Image.encodeJXL writes the same. The channels are those encodeJXL picks (grey if every pixel is, alpha if one isn't
# opaque). libjxl's output depends on the CPU: with AVX2 or NEON it works in chunks of 16 pixels (what encodeJXL does),
# without SIMD in chunks of 8 (the test checks these too), with AVX-512 in chunks of 32. Needs Pillow and cjxl:
#   CJXL=path/to/cjxl python scripts/jxl-lossless-references.py
import hashlib, os, subprocess, tempfile
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent.parent
CJXL = os.environ.get('CJXL', 'cjxl')
tmp = Path(tempfile.mkdtemp())


def images():
    for name in ['external.png', 'circle.png', 'screen.png', 'potato.png']:
        yield name, np.asarray(Image.open(root / 'tests' / 'targets' / name).convert('RGBA'))
    # (grey: the red channel)
    red = np.asarray(Image.open(root / 'tests' / 'targets' / 'external.png').convert('RGBA'))[..., 0]
    yield 'external.png grey', np.dstack([red, red, red, np.full_like(red, 255)])


for name, rgba in images():
    grey = (rgba[..., 0] == rgba[..., 1]).all() and (rgba[..., 0] == rgba[..., 2]).all()
    opaque = (rgba[..., 3] == 255).all()
    channels = [0] if grey else [0, 1, 2]
    if not opaque: channels.append(3)
    a = rgba[..., channels]
    Image.fromarray(a[..., 0] if len(channels) == 1 else a, {1: 'L', 2: 'LA', 3: 'RGB', 4: 'RGBA'}[len(channels)]).save(tmp / 'in.png')
    subprocess.run([CJXL, '--quiet', str(tmp / 'in.png'), str(tmp / 'out.jxl'), '-d', '0', '-e', '1'], check=True)
    print(f"    '{name}': '{hashlib.sha256((tmp / 'out.jxl').read_bytes()).hexdigest()}',")
