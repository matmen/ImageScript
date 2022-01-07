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
    title: 'overlay(256x256)',

    results: {
      jimp: sync(1e4, () => images.jimp.composite(images.jimp, 0, 0)),
      imagescript: sync(1e4, () => images.v2.overlay(images.v2, 0, 0)),
      'image-rs (wasm)': sync(1e4, () => images.imagers.overlay(images.imagers, 0, 0)),
      'imagescript-rs (wasm)': sync(1e4, () => v2_wasm.overlay(images.v2_wasm, images.v2_wasm, 0, 0)),
      sharp: await async(1e4, () => images.sharp.composite([{ input: rgba, raw: { width: 256, height: 256, channels: 4 } }]).toBuffer()),
    },
  }));

  images.v2_wasm.drop();
  images.imagers.drop();
}