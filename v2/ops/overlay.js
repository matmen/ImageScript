export function replace(bg, fg, x, y) {
  const b32 = bg.u32;
  const f32 = fg.u32;
  const fw = fg.width | 0;
  const bw = bg.width | 0;
  const fh = fg.height | 0;
  const bh = bg.height | 0;
  const ox = (x > 0 ? 0 : -x) | 0;
  const oy = (y > 0 ? 0 : -y) | 0;
  const top = (y > 0 ? y : 0) | 0;
  const left = (x > 0 ? x : 0) | 0;
  const width = (Math.min(bw, x + fw) - left) | 0;
  const height = (Math.min(bh, y + fh) - top) | 0;

  if (0 >= width || 0 >= height) return;

  for (let yy = 0 | 0; yy < height; yy++) {
    const yyoffset = ox + fw * (yy + oy);
    const yoffset = left + bw * (yy + top);
    b32.subarray(yoffset, width + yoffset).set(f32.subarray(yyoffset, width + yyoffset));
  }
}

export function blend(bg, fg, x, y) {
  const b32 = bg.u32;
  const f32 = fg.u32;
  const fw = fg.width | 0;
  const bw = bg.width | 0;
  const fh = fg.height | 0;
  const bh = bg.height | 0;
  const ox = (x > 0 ? 0 : -x) | 0;
  const oy = (y > 0 ? 0 : -y) | 0;
  const top = (y > 0 ? y : 0) | 0;
  const left = (x > 0 ? x : 0) | 0;
  const width = (Math.min(bw, x + fw) - left) | 0;
  const height = (Math.min(bh, y + fh) - top) | 0;

  if (0 >= width || 0 >= height) return;

  for (let yy = 0 | 0; yy < height; yy++) {
    const yyoffset = ox + fw * (yy + oy);
    const yoffset = left + bw * (yy + top);

    for (let xx = 0 | 0; xx < width; xx++) {
      const F = f32[xx + yyoffset];

      // todo: be?
      const fa = F >> 24 & 0xff;
      if (fa === 0x00) continue;
      else if (fa === 0xff) b32[xx + yoffset] = F;

      else {
        const alpha = 1 + fa;
        const inv_alpha = 256 - fa;
        const B = b32[xx + yoffset];
        const r = (alpha * (F & 0xff) + inv_alpha * (B & 0xff)) >> 8;
        const g = (alpha * ((F >> 8) & 0xff) + inv_alpha * ((B >> 8) & 0xff)) >> 8;
        const b = (alpha * ((F >> 16) & 0xff) + inv_alpha * ((B >> 16) & 0xff)) >> 8;
        b32[xx + yoffset] = (Math.max(fa, (B >> 24) & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | r;
      }
    }
  }
}