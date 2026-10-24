// Compresses the packed tables of the output of scripts/av1-tables.c (stdin to stdout): the PACKED constant's base64
// data becomes the base64 of a zlib stream of it
const zlib = require('zlib');

let text = require('fs').readFileSync(0, 'utf8');
text = text.replace(/export const PACKED = '([^']*)'/, (_, data) => `export const PACKED = '${zlib.deflateSync(Buffer.from(data, 'base64'), { level: 9 }).toString('base64')}'`);
process.stdout.write(text);
