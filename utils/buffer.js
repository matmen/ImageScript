module.exports = class Buffer {
    static concat(...arrays) {
        const array = new Uint8Array(
            arrays.reduce((length, array) => length + array.length, 0)
        );

        let offset = 0;
        for (const x of arrays) {
            array.set(x, offset);
            offset += x.length;
        }

        return array;
    }
};