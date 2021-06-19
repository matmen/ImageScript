import { blend } from './color.js';

export function replace(bg, fg, x, y) {
  const fwidth = fg.width | 0;
  const bwidth = bg.width | 0;
  const fheight = fg.height | 0;
  const bheight = bg.height | 0;

  // todo: switch to range copying
  for (let yy = 0 | 0; yy < fheight; yy++) {
    let y_offset = y + yy;
    if (y_offset < 0) continue;
    if (y_offset >= bheight) break;

    const yyoffset = yy * fwidth | 0;
    const yoffset = y_offset * bwidth | 0;

    for (let xx = 0 | 0; xx < fwidth; xx++) {
      let x_offset = x + xx;
      if (x_offset < 0) continue;
      if (x_offset >= bwidth) break;
      bg.u32[x_offset + yoffset] = fg.u32[xx + yyoffset];
    }
  }
}

export function overlay(background, foreground, x, y) {
  x = x | 0;
  y = y | 0;
  const fwidth = foreground.width | 0;
  const bwidth = background.width | 0;
  const fheight = foreground.height | 0;
  const bheight = background.height | 0;

  const fview = foreground.view;
  const bview = background.view;

  for (let yy = 0 | 0; yy < fheight; yy++) {
    let yoffset = y + yy;
    if (yoffset < 0) continue;
    if (yoffset >= bheight) break;

    yoffset = bwidth * yoffset;
    const yyoffset = yy * fwidth;
    for (let xx = 0 | 0; xx < fwidth; xx++) {
      let xoffset = x + xx;
      if (xoffset < 0) continue;
      if (xoffset >= bwidth) break;

      const offset = 4 * (xoffset + yoffset);
      const fg = fview.getUint32(4 * (xx + yyoffset), false);

      const bg = bview.getUint32(offset, false);
      if ((fg & 0xff) === 0xff) bview.setUint32(offset, fg, false);
      else if ((fg & 0xff) === 0x00) bview.setUint32(offset, bg, false);

      else bview.setUint32(offset, blend(fg, bg), false);
    }
  }
}