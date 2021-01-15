let wasm;

{
  const path = new URL(import.meta.url.replace('.js', '.wasm'));
  const module = new WebAssembly.Module(await ('file:' === path.protocol ? Deno.readFile(path) : fetch(path).then(r => r.arrayBuffer())));
  const instance = new WebAssembly.Instance(module);

  wasm = instance.exports;
}

class mem {
  static alloc(size) { return wasm.walloc(size); }
  static free(ptr, size) { return wasm.wfree(ptr, size); }
  static u8(ptr, size) { return new Uint8Array(wasm.memory.buffer, ptr, size); }
  static u32(ptr, size) { return new Uint32Array(wasm.memory.buffer, ptr, size); }
  static length() { return new Uint32Array(wasm.memory.buffer, wasm.cur_len.value, 1)[0]; }

  static copy_and_free(ptr, size) {
    let slice = mem.u8(ptr, size).slice();
    return (wasm.wfree(ptr, size), slice);
  }
}

export function compress(buffer, level = 3) {
  const ptr = mem.alloc(buffer.length);
  mem.u8(ptr, buffer.length).set(buffer);
  return mem.copy_and_free(wasm.compress(ptr, buffer.length, level), mem.length());
}

export function compress_raw(buffer, level = 3) {
  const ptr = mem.alloc(buffer.length);
  mem.u8(ptr, buffer.length).set(buffer);
  return mem.copy_and_free(wasm.compress_raw(ptr, buffer.length, level), mem.length());
}

export function decompress(buffer, limit = 0) {
  const ptr = mem.alloc(buffer.length);
  mem.u8(ptr, buffer.length).set(buffer);
  const x = wasm.decompress(ptr, buffer.length, limit);
  if (0 === x) throw new Error('zlib: failed to decompress');

  return mem.copy_and_free(x, mem.length());
}

export function decompress_raw(buffer, limit = 0) {
  const ptr = mem.alloc(buffer.length);
  mem.u8(ptr, buffer.length).set(buffer);
  const x = wasm.decompress_raw(ptr, buffer.length, limit);
  if (0 === x) throw new Error('zlib: failed to decompress (raw)');

  return mem.copy_and_free(x, mem.length());
}

export function decompress_with(buffer, limit = 0, transform) {
  const ptr = mem.alloc(buffer.length);
  mem.u8(ptr, buffer.length).set(buffer);
  const x = wasm.decompress(ptr, buffer.length, limit);
  if (0 === x) throw new Error('zlib: failed to decompress');

  const u8 = mem.u8(x, mem.length());

  const value = transform(u8);
  return (mem.free(x, u8.length), value);
}

export function decompress_raw_with(buffer, limit = 0, transform) {
  const ptr = mem.alloc(buffer.length);
  mem.u8(ptr, buffer.length).set(buffer);
  const x = wasm.decompress_raw(ptr, buffer.length, limit);
  if (0 === x) throw new Error('zlib: failed to decompress (raw)');

  const u8 = mem.u8(x, mem.length());

  const value = transform(u8);
  return (mem.free(x, u8.length), value);
}