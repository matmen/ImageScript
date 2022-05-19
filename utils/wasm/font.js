let registry;
let wasm_mod;
let ref = { deref() {} };

{
  const path = new URL(import.meta.url.replace('.js', '.wasm'));
  wasm_mod = new WebAssembly.Module(await ('file:' === path.protocol ? Deno.readFile(path) : fetch(path).then(r => r.arrayBuffer())));
}

function wasm() {
  return ref.deref() || (ref = new WeakRef(new WebAssembly.Instance(wasm_mod).exports)).deref();
}

class mem {
  static length() { return wasm().wlen(); }
  static alloc(size) { return wasm().walloc(size); }
  static free(ptr, size) { return wasm().wfree(ptr, size); }
  static u8(ptr, size) { return new Uint8Array(wasm().memory.buffer, ptr, size); }
  static u32(ptr, size) { return new Uint32Array(wasm().memory.buffer, ptr, size); }

  static copy_and_free(ptr, size) {
    let slice = mem.u8(ptr, size).slice();
    return (wasm().wfree(ptr, size), slice);
  }
}

const decode_utf8 = globalThis.Deno?.core?.decode ?? TextDecoder.prototype.decode.bind(new TextDecoder);
const encode_utf8 = globalThis.Deno?.core?.encode ?? globalThis.Buffer?.from.bind(globalThis.Buffer) ?? TextEncoder.prototype.encode.bind(new TextEncoder);

if ('FinalizationRegistry' in globalThis) {
  registry = new FinalizationRegistry(([t, ptr]) => {
    if (!ref.deref()) return;
    if (t === 0) wasm().font_free(ptr);
    if (t === 1) wasm().layout_free(ptr);
  });
}

export class Font {
  constructor(scale, buffer) {
    this._w = wasm();
    this.scale = scale;
    const ptr = mem.alloc(buffer.length);
    mem.u8(ptr, buffer.length).set(buffer);
    this.ptr = wasm().font_new(ptr, buffer.length, scale);

    if (!this.ptr) throw new Error('invalid font');
    if (registry) registry.register(this, [0, this.ptr], this);
  }

  free() {
    this.ptr = wasm().font_free(this.ptr);
    if (registry) registry.unregister(this);
  }

  has(char) {
    return wasm().font_has(this.ptr, String.prototype.charCodeAt.call(char, 0));
  }

  metrics(char, scale = this.scale) {
    const ptr = wasm().font_metrics(this.ptr, String.prototype.charCodeAt.call(char, 0), scale);
    const metrics = JSON.parse(decode_utf8(mem.u8(wasm().font_metrics_buffer(ptr), mem.length())));

    return (wasm().font_metrics_free(ptr), metrics);
  }

  rasterize(char, scale = this.scale) {
    const ptr = wasm().font_rasterize(this.ptr, String.prototype.charCodeAt.call(char, 0), scale);

    const glyph = {
      buffer: mem.u8(wasm().font_rasterize_buffer(ptr), mem.length()).slice(),
      metrics: JSON.parse(decode_utf8(mem.u8(wasm().font_rasterize_metrics(ptr), mem.length()))),
    }

    return (wasm().font_rasterize_free(ptr), glyph);
  }
}

export class Layout {
  constructor() {
    this._w = wasm();
    if (registry) this.refs = [];
    this.ptr = wasm().layout_new();
    if (registry) registry.register(this, [1, this.ptr], this);
  }

  clear() {
    wasm().layout_clear(this.ptr);
    if (registry) this.refs.length = 0;
  }

  lines() {
    return wasm().layout_lines(this.ptr);
  }

  free() {
    if (registry) this.refs.length = 0;
    this.ptr = wasm().layout_free(this.ptr);
    if (registry) registry.unregister(this);
  }

  reset(options = {}) {
    options = encode_utf8(JSON.stringify(options));

    if (registry) this.refs.length = 0;
    const ptr = mem.alloc(options.length);
    mem.u8(ptr, options.length).set(options);
    wasm().layout_reset(this.ptr, ptr, options.length);
  }

  append(font, text, init) {
    text = encode_utf8(text);
    const options = init || {};
    if (registry) this.refs.push(font);
    const ptr = mem.alloc(text.length);
    mem.u8(ptr, text.length).set(text);
    const has_color = ('r' in options) || ('g' in options) || ('b' in options);
    wasm().layout_append(this.ptr, font.ptr, ptr, text.length, options.scale ?? font.scale, has_color, options.r, options.g, options.b);
  }

  rasterize(r, g, b) {
    const ptr = wasm().layout_rasterize(this.ptr, r, g, b);

    const framebuffer = {
      width: wasm().layout_rasterize_width(ptr),
      height: wasm().layout_rasterize_height(ptr),
      buffer: mem.u8(wasm().layout_rasterize_buffer(ptr), mem.length()).slice(),
    }

    return (wasm().layout_rasterize_free(ptr), framebuffer);
  }
}