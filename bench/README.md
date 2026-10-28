# ImageScript benchmark

How [ImageScript](https://github.com/matmen/ImageScript) compares to other image libraries for Node.js: speed, file
sizes and what installing each takes. ImageScript is plain JavaScript with no dependencies, so it runs wherever
JavaScript does, like Jimp, image-js and PureJsImage; sharp and @napi-rs/canvas wrap native libraries (libvips, Skia),
Photon and ImageScript 1 are WebAssembly.

<img src="charts/install.svg" alt="Install size of each library">

<img src="charts/codecs.svg" alt="Decoding and encoding speed">

<img src="charts/operations.svg" alt="Speed of image operations">

<img src="charts/rendering.svg" alt="Text and SVG rendering speed">

<img src="charts/animation.svg" alt="Animated GIF decoding and encoding speed">

<img src="charts/sizes.svg" alt="Encoded file sizes">

## Numbers

Operations per second (more is faster), measured 2026-10-28 with Node.js v24.22.1 on AMD EPYC 7763 64-Core Processor, ImageScript 3.8.0.

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **PureJsImage** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| decode JPEG | **12.9** | 6.31 | 6.28 | 5.94 | 7.90 | 21.1 | 65.1 | 46.2 |
| decode PNG | **30.4** | 23.9 | 15.8 | 7.86 | 11.7 | 40.0 | 50.0 | 51.6 |
| decode WebP (lossy) | **10.1** | – | – | – | 9.79 | 11.1 | 33.0 | 57.0 |
| encode JPEG (quality 80) | **9.45** | 19.2 | 2.36 | 9.32 | 7.11 | 8.84 | 54.9 | 34.4 |
| encode PNG | **7.59** | 3.46 | 4.16 | 2.94 | 1.75 | 9.75 | 7.21 | 2.13 |
| encode WebP (lossless) | **0.83** | – | – | – | 0.36 | 23.6 | 0.62 | 1.95 |
| resize to half | **69.0** | 281 | 61.8 | 10.8 | 16.6 | 15.2 | 57.5 | 300 |
| rotate by 30° | **25.7** | 4.64 | 1.61 | 1.11 | 1.94 | 4.63 | 13.7 | 35.9 |
| blur (radius 5) | **13.9** | – | 0.01 | 1.22 | – | 6.43 | 28.9 | 60.4 |
| composite an overlay | **403** | 477 | 29.6 | 112 | – | 152 | 98.5 | 382 |
| crop | **629** | 576 | 43.2 | 63.8 | 93.8 | 182 | 997 | 1,013 |
| clone | **966** | 574 | 529 | 629 | 941 | 319 | 999 | 423 |
| render text | **1,976** | 55.4 | – | – | – | – | 1,625 | 2,176 |
| render SVG | **6.08** | fails | – | – | – | – | 16.7 | 84.2 |
| decode animated GIF | **14.3** | 7.83 | – | – | – | – | 12.6 | – |
| encode animated GIF | **4.75** | 1.14 | – | – | – | – | 0.87 | – |

Encoded sizes:

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **PureJsImage** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| photo PNG | 2.2 MB | 3.0 MB | 2.7 MB | 2.8 MB | 2.1 MB | 2.8 MB | 2.8 MB | 2.1 MB |
| photo JPEG | 217 kB | 257 kB | 260 kB | 260 kB | 222 kB | 257 kB | 218 kB | 218 kB |
| photo WebP | 1.3 MB | – | – | – | 2.1 MB | 1.7 MB | 1.2 MB | 1.4 MB |
| graphic PNG | 891 kB | 802 kB | 2.0 MB | 736 kB | 811 kB | 2.2 MB | 718 kB | 1.0 MB |
| graphic JPEG | 275 kB | 314 kB | 315 kB | 315 kB | 286 kB | 314 kB | 275 kB | 276 kB |
| graphic WebP | 557 kB | – | – | – | 758 kB | 856 kB | 239 kB | 631 kB |
| animation GIF | 825 kB | 1.3 MB | – | – | – | – | 720 kB | – |

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **PureJsImage** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|---|---|---|---|---|---|---|---|
| kind | JavaScript | WebAssembly | JavaScript | JavaScript | JavaScript | WebAssembly | native (libvips) | native (Skia) |
| package | `imagescript@3.8.0` | `imagescript@1.3.1` | `jimp@1.6.1` | `image-js@1.7.1` | `purejsimage@0.17.0` | `@silvia-odwyer/photon-node@0.3.4` | `sharp@0.35.5` | `@napi-rs/canvas@1.0.11` |
| install size | 2.2 MB | 6.7 MB | 26.8 MB | 47.8 MB | 6.7 MB | 2.3 MB | 20.3 MB | 35.0 MB |
| packages | 1 | 1 | 64 | 55 | 1 | 1 | 6 | 2 |

## Method

- Inputs (in `inputs/`, sources in [inputs/SOURCES.md](inputs/SOURCES.md)): a 1920×1080 photo (JPEG, and made from it
  when the benchmark starts, PNG and lossy WebP), a 1434×1434 graphic with transparency (PNG), a 445×445 diagram with
  transparency placed on the photo (PNG), a 300×300 GIF with 101 frames.
- Rendering: "The quick brown fox jumps over the lazy dog, 0123456789" in Source Sans 3 at 64px, and `tests/svgs/features.svg` (gradients, clipping,
  CSS) at 1920 pixels wide. Jimp, image-js, PureJsImage and Photon can't render TrueType/OpenType fonts or SVGs; ImageScript 1 crashes
  on this SVG; @napi-rs/canvas (Skia's SVG module) ignores its CSS, so it draws a little less.
- Every operation starts from the same decoded image and returns a new one: libraries that change images in place
  clone first, sharp runs a pipeline from raw pixels back to raw pixels, PureJsImage (which has no decoded images) one
  from a BMP back to a BMP, @napi-rs/canvas draws into a new canvas. PureJsImage has no blur, composite, rendering or
  animated GIFs.
- Where the library lets you choose, resizing is bilinear (ImageScript 1 only has nearest neighbor), blurring is
  gaussian with a radius or sigma of 5, rotating grows the image to fit. Each library uses its own defaults
  otherwise, e.g. its PNG compression level.
- [tinybench](https://github.com/tinylibs/tinybench), at least 1.5 seconds and 3 runs per measurement, every library
  in its own process.
- The release workflow runs the benchmark for every release and commits the results, on a GitHub Actions runner;
  runners vary, so compare libraries within one run rather than between runs.
- Install sizes: `npm install <library>` in an empty project, the apparent size of `node_modules`.

Run it: `npm install` in this directory, then `node run.js` (on an idle machine; `IMAGESCRIPT=local` measures
this checkout after `npm run build` instead of the version from npm), `node installs.js` and `node report.js`.
