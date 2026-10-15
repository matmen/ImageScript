# Changelog

## 3.1.0 (unreleased)

### New

- **APNG** decoding and encoding (#6): `Animation.decode()` reads animated PNGs (broken animations fall back to the
  default image, like browsers do), `Animation.encodeAPNG()` writes them with full alpha. `Image.decode()` still
  returns an APNG's default image.
- **`Animation`**, the base class of `GIF`: an array of frames that decodes GIF and APNG (`Animation.decode()`) and
  encodes `encodeGIF()` and `encodeAPNG()`. `GIF` keeps its API.

### Deprecated

- **`GIF`**: use `Animation`, which works the same and also handles APNG (`new GIF(frames).encode()` becomes
  `new Animation(frames).encodeGIF()`, `GIF.decode()` becomes `Animation.decode()`). `GIF` will be removed in 4.0.

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
