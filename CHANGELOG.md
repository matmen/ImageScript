# Changelog

## 3.13.0

### New

- WOFF fonts work everywhere fonts do: `renderText()`, `TextLayout`, and SVG rendering's `fonts` option (before, only
  fonts an SVG embeds with `@font-face` could be WOFF). Font packages like Fontsource ship only WOFF and WOFF2, so
  their fonts can be used directly. WOFF2 fonts are refused with a clear error for now: they need Brotli, which
  Chrome's `DecompressionStream` doesn't offer yet.

### Changes

- PNG and APNG encoding (`encode()`, `encodePNG()`, `encodeAPNG()`, `apngEncoder()`) default to compression level 4
  instead of 1: 7-22% smaller files (graphics 11%, photos 10%, screenshots 22%) for about 30% more time. zlib's lazy
  matching starts at level 4, so levels 2-3 save less. Pass `compression: 1` for the previous speed. (Node.js and
  Bun; elsewhere levels 1-6 compress with `CompressionStream`, whose level is fixed at 6.)

### Performance

- Lossy WebP decoding is about 45% faster (1920x1080 at quality 75: 184 -> 100 ms of CPU time): reading a DC
  prediction mode returned -0, a floating point number to V8, which kept deoptimizing the decoder's main loop. Blocks
  with only a DC coefficient also skip the full inverse transform. Same pixels.

### Fixes

- TrueType hinting scales the control values like FreeType: kept in 1/64 font units (cvar's deltas rounded to them)
  and scaled by the scale cut to 1/64. Rounding differently moved some points by 1/64 pixel, sometimes across a pixel
  boundary: of Ethnocentric's glyphs at 11-128 px, 60 of 72 were FreeType's before, all of them now.

### Tests

- Tests for the decoders' rarer paths, each against its reference implementation: JPEG 4:4:0, 4:1:1, YCCK and fill
  bytes (Pillow), interlaced GIFs (Pillow), 16-bit RGB and interlaced RGBA PNGs (PngSuite), WebP's simple loop filter,
  sharpness and loop filter deltas (dwebp, a libvpx keyframe), CFF flex operators, CID-keyed CFF, scaled composite
  glyphs, cmap formats 0, 6 and 14, phantom point and cvar variations, hinting in the twilight zone (FreeType), more
  shaping inputs of HarfBuzz's test suite (USE, Indic, Myanmar, ...), more of resvg's SVG tests, AV1 timing info
  and frame ids, YCgCo, 180° rotations and items in several extents in AVIF (avifdec), JPEG XL custom primaries and
  tone mapping (djxl), and the code paths for big endian machines (forced on).

## 3.12.2

### Changes

- `encodeJPEG()` encodes like libjpeg-turbo: its integer color conversion, downsampling, DCT and quantization instead
  of floating point ones, so the files are byte for byte what `cjpeg -quality <q> -baseline -optimize` writes (with
  `-sample 1x1` above quality 90), but for the Exif segment. Quality 1-49 also uses libjpeg's integer scaling of the
  quantization tables now. Files differ slightly from before: photos 0.1-1% larger at the same quality, rendered
  images (screenshots, graphics) at quality 90 and above up to 9%, mostly as libjpeg rounds the YCbCr samples to 8 bits.

### Performance

- `encodeJPEG()` is about 30% faster: the integer pipeline, chroma converted and subsampled two rows at a time
  (instead of full-size planes first, 16 MB less for a 1920x1080 image), and entropy coding in two specialized passes.
- JPEG decoding upsamples chroma a row at a time while converting to RGB, and uses unscaled planes as they are,
  instead of first building full-size copies of all of them (about 6 MB less for a 1920x1080 image). Same output and
  speed.

## 3.12.1

### Changes

- Lossless `encodeWebP()` chooses whether to use the predictor and to subtract green by libwebp's entropy analysis,
  instead of always predicting: graphics with flat areas and repeated parts compress much better without the
  predictor. The 1434x1434 benchmark graphic takes 277 kB instead of 557 kB (cwebp: 278 kB), screenshots and images
  with transparency 15-30% less; photos stay the same. Over 39 test images the bitstreams went from 1.11 to 1.05
  times cwebp's (`-m 4 -q 75`, like sharp's default).
- Lossless `encodeWebP()` uses the color transform after the predictor, choosing per 32x32 block how much of green to
  subtract from red and of green and red from blue, like libwebp: 5-6% smaller for images like emoji and rendered
  graphics, about 0.6% on average, and about 9% slower. Over the same 39 images: 1.04 times cwebp's.
- The documentation moved to [imagescript.dev](https://imagescript.dev/); imagescript.matmen.dev redirects there.

## 3.12.0

### New

- Variable fonts: `renderText()` renders the instance `TextStyle.variations` asks for, by axis names (`weight`,
  `width`, `slant`, `italic`, `opticalSize`) or tags (like Roboto Flex's `GRAD`), clamped to the axes' ranges; the
  optical size is the font size unless given, like browsers' `font-optical-sizing: auto`. `renderSVG()` maps
  `font-weight`, `font-stretch` and `font-style` to the axes like browsers and resvg do, with `font-optical-sizing`
  and `font-variation-settings`, and matches a variable font's ranges of weights and stretches like several faces.
  TrueType outlines (gvar, with the interpolation of untouched points), advances (HVAR, else gvar's phantom points),
  metrics (MVAR), GPOS adjustments and anchors (variation indices), feature variations and hinting (cvar) vary;
  CFF2 outlines aren't supported yet. Outlines and advances are the same as fontTools' and HarfBuzz's, shaping is
  within HarfBuzz's rounding, and all 14 of resvg's `font-variation-settings` tests pass.

### Changes

- AVIFs without an ICC profile whose nclx box (or sequence header) gives other color primaries than sRGB's (Display
  P3, BT.2020, DCI-P3, ...) or a gamma 2.2, 2.8 or linear transfer are converted to sRGB when decoding, like browsers
  show them (`applyColorProfile: false` keeps the stored values): as a matrix/TRC profile of those primaries,
  relative colorimetric, within 1 of LittleCMS. Transfers of the BT.709 family are taken as sRGB's curve, so most
  AVIFs (BT.709 or unspecified primaries) stay the same.

## 3.11.0

### Fixes

- 3.10.0 is on npm but not on JSR, which refused it for declaring `import.meta.url`'s type globally; this version
  is published to both again.

### Changes

- JPEG XLs with an embedded ICC profile whose pixels are in its color space (lossless ones and recompressed JPEGs, not
  XYB) are converted to sRGB when decoding, like the other formats' (`applyColorProfile: false` keeps the stored
  values): the profile's stream is decoded (ported from jxl-oxide; the same profiles as libjxl's), then applied like
  PNGs' and JPEGs'. Lossy (XYB) JPEG XLs already decode to sRGB, their profiles only say what the image was before.

## 3.10.0

### Performance

- `encodeAVIF()` encodes in worker threads (`AVIFEncodeOptions.threads`, default: the processors available, at most
  8; `1` for none), writing the same files: superblock rows are searched in a wavefront (each superblock after the one
  above right of it), like libaom's row-based multithreading, so there is no loss in compression, and the loop filter
  and CDEF trials run in parallel. A 1920x1080 photo takes 1.1 s instead of 2.1 s at effort 0, 1.7 s instead of 4.9 s
  at effort 1 and 3.4 s instead of 14.2 s at effort 2 (8 threads, Ryzen 7 5800X). Works in Node (worker_threads),
  Deno, Bun and browsers (Web Workers; bundlers like Vite pick up the worker's module). Small images (under about
  640x640 pixels at effort 0, 448x448 at 1, 320x320 at 2), browser pages without cross-origin isolation (no
  SharedArrayBuffer), runtimes without workers, and workers that fail to start encode on the calling thread as before.
