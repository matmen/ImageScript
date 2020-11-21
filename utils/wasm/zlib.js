/* global WebAssembly */
const {join} = require('path');
const {promises: {readFile}} = require('fs');

async function load() {
    let wasm;

    {
        const module = new WebAssembly.Module(await readFile(join(__dirname, './zlib.wasm')));
        const instance = new WebAssembly.Instance(module);

        wasm = instance.exports;
    }

    let u8array_ref = new Uint8Array(wasm.memory.buffer);

    function u8array() {
        return u8array_ref.buffer === wasm.memory.buffer ? u8array_ref : (u8array_ref = new Uint8Array(wasm.memory.buffer));
    }

    function ptr_to_u8array(ptr, len) {
        return u8array().subarray(ptr, ptr + len);
    }

    return function compress(buffer, level) {
        const ptr = wasm.__wbindgen_malloc(buffer.length);

        u8array().set(buffer, ptr);
        wasm.compress(8, ptr, buffer.length, level);
        const i32 = new Int32Array(wasm.memory.buffer, 8, 2);
        const slice = ptr_to_u8array(i32[0], i32[1]).slice();
        wasm.__wbindgen_free(i32[0], i32[1]);
        return slice;
    };
}

module.exports = {
    async compress(buffer, level) {
        const fn = module.exports.compress = await load();

        return fn(buffer, level);
    }
};