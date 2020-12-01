let wasm;

{
    const module = new WebAssembly.Module(await fetch('https://github.com/matmen/ImageScript/raw/deno/utils/wasm/jpeg.wasm').then(r => r.arrayBuffer()));
    const instance = new WebAssembly.Instance(module);

    wasm = instance.exports;
}

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

let cachegetUint16Memory0 = null;

function getUint16Memory0() {
    if (cachegetUint16Memory0 === null || cachegetUint16Memory0.buffer !== wasm.memory.buffer) {
        cachegetUint16Memory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachegetUint16Memory0;
}

function getArrayU16FromWasm0(ptr, len) {
    return getUint16Memory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    return getUint8Memory0().subarray(ptr / 1, ptr / 1 + len);
}

/**
 * @param {number} ptr
 * @param {Uint8Array} buffer
 * @param {number} _width
 * @param {number} _height
 * @returns {number}
 */
export async function decode(ptr, buffer, _width, _height) {
    wasm = await wasm;
    const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
    return wasm.decode(ptr, ptr0, WASM_VECTOR_LEN, _width, _height);
}

/**
 * @param {number} id
 * @returns {Uint16Array}
 */
export function meta(id) {
    try {
        const retptr = wasm.__wbindgen_export_1.value - 16;
        wasm.__wbindgen_export_1.value = retptr;
        wasm.meta(retptr, id);
        const r0 = getInt32Memory0()[retptr / 4];
        const r1 = getInt32Memory0()[retptr / 4 + 1];
        const v0 = getArrayU16FromWasm0(r0, r1).slice();
        wasm.__wbindgen_free(r0, r1 * 2);
        return v0;
    } finally {
        wasm.__wbindgen_export_1.value += 16;
    }
}

/**
 * @param {number} id
 * @returns {Uint8Array}
 */
export function buffer(id) {
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
}

/**
 * @param {number} id
 */
export function free(id) {
    wasm.free(id);
}
