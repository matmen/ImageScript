export function* cords(framebuffer) {
  const width = framebuffer.width | 0;
  const height = framebuffer.height | 0;

  for (let y = 0 | 0; y < height; y++) {
    for (let x = 0 | 0; x < width; x++) yield [x, y];
  }
}

export function* rgba(framebuffer) {
  let offset = 0 | 0;
  const u8 = framebuffer.u8;
  const width = framebuffer.width | 0;
  const height = framebuffer.height | 0;

  for (let y = 0 | 0; y < height; y++) {
    for (let x = 0 | 0; x < width; x++) {
      yield [x, y, u8.subarray(offset, offset += 4)];
    }
  }
}

export function* u32(framebuffer) {
  let offset = 0 | 0;
  const view = framebuffer.view;
  const width = framebuffer.width | 0;
  const height = framebuffer.height | 0;

  for (let y = 0 | 0; y < height; y++) {
    for (let x = 0 | 0; x < width; x++) {
      yield [x, y, view.getUint32(offset, false)]; offset += 4;
    }
  }
}