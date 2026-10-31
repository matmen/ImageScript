# Writes the JPEG XLs of tests/jxl and their references: parts of tests/targets encoded by cjxl (libjxl) with its coding
# tools (lossless efforts, palettes, VarDCT, lossy Modular, alpha, progressive passes and LF frames, resampling, photon
# noise, patches, JPEG recompression, animations, the container), a few conformance files (github.com/libjxl/conformance,
# BSD-3-Clause, for what cjxl doesn't write: splines, blend modes, small trees, premultiplied alpha), and what djxl
# decodes them to as 8-bit sRGB PNGs (APNGs for cjxl's animations; premultiplied alpha as djxl writes it). Needs Pillow,
# cjxl and djxl:
#   CJXL=path/to/cjxl DJXL=path/to/djxl CONFORMANCE=path/to/conformance python scripts/jxl-fixtures.py
import json, os, shutil, struct, subprocess, tempfile
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from PIL.PngImagePlugin import PngInfo

root = Path(__file__).resolve().parent.parent
out = root / 'tests' / 'jxl'
out.mkdir(exist_ok=True)
CJXL, DJXL = os.environ.get('CJXL', 'cjxl'), os.environ.get('DJXL', 'djxl')
conformance = Path(os.environ.get('CONFORMANCE', 'conformance'))
tmp = Path(tempfile.mkdtemp())


def source(name, w, h, box=None, mode='RGB'):
    """a part of a test target scaled to w x h"""
    im = Image.open(root / 'tests' / 'targets' / name).convert('RGBA')
    return im.crop(box or (0, 0) + im.size).resize((w, h), Image.LANCZOS).convert(mode)


def encode(name, im, *args, fmt='png', **save):
    src = tmp / f'{name}.{fmt}'
    if isinstance(im, Path):
        src = im
    else:
        im.save(src, **save)
    subprocess.run([CJXL, '--quiet', str(src), str(out / f'{name}.jxl'), *args], check=True, stdout=subprocess.DEVNULL)


def write_pfm(path, im):
    """a float PFM of an RGB image (bottom up)"""
    w, h = im.size
    data = b''.join(struct.pack('<3f', *(v / 255 for v in im.getpixel((x, y)))) for y in reversed(range(h)) for x in range(w))
    path.write_bytes(f'PF\n{w} {h}\n-1.0\n'.encode() + data)


photo = lambda w, h: source('external.png', w, h, (200, 120, 520, 440))
text = lambda w, h: source('screen.png', w, h, (40, 40, 40 + w, 40 + h))

# lossless (Modular): the fast efforts (gradient, RLE), MA trees and the weighted predictor, palettes, alpha, 16 bits,
# grey, floats
encode('lossless-e1', photo(64, 48), '-d', '0', '-e', '1')
encode('lossless-e3', photo(64, 48), '-d', '0', '-e', '3')
encode('lossless-e7', photo(64, 48), '-d', '0', '-e', '7')
encode('lossless-alpha', source('circle.png', 48, 48, mode='RGBA'), '-d', '0', '-e', '9')
encode('palette', text(96, 64), '-d', '0', '-e', '7')
# (16 bits: the grey values spread by a gradient over the low byte)
grey = np.asarray(photo(48, 48).convert('L'), np.uint16) * 256 + np.arange(48, dtype=np.uint16)[None, :] * 5
encode('grey16', Image.fromarray(grey.astype('<u2'), 'I;16'), '-d', '0', '-e', '7')
write_pfm(tmp / 'float.pfm', photo(32, 24))
encode('float', tmp / 'float.pfm', '-d', '0', fmt='pfm')
# custom primaries (Adobe RGB's) as the color encoding (lossy: XYB, which decoders convert to sRGB); tone mapping
# fields (an intensity target)
chrm = PngInfo()
chrm.add(b'cHRM', struct.pack('>8I', 31270, 32900, 64000, 33000, 21000, 71000, 15000, 6000))
encode('custom-primaries', photo(48, 32), '-d', '1', pnginfo=chrm)
encode('tone-mapping', photo(48, 32), '-d', '1', '--intensity_target=200')
# lossy: VarDCT (Gaborish and the edge-preserving filter by default), larger varblocks, alpha,
# grey, lossy Modular (squeeze), progressive passes and LF frames, resampling, photon noise, patches
encode('lossy', photo(64, 48), '-d', '1')
encode('lossy-d4', photo(64, 48), '-d', '4', '-e', '7', '--epf=3')
encode('lossy-alpha', source('circle.png', 64, 64, mode='RGBA'), '-d', '1.5')
encode('lossy-grey', photo(64, 64).convert('L'), '-d', '1')
encode('lossy-modular', photo(64, 48), '--modular=1', '-d', '1')
encode('progressive', photo(64, 48), '-d', '1', '-p')
encode('lf-frame', photo(64, 48), '-d', '1', '--progressive_dc=1')
encode('resampling', photo(64, 48), '-d', '2', '--resampling=2')
encode('resampling8', photo(64, 48), '-d', '2', '--resampling=8')
encode('noise', photo(64, 48), '-d', '1', '--photon_noise_iso=12800')
# (patches of repeated text on a flat background, from a reference frame)
page = Image.new('RGB', (160, 72), (250, 250, 245))
for y in range(4, 72, 14):
    ImageDraw.Draw(page).text((4, y), 'JPEG XL patches ImageScript', fill=(20, 20, 60))
