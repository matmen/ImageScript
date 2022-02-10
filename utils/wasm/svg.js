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

export function rasterize(buffer, fit, scale) {
  const _w = wasm();

  const bptr = mem.alloc(buffer.length);
  mem.u8(bptr, buffer.length).set(buffer);
  const ptr = wasm().rasterize(bptr, buffer.length, fit, scale);

  if (0 === ptr) throw new Error('svg: failed to parse');
  if (1 === ptr) throw new Error('svg: failed to rasterize');

  const framebuffer = {
    width: wasm().rasterize_width(ptr),
    height: wasm().rasterize_height(ptr),
    buffer: mem.u8(wasm().rasterize_buffer(ptr), mem.length()).slice(),
  }

  return (wasm().rasterize_free(ptr), framebuffer);
}