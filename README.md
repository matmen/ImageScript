# ImageScript
##### zero-dependency JavaScript image manipulation
[![Discord Server](https://img.shields.io/discord/691713541262147687.svg?label=Discord&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2&style=for-the-badge)](https://discord.gg/8hPrwAH)
[![Documentation](https://img.shields.io/badge/Documentationn-informational?style=for-the-badge)](https://imagescript.dreadful.tech/)
[![Github](https://img.shields.io/badge/Github-Repository-181717?logo=github&style=for-the-badge)](https://github.com/matmen/ImageScript)
[![NPM](https://nodei.co/npm/imagescript.png)](https://www.npmjs.com/package/imagescript)

---

**ImageScript** is a zero-dependency alternative to common JavaScript bitmap image manipulation tools. It can achieve
much more performant results by utilizing lower-level memory access, less memory copying and WebAssembly / native
binaries for decoding and encoding.

---

### Features

- [Decoding images](https://imagescript.dreadful.tech/Image.html#.decode)
  - PNGs (grayscale, RGB, indexed colors) with and without alpha channels
  - JPEGs (grayscale, RGB, CMYK)
  - TIFFs
- [Decoding GIFs](https://imagescript.dreadful.tech/GIF.html#.decode)
- [Rendering SVGs](https://imagescript.dreadful.tech/Image.html#.renderSVG)
- [Rendering vector fonts](https://imagescript.dreadful.tech/Image.html#.renderText)
- Image manipulation functions ([crop](https://imagescript.dreadful.tech/Image.html#crop)
  , [rotate](https://imagescript.dreadful.tech/Image.html#rotate)
  , [composite](https://imagescript.dreadful.tech/Image.html#composite), ...)
- Color manipulation functions ([invert](https://imagescript.dreadful.tech/Image.html##invert)
  , [hueShift](https://imagescript.dreadful.tech/Image.html##hueshift), ...)
- Color information functions ([averageColor](https://imagescript.dreadful.tech/Image.html##averagecolor)
  , [dominantColor](https://imagescript.dreadful.tech/Image.html##dominantcolor), ...)
- Encoding images as [PNGs](https://imagescript.dreadful.tech/Image.html##encode)
  , [JPEGs](https://imagescript.dreadful.tech/Image.html##encodejpeg)
  and [GIFs](https://imagescript.dreadful.tech/GIF.html#encode)

---

### Example

[![Example](https://github.com/matmen/ImageScript/raw/master/tests/targets/readme.png)](https://github.com/matmen/ImageScript/blob/master/tests/readme.js)

---

If you have any additional questions, feel free to join the [discord support server](https://discord.gg/8hPrwAH).
