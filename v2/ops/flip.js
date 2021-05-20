export function horizontal(framebuffer) {
  for (let y = 0; y < framebuffer.height; y++) {
    const offset = y * framebuffer.width;
    framebuffer.u32.subarray(offset, offset + framebuffer.width).reverse();
  }
}

export function vertical(framebuffer) {
  const u32 = framebuffer.u32;
  const width = framebuffer.width;
  const oheight = framebuffer.height;
  const height = ~~(framebuffer.height / 2);

  for (let y = 0; y < height; y++) {
    const wo1y = width * (oheight - 1 - y);

    for (let x = 0; x < width; x++) {
      const offset2 = x + wo1y;
      const offset = x + y * width;

      const top = u32[offset];
      const bottom = u32[offset2];

      u32[offset2] = top;
      u32[offset] = bottom;
    }
  }
}