- Lossy `encodeJXL()` encodes in worker threads (`JXLEncodeOptions.threads`, the same default): XYB, the quantization
  field, the varblock search (rows of 64x64 areas, like libjxl's), the coefficients and their tokens run in parallel,
  writing the same files. A 1920x1080 photo takes 0.20 s instead of 0.28 s at effort 0, 0.86 s instead of 2.2 s at
  effort 1 and 1.7 s instead of 4.9 s at effort 2, a 3840x2160 one 0.42 s instead of 0.89 s, 2.0 s instead of 8.5 s
  and 4.8 s instead of 19.2 s (8 threads). Images under about 1.5 megapixels at effort 0, 512x512 pixels at 1 and
  384x384 at 2 encode without threads.
- JPEG XL decoding uses worker threads (`DecodeOptions.threads` and `AnimationDecodeOptions.threads`, the same
  default), lossy images from 4 megapixels on (one thread per 2 megapixels at most), lossless ones from 1.5 megapixels
  and 512 KiB on: the groups (with all their passes), Gaborish, the EPF's strips and the conversion to sRGB run in
  parallel, with the same pixels. A 3840x2160 image decodes in 395 ms
  instead of 640 ms lossy and 328 ms instead of 671 ms lossless, a 5120x2880 one in 568 ms instead of 1121 ms and
  487 ms instead of 1122 ms. Lossy frames no longer keep the coefficients of the whole frame (about 100 MB at 4K): each
  group is rendered once its passes are read.
- SVG rendering rasterizes paths 23-36% faster (a 1000x1000 SVG of 500 text labels: about 15% faster in all, the
  test SVG at 1920 pixels wide about 13%), with the same pixels: the edges in typed arrays bucketed by their first
  row, the active ones kept sorted by x so each sub-scanline's crossings come nearly sorted, the working arrays reused.
- `encodeJXL({ quality, effort: 2 })` searches patches about 30% faster (the connected components with a typed stack of
  pixel indices instead of an array of coordinates, in the same order): the same files.
- Lossless `encodeWebP()` searches the predictors and the prefix groups (the k-means of the blocks' histograms) in
  worker threads (`WebPEncodeOptions.threads`, the same default), from 1.5 megapixels on: the same files. A 2731x1536
  photo takes 1.07 s instead of 1.39 s, a 3862x2172 one 1.62 s instead of 2.34 s (8 threads); the backward
  references stay on one thread.
- The thresholds for threads were measured with 1 to 8 threads on 0.25 to 8 megapixels: lossy JPEG XL encoding at
  efforts 1 and 2 and AVIF encoding use 4 threads up to about 1-2 megapixels (more were slower there), JPEG XL at
  effort 0 starts at 1.5 megapixels, lossless JPEG XL decoding at 1.5 instead of 4 (and 512 KiB: smaller files, like
  ones of few colors, decode faster than threads start). Checked on screenshots, few colors and alpha too.
- AVIF decoding uses worker threads (`DecodeOptions.threads`) from 4 megapixels on: the conversion to RGB runs in
  bands of rows (started at the beginning, the threads load while the AV1 image is decoded) and the tiles of grids are
  decoded in parallel, with the same pixels. A 3840x2160 4:2:0 image decodes in 355 ms instead of 466 ms, a 6400x2880
  grid of 20 tiles in 1.12 s instead of 2.68 s (8 threads). 4:2:0 and 4:2:2 images convert about 7% faster on one
  thread too.
- Lossless JPEG XLs shown as they are (integer samples, no filters or upsampling) become RGBA bytes right away instead
  of through float planes, in the threads, with an RCT of the colors undone in the same pass: the same pixels. A
  3840x2160 image from `encodeJXL()` decodes in 304 ms instead of 379 ms with 8 threads, 548 ms instead of 581 ms
  with one.

### Tests

- Edge runtimes are tested: Cloudflare's workerd (with and without `nodejs_compat`) and Vercel's Edge Runtime run every
  codec and the renderers bundled like deployments (`tests/edge`), and Chromium runs them bundled by Vite, with threads
  on a cross-origin isolated page and without on another (`tests/browser`).

## 3.9.0

### Features

- `Image.renderSVG()` renders text (`<text>`, `<tspan>`, `<tref>`, `<textPath>`) with the fonts given as
  `SVGOptions.fonts` and the ones the SVG embeds with `@font-face` (TrueType, OpenType and WOFF in data: URIs, which
  win for their family names). Fonts are matched like browsers match installed ones: `font-family` by the names in
  the fonts, then `font-stretch`, `font-style` and `font-weight` by CSS Fonts' algorithm; generic families take the
  first font fitting them (by its panose and fixed pitch flag), other families and text without one the first font,
  and characters a face doesn't have come from the other fonts. Laid out like resvg's (ported from usvg): chunks
  shaped as a whole (kerning and ligatures across spans, with each span's own font), the bidirectional algorithm,
  `x`/`y`/`dx`/`dy`/`rotate` lists, `text-anchor`, `letter-spacing`, `word-spacing`, `textLength` and `lengthAdjust`,
  `baseline-shift` (`sub`, `super`, lengths), `dominant-baseline` and `alignment-baseline`, `text-decoration` in the
  colors of the elements declaring it, text along paths (`startOffset`, arc lengths measured like kurbo's), vertical
  text (`writing-mode`), `font-variant: small-caps`, `font-kerning`, the `font` shorthand, `xml:space`, and color
  glyphs (COLR versions 0 and 1, CBDT and sbix bitmaps, SVG glyphs). Text is painted like shapes (gradients and
  patterns with the bounding box of the whole text, strokes, `paint-order`), and counts in clip paths and in bounding
  boxes. Variable fonts aren't supported yet. 359 of resvg's 431 text tests pass (with its test fonts), and 41 more of
  its other tests that have text; the others need variable fonts (14), resvg's default font size of 12 pixels (instead
  of 16), its cursive and fantasy fonts, or render as resvg doesn't (in ways browsers don't either, like conjuncts
  broken at a font change).
- `encodeJXL({ quality, effort: 2 })` stores text-like features that repeat (glyphs on the flat backgrounds of
  screenshots) once, in a reference frame, and adds them where they occur, like libjxl's patches (`cjxl -e 7`, ported
  from it): a page of text takes 62% fewer bytes (143x91 pixels: 1698 instead of 4458), screenshots 1-2% fewer, like
  with cjxl. Images without such features stay as they are; finding them takes about 0.3 s per megapixel.
- Decoding converts images with embedded ICC color profiles to sRGB, like browsers show them (`DecodeOptions.applyColorProfile`,
  default `true`, also for `Animation.decode()`): PNGs (iCCP, unless an sRGB chunk is there too), JPEGs (APP2), WebPs
  (ICCP, also animated), AVIFs (colr prof/rICC, which then describe the RGB values instead of the nclx box) and TIFFs.
  Matrix/TRC profiles (RGB and gray; gamma, table and parametric curves) are applied relative colorimetric, colors
  outside sRGB clipped: Display P3 photos from phones, Adobe RGB and ProPhoto images no longer look washed out. The
  results are within 1 of LittleCMS's. Profiles with only lookup tables, CMYK profiles, gray profiles of color images (like libpng,
  which rejects them) and ones that are sRGB (like most cameras embed) leave the pixels as they are; converting a 1920x1080 image takes about 35 ms.
- `font-size` resolves `em`, `ex`, percentages and keywords against the parent's size for all elements (lengths in `em`
  used the default 16 pixels when an ancestor's size was relative), and `font-weight` `bolder` and `lighter`.
