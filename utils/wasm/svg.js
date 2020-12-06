const {readFile} = require('fs').promises;
const {join} = require('path');

let wasm;

let WASM_VECTOR_LEN = 0;

let cachegetUint8Memory0 = null;

function getUint8Memory0() {
    if (cachegetUint8Memory0 === null || cachegetUint8Memory0.buffer !== wasm.memory.buffer) {
        cachegetUint8Memory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachegetUint8Memory0;
}

let cachedTextEncoder = new TextEncoder();

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
        return cachedTextEncoder.encodeInto(arg, view);
    }
    : function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    });

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const textEncoder = new TextEncoder();
        const buf = textEncoder.encode(arg);
        const ptr = malloc(buf.length);
        getUint8Memory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len);

    const mem = getUint8Memory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3);
        const view = getUint8Memory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
    }

    WASM_VECTOR_LEN = offset;
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
    return getUint8Memory0().subarray(ptr, ptr + len);
}

module.exports = {
    /**
     * @param {number} ptr
     * @param {string} svg
     * @param {number} fit_kind
     * @param {number} zoom
     * @param {number} width
     * @param {number} height
     * @returns {number}
     */
    async rgba(ptr, svg, fit_kind, zoom, width, height) {
        const module = new WebAssembly.Module(await readFile(join(__dirname, './svg.wasm')));
        const instance = new WebAssembly.Instance(module);
        wasm = instance.exports;

        const ptr0 = passStringToWasm0(svg, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        return wasm.rgba(ptr, ptr0, WASM_VECTOR_LEN, fit_kind, zoom, width, height);
    },
    /**
     * @param {number} id
     * @returns {Uint32Array}
     */
    meta(id) {
        try {
            const retptr = wasm.__wbindgen_export_2.value - 16;
            wasm.__wbindgen_export_2.value = retptr;
            wasm.meta(retptr, id);
            const r0 = getInt32Memory0()[retptr / 4];
            const r1 = getInt32Memory0()[retptr / 4 + 1];
            const v0 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 4);
            return v0;
        } finally {
            wasm.__wbindgen_export_2.value += 16;
        }
    },
    /**
     * @param {number} id
     * @returns {Uint8Array}
     */
    buffer(id) {
        try {
            const retptr = wasm.__wbindgen_export_2.value - 16;
            wasm.__wbindgen_export_2.value = retptr;
            wasm.buffer(retptr, id);
            const r0 = getInt32Memory0()[retptr / 4];
            const r1 = getInt32Memory0()[retptr / 4 + 1];
            const v0 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1);
            return v0;
        } finally {
            wasm.__wbindgen_export_2.value += 16;
        }
    },
    /**
     * @param {number} id
     */
    free(id) {
        wasm.free(id);
    }
};