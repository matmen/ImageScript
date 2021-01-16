const {version} = require('../../package.json');

let wasm;
const streams = new Map;

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

class Encoder {
  constructor(width, height, loops = -1) {
    this.slices = [];
    streams.set(0, this);
    this.ptr = wasm.encoder_new(0, width, height, loops);
  }

  cb(buffer) { this.slices.push(buffer); }
  free() { this.ptr = wasm.encoder_free(this.ptr); }

  u8() {
    this.free();
    let offset = 0;
    const u8 = new Uint8Array(this.slices.reduce((sum, array) => sum + array.length, 0));

    for (const x of this.slices) {
      u8.set(x, offset);
      offset += x.length;
    }

    return u8;
  }

  add(delay, width, height, buffer, quality) {
    const ptr = mem.alloc(buffer.length);
    mem.u8(ptr, buffer.length).set(buffer);
    wasm.encoder_add(this.ptr, ptr, buffer.length, width, height, delay, quality);
  }
}

class Decoder {
  constructor(buffer, limit = 0) {
    const bptr = mem.alloc(buffer.length);
    mem.u8(bptr, buffer.length).set(buffer);
    this.ptr = wasm.decoder_new(bptr, buffer.length, limit);
    if (0 === this.ptr) throw new Error('gif: failed to parse gif header');

    this.width = wasm.decoder_width(this.ptr);
    this.height = wasm.decoder_height(this.ptr);
  }

  free() {
    this.ptr = wasm.decoder_free(this.ptr);
  }

  *frames() {
    let frame;
    while (frame = this.frame()) yield frame;

    this.free();
  }

  frame() {
    const ptr = wasm.decoder_frame(this.ptr);

    if (1 === ptr) return null;
    if (0 === ptr) throw (this.free(), new Error('gif: failed to decode frame'));

    const framebuffer = {
      delay: wasm.decoder_frame_delay(ptr),
      width: wasm.decoder_frame_width(ptr),
      height: wasm.decoder_frame_height(ptr),
      buffer: mem.u8(wasm.decoder_frame_buffer(ptr), mem.length()).slice(),
    };

    return (wasm.decoder_frame_free(ptr), framebuffer);
  }
}

module.exports = {
  Encoder,
  Decoder,

  async init() {
		if (wasm) return;
		const streaming = 'compileStreaming' in WebAssembly;
		const module = await WebAssembly[!streaming ? 'compile' : 'compileStreaming'](await fetch(`https://unpkg.com/imagescript@${version}/utils/wasm/gif.wasm`).then(x => streaming ? x : x.arrayBuffer()));
    const instance = new WebAssembly.Instance(module, {
      env: {
        push_to_stream(id, ptr) {
          streams.get(id).cb(mem.u8(ptr, mem.length()).slice());
        },
      },
    });
  
    wasm = instance.exports;
  }
}