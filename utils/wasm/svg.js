const {join} = require('path');
const {promises: {readFile}} = require('fs');

let wasm;

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

function rasterize(buffer, fit, scale) {
    const bptr = mem.alloc(buffer.length);
    mem.u8(bptr, buffer.length).set(buffer);
    const ptr = wasm.rasterize(bptr, buffer.length, fit, scale);
  
    if (0 === ptr) throw new Error('svg: failed to parse');
    if (1 === ptr) throw new Error('svg: failed to rasterize');
  
    const framebuffer = {
      width: wasm.rasterize_width(ptr),
      height: wasm.rasterize_height(ptr),
      buffer: mem.u8(wasm.rasterize_buffer(ptr), mem.length()).slice(),
    }
  
    return (wasm.rasterize_free(ptr), framebuffer);
}

module.exports = {
    rasterize,

    async init() {
        if (wasm) return;
        const module = new WebAssembly.Module(await readFile(join(__dirname, './svg.wasm')));
        const instance = new WebAssembly.Instance(module);

        wasm = instance.exports;
    }
}