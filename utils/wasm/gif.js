const {version} = require('../../package.json');
let wasm;

let cachedTextDecoder = new TextDecoder('utf-8', {ignoreBOM: true, fatal: true});

cachedTextDecoder.decode();

let cachegetUint8Memory0 = null;

function getUint8Memory0() {
	if (cachegetUint8Memory0 === null || cachegetUint8Memory0.buffer !== wasm.memory.buffer) {
		cachegetUint8Memory0 = new Uint8Array(wasm.memory.buffer);
	}
	return cachegetUint8Memory0;
}

function getStringFromWasm0(ptr, len) {
	return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
}

let cachegetInt32Memory0 = null;

function getInt32Memory0() {
	if (cachegetInt32Memory0 === null || cachegetInt32Memory0.buffer !== wasm.memory.buffer) {
		cachegetInt32Memory0 = new Int32Array(wasm.memory.buffer);
	}
	return cachegetInt32Memory0;
}

function getArrayU8FromWasm0(ptr, len) {
	return getUint8Memory0().subarray(ptr / 1, ptr / 1 + len);
}

let WASM_VECTOR_LEN = 0;

function passArray8ToWasm0(arg, malloc) {
	const ptr = malloc(arg.length * 1);
	getUint8Memory0().set(arg, ptr / 1);
	WASM_VECTOR_LEN = arg.length;
	return ptr;
}

class GIFEncoder {
	free() {
		wasm.__wbg_gif_encoder_free(this.ptr);
	}

	/**
	 * @param {number} width
	 * @param {number} height
	 * @param {number} repeat
	 */
	static async initialize(width, height, repeat) {
		if (!wasm) {
			const { instance } = await WebAssembly.instantiate(await fetch(`https://unpkg.com/imagescript@${version}/utils/wasm/gif.wasm`.then(r => r.arrayBuffer())), {
				__wbindgen_placeholder__: {
					__wbindgen_throw: function (arg0, arg1) {
						throw new Error(getStringFromWasm0(arg0, arg1));
					}
				}
			});
			wasm = instance.exports;
		}

		const ret = wasm.gif_encoder_new(width, height, repeat);
		return new GIFEncoder(ret);
	}

	constructor(ptr) {
		this.ptr = ptr;
	}

	/**
	 * @returns {Uint8Array}
	 */
	buffer() {
		try {
			const retptr = wasm.__wbindgen_export_0.value - 16;
			wasm.__wbindgen_export_0.value = retptr;
			wasm.gif_encoder_buffer(retptr, this.ptr);
			const r0 = getInt32Memory0()[retptr / 4];
			const r1 = getInt32Memory0()[retptr / 4 + 1];
			const v0 = getArrayU8FromWasm0(r0, r1).slice();
			wasm.__wbindgen_free(r0, r1 * 1);
			return v0;
		} finally {
			wasm.__wbindgen_export_0.value += 16;
		}
	}

	/**
	 * @param {number} delay
	 * @param {number} quality
	 * @param {Uint8Array} buffer
	 */
	add(delay, quality, buffer) {
		const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
		wasm.gif_encoder_add(this.ptr, delay, quality, ptr0, WASM_VECTOR_LEN);
	}
}

module.exports = {GIFEncoder};
