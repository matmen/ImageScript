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
    v2_wasm: () => v2_wasm.framebuffer.from(256, 256, rgba),
    sharp: sharp(rgba, { raw: { width: 256, height: 256, channels: 4 } }),
    jimp: await new Promise(r => new jimp({ width: 256, height: 256, data: rgba }, (_, i) => r(i))),
  };

  console.log(format({
    percentiles: false,
    title: 'blur (5.0f/256x256)',

    results: {
      jimp: sync(1e4, () => images.jimp.clone().blur(5)),
      imagescript: sync(1e4, () => images.v2.clone().blur('gaussian')),
      sharp: await async(1e4, () => images.sharp.clone().blur(5).toBuffer()),
      'image-rs (wasm)': sync(1e4, () => imagers.blur(images.imagers, 5).drop()),
      'imagescript-rs (wasm)': sync(1e4, () => { let i = images.v2_wasm(); v2_wasm.blur(i, 5); i.drop() }),
    },
  }));

  images.imagers.drop();
}

{
  const rgba = new Uint8Array(4 * 1024 * 1024).map((_, i) => i % 256);

  const images = {
    v2: new v2(1024, 1024, rgba),
    imagers: imagers.framebuffer.from(1024, 1024, rgba),
    v2_wasm: () => v2_wasm.framebuffer.from(1024, 1024, rgba),
    sharp: sharp(rgba, { raw: { width: 1024, height: 1024, channels: 4 } }),
    jimp: await new Promise(r => new jimp({ width: 1024, height: 1024, data: rgba }, (_, i) => r(i))),
  };

  console.log(format({
    percentiles: false,
    title: 'blur (5.0f/1024x1024)',

    results: {
      jimp: sync(1e4, () => images.jimp.clone().blur(5)),
      imagescript: sync(1e4, () => images.v2.clone().blur('gaussian')),
      sharp: await async(1e4, () => images.sharp.clone().blur(5).toBuffer()),
      'image-rs (wasm)': sync(1e4, () => imagers.blur(images.imagers, 5).drop()),
      'imagescript-rs (wasm)': sync(1e4, () => { let i = images.v2_wasm(); v2_wasm.blur(i, 5); i.drop() }),
    },
  }));
}