# ImageScript
##### zero-dependency JavaScript image manipulation
[![Discord Server](https://img.shields.io/discord/691713541262147687.svg?label=Discord&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2&style=for-the-badge)](https://discord.gg/8hPrwAH)
[![Docs](https://img.shields.io/badge/Docs-informational?style=for-the-badge)](https://oss-is.dreadful.tech/)
[![Github](https://img.shields.io/badge/Github-Repository-181717?logo=github&style=for-the-badge)](https://github.com/matmen/ImageScript)

---

**ImageScript** is a zero-dependency alternative to common JavaScript bitmap image manipulation tools.
It can achieve much more performant results by utilizing lower-level memory access, less memory copying and WebAssembly for compression and encoding.

---

### Example
```js
const fs = require('fs').promises;
const {Image} = require('imagescript');

(async () => {
    const image = await Image.decode(await fs.readFile('./photo.png'));
    const overlay = await Image.decode(await fs.readFile('./overlay.png'));

    image.crop(228, 20, 152, 171);

    overlay.resize(image.width, Image.RESIZE_AUTO);
    overlay.opacity(0.8, true);
    image.composite(overlay, 0, image.height - overlay.height);

    await fs.writeFile('./output.png', await image.encode());
})();
```

#### Inputs
![Photo](./.github/external.png)  
![Overlay](./.github/issues.png)

#### Output
![Output](./.github/readme.png)

---

If you have any additional questions, feel free to join the [discord support server](https://discord.gg/8hPrwAH).