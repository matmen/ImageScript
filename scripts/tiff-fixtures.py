# Writes the TIFFs of tests/tiffs: python3 scripts/tiff-fixtures.py (needs Pillow with libtiff)
# First the ones Pillow (libtiff) writes, from tests/targets/external.png scaled to 157x101, then those it can't write.
# Most of these store the pixels of the first ones (rgba-tiff_lzw-pred, la-tiff_lzw, bw-tiff_deflate) in another way,
# so they have to decode to the same output; the YCbCr ones are compared with libtiff (through Pillow)
import struct
import zlib
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent.parent
out = root / 'tests' / 'tiffs'

source = Image.open(root / 'tests' / 'targets' / 'external.png').convert('RGB').resize((157, 101), Image.BICUBIC)
source.convert('1').save(out / 'bw-tiff_deflate.tif', compression='tiff_adobe_deflate')
source.convert('CMYK').save(out / 'cmyk-tiff_lzw-pred.tif', compression='tiff_lzw', tiffinfo={317: 2})
source.convert('L').convert('F').save(out / 'f-tiff_adobe_deflate-pred.tif', compression='tiff_adobe_deflate', tiffinfo={317: 3})
# (16 bits, big endian: v * 257, the high bytes are the 8-bit image)
Image.frombytes('I;16B', source.size, (np.asarray(source.convert('L'), np.uint32) * 257).astype('>u2').tobytes()).save(out / 'i16b.tif')
source.convert('LA').save(out / 'la-tiff_lzw.tif', compression='tiff_lzw')
source.quantize(64).save(out / 'p-packbits.tif', compression='packbits')
source.save(out / 'rgb-jpeg.tif', compression='jpeg')
source.convert('RGBA').save(out / 'rgba-tiff_lzw-pred.tif', compression='tiff_lzw', tiffinfo={317: 2})

rgb = Image.open(out / 'rgba-tiff_lzw-pred.tif').convert('RGB')
grey = Image.open(out / 'la-tiff_lzw.tif').convert('L')
bw = Image.open(out / 'bw-tiff_deflate.tif').convert('1')
W, H = rgb.size

SHORT, LONG, RATIONAL, LONG8 = 3, 4, 5, 16


def tiff(entries, segments, big=False, little=True):
    """entries: {tag: (type, [values])} without the offsets and byte counts of the segments, segments: [bytes]
    (strips, or tiles when TileWidth is given)"""
    e = '<' if little else '>'
    tiled = 322 in entries
    data, offsets = b'', []
    header = 16 if big else 8
    for s in segments:
        offsets.append(header + len(data))
        data += s + (b'\0' if len(s) & 1 else b'')
    entries = dict(entries)
    offset_type = LONG8 if big else LONG
    entries[324 if tiled else 273] = (offset_type, offsets)
    entries[325 if tiled else 279] = (offset_type, [len(s) for s in segments])

    sizes = {SHORT: 2, LONG: 4, RATIONAL: 8, LONG8: 8}
    codes = {SHORT: 'H', LONG: 'I', LONG8: 'Q'}
    inline = 8 if big else 4
    ifd = header + len(data)
    count = len(entries)
    ifd_size = (8 + count * 20 + 8) if big else (2 + count * 12 + 4)
    extra, body = b'', b''
    for tag in sorted(entries):
        kind, values = entries[tag]
        raw = b''.join(struct.pack(e + 'II', *v) for v in values) if kind == RATIONAL else struct.pack(e + codes[kind] * len(values), *values)
        if len(raw) <= inline:
            field = raw.ljust(inline, b'\0')
        else:
            field = struct.pack(e + ('Q' if big else 'I'), ifd + ifd_size + len(extra))
            extra += raw + (b'\0' if len(raw) & 1 else b'')
        body += struct.pack(e + ('HHQ' if big else 'HHI'), tag, kind, len(values)) + field
    if big:
        start = (b'II' if little else b'MM') + struct.pack(e + 'HHHQ', 43, 8, 0, ifd)
        ifd_bytes = struct.pack(e + 'Q', count) + body + struct.pack(e + 'Q', 0)
    else:
        start = (b'II' if little else b'MM') + struct.pack(e + 'HI', 42, ifd)
        ifd_bytes = struct.pack(e + 'H', count) + body + struct.pack(e + 'I', 0)
    return start + data + ifd_bytes + extra


def base(bps, spp, photometric, compression=1, more=None):
    entries = {256: (LONG, [W]), 257: (LONG, [H]), 258: (SHORT, [bps] * spp), 259: (SHORT, [compression]),
               262: (SHORT, [photometric]), 277: (SHORT, [spp]), 278: (LONG, [H]), 284: (SHORT, [1])}
    entries.update(more or {})
    return entries


def rows_of(image_bytes, row_bytes):
    return [image_bytes[i:i + row_bytes] for i in range(0, len(image_bytes), row_bytes)]


def pack_bits(values, bps):
    """MSB first"""
    out, acc, n = bytearray(), 0, 0
    for v in values:
        acc = acc << bps | v
        n += bps
        while n >= 8:
            n -= 8
            out.append(acc >> n & 255)
    if n:
        out.append(acc << 8 - n & 255)
    return bytes(out)


def bilevel_rows():
    return [pack_bits([1 if bw.getpixel((x, y)) else 0 for x in range(W)], 1) for y in range(H)]


