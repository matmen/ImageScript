# Writes the lossy WebPs of tests/webp that test the decoder's loop filter variants, from a 96x72 part of
# tests/jpegs/orig-420-base.jpg, and prints the sha256 of the RGBA pixels dwebp decodes, for tests/webp.js: the simple
# filter (cwebp -nostrong), sharpness, and loop filter deltas (which libwebp never writes but libvpx does: a vpxenc
# keyframe in a WebP container). Needs Pillow, numpy, cwebp, dwebp and vpxenc:
#   python scripts/webp-fixtures.py
import hashlib, struct, subprocess, tempfile
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent.parent
webp = root / 'tests' / 'webp'
source = Image.open(root / 'tests' / 'jpegs' / 'orig-420-base.jpg').convert('RGB').crop((60, 40, 156, 112))

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    source.save(tmp / 'source.ppm')
    subprocess.run(['cwebp', '-quiet', '-q', '50', '-nostrong', tmp / 'source.ppm', '-o', webp / 'simple-filter.webp'], check=True)
    subprocess.run(['cwebp', '-quiet', '-q', '60', '-sharpness', '6', '-f', '80', tmp / 'source.ppm', '-o', webp / 'sharpness.webp'], check=True)

    ycbcr = source.convert('YCbCr')
    planes = [np.array(ycbcr.getchannel(0))] + [np.array(ycbcr.getchannel(c).resize((48, 36))) for c in (1, 2)]
    (tmp / 'source.yuv').write_bytes(b''.join(p.tobytes() for p in planes))
    subprocess.run(['vpxenc', '--codec=vp8', '-w', '96', '-h', '72', '--i420', '--limit=1', '--ivf', '--end-usage=q',
                    '--cq-level=50', '--min-q=40', '--max-q=63', '-q', '-o', tmp / 'frame.ivf', tmp / 'source.yuv'], check=True)
    ivf = (tmp / 'frame.ivf').read_bytes()
    header = struct.unpack('<H', ivf[6:8])[0]
    frame = ivf[header + 12:header + 12 + struct.unpack('<I', ivf[header:header + 4])[0]]
    chunk = b'VP8 ' + struct.pack('<I', len(frame)) + frame + b'\0' * (len(frame) & 1)
    (webp / 'lf-deltas.webp').write_bytes(b'RIFF' + struct.pack('<I', 4 + len(chunk)) + b'WEBP' + chunk)

    for name in ['simple-filter', 'sharpness', 'lf-deltas']:
        pam = subprocess.run(['dwebp', '-quiet', webp / f'{name}.webp', '-pam', '-o', '-'], check=True, capture_output=True).stdout
        print(f"    '{name}': '{hashlib.sha256(pam[pam.index(b'ENDHDR\n') + 7:]).hexdigest()}',")
