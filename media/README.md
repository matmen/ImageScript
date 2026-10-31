# ImageScript logo assets

The `{■}` mark: curly braces around a 3×3 pixel mosaic. All text is converted to paths, so the SVGs render
the same everywhere without fonts (Inter ExtraBold + JetBrains Mono Medium/Regular were used).

## Files

| File | Use |
|---|---|
| `favicon.svg`, `favicon.ico` (16/32/48), `favicon-16/32/48.png` | imagescript.dev favicon |
| `apple-touch-icon.png` (180, full bleed) | iOS home screen |
| `icon-192.png`, `icon-512.png`, `icon-1024.png` | web manifest, general use |
| `icon.svg` / `icon-dark-ring.svg` | app-style tile; the ring variant separates it from dark backgrounds |
| `mark-transparent.svg` / `-dark.svg` | mark without tile, for light / dark backgrounds |
| `mark-mono-black.svg` / `-white.svg` | single colour (print, stamps, shields.io `logo=`) |
| `wordmark.svg` / `-dark.svg` (+ `.png` @2x) | icon + name, e.g. docs header |
| `wordmark-tagline.svg` / `-dark.svg` (+ `.png` @2x) | icon + name + description, README header |
| `social-preview.png` / `.svg` (1280×640) | GitHub social preview and `og:image` |
| `discord-icon.png` (512, safe inside the circle crop) | Discord server icon |

## Colours

| | Hex |
|---|---|
| tile / ink | `#141821` |
| braces on dark | `#F2F4F8` |
| "Script" (light / dark bg) | `#3178C6` / `#6FA8FF` |
| mosaic | `#FFC857` `#FF8C61` `#E85D8C` `#8E6CEF` `#4C7DF0` |

## Where they're used

- README header: `wordmark-tagline.svg` / `-dark.svg` by absolute URL, so it also shows on npm and JSR; the
  Documentation badge has `mark-mono-white.svg` inlined as its logo
- docs (imagescript.dev): `favicon.svg` and `docs.css` through `typedoc.json`; `scripts/docs.js` copies
  `favicon.ico`, `apple-touch-icon.png` and `social-preview.png` to the site's root and adds the description and
  Open Graph tags to every page
- set by hand: `social-preview.png` as the repository's social preview (Settings → General → Social preview),
  `discord-icon.png` as the Discord server's icon
