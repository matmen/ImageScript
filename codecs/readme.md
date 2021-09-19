# fast codecs bindings for node and browsers

`npm i @imagescript/codecs`

```js
import { png } from '@imagescript/codecs';

const rgba = new Uint32Array(256 * 256);
const image = png.encode(rgba, { width: 256, height: 256 });
```

## supported platforms
|                  | node@10 | node@12 | node@14 | node@16 |
| ---------------- | ------- | ------- | ------- | ------- |
| wasm32           | ✕       | ✕       | ✕       | ✕       |
| macos x64        | ✓       | ✓       | ✓       | ✓       |
| macos arm64      | ✓       | ✓       | ✓       | ✓       |
| windows x64      | ✓       | ✓       | ✓       | ✓       |
| linux x64 gnu    | ✓       | ✓       | ✓       | ✓       |
| linux arm64 gnu  | ✓       | ✓       | ✓       | ✓       |

you can force usage of wasm by setting `CODECS_FORCE_WASM` env variable

for deno and browsers use `@imagescript/codecs/wasm/bundle/browser.js` [cdn](https://unpkg.com/@imagescript/codecs/wasm/bundle/browser.js)

## benchmarks

TODO!

## License

MIT © [evan](https://github.com/evanwashere) [matmen](https://github.com/matmen)