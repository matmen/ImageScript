const wasm_name = 'gif';
const { join } = require('path');
const { promises: { readFile } } = require('fs');
const wasm_path = process.env.IMAGESCRIPT_WASM_SIMD ? 'simd' : 'any';

let mod = null;
module.exports = {
  async init() {
    if (!mod) mod = new WebAssembly.Module(await readFile(join(__dirname, `../${wasm_path}/${wasm_name}.wasm`)));

    return this.new();
  },

  new() {
    const wasm = new WebAssembly.Instance(mod, { env: { push_to_stream(id, ptr) { } } }).exports;

    class mem {
      static length() { return wasm.wlen(); }
      static alloc(size) { return wasm.walloc(size); }
      static free(ptr, size) { return wasm.wfree(ptr, size); }
      static u8(ptr, size) { return new Uint8Array(wasm.memory.buffer, ptr, size); }
      static u32(ptr, size) { return new Uint32Array(wasm.memory.buffer, ptr, size); }

      static copy_and_free(ptr, size) {
        let slice = mem.u8(ptr, size).slice();
        return (wasm.wfree(ptr, size), slice);
      }
    }

    function load(buffer) {
      return [...new Decoder(buffer).frames()];
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
      }

      frame() {
        const ptr = wasm.decoder_frame(this.ptr);

        if (1 === ptr) return null;
        if (0 === ptr) throw (this.free(), new Error('gif: failed to decode frame'));

        const framebuffer = {
          x: wasm.decoder_frame_x(ptr),
          y: wasm.decoder_frame_y(ptr),
          delay: wasm.decoder_frame_delay(ptr),
          width: wasm.decoder_frame_width(ptr),
          height: wasm.decoder_frame_height(ptr),
          dispose: wasm.decoder_frame_dispose(ptr),
          buffer: mem.u8(wasm.decoder_frame_buffer(ptr), mem.length()).slice(),
        };

        return (wasm.decoder_frame_free(ptr), framebuffer);
      }
    }

    return { load, Decoder };
  }
}
