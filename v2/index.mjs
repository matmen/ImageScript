import * as mem from './mem.js';
import * as magic from './magic.js';
import * as png from '../png/src/png.js';
import * as codecs from '../node/index.js';
import framebuffer from './framebuffer.js';

const wasm = {
  svg: require('../wasm/node/svg.js'),
  gif: require('../wasm/node/gif.js'),
  jpeg: require('../wasm/node/jpeg.js'),
  tiff: require('../wasm/node/tiff.js'),
  // font: require('../wasm/node/font.js'),
}

const image_formats = ['png', 'jpeg', 'tiff'];
const all_formats = ['png', 'gif', 'jpeg', 'tiff'];

// type png_options = {
//   /** zlib compression level (0-9) */
//   level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
// };

// type gif_options = {
//   /** frame quality (1-30) */
//   quality?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30,
// }

// type jpeg_options = {
//   /** image quality (1-100) */
//   quality?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 | 52 | 53 | 54 | 55 | 56 | 57 | 58 | 59 | 60 | 61 | 62 | 63 | 64 | 65 | 66 | 67 | 68 | 69 | 70 | 71 | 72 | 73 | 74 | 75 | 76 | 77 | 78 | 79 | 80 | 81 | 82 | 83 | 84 | 85 | 86 | 87 | 88 | 89 | 90 | 91 | 92 | 93 | 94 | 95 | 96 | 97 | 98 | 99 | 100,
// };

// type svg_options = {
//   /** image fit options */
//   fit?: svg_fit_zoom | svg_fit_width | svg_fit_height,
// };

// type svg_fit_zoom = {
//   /** zoom by factor */
//   zoom,
//   width?: undefined,
//   height?: undefined,
// };
// type svg_fit_width = {
//   /** scale to width */
//   width,
//   zoom?: undefined,
//   height?: undefined,
// };

// type svg_fit_height = {
//   /** scale to height */
//   height,
//   zoom?: undefined,
//   width?: undefined,
// };

/** load image from memory */
export async function load(buffer) {
  const u8 = mem.view(buffer);
  if (0 === u8.length) throw new TypeError('empty buffer');

  const meta = magic.buffer(u8);
  if (!meta) throw new Error('unknown file format');
  if ('image' !== meta.type) throw new Error('unsupported file type');
  if (!all_formats.includes(meta.format)) throw new Error('unsupported image format');

  if ('gif' === meta.format) throw new Error('gif not supported');
  const frame = 'png' === meta.format ? png.decode(u8) : (await wasm[meta.format].init()).load(u8);

  // animation
  // if ('gif' === meta.format) return new GIF(null, null, null, codecs.gif.load(u8).map(x => new Frame(x.width, x.height, 10 * x.delay, x.buffer)));

  return new Image(frame.width, frame.height, frame.buffer);
}

// box image
// export class Frame extends framebuffer {
//   constructor(width, height, duration, buffer = new Uint8Array(4 * width * height)) {
//     super(width, height, buffer);
//     this.duration = duration ?? 100;
//   }

//   clone() { return new Frame(this.width, this.height, this.duration, this.u8.slice()); }
//   overlay(framebuffer, x = 0, y = 0) { return super.overlay(framebuffer, x, y); };
//   replace(framebuffer, x = 0, y = 0) { return super.replace(framebuffer, x, y); };
//   from(framebuffer) { return new Frame(framebuffer.width, framebuffer.height, framebuffer.duration ?? 100, framebuffer.u8); }
// }

// // animation
// export class GIF extends Array {
//   constructor(width, height, loops, frames = []) {
//     super(...frames);
//     this.loops = loops ?? -1;
//     this.width = width ?? frames[0]?.width;
//     this.height = height ?? frames[0]?.height;
//   }

//   clone() { return new GIF(this.width, this.height, this.loops, this.map(frame => frame.clone())); }
//   static decode(buffer) { return new GIF(null, null, null, codecs.gif.load(mem.view(buffer)).map(x => new Frame(x.width, x.height, 10 * x.delay, x.buffer))); }

//   encode(options = {}) {
//     const encoder = new codecs.gif.Encoder(this.width, this.height, this.loops);
//     this.forEach(frame => encoder.add(frame.duration / 10, frame.width, frame.height, frame.u8, Math.abs(30 - ((options.quality ?? 21) - 1))));

//     return encoder.u8();
//   }

//   resize(type, width, height) {
//     this.width = width;
//     this.height = height;
//     this.forEach(frame => frame.resize(type, width, height));
//   }
// }

export class Image extends framebuffer {
  constructor(width, height, buffer) {
    super(width, height, buffer || new Uint8Array(4 * width * height));
  }

  clone() { return new Image(this.width, this.height, this.u8.slice()); }
  from(framebuffer) { return new Image(framebuffer.width, framebuffer.height, framebuffer.u8); }

  async encode(format, options = {}) {
    if ('png' === format) return codecs.png.encode(this.u8, { ...options, width: this.width, height: this.height });
    if ('jpeg' === format) return codecs.jpeg.encode(this.u8, { ...options, width: this.width, height: this.height });

    throw new TypeError('invalid image format');
  }

  static async decode(format, buffer, options = {}) {
    buffer = mem.view('string' === typeof buffer ? Buffer.from(buffer) : buffer);

    if ('auto' === format) {
      const meta = magic.buffer(buffer);
      if (!meta) throw new Error('unknown file format');
      if ('image' !== meta.type) throw new Error('unsupported file type');
      if (!image_formats.includes(meta.format)) throw new Error('unsupported image format');

      format = meta.format;
    }

    let frame;
    if ('svg' === format) frame = (await wasm.svg.init()).load(buffer, options.fit ?? null);
    
    else if (format in wasm) frame = (await wasm[format].init()).load(buffer);

    if (!frame) throw new TypeError('invalid image format');
    return new Image(frame.width, frame.height, frame.buffer);
  }
}