export function *cords(framebuffer) {
  for (let y = 1; y <= framebuffer.height; y++) {
    for (let x = 1; x <= framebuffer.width; x++) yield [x, y];
  }
}

export function *rgba(framebuffer) {
  let offset = 0;
  const u8 = framebuffer.u8;
  for (let y = 1; y <= framebuffer.height; y++) {
    for (let x = 1; x <= framebuffer.width; x++) {
      yield [x, y, u8.subarray(offset, offset += 4)];
    }
  }
}

export function *u32(framebuffer) {
  let offset = 0;
  const view = framebuffer.view;
  for (let y = 1; y <= framebuffer.height; y++) {
    for (let x = 1; x <= framebuffer.width; x++) {
      yield [x, y, view.getUint32(offset, false)]; offset += 4;
    }
  }
}