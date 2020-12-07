const {readFile} = require('fs').promises;
const {join} = require('path');

let wasm;

let cachegetUint8Memory0 = null;

function getUint8Memory0() {
	if (cachegetUint8Memory0 === null || cachegetUint8Memory0.buffer !== wasm.memory.buffer) {
		cachegetUint8Memory0 = new Uint8Array(wasm.memory.buffer);
	}
	return cachegetUint8Memory0;
}

let WASM_VECTOR_LEN = 0;

function passArray8ToWasm0(arg, malloc) {
	const ptr = malloc(arg.length * 1);
	getUint8Memory0().set(arg, ptr / 1);
	WASM_VECTOR_LEN = arg.length;
	return ptr;
}

let cachegetInt32Memory0 = null;

function getInt32Memory0() {
	if (cachegetInt32Memory0 === null || cachegetInt32Memory0.buffer !== wasm.memory.buffer) {
		cachegetInt32Memory0 = new Int32Array(wasm.memory.buffer);
	}
	return cachegetInt32Memory0;
}

let cachegetUint32Memory0 = null;

function getUint32Memory0() {
	if (cachegetUint32Memory0 === null || cachegetUint32Memory0.buffer !== wasm.memory.buffer) {
		cachegetUint32Memory0 = new Uint32Array(wasm.memory.buffer);
	}
	return cachegetUint32Memory0;
}

function getArrayU32FromWasm0(ptr, len) {
	return getUint32Memory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
	return getUint8Memory0().subarray(ptr / 1, ptr / 1 + len);
}

module.exports = {
	/**
	 * @param {number} ptr
	 * @param {Uint8Array} buffer
	 * @returns {number}
	 */
	async decode(ptr, buffer) {
		if (!wasm) {
			const module = new WebAssembly.Module(await readFile(join(__dirname, './tiff.wasm')));
			const instance = new WebAssembly.Instance(module);
			wasm = instance.exports;
		}

		const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
		return wasm.decode(ptr, ptr0, WASM_VECTOR_LEN);
	},
	/**
	 * @param {number} id
	 * @returns {Uint32Array}
	 */
	meta(id) {
		try {
			const retptr = wasm.__wbindgen_export_1.value - 16;
			wasm.__wbindgen_export_1.value = retptr;
			wasm.meta(retptr, id);
			const r0 = getInt32Memory0()[retptr / 4];
			const r1 = getInt32Memory0()[retptr / 4 + 1];
			const v0 = getArrayU32FromWasm0(r0, r1).slice();
			wasm.__wbindgen_free(r0, r1 * 4);
			return v0;
		} finally {
			wasm.__wbindgen_export_1.value += 16;
		}
	},
	/**
	 * @param {number} id
	 * @returns {Uint8Array}
	 */
	buffer(id) {
		try {
			const retptr = wasm.__wbindgen_export_1.value - 16;
			wasm.__wbindgen_export_1.value = retptr;
			wasm.buffer(retptr, id);
			const r0 = getInt32Memory0()[retptr / 4];
			const r1 = getInt32Memory0()[retptr / 4 + 1];
			const v0 = getArrayU8FromWasm0(r0, r1).slice();
			wasm.__wbindgen_free(r0, r1 * 1);
			return v0;
		} finally {
			wasm.__wbindgen_export_1.value += 16;
		}
	},
	/**
	 * @param {number} id
	 */
	free(id) {
		wasm.free(id);
	}
}