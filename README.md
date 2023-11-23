# ImageScript
##### zero-dependency JavaScript image manipulation
[![Discord Server](https://img.shields.io/discord/691713541262147687.svg?label=Discord&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2&style=for-the-badge)](https://discord.gg/8hPrwAH)
[![Documentation](https://img.shields.io/badge/Documentation-informational?style=for-the-badge)](https://imagescript.matmen.dev/)
[![Github](https://img.shields.io/badge/Github-Repository-181717?logo=github&style=for-the-badge)](https://github.com/matmen/ImageScript)
[![deno.land](https://shields.io/badge/deno.land-gray?logo=deno&style=for-the-badge)](https://deno.land/x/imagescript)
[![NPM](https://nodei.co/npm/imagescript.png)](https://www.npmjs.com/package/imagescript)

---

**ImageScript** is a zero-dependency alternative to common JavaScript bitmap image manipulation tools. It can achieve
much more performant results by utilizing lower-level memory access, less memory copying and WebAssembly / native
binaries for decoding and encoding.

---

### Features

- [Decoding images](https://imagescript.matmen.dev/Image.html#.decode)
  - PNGs (grayscale, RGB, indexed colors) with and without alpha channels
  - JPEGs (grayscale, RGB, CMYK)
  - TIFFs
- [Decoding GIFs](https://imagescript.matmen.dev/GIF.html#.decode)
- [Rendering SVGs](https://imagescript.matmen.dev/Image.html#.renderSVG)
- [Rendering vector fonts](https://imagescript.matmen.dev/Image.html#.renderText)
- Image manipulation functions ([crop](https://imagescript.matmen.dev/Image.html#crop)
  , [rotate](https://imagescript.matmen.dev/Image.html#rotate)
  , [composite](https://imagescript.matmen.dev/Image.html#composite), ...)
- Color manipulation functions ([invert](https://imagescript.matmen.dev/Image.html##invert)
  , [hueShift](https://imagescript.matmen.dev/Image.html##hueshift), ...)
- Color information functions ([averageColor](https://imagescript.matmen.dev/Image.html#averageColor)
  , [dominantColor](https://imagescript.matmen.dev/Image.html#dominantColor), ...)
- Encoding images as [PNGs](https://imagescript.matmen.dev/Image.html#encode)
  , [JPEGs](https://imagescript.matmen.dev/Image.html#encodejpeg)
  , [WEBPs](https://imagescript.matmen.dev/Image.html#encodeWEBP)
  and [GIFs](https://imagescript.matmen.dev/GIF.html#encode)

---

### Example

Check out one of these examples:
* **NodeJS**: [README image generation](https://github.com/matmen/ImageScript/blob/master/tests/readme.js)
* **Deno**: [README image generation](https://github.com/matmen/ImageScript/blob/deno/tests/readme.js)
* **Browser**: [Grayscale Conversion Example Page](https://github.com/matmen/ImageScript/blob/browser/example/index.html) (via CDN)

[![Example](https://github.com/matmen/ImageScript/raw/master/tests/targets/readme.png)](https://github.com/matmen/ImageScript/blob/master/tests/readme.js)

---

If you have any additional questions, feel free to join the [discord support server](https://discord.gg/8hPrwAH).
