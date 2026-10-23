const zlib = require('zlib');
const fs = require('fs');
const child_process = require('child_process');

const panic = message => {
    console.error(message);
    process.exit(1);
};

(async () => {
    const {compress, decompress} = await import('../dist/codecs/zlib.js');
    const equal = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

    // the JavaScript deflater and inflater (runtimes without node:zlib), against zlib itself
    let seed = 1;
    const random = Uint8Array.from({length: 70000}, () => (seed = seed * 1103515245 + 12345 >>> 0) >>> 24);
    const inputs = {
        empty: new Uint8Array(0),
        byte: new Uint8Array([42]),
        text: new TextEncoder().encode('ImageScript '.repeat(5000) + 'zlib'),
        random,
        runs: Uint8Array.from({length: 300000}, (_, i) => i / 1000 & 0xff),
        pixels: new Uint8Array(fs.readFileSync('./tests/targets/image.png').buffer).subarray(0, 200000).map((v, i) => v ^ i % 7)
    };
    for (const [name, data] of Object.entries(inputs)) {
        for (let level = 0; level <= 9; level++) {
            const compressed = compress(data, level);
            if (!equal(zlib.inflateSync(compressed), data)) panic(`zlib: ${name} at level ${level} doesn't decompress with zlib`);
            if (!equal(decompress(compressed, data.length), data)) panic(`zlib: ${name} at level ${level} doesn't round trip`);
            for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE])
                if (!equal(decompress(zlib.deflateSync(data, {level, strategy}), data.length), data))
                    panic(`zlib: zlib's ${name} at level ${level} (strategy ${strategy}) decompressed incorrectly`);
        }
        if (data.length > 1000 && compress(data, 9).length > compress(data, 1).length * 1.02) panic(`zlib: ${name} compresses worse at level 9`);
    }
    // the limit cuts the output, damaged and unsupported streams throw
    if (!equal(decompress(zlib.deflateSync(inputs.text), 100), inputs.text.subarray(0, 100))) panic('zlib: the limit should cut the output');
    for (const [name, data] of [['header', [0x78, 0x9d, 0, 0]], ['dictionary', [0x78, 0xbb, 0, 0, 0, 1]], ['method', [0x79, 0x9c, 0, 0]]])
        try {
            decompress(new Uint8Array(data), 10);
            panic(`zlib: an invalid ${name} should throw`);
        } catch (error) {
            if (!/zlib/.test(error.message)) panic(`zlib: an invalid ${name} threw ${error.message}`);
        }

    // whole images through the paths other runtimes take: CompressionStream (levels 1-6) and DecompressionStream as in
    // browsers, the JavaScript ones without either
    const runtime = `"${process.execPath}"`;
    const command = typeof Deno !== 'undefined' ? `${runtime} run -A` : runtime;
    const run = mode => JSON.parse(child_process.execSync(`${command} ./tests/util/without-native.js ${mode}`, {maxBuffer: 1 << 24}).toString());
    const native = run('native');
    // (Bun 1.2 has no CompressionStream)
    for (const mode of typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined' ? ['streams', 'plain'] : ['plain']) {
        const results = run(mode);
        for (const [key, hash] of Object.entries(native)) if (results[key] !== hash) panic(`zlib: ${key} differs without native zlib (${mode})`);
    }
})();
