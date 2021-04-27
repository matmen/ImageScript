const { join } = require('path');
const { promises: { readFile } } = require('fs');

let mod = null;
module.exports = {
  async init() {
    if (!mod) mod = new WebAssembly.Module(await readFile(join(__dirname, './jpeg.wasm')));

    return this.new();
  },

  new() {
    const wasm = new WebAssembly.Instance(mod).exports;

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

    function decode(buffer, width, height) {
      const bptr = mem.alloc(buffer.length);
      mem.u8(bptr, buffer.length).set(buffer);
      const ptr = wasm.decode(bptr, buffer.length, width, height);

      if (0 === ptr) throw new Error('jpg: failed to decode');
      if (1 === ptr) throw new Error('jpg: failed to scale decoder');

      const framebuffer = {
        width: wasm.decode_width(ptr),
        height: wasm.decode_height(ptr),
        format: wasm.decode_format(ptr),
        buffer: mem.u8(wasm.decode_buffer(ptr), mem.length()).slice(),
      }

      return (wasm.decode_free(ptr), framebuffer);
    }

    return { decode };
  }
}