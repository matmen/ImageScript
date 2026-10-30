# Writes tests/icc: a part of tests/targets/external.png (with an alpha gradient) with ICC profiles embedded in PNGs,
# a lossless WebP (and an animated one), a TIFF, a JPEG and an AVIF, and what LittleCMS (lcms2, through Pillow's
# ImageCms) converts them to, relative colorimetric to sRGB, as PNGs: from the source pixels for the lossless formats,
# from what Pillow decodes for JPEG and AVIF. The profiles are matrix/TRC ones written here (Display P3 with a
# parametric curve, Adobe RGB with a gamma, P3 with a table curve, Rec. 2020 with a type 4 parametric curve, gray), and
# one that is sRGB (its pixels stay as they are), and a gray one on a color image (not applied). Also JPEG XLs by
# cjxl: lossless ones (their pixels are in the profile's space) and a lossy one (XYB, decoded to sRGB: its profile is
# only what the image was before). Needs Pillow (with AVIF), numpy and cjxl (libjxl):
#   CJXL=path/to/cjxl python scripts/icc-fixtures.py
import io, os, struct, subprocess
from pathlib import Path
import numpy as np
from PIL import Image, ImageCms

root = Path(__file__).resolve().parent.parent
out = root / 'tests' / 'icc'
out.mkdir(exist_ok=True)

D50 = np.array([0.9642, 1.0, 0.8249])
BRADFORD = np.array([[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]])
D65 = (0.3127, 0.3290)


def xyz(x, y):
    return np.array([x / y, 1.0, (1 - x - y) / y])


def s15(v):
    return struct.pack('>i', int(round(v * 65536)))


def tag_xyz(v):
    return b'XYZ \0\0\0\0' + b''.join(s15(c) for c in v)


def tag_gamma(g):
    return b'curv\0\0\0\0' + struct.pack('>IH', 1, int(round(g * 256))) + b'\0\0'


def tag_table(values):
    return b'curv\0\0\0\0' + struct.pack('>I', len(values)) + b''.join(struct.pack('>H', int(round(v * 65535))) for v in values) + b'\0\0' * (len(values) % 2)


def tag_para(kind, params):
    return b'para\0\0\0\0' + struct.pack('>H', kind) + b'\0\0' + b''.join(s15(p) for p in params)


def tag_mluc(text):
    t = text.encode('utf-16-be')
    return b'mluc\0\0\0\0' + struct.pack('>II', 1, 12) + b'enUS' + struct.pack('>II', len(t), 28) + t


def tag_desc(text):
    b = text.encode() + b'\0'
    return b'desc\0\0\0\0' + struct.pack('>I', len(b)) + b + b'\0' * 79


def profile(tags, version, space=b'RGB '):
    entries, data, offset = [], b'', 132 + 12 * len(tags)
    for sig, body in tags:
        data += b'\0' * (-(offset + len(data)) % 4)
        entries.append((sig, offset + len(data), len(body)))
        data += body
    data += b'\0' * (-len(data) % 4)
    header = (struct.pack('>I4sI4s4s4s', offset + len(data), b'lcms', version, b'mntr', space, b'XYZ ') + b'\0' * 12 + b'acsp' + b'\0' * 28
              + b''.join(s15(c) for c in D50) + b'\0' * 48)
    return header + struct.pack('>I', len(tags)) + b''.join(struct.pack('>4sII', *e) for e in entries) + data


def rgb_profile(primaries, trc, name, version=0x04300000):
    """primaries (xy, white D65) adapted to D50 by Bradford, like ICC profiles have them"""
    W = xyz(*D65)
    P = np.stack([xyz(*p) for p in primaries], axis=1)
    M = P * np.linalg.solve(P, W)
    A = np.linalg.inv(BRADFORD) @ np.diag((BRADFORD @ D50) / (BRADFORD @ W)) @ BRADFORD
    M = A @ M
    chad = b'sf32\0\0\0\0' + b''.join(s15(v) for v in A.flatten())
    desc = tag_mluc(name) if version >= 0x04000000 else tag_desc(name)
    return profile([(b'desc', desc), (b'wtpt', tag_xyz(D50)), (b'chad', chad), (b'rXYZ', tag_xyz(M[:, 0])), (b'gXYZ', tag_xyz(M[:, 1])),
                    (b'bXYZ', tag_xyz(M[:, 2])), (b'rTRC', trc), (b'gTRC', trc), (b'bTRC', trc)], version)