def write(name, data):
    (out / f'{name}.tif').write_bytes(data)
    print(name, len(data), 'bytes')


# BigTIFF (version 43, 64-bit offsets), RGB with deflate: the same pixels as rgb-tiff_lzw-pred
write('rgb-bigtiff', tiff(base(8, 3, 2, 8), [zlib.compress(rgb.tobytes())], big=True))

# 16-bit RGB with the horizontal predictor (big endian), every sample v * 257: the high bytes are the 8-bit image
row = []
for y in range(H):
    samples = [v * 257 for v in rgb.tobytes()[y * W * 3:(y + 1) * W * 3]]
    diff = [samples[i] if i < 3 else (samples[i] - samples[i - 3]) & 0xffff for i in range(len(samples))]
    row.append(struct.pack('>' + 'H' * len(diff), *diff))
write('rgb16-pred-be', tiff(base(16, 3, 2, 8, more={317: (SHORT, [2])}), [zlib.compress(b''.join(row))], little=False))

# 32-bit unsigned greyscale, v * 0x01010101
write('l32', tiff(base(32, 1, 1), [struct.pack('<' + 'I' * (W * H), *(v * 0x01010101 for v in grey.tobytes()))]))

# 1-bit with FillOrder 2 (least significant bit first)
reverse = bytes(int(f'{b:08b}'[::-1], 2) for b in range(256))
write('bw-fillorder2', tiff(base(1, 1, 1, more={266: (SHORT, [2])}), [b''.join(r.translate(reverse) for r in bilevel_rows())]))

# 1-bit in tiles 12 pixels wide (not a multiple of 16 as TIFF requires, which some writers ignore): tiles start in the
# middle of bytes
TW, TH = 12, 16
tiles = []
for ty in range(0, H, TH):
    for tx in range(0, W, TW):
        tiles.append(b''.join(pack_bits([1 if x < W and y < H and bw.getpixel((x, y)) else 0 for x in range(tx, tx + TW)], 1)
                              for y in range(ty, ty + TH)))
entries = base(1, 1, 1, more={322: (LONG, [TW]), 323: (LONG, [TH])})
del entries[278]
write('bw-tiles12', tiff(entries, tiles))

# 2-bit greyscale (top bits), compared with its own expectation in tests/tiff.js
write('l2', tiff(base(2, 1, 1), [b''.join(pack_bits([v >> 6 for v in grey.tobytes()[y * W:(y + 1) * W]], 2) for y in range(H))]))

# RGBA with associated (premultiplied) alpha: an alpha gradient over the image
rgba = bytearray()
for y in range(H):
    for x in range(W):
        a = (x * 255) // (W - 1)
        r, g, b = rgb.getpixel((x, y))
        rgba += bytes([(r * a + 127) // 255, (g * a + 127) // 255, (b * a + 127) // 255, a])
write('rgba-associated', tiff(base(8, 4, 2, more={338: (SHORT, [1])}), [bytes(rgba)]))

# 32-bit floats from 0 to 1020 (greyscale * 4 + 0.5), normalized to their range
floats = [v * 4 + 0.5 for v in grey.tobytes()]
write('f32-range', tiff(base(32, 1, 1, more={339: (SHORT, [3])}), [struct.pack('<' + 'f' * len(floats), *floats)]))

# old-style LZW (libtiff before 5.0: codes packed least significant bit first, the code size grows a code later)
def old_lzw(data):
    table = {bytes([i]): i for i in range(256)}
    nxt, size, acc, n, out = 258, 9, 0, 0, bytearray()

    def emit(code):
        nonlocal acc, n
        acc |= code << n
        n += size
        while n >= 8:
            out.append(acc & 255)
            acc >>= 8
            n -= 8

    emit(256)
    w = b''
    for c in data:
        wc = w + bytes([c])
        if wc in table:
            w = wc
            continue
        emit(table[w])
        table[wc] = nxt
        nxt += 1
        # the decoder adds each entry a code later, so it reads with the longer codes a code later
        if nxt == 4096:
            emit(256)
            table = {bytes([i]): i for i in range(256)}
            nxt, size = 258, 9
        elif nxt > 1 << size:
            size += 1
        w = bytes([c])
    if w:
        emit(table[w])
    emit(257)
    if n:
        out.append(acc & 255)
    return bytes(out)

write('rgb-oldlzw', tiff(base(8, 3, 2, 5), [old_lzw(rgb.tobytes())]))

# YCbCr, uncompressed: subsampled 2x2 and 2x1 (data units of h*v luma samples, then Cb and Cr) and not subsampled
ycbcr = rgb.convert('YCbCr')
for h, v in [(2, 2), (2, 1), (1, 1)]:
    units = bytearray()
    for uy in range(0, H, v):
        for ux in range(0, W, h):
            ys = [ycbcr.getpixel((min(ux + i, W - 1), min(uy + j, H - 1)))[0] for j in range(v) for i in range(h)]
            block = [ycbcr.getpixel((min(ux + i, W - 1), min(uy + j, H - 1))) for j in range(v) for i in range(h)]
            units += bytes(ys + [round(sum(p[1] for p in block) / len(block)), round(sum(p[2] for p in block) / len(block))])
    write(f'ycbcr-{h}{v}', tiff(base(8, 3, 6, more={530: (SHORT, [h, v]), 532: (RATIONAL, [(0, 1), (255, 1), (128, 1), (255, 1), (128, 1), (255, 1)])}), [bytes(units)]))