encode('patches', page, '-d', '1', '-e', '7', '--patches=1')
encode('container', photo(48, 32), '-d', '1', '--container=1')
# JPEG recompression (chroma subsampled, grey)
photo(64, 48).save(tmp / 'in.jpg', quality=70, subsampling=2)
encode('jpeg', tmp / 'in.jpg', fmt='jpg')
photo(64, 48).convert('L').save(tmp / 'grey.jpg', quality=70)
encode('jpeg-grey', tmp / 'grey.jpg', fmt='jpg')
# animations (from an APNG with alpha and a timing)
frames = [source('circle.png', 32, 32, (i * 40, 0, 512, 512 - i * 40), 'RGBA') for i in range(4)]
frames[0].save(tmp / 'anim.png', save_all=True, append_images=frames[1:], duration=[40, 80, 40, 120], loop=0)
encode('animation', tmp / 'anim.png', '-d', '0')
encode('animation-lossy', tmp / 'anim.png', '-d', '2')
# CMYK (scripts/jxl-cmyk.c, a black channel): the reference is the color times black, which djxl ignores without a
# CMYK profile
# (1 - ink: black is the darkest channel, the colors are divided by it)
rgb = np.asarray(photo(32, 32), np.float64)
k = np.maximum(rgb.max(axis=2, keepdims=True), 1)
cmyk = np.round(np.dstack([rgb / k * 255, k])).astype(np.uint8)
subprocess.run(['cc', '-o', str(tmp / 'jxl-cmyk'), str(root / 'scripts' / 'jxl-cmyk.c'), '-ljxl'], check=True)
(out / 'cmyk.jxl').write_bytes(subprocess.run([str(tmp / 'jxl-cmyk'), '32', '32'], input=cmyk.tobytes(), check=True,
                                              stdout=subprocess.PIPE).stdout)

# conformance files: the step of the reference's samples
conformances = {'alpha_nonpremultiplied': 4, 'alpha_premultiplied': 8, 'blendmodes': 8, 'mul_no_extra_channels': 1,
                'animation_spline': 4}
for name in conformances:
    shutil.copy(conformance / 'testcases' / name / 'input.jxl', out / f'{name.replace("_", "-")}.jxl')

# the references (of the conformance files every step-th sample of the first frame)
manifest = {}
for jxl in sorted(out.glob('*.jxl')):
    png = jxl.with_suffix('.png')
    if jxl.stem == 'cmyk':
        Image.fromarray(np.round(cmyk[..., :3] * (cmyk[..., 3:] / 255)).astype(np.uint8)).save(png)
        print(jxl.name, jxl.stat().st_size, png.stat().st_size)
        continue
    subprocess.run([DJXL, str(jxl), str(png), '--bits_per_sample=8', '--color_space=RGB_D65_SRG_Rel_SRG', '--quiet'],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    step = conformances.get(jxl.stem.replace('-', '_'))
    if step:
        with Image.open(png) as im:
            sample = np.asarray(im.convert('RGBA'))[::step, ::step]
        Image.fromarray(sample).save(png, optimize=True)
        manifest[jxl.stem] = {'step': step}
    print(jxl.name, jxl.stat().st_size, png.stat().st_size)
(out / 'sampled.json').write_text(json.dumps(manifest, indent=4) + '\n')
