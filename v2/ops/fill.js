export function color(int, framebuffer) {
  framebuffer.view.setUint32(0, int);
  framebuffer.u32.fill(framebuffer.u32[0]);
}

export function fn(cb, framebuffer) {
  let offset = 0;
  const view = framebuffer.view;
  for (let y = 1; y <= framebuffer.height; y++) {
    for (let x = 1; x <= framebuffer.width; x++) {
      view.setUint32(offset, cb(x, y), false); offset += 4;
    }
  }
}