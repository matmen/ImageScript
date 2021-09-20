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

image used for benchmarks: `new framebuffer(width, height).fill((x, y) => x * y)`

![benchmark](https://plot.evan.lol/bar/eyJ0aXRsZSI6IkdJRiBvcHMvcyAoaGlnaGVyIGlzIGJldHRlcikiLCJwb2ludHMiOlt7Im5hbWUiOiJlbmNvZGUoNXggUkdCQSAyNTZ4MjU2KSIsInNjb3JlcyI6WzE0LjU2LDIuMzZdfSx7Im5hbWUiOiJlbmNvZGUoNXggUkdCQSAxMDI0eDEwMjQpIiwic2NvcmVzIjpbMC43MywwLjIxXX1dLCJsZWdlbmQiOlt7Im5hbWUiOiJuYXRpdmUoQGltYWdlc2NyaXB0L2NvZGVjcykiLCJjb2xvciI6ODUxMTM4MDQ3fSx7Im5hbWUiOiJqcyhAc2t5cmEvZ2lmZW5jKSIsImNvbG9yIjotMTI1MDk3MjY3M31dfQ==.png)

![benchmark](https://plot.evan.lol/bar/eyJ0aXRsZSI6IkpQRUcgb3BzL3MgKGhpZ2hlciBpcyBiZXR0ZXIpIiwicG9pbnRzIjpbeyJuYW1lIjoiZW5jb2RlKFJHQkEgNjR4NjQpIiwic2NvcmVzIjpbNDMuNTgsNTcyOS4wOCw4MTEuMjldfSx7Im5hbWUiOiJlbmNvZGUoUkdCQSAyNTZ4MjU2KSIsInNjb3JlcyI6WzMyLjQ0LDM2NS45MywyMjguN119LHsibmFtZSI6ImVuY29kZShSR0JBIDUxMng1MTIpIiwic2NvcmVzIjpbMTYuMjIsODIuOTgsNzkuMjddfSx7Im5hbWUiOiJlbmNvZGUoUkdCQSAxMDI0eDEwMjQpIiwic2NvcmVzIjpbNC4yMiwxOS4xNiwyMi43OV19LHsibmFtZSI6ImVuY29kZShSR0JBIDIwNDh4MjA0OCkiLCJzY29yZXMiOlsxLjA1LDQuODksNS42N119XSwibGVnZW5kIjpbeyJuYW1lIjoianMoanBlZy1qcykiLCJjb2xvciI6ODUxMTM4MDQ3fSx7Im5hbWUiOiJuYXRpdmUoQGltYWdlc2NyaXB0L2NvZGVjcykiLCJjb2xvciI6LTEyNTA5NzI2NzN9LHsibmFtZSI6Im5hdGl2ZShzaGFycCkiLCJjb2xvciI6LTExNTY1MDA0ODF9XX0=.png)

![benchmark](https://plot.evan.lol/bar/eyJ0aXRsZSI6IlBORyBvcHMvcyAoaGlnaGVyIGlzIGJldHRlcikiLCJwb2ludHMiOlt7Im5hbWUiOiJlbmNvZGUoUkdCQSA2NHg2NCkiLCJzY29yZXMiOlsyNDAuNzEsMTQzNy44Nyw2OTAuOTQsNzY2LjA1XX0seyJuYW1lIjoiZW5jb2RlKFJHQkEgMjU2eDI1NikiLCJzY29yZXMiOlsxMi43OSw1Ni4yOCwzMS41MywxMTIuNDZdfSx7Im5hbWUiOiJlbmNvZGUoUkdCQSA1MTJ4NTEyKSIsInNjb3JlcyI6WzkuOTQsMjUuODMsMTAuMzEsMzQuODZdfSx7Im5hbWUiOiJlbmNvZGUoUkdCQSAxMDI0eDEwMjQpIiwic2NvcmVzIjpbMy4wNCw3LDMuMzcsMTAuMzddfSx7Im5hbWUiOiJlbmNvZGUoUkdCQSAyMDQ4eDIwNDgpIiwic2NvcmVzIjpbMC44LDEuNzYsMC45NywyLjddfV0sImxlZ2VuZCI6W3sibmFtZSI6ImpzKHVwbmcpIiwiY29sb3IiOjg1MTEzODA0N30seyJuYW1lIjoibmF0aXZlKEBpbWFnZXNjcmlwdC9jb2RlY3MpIiwiY29sb3IiOi0xMjUwOTcyNjczfSx7Im5hbWUiOiJqcyhpbWFnZXNjcmlwdCkiLCJjb2xvciI6LTExNTY1MDA0ODF9LHsibmFtZSI6Im5hdGl2ZShzaGFycCkiLCJjb2xvciI6LTE0MTI4NzE2OX1dfQ==.png)

## License

MIT © [evan](https://github.com/evanwashere) [matmen](https://github.com/matmen)