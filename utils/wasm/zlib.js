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
    let i32array_ref = new Int32Array(wasm.memory.buffer);

    function u8array() {
        return u8array_ref.buffer === wasm.memory.buffer ? u8array_ref : (u8array_ref = new Uint8Array(wasm.memory.buffer));
    }

    function i32array() {
        return i32array_ref.buffer === wasm.memory.buffer ? i32array_ref : (i32array_ref = new Int32Array(wasm.memory.buffer));
    }

    function ptr_to_u8array(ptr, len) {
        return u8array().subarray(ptr, ptr + len);
    }

    function u8array_to_ptr(buffer) {
        const ptr = wasm.__wbindgen_malloc(buffer.length);
        u8array().set(buffer, ptr);
        return ptr;
    }

    return {
        compress(buffer, level) {
            const ptr = u8array_to_ptr(buffer);
            wasm.compress(8, ptr, buffer.length, level);

            const i32 = i32array();
            const slice = ptr_to_u8array(i32[2], i32[3]).slice();
            wasm.__wbindgen_free(i32[2], i32[3]);
            return slice;
        }, decompress(buffer, limit) {
            const ptr = u8array_to_ptr(buffer);

            try {
                wasm.decompress(8, ptr, buffer.length, limit);

                const i32 = i32array();
                const slice = ptr_to_u8array(i32[2], i32[3]).slice();
                wasm.__wbindgen_free(i32[2], i32[3]);
                return slice;
            } catch {
                wasm.__wbindgen_free(ptr, buffer.length);
                throw new Error('zlib: panic');
            }
        }
    };
}

module.exports = {
    async compress(buffer, level) {
        const {compress} = module.exports = await load();

        return compress(buffer, level);
    },
    async decompress(buffer, limit) {
        const {decompress} = module.exports = await load();

        return decompress(buffer, limit);
    }
};