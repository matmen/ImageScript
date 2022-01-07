import Color from './ops/color.mjs';
import { view } from './util/mem.mjs';
import * as ops from './ops/index.mjs';
import * as png from '../png/src/png.mjs';

export { Color };

// todo: tree shakable context
// todo: make errors more verbose

export default class framebuffer {
  constructor(width, height, buffer) {
    this.width = width | 0;
    this.height = height | 0;
    this.u8 = buffer ? view(buffer) : new Uint8Array(4 * this.width * this.height);
    this.view = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength);
    this.u32 = new Uint32Array(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength / 4);
    if (this.u8.length !== 4 * this.width * this.height) throw new RangeError('invalid capacity of buffer');
  }

  [Symbol.iterator]() { return ops.iterator.cords(this); }
  toString() { return `framebuffer<${this.width}x${this.height}>`; }
  get(x, y) { return this.view.getUint32((x | 0) + (y | 0) * this.width, false); }
  clone() { return new this.constructor(this.width, this.height, this.u8.slice()); }
  set(x, y, color) { this.view.setUint32((x | 0) + (y | 0) * this.width, color, false); }
  toJSON() { return { width: this.width, height: this.height, buffer: Array.from(this.u8) } }
  scale(type, factor) { return this.resize(type, factor * this.width, factor * this.height); }
  overlay(frame, x = 0, y = 0) { return (ops.overlay.blend(this, frame, x | 0, y | 0), this); }
  replace(frame, x = 0, y = 0) { return (ops.overlay.replace(this, frame, x | 0, y | 0), this); }
  at(x, y) { const offset = 4 * ((x | 0) + (y | 0) * this.width); return this.u8.subarray(offset, 4 + offset); }
  static from(framebuffer) { return new this(framebuffer.width, framebuffer.height, framebuffer.u8 || framebuffer.buffer); }
  static decode(format, buffer) { if (format !== 'png') throw new RangeError('invalid image format'); else return framebuffer.from(png.decode(buffer)); }

  encode(format, options = {}) {
    if (format !== 'png') throw new RangeError('invalid image format');
    else return png.encode(this.u8, { channels: 4, width: this.width, height: this.height, level: ({ none: 0, fast: 3, default: 6, best: 9 })[options.compression] ?? 3 });
  }

  pixels(type) {
    if ('rgba' === type) return ops.iterator.rgba(this);
    if (!type || 'int' === type) return ops.iterator.u32(this);

    throw new RangeError('invalid iterator type');
  }

  flip(type) {
    if (type === 'vertical') ops.flip.vertical(this);
    else if (type === 'horizontal') ops.flip.horizontal(this);

    else throw new RangeError('invalid flip type');

    return this;
  }

  crop(type, arg0, arg1, arg2, arg3) {
    if (type === 'circle') ops.crop.circle(arg0 || 0, this);
    else if (type === 'box') ops.crop.crop(arg0 | 0, arg1 | 0, arg2 | 0, arg3 | 0, this);

    else throw new RangeError('invalid crop type');

    return this;
  }

  cut(type, arg0, arg1, arg2, arg3) {
    if (type === 'circle') return ops.crop.circle(arg0 || 0, this.clone());
    else if (type === 'box') return ops.crop.cut(arg0 | 0, arg1 | 0, arg2 | 0, arg3 | 0, this);

    else throw new RangeError('invalid cut type');
  }

  rotate(deg, resize = true) {
    if (0 === (deg %= 360)) return this;
    else if (90 === deg) ops.rotate.rotate90(this);
    else if (180 === deg) ops.rotate.rotate180(this);
    else if (270 === deg) ops.rotate.rotate270(this);

    else ops.rotate.rotate(deg, this, resize);

    return this;
  }

  blur(type, arg0) {
    if (type === 'cubic') ops.blur.cubic(this);
    else if (type === 'box') ops.blur.box(+arg0, this);
    else if (type === 'gaussian') ops.blur.gaussian(+arg0, this);

    else throw new RangeError('invalid blur type');

    return this;
  }

  fill(color) {
    const type = typeof color;
    if (type === 'function') ops.fill.fn(color, this);
    else if (type === 'number') ops.fill.color(color, this);
    else if (color instanceof Color) ops.fill.color(color.valueOf(), this);
    else if (Array.isArray(color)) ops.fill.color(ops.color.from_rgba(...color), this);

    else throw new TypeError('invalid fill color');

    return this;
  }

  swap(old, color) {
    const ot = typeof old;
    const nt = typeof color;
    if (ot === nt && ot === 'number') ops.fill.swap(old, color, this);
    else if (old instanceof Color && color instanceof Color) ops.fill.swap(old.valueOf(), color.valueOf(), this);
    else if (Array.isArray(old) && Array.isArray(color)) ops.fill.swap(ops.color.from_rgba(...old), ops.color.from_rgba(...color), this);

    else throw new RangeError('invalid swap color');

    return this;
  }

  resize(type, width, height) {
    if (width === this.width && height === this.height) return this;
    else if (type === 'cubic') ops.resize.cubic(width, height, this);
    else if (type === 'linear') ops.resize.linear(width, height, this);
    else if (type === 'nearest') ops.resize.nearest(width, height, this);

    else throw new RangeError('invalid resize type');

    return this;
  }
}