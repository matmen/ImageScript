export function cubic(framebuffer) {
  const width = framebuffer.width;
  const height = framebuffer.height;
  framebuffer.resize('cubic', Math.max(1, .008 * width), Math.max(1, .008 * height));

  framebuffer.resize('cubic', width, height);
}

export function box(radius, framebuffer) {
  if (!radius) return;
  const u8 = framebuffer.u8;
  const width = framebuffer.width;
  const height = framebuffer.height;
  const old = framebuffer.u8.slice();
  bb(u8, old, width, height, radius);
}

export function gaussian(radius, framebuffer) {
  if (0 >= radius) return;
  const a = Math.exp(.726 ** 2) / radius;

  const g1 = Math.exp(-a);
  const g2 = Math.exp(a * -2);
  const old = framebuffer.u8.slice();
  const k = ((1 - g1) ** 2) / (1 - g2 + 2 * a * g1);

  const b2 = -g2;
  const b1 = 2 * g1;
  const a3 = -k * g2;
  const a1 = k * g1 * (a - 1);
  const a2 = k * g1 * (a + 1);
  const lc = (k + a1) / (1 - b1 - b2);
  const width = framebuffer.width | 0;
  const rc = (a2 + a3) / (1 - b1 - b2);
  const height = framebuffer.height | 0;
  const tmp = new Float32Array(4 * Math.max(width, height));
  gc(old, framebuffer.u8, tmp, width, height, k, a1, a2, a3, b1, b2, lc, rc);
  gc(framebuffer.u8, old, tmp, height, width, k, a1, a2, a3, b1, b2, lc, rc);
}

function bb(u8, old, width, height, radius) {
  const divisor = 1 / (1 + radius + radius);
  bbt(u8, old, width, height, radius, divisor);
  bbh(u8, old, width, height, radius, divisor);
}

function bbh(u8, old, width, height, radius, divisor) {
  for (var y = 0; y < height; y++) {
    let y_offset = y * width;

    let li = y_offset;
    let ri = radius + y_offset;
    const fv_offset = 4 * y_offset;
    const lv_offset = 4 * (width - 1 + y_offset);

    const rfv = old[fv_offset];
    const gfv = old[1 + fv_offset];
    const bfv = old[2 + fv_offset];
    const afv = old[3 + fv_offset];

    const rlv = old[lv_offset];
    const glv = old[1 + lv_offset];
    const blv = old[2 + lv_offset];
    const alv = old[3 + lv_offset];

    let r = rfv * (1 + radius);
    let g = gfv * (1 + radius);
    let b = bfv * (1 + radius);
    let a = afv * (1 + radius);

    for (let x = 0; x < radius; x++) {
      const offset = 4 * (x + y_offset);

      r += old[offset];
      g += old[1 + offset];
      b += old[2 + offset];
      a += old[3 + offset];
    }

    for (let x = 0; x <= radius; x++) {
      let offset = 4 * ri++;
      r += old[offset] - rfv;
      g += old[1 + offset] - gfv;
      b += old[2 + offset] - bfv;
      a += old[3 + offset] - afv;

      offset = 4 * y_offset++;
      u8[offset] = Math.round(r * divisor);
      u8[1 + offset] = Math.round(g * divisor);
      u8[2 + offset] = Math.round(b * divisor);
      u8[3 + offset] = Math.round(a * divisor);
    }

    for (let x = 1 + radius; x < (width - radius); x++) {
      let offset = 4 * ri++;
      const roffset = 4 * li++;
      r += old[offset] - old[roffset];
      g += old[1 + offset] - old[1 + roffset];
      b += old[2 + offset] - old[2 + roffset];
      a += old[3 + offset] - old[3 + roffset];
      // todo: how far is roffset

      offset = 4 * y_offset++;
      u8[offset] = Math.round(r * divisor);
      u8[1 + offset] = Math.round(g * divisor);
      u8[2 + offset] = Math.round(b * divisor);
      u8[3 + offset] = Math.round(a * divisor);
    }

    for (let x = width - radius; x < width; x++) {
      let offset = 4 * li++;
      r += rlv - old[offset];
      g += glv - old[1 + offset];
      b += blv - old[2 + offset];
      a += alv - old[3 + offset];

      offset = 4 * y_offset++;
      u8[offset] = Math.round(r * divisor);
      u8[1 + offset] = Math.round(g * divisor);
      u8[2 + offset] = Math.round(b * divisor);
      u8[3 + offset] = Math.round(a * divisor);
    }
  }
}

