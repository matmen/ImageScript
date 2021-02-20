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

function decode(buffer) {
	const bptr = mem.alloc(buffer.length);
	mem.u8(bptr, buffer.length).set(buffer);
	const ptr = wasm.decode(bptr, buffer.length);
	if (0 === ptr) throw new Error('tiff: failed to decode');

	const framebuffer = {
		width: wasm.decode_width(ptr),
		height: wasm.decode_height(ptr),
		buffer: mem.u8(wasm.decode_buffer(ptr), mem.length()).slice(),
	}

	return (wasm.decode_free(ptr), framebuffer);
}

module.exports = {
	decode,

	async init() {
		if (wasm) return;
		const streaming = 'compileStreaming' in WebAssembly;
		const module = await WebAssembly[!streaming ? 'compile' : 'compileStreaming'](await fetch(`https://unpkg.com/imagescript@${version}/utils/wasm/tiff.wasm`).then(x => streaming ? x : x.arrayBuffer()));
		const instance = await WebAssembly.instantiate(module);

		wasm = instance.exports;
	}
}
