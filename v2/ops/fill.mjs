export function color(int, framebuffer) {
  framebuffer.view.setUint32(0, int);
  framebuffer.u32.fill(framebuffer.u32[0]);
}

export function fn(cb, framebuffer) {
  let offset = 0 | 0;
  const view = framebuffer.view;
  const width = framebuffer.width | 0;
  const height = framebuffer.height | 0;

  for (let y = 1 | 0; y <= height; y++) {
    for (let x = 1 | 0; x <= width; x++) {
      view.setUint32(offset, cb(x, y), false); offset += 4;
    }
  }
}

export function swap(old, int, framebuffer) {
  {
    const t = new Uint32Array(2);
    const v = new DataView(t.buffer);
    old = (v.setUint32(0, old), t[0]);
    int = (v.setUint32(4, int), t[1]);
  }

  const u32 = framebuffer.u32;
  const l = framebuffer.u32.length | 0;

  for (let o = 0 | 0; o < l; o++) {
    if (old === u32[o]) u32[o] = int;
  }
}