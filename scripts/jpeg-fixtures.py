# Writes the JPEGs of tests/jpegs that test the decoder's rarer paths, from tests/jpegs/orig-420-base.jpg, and prints
# the sha256 of their RGBA pixels as Pillow (libjpeg-turbo) decodes them, for tests/jpeg.js: 4:4:0 and 4:1:1 chroma
# subsampling (cjpeg), YCCK (scripts/jpeg-ycck.c, built with the libjpeg-turbo headers), and fill bytes (0xff) before
# markers. Needs Pillow, cjpeg and a C compiler:
#   python scripts/jpeg-fixtures.py
import hashlib, subprocess, tempfile
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
jpegs = root / 'tests' / 'jpegs'
sha = lambda path: hashlib.sha256(Image.open(path).convert('RGBA').tobytes()).hexdigest()

with tempfile.TemporaryDirectory() as tmp:
    ppm = Path(tmp) / 'orig.ppm'
    Image.open(jpegs / 'orig-420-base.jpg').convert('RGB').save(ppm)

    for name, sample in [('sub-440', '1x2'), ('sub-411', '4x1')]:
        subprocess.run(['cjpeg', '-quality', '90', '-sample', sample, '-outfile', str(jpegs / f'{name}.jpg'), str(ppm)], check=True)

    tool = Path(tmp) / 'jpeg-ycck'
    subprocess.run(['cc', '-O2', '-o', str(tool), str(root / 'scripts' / 'jpeg-ycck.c'), '-ljpeg'], check=True)
    subprocess.run([str(tool), str(ppm), str(jpegs / 'ycck.jpg')], check=True)

    # (every marker after SOI preceded by two fill bytes, which markers may have)
    data = (jpegs / 'orig-420-base.jpg').read_bytes()
    out, i = bytearray(data[:2]), 2
    while i < len(data):
        if data[i] == 0xff and data[i + 1] not in (0x00, 0xff) and not 0xd0 <= data[i + 1] <= 0xd7:
            out += b'\xff\xff'
            length = 2 if data[i + 1] == 0xd9 else 2 + (data[i + 2] << 8 | data[i + 3])
            if data[i + 1] == 0xda:
                # the scan: everything up to the next marker that isn't a stuffed byte or restart marker
                j = i + length
                while not (data[j] == 0xff and data[j + 1] not in (0x00,) and not 0xd0 <= data[j + 1] <= 0xd7): j += 1
                length = j - i
            out += data[i:i + length]
            i += length
        else:
            raise ValueError(f'unexpected byte at {i}')
    (jpegs / 'fill-bytes.jpg').write_bytes(out)

for name in ['sub-440', 'sub-411', 'ycck', 'fill-bytes']:
    print(f"\t'{name}': '{sha(jpegs / f'{name}.jpg')}',")
