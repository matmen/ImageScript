const {join} = require('path');
const {promises: {readFile}} = require('fs');

let u8array_ref, i32array_ref, u32array_ref;

let wasm = new Promise(async resolve => {
    const module = new WebAssembly.Module(await readFile(join(__dirname, './font.wasm')));
    const instance = new WebAssembly.Instance(module);
    const wasm = instance.exports;

    u8array_ref = new Uint8Array(wasm.memory.buffer);
    i32array_ref = new Int32Array(wasm.memory.buffer);
    u32array_ref = new Uint32Array(wasm.memory.buffer);

    resolve(wasm);
});

const utf8encoder = new TextEncoder();

function u8array() {
    return u8array_ref.buffer === wasm.memory.buffer ? u8array_ref : (u8array_ref = new Uint8Array(wasm.memory.buffer));
}

function i32array() {
    return i32array_ref.buffer === wasm.memory.buffer ? i32array_ref : (i32array_ref = new Int32Array(wasm.memory.buffer));
}

function u32array() {
    return u32array_ref.buffer === wasm.memory.buffer ? u32array_ref : (u32array_ref = new Uint32Array(wasm.memory.buffer));
}

function ptr_to_u8array(ptr, len) {
    return u8array().subarray(ptr, ptr + len);
}

function ptr_to_u32array(ptr, len) {
    return u32array().subarray(ptr / 4, ptr / 4 + len);
}

function u8array_to_ptr(buffer) {
    const ptr = wasm.__wbindgen_malloc(buffer.length);
    u8array().set(buffer, ptr);

    return ptr;
}

function string_to_ptr(string) {
    let offset = 0;
    let len = string.length;
    let ptr = wasm.__wbindgen_malloc(string.length);

    const u8 = u8array();
    while (len > offset) {
        const code = string.charCodeAt(offset);

        if (code > 0x7F) break;
        u8[ptr + offset++] = code;
    }

    if (offset !== len) {
        if (offset !== 0) string = string.substring(offset);
        ptr = wasm.__wbindgen_realloc(ptr, len, len = offset + string.length * 3);
        const ret = utf8encoder.encodeInto(string, u8array().subarray(ptr + offset, ptr + len));

        offset += ret.written;
    }

    return [ptr, offset];
}

const nullish = x => x == null;

module.exports = {
    render(ptr, id, scale, r, g, b, text, max_width, wrap_style = false) {
        const str = string_to_ptr(text);
        wasm.render(ptr, id, scale, r, g, b, str[0], str[1], !nullish(max_width), max_width || 0, wrap_style);
    },
    buffer(id) {
        wasm.buffer(8, id);
        const i32 = i32array();
        const slice = ptr_to_u8array(i32[2], i32[3]).slice();
        wasm.__wbindgen_free(i32[2], i32[3]);

        return slice;
    },
    meta(id) {
        wasm.meta(8, id);
        const i32 = i32array();
        const slice = ptr_to_u32array(i32[2], i32[3]).slice();
        wasm.__wbindgen_free(i32[2], 4 * i32[3]);

        return slice;
    },
    async load(id, buffer, scale = 128) {
        wasm = await wasm;
        wasm.load(id, u8array_to_ptr(buffer), buffer.length, scale);
    },
    free(id) {
        wasm.free(id);
    }
}