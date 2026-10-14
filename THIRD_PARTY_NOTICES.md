# Third party notices

ImageScript is licensed under AGPL-3.0-or-later OR MIT (see [LICENSE](LICENSE)). Parts of it are derived from the
following projects, under their own licenses. Each derived file says so in its header.

| Project | Used in | License |
|---|---|---|
| [fflate](https://github.com/101arrowz/fflate) by Arjun Barrett | `src/codecs/zlib.ts` (deflate/inflate) | MIT |
| [Fast CRC32 in JavaScript](https://gist.github.com/101arrowz/e58695f7ccfdf74f60ba22018093edea) by Arjun Barrett | `src/codecs/crc.ts` (slice-by-16 CRC-32) | MIT |
| [libjpeg](https://ijg.org/) / [libjpeg-turbo](https://libjpeg-turbo.org/) by the Independent JPEG Group | `src/codecs/jpeg.ts` (IDCT, FDCT, upsampling, color conversion, progressive refinement, optimal Huffman tables) | IJG |
| [pdf.js](https://github.com/mozilla/pdf.js) (forked from [jpgjs](https://github.com/notmasteryet/jpgjs) by notmasteryet) | `src/codecs/jpeg.ts` (structure of the scan decoder) | Apache-2.0 |
| [font-rs](https://github.com/raphlinus/font-rs) by Raph Levien | `src/render/text.ts` (the `Rasterizer` class, also used for SVGs) | Apache-2.0 |

## fflate, Fast CRC32 in JavaScript

```
MIT License

Copyright (c) 2020 Arjun Barrett (fflate)
Copyright (c) 2021 Arjun Barrett (Fast CRC32 in JavaScript)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## libjpeg / libjpeg-turbo

This software is based in part on the work of the Independent JPEG Group.

The JPEG codec translates parts of libjpeg (as shipped by libjpeg-turbo) to TypeScript: the integer inverse DCT
(`jidctint.c`), the floating point forward DCT (`jfdctflt.c`), fancy upsampling (`jdsample.c`), the YCbCr to RGB
tables (`jdcolor.c`), the progressive AC refinement (`jdphuff.c`) and the optimal Huffman table generation
(`jcphuff.c`/`jchuff.c`). The translations were rewritten for TypeScript's numbers and typed arrays; the rest of the
codec is ImageScript's own. libjpeg's README with its copyright and terms is included unaltered as
[licenses/README.ijg](licenses/README.ijg).

## pdf.js, font-rs

```
pdf.js: Copyright 2014 Mozilla Foundation
font-rs: Copyright 2015 Google Inc. All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

The scan decoder of `src/codecs/jpeg.ts` follows the structure of pdf.js' `src/core/jpg.js` (block and MCU layout,
one decode function per scan type). The `Rasterizer` class in `src/render/text.ts` is a translation of font-rs'
`Raster` from Rust to TypeScript (`draw_line`, `draw_quad`, `accumulate`); its `cubic` method is adapted from
`draw_quad`. The full license text is in [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt).
