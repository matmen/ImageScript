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
  for (let yy = 0; yy < foreground.height; yy++) {
    let y_offset = y + yy;
    if (y_offset < 0) continue;
    if (y_offset >= background.height) break;

    for (let xx = 0; xx < foreground.width; xx++) {
      let x_offset = x + xx;
      if (x_offset < 0) continue;
      if (x_offset >= background.width) break;

      const offset = 4 * (x_offset + y_offset * background.width);
      const fg = foreground.view.getUint32(4 * (xx + yy * foreground.width), false);

      const bg = background.view.getUint32(offset, false);
      if ((fg & 0xff) === 0xff) background.view.setUint32(offset, fg, false);
      else if ((fg & 0xff) === 0x00) background.view.setUint32(offset, bg, false);

      else background.view.setUint32(offset, blend(fg, bg), false);
    }
  }
}