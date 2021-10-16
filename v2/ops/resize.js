function lerp(a, b, t) {
  return t * b + a * (1 - t);
}

function clamp(min, int, max) {
  const t = int < min ? min : int; return t > max ? max : t;
}

function clamped(x, y, width, height) {
  return 4 * (clamp(0, x, width - 1) + clamp(0, y, height - 1) * width);
}

function hermite(A, B, C, D, t) {
  const c = (C / 2) + (A / -2);
  const b = A + (C * 2) - (D / 2) - (B * 2.5);
  const a = (D / 2) + (A / -2) + (B * 1.5) - (C * 1.5);

  const t2 = t * t;
  return B + (c * t) + (b * t2) + (a * t * t2);
}

export function nearest(width, height, framebuffer) {
  width = width | 0;
  height = height | 0;
  const old = framebuffer.u32;
  const fwidth = framebuffer.width | 0;
  const fheight = framebuffer.height | 0;
  const u32 = framebuffer.u32 = new Uint32Array(width * height);

  const dw = 1 / width;
  const dh = 1 / height;
  const xw = dw * fwidth;
  const yw = dh * fheight;
  for (let y = 0 | 0; y < height; y++) {
    const yoffset = y * width;
    const yyoffset = fwidth * ((y * yw) | 0);

    for (let x = 0 | 0; x < width; x++) {
      u32[x + yoffset] = old[yyoffset + ((x * xw) | 0)];
    }
  }

  framebuffer.width = width;
  framebuffer.height = height;
  framebuffer.u8 = new Uint8Array(u32.buffer);
  framebuffer.view = new DataView(u32.buffer);
}

export function linear(width, height, framebuffer) {
  width = width | 0;
  height = height | 0;
  const old = framebuffer.u8;
  const old_width = framebuffer.width | 0;
  const old_height = framebuffer.height | 0;
  const u8 = new Uint8ClampedArray(4 * width * height);

  let offset = 0 | 0;
  const width1 = 1 / (width - 1);
  const height1 = 1 / (height - 1);

  for (let y = 0 | 0; y < height; y++) {
    const yy = old_height * (y * height1) - .5;

    const yyi = yy | 0;
    const ty = yy - yyi;

    for (let x = 0 | 0; x < width; x++) {
      const xx = old_width * (x * width1) - .5;

      const xxi = xx | 0;
      const tx = xx - xxi;
      const s0 = clamped(xxi, yyi, old_width, old_height);
      const s1 = clamped(1 + xxi, yyi, old_width, old_height);
      const s2 = clamped(xxi, 1 + yyi, old_width, old_height);
      const s3 = clamped(1 + xxi, 1 + yyi, old_width, old_height);

      u8[offset++] = lerp(lerp(old[s0], old[s2], tx), lerp(old[s1], old[s3], tx), ty);
      u8[offset++] = lerp(lerp(old[1 + s0], old[1 + s2], tx), lerp(old[1 + s1], old[1 + s3], tx), ty);
      u8[offset++] = lerp(lerp(old[2 + s0], old[2 + s2], tx), lerp(old[2 + s1], old[2 + s3], tx), ty);
      u8[offset++] = lerp(lerp(old[3 + s0], old[3 + s2], tx), lerp(old[3 + s1], old[3 + s3], tx), ty);
    }
  }

  framebuffer.width = width;
  framebuffer.height = height;
  framebuffer.u8 = new Uint8Array(u8.buffer);
  framebuffer.view = new DataView(u8.buffer);
  framebuffer.u32 = new Uint32Array(u8.buffer);
}

