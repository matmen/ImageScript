// Decodes and encodes images like a runtime without node:zlib (a browser: CompressionStream and DecompressionStream)
// or without any native compression (e.g. Hermes): node:zlib is hidden before ImageScript loads, with `plain` also the
// streams. Prints the sha256 of every result, which tests/zlib.js compares with the ones of the native runtime
const fs = require('fs');
const crypto = require('crypto');
const mode = process.argv[process.argv.length - 1];

if (mode !== 'native') delete process.getBuiltinModule;
if (mode === 'plain') {
    delete globalThis.CompressionStream;
    delete globalThis.DecompressionStream;
}

(async () => {
    const {Image, Frame, Animation} = await import('../../dist/index.js');
    const {nodeZlib} = await import('../../dist/codecs/zlib.js');
    // the runtime has to let them be hidden, or this tests nothing
    if (mode !== 'native' && nodeZlib) throw new Error(`node:zlib can't be hidden`);
    if (mode === 'plain' && (globalThis.CompressionStream || globalThis.DecompressionStream)) throw new Error(`the compression streams can't be hidden`);
    const sha256 = data => crypto.createHash('sha256').update(new Uint8Array(data)).digest('hex');
    const results = {};
    const image = await Image.decode(fs.readFileSync('./tests/targets/image.png'));
    results.decoded = sha256(image.bitmap);
    for (let level = 0; level <= 9; level++) {
        const encoded = await image.encode({compression: level, metadata: {creationTime: 0, software: ''}});
        // the output differs between the deflaters, the pixels must not
        results[`level ${level}`] = sha256((await Image.decode(encoded)).bitmap);
    }
    for (const file of fs.readdirSync('./tests/pngsuite').filter(f => f.endsWith('.png')))
        // also the damaged ones, which have to fail the same way
        results[file] = await Image.decode(fs.readFileSync(`./tests/pngsuite/${file}`)).then(image => sha256(image.bitmap), error => error.message);
    const animation = await Animation.decode(await new Animation([Frame.from(image.clone().resize(32, 32)), Frame.from(image.clone().resize(32, 32).invert())]).encodeAPNG());
    results.apng = sha256(animation.frames[1].bitmap);
    console.log(JSON.stringify(results));
})().catch(error => {
    console.error(error);
    process.exit(1);
});
