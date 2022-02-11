function clamp(min, int, max) {
  const t = int < min ? min : int; return t > max ? max : t;
}

export function cut(x, y, width, height, framebuffer) {
  width |= 0;
  height |= 0;
  const frame = new framebuffer.constructor(width, height);

  const n32 = frame.u32;
  const o32 = framebuffer.u32;
  const fwidth = framebuffer.width | 0;

  for (let yy = 0 | 0; yy < height; yy++) {
    const offset = x + fwidth * (y + yy);
    n32.set(o32.subarray(offset, width + offset), yy * width);
  }

  return frame;
}

export function crop(x, y, width, height, framebuffer) {
  width |= 0;
  height |= 0;
  const old = framebuffer.u32;
  const fwidth = framebuffer.width | 0;
  const u32 = framebuffer.u32 = new Uint32Array(width * height);

  for (let yy = 0; yy < height; yy++) {
    const offset = x + fwidth * (y + yy);
    u32.set(old.subarray(offset, width + offset), yy * width);
  }

  framebuffer.width = width;
  framebuffer.height = height;
  framebuffer.u8 = new Uint8Array(framebuffer.u32.buffer);
  framebuffer.view = new DataView(framebuffer.u32.buffer);
}

export function circle(feathering, framebuffer) {
  const u8 = framebuffer.u8;
  const u32 = framebuffer.u32;
  const width = framebuffer.width | 0;
  const height = framebuffer.height | 0;
  const rad = Math.min(width, height) / 2;

  const cx = width / 2;
  const cy = height / 2;
  const rad_2 = rad ** 2;
  const feathering_12 = feathering ** (1 / 2);

  for (let y = 0 | 0; y < height; y++) {
    const cdy = (y - cy) ** 2;
    const y_offset = y * width;

    for (let x = 0 | 0; x < width; x++) {
      const cd = cdy + (x - cx) ** 2;
      if (cd > rad_2) u32[x + y_offset] = 0;
      else if (feathering) u8[3 + 4 * (x + y_offset)] *= clamp(0, 1 - (cd / rad_2) * feathering_12, 1);
    }
  }

  return framebuffer;
}