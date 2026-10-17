# ImageScript benchmark

How [ImageScript](https://github.com/matmen/ImageScript) compares to other image libraries for Node.js: speed, file
sizes and what installing each takes. ImageScript is plain JavaScript with no dependencies, so it runs wherever
JavaScript does; sharp and @napi-rs/canvas wrap native libraries (libvips, Skia), Photon and ImageScript 1 are
WebAssembly.

<img src="charts/install.svg" alt="Install size of each library">

<img src="charts/codecs.svg" alt="Decoding and encoding speed">

<img src="charts/operations.svg" alt="Speed of image operations">

<img src="charts/rendering.svg" alt="Text and SVG rendering speed">

<img src="charts/animation.svg" alt="Animated GIF decoding and encoding speed">

<img src="charts/sizes.svg" alt="Encoded file sizes">

## Numbers

Operations per second (more is faster), measured 2026-10-17 with Node.js v24.21.0 on AMD EPYC 7763 64-Core Processor, ImageScript 3.3.0.

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|
| decode JPEG | **11.8** | 6.37 | 6.83 | 6.37 | 21.2 | 69.6 | 49.4 |
| decode PNG | **32.9** | 30.7 | 15.8 | 8.33 | 41.0 | 53.6 | 54.6 |
| decode WebP (lossy) | **10.4** | – | – | – | 11.2 | 36.4 | 61.5 |
| encode JPEG (quality 80) | **12.5** | 19.4 | 2.50 | 9.47 | 8.87 | 56.3 | 34.8 |
| encode PNG | **8.77** | 3.90 | 4.18 | 2.67 | 9.78 | 7.27 | 2.14 |
| encode WebP (lossless) | **1.60** | – | – | – | 23.9 | 0.68 | 2.12 |
| resize to half | **73.2** | 370 | 61.1 | 11.1 | 15.2 | 60.3 | 393 |
| rotate by 30° | **27.9** | 5.57 | 1.76 | 1.15 | 4.67 | 14.3 | 38.5 |
| blur (radius 5) | **13.9** | – | 0.01 | 1.25 | 6.60 | 29.8 | 60.0 |
| composite an overlay | **447** | 608 | 31.9 | 116 | 169 | 113 | 447 |
| crop | **825** | 754 | 50.7 | 65.5 | 204 | 1,307 | 1,437 |
| clone | **1,382** | 934 | 1,033 | 885 | 419 | 1,520 | 490 |
| render text | **2,103** | 59.6 | – | – | – | 2,007 | 3,495 |
| render SVG | **6.83** | fails | – | – | – | 26.6 | 93.9 |
| decode animated GIF | **14.8** | 7.90 | – | – | – | 17.2 | – |
| encode animated GIF | **5.02** | 1.16 | – | – | – | 0.88 | – |

Encoded sizes:

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|
| photo PNG | 2.2 MB | 3.0 MB | 2.7 MB | 2.8 MB | 2.8 MB | 2.8 MB | 2.1 MB |
| photo JPEG | 217 kB | 257 kB | 260 kB | 260 kB | 257 kB | 218 kB | 218 kB |
| photo WebP | 1.4 MB | – | – | – | 1.7 MB | 1.2 MB | 1.4 MB |
| graphic PNG | 1.1 MB | 802 kB | 2.0 MB | 736 kB | 2.2 MB | 718 kB | 1.0 MB |
| graphic JPEG | 275 kB | 314 kB | 315 kB | 315 kB | 314 kB | 275 kB | 276 kB |
| graphic WebP | 580 kB | – | – | – | 856 kB | 239 kB | 631 kB |
| animation GIF | 825 kB | 1.3 MB | – | – | – | 720 kB | – |

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|---|---|---|---|---|---|---|
| kind | JavaScript | WebAssembly | JavaScript | JavaScript | WebAssembly | native (libvips) | native (Skia) |
| package | `imagescript@3.3.0` | `imagescript@1.3.1` | `jimp@1.6.1` | `image-js@1.7.1` | `@silvia-odwyer/photon-node@0.3.4` | `sharp@0.35.5` | `@napi-rs/canvas@1.0.11` |
| install size | 1.1 MB | 6.7 MB | 26.8 MB | 47.8 MB | 2.3 MB | 20.3 MB | 35.0 MB |
| packages | 1 | 1 | 64 | 55 | 1 | 6 | 2 |

## Method

- Inputs (in `inputs/`, sources in [inputs/SOURCES.md](inputs/SOURCES.md)): a 1920×1080 photo (JPEG, and made from it
  when the benchmark starts, PNG and lossy WebP), a 1434×1434 graphic with transparency (PNG), a 445×445 diagram with
  transparency placed on the photo (PNG), a 300×300 GIF with 101 frames.
- Rendering: "The quick brown fox jumps over the lazy dog, 0123456789" in Source Sans 3 at 64px, and `tests/svgs/features.svg` (gradients, clipping,
  CSS) at 1920 pixels wide. Jimp and Photon can't render TrueType/OpenType fonts or SVGs; ImageScript 1 crashes
  on this SVG; @napi-rs/canvas (Skia's SVG module) ignores its CSS, so it draws a little less.
- Every operation starts from the same decoded image and returns a new one: libraries that change images in place
  clone first, sharp runs a pipeline from raw pixels back to raw pixels, @napi-rs/canvas draws into a new canvas.
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
