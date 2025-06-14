export const streams = new Map;

export function emscripten_notify_memory_growth(...args) { console.log(...args) }
export function push_to_stream(id, ptr) {
    const mem = streams.get(id).m;
    streams.get(id).cb(mem.u8(ptr, mem.length()).slice());
}