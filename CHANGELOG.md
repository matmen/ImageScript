# Changelog

## 3.0.0

ImageScript is now written in TypeScript and has no WebAssembly or native binaries anymore. Every codec and renderer
was rewritten, the npm package shrank from 3 MB to about 100 kB, and it installs and runs on any platform Node.js
supports (including Alpine/musl and bundled serverless functions).

### Breaking changes

- **Node.js 22.12 or newer is required.** The package is ES modules only; `require('imagescript')` keeps working
  through Node's `require(esm)`.
- **All coordinates are 0-based.** `getPixelAt`, `setPixelAt`, `getRGBAAt`, iteration, `fill` callbacks, `drawBox`
  and `drawCircle` used 1-based coordinates while `crop` and `composite` used 0-based offsets. Code that addressed
  pixels starting at 1 now has to subtract 1; out of range coordinates throw.
- **WebP encoding was removed.** `encodeWEBP()` rejects; use `encode()` (PNG) or `encodeJPEG()`.
- **The experimental `imagescript/v2` API was removed.**
- **`TextLayout` alignment options are named correctly:** `horizontalAlign` takes `left`/`center`/`right`,
  `verticalAlign` takes `top`/`middle`/`bottom`. Values passed under the old (swapped) names are still accepted.
  Alignment and `wrapStyle: 'char'` actually work now, which changes the output of code that set them.
- **`GIF.encode(quality)`** scales the palette size: 1 = 8 colors, 50 = 55, 90 and above = 256.
- **`GIF.decode`** returns the GIF's real loop count (it always returned -1); GIFs without a loop extension play once (0).
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
- Big endian TIFFs weren't recognized, and most TIFFs failed to decode
- Text alignment was ignored (#37)

### Codecs

- PNG: all color types and bit depths, interlacing, tRNS transparency, checksum validation; inflating uses the
  runtime's native zlib when available
- JPEG: baseline and progressive decoding (bit-exact with libjpeg-turbo), encoding with optimized Huffman tables
- GIF: encoding with a median cut quantizer and dithering, tolerant decoding
- TIFF: strips and tiles, LZW/deflate/PackBits/JPEG compression, 1-32 bit and float samples, CMYK and YCbCr, BigTIFF
- Fonts: TrueType and OpenType (CFF) outlines; much faster for large fonts
- SVG: shapes, paths, transforms, use/symbol, CSS, gradients, strokes, clip paths and masks. Text, images, filters
  and patterns are not rendered.
