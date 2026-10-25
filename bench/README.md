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

Operations per second (more is faster), measured 2026-10-25 with Node.js v24.21.0 on AMD EPYC 7763 64-Core Processor, ImageScript 3.5.0.

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **PureJsImage** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| decode JPEG | **12.9** | 6.46 | 6.66 | 6.36 | 8.05 | 21.3 | 69.1 | 48.5 |
| decode PNG | **32.9** | 30.2 | 15.7 | 8.34 | 12.4 | 40.6 | 52.7 | 53.3 |
| decode WebP (lossy) | **10.1** | – | – | – | 9.92 | 11.0 | 36.3 | 60.0 |
| encode JPEG (quality 80) | **10.2** | 19.3 | 2.47 | 9.49 | 7.20 | 8.78 | 55.7 | 34.3 |
| encode PNG | **8.44** | 3.77 | 4.17 | 3.14 | 1.82 | 9.82 | 7.32 | 2.13 |
| encode WebP (lossless) | **1.58** | – | – | – | 0.36 | 23.8 | 0.69 | 2.10 |
| resize to half | **78.7** | 339 | 61.5 | 11.0 | 16.8 | 15.1 | 58.6 | 360 |
| rotate by 30° | **25.8** | 5.50 | 1.75 | 1.39 | 1.98 | 4.66 | 14.0 | 37.4 |
| blur (radius 5) | **13.9** | – | 0.01 | 1.25 | – | 6.56 | 29.2 | 62.8 |
| composite an overlay | **423** | 616 | 31.4 | 119 | – | 162 | 112 | 418 |
| crop | **823** | 658 | 50.0 | 64.6 | 98.5 | 199 | 1,189 | 1,109 |
| clone | **1,200** | 906 | 1,353 | 915 | 1,441 | 380 | 1,380 | 443 |
| render text | **1,971** | 58.1 | – | – | – | – | 1,961 | 2,819 |
| render SVG | **6.23** | fails | – | – | – | – | 26.0 | 86.2 |
| decode animated GIF | **14.6** | 7.71 | – | – | – | – | 15.9 | – |
| encode animated GIF | **5.03** | 1.16 | – | – | – | – | 0.88 | – |

Encoded sizes:

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **PureJsImage** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| photo PNG | 2.2 MB | 3.0 MB | 2.7 MB | 2.8 MB | 2.1 MB | 2.8 MB | 2.8 MB | 2.1 MB |
| photo JPEG | 217 kB | 257 kB | 260 kB | 260 kB | 222 kB | 257 kB | 218 kB | 218 kB |
| photo WebP | 1.4 MB | – | – | – | 2.1 MB | 1.7 MB | 1.2 MB | 1.4 MB |
| graphic PNG | 1.1 MB | 802 kB | 2.0 MB | 736 kB | 811 kB | 2.2 MB | 718 kB | 1.0 MB |
| graphic JPEG | 275 kB | 314 kB | 315 kB | 315 kB | 286 kB | 314 kB | 275 kB | 276 kB |
| graphic WebP | 580 kB | – | – | – | 758 kB | 856 kB | 239 kB | 631 kB |
| animation GIF | 825 kB | 1.3 MB | – | – | – | – | 720 kB | – |

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **PureJsImage** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|---|---|---|---|---|---|---|---|
| kind | JavaScript | WebAssembly | JavaScript | JavaScript | JavaScript | WebAssembly | native (libvips) | native (Skia) |
| package | `imagescript@3.5.0` | `imagescript@1.3.1` | `jimp@1.6.1` | `image-js@1.7.1` | `purejsimage@0.17.0` | `@silvia-odwyer/photon-node@0.3.4` | `sharp@0.35.5` | `@napi-rs/canvas@1.0.11` |
| install size | 1.9 MB | 6.7 MB | 26.8 MB | 47.8 MB | 6.7 MB | 2.3 MB | 20.3 MB | 35.0 MB |
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
