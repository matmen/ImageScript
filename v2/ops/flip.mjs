export function horizontal(framebuffer) {
  let offset = 0 | 0;
  const u32 = framebuffer.u32;
  const width = framebuffer.width | 0;
  const height = framebuffer.height | 0;

  for (let y = 0 | 0; y < height; y++) {
    u32.subarray(offset, offset += width).reverse();
  }
}

export function vertical(framebuffer) {
  const u32 = framebuffer.u32;
  const width = framebuffer.width | 0;
  const oheight = framebuffer.height | 0;
  const height = (framebuffer.height / 2) | 0;

  for (let y = 0 | 0; y < height; y++) {
    const yo = y * width | 0;
    const wo1y = width * (oheight - 1 - y) | 0;

    for (let x = 0 | 0; x < width; x++) {
      const offset = x + yo;
      const offset2 = x + wo1y;

      const top = u32[offset];
      const bottom = u32[offset2];

      u32[offset2] = top;
      u32[offset] = bottom;
    }
  }
}