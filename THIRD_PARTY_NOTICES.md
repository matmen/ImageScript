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
| [RFC 9649](https://www.rfc-editor.org/rfc/rfc9649) (WebP Image Format) | `src/codecs/vp8l.ts` (lossless bitstream, short distance code table), `src/codecs/webp.ts` (container) | BSD-3-Clause (Revised BSD) |
| [RFC 6386](https://www.rfc-editor.org/rfc/rfc6386) (VP8 Data Format and Decoding Guide, with the libvpx reference decoder) | `src/codecs/vp8-tables.ts` (probability and quantizer tables), `src/codecs/vp8.ts` (decoding procedures) | BSD-3-Clause |
| [libwebp](https://chromium.googlesource.com/webm/libwebp) | `src/codecs/vp8.ts` (YUV to RGB conversion, "fancy" chroma upsampling), `src/codecs/webp.ts` (animation frame blending) | BSD-3-Clause |
| [FreeType](https://freetype.org) | `src/render/hinting.ts` (behavior and parts of the logic of the TrueType interpreter) | FreeType License |

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

## RFC 6386, libwebp

The VP8 decoder follows the procedures of RFC 6386 and its reference decoder, its constant tables are extracted from
the RFC. To decode exactly like libwebp, the YUV to RGB conversion, the chroma upsampling and the blending of animation
frames reproduce libwebp's integer arithmetic.

```
RFC 6386 reference decoder: Copyright (c) 2010, 2011, Google Inc. All rights reserved.
libwebp: Copyright (c) 2010, Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

The RFC's reference decoder additionally comes with Google's patent grant for VP8 (RFC 6386 section 20.27).

## RFC 9649

The WebP container and the lossless (VP8L) codec follow RFC 9649, the short distance code table is taken from it.

```
Copyright (c) 2024 IETF Trust and the persons identified as authors of the code. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

- Redistributions of source code must retain the above copyright notice, this list of conditions and the following
  disclaimer.
- Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
  following disclaimer in the documentation and/or other materials provided with the distribution.
- Neither the name of Internet Society, IETF or IETF Trust, nor the names of specific contributors, may be used to
  endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## FreeType

Portions of this software are copyright © 2026 The FreeType Project (https://freetype.org). All rights reserved.

The TrueType hinting interpreter in `src/render/hinting.ts` is written after the TrueType instruction specification.
Where the specification leaves details open, its behavior and parts of its logic follow FreeType's interpreter
(`src/truetype/ttinterp.c`): the fixed point rounding, measuring original distances on the unscaled outline, the
interpolation of untouched points (IUP), the handling of near-perpendicular freedom and projection vectors, and the
tolerance of invalid references. FreeType is used under the FreeType License, included as
[licenses/FTL.txt](licenses/FTL.txt).
