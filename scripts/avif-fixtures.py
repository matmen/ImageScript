# Writes the AVIFs of tests/avif: AV1 streams encoded by aomenc (libaom) from parts of tests/targets, in containers
# written here (items, grids, alpha, transformations, an image sequence), and prints the sha256 of their pixels as
# libavif decodes them: avifdec (with dav1d, bilinear chroma upsampling), except monochrome ones (avifdec writes their
# luma as gray without converting its range: Pillow, which uses libavif too) and the transformed one (avifdec doesn't
# apply transformations: applied here). The lossless and HDR ones are compared with source.png instead. Needs numpy,
# Pillow (with AVIF support), aomenc and avifdec:
#   AOMENC=path/to/aomenc AVIFDEC=path/to/avifdec python scripts/avif-fixtures.py
import hashlib, os, struct, subprocess, tempfile
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent.parent
out = root / 'tests' / 'avif'
out.mkdir(exist_ok=True)
AOMENC, AVIFDEC = os.environ.get('AOMENC', 'aomenc'), os.environ.get('AVIFDEC', 'avifdec')
tmp = Path(tempfile.mkdtemp())
sha = lambda pixels: hashlib.sha256(np.ascontiguousarray(pixels, np.uint8).tobytes()).hexdigest()
hashes = {}


def source(name, w, h, box=None):
    """a part of a test target scaled to w x h, as RGB (0-255)"""
    im = Image.open(root / 'tests' / 'targets' / name).convert('RGB')
    return np.asarray(im.crop(box or (0, 0) + im.size).resize((w, h), Image.LANCZOS)).astype(np.float64)


