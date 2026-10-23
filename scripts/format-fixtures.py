# Writes the icons, cursors, Radiance HDRs and QOIs of tests/ico, tests/hdr and tests/qoi from a part of
# tests/targets/external.png, and prints the sha256 of their pixels as the references decode them: Pillow (icons,
# QOIs) and OpenCV (HDRs, converted to sRGB like ImageScript does). Needs Pillow, numpy and opencv-python-headless:
#   python scripts/format-fixtures.py
import hashlib, io, struct
from pathlib import Path
import numpy as np
from PIL import Image, IcoImagePlugin

root = Path(__file__).resolve().parent.parent
source = Image.open(root / 'tests' / 'targets' / 'external.png').convert('RGB')
sha = lambda pixels: hashlib.sha256(np.ascontiguousarray(pixels, np.uint8).tobytes()).hexdigest()
hashes = {}


def part(size, alpha=True):
    """a part of the source scaled to size, with an alpha gradient and a transparent corner"""
    im = source.crop((180, 160, 440, 420)).resize((size, size), Image.LANCZOS).convert('RGBA')
    if alpha:
        a = np.zeros((size, size), np.uint8)
        for y in range(size):
            for x in range(size):
                a[y, x] = 0 if x + y < size // 3 else min(255, 64 + (x * 191) // max(1, size - 1))
        im.putalpha(Image.fromarray(a))
    return im


# ---- icons and cursors: bitmaps of every depth with their AND masks, 32 bit ones with alpha, PNGs
def dib(im, bits, zero_alpha=False):
    """a bitmap of an icon: the info header (twice the height), palette, pixels and AND mask, bottom up"""
    w, h = im.size
    rgba = np.asarray(im)
    palette = b''
    if bits <= 8:
        q = im.convert('RGB').quantize(1 << bits, dither=Image.Dither.NONE)
        colors = q.getpalette()[:3 << bits] + [0] * (3 * (1 << bits) - len(q.getpalette()[:3 << bits]))
        palette = b''.join(bytes([colors[i * 3 + 2], colors[i * 3 + 1], colors[i * 3], 0]) for i in range(1 << bits))
        indices = np.asarray(q)
    stride = (w * bits + 31) // 32 * 4
    rows = b''
    for y in reversed(range(h)):
        row = bytearray(stride)
        for x in range(w):
            r, g, b, a = (int(v) for v in rgba[y, x])
            if bits <= 8:
                bit = x * bits
                row[bit >> 3] |= int(indices[y, x]) << (8 - bits - (bit & 7))
            elif bits == 24: row[x * 3:x * 3 + 3] = bytes([b, g, r])
            else: row[x * 4:x * 4 + 4] = bytes([b, g, r, 0 if zero_alpha else a])
        rows += bytes(row)
    mask_stride = (w + 31) // 32 * 4
    mask = b''
    for y in reversed(range(h)):
        row = bytearray(mask_stride)
        for x in range(w):
            if rgba[y, x, 3] < 128: row[x >> 3] |= 128 >> (x & 7)
        mask += bytes(row)
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, bits, 0, len(rows) + len(mask), 0, 0, 1 << bits if bits <= 8 else 0, 0)
    return header + palette + rows + mask


def png(im):
    out = io.BytesIO()
    im.save(out, 'PNG')
    return out.getvalue()


def icon(entries, cursor=False):
    """entries: (width, height, bits, data); cursors have a hot spot instead of planes and bits"""
    out = struct.pack('<HHH', 0, 2 if cursor else 1, len(entries))
    offset = 6 + 16 * len(entries)
    for i, (w, h, bits, data) in enumerate(entries):
        a, b = (3 + i, 5) if cursor else (1, bits)
        out += struct.pack('<BBBBHHII', w & 255, h & 255, 0, 0, a, b, len(data), offset)
        offset += len(data)
    return out + b''.join(e[3] for e in entries)


