let mod = async () => {
  let t;

  {
    const simd = WebAssembly.validate(Uint8Array.of(0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11));
    t = new WebAssembly.Module(await require('fs').promises.readFile(require('path').join(__dirname, `${simd ? 'simd' : 'unknown'}.wasm`)));
  }

  return (mod = () => t)();
};

module.exports = async function codecs() {
  return {
    png: null,
    gif: null,
    svg: null,
    webp: null,
    jpeg: null,
    tiff: null,
  };
}