def alpha_ramp(w, h):
    """an alpha gradient with a transparent corner"""
    y, x = np.mgrid[0:h, 0:w]
    return np.where(x + y < min(w, h) // 3, 0, np.minimum(255, 64 + x * 191 // max(1, w - 1))).astype(np.float64)


# ---- AV1 streams
def yuv(rgb, layout, bits, full=False):
    """BT.601 YCbCr planes of RGB (0-255), chroma subsampled by averaging"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    u, v = (b - y) * 0.564 + 128, (r - y) * 0.713 + 128
    if not full:
        y, u, v = 16 + y * 219 / 255, 128 + (u - 128) * 224 / 255, 128 + (v - 128) * 224 / 255
    if layout == 'mono':
        return [y]
    sx, sy = {'420': (1, 1), '422': (1, 0), '444': (0, 0)}[layout]

    def sub(p):
        h, w = p.shape
        p = np.pad(p, ((0, h % (1 << sy)), (0, w % (1 << sx))), mode='edge')
        return p.reshape(p.shape[0] >> sy, 1 << sy, p.shape[1] >> sx, 1 << sx).mean(axis=(1, 3))
    return [y, sub(u), sub(v)]


def y4m(planes, layout, bits, full, scale=True):
    """a y4m file of planes (0-255, or already in the bit depth's range)"""
    h, w = planes[0].shape
    top = (1 << bits) - 1
    data = b''.join(np.clip(np.round(p * top / 255 if scale else p), 0, top).astype(np.uint16 if bits > 8 else np.uint8).tobytes() for p in planes)
    cs = {'420': 'C420jpeg' if bits == 8 else f'C420p{bits}', '422': f'C422p{bits}' if bits > 8 else 'C422',
          '444': f'C444p{bits}' if bits > 8 else 'C444', 'mono': f'Cmono{bits}' if bits > 8 else 'Cmono'}[layout]
    header = f'YUV4MPEG2 W{w} H{h} F30:1 Ip A1:1 {cs}' + (' XCOLORRANGE=FULL' if full else '') + '\n'
    return header.encode(), data


def leb128(d, o):
    v = 0
    for i in range(8):
        v |= (d[o] & 127) << (7 * i)
        o += 1
        if not d[o - 1] & 128:
            break
    return v, o


def obus(d):
    """(type, bytes) of the OBUs of a low overhead bitstream"""
    o = 0
    while o < len(d):
        start, t, ext = o, d[o] >> 3 & 15, d[o] >> 2 & 1
        size, o = leb128(d, o + 1 + ext)
        yield t, d[start:o + size]
        o += size


def encode(frames, layout, bits, args, full=False, intra=True):
    """aomenc's temporal units (OBUs without temporal delimiters) of the y4m frames (lists of planes); a single frame
    with the all intra mode unless intra is False"""
    header = None
    body = b''
    for planes in frames:
        h, data = y4m(planes, layout, bits, full, scale=not isinstance(planes, tuple))
        header = header or h
        body += b'FRAME\n' + data
    src, dst = tmp / 'in.y4m', tmp / 'out.obu'
    src.write_bytes(header + body)
    profile = ['--profile=2'] if bits == 12 or layout == '422' else ['--profile=1'] if layout == '444' else []
    usage = ['--allintra'] if len(frames) == 1 and intra else ['--good', '--kf-max-dist=100', '--lag-in-frames=0']
    r = subprocess.run([AOMENC, *usage, f'--limit={len(frames)}', '--cpu-used=6', '--end-usage=q', '--obu', '--threads=1',
                        f'--bit-depth={bits}', f'--input-bit-depth={bits}', *profile, *(['--monochrome'] if layout == 'mono' else []),
                        *args, '-o', str(dst), str(src)], capture_output=True, text=True)
    if r.returncode:
        raise Exception(f'aomenc failed: {r.stderr.strip()}')
    units, unit = [], b''
    for t, obu in obus(dst.read_bytes()):
        if t == 2:
            if unit:
                units.append(unit)
            unit = b''
        else:
            unit += obu
    return units + [unit]


def av1c(unit, layout, bits):
    """the av1C property of a stream: its sequence header's profile, level and tier, its color config, the header"""
    seq = next(obu for t, obu in obus(unit) if t == 1)
    payload = seq[1 + (seq[0] >> 2 & 1):]
    payload = payload[leb128(payload, 0)[1]:]
    bitpos = 0

    def read(n):
        nonlocal bitpos
        v = 0
        for _ in range(n):
            v = v << 1 | payload[bitpos >> 3] >> (7 - (bitpos & 7)) & 1
            bitpos += 1
        return v
    profile, _, reduced = read(3), read(1), read(1)
    tier = 0
    if reduced:
        level = read(5)
    else:
        assert not read(1), 'timing info'
        delay = read(1)
        read(5)
        read(12)
        level = read(5)
        if level > 7:
            tier = read(1)
        if delay and read(1):
            read(4)
    ssx, ssy = {'420': (1, 1), '422': (1, 0), '444': (0, 0), 'mono': (1, 1)}[layout]
    return box(b'av1C', bytes([0x81, profile << 5 | level, tier << 7 | (bits > 8) << 6 | (bits == 12) << 5 |
                               (layout == 'mono') << 4 | ssx << 3 | ssy << 2, 0]) + seq)


# ---- containers
def box(t, payload):
    return struct.pack('>I', 8 + len(payload)) + t + payload


def fullbox(t, version, flags, payload):
    return box(t, bytes([version]) + flags.to_bytes(3, 'big') + payload)


ispe = lambda w, h: fullbox(b'ispe', 0, 0, struct.pack('>II', w, h))
pixi = lambda bits, channels: fullbox(b'pixi', 0, 0, bytes([channels] + [bits] * channels))
colr = lambda primaries, transfer, matrix, full: box(b'colr', b'nclx' + struct.pack('>HHHB', primaries, transfer, matrix, full << 7))
auxc = fullbox(b'auxC', 0, 0, b'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0')


class Item:
    def __init__(self, id, type, data, props, refs=(), hidden=False):
        self.id, self.type, self.data, self.props, self.refs, self.hidden = id, type, data, props, list(refs), hidden


def ftyp(major, *brands):
    return box(b'ftyp', major + b'\0\0\0\0' + major + b''.join(brands))


def avif(items, primary=1):
    """an AVIF of items (their properties: (box, essential)), the data in an mdat after the meta box"""
    properties = []
    for it in items:
        for p, _ in it.props:
            if p not in properties:
                properties.append(p)

    def meta(offsets):
        hdlr = fullbox(b'hdlr', 0, 0, b'\0' * 4 + b'pict' + b'\0' * 12 + b'\0')
        pitm = fullbox(b'pitm', 0, 0, struct.pack('>H', primary))
        iloc = fullbox(b'iloc', 0, 0, bytes([0x44, 0]) + struct.pack('>H', len(items)) + b''.join(
            struct.pack('>HHHII', it.id, 0, 1, offsets[i], len(it.data)) for i, it in enumerate(items)))
        iinf = fullbox(b'iinf', 0, 0, struct.pack('>H', len(items)) + b''.join(
            fullbox(b'infe', 2, int(it.hidden), struct.pack('>HH', it.id, 0) + it.type + b'\0') for it in items))
        refs = b''.join(box(t, struct.pack('>HH', it.id, len(to)) + b''.join(struct.pack('>H', i) for i in to))
                        for it in items for t, to in it.refs)
        ipco = box(b'ipco', b''.join(properties))
        ipma = fullbox(b'ipma', 0, 0, struct.pack('>I', len(items)) + b''.join(
            struct.pack('>HB', it.id, len(it.props)) + bytes(essential << 7 | (properties.index(p) + 1) for p, essential in it.props)
            for it in items))
        return fullbox(b'meta', 0, 0, hdlr + pitm + iloc + iinf + (fullbox(b'iref', 0, 0, refs) if refs else b'') + box(b'iprp', ipco + ipma))
    head = ftyp(b'avif', b'mif1', b'miaf')
    start = len(head) + len(meta([0] * len(items))) + 8
    offsets = []
    for it in items:
        offsets.append(start)
        start += len(it.data)
    return head + meta(offsets) + box(b'mdat', b''.join(it.data for it in items))


def image(units, layout, bits, w, h, extra=(), id=1, full=False):
    """an av01 item of a still image's stream"""
    channels = 1 if layout == 'mono' else 3
    return Item(id, b'av01', units[0], [(av1c(units[0], layout, bits), 1), (ispe(w, h), 0), (pixi(bits, channels), 0), *extra])


def sequence(units, layout, bits, w, h):
    """an AVIF image sequence: one track of the temporal units, no meta box"""
    zero = lambda n: b'\0' * n
    matrix = struct.pack('>9I', 0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000)
    n = len(units)

    def moov(offset):
        mvhd = fullbox(b'mvhd', 0, 0, struct.pack('>IIII', 0, 0, 30, n) + struct.pack('>IH', 0x10000, 0x100) + zero(10) + matrix + zero(24) + struct.pack('>I', 2))
        tkhd = fullbox(b'tkhd', 0, 3, struct.pack('>IIIII', 0, 0, 1, 0, n) + zero(8) + struct.pack('>HHHH', 0, 0, 0, 0) + matrix + struct.pack('>II', w << 16, h << 16))
        mdhd = fullbox(b'mdhd', 0, 0, struct.pack('>IIIIHH', 0, 0, 30, n, 0x55c4, 0))
        hdlr = fullbox(b'hdlr', 0, 0, zero(4) + b'pict' + zero(12) + b'\0')
        entry = box(b'av01', zero(6) + struct.pack('>HHH', 1, 0, 0) + zero(12) + struct.pack('>HHIIIH', w, h, 0x480000, 0x480000, 0, 1) + zero(32) +
                    struct.pack('>Hh', 0x18, -1) + av1c(units[0], layout, bits))
        stbl = box(b'stbl', fullbox(b'stsd', 0, 0, struct.pack('>I', 1) + entry) +
                   fullbox(b'stts', 0, 0, struct.pack('>III', 1, n, 1)) +
                   fullbox(b'stss', 0, 0, struct.pack('>II', 1, 1)) +
                   fullbox(b'stsc', 0, 0, struct.pack('>IIII', 1, 1, n, 1)) +
                   fullbox(b'stsz', 0, 0, struct.pack('>II', 0, n) + b''.join(struct.pack('>I', len(u)) for u in units)) +
                   fullbox(b'stco', 0, 0, struct.pack('>II', 1, offset)))
        minf = box(b'minf', fullbox(b'vmhd', 0, 1, zero(8)) + box(b'dinf', fullbox(b'dref', 0, 0, struct.pack('>I', 1) + fullbox(b'url ', 0, 1, b''))) + stbl)
        return box(b'moov', mvhd + box(b'trak', tkhd + box(b'mdia', mdhd + hdlr + minf)))
    head = ftyp(b'avis', b'msf1', b'miaf')
    offset = len(head) + len(moov(0)) + 8
    return head + moov(offset) + box(b'mdat', b''.join(units))


# ---- the references
def avifdec(path):
    png = tmp / 'ref.png'
    subprocess.run([AVIFDEC, '-d', '8', '-u', 'bilinear', '--ignore-icc', str(path), str(png)], check=True, capture_output=True)
    return np.asarray(Image.open(png).convert('RGBA'))


def write(name, data, reference=avifdec):
    path = out / f'{name}.avif'
    path.write_bytes(data)
    if reference:
        hashes[name] = sha(reference(path))


photo = lambda w, h: source('external.png', w, h, (180, 160, 440, 420))
FILTERS = ['--enable-cdef=1', '--enable-restoration=1']

# the lossy ones: every subsampling and bit depth, all filters
write('yuv420', avif([image(encode([yuv(photo(61, 45), '420', 8)], '420', 8, ['--cq-level=30', *FILTERS]), '420', 8, 61, 45)]))
write('yuv420-12bit', avif([image(encode([yuv(photo(48, 40), '420', 12)], '420', 12, ['--cq-level=25', *FILTERS]), '420', 12, 48, 40)]))
write('yuv422-10bit', avif([image(encode([yuv(photo(48, 40), '422', 10)], '422', 10, ['--cq-level=25', *FILTERS]), '422', 10, 48, 40)]))
# 4:4:4, large enough for the conversion's tables of the colors by sample value
write('yuv444', avif([image(encode([yuv(photo(368, 360), '444', 8)], '444', 8, ['--cq-level=50', *FILTERS]), '444', 8, 368, 360)]))
write('mono', avif([image(encode([yuv(photo(45, 37), 'mono', 8)], 'mono', 8, ['--cq-level=25', *FILTERS]), 'mono', 8, 45, 37)]),
      lambda p: np.asarray(Image.open(p).convert('RGBA')))
# coding tools: 128x128 superblocks, tiles, quantizer matrices, delta q and delta loop filter levels, the slower
# encoder's tools (filter intra, ...); segmentation (by the good quality mode's adaptive quantization); film grain;
# superres with loop restoration (the self guided filter too); screen content (palettes, intra block copy)
write('tools', avif([image(encode([yuv(photo(160, 96), '420', 8)], '420', 8, [
    '--cq-level=30', '--cpu-used=1', '--sb-size=128', '--tile-columns=1', '--tile-rows=1', '--enable-qm=1', '--deltaq-mode=4',
    '--deltaq-strength=200', '--enable-tpl-model=1', '--delta-lf-mode=1', *FILTERS]), '420', 8, 160, 96)]))
write('segments', avif([image(encode([yuv(photo(96, 64), '420', 8)], '420', 8, ['--cq-level=30', '--aq-mode=1', *FILTERS], intra=False), '420', 8, 96, 64)]))
write('grain', avif([image(encode([yuv(photo(48, 40), '420', 8)], '420', 8, ['--cq-level=30', '--film-grain-test=1']), '420', 8, 48, 40)]))
write('superres', avif([image(encode([yuv(photo(128, 96), '420', 8)], '420', 8, ['--cq-level=35', '--cpu-used=0', '--superres-mode=1',
                                                                             '--superres-kf-denominator=13', '--enable-restoration=1']), '420', 8, 128, 96)]))
write('screen', avif([image(encode([yuv(source('readme.png', 200, 150), '420', 8)], '420', 8, ['--cq-level=30', '--tune-content=screen']), '420', 8, 200, 150)]))

# alpha (an auxiliary image), premultiplied too
color, alpha = photo(48, 40), alpha_ramp(48, 40)


def alpha_item(plane):
    unit = encode([[plane]], 'mono', 8, ['--cq-level=10'], full=True)[0]
    return Item(2, b'av01', unit, [(av1c(unit, 'mono', 8), 1), (ispe(48, 40), 0), (pixi(8, 1), 0), (auxc, 0)], [(b'auxl', [1])], hidden=True)


write('alpha', avif([image(encode([yuv(color, '420', 8)], '420', 8, ['--cq-level=25']), '420', 8, 48, 40), alpha_item(alpha)]))
premultiplied = image(encode([yuv(color * alpha[..., None] / 255, '420', 8)], '420', 8, ['--cq-level=25']), '420', 8, 48, 40)
premultiplied.refs.append((b'prem', [2]))
write('alpha-premultiplied', avif([premultiplied, alpha_item(alpha)]))

# a 2x2 grid of 64x64 tiles (MIAF's minimum) for a 124x100 image, with an alpha grid
grid_rgb, grid_alpha = photo(128, 128), alpha_ramp(128, 128)
tiles, alpha_tiles = [], []
for i, (y, x) in enumerate([(0, 0), (0, 64), (64, 0), (64, 64)]):
    tiles.append(Item(10 + i, b'av01', encode([yuv(grid_rgb[y:y + 64, x:x + 64], '420', 8)], '420', 8, ['--cq-level=25'])[0], [], hidden=True))
    alpha_tiles.append(Item(20 + i, b'av01', encode([[grid_alpha[y:y + 64, x:x + 64]]], 'mono', 8, ['--cq-level=10'], full=True)[0], [], hidden=True))
for t, layout in [(t, '420') for t in tiles] + [(t, 'mono') for t in alpha_tiles]:
    t.props = [(av1c(t.data, layout, 8), 1), (ispe(64, 64), 0), (pixi(8, 1 if layout == 'mono' else 3), 0)] + ([(auxc, 0)] if layout == 'mono' else [])
grid_data = bytes([0, 0, 1, 1]) + struct.pack('>HH', 124, 100)
write('grid', avif([Item(1, b'grid', grid_data, [(ispe(124, 100), 0), (pixi(8, 3), 0)], [(b'dimg', [10, 11, 12, 13])]),
                    Item(2, b'grid', grid_data, [(ispe(124, 100), 0), (pixi(8, 1), 0), (auxc, 0)], [(b'dimg', [20, 21, 22, 23]), (b'auxl', [1])], hidden=True),
                    *tiles, *alpha_tiles]))

# transformations: a 30x20 clean aperture 3 right of and 2 above the center, rotated by 90° anticlockwise, mirrored
# top to bottom (applied in this order, the order of the properties)
clap = box(b'clap', struct.pack('>8i', 30, 1, 20, 1, 3, 1, -2, 1))
irot, imir = box(b'irot', bytes([1])), box(b'imir', bytes([0]))
write('transforms', avif([image(encode([yuv(photo(48, 40), '420', 8)], '420', 8, ['--cq-level=25']), '420', 8, 48, 40, [(clap, 1), (irot, 1), (imir, 1)])]),
      lambda p: np.flipud(np.rot90(avifdec(p)[8:28, 12:42], 1)))

# an image sequence: its first frame (the second one is an inter frame)
frames = [yuv(photo(48, 40), '420', 8), yuv(np.roll(photo(48, 40), 3, axis=1), '420', 8)]
write('sequence', sequence(encode(frames, '420', 8, ['--cq-level=25']), '420', 8, 48, 40))

# lossless RGB (identity matrix): the source's pixels
src = photo(48, 40)
Image.fromarray(src.round().astype(np.uint8)).save(out / 'source.png')
src = np.asarray(Image.open(out / 'source.png')).astype(np.float64)
gbr = lambda rgb: [rgb[..., 1], rgb[..., 2], rgb[..., 0]]
write('lossless', avif([image(encode([gbr(src)], '444', 8, ['--lossless=1', '--matrix-coefficients=identity'], full=True), '444', 8, 48, 40,
                              [(colr(1, 13, 0, 1), 0)])]), None)

# HDR: the source as PQ and HLG with BT.2020 primaries (SDR white at 203 cd/m², HLG for a 1000 cd/m² display), 10 bit
# lossless RGB
linear = np.where(src / 255 <= 0.04045, src / 255 / 12.92, ((src / 255 + 0.055) / 1.055) ** 2.4)
to2020 = np.linalg.inv(np.array([[1.660491, -0.587641, -0.072850], [-0.124550, 1.132900, -0.008349], [-0.018151, -0.100579, 1.118730]]))
linear = np.maximum(linear @ to2020.T, 0)
m1, m2, c1, c2, c3 = 2610 / 16384, 2523 / 4096 * 128, 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
y = (linear * 203 / 10000) ** m1
pq = ((c1 + c2 * y) / (1 + c3 * y)) ** m2
ys = (linear * 203 / 1000 @ np.array([0.2627, 0.6780, 0.0593]))[..., None]
scene = np.where(ys > 0, linear * 203 / 1000 / np.maximum(ys, 1e-12) ** (1 / 6), 0)
a, b = 0.17883277, 1 - 4 * 0.17883277
c = 0.5 - a * np.log(4 * a)
hlg = np.where(scene <= 1 / 12, np.sqrt(3 * scene), a * np.log(np.maximum(12 * scene - b, 1e-12)) + c)
for name, signal, transfer in [('pq', pq, 'smpte2084'), ('hlg', hlg, 'hlg')]:
    planes = tuple(p * 1023 for p in gbr(signal))
    units = encode([planes], '444', 10, ['--lossless=1', '--matrix-coefficients=identity', '--color-primaries=bt2020', f'--transfer-characteristics={transfer}'], full=True)
    write(name, avif([image(units, '444', 10, 48, 40, [(colr(9, 16 if name == 'pq' else 18, 0, 1), 0)])]), None)

for name, h in hashes.items():
    print(f"    '{name}': '{h}',")
