let codecs;

if (process.env.CODECS_FORCE_WASM) codecs = require('./wasm/index.js');
else try { codecs = require('./node/index.js'); } catch { codecs = require('./wasm/index.js'); }

throw new Error('todo!');