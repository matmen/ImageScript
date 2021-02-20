const {version} = require('../../package.json');

let wasm;

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

function compress(buffer, level = 3) {
  const ptr = mem.alloc(buffer.length);
  mem.u8(ptr, buffer.length).set(buffer);
  return mem.copy_and_free(wasm.compress(ptr, buffer.length, level), mem.length());
}

function decompress(buffer, limit = 0) {
  const ptr = mem.alloc(buffer.length);
  mem.u8(ptr, buffer.length).set(buffer);
  const x = wasm.decompress(ptr, buffer.length, limit);
  if (0 === x) throw new Error('zlib: failed to decompress');

  return mem.copy_and_free(x, mem.length());
}

module.exports = {
  compress,
  decompress,

  async init() {
    if (wasm) return;
    const streaming = 'compileStreaming' in WebAssembly;
    const module = await WebAssembly[!streaming ? 'compile' : 'compileStreaming'](await fetch(`https://unpkg.com/imagescript@${version}/utils/wasm/zlib.wasm`).then(x => streaming ? x : x.arrayBuffer()));
    const instance = await WebAssembly.instantiate(module);

    wasm = instance.exports;
  }
}
