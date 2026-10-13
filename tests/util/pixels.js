const {Image} = require('../..');

// compares two encoded images by their pixels, so tests don't depend on the compressor the runtime provides
module.exports = async (a, b) => {
    const [x, y] = await Promise.all([Image.decode(a), Image.decode(b)]);
    return x.width === y.width && x.height === y.height && Buffer.from(x.bitmap).equals(Buffer.from(y.bitmap));
};