P3 = [(0.680, 0.320), (0.265, 0.690), (0.150, 0.060)]
SRGB_TRC = tag_para(3, [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045])
profiles = {
    'display-p3': rgb_profile(P3, SRGB_TRC, 'Display P3'),
    'adobe-rgb': rgb_profile([(0.64, 0.33), (0.21, 0.71), (0.15, 0.06)], tag_gamma(563 / 256), 'Adobe RGB', 0x02100000),
    'p3-table': rgb_profile(P3, tag_table([(i / 1023) ** 1.8 for i in range(1024)]), 'P3 table'),
    'rec2020': rgb_profile([(0.708, 0.292), (0.170, 0.797), (0.131, 0.046)], tag_para(4, [2.2, 0.95, 0.05, 0.08, 0.06, 0.0, 0.001]), 'Rec. 2020'),
    'srgb': rgb_profile([(0.64, 0.33), (0.30, 0.60), (0.15, 0.06)], SRGB_TRC, 'sRGB'),
}
gray_profile = profile([(b'desc', tag_mluc('Gray 2.2')), (b'wtpt', tag_xyz(D50)), (b'kTRC', tag_gamma(2.2))], 0x04300000, b'GRAY')

srgb = ImageCms.createProfile('sRGB')
source = Image.open(root / 'tests' / 'targets' / 'external.png').convert('RGB').crop((180, 160, 440, 420)).resize((64, 64), Image.LANCZOS)
alpha = Image.fromarray(np.tile(np.linspace(80, 255, 64).astype(np.uint8), (64, 1)))


def convert(im, icc):
    mode = 'L' if im.mode == 'L' else 'RGB'
    converted = ImageCms.profileToProfile(im.convert(mode), ImageCms.ImageCmsProfile(io.BytesIO(icc)), srgb,
                                          renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, outputMode='RGB')
    return converted


for name, icc in profiles.items():
    rgba = source.copy()
    rgba.putalpha(alpha)
    rgba.save(out / f'{name}.png', icc_profile=icc)
    ref = convert(source, icc)
    ref.putalpha(alpha)
    ref.save(out / f'{name}.ref.png')

icc = profiles['display-p3']
rgba = source.copy()
rgba.putalpha(alpha)
rgba.save(out / 'display-p3.webp', lossless=True, icc_profile=icc)
rgba.save(out / 'display-p3.tiff', icc_profile=icc, compression='tiff_deflate')
# (opaque frames: they aren't blended onto each other)
frames = [source, source.transpose(Image.FLIP_LEFT_RIGHT)]
frames[0].save(out / 'display-p3-animated.webp', save_all=True, append_images=frames[1:], lossless=True, icc_profile=icc, duration=100)
for i, frame in enumerate(frames):
    convert(frame, icc).save(out / f'display-p3-animated-{i + 1}.ref.png')
source.save(out / 'display-p3.jpg', quality=95, icc_profile=icc)
convert(Image.open(out / 'display-p3.jpg'), icc).save(out / 'display-p3.jpg.ref.png')
source.save(out / 'display-p3.avif', quality=95, icc_profile=icc)
convert(Image.open(out / 'display-p3.avif'), icc).save(out / 'display-p3.avif.ref.png')

gray = source.convert('L')
gray.save(out / 'gray.png', icc_profile=gray_profile)
convert(gray, gray_profile).save(out / 'gray.ref.png')
# a gray profile on a color image (invalid, like libpng says: not applied)
source.save(out / 'gray-on-rgb.png', icc_profile=gray_profile)

# JPEG XLs: lossless (the pixels in the profile's space, compared with the PNGs' references) and lossy (XYB with the
# profile, decoded to sRGB without it)
for name, distance in [('display-p3', 0), ('gray', 0), ('rec2020', 1)]:
    subprocess.run([os.environ.get('CJXL', 'cjxl'), '-d', str(distance), str(out / f'{name}.png'), str(out / f'{name}{"-xyb" if distance else ""}.jxl')], check=True, capture_output=True)
