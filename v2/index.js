const mem = require('../utils/mem.js');
const magic = require('./codecs/magic.js');
const { Color, default: framebuffer } = require('./framebuffer.js');

const codecs = {
  png: require('../formats/png.js'),
  gif: require('../formats/gif.js'),
  svg: require('../formats/svg.js'),
  jpeg: require('../formats/jpeg.js'),
  tiff: require('../formats/tiff.js'),
};

// all decoders return 8-bit RGBA
function decodeStill(format, u8) {
  const { width, height, pixels } = codecs[format].decode(u8);
  return { width, height, buffer: pixels };
}

// todo: verbose range errors

const animation_formats = ['gif'];
const image_formats = ['png', 'jpeg', 'tiff'];
const all_formats = ['png', 'gif', 'jpeg', 'tiff'];

async function load(buffer) {
  const u8 = mem.view(buffer);
  if (0 === u8.length) throw new RangeError('empty buffer');

  const meta = magic.buffer(u8);
  if (!meta) throw new RangeError('unknown file format');
  if ('image' !== meta.type) throw new RangeError('unsupported file type');
  if (!all_formats.includes(meta.format)) throw new RangeError('unsupported image format');

  if ('gif' === meta.format) return Animation.decode('gif', u8);
  return Image.from(decodeStill(meta.format, u8));
}

class Frame {
  timestamp = 0;
  dispose = 'any';

  constructor(width, height, buffer) {
    this.image = buffer instanceof Image ? buffer : new Image(width | 0, height | 0, buffer);
  }

  get width() { return this.image.width; }
  get height() { return this.image.height; }

  clone() {
    const frame = new Frame(this.width, this.height, this.image.clone());

    frame.dispose = this.dispose;
    frame.timestamp = this.timestamp;

    return frame;
  }

  static from(framebuffer) {
    const frame = new Frame(framebuffer.width, framebuffer.height, framebuffer.u8 || framebuffer.buffer);

    frame.dispose = framebuffer.dispose || 'any';
    frame.timestamp = framebuffer.timestamp || 0;

    return frame;
  }
}

class Image extends framebuffer {
  constructor(width, height, buffer) {
    super(width, height, buffer || new Uint8Array(4 * width * height));
  }

  encode(format, options = {}) {
    let encoded;
    if ('png' === format) {
      const level = ({ fast: 1, default: 6, best: 9 })[options.compression] ?? 6;
      encoded = codecs.png.encode(this.u8, { channels: 4, width: this.width, height: this.height, level });
    }
    else if ('jpeg' === format) encoded = codecs.jpeg.encode(this.u8, this.width, this.height, options.quality ?? 90);
    else if ('webp' === format) throw new RangeError('webp encoding is no longer supported');
    else throw new RangeError('invalid image format');

    return options.sync ? encoded : Promise.resolve(encoded);
  }

  static async decode(format, buffer, options = {}) {
    buffer = mem.view('string' === typeof buffer ? Buffer.from(buffer) : buffer);

    if ('auto' === format) {
      const meta = magic.buffer(buffer);
      if (!meta) throw new RangeError('unknown file format');
      if ('image' !== meta.type) throw new RangeError('unsupported file type');
      if (!image_formats.includes(meta.format)) throw new RangeError('unsupported image format');

      format = meta.format;
    }

    let frame;
    if ('svg' === format) {
      const fit = options.fit ?? {};
      const [mode, size] = fit.width ? [2, fit.width] : fit.height ? [3, fit.height] : [1, fit.zoom ?? 1];
      const { width, height, pixels } = codecs.svg.render(buffer, mode, size);
      frame = { width, height, buffer: pixels };
    }

    else if (['png', 'jpeg', 'tiff'].includes(format)) frame = decodeStill(format, buffer);

    if (!frame) throw new RangeError('invalid image format');
    return new Image(frame.width, frame.height, frame.buffer);
  }
}

class Animation {
  width = 0;
  height = 0;
  frames = [];
  repeat = Infinity;

  constructor(width, height) {
    this.width = width | 0;
    this.height = height | 0;
  }

  clear() { this.frames.length = 0; }
  [Symbol.iterator]() { return this.frames.values(); }

  add(frame) {
    if (this.width !== frame.width) throw new RangeError('invalid frame width');
    else if (this.height !== frame.height) throw new RangeError('invalid frame height');

    this.frames.push(frame);
  }

  resize(type, width, height) {
    this.width = width | 0;
    this.height = height | 0;
    for (const frame of this) frame.image.resize(type, this.width, this.height);
  }

  async encode(format, options = {}) {
    if ('gif' === format) {
      const dispose = { any: 0, keep: 1, previous: 2, background: 3 };
      const repeat = options.repeat ?? this.repeat;

      let prev = { timestamp: 0 };
      const frames = this.frames.map(frame => {
        const delay = ((frame.timestamp - prev.timestamp) / 10) | 0;
        prev = frame;
        return { x: 0, y: 0, width: frame.width, height: frame.height, delay, dispose: dispose[frame.dispose] ?? 0, pixels: frame.image.u8 };
      });

      return codecs.gif.encode({ width: this.width, height: this.height, loopCount: Infinity === repeat ? -1 : repeat, frames }, options.quality ?? 95);
    }

    throw new RangeError('invalid animation format');
  }

  static async decode(format, buffer, options = {}) {
    buffer = mem.view(buffer);

    if ('auto' === format) {
      const meta = magic.buffer(buffer);
      if (!meta) throw new RangeError('unknown file format');
      if ('image' !== meta.type) throw new RangeError('unsupported file type');
      if (!animation_formats.includes(meta.format)) throw new RangeError('unsupported animation format');

      format = meta.format;
    }

    if ('gif' === format) {
      const decoded = codecs.gif.decode(buffer);
      const animation = new Animation(decoded.width, decoded.height);
      animation.repeat = -1 === decoded.loopCount ? Infinity : decoded.loopCount;

      let timestamp = 0;
      for (const { pixels, delay } of codecs.gif.composite(decoded)) {
        const frame = new Frame(decoded.width, decoded.height, pixels);
        frame.dispose = 'background';
        frame.timestamp = timestamp += 10 * delay;
        animation.frames.push(frame);
      }

      return animation;
    }

    throw new RangeError('invalid animation format');
  }
}

module.exports = { load, Image, Frame, Color, Animation };
