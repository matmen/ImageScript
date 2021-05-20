const mem = require('./mem.js');
const magic =  require('./magic.js');
const png = require('../png/node.js');
const codecs = require('../node/index.js');
const { default: framebuffer } = require('./framebuffer.js');

const wasm = {
  svg: require('../wasm/node/svg.js'),
  gif: require('../wasm/node/gif.js'),
  jpeg: require('../wasm/node/jpeg.js'),
  tiff: require('../wasm/node/tiff.js'),
  // font: require('../wasm/node/font.js'),
}

const image_formats = ['png', 'jpeg', 'tiff'];
const all_formats = ['png', 'gif', 'jpeg', 'tiff'];

async function load(buffer) {
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

class Image extends framebuffer {
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

module.exports = { load, Image };

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