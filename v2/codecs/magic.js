const { view } = require('../util/mem.js');

const formats = {
  ttf: { type: 'font', format: 'ttf' },
  otf: { type: 'font', format: 'otf' },
  svg: { type: 'image', format: 'svg' },
  png: { type: 'image', format: 'png' },
  gif: { type: 'image', format: 'gif' },
  jpeg: { type: 'image', format: 'jpeg' },
  tiff: { type: 'image', format: 'tiff' },
};

function buffer(init) {
  const u8 = view(init);
  if (0 === u8.length) return;
  if (0xff === u8[0] && 0xd8 === u8[1] && 0xff === u8[2]) return formats.jpeg;
  if (0x4d === u8[0] && 0x4d === u8[1] && 0x00 === u8[2] && 0x2a === u8[3]) return formats.tiff;
  if (0x49 === u8[0] && 0x49 === u8[1] && 0x2a === u8[2] && 0x00 === u8[3]) return formats.tiff;
  if (0x00 === u8[0] && 0x01 === u8[1] && 0x00 === u8[2] && 0x00 === u8[3] && 0x00 === u8[4]) return formats.ttf;
  if (0x4F === u8[0] && 0x54 === u8[1] && 0x54 === u8[2] && 0x4F === u8[3] && 0x00 === u8[4]) return formats.otf;
  if (0x47 === u8[0] && 0x49 === u8[1] && 0x46 === u8[2] && 0x38 === u8[3] && 0x61 === u8[5] && (0x37 === u8[4] || 0x39 === u8[4])) return formats.gif;
  if (0x89 === u8[0] && 0x50 === u8[1] && 0x4e === u8[2] && 0x47 === u8[3] && 0x0d === u8[4] && 0x0a === u8[5] && 0x1a === u8[6] && 0x0a === u8[7]) return formats.png;
}

module.exports = { buffer };