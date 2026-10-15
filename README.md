# ImageScript
##### zero-dependency JavaScript image manipulation
[![Discord Server](https://img.shields.io/discord/691713541262147687.svg?label=Discord&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2&style=for-the-badge)](https://discord.gg/8hPrwAH)
[![Documentation](https://img.shields.io/badge/Documentation-informational?style=for-the-badge)](https://imagescript.matmen.dev/)
[![Github](https://img.shields.io/badge/Github-Repository-181717?logo=github&style=for-the-badge)](https://github.com/matmen/ImageScript)
[![NPM](https://nodei.co/npm/imagescript.png)](https://www.npmjs.com/package/imagescript)

---

**ImageScript** is a zero-dependency alternative to common JavaScript bitmap image manipulation tools. Every codec and
renderer is written in TypeScript: no WebAssembly, no native binaries, no npm dependencies, no install scripts. The
package is about 140 kB (compressed) and runs in Node.js 22.13 or newer (including Alpine/musl, ARM and bundled
serverless functions), Deno, Bun and browsers. It works with both `import` and `require()`, type definitions are included.

```sh
npm install imagescript              # Node.js, Bun and bundlers
deno add jsr:@matmen/imagescript     # Deno (npm:imagescript works too)
```

---

### Features

- [Decoding images](https://imagescript.matmen.dev/classes/Image.html#decode)
  - PNGs (grayscale, RGB, indexed colors, 1-16 bit, interlaced) with and without alpha channels
  - JPEGs (baseline and progressive; grayscale, RGB, CMYK)
  - TIFFs (strips and tiles; uncompressed, LZW, deflate, PackBits and JPEG compressed; BigTIFF)
  - WebPs (lossy, lossless and with alpha; bit-exact with libwebp)
  - TGAs (color mapped, truecolor and greyscale; uncompressed and run length encoded)
  - JPEGs, TIFFs, PNGs and WebPs are rotated as their Exif (or, for PNGs, XMP) orientation says
- [Decoding animations](https://imagescript.matmen.dev/classes/Animation.html#decode) (GIF, APNG and WebP) with all
  frames, durations and disposal modes
- [Rendering SVGs](https://imagescript.matmen.dev/classes/Image.html#rendersvg) (shapes, paths, gradients, strokes, clip paths,
  masks, CSS; no text, images or filters)
- [Rendering vector fonts](https://imagescript.matmen.dev/classes/Image.html#rendertext) (TrueType and OpenType, with kerning,
  outlines and TrueType hinting)
- [Resizing](https://imagescript.matmen.dev/classes/Image.html#resize) (bilinear, bicubic, area averaging and nearest neighbor)
- Image manipulation functions ([crop](https://imagescript.matmen.dev/classes/Image.html#crop)
  , [rotate](https://imagescript.matmen.dev/classes/Image.html#rotate)
  , [cropCircle](https://imagescript.matmen.dev/classes/Image.html#cropcircle)
  , [roundCorners](https://imagescript.matmen.dev/classes/Image.html#roundcorners), ...)
- Filters and color adjustments ([blur](https://imagescript.matmen.dev/classes/Image.html#blur)
  , [sharpen](https://imagescript.matmen.dev/classes/Image.html#sharpen)
  , [brightness](https://imagescript.matmen.dev/classes/Image.html#brightness)
  , [hueShift](https://imagescript.matmen.dev/classes/Image.html#hueshift), ...)
- Compositing with opacity and blend modes ([composite](https://imagescript.matmen.dev/classes/Image.html#composite)),
  removing backgrounds ([colorToAlpha](https://imagescript.matmen.dev/classes/Image.html#colortoalpha))
- Color information functions ([averageColor](https://imagescript.matmen.dev/classes/Image.html#averagecolor)
  , [dominantColor](https://imagescript.matmen.dev/classes/Image.html#dominantcolor), ...)
- Encoding images as [PNGs](https://imagescript.matmen.dev/classes/Image.html#encode) (smallest lossless color type)
  , [JPEGs](https://imagescript.matmen.dev/classes/Image.html#encodejpeg)
  , lossless [WebPs](https://imagescript.matmen.dev/classes/Image.html#encodewebp)
  and [TGAs](https://imagescript.matmen.dev/classes/Image.html#encodetga)
- Encoding animations as [GIF](https://imagescript.matmen.dev/classes/Animation.html#encodegif),
  [APNG](https://imagescript.matmen.dev/classes/Animation.html#encodeapng) and lossless
  [WebP](https://imagescript.matmen.dev/classes/Animation.html#encodewebp)

---

### Example

```js
import { Image } from 'imagescript';
import { readFile, writeFile } from 'node:fs/promises';

const image = await Image.decode(await readFile('input.jpg'));
image.resize(256, Image.RESIZE_AUTO).roundCorners(16);
await writeFile('output.png', await image.encode());
```

With CommonJS:

```js
const { Image } = require('imagescript');
```

All coordinates are 0-based, `(0, 0)` is the top left pixel.

A bigger example is the [README image generation](https://github.com/matmen/ImageScript/blob/master/tests/readme.js).
Upgrading from 1.x? Version 3 has breaking changes (0-based coordinates, removed WebP encoding, Node.js 22.13+, ...),
see the [changelog](https://github.com/matmen/ImageScript/blob/master/CHANGELOG.md). There is no 2.x release, the number was skipped because of the old experimental
`imagescript/v2` API.

[![Example](https://github.com/matmen/ImageScript/raw/master/tests/targets/readme.png)](https://github.com/matmen/ImageScript/blob/master/tests/readme.js)

---

### Benchmarks

[bench/](bench/README.md) compares ImageScript to Jimp, image-js, Photon, sharp and @napi-rs/canvas: speed of decoding,
encoding, image operations and rendering, encoded file sizes and install sizes. It runs for every release.

---

### Credits

The deflate/inflate implementation is derived from [fflate](https://github.com/101arrowz/fflate) and the CRC-32 from
[Fast CRC32 in JavaScript](https://gist.github.com/101arrowz/e58695f7ccfdf74f60ba22018093edea), both by Arjun Barrett.
The JPEG codec is based in part on the work of the Independent JPEG Group (libjpeg) and on
[pdf.js](https://github.com/mozilla/pdf.js), the glyph rasterizer is translated from
[font-rs](https://github.com/raphlinus/font-rs). The WebP codecs follow [RFC 9649](https://www.rfc-editor.org/rfc/rfc9649) and [RFC 6386](https://www.rfc-editor.org/rfc/rfc6386)
and reproduce [libwebp](https://chromium.googlesource.com/webm/libwebp)'s color conversion, the TrueType hinting follows
[FreeType](https://freetype.org)'s interpreter (portions of this software are copyright © 2026 The FreeType Project).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for their licenses.

---

If you have any additional questions, feel free to join the [discord support server](https://discord.gg/8hPrwAH).
