import { sync, async, format } from './_.mjs';

import jimp from 'jimp';
import sharp from 'sharp';
import v2 from '../v2/framebuffer.mjs';
import * as imagers from '@evan/wasm/target/image/node.mjs';
import * as v2_wasm from '@evan/wasm/target/imagescript/node.mjs';

{
  const rgba = new Uint8Array(4 * 256 * 256).map((_, i) => i % 256);

  const images = {
    v2: new v2(256, 256, rgba),
    imagers: imagers.framebuffer.from(256, 256, rgba),
    v2_wasm: v2_wasm.framebuffer.from(256, 256, rgba),
    sharp: sharp(rgba, { raw: { width: 256, height: 256, channels: 4 } }),
    jimp: await new Promise(r => new jimp({ width: 256, height: 256, data: rgba }, (_, i) => r(i))),
  };

  console.log(format({
    percentiles: false,
    title: 'flip horizontal (256)',

    results: {
      jimp: sync(1e4, () => images.jimp.flip(true, false)),
      imagescript: sync(1e4, () => images.v2.flip('horizontal')),
      sharp: await async(1e4, () => images.sharp.flip().toBuffer()),
      'image-rs (wasm)': sync(1e4, () => images.imagers.flip_horizontal()),
      'imagescript-rs (wasm)': sync(1e4, () => v2_wasm.flip_horizontal(images.v2_wasm)),
    },
  }));

  images.v2_wasm.drop();
  images.imagers.drop();
}

{
  const rgba = new Uint8Array(4 * 256 * 256).map((_, i) => i % 256);

  const images = {
    v2: new v2(256, 256, rgba),
    imagers: imagers.framebuffer.from(256, 256, rgba),
    v2_wasm: v2_wasm.framebuffer.from(256, 256, rgba),
    sharp: sharp(rgba, { raw: { width: 256, height: 256, channels: 4 } }),
    jimp: await new Promise(r => new jimp({ width: 256, height: 256, data: rgba }, (_, i) => r(i))),
  };

  console.log(format({
    percentiles: false,
    title: 'flip vertical (256)',

    results: {
      jimp: sync(1e4, () => images.jimp.flip(false, true)),
      imagescript: sync(1e4, () => images.v2.flip('vertical')),
      sharp: await async(1e4, () => images.sharp.flop().toBuffer()),
      'image-rs (wasm)': sync(1e4, () => images.imagers.flip_vertical()),
      'imagescript-rs (wasm)': sync(1e4, () => v2_wasm.flip_vertical(images.v2_wasm)),
    },
  }));

  images.v2_wasm.drop();
  images.imagers.drop();
}