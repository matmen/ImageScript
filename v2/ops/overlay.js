import { blend } from './color.js';

export function replace(bg, fg, x, y) {
  // TODO: switch to range copying
  for (let yy = 0; yy < fg.height; yy++) {
    let y_offset = y + yy;
    if (y_offset < 0) continue;
    if (y_offset >= bg.height) break;

    for (let xx = 0; xx < fg.width; xx++) {
      let x_offset = x + xx;
      if (x_offset < 0) continue;
      if (x_offset >= bg.width) break;
      bg.u32[x_offset + y_offset * bg.width] = fg.u32[xx + yy * fg.width];
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
      const fg = foreground.view.getUint32(4 * (xx + yyoffset), false);

      const bg = background.view.getUint32(offset, false);
      if ((fg & 0xff) === 0xff) background.view.setUint32(offset, fg, false);
      else if ((fg & 0xff) === 0x00) background.view.setUint32(offset, bg, false);

      else background.view.setUint32(offset, blend(fg, bg), false);
    }
  }
}