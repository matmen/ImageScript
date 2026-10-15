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

Operations per second (more is faster), measured 2026-10-15 with Node.js v24.11.1 on Intel(R) Core(TM) i3-8109U CPU @ 3.00GHz, ImageScript 3.1.0.

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|
| decode JPEG | **9.06** | 3.97 | 4.34 | 5.17 | 16.1 | 37.3 | 42.2 |
| decode PNG | **20.4** | 20.6 | 12.2 | 7.46 | 22.0 | 43.7 | 48.1 |
| decode WebP (lossy) | **7.73** | – | – | – | 7.75 | 30.3 | 53.3 |
| encode JPEG (quality 80) | **9.51** | 14.6 | 1.86 | 6.76 | 6.12 | 49.0 | 30.8 |
| encode PNG | **6.67** | 3.17 | 3.33 | 2.37 | 7.57 | 6.74 | 2.00 |
| encode WebP (lossless) | **0.67** | – | – | – | 17.0 | 0.52 | 1.85 |
| resize to half | **14.9** | 249 | 42.5 | 7.09 | 9.57 | 50.6 | 364 |
| rotate by 30° | **6.39** | 4.22 | 1.20 | 0.85 | 2.64 | 10.6 | 31.7 |
| blur (radius 5) | **4.32** | – | 0.01 | 1.00 | 2.54 | 23.7 | 33.5 |
| composite an overlay | **272** | 408 | 22.4 | 103 | 38.3 | 95.3 | 236 |
| crop | **313** | 428 | 34.4 | 46.3 | 41.1 | 928 | 934 |
| clone | **596** | 575 | 700 | 563 | 42.2 | 712 | 273 |
| render text | **774** | 50.1 | – | – | – | 1,896 | 3,164 |
| render SVG | **3.86** | fails | – | – | – | 12.0 | 51.2 |
| decode animated GIF | **4.95** | 6.77 | – | – | – | 12.5 | – |
| encode animated GIF | **3.39** | 1.01 | – | – | – | 0.80 | – |

Encoded sizes:

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|
| photo PNG | 2.2 MB | 3.0 MB | 2.7 MB | 2.8 MB | 2.8 MB | 2.8 MB | 2.1 MB |
| photo JPEG | 217 kB | 257 kB | 260 kB | 260 kB | 257 kB | 218 kB | 218 kB |
| photo WebP | 1.4 MB | – | – | – | 1.7 MB | 1.2 MB | 1.4 MB |
| graphic PNG | 1.1 MB | 802 kB | 2.0 MB | 736 kB | 2.2 MB | 718 kB | 1.0 MB |
| graphic JPEG | 275 kB | 314 kB | 315 kB | 315 kB | 314 kB | 275 kB | 276 kB |
| graphic WebP | 579 kB | – | – | – | 856 kB | 239 kB | 631 kB |
| animation GIF | 1.3 MB | 1.3 MB | – | – | – | 720 kB | – |

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **Photon** | **sharp** | **@napi-rs/canvas** |
|---|---|---|---|---|---|---|---|
| kind | JavaScript | WebAssembly | JavaScript | JavaScript | WebAssembly | native (libvips) | native (Skia) |
| package | `imagescript@3.1.0` | `imagescript@1.3.1` | `jimp@1.6.1` | `image-js@1.7.1` | `@silvia-odwyer/photon-node@0.3.4` | `sharp@0.35.5` | `@napi-rs/canvas@1.0.11` |
| install size | 639 kB | 6.7 MB | 26.7 MB | 47.8 MB | 2.3 MB | 30.2 MB | 35.0 MB |
| packages | 1 | 1 | 64 | 55 | 1 | 9 | 2 |

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
