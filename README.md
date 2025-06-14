# ImageScript
##### zero-dependency JavaScript image manipulation
![NPM Version](https://img.shields.io/npm/v/imagescript?style=for-the-badge&label=NPM%20(Node.JS))
![JSR Version](https://img.shields.io/jsr/v/%40matmen/imagescript?style=for-the-badge&label=JSR%20(Deno))
[![Documentation](https://img.shields.io/badge/Documentation-informational?style=for-the-badge)](https://imagescript.matmen.dev/)
[![Github](https://img.shields.io/badge/Github-Repository-181717?logo=github&style=for-the-badge)](https://github.com/matmen/ImageScript)
[![Discord Server](https://img.shields.io/discord/691713541262147687.svg?label=Discord&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2&style=for-the-badge)](https://discord.gg/8hPrwAH)

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
- Color information functions ([averageColor](https://imagescript.matmen.dev/Image.html##averagecolor)
  , [dominantColor](https://imagescript.matmen.dev/Image.html##dominantcolor), ...)
- Encoding images as [PNGs](https://imagescript.matmen.dev/Image.html##encode)
  , [JPEGs](https://imagescript.matmen.dev/Image.html##encodejpeg)
  and [GIFs](https://imagescript.matmen.dev/GIF.html#encode)

---

### Example

```js
import {Image} from "jsr:@matmen/imagescript";

const input = await Deno.readFile('./image.png');
const image = await Image.decode(input);
image.rotate(180);

const output = await image.encode();
await Deno.writeFile('./output.png', output);
```
---

If you have any additional questions, feel free to join the [discord support server](https://discord.gg/8hPrwAH).