function bbt(u8, old, width, height, radius, divisor) {
  for (var x = 0; x < width; x++) {
    let ti = x;
    let li = ti;
    const fv_offset = 4 * ti;
    let ri = ti + width * radius;
    const lv_offset = 4 * (ti + width * (height - 1));

    const rfv = old[fv_offset];
    const gfv = old[1 + fv_offset];
    const bfv = old[2 + fv_offset];
    const afv = old[3 + fv_offset];

    const rlv = old[lv_offset];
    const glv = old[1 + lv_offset];
    const blv = old[2 + lv_offset];
    const alv = old[3 + lv_offset];

    let r = rfv * (1 + radius);
    let g = gfv * (1 + radius);
    let b = bfv * (1 + radius);
    let a = afv * (1 + radius);

    for (let y = 0; y < radius; y++) {
      const offset = 4 * (ti + y * width);

      r += old[offset];
      g += old[1 + offset];
      b += old[2 + offset];
      a += old[3 + offset];
    }

    for (let y = 0; y <= radius; y++) {
      let offset = 4 * ri;
      r += old[offset] - rfv;
      g += old[1 + offset] - gfv;
      b += old[2 + offset] - bfv;
      a += old[3 + offset] - afv;

      offset = 4 * ti;
      u8[offset] = Math.round(r * divisor);
      u8[1 + offset] = Math.round(g * divisor);
      u8[2 + offset] = Math.round(b * divisor);
      u8[3 + offset] = Math.round(a * divisor);

      ri += width;
      ti += width;
    }

    for (let y = 1 + radius; y < (height - radius); y++) {
      let offset = 4 * ri;
      const xoffset = 4 * li;
      r += old[offset] - old[xoffset];
      g += old[1 + offset] - old[1 + xoffset];
      b += old[2 + offset] - old[2 + xoffset];
      a += old[3 + offset] - old[3 + xoffset];
      // todo: how far is xoffset

      offset = 4 * ti;
      u8[offset] = Math.round(r * divisor);
      u8[1 + offset] = Math.round(g * divisor);
      u8[2 + offset] = Math.round(b * divisor);
      u8[3 + offset] = Math.round(a * divisor);

      li += width;
      ri += width;
      ti += width;
    }

    for (let y = height - radius; y < height; y++) {
      let offset = 4 * li;
      r += rlv - old[offset];
      g += glv - old[1 + offset];
      b += blv - old[2 + offset];
      a += alv - old[3 + offset];

      offset = 4 * ti;
      u8[offset] = Math.round(r * divisor);
      u8[1 + offset] = Math.round(g * divisor);
      u8[2 + offset] = Math.round(b * divisor);
      u8[3 + offset] = Math.round(a * divisor);

      li += width;
      ti += width;
    }
  }
}

function gc(u8, old, tmp, width, height, k, a1, a2, a3, b1, b2, lc, rc) {
  const width4 = width * 4;
  const height4 = height * 4;
  const hw1 = height * (width - 1);

  for (let y = 0; y < height; y++) {
    let toffset = 0 | 0;
    let ooffset = (y * width4) | 0;
    let offset = (4 * (y + hw1)) | 0;

    let por = old[ooffset];
    let pog = old[1 + ooffset];
    let pob = old[2 + ooffset];
    let poa = old[3 + ooffset];

    let pur = lc * por;
    let pug = lc * pog;
    let pub = lc * pob;
    let pua = lc * poa;

    let ppur = pur;
    let ppug = pug;
    let ppub = pub;
    let ppua = pua;

    for (let x = 0; x < width; x++) {
      const cor = old[ooffset++];
      const cog = old[ooffset++];
      const cob = old[ooffset++];
      const coa = old[ooffset++];

      const cur = k * cor + a1 * por + b1 * pur + b2 * ppur;
      const cug = k * cog + a1 * pog + b1 * pug + b2 * ppug;
      const cub = k * cob + a1 * pob + b1 * pub + b2 * ppub;
      const cua = k * coa + a1 * poa + b1 * pua + b2 * ppua;

      ppur = pur; pur = cur; por = cor;
      ppug = pug; pug = cug; pog = cog;
      ppub = pub; pub = cub; pob = cob;
      ppua = pua; pua = cua; poa = coa;

      tmp[toffset++] = pur;
      tmp[toffset++] = pug;
      tmp[toffset++] = pub;
      tmp[toffset++] = pua;
    }

    ooffset -= 4;
    toffset -= 4;
    ppur = rc * (por = old[ooffset]);
    ppug = rc * (pog = old[1 + ooffset]);
    ppub = rc * (pob = old[2 + ooffset]);
    ppua = rc * (poa = old[3 + ooffset]);

    pur = ppur;
    pug = ppug;
    pub = ppub;
    pua = ppua;
    let cor = por;
    let cog = pog;
    let cob = pob;
    let coa = poa;

    for (let x = width - 1; 0 <= x; x--) {
      const cur = a2 * cor + a3 * por + b1 * pur + b2 * ppur;
      const cug = a2 * cog + a3 * pog + b1 * pug + b2 * ppug;
      const cub = a2 * cob + a3 * pob + b1 * pub + b2 * ppub;
      const cua = a2 * coa + a3 * poa + b1 * pua + b2 * ppua;

      ppur = pur; pur = cur; por = cor;
      ppug = pug; pug = cug; pog = cog;
      ppub = pub; pub = cub; pob = cob;
      ppua = pua; pua = cua; poa = coa;

      cor = old[ooffset];
      cog = old[1 + ooffset];
      cob = old[2 + ooffset];
      coa = old[3 + ooffset];

      u8[offset] = pur + tmp[toffset];
      u8[1 + offset] = pug + tmp[1 + toffset];
      u8[2 + offset] = pub + tmp[2 + toffset];
      u8[3 + offset] = pua + tmp[3 + toffset];

      ooffset -= 4;
      toffset -= 4;
      offset -= height4;
    }
  }
}