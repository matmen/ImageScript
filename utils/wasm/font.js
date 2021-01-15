const {join} = require('path');
const {promises: {readFile}} = require('fs');

let wasm;
let registry = null;

class mem {
  static alloc(size) { return wasm.walloc(size); }
  static free(ptr, size) { return wasm.wfree(ptr, size); }
  static u8(ptr, size) { return new Uint8Array(wasm.memory.buffer, ptr, size); }
  static u32(ptr, size) { return new Uint32Array(wasm.memory.buffer, ptr, size); }
  static length() { return new Uint32Array(wasm.memory.buffer, wasm.cur_len.value, 1)[0]; }

  static copy_and_free(ptr, size) {
    let slice = mem.u8(ptr, size).slice();
    return (wasm.wfree(ptr, size), slice);
  }
}

const encode_utf8 = 'Deno' in globalThis ? Deno.core.encode : (() => {
  const encoder = new TextEncoder();
  return string => encoder.encode(string);
})();

const decode_utf8 = 'Deno' in globalThis ? Deno.core.decode : (() => {
  const decoder = new TextDecoder();
  return buffer => decoder.decode(buffer);
})();

if ('FinalizationRegistry' in globalThis) {
  registry = new FinalizationRegistry(([t, ptr]) => {
    if (t === 0) wasm.font_free(ptr);
    if (t === 1) wasm.layout_free(ptr);
  });
}

class Font {
  constructor(scale, buffer) {
    this.scale = scale;
    const ptr = mem.alloc(buffer.length);
    mem.u8(ptr, buffer.length).set(buffer);
    this.ptr = wasm.font_new(ptr, buffer.length, scale);

    if (!this.ptr) throw new Error('invalid font');
    if (registry) registry.register(this, [0, this.ptr]);
  }

  free() {
    this.ptr = wasm.font_free(this.ptr);
    if (registry) registry.unregister(this);
  }

  has(char) {
    return wasm.font_has(this.ptr, String.prototype.charCodeAt.call(char, 0));
  }

  metrics(char, scale = this.scale) {
    const ptr = wasm.font_metrics(this.ptr, String.prototype.charCodeAt.call(char, 0), scale);
    const metrics = JSON.parse(decode_utf8(mem.u8(wasm.font_metrics_buffer(ptr), mem.length())));

    return (wasm.font_metrics_free(ptr), metrics);
  }

  rasterize(char, scale = this.scale) {
    const ptr = wasm.font_rasterize(this.ptr, String.prototype.charCodeAt.call(char, 0), scale);

    const glyph = {
      buffer: mem.u8(wasm.font_rasterize_buffer(ptr), mem.length()).slice(),
      metrics: JSON.parse(decode_utf8(mem.u8(wasm.font_rasterize_metrics(ptr), mem.length()))),
    }

    return (wasm.font_rasterize_free(ptr), glyph);
  }
}

class Layout {
  constructor() {
    this.ptr = wasm.layout_new();
    if (registry) this.refs = [];
    if (registry) registry.register(this, [1, this.ptr]);
  }

  clear() {
    wasm.layout_clear(this.ptr);
    if (registry) this.refs.length = 0;
  }

  lines() {
    return wasm.layout_lines(this.ptr);
  }

  free() {
    if (registry) this.refs.length = 0;
    this.ptr = wasm.layout_free(this.ptr);
    if (registry) registry.unregister(this);
  }

  reset(options = {}) {
    options = encode_utf8(JSON.stringify(options));

    if (registry) this.refs.length = 0;
    const ptr = mem.alloc(options.length);
    mem.u8(ptr, options.length).set(options);
    wasm.layout_reset(this.ptr, ptr, options.length);
  }

  append(font, text, scale) {
    text = encode_utf8(text);
    if (registry) this.refs.push(font);
    const ptr = mem.alloc(text.length);
    mem.u8(ptr, text.length).set(text);
    wasm.layout_append(this.ptr, font.ptr, ptr, text.length, null != scale ? scale : font.scale);
  }

  rasterize(r, g, b) {
    const ptr = wasm.layout_rasterize(this.ptr, r, g, b);

    const framebuffer = {
      width: wasm.layout_rasterize_width(ptr),
      height: wasm.layout_rasterize_height(ptr),
      buffer: mem.u8(wasm.layout_rasterize_buffer(ptr), mem.length()).slice(),
    }

    return (wasm.layout_rasterize_free(ptr), framebuffer);
  }
}

module.exports = {
  Font,
  Layout,

  async init() {
    if (wasm) return;
    const module = new WebAssembly.Module(await readFile(join(__dirname, './font.wasm')));
    const instance = new WebAssembly.Instance(module);
  
    wasm = instance.exports;
  },
}