- `Image.renderSVG()` blends elements with `mix-blend-mode` (all 16 modes and `plus-lighter`, in CSS) and isolates
  groups with `isolation: isolate`, like resvg (the blend modes are the ones feBlend already used). All of resvg's 21
  mix-blend-mode and 2 isolation tests pass, up from 4 and 1.
- `Image.renderSVG()` applies `transform-origin` (keywords, lengths and percentages) to transforms of elements, clip
  paths, gradients and patterns; the root's transform turns around the center of its viewport, like resvg's. 21 of
  resvg's 23 transform-origin tests pass (the others have text), up from 3.
- `Image.renderSVG()` paints in the order of `paint-order` (fill, stroke and markers). 12 of resvg's 14 tests pass (the
  others have text), up from 6.
- `Image.renderSVG()` paints with `context-fill` and `context-stroke`: inside markers the paint of the shape they're on,
  inside `<use>` that of the element, in their coordinates and bounding boxes (gradients and patterns too). 13 of
  resvg's 16 tests pass, up from 2.
- `Image.renderSVG()` draws shapes without antialiasing for `shape-rendering: crispEdges` and `optimizeSpeed`, and fills
  the root's viewBox with its `background-color` (in CSS).
- `WebPEncodeOptions.alphaQuality` (0-100, default 100, also for lossy animations and `Animation.webpEncoder()`):
  below 100 the alpha plane of lossy images keeps fewer levels (2-16 up to 70, 16-256 above), like cwebp's `-alpha_q`
  (the same alpha values), so it compresses better: potato.png's alpha plane takes 1.3 kB at 50 instead of 1.9 kB,
  a gradient 4.3 kB instead of 16.7 kB.

### Fixes

- `Image.renderSVG()`: zero length dashes (`stroke-dasharray="0 40"`) at the start of a path get caps too, and square
  ones are turned along the path.
- `Image.renderSVG()`: shapes without a bounding box (horizontal and vertical lines and curves) painted with an
  `objectBoundingBox` gradient or pattern use its fallback color, and curves along an axis no longer count as having
  one.
- `Image.renderSVG()`: elements with `display: none` don't count towards the bounding boxes of groups (clip paths,
  masks, gradients and filters in `objectBoundingBox` units).
- `Image.renderSVG()`: `overflow="inherit"` on markers and nested viewports takes the parent's value.
- `Image.renderSVG()`: path data ends at the first character that isn't part of it, instead of skipping it.
- `Image.renderSVG()`: line ends (CR LF, CR) read as line feeds, like XML parsers read them.
- Hinting (`renderText` with `hinting`) places points exactly like FreeType's TrueType interpreter (version 35): vectors,
  projections and moves in its integer arithmetic (2.14 unit vectors normalized like FT_Vector_NormLen, its rounding of
  products and movement factors, points touched only where they move), `SLOOP` with 0, `IP` on the unscaled outline,
  composite glyphs' instructions measuring the hinted components at a scale of 1 and their origins left unrounded
  without instructions, and `DELTAP`/`DELTAC` asking for more pairs than the stack holds. Over 18 fonts (DejaVu,
  Carlito, Noto, Source Sans, Amiri, M+, Open Sans...) at 8-48 pixels, and all 6190 glyphs of DejaVu Sans at 4 sizes,
  every point is where FreeType puts it; before, up to 30% of the glyphs of some fonts were off by fractions of a
  pixel, a few (DejaVu Sans Mono) by up to 4 pixels.

## 3.8.1

### Performance

Decoding and encoding is faster, with identical results (images and files):

- JPEG decoding is about 14% faster (a 1920x1080 photo: 47 ms instead of 55 ms): YCbCr becomes RGB in a loop of its
  own, clamped by a lookup and stored a pixel at a time.
- JPEG encoding is about 10% faster: coefficients are stored in zigzag order with the position of each block's last
  nonzero one, so writing a block stops there instead of scanning all 64 (twice).
- PNG decoding is about 14% faster (a 1920x1080 photo: 36 ms instead of 41 ms): the Paeth filter keeps the neighbours
  of 3 and 4 byte pixels in variables, RGB rows become RGBA a pixel at a time.
- GIF decoding is about 14% faster (101 frames of 300x300: 40 ms instead of 46 ms): LZW strings are copied from
  where they were decoded before, instead of following a chain of codes back a byte at a time.
- Lossy WebP decoding is about 8% faster: upsampled pixels are stored a pixel at a time.

## 3.8.0

### Features

- `Image#region(x, y, width, height)` copies a region into a new image and leaves the image as it is (like `crop`
  on a clone, without copying the whole image). It's clipped like `crop`; on a frame it gives a plain image.
- `Animation.webpEncoder()`, `Animation.gifEncoder()` and `Animation.apngEncoder()` (width, height, options) encode
  animations a frame at a time: `await encoder.add(frame)` for each frame (a `Frame`, or any image, with options like
  `{ duration: 40 }` that override a frame's), then `await encoder.finish()` for the file, the same one `encodeWebP()`,
  `encodeGIF()` and `encodeAPNG()` make of the frames. Only the canvas and the frame before stay in memory (APNGs keep
  their frames compressed until the end: their pixel format depends on all of them): 120 frames of 1000x1000 take
  159 MB instead of 1066 MB as an `Animation`. Unoptimized WebPs with frames WebP can't store as they are (disposed to
  the previous frame, or disposed at odd offsets) store the canvas from the first of them on (`encodeWebP()` from the
  start), which looks the same.
- `encodeWebP({ quality, sharpYuv: true })` (images, animations and `Animation.webpEncoder`) converts to YUV like
  libwebp's sharp conversion (`cwebp -sharp_yuv`, ported: the same files), which keeps colored edges sharp. It takes
  about twice the time at the default effort; photos get about as large (+0.3% on a 1920x1080 photo), images with
  many hard color edges a lot larger.
- `Image.renderText()` takes OpenType features: `features: { tnum: true, smcp: true, liga: false, salt: 2 }` turns
  features on for the whole text (tabular numbers, small caps, stylistic sets, ...), off (also the default ones like
  ligatures or kerning) or picks an alternate by its number, like HarfBuzz's user features (shaped exactly like
  `hb-shape --features`). Fonts without a feature ignore it.

### Improvements

- `Image.renderSVG()` paints with patterns (`<pattern>`): tiles in user space or relative to the bounding box, their
  content in either, `viewBox` and `preserveAspectRatio`, `patternTransform`, attributes and children inherited
  through `href`. Like resvg, a tile is rendered once in device resolution and repeated (bicubic, or the nearest
  pixel where it's only translated); patterns painting their own content paint nothing. 32 of resvg's 33 pattern
  tests pass (the other one has text), up from 4.
- `Image.renderSVG()` draws markers (`marker-start`, `marker-mid`, `marker-end`, and the `marker` shorthand in CSS):
  `orient` (angles in any unit, `auto`, `auto-start-reverse`), `markerUnits`, `refX`/`refY`, `markerWidth`/
  `markerHeight`, `viewBox`, clipped unless `overflow` is visible; placed and oriented like resvg's (ported from usvg).
  Arcs are split into as many curves as resvg splits them into (more for large radii), which places the mid markers
  alike. 61 of resvg's 64 marker tests pass (the others have text or images), up from 11.
- `Image.renderSVG()` draws images (`<image>`) in data URIs: PNG, JPEG, GIF (the first frame), WebP and the other
  formats `Image.decode()` reads, and SVGs (also gzipped, and with their own embedded images). They're fitted like
  resvg's: `width`/`height` from the image where they're missing or `auto`, `preserveAspectRatio` (clipped with
  `slice`), `image-rendering`, sampled bicubically (the nearest pixel at their size). External files and URLs aren't
  loaded. Elements of embedded SVGs count towards the limit of 100000 elements rendered through references. Of
  resvg's 56 image tests, 17 pass the test suite's threshold, 37 without the frame around them, whose antialiasing
  differs (tiny-skia rounds edges to quarter pixels); most of the others load files.
- `Image.renderSVG()` applies filters (`filter="url(#…)"` and the filter functions `blur()`, `drop-shadow()`,
  `brightness()`, `contrast()`, `grayscale()`, `hue-rotate()`, `invert()`, `opacity()`, `saturate()`, `sepia()`):
  all 17 primitives (feGaussianBlur, feOffset, feFlood, feComposite with `arithmetic`, feMerge, feDropShadow,
  feColorMatrix, feComponentTransfer, feTile, feBlend with all 16 modes, feMorphology, feConvolveMatrix,
  feTurbulence, feDisplacementMap, feDiffuseLighting and feSpecularLighting with distant, point and spot lights,
  feImage showing an element or an embedded image), with filter regions and subregions in both units,
  `color-interpolation-filters` (linear RGB by default), inputs and results, attributes through `href`. Like resvg
  (ported from it), filters run on 8 bit premultiplied pixels in the element's scale, rotation and skew applied
  afterwards; invalid filters hide the element. 396 of resvg's 408 filter tests pass, up from 81 (the others have
  text or load files, but for 3).
