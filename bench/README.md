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

Operations per second (more is faster), measured 2026-10-28 with Node.js v24.22.1 on AMD EPYC 9V74 80-Core Processor, ImageScript 3.8.1.

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **PureJsImage** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| decode JPEG | **17.3** | 7.84 | 8.08 | 6.81 | 9.88 | 26.0 | 82.8 | 56.6 |
| decode PNG | **43.6** | 29.1 | 19.6 | 11.1 | 15.2 | 48.9 | 60.8 | 62.4 |
| decode WebP (lossy) | **14.3** | – | – | – | 12.2 | 13.6 | 40.9 | 79.6 |
| encode JPEG (quality 80) | **17.9** | 22.5 | 3.03 | 11.1 | 8.53 | 11.1 | 67.4 | 43.9 |
| encode PNG | **9.17** | 4.58 | 5.05 | 3.41 | 2.10 | 11.6 | 8.79 | 2.41 |
| encode WebP (lossless) | **1.02** | – | – | – | 0.44 | 28.6 | 0.80 | 2.37 |
| resize to half | **85.7** | 394 | 80.6 | 13.7 | 20.2 | 19.5 | 70.6 | 314 |
| rotate by 30° | **29.8** | 6.83 | 2.16 | 1.46 | 2.31 | 5.84 | 17.6 | 39.4 |
| blur (radius 5) | **16.1** | – | 0.01 | 1.53 | – | 7.61 | 38.5 | 67.8 |
| composite an overlay | **542** | 641 | 38.3 | 153 | – | 194 | 119 | 575 |
| crop | **867** | 784 | 59.9 | 76.4 | 120 | 193 | 1,233 | 1,431 |
| clone | **1,251** | 1,066 | 1,283 | 972 | 1,285 | 494 | 1,413 | 632 |
| render text | **2,434** | 68.3 | – | – | – | – | 2,573 | 3,560 |
| render SVG | **7.05** | fails | – | – | – | – | 20.4 | 116 |
| decode animated GIF | **19.4** | 9.31 | – | – | – | – | 14.6 | – |
| encode animated GIF | **5.83** | 1.46 | – | – | – | – | 1.10 | – |

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
| package | `imagescript@3.8.1` | `imagescript@1.3.1` | `jimp@1.6.1` | `image-js@1.7.1` | `purejsimage@0.17.0` | `@silvia-odwyer/photon-node@0.3.4` | `sharp@0.35.5` | `@napi-rs/canvas@1.0.11` |
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