ico = root / 'tests' / 'ico'
ico.mkdir(exist_ok=True)
im32, im48 = part(32), part(48)
files = {
    '1bit.ico': [(32, 32, 1, dib(im32, 1))],
    '4bit.ico': [(32, 32, 4, dib(im32, 4))],
    '8bit.ico': [(32, 32, 8, dib(im32, 8))],
    '24bit.ico': [(32, 32, 24, dib(im32, 24))],
    '32bit.ico': [(32, 32, 32, dib(im32, 32))],
    # alpha that is zero everywhere: the AND mask says what's transparent, like for 24 bits
    '32bit-zero-alpha.ico': [(32, 32, 32, dib(im32, 32, zero_alpha=True))],
    # the largest image, of those as large the one with the most bits, not the first
    'sizes.ico': [(16, 16, 8, dib(part(16), 8)), (48, 48, 4, dib(im48, 4)), (48, 48, 32, dib(im48, 32)), (24, 24, 32, png(part(24)))],
    'png.ico': [(16, 16, 32, dib(part(16), 32)), (64, 64, 32, png(part(64)))],
    'cursor.cur': [(32, 32, 32, dib(im32, 32)), (16, 16, 4, dib(part(16), 4))],
}
for name, entries in files.items():
    (ico / name).write_bytes(icon(entries, name.endswith('.cur')))
    with open(ico / name, 'rb') as f:
        if name == '32bit-zero-alpha.ico':
            continue  # (Pillow makes it all transparent)
        w, h, bits, _ = max(entries, key=lambda e: (e[0] * e[1], e[2]))
        im = (Image.open(f) if name.endswith('.cur') else IcoImagePlugin.IcoFile(f).getimage((w, h), bits)).convert('RGBA')
        a = np.asarray(im).copy()
        # the pixels the AND mask makes transparent are transparent black
        if bits < 32: a[a[..., 3] == 0] = 0
        hashes[f'ico/{name}'] = sha(a)

# ---- Radiance HDR: values above 1 (clamped), zeros, runs; the same pixels in every orientation and encoding
hdr = root / 'tests' / 'hdr'
hdr.mkdir(exist_ok=True)
W, H = 23, 9
linear = (np.asarray(part(W, alpha=False).convert('RGB').resize((W, H)), np.float64) / 255) ** 2.2 * 1.6
linear[:, 15:] = linear[:, 15:16]  # runs
linear[0, :4] = 0


def rgbe(v):
    """floats to RGBE like Radiance (truncated mantissas)"""
    m = v.max(axis=-1)
    out = np.zeros(v.shape[:-1] + (4,), np.uint8)
    nz = m > 1e-32
    mant, exp = np.frexp(m[nz])
    scale = mant * 256 / m[nz]
    out[nz, :3] = (v[nz] * scale[:, None]).astype(np.uint8)
    out[nz, 3] = exp + 128
    return out


def rle_line(line):
    """a scan line run length encoded by channel"""
    out = bytes([2, 2, len(line) >> 8, len(line) & 255])
    for c in range(4):
        v, i = line[:, c], 0
        while i < len(v):
            run = 1
            while i + run < len(v) and run < 127 and v[i + run] == v[i]: run += 1
            if run >= 4:
                out += bytes([128 + run, v[i]]); i += run
            else:
                n = 1
                while i + n < len(v) and n < 128 and not (i + n + 3 < len(v) and v[i + n] == v[i + n + 1] == v[i + n + 2] == v[i + n + 3]): n += 1
                out += bytes([n]) + bytes(v[i:i + n]); i += n
    return out


def write_hdr(name, pixels, resolution, lines=None, fmt='32-bit_rle_rgbe', encode=rle_line):
    """pixels: RGBE in display order; lines: the scan lines in file order (default: rows top down)"""
    head = f'#?RADIANCE\n# ImageScript test\nFORMAT={fmt}\nEXPOSURE=1.0\n\n{resolution}\n'.encode()
    (hdr / name).write_bytes(head + b''.join(encode(l) for l in (pixels if lines is None else lines)))


pixels = rgbe(linear)
write_hdr('rle.hdr', pixels, f'-Y {H} +X {W}')
write_hdr('flat.hdr', pixels, f'-Y {H} +X {W}', encode=lambda l: l.tobytes())
write_hdr('bottom-up.hdr', pixels, f'+Y {H} +X {W}', pixels[::-1])
write_hdr('mirrored.hdr', pixels, f'-Y {H} -X {W}', pixels[:, ::-1])
write_hdr('columns.hdr', pixels, f'+X {W} -Y {H}', pixels.transpose(1, 0, 2))
write_hdr('columns-flipped.hdr', pixels, f'-X {W} +Y {H}', pixels.transpose(1, 0, 2)[::-1, ::-1])


