export function rotate180(framebuffer) {
  framebuffer.u32.reverse();
}

export function rotate90(framebuffer) {
  const u32 = framebuffer.u32;
  const old = framebuffer.u32.slice();
  const width = framebuffer.width | 0;
  const height = framebuffer.height | 0;

  framebuffer.width = height;
  framebuffer.height = width;

  for (let y = 0 | 0; y < height; y++) {
    const yoffset = y * width;
    const heighty1 = height - 1 - y;

    for (let x = 0 | 0; x < width; x++) {
      u32[heighty1 + x * height] = old[x + yoffset];
    }
  }
}

export function rotate270(framebuffer) {
  const u32 = framebuffer.u32;
  const old = framebuffer.u32.slice();
  const width = framebuffer.width | 0;
  const height = framebuffer.height | 0;

  framebuffer.width = height;
  framebuffer.height = width;

  for (let y = 0 | 0; y < height; y++) {
    const yoffset = y * width;

    for (let x = 0 | 0; x < width; x++) {
      u32[y + height * (width - 1 - x)] = old[x + yoffset];
    }
  }
}

// broken?
export function rotate(deg, framebuffer, resize) {
  const rad = Math.PI * ((360 - deg) / 180);

  const sin = Math.sin(rad);
  const cos = Math.cos(rad);

  const width = (resize ? Math.abs(framebuffer.width * sin) + Math.abs(framebuffer.height * cos) : framebuffer.width) | 0;
  const height = (resize ? Math.abs(framebuffer.width * cos) + Math.abs(framebuffer.height * sin) : framebuffer.height) | 0;

  const same_size = width === framebuffer.width && height === framebuffer.height;

  const inn = same_size ? framebuffer.clone() : framebuffer;
  const out = { width, height, u8: same_size ? framebuffer.u8 : new Uint8Array(4 * width * height) };

  const out_cx = width / 2 - .5;
  const out_cy = height / 2 - .5;
  const src_cx = framebuffer.width / 2 - .5;
  const src_cy = framebuffer.height / 2 - .5;

  let h = 0;
  do {
    let w = 0;
    const ysin = src_cx - sin * (h - out_cy);
    const ycos = src_cy + cos * (h - out_cy);

    do {
      interpolate(inn, out, w, h, ysin + cos * (w - out_cx), ycos + sin * (w - out_cx));
    } while (w++ < width);
  } while (h++ < height);

  framebuffer.u8 = out.u8;
  framebuffer.width = width;
  framebuffer.height = height;
  framebuffer.view = new DataView(out.u8.buffer, out.u8.byteOffset, out.u8.byteLength);
  framebuffer.u32 = new Uint32Array(out.u8.buffer, out.u8.byteOffset, out.u8.byteLength / 4);
}

function interpolate(inn, out, x0, y0, x1, y1) {
  const x2 = ~~x1;
  const y2 = ~~y1;
  const xq = x1 - x2;
  const yq = y1 - y2;
  const offset = 4 * (x0 + y0 * out.width);

  const ref = { r: 0, g: 0, b: 0, a: 0 };
  pawn(x2, y2, (1 - xq) * (1 - yq), ref, inn);

  pawn(1 + x2, y2, xq * (1 - yq), ref, inn);
  pawn(x2, 1 + y2, (1 - xq) * yq, ref, inn);

  pawn(1 + x2, 1 + y2, xq * yq, ref, inn);

  out.u8[3 + offset] = ref.a;
  out.u8[offset] = ref.r / ref.a;
  out.u8[1 + offset] = ref.g / ref.a;
  out.u8[2 + offset] = ref.b / ref.a;
}

function pawn(point0, point1, weight, ref, inn) {
  if (
    point0 > 0
    && point1 > 0
    && point0 < inn.width
    && point1 < inn.height
  ) {
    const offset = 4 * (point0 + point1 * inn.width);

    const wa = weight * inn.u8[3 + offset];

    ref.a += wa;
    ref.r += wa * inn.u8[offset];
    ref.g += wa * inn.u8[1 + offset];
    ref.b += wa * inn.u8[2 + offset];
  }
}