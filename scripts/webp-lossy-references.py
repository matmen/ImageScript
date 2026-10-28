# Prints the sha256 of the VP8 chunks cwebp (libwebp) writes for some of tests/targets, with its default settings and
# a quality (and some with other methods, ImageScript's efforts, or -sharp_yuv), for tests/webp-lossy.js (ImageScript's lossy encoder writes the same). The images are passed as PPM/PAM,
# which cwebp reads without libpng:
#   CWEBP=path/to/cwebp python scripts/webp-lossy-references.py
import hashlib, os, struct, subprocess, tempfile
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
CWEBP = os.environ.get('CWEBP', 'cwebp')
tmp = Path(tempfile.mkdtemp())
images = ['external.png', 'potato.png', 'issues.png', 'resize.png', 'font-4.png']
qualities = [10, 75, 95]
# the other methods (at quality 75)
method_images = ['external.png', 'potato.png', 'font-4.png']
methods = [0, 1, 2, 3, 5, 6]
# -sharp_yuv (at quality 75, methods 4 and 2)
sharp_images = ['external.png', 'potato.png', 'font-4.png']


def vp8_chunk(data):
    o = 12
    while o + 8 <= len(data):
        size = struct.unpack('<I', data[o + 4:o + 8])[0]
        if data[o:o + 4] == b'VP8 ':
            return data[o + 8:o + 8 + size]
        o += 8 + size + (size & 1)


for name in images:
    im = Image.open(root / 'tests' / 'targets' / name)
    alpha = im.mode in ('RGBA', 'LA') or 'transparency' in im.info
    im = im.convert('RGBA' if alpha else 'RGB')
    w, h = im.size
    src = tmp / ('in.pam' if alpha else 'in.ppm')
    header = f'P7\nWIDTH {w}\nHEIGHT {h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n' if alpha else f'P6\n{w} {h}\n255\n'
    src.write_bytes(header.encode() + im.tobytes())
    runs = [(q, 4, False) for q in qualities] + [(75, m, False) for m in methods if name in method_images]
    runs += [(75, m, True) for m in [4, 2] if name in sharp_images]
    for q, m, sharp in runs:
        subprocess.run([CWEBP, '-quiet', '-q', str(q), '-m', str(m), *(['-sharp_yuv'] if sharp else []), str(src), '-o', str(tmp / 'out.webp')], check=True)
        key = f'{name} {q} {m} sharp' if sharp else f'{name} {q}' if m == 4 else f'{name} {q} {m}'
        print(f"    '{key}': '{hashlib.sha256(vp8_chunk((tmp / 'out.webp').read_bytes())).hexdigest()}',")
