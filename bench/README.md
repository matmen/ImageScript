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

Operations per second (more is faster), measured 2026-10-16 with Node.js v24.21.0 on AMD EPYC 9V45 96-Core Processor, ImageScript 3.2.1.

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|
| decode JPEG | **20.4** | 11.1 | 9.69 | 9.88 | 33.2 | 111 | 81.3 |
| decode PNG | **43.1** | 43.3 | 27.6 | 15.3 | 60.6 | 81.4 | 75.7 |
| decode WebP (lossy) | **15.8** | – | – | – | 16.5 | 58.3 | 96.0 |
| encode JPEG (quality 80) | **17.2** | 30.7 | 4.10 | 14.8 | 15.8 | 86.7 | 59.7 |
| encode PNG | **13.1** | 7.01 | 6.32 | 5.29 | 15.9 | 10.8 | 2.96 |
| encode WebP (lossless) | **1.61** | – | – | – | 37.0 | 1.08 | 3.21 |
| resize to half | **110** | 598 | 111 | 18.3 | 27.6 | 123 | 591 |
| rotate by 30° | **16.2** | 10.8 | 2.88 | 2.53 | 8.22 | 25.9 | 49.6 |
| blur (radius 5) | **24.8** | – | 0.02 | 2.41 | 11.8 | 66.0 | 111 |
| composite an overlay | **774** | 1,037 | 57.9 | 217 | 297 | 212 | 935 |
| crop | **1,247** | 1,216 | 93.4 | 114 | 364 | 2,220 | 2,845 |
| clone | **1,938** | 1,588 | 1,711 | 1,491 | 795 | 2,332 | 1,039 |
| render text | **1,890** | 91.2 | – | – | – | 4,649 | 5,832 |
| render SVG | **10.9** | fails | – | – | – | 41.7 | 171 |
| decode animated GIF | **24.7** | 13.5 | – | – | – | 25.1 | – |
| encode animated GIF | **8.04** | 2.03 | – | – | – | 1.46 | – |

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
| package | `imagescript@3.2.1` | `imagescript@1.3.1` | `jimp@1.6.1` | `image-js@1.7.1` | `@silvia-odwyer/photon-node@0.3.4` | `sharp@0.35.5` | `@napi-rs/canvas@1.0.11` |
| install size | 672 kB | 6.7 MB | 26.7 MB | 47.8 MB | 2.3 MB | 20.3 MB | 35.0 MB |
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
