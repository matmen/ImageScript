let wasm_mod;
let ref = { deref() {} };

{
  const path = new URL(import.meta.url.replace('.js', '.wasm'));
  wasm_mod = new WebAssembly.Module(await ('file:' === path.protocol ? Deno.readFile(path) : fetch(path).then(r => r.arrayBuffer())));
}

function wasm() {
  return ref.deref() || (ref = new WeakRef(new WebAssembly.Instance(wasm_mod).exports)).deref();
}

class mem {
  static length() { return wasm().wlen(); }
  static alloc(size) { return wasm().walloc(size); }
  static free(ptr, size) { return wasm().wfree(ptr, size); }
  static u8(ptr, size) { return new Uint8Array(wasm().memory.buffer, ptr, size); }
  static u32(ptr, size) { return new Uint32Array(wasm().memory.buffer, ptr, size); }

  static copy_and_free(ptr, size) {
    let slice = mem.u8(ptr, size).slice();
    return (wasm().wfree(ptr, size), slice);
  }
}

export function encode(buffer, width, height, quality) {
  const _w = wasm();

  const ptr = mem.alloc(buffer.length);
  mem.u8(ptr, buffer.length).set(buffer);
  return mem.copy_and_free(wasm().encode(ptr, width, height, quality), mem.length());
}

export function decode(buffer, width, height) {
  const _w = wasm();

  const bptr = mem.alloc(buffer.length);
  mem.u8(bptr, buffer.length).set(buffer);
  const ptr = wasm().decode(bptr, buffer.length, width, height);

  if (0 === ptr) throw new Error('jpg: failed to decode');
  if (1 === ptr) throw new Error('jpg: failed to scale decoder');

  const framebuffer = {
    width: wasm().decode_width(ptr),
    height: wasm().decode_height(ptr),
    format: wasm().decode_format(ptr),
    buffer: mem.u8(wasm().decode_buffer(ptr), mem.length()).slice(),
  }

  return (wasm().decode_free(ptr), framebuffer);
}