- Optimized lossy WebP animations are smaller: like libwebp's, they leave out pixels that changed by up to a tolerance
  from the quality (3 per channel at quality 85, 1 at 100), and make unchanged pixels transparent only in whole 8x8
  blocks. Making each unchanged pixel transparent gave speckled alpha masks where most pixels change a little
  (cross-fades), which could cost more than they saved. On six cross-faded radar-like animations at quality 85 the
  files are 2% larger to 13% smaller than before and 7-46% smaller than unoptimized ones, at 0.1 dB PSNR below
  unoptimized ones (before: 0.8-1 dB below); where nearly every pixel changes a little, they're 10x smaller.

### Fixes

- Lossless WebPs, and lossy ones with alpha (most optimized animations), could be undecodable since 3.7.0 (#82): a
  prefix group whose code had a single symbol of 256 or more (a length code) took a bit per symbol instead of none.

### Performance

- `composite()` with an opacity in `normal` mode is about 40% faster (a 1100x680 layer, two thirds at alpha 150: 7.6
  ms instead of 12.6 ms): it takes the fast path with the source alpha scaled by the opacity, instead of the blend
  modes' per channel path. The results are the same, except for exact halves at opacities like 0.5, which now round
  like without an opacity (by 1 at most). Without an opacity it's 5-30% faster.

## 3.7.0

### Features

- `Image.encodeJXL({ quality, effort })` encodes lossy JPEG XLs (VarDCT): `quality` (0-100) maps to the Butteraugli
  distance like `cjxl -q` (90 is cjxl's default, 100 is lossless); without it, images are encoded losslessly as
  before. The encoder follows libjxl: XYB, the varblock sizes and transforms of libjxl's search (`effort` 1, the
  default, like `cjxl -e 5`; 2 also tries the 4x8 and AFV transforms; 0: 8x8 DCTs only, like `cjxl -e 3`), chroma
  from luma per 64x64 tile, libjxl's quantization, the weighted predictor for the LF, ANS, the edge preserving
  filter. Alpha is lossless. At the same SSIMULACRA2 score its files are about 1.5% smaller than `cjxl -e 5`'s at
  effort 1 (3.5% at effort 2) and within 1-4% of `cjxl -e 7`'s (up to 9% for screenshots); effort 0 is within 1.5%
  of `cjxl -e 3`. A 1920x1080 photo takes about 1 s at effort 0, 5 s at effort 1, 10 s at effort 2.

### Improvements

- Lossless WebPs (and the alpha of lossy ones) are smaller: the encoder groups blocks of 16 pixels by their
  statistics (prefix codes per group, like libwebp's entropy image), picks the color cache's size, delays matches by a
  pixel where the next one is longer, and predicts images of up to 256 colors instead of indexing them where that's
  smaller (smooth alpha). Lossless files are about 6% smaller (within about 7% of cwebp's), the alpha of lossy ones
  about 17% (at the default effort smaller than cwebp's). Lossless encoding takes about 65% longer.

### Fixes

- `AVIFEncodeOptions` is exported (with the new `JXLEncodeOptions`).

### Performance

- Lossy JPEG XL decoding is about 15% faster (a 2048x1536 image: 0.73 s instead of 0.87 s), with identical results:
  XYB becomes sRGB bytes right away for images shown as they are (an exact lookup of linear light), Gaborish and the
  edge preserving filter's usual pass load fewer samples.
- AVIF encoding is about 8% faster: the SATD is unrolled, the transform types are tried on one prediction, 16x16
  blocks whose coefficients take few bits aren't split further. The files are about as large as before.

## 3.6.0

### Features

- `Image.encodeAVIF()` and `Image.encodeJXL()` take `metadata` like the other encoders: author, description,
  copyright, creation time and software (by default ImageScript and its version) as Exif. In AVIFs it is an Exif item
  describing the image, JPEG XLs get the container (with an Exif box; the codestream stays what `cjxl -e 1` writes).
  As the creation time is always written, JPEG XLs are now always in the container (about 250 bytes more), like
  JPEGs and WebPs always have Exif; `metadata: { software: '' }` leaves out the software.

### Improvements

- Lossy WebP encoding defaults to `effort: 2` instead of 4: about a quarter of the time (about 250 ms instead of
  900 ms for a 1920x1080 photo) for files about 5% larger at a slightly lower quality (about 0.5 dB PSNR).
  `effort: 4` encodes like cwebp's default as before.
- AVIF encoding also tries splitting blocks into halves (horizontal or vertical, from 64x64 to 16x16) where the whole
  block and its quarters cost about the same: files about 2% smaller at the default effort, encoding about 20% slower.
- AVIF encoding with `effort: 2` also chooses smaller transforms within blocks (transform depth): files about 1% smaller
  (up to 4% for graphics), encoding about 10% slower.
- PNG (and APNG) encoding leaves the rows unfiltered when that compresses better than the paeth filter, as it often
  does for graphics and screenshots: their files are up to 30% smaller (and encoded faster), decided by compressing
  samples of the rows both ways. Photos stay as they were, encoding them takes about 8% longer.

### Performance

- Lossy WebP encoding with `effort` 3 to 6 is about 25% faster: modes that can no longer beat the
  best one are dropped before their distortion and rate are computed. The files stay byte for byte what cwebp writes.

## 3.5.0

### Features

- `Image.encodeAVIF({ quality, alphaQuality, subsampling, effort })` encodes AVIFs: an AV1 encoder of its own (still
  pictures, intra coding) whose syntax mirrors the dav1d based decoder, so dav1d decodes its files to exactly the
  encoder's reconstruction. It chooses partitions (64x64 to 8x8), the intra modes (with their angle deltas), chroma
  from luma, palettes (for screenshots and graphics) and the transform types by rate and distortion, quantizes the
  coefficients by rate and distortion, and picks the loop filter level and up to 8 CDEF strengths (per 64x64 block) by
  the filtered image. On photos its files are within a few percent of libaom's (avifenc's default speed) at the same
  PSNR, but encoding takes about 10 times as long. `quality` (0-100, default 60) maps to the quantizer like avifenc's
  -q; 100 is lossless (RGB, identity matrix). Greyscale images are encoded as monochrome. Transparency is a monochrome
  alpha image, lossless by default (`alphaQuality`); the colors of fully transparent pixels are smoothed (unless
  lossless), which costs fewer bits. `subsampling`: '4:4:4' (default) or '4:2:0'. `effort` (0-2, default 1): how many
  modes and partitions are tried.
- `Image.encodeJXL()` encodes lossless JPEG XLs: ported from libjxl's fast lossless encoder, the codestream is byte for
  byte what `cjxl -e 1` writes on CPUs with AVX2 or NEON (libjxl's output depends on the CPU: it works in chunks of 16
  pixels there, of 8 without SIMD, of 32 with AVX-512). Images of at most 511 colors besides black get a palette,
  others YCoCg; greyscale images are encoded as one channel, alpha only if the image has transparency. Unlike libjxl,
  two colors whose hashes collide within 8 pixels don't end up as one (libjxl then writes a palette that loses one of
  them; such images are encoded with YCoCg instead).

### Performance

- JPEG XL decoding is about 25% faster: lossy 2048x1536 images take about 0.87 s instead of 1.2 s, lossless ones of
  the default effort 2.6 s instead of 3.7 s. The output is the same, except for rounding: linear light becomes sRGB
  like libjxl does (a rational polynomial of the square root instead of a power).

## 3.4.0

### Features

- `Image.decode` reads BMPs, ICOs and CURs, QOIs, Netpbm images (PBM, PGM, PPM, PAM, PFM) and Radiance HDRs, and
  `ImageType` recognizes them (`'bmp'`, `'ico'`, `'cur'`, `'qoi'`, `'pnm'`, `'hdr'`; `ImageType.isBMP` etc.):
  - BMPs of 1, 2, 4, 8, 16, 24, 32 and 64 bits, with channel masks of any size (scaled to full white, not shifted),
    alpha, RLE4 and RLE8 (pixels they skip are transparent, like in browsers), embedded JPEGs and PNGs, top-down rows,
    and OS/2's headers. Matches BMP Suite's reference images (32-bit channels wider than 8 bits within 1, they're
    rounded). Not supported: OS/2's Huffman and RLE24 compression.
  - Icons and cursors decode their largest image (of those as large, the one with the most bits): bitmaps with their
    AND masks (32-bit ones with alpha, unless it's zero everywhere), or PNGs.
  - Netpbm: plain and raw, samples of up to 16 bits, PAM's tuple types.
  - Radiance HDRs: RGBE and XYZE, every orientation, both run length encodings.
- `Image.decode` reads AVIFs, and `ImageType` recognizes them (`'avif'`, `ImageType.isAVIF`). The AV1 decoder is
  ported from dav1d and decodes exactly like it: 4:2:0, 4:2:2, 4:4:4 and monochrome, 8, 10 and 12 bits, every intra
  coding tool (palettes, intra block copy, filter intra, chroma from luma, quantizer matrices, lossless, 128x128
  superblocks, tiles), every post filter (deblocking, CDEF, superres, loop restoration) and film grain. The container:
  the primary item or a grid of them, alpha (also premultiplied, or one per grid tile), the crop, rotation and
  mirroring properties (`clap`, `irot`, `imir`), the color description of `colr`, and the first frame of image
  sequences (also from `Animation.decode`). Converted to RGB like libavif does, so the pixels are libavif's; HDR
  AVIFs (PQ and HLG, BT.2020 and Display P3 primaries) are converted to sRGB with `toneMapping`. Not supported:
  frames that use other frames (inter frames): image sequences only give their first frame, and of layered images
  whose shown layer is inter coded the highest intra coded layer is shown if it has the image's size (else they
  throw).
- `Image.decode` reads JPEG XLs, `Animation.decode` their animations (composited frames, durations, loop count), and
  `ImageType` recognizes them (`'jxl'`, `ImageType.isJXL`). Ported from jxl-oxide and libjxl: bare codestreams and the
  container (`jxlc`, `jxlp`), Modular (meta-adaptive trees, every predictor including the self-correcting one,
  reversible color transforms, palettes with delta and implicit colors, squeeze, LZ77) and VarDCT (every varblock type,
  chroma from luma, adaptive LF smoothing, chroma subsampled JPEG recompression), progressive passes and LF frames,
  Gaborish and the edge-preserving filter, patches, splines, noise, upsampling, cropped and blended frames and reference
  frames, alpha (also premultiplied), spot colors, CMYK, the orientation. XYB images are rendered to sRGB, HDR ones (PQ,
  HLG, or brighter than SDR white) tone mapped with `toneMapping`; others stay in their color space, CMYK ones become
  their colors times black (like CMYK JPEGs). Every file of the JPEG XL conformance suite decodes within 1 of libjxl's
  djxl (as 8-bit sRGB; but djxl ignores black without a CMS). Not supported: ICC profiles aren't applied, previews are
  skipped.
- `Image.encodeWebP({ quality })` encodes lossy WebPs (VP8, with a losslessly compressed alpha plane if the image
  isn't opaque): ported from libwebp's encoder with its default settings, the VP8 bitstream is byte for byte the one
  cwebp writes for the same quality (0-100). `effort` (0-6, default 4) is cwebp's `-m`: 0-2 decide by distortion only
  and are several times faster, 5-6 search harder for smaller files. Without a quality WebPs stay lossless.
  `Animation.encodeWebP({ quality, effort })` encodes lossy frames the same way.
- `DecodeOptions.toneMapping`: HDRs', PFMs' and HDR AVIFs' and JPEG XLs' light can be brighter than (SDR) white. By
  default (`'reinhard'`) the brightest parts are compressed like Reinhard's extended tone mapping operator does, the
  brightest pixel becomes white (without the operator's automatic exposure, which turns night scenes grey); images no
  brighter than white stay as they are. `'clamp'` clamps everything brighter than white instead. Either way the result
  is sRGB.
- `Image.encodeBMP`, `Image.encodeQOI` and `Image.encodePNM`:
  - BMPs with a palette of 2, 16 or 256 colors if an opaque image has at most that many, else 24-bit, or 32-bit with
    an alpha mask (a version 4 header) if the image has transparency
  - QOIs byte for byte like the reference encoder (3 channels if the image is opaque)
  - PBM for black and white images, PGM for greyscale ones, PPM, or PAM if the image has transparency

### Fixes

- TrueType hinting matches FreeType's in more fonts: SPVTL, SFVTL and SDPVTL set their vectors from the second point
  to the first (they pointed the other way), S45ROUND rounds to FreeType's 45° grid, ISECT and ALIGNPTS compute like
  FreeType's integer arithmetic. (Found by a test font using every instruction, compared with FreeType point for point.)
- `rand`: the alternates picked at random are the ones HarfBuzz picks (its random state wraps around at 2^32).
- `Image.renderSVG`: spaces around presentation attribute values (`fill="  url(#gradient) "`) are ignored, as in CSS.

## 3.3.0

### Features

- `ResizeOptions.fast` (default `true`): bilinear and area resizing (down to about a third of the size, and
  enlarging) round to 8 bits between the two passes, so both passes share their multiplications between two channels.
  `fast: false` keeps the more precise results of 3.2.1.
  - Opaque images: halving a 1920×1080 photo takes 12 instead of 15 ms, doubling it 61 instead of 80 ms. About 10-25%
    of the channel values differ from 3.2.1, by at most 1.
  - Transparent images are premultiplied to 8 bits, like browsers do: halving takes 24 instead of 43 ms, doubling 103
    instead of 260 ms. What shows once they're composited differs from 3.2.1 by up to about 2 steps (alpha by at most 2),
    the color of pixels that are almost transparent can differ more.
- `RotateOptions.fast` (default `true`): rotations by angles that aren't multiples of 90° sample with 8-bit weights
  on 8-bit premultiplied pixels, two channels per multiplication, and skip the parts of each row outside the source.
  Rotating a 1920×1080 photo by 30° takes 51 instead of 119 ms (61 instead of 114 ms with alpha). Opaque pixels stay
  within 1 of 3.2.1 (0.5-2% of the values differ), what shows of translucent ones (also the faded edges) within
  about 2.5 steps. `fast: false` keeps the precise sampling.
- `Image.renderText` takes several fonts by priority (`[text, emoji]`): every character comes from the first font that
  has it, the first font sets the line height. Color glyphs keep their colors: COLR version 0 layers with CPAL
  palettes (e.g. Twemoji), CBDT/CBLC bitmaps (e.g. Noto Color Emoji, which now loads at all, it has no outlines) and
  sbix bitmaps (Apple's format).
  Invisible characters like joiners and variation selectors take no room, as in browsers.
- `Image.renderText` shapes text in every script like browsers do (a port of HarfBuzz's OpenType shaping, glyph for
  glyph and position for position the same as HarfBuzz 14.6 on the tested texts):
  - right to left and bidirectional text (the Unicode Bidirectional Algorithm): Arabic, Hebrew and others, mixed with
    left to right text and numbers, brackets mirrored
  - joining scripts (Arabic, Syriac, N'Ko, Mongolian, Adlam, ...), with presentation forms for fonts without shaping
    features
  - Indic scripts (Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam) with their
    conjuncts, reph and matra reordering, Khmer, Myanmar, Thai and Lao, Hangul syllables, and the scripts of the
    Universal Shaping Engine (Sinhala, Tibetan, Javanese, Balinese and many more)
  - all GSUB and GPOS lookups: mark positioning (diacritics, vowel signs), cursive attachment, kerning, contextual
    substitutions and positioning; the kern table for fonts without GPOS kerning, and marks placed by their combining
    class for fonts without mark positioning
  - emoji sequences (skin tones, flags, keycaps, families and other joined ones) become one glyph, from the first font
    that has all of their characters; the emoji variation selector picks a color glyph (❤️ in an emoji font rather than
    the text font's ❤)
  - text wraps at the line break opportunities of the Unicode Line Breaking Algorithm (also in CJK text and before
    or after punctuation, not only at spaces), words wider than a line between grapheme clusters; each line is
    shaped and ordered by itself
  The Unicode data (properties of version 18.0) with the bidirectional algorithm and line breaking add about 39 kB
  (gzipped) to the package, the shaping about 39 kB.
- `Image.renderText` renders COLR version 1 color glyphs (e.g. Noto-COLRv1): solid colors, linear, radial and sweep
  gradients (pad, repeat, reflect), glyph outlines as masks, transforms and all composite modes; variable paints with
  their default values. They are rendered at four times the size and scaled down, so layers sharing an edge don't let the
  ones below show through. Fonts with both prefer them over their other color glyphs, like browsers.
- `Image.renderText` composes combining sequences (e + ◌́ to é, as in text from macOS) where the font has the composed
  character, and decomposes characters the fonts lack where one has their parts, like HarfBuzz. Fallback fonts are
  chosen per grapheme cluster (UAX #29).
- Fallback fonts are only loaded when the text needs them, and glyphs (also decoded and scaled emoji bitmaps) are
  kept per font and size across calls.
- `DecodeOptions.maxPixels` and `AnimationDecodeOptions.maxPixels` (default 268,402,689, that's 16383², like sharp):
  larger images, and animations whose frames take more pixels together, throw a RangeError before anything that size
  is allocated. Tiny files declaring huge images (decompression bombs) could take gigabytes or kill the process: a
  250-byte JPEG of 65500x65500, a 115 kB GIF with 5000 frames on a 4000x4000 screen. `maxPixels: Infinity` lifts the
  limit. TIFFs also can't take more than 8 bytes of samples per pixel of the limit, or tiles much larger than the
  image.

### Performance

- Lossless WebP encoding is about 40% faster and decoding about 15% faster (1920×1080 photo: 735 instead of 1220 ms,
  82 instead of 95 ms), with identical output: the predictors run as one loop per mode instead of a switch per pixel,
  residual costs come from a table, and the LZ77 search hashes every pixel pair once.

- Decoding PNGs takes less memory (an 8000x8000 RGBA image: 785 instead of 1272 MB at most): the rows are unfiltered in
  place, and `Image.decode` keeps the decoded pixels instead of copying them. `Animation.decode` decodes still PNGs like
  images (10 times as fast for large ones), and composites APNG frames that replace pixels row by row.

### Fixes

- `Image.renderSVG`: SVGs with long malformed styles, `url()` references, lengths or colors (e.g. a stylesheet of
  200,000 characters without braces, which took a minute) parse in linear time instead of backtracking quadratically
  or worse in regular expressions. A style rule that isn't closed at the end of the stylesheet applies now, as in
  browsers.
- NaN and infinite arguments throw a RangeError naming the argument instead of silently drawing black, transparent
  or nothing: colors (`fill`, `setPixelAt`, `drawBox`, `drawCircle`, `trim`, `colorToAlpha`, `Image.gradient`, the
  text and stroke colors, `Image.rgbaToColor` and the other color conversions, so `Image.rgbToColor(NaN, 0, 0)` is no
  longer black), coordinates and sizes (`getPixelAt`, `crop`, `composite`, `drawBox`, `drawCircle`, `contain`),
  angles and amounts (`rotate`, `hueShift`, `roundCorners`, `fisheye`, `cropCircle`), infinite factors (`opacity`,
  `red`, `lightness`, `brightness`, `contrast`, `gamma`, ...), the PNG compression and JPEG quality, the font size,
  frame durations and offsets, and loop counts. Numeric strings keep working. `TextLayout`'s `maxWidth` and `maxHeight`
  accept `Infinity` (no limit), NaN throws instead of meaning no limit.
- The outline of `Image.renderText` (`strokeWidth`) showed through translucent text, it now only shows around the
  glyphs (opaque text renders as before).
- The outline of `Image.renderText` follows the glyphs' antialiased edges instead of their pixels, so it is smooth
  rather than stepped, and it reaches exactly `strokeWidth` beyond the edge.
- `Image.renderText` threw for text without anything to show (empty, only spaces), it now renders a transparent pixel
  wide.
- Damaged fonts no longer take unbounded memory or time: glyphs with contour end points that don't increase render
  empty (as in FreeType), composite glyphs can't contain themselves (also when hinting), and outlines have a size
  limit. Reading past the end of damaged or truncated font data throws "Font: damaged or truncated font data" instead
  of a RangeError, and text larger than 2^28 pixels throws.
- Glyph outlines reaching far outside their bitmap rasterize correctly (the parts outside used to change the slope of
  the edges inside).
- Damaged images throw "Image: damaged or truncated image data" (with the original RangeError as its cause) instead
  of RangeErrors from reading past their end. JPEGs with more than 4 components are rejected (each took memory the size
  of the image).
- `blur` and `sharpen` hung with an infinite radius, they throw a RangeError now; huge finite radii take as long as
  small ones (`blur(1e9)` took minutes).
- `Image.renderSVG` against denial of service: elements rendered through `<use>` references multiplying each other
  ("billion laughs", a billion rectangles from a 1 kB file) are limited to 100,000 (like librsvg), dash patterns of
  more than a million dashes stroke solid (like Skia) instead of taking any amount of memory, and arbitrarily deep
  nesting no longer overflows the stack.

## 3.2.1

### Performance

- Resizing is 2-4 times faster for opaque images with bilinear and area resizing (halving a 1920×1080 photo: 15 instead
  of 49 ms), and 20-40% faster otherwise: the arithmetic is integer, the vertical pass runs first, and for opaque
  images two channels share a multiplication. Results differ from 3.2.0 by at most 1 per channel (more only in the
  invisible color of pixels that are almost fully transparent).
- `clone()` is about 50% faster.
- `blur()` is about 2.4 times faster (1920×1080 photo: 86 instead of 205 ms): the three box blurs run on the pixels as
  32-bit words, two channels per sum. Results differ from 3.2.0 by at most 1 per channel (2 for radii above 10).
  Transparent images are blurred premultiplied in 8 bits, like browsers do: the color of pixels that are almost
  transparent can differ more, what shows when they're composited stays within 2 steps.
- Decoding GIF animations is about 35% faster, with identical results: frames are composited from their color
  indices instead of an RGBA copy of each, and the composited frames aren't copied again.

### Fixes

- Enlarging with `RESIZE_AREA` left transparent rows and columns where a pixel's center fell right on the edge of the
  filter.

## 3.2.0

### New

- **Options objects**: every method with optional arguments takes them as an object too, e.g.
  `image.resize(100, 100, {mode: Image.RESIZE_BICUBIC})`, `image.composite(logo, {x: 10, y: 10, opacity: 0.5})`,
  `Image.renderText(font, 32, 'Hi', {color: 0xff0000ff, strokeWidth: 2})`, `new Frame(10, 10, {duration: 50})`,
  `animation.encodeGIF({quality: 80})`. Options can be left out or added without counting positions; the positional
  arguments keep working until 4.0.
- **Smaller animations**: `encodeGIF()`, `encodeAPNG()` and `encodeWebP()` store each frame as the area that changed
  since the frame before, with unchanged pixels transparent where that compresses better, and merge identical
  frames. Re-encoding 762 decoded animations (which have every frame as a full image) took 51% (GIF), 63% (APNG) and
  54% (WebP) of the bytes in total; the less moves, the smaller a file gets, ones where everything moves stay about
  the same. Large animations encode faster, small ones up to about twice as slow. The files show the same animation as
  before, but don't decode to the same frames anymore: `{optimize: false}` stores the frames as they are.
- **`Animation.frames`**: the frames of an animation as an array, to use instead of the animation itself (see
  Deprecated). Changing it (`push()`, `splice()`, …) changes the animation, and it can be replaced as a whole.
- **Metadata in every format**: `encodeJPEG()`, `encodeWebP()`, `encodeTGA()` and, for animations, `encodeGIF()`,
  `encodeAPNG()` and `encodeWebP()` take the same metadata as `encode()` (now called `Metadata`), as the `metadata`
  option: `image.encodeJPEG({quality: 80, metadata: {author: 'me'}})`. Each format stores
  the fields it has a place for: Exif and a comment for JPEG, Exif for WebP, comments for GIF, the extension area for
  TGA, text chunks for PNG and APNG. Like PNGs, all files name ImageScript and its version as the software and
  include the creation time by default; `{software: ''}` leaves the software out.
- **`trim(color, options)`**: removes borders of one color, like the empty space around rendered text or a solid
  background around a logo. Without a color, the top left pixel's is used; `tolerance` also trims near colors (e.g.
  JPEG artifacts). Frames keep their position.

### Performance

- GIF decoding is about 25% faster, with identical results: indices become colors through a lookup table, LZW
  strings are written without bounds checks unless they run past the image.
- SVG rendering is about 15-20% faster, with identical results: groups with opacity, clip paths, masks and nested
  viewports are composited only where they painted.
- PNG decoding is about 25% faster and encoding about 10% faster, with identical results: the paeth filter is
  computed without branches, 8-bit RGB images are converted without per-sample function calls.
- Lossless WebP encoding is about 15% faster, with identical files: backward reference candidates that can't be
  longer are skipped, the per-channel predictor helpers are unrolled.
- Resizing (bilinear, bicubic and area) is about 10% faster, with identical results.

### Deprecated

- **Animations as arrays**: `Animation` (and `GIF`) extend `Array`, so `animation[0]`, `animation.length` and
  `animation.map()` work on the frames. In 4.0 they won't extend `Array` anymore, which makes array methods
  unambiguous (`map()` can return anything, so it can't return an animation): use `animation.frames`, an array of
  the frames that changes the animation when it's changed.
- **`PNGMetadata`**: renamed to `Metadata`, the old name stays an alias until 4.0.

### Fixes

- TGA encoding: run length encoded packets end with the row, as TGA 2.0 requires. Before, packets could span rows,
  which some readers reject (Pillow fails with "buffer overrun").
- PNG text metadata: text that isn't Latin-1 (like `©` is, but `Ⓒ` or emoji aren't) is written into `iTXt` chunks as
  UTF-8 instead of `tEXt`, where readers showed it garbled; text chunks come before the image data, where all readers
  look for them.
- An invalid `creationTime` throws a `RangeError` instead of writing "Invalid Date".

## 3.1.0

### New

- **WebP decoding**: lossy, lossless, with alpha and animated (#19, #20). Still images decode with `Image.decode()`,
  animated ones with `Animation.decode()`. The output is bit-exact with libwebp (checked against libwebp's test
  vectors and their reference checksums).
- **WebP encoding** (lossless): `Image.encodeWebP()`, typically 20-30% smaller than PNG.
- **APNG** decoding and encoding (#6): `Animation.decode()` reads animated PNGs (broken animations fall back to the
  default image, like browsers do), `Animation.encodeAPNG()` writes them with full alpha. `Image.decode()` still
  returns an APNG's default image.
- **`Animation`**, the base class of `GIF`: an array of frames that decodes GIF, APNG and WebP
  (`Animation.decode()`) and encodes `encodeGIF()`, `encodeAPNG()` and `encodeWebP()`. `GIF` keeps its API.
- `decode()` returns animated WebPs as `Animation`; `ImageType` recognizes WebP (`isWebP()`, `getType() === 'webp'`).
- **TGA** decoding and encoding (#21): color mapped, truecolor and greyscale, uncompressed and run length encoded, all
  four origins. `Image.decode()` recognizes TGAs by their header (they have no magic number), `encodeTGA()` writes
  run length encoded 24/32 bit files.
- **`colorToAlpha(color, options)`** (#39): makes a color transparent like GIMP's "Color to Alpha", antialiased edges
  become translucent instead of keeping a fringe of the removed color. Without a color, the top left pixel's is used.
  The color is removed everywhere in the image, not only from a connected background.
- **TrueType hinting** (#31): `renderText()` runs the hinting instructions of TrueType fonts, which align stems and
  edges with the pixel grid for crisper small text, like Windows renders it. Hinted outlines match FreeType's classic
  interpreter point for point, glyphs of hinted fonts are placed on whole pixels. Fonts without instructions (and
  CFF/OpenType outlines) render as before; `renderText(..., {hinting: false})` turns it off.

### Deprecated

- **`GIF`**: use `Animation`, which works the same and also handles APNG and WebP (`new GIF(frames).encode()` becomes
  `new Animation(frames).encodeGIF()`, `GIF.decode()` becomes `Animation.decode()`). `GIF` will be removed in 4.0.

### Fixes

- Text rendering: glyph outlines touching the left edge of their bitmap could come out inverted (a rasterizer
  rounding issue); hinting made it common

## 3.0.0

ImageScript is now written in TypeScript and has no WebAssembly or native binaries anymore. Every codec and renderer
was rewritten, the npm package shrank from 3 MB to about 120 kB, and it installs and runs on any platform Node.js
supports (including Alpine/musl and bundled serverless functions).

On JSR, `@matmen/imagescript` is now the same package as on npm (it used to be the Deno-only 1.x with WebAssembly),
published from the TypeScript sources with every release: `deno add jsr:@matmen/imagescript`.

### Breaking changes

- **Node.js 22.13 or newer is required.** The package is ES modules only; `require('imagescript')` keeps working
  through Node's `require(esm)`.
- **All coordinates are 0-based.** `getPixelAt`, `setPixelAt`, `getRGBAAt`, iteration, `fill` callbacks, `drawBox`
  and `drawCircle` used 1-based coordinates while `crop` and `composite` used 0-based offsets. Code that addressed
  pixels starting at 1 now has to subtract 1; out of range coordinates throw.
- **WebP encoding and `encodeWEBP()` were removed**, use `encode()` (PNG) or `encodeJPEG()`.
- **`invertSaturation()` and `invertHue()` were removed.** `invertHue()` mirrored the hue (`h -> 1 - h`); for the
  complementary color use `hueShift(180)`.
- **The experimental `imagescript/v2` API was removed.**
- **`TextLayout` alignment options are named correctly:** `horizontalAlign` takes `left`/`center`/`right`,
  `verticalAlign` takes `top`/`middle`/`bottom`. Values passed under the old (swapped) names are still accepted.
  Alignment and `wrapStyle: 'char'` actually work now, which changes the output of code that set them.
- **`GIF.encode(quality)`** scales the palette size: 1 = 8 colors, 50 = 55, 90 and above = 256.
- **`GIF.decode`** returns the GIF's real loop count (it always returned -1); GIFs without a loop extension play once (0).
- **Resizing defaults to bilinear filtering** (`Image.RESIZE_BILINEAR`) instead of nearest neighbor, which aliased
  badly when shrinking photos. Pass `Image.RESIZE_NEAREST_NEIGHBOR` for pixel art; it now samples the pixel centers,
  which shifts its output by up to a pixel. `RESIZE_AUTO` rounds the computed side instead of flooring it.
- **`drawCircle()`, `cropCircle()` and `roundCorners()` are antialiased.** `drawCircle(x, y, r)` is centered on the
  center of pixel (x, y) and has a radius of exactly `r`. `cropCircle(max, feathering)`: `feathering` is now the share
  of the radius (0..1) over which the edge fades out; it used to fade the whole circle.
- **`dominantColor()`** groups the colors into clusters (median cut and k-means) and returns the average color of the
  largest one, instead of the most common bucket of a fine HSL histogram (which returned shifted colors, e.g. `#fb0000`
  for pure red, and let small flat areas beat large varied ones). `bwThreshold` (still 0-64) now ignores colors whose
  channels are all below / above the threshold, so dark saturated colors like navy are no longer discarded as black.
- **Text is laid out with subpixel precision and kerning** (GPOS and kern tables). Glyph advances used to be rounded
  up to whole pixels, so text gets narrower and more evenly spaced.
- **`encode()`** writes the smallest lossless PNG color type: a palette for images with up to 256 colors, otherwise
  greyscale or RGB, with an alpha channel only if needed. Rows of non-palette images are paeth filtered, which makes
  photos about 25% and gradients up to 95% smaller. Compression uses the runtime's native zlib when available
  (node:zlib), which is several times faster than the JS fallback.
- **JPEGs, TIFFs and PNGs are rotated/mirrored as their orientation tag says**, like browsers display them. Photos
  taken with a rotated camera used to come out sideways. PNGs take it from the eXIf chunk, or without one from
  ImageMagick's Exif text or the XMP packet (which browsers ignore). `Image.decode(data, {applyOrientation: false})` keeps the
  stored pixels.
- **`rgbaToColor()` / `rgbToColor()` round and clamp the components** to 0..255. Out of range values used to wrap
  around (256 became 0) and fractions were truncated.
- **`Frame.disposalMode` returns the mode's name** (`'keep'`, ...), matching the `Frame.DISPOSAL_*` constants and what
  it is set to; it used to return the numeric id.
- **`invertValue()`** inverts the HSV value (the brightest channel `v` becomes `255 - v`, black becomes white). It used
  to invert HSL lightness, which `invertLightness()` does now.
- **`rotate()`** is documented as counterclockwise, which it always was.
- **`averageColor()`** weights pixels by their opacity.

### Fixes

- `rotate(90)` / `rotate(270)` scrambled non-square images (#29); free rotation lost the image edges
- `composite()` darkened semi-transparent pixels drawn onto transparent ones
- `crop()` read pixels from the next row when the region exceeded the image
- `drawBox()` threw when the box was outside the image
- `cropCircle(max)` ignored `max`
- `roundCorners()` was asymmetric and did nothing to the right/bottom corners for fractional radii
- `Frame.resize()` returned a frame without its duration, offsets and disposal mode; `Frame.clone()` returned an Image
- `GIF.slice()` without an end, `GIF.map()` and `GIF.filter()` threw
- `GIF.resize()` stretched partial frames to the full size
- `encode({...metadata})` ignored the metadata
- `fisheye()` shifted the image by a pixel
- HSL conversions truncated instead of rounding, so `lightness(1)`, `saturation(1)` or `hueShift(360)` changed the
  image and repeated adjustments drifted darker; negative hues (e.g. `hueShift(-300)`) produced wrong colors
- `cover()` could return an image a pixel smaller than requested, `contain()` one a pixel smaller than the box
- Big endian TIFFs weren't recognized, and most TIFFs failed to decode
- Text alignment was ignored (#37)
- Assigning `image.bitmap` left `getPixelAt()` and other methods reading the old pixels
- GIF frame durations were truncated to centiseconds (16 ms became 10 ms), they are rounded now
- `invert()`, `dominantColor()`, `rotate()`, `hueShift()`, `lightness()`, `saturation()` and the other HSL based
  functions are several times faster; PNG decoding uses native zlib when available

### New

- `blur(radius)` (gaussian, radius = standard deviation like CSS' `blur()`) and `sharpen(amount, radius)` (unsharp mask)
- `brightness(factor)`, `contrast(factor)`, `gamma(gamma)`, `greyscale()` (ITU-R 601 luma, like Pillow) and `sepia()`
- `composite(source, x, y, {opacity, mode})` with the blend modes of CSS' `mix-blend-mode` (`multiply`, `screen`,
  `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`)
  and `add`
- Outlined text: `renderText(font, size, text, color, layout, {strokeWidth, strokeColor})`
- `invertLightness()`, which does what `invertValue()` used to do (invert HSL lightness)
- `encodePNG()`, an alias of `encode()`
- Options objects as an alternative to positional arguments: `cropCircle({max, feathering})`,
  `dominantColor({ignoreBlack, ignoreWhite, threshold})`, `rotate(angle, {resize})`
- `Frame.DISPOSAL_ANY`; `ImageType.isPNG()` and the other checks accept any binary data, not only a `DataView`
- Parameter names describe what they are: `red/green/blue(factor)`, `renderText(font, size, ...)`, `fisheye(strength)`
- Resize modes `Image.RESIZE_BILINEAR` (default), `Image.RESIZE_BICUBIC` and `Image.RESIZE_AREA`, all usable with
  `resize`, `scale`, `contain`, `fit`, `cover` and `GIF.resize`

### Codecs

- PNG: all color types and bit depths, interlacing, tRNS transparency, checksum validation; inflating uses the
  runtime's native zlib when available
- JPEG: baseline and progressive decoding (bit-exact with libjpeg-turbo), encoding with optimized Huffman tables
- GIF: encoding with a median cut quantizer and dithering, tolerant decoding
- TIFF: strips and tiles, LZW/deflate/PackBits/JPEG compression, 1-32 bit and float samples, CMYK and YCbCr, BigTIFF
- Fonts: TrueType and OpenType (CFF) outlines; much faster for large fonts
- SVG: shapes, paths, transforms, use/symbol, CSS, gradients, strokes, clip paths and masks. Text, images, filters
  and patterns are not rendered.
