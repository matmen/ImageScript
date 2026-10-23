# Changelog

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
- `DecodeOptions.toneMapping`: HDRs' and PFMs' linear light can be brighter than white. By default (`'reinhard'`) the
  brightest parts are compressed like Reinhard's extended tone mapping operator does, the brightest pixel becomes
  white (without the operator's automatic exposure, which turns night scenes grey); images no brighter than white
  stay as they are. `'clamp'` clamps everything brighter than white instead. Either way the result is sRGB.
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
