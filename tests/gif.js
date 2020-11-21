const fs = require('fs').promises;
const {Frame, GIF} = require('../ImageScript');

(async () => {
    const frames = [];
    for (let i = 0; i < 30; i++) {
        const frame = Frame.new(128, 128);
        frame.fill(x => Frame.hslToColor(x / frame.width + i / 30, 1, 0.5));
        frames.push(frame);
    }

    const gif = new GIF(frames);

    const encoded = await gif.encode();
    const desired = await fs.readFile('./tests/gif.gif');
    process.exit(desired.equals(encoded) ? 0 : 1);
})();