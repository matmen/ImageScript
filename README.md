# ImageScript
##### zero-dependency JavaScript image manipulation
[![Discord Server](https://img.shields.io/discord/691713541262147687.svg?label=Discord&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2&style=for-the-badge)](https://discord.gg/8hPrwAH)
[![Documentation](https://img.shields.io/badge/Documentation-informational?style=for-the-badge)](https://imagescript.matmen.dev/)
[![Github](https://img.shields.io/badge/Github-Repository-181717?logo=github&style=for-the-badge)](https://github.com/matmen/ImageScript)
[![NPM](https://nodei.co/npm/imagescript.png)](https://www.npmjs.com/package/imagescript)

---

**ImageScript** is a zero-dependency alternative to common JavaScript bitmap image manipulation tools. All codecs and
renderers are written in TypeScript, without WebAssembly, native binaries or npm dependencies. It requires Node.js 22.12
or newer and works with both `import` and `require()`; type definitions are included.

---

### Features

- [Decoding images](https://imagescript.matmen.dev/Image.html#.decode)
  - PNGs (grayscale, RGB, indexed colors, 1-16 bit, interlaced) with and without alpha channels
  - JPEGs (baseline and progressive; grayscale, RGB, CMYK)
  - TIFFs (strips and tiles; uncompressed, LZW, deflate, PackBits and JPEG compressed)
- [Decoding GIFs](https://imagescript.matmen.dev/GIF.html#.decode)
- [Rendering SVGs](https://imagescript.matmen.dev/Image.html#.renderSVG) (shapes, paths, gradients, strokes, clip paths,
  masks, CSS; no text, images or filters)
- [Rendering vector fonts](https://imagescript.matmen.dev/Image.html#.renderText) (TrueType and OpenType)
- Image manipulation functions ([crop](https://imagescript.matmen.dev/Image.html#crop)
  , [rotate](https://imagescript.matmen.dev/Image.html#rotate)
  , [composite](https://imagescript.matmen.dev/Image.html#composite), ...)
- Color manipulation functions ([invert](https://imagescript.matmen.dev/Image.html##invert)
  , [hueShift](https://imagescript.matmen.dev/Image.html##hueshift), ...)
- Color information functions ([averageColor](https://imagescript.matmen.dev/Image.html#averageColor)
  , [dominantColor](https://imagescript.matmen.dev/Image.html#dominantColor), ...)
- Encoding images as [PNGs](https://imagescript.matmen.dev/Image.html#encode)
  , [JPEGs](https://imagescript.matmen.dev/Image.html#encodejpeg)
  and [GIFs](https://imagescript.matmen.dev/GIF.html#encode)

---

### Example

```js
import { Image } from 'imagescript';
import { readFile, writeFile } from 'node:fs/promises';

const image = await Image.decode(await readFile('input.jpg'));
image.resize(256, Image.RESIZE_AUTO).roundCorners(16);
await writeFile('output.png', await image.encode());
```

All coordinates are 0-based, `(0, 0)` is the top left pixel.

A bigger example is the [README image generation](https://github.com/matmen/ImageScript/blob/master/tests/readme.js).
Upgrading from 1.x? See the [changelog](CHANGELOG.md).

[![Example](https://github.com/matmen/ImageScript/raw/master/tests/targets/readme.png)](https://github.com/matmen/ImageScript/blob/master/tests/readme.js)

---

If you have any additional questions, feel free to join the [discord support server](https://discord.gg/8hPrwAH).
