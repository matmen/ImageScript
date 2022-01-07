import { sync, async, format } from './_.mjs';

import jimp from 'jimp';
import sharp from 'sharp';
import v2 from '../v2/framebuffer.mjs';
import * as imagers from '@evan/wasm/target/image/node.mjs';
import * as v2_wasm from '@evan/wasm/target/imagescript/node.mjs';
const rgba = new Uint8Array(4 * 256 * 256).map((_, i) => i % 256);

const images = {
  v2: () => new v2(256, 256, rgba),
  v2_wasm: v2_wasm.framebuffer.from(256, 256, rgba),
  imagers: imagers.framebuffer.from(256, 256, rgba),
  sharp: sharp(rgba, { raw: { width: 256, height: 256, channels: 4 } }),
  jimp: await new Promise(r => new jimp({ width: 256, height: 256, data: rgba }, (_, i) => r(i))),
};

console.log(format({
  percentiles: false,
  title: 'resize linear (256 -> 1024)',

  results: {
    // others don't have linear
    imagescript: sync(1e3, () => images.v2().resize('linear', 1024, 1024)),
    'imagescript-rs (wasm)': sync(1e3, () => v2_wasm.resize(images.v2_wasm, 'linear', 1024, 1024).drop()),
  },
}));

console.log(format({
  percentiles: false,
  title: 'resize cubic (256 -> 1024)',

  results: {
    // others don't have cubic
    imagescript: sync(1e3, () => images.v2().resize('cubic', 1024, 1024)),
    sharp: await async(1e3, () => images.sharp.resize(1024, 1024, { kernel: 'cubic' }).toBuffer()),
    'imagescript-rs (wasm)': sync(1e3, () => v2_wasm.resize(images.v2_wasm, 'cubic', 1024, 1024).drop()),
  },
}));

console.log(format({
  percentiles: false,
  title: 'resize nearest (256 -> 1024)',

  results: {
    imagescript: sync(1e4, () => images.v2().resize('nearest', 1024, 1024)),
    jimp: sync(1e4, () => images.jimp.resize(1024, 1024, jimp.RESIZE_NEAREST_NEIGHBOR)),
    sharp: await async(1e4, () => images.sharp.resize(1024, 1024, { kernel: 'nearest' }).toBuffer()),
    'image-rs (wasm)': sync(1e4, () => imagers.resize(images.imagers, 'nearest', 1024, 1024).drop()),
    'imagescript-rs (wasm)': sync(1e4, () => v2_wasm.resize(images.v2_wasm, 'nearest', 1024, 1024).drop()),
  },
}));