# the old run length encoding: 1, 1, 1, n repeats the previous pixel n times, consecutive ones n << 8 more
def old_rle(line):
    out, i = b'', 0
    while i < len(line):
        out += line[i].tobytes()
        j = i + 1
        while j < len(line) and (line[j] == line[i]).all(): j += 1
        run = j - i - 1
        while run:
            out += bytes([1, 1, 1, run & 255]); run >>= 8
        i = j
    return out


write_hdr('old-rle.hdr', pixels, f'-Y {H} +X {W}', encode=old_rle)
# up to 40 times brighter than white, for the tone mapping
bright = rgbe(linear * 25)
write_hdr('bright.hdr', bright, f'-Y {H} +X {W}')
long = np.tile(rgbe(np.array([[0.2, 0.5, 0.9]])), (2, 600, 1))
long[1, 300:] = rgbe(np.array([[1.0, 0.25, 0.0]]))
write_hdr('old-rle-long.hdr', long, f'-Y 2 +X 600', encode=old_rle)

# XYZE: the pixels as CIE XYZ, by Radiance's primaries and equal energy white
prim = np.array([[0.640, 0.330], [0.290, 0.600], [0.150, 0.060]])
P = np.array([[x / y, 1, (1 - x - y) / y] for x, y in prim]).T
M = P * np.linalg.solve(P, np.ones(3))
write_hdr('xyze.hdr', rgbe(linear @ M.T), f'-Y {H} +X {W}', fmt='32-bit_rle_xyze')


def srgb(v):
    v = np.clip(v, 0, 1)
    return np.round(255 * np.where(v <= 0.0031308, 12.92 * v, 1.055 * v ** (1 / 2.4) - 0.055))


def decoded(pixels, reinhard=True):
    """RGBE as ImageScript decodes it: linear light, tone mapped by Reinhard's extended operator (the brightest
    luminance, at least 1, is white) or clamped, to sRGB, opaque"""
    e = pixels[..., 3:].astype(np.float64)
    v = np.where(e > 0, pixels[..., :3] * 2.0 ** (e - 136), 0)
    if reinhard:
        lum = np.maximum(0, v @ [0.2126, 0.7152, 0.0722])
        white = max(1, lum.max())
        v = v * ((1 + lum / white ** 2) / (1 + lum))[..., None]
    return np.concatenate([srgb(v), np.full(v.shape[:2] + (1,), 255)], axis=2)


# OpenCV reads the same (it can't read the old run length encoding)
import cv2
f = cv2.imread(str(hdr / 'rle.hdr'), cv2.IMREAD_UNCHANGED)
assert (srgb(f[..., ::-1]) == decoded(pixels, False)[..., :3]).all()
hashes['hdr/rle.hdr'] = sha(decoded(pixels))
hashes['hdr/bright.hdr (clamp, as OpenCV)'] = sha(decoded(bright, False))
f = cv2.imread(str(hdr / 'bright.hdr'), cv2.IMREAD_UNCHANGED)
assert (srgb(f[..., ::-1]) == decoded(bright, False)[..., :3]).all()
hashes['hdr/bright.hdr (reinhard)'] = sha(decoded(bright))
hashes['hdr/old-rle-long.hdr'] = sha(decoded(long))

# ---- QOI: Pillow writes the same as the reference encoder except the colorspace byte (it says linear)
qoi = root / 'tests' / 'qoi'
qoi.mkdir(exist_ok=True)
for name, im in [('rgba.qoi', part(64)), ('rgb.qoi', part(64, alpha=False).convert('RGB'))]:
    out = io.BytesIO()
    im.save(out, 'QOI')
    data = bytearray(out.getvalue())
    data[13] = 0
    (qoi / name).write_bytes(data)
    im.save(qoi / name.replace('.qoi', '.png'))
    hashes[f'qoi/{name}'] = sha(np.asarray(Image.open(qoi / name).convert('RGBA')))

for name, digest in hashes.items(): print(f"'{name}': '{digest}',")
