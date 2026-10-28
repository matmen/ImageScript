# ImageScript
##### zero-dependency JavaScript image manipulation
[![Discord Server](https://img.shields.io/discord/691713541262147687.svg?label=Discord&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2&style=for-the-badge)](https://discord.gg/8hPrwAH)
[![Documentation](https://img.shields.io/badge/Documentation-informational?style=for-the-badge)](https://imagescript.matmen.dev/)
[![Github](https://img.shields.io/badge/Github-Repository-181717?logo=github&style=for-the-badge)](https://github.com/matmen/ImageScript)
[![NPM](https://nodei.co/npm/imagescript.png)](https://www.npmjs.com/package/imagescript)

---

**ImageScript** decodes, edits and encodes images in pure TypeScript: no WebAssembly, no native binaries, no
dependencies. It runs in Node.js 22.13+, Deno, Bun and browsers, with `import` or `require()`, and includes type
definitions.

```sh
npm install imagescript              # Node.js, Bun and bundlers
deno add jsr:@matmen/imagescript     # Deno
```

---

### Example

```js
import { Image } from 'imagescript';
import { readFile, writeFile } from 'node:fs/promises';

const image = await Image.decode(await readFile('input.jpg'));
image.resize(256, Image.RESIZE_AUTO).roundCorners(16);
await writeFile('output.png', await image.encode());
```

Coordinates are 0-based, `(0, 0)` is the top left pixel. A bigger example is the
[README image generation](https://github.com/matmen/ImageScript/blob/master/tests/readme.js):

[![Example](https://github.com/matmen/ImageScript/raw/master/tests/targets/readme.png)](https://github.com/matmen/ImageScript/blob/master/tests/readme.js)

---

### Features

| Format | Decode | Encode |
|---|---|---|
| PNG | ✓ | ✓ |
| JPEG | ✓ | ✓ |
| WebP | ✓ | ✓ (lossless and lossy) |
| AVIF | ✓ | ✓ (lossless and lossy) |
| JPEG XL | ✓ | ✓ (lossless and lossy) |
| GIF, APNG (animations) | ✓ | ✓ |
| BMP, QOI, TGA, Netpbm | ✓ | ✓ |
| TIFF, ICO/CUR, Radiance HDR | ✓ | |

Animated WebPs and JPEG XLs decode too, and [animations](https://imagescript.matmen.dev/classes/Animation.html)
encode as GIF, APNG or WebP.

- [Text rendering](https://imagescript.matmen.dev/classes/Image.html#rendertext) with TrueType and OpenType fonts,
  in every script, with color emoji
- [SVG rendering](https://imagescript.matmen.dev/classes/Image.html#rendersvg) (no text)
- [Resizing](https://imagescript.matmen.dev/classes/Image.html#resize),
  [cropping](https://imagescript.matmen.dev/classes/Image.html#crop),
  [rotating](https://imagescript.matmen.dev/classes/Image.html#rotate),
  [trimming](https://imagescript.matmen.dev/classes/Image.html#trim),
  [rounded corners](https://imagescript.matmen.dev/classes/Image.html#roundcorners), ...
- [Compositing](https://imagescript.matmen.dev/classes/Image.html#composite) with opacity and blend modes
- Filters and color adjustments: [blur](https://imagescript.matmen.dev/classes/Image.html#blur),
  [sharpen](https://imagescript.matmen.dev/classes/Image.html#sharpen),
  [brightness](https://imagescript.matmen.dev/classes/Image.html#brightness),
  [hueShift](https://imagescript.matmen.dev/classes/Image.html#hueshift), ...

See the [documentation](https://imagescript.matmen.dev/) for everything else, and the
[changelog](https://github.com/matmen/ImageScript/blob/master/CHANGELOG.md) when upgrading from an older major version.
[bench/](bench/README.md) compares ImageScript to Jimp, sharp and others.

---

### Credits

ImageScript builds on [fflate](https://github.com/101arrowz/fflate), libjpeg, [pdf.js](https://github.com/mozilla/pdf.js),
[font-rs](https://github.com/raphlinus/font-rs), [libwebp](https://chromium.googlesource.com/webm/libwebp),
[HarfBuzz](https://github.com/harfbuzz/harfbuzz), [dav1d](https://code.videolan.org/videolan/dav1d),
[libavif](https://github.com/AOMediaCodec/libavif), libaom, [jxl-oxide](https://github.com/tirr-c/jxl-oxide) and
[libjxl](https://github.com/libjxl/libjxl). The TrueType hinting follows [FreeType](https://freetype.org): portions of
this software are copyright © 2026 The FreeType Project (www.freetype.org). All rights reserved. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the licenses.

---

Questions? Join the [Discord server](https://discord.gg/8hPrwAH).