export function cubic(width, height, framebuffer) {
  width = width | 0;
  height = height | 0;
  const old = framebuffer.u8;
  const old_width = framebuffer.width | 0;
  const old_height = framebuffer.height | 0;
  const u8 = new Uint8ClampedArray(4 * width * height);

  let offset = 0 | 0;
  const width1 = 1 / (width - 1);
  const height1 = 1 / (height - 1);

  for (let y = 0 | 0; y < height; y++) {
    const yy = old_height * (y * height1) - .5;

    const yyi = yy | 0;
    const ty = yy - yyi;

    for (let x = 0 | 0; x < width; x++) {
      const xx = old_width * (x * width1) - .5;

      const xxi = xx | 0;
      const tx = xx - xxi;
      const s0 = clamped(xxi - 1, yyi - 1, old_width, old_height);
      const s1 = clamped(0 + xxi, yyi - 1, old_width, old_height);
      const s2 = clamped(1 + xxi, yyi - 1, old_width, old_height);
      const s3 = clamped(2 + xxi, yyi - 1, old_width, old_height);

      const s4 = clamped(xxi - 1, yyi, old_width, old_height);
      const s5 = clamped(0 + xxi, yyi, old_width, old_height);
      const s6 = clamped(1 + xxi, yyi, old_width, old_height);
      const s7 = clamped(2 + xxi, yyi, old_width, old_height);

      const s8 = clamped(xxi - 1, 1 + yyi, old_width, old_height);
      const s9 = clamped(0 + xxi, 1 + yyi, old_width, old_height);
      const s10 = clamped(1 + xxi, 1 + yyi, old_width, old_height);
      const s11 = clamped(2 + xxi, 1 + yyi, old_width, old_height);

      const s12 = clamped(xxi - 1, 2 + yyi, old_width, old_height);
      const s13 = clamped(0 + xxi, 2 + yyi, old_width, old_height);
      const s14 = clamped(1 + xxi, 2 + yyi, old_width, old_height);
      const s15 = clamped(2 + xxi, 2 + yyi, old_width, old_height);

      const c0 = hermite(old[s0], old[s1], old[s2], old[s3], tx);
      const c00 = hermite(old[1 + s0], old[1 + s1], old[1 + s2], old[1 + s3], tx);
      const c000 = hermite(old[2 + s0], old[2 + s1], old[2 + s2], old[2 + s3], tx);
      const c0000 = hermite(old[3 + s0], old[3 + s1], old[3 + s2], old[3 + s3], tx);

      const c1 = hermite(old[s4], old[s5], old[s6], old[s7], tx);
      const c11 = hermite(old[1 + s4], old[1 + s5], old[1 + s6], old[1 + s7], tx);
      const c111 = hermite(old[2 + s4], old[2 + s5], old[2 + s6], old[2 + s7], tx);
      const c1111 = hermite(old[3 + s4], old[3 + s5], old[3 + s6], old[3 + s7], tx);

      const c2 = hermite(old[s8], old[s9], old[s10], old[s11], tx);
      const c22 = hermite(old[1 + s8], old[1 + s9], old[1 + s10], old[1 + s11], tx);
      const c222 = hermite(old[2 + s8], old[2 + s9], old[2 + s10], old[2 + s11], tx);
      const c2222 = hermite(old[3 + s8], old[3 + s9], old[3 + s10], old[3 + s11], tx);

      const c3 = hermite(old[s12], old[s13], old[s14], old[s15], tx);
      const c33 = hermite(old[1 + s12], old[1 + s13], old[1 + s14], old[1 + s15], tx);
      const c333 = hermite(old[2 + s12], old[2 + s13], old[2 + s14], old[2 + s15], tx);
      const c3333 = hermite(old[3 + s12], old[3 + s13], old[3 + s14], old[3 + s15], tx);

      u8[offset++] = hermite(c0, c1, c2, c3, ty);
      u8[offset++] = hermite(c00, c11, c22, c33, ty);
      u8[offset++] = hermite(c000, c111, c222, c333, ty);
      u8[offset++] = hermite(c0000, c1111, c2222, c3333, ty);
    }
  }

  framebuffer.width = width;
  framebuffer.height = height;
  framebuffer.u8 = new Uint8Array(u8.buffer);
  framebuffer.view = new DataView(u8.buffer);
  framebuffer.u32 = new Uint32Array(u8.buffer);
}