# ImageScript benchmark

How [ImageScript](https://github.com/matmen/ImageScript) compares to other image libraries for Node.js: speed, file
sizes and what installing each takes. ImageScript is plain JavaScript with no dependencies, so it runs wherever
JavaScript does, like Jimp, image-js and PureJsImage; sharp and @napi-rs/canvas wrap native libraries (libvips, Skia),
Photon and ImageScript 1 are WebAssembly, and so is jsquash (Squoosh's libavif and libjxl, for AVIF and JPEG XL).

<img src="charts/install.svg" alt="Install size of each library">

<img src="charts/codecs.svg" alt="Decoding and encoding speed">

<img src="charts/modern.svg" alt="AVIF and JPEG XL decoding and encoding speed">

<img src="charts/operations.svg" alt="Speed of image operations">

<img src="charts/rendering.svg" alt="Text and SVG rendering speed">

<img src="charts/animation.svg" alt="Animated GIF decoding and encoding speed">

<img src="charts/sizes.svg" alt="Encoded file sizes">

## Numbers

Operations per second (more is faster), measured 2026-10-31 with Node.js v24.22.1 on AMD EPYC 7763 64-Core Processor, ImageScript 3.13.0.

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **PureJsImage** | **Photon** | **sharp** | **jsquash** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| decode JPEG | **12.4** | 6.00 | 5.99 | 5.75 | 7.53 | 21.2 | 68.1 | – | 47.4 |
| decode PNG | **32.5** | 24.9 | 15.4 | 8.00 | 12.3 | 40.2 | 51.0 | – | 52.9 |
| decode WebP (lossy) | **11.0** | – | – | – | 9.51 | 11.1 | 34.2 | – | 58.4 |
| encode JPEG (quality 80) | **16.5** | 19.2 | 2.41 | 9.18 | 6.87 | 8.85 | 55.3 | – | 34.4 |
| encode PNG | **5.60** | 3.79 | 4.19 | 2.65 | 1.80 | 9.77 | 7.21 | – | 2.13 |
| encode WebP (lossless) | **0.69** | – | – | – | 0.36 | 23.6 | 0.64 | – | 2.04 |
| decode AVIF | **4.08** | – | – | – | 0.52 | – | 12.1 | 4.43 | 15.8 |
| decode JPEG XL | **2.36** | – | – | – | fails | – | – | 2.44 | 15.2 |
| encode AVIF (quality 60) | **0.19** | – | – | – | 0.70 | – | 0.39 | 0.41 | – |
| encode JPEG XL (quality 90) | **0.39** | – | – | – | – | – | – | 0.23 | – |
| resize to half | **75.1** | 306 | 59.8 | 10.7 | 15.4 | 15.1 | 104 | – | 306 |
| rotate by 30° | **25.6** | 5.42 | 1.66 | 1.12 | 1.94 | 4.66 | 28.7 | – | 36.6 |
| blur (radius 5) | **13.0** | – | 0.01 | 1.17 | – | 6.48 | 54.1 | – | 60.1 |
| composite an overlay | **431** | 526 | 28.9 | 112 | – | 155 | 180 | – | 386 |
| crop | **825** | 666 | 47.9 | 61.0 | 95.7 | 190 | 1,006 | – | 1,099 |
| clone | **1,369** | 797 | 574 | 735 | 1,043 | 336 | 1,041 | – | 424 |
| render text | **1,822** | 55.6 | – | – | – | – | 1,588 | – | 2,497 |
| render SVG | **6.27** | fails | – | – | – | – | 26.4 | – | 84.2 |
| decode animated GIF | **15.6** | 7.52 | – | – | – | – | 14.2 | – | – |
| encode animated GIF | **4.35** | 1.12 | – | – | – | – | 0.86 | – | – |

Encoded sizes:

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **PureJsImage** | **Photon** | **sharp** | **jsquash** | **@napi-rs/canvas** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| photo PNG | 2.0 MB | 3.0 MB | 2.7 MB | 2.8 MB | 2.1 MB | 2.8 MB | 2.8 MB | – | 2.1 MB |
| photo JPEG | 218 kB | 257 kB | 260 kB | 260 kB | 222 kB | 257 kB | 218 kB | – | 218 kB |
| photo WebP | 1.3 MB | – | – | – | 2.1 MB | 1.7 MB | 1.2 MB | – | 1.4 MB |
| graphic PNG | 795 kB | 802 kB | 2.0 MB | 736 kB | 811 kB | 2.2 MB | 718 kB | – | 1.0 MB |
| graphic JPEG | 276 kB | 314 kB | 315 kB | 315 kB | 286 kB | 314 kB | 275 kB | – | 276 kB |
| graphic WebP | 277 kB | – | – | – | 758 kB | 856 kB | 239 kB | – | 631 kB |
| animation GIF | 825 kB | 1.3 MB | – | – | – | – | 720 kB | – | – |
| photo AVIF | 93 kB, 40.9 dB | – | – | – | 992 kB, 32.7 dB | – | 91 kB, 40.6 dB | 80 kB, 40.2 dB | – |
| photo JPEG XL | 245 kB, 44.5 dB | – | – | – | – | – | – | 230 kB, 44.1 dB | – |
| graphic AVIF | 147 kB, 41 dB | – | – | – | 709 kB, 38.5 dB | – | 114 kB, 38.7 dB | 136 kB, 40.5 dB | – |
| graphic JPEG XL | 230 kB, 43.4 dB | – | – | – | – | – | – | 194 kB, 41.9 dB | – |

| | **ImageScript 3** | **ImageScript 1** | **Jimp** | **image-js** | **PureJsImage** | **Photon** | **sharp** | **jsquash** | **@napi-rs/canvas** |
|---|---|---|---|---|---|---|---|---|---|
| kind | JavaScript | WebAssembly | JavaScript | JavaScript | JavaScript | WebAssembly | native (libvips) | WebAssembly | native (Skia) |
| package | `imagescript@3.13.0` | `imagescript@1.3.1` | `jimp@1.6.1` | `image-js@1.7.1` | `purejsimage@0.17.0` | `@silvia-odwyer/photon-node@0.3.4` | `sharp@0.35.5` | `@jsquash/avif@2.1.1 @jsquash/jxl@1.3.0` | `@napi-rs/canvas@1.0.11` |
| install size | 2.4 MB | 6.7 MB | 26.8 MB | 47.8 MB | 6.7 MB | 2.3 MB | 20.3 MB | 14.2 MB | 35.0 MB |
| packages | 1 | 1 | 64 | 55 | 1 | 1 | 6 | 3 | 2 |

## Method

- Inputs (in `inputs/`, sources in [inputs/SOURCES.md](inputs/SOURCES.md)): a 1920×1080 photo (JPEG, and made from it
  when the benchmark starts, PNG, lossy WebP, AVIF by sharp (libaom) and JPEG XL by jsquash (libjxl, effort 7), both
  at the qualities below), a 1434×1434 graphic with transparency (PNG), a 445×445 diagram with transparency placed on
  the photo (PNG), a 300×300 GIF with 101 frames.
- AVIF and JPEG XL are encoded at the same nominal quality (60 and 90); as the libraries' scales differ,
  the file sizes come with their PSNR (of the color over black, decoded by libavif and libjxl). PureJsImage's AVIF
  encoder has no quality option, and its JPEG XL decoder doesn't support everything libjxl's files use, which shows as
  failing. jsquash only encodes and decodes AVIF and JPEG XL (it gets the other inputs as pixels); @napi-rs/canvas
  decodes both with Skia's codecs, but doesn't encode them.
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
- Threads: ImageScript uses worker threads where they pay off (the processors available, at most 8), and sharp gets
  as many (`sharp.concurrency()`; its default on glibc Linux without jemalloc, like on CI, is one). The other
  libraries run on one thread (jsquash turns its threaded builds off in Node).
- [tinybench](https://github.com/tinylibs/tinybench), at least 1.5 seconds and 3 runs per measurement, every library
  in its own process.
- The release workflow runs the benchmark for every release and commits the results, on a GitHub Actions runner;
  runners vary, so compare libraries within one run rather than between runs.
- Install sizes: `npm install <library>` in an empty project, the apparent size of `node_modules`.

Run it: `npm install` in this directory, then `node run.js` (on an idle machine; `IMAGESCRIPT=local` measures
this checkout after `npm run build` instead of the version from npm), `node installs.js` and `node report.js`.
