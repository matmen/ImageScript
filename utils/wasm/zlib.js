let wasm;

{
    const module = new WebAssembly.Module(await Deno.readFile('./utils/wasm/zlib.wasm'));
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

export function compress(buffer, level) {
    const ptr = u8array_to_ptr(buffer);
    wasm.compress(8, ptr, buffer.length, level);

    const i32 = i32array();
    const slice = ptr_to_u8array(i32[2], i32[3]).slice();
    wasm.__wbindgen_free(i32[2], i32[3]);
    return slice;
}

export function compress_raw(buffer, level) {
    const ptr = u8array_to_ptr(buffer);
    wasm.compress_raw(8, ptr, buffer.length, level);

    const i32 = i32array();
    const slice = ptr_to_u8array(i32[2], i32[3]).slice();
    wasm.__wbindgen_free(i32[2], i32[3]);
    return slice;
}

export function decompress(buffer, limit) {
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

export function decompress_raw(buffer, limit) {
    const ptr = u8array_to_ptr(buffer);

    try {
        wasm.decompress_raw(8, ptr, buffer.length, limit);

        const i32 = i32array();
        const slice = ptr_to_u8array(i32[2], i32[3]).slice();
        wasm.__wbindgen_free(i32[2], i32[3]);
        return slice;
    } catch {
        wasm.__wbindgen_free(ptr, buffer.length);
        throw new Error('zlib: panic');
    }
}

export function decompress_with(buffer, limit, transform) {
    const ptr = u8array_to_ptr(buffer);

    try {
        wasm.decompress(8, ptr, buffer.length, limit);

        const i32 = i32array();
        const slice = ptr_to_u8array(i32[2], i32[3]);

        try {
            const value = transform(slice);
            wasm.__wbindgen_free(i32[2], i32[3]);
            return value;
        } catch (err) {
            wasm.__wbindgen_free(i32[2], i32[3]);
            throw err;
        }
    } catch {
        wasm.__wbindgen_free(ptr, buffer.length);
        throw new Error('zlib: panic');
    }
}

export function decompress_raw_with(buffer, limit, transform) {
    const ptr = u8array_to_ptr(buffer);

    try {
        wasm.decompress_raw(8, ptr, buffer.length, limit);

        const i32 = i32array();
        const slice = ptr_to_u8array(i32[2], i32[3]);

        try {
            const value = transform(slice);
            wasm.__wbindgen_free(i32[2], i32[3]);
            return value;
        } catch (err) {
            wasm.__wbindgen_free(i32[2], i32[3]);
            throw err;
        }
    } catch {
        wasm.__wbindgen_free(ptr, buffer.length);
        throw new Error('zlib: panic');
    }
}
