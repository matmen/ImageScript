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