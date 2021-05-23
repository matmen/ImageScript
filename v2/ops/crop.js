export function cut(x, y, width, height, framebuffer) {
  const frame = new framebuffer.constructor(width, height);

  for (let yy = 0; yy < height; yy++) {
    const offset = x + (y + yy) * framebuffer.width;
    frame.u32.set(framebuffer.u32.subarray(offset, width + offset), yy * width);
  }

  return frame;
}

export function crop(x, y, width, height, framebuffer) {
  const old = framebuffer.u32;
  framebuffer.u32 = new Uint32Array(width * height);

  for (let yy = 0; yy < height; yy++) {
    const offset = x + (y + yy) * framebuffer.width;
    framebuffer.u32.set(old.subarray(offset, width + offset), yy * width);
  }

  framebuffer.width = width;
  framebuffer.height = height;
  framebuffer.u8 = new Uint8Array(framebuffer.u32.buffer);
  framebuffer.view = new DataView(framebuffer.u32.buffer);
}

export function circle(feathering, framebuffer) {
  const rad = Math.min(framebuffer.width, framebuffer.height) / 2;

  const rad_2 = rad ** 2;
  const cx = framebuffer.width / 2;
  const cy = framebuffer.height / 2;
  const feathering_12 = feathering ** (1 / 2);

  for (let y = 0; y < framebuffer.height; y++) {
    const cdy = (y - cy) ** 2;
    const y_offset = y * framebuffer.width;

    for (let x = 0; x < framebuffer.width; x++) {
      const cd = cdy + (x - cx) ** 2;
      const offset = 3 + 4 * (x + y_offset);

      if (cd > rad_2) framebuffer.u8[offset] = 0;
      else if (feathering) framebuffer.u8[offset] *= Math.max(0, Math.min(1, 1 - (cd / rad_2) * feathering_12));
    }
  }

  return framebuffer;
}