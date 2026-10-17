/** A byte buffer that grows as it is written (doubling its capacity) */
export class ByteWriter {
    buffer: Uint8Array;
    length = 0;

    constructor(capacity = 1024) {
        this.buffer = new Uint8Array(Math.max(16, capacity));
    }

    /** makes room for size more bytes */
    reserve(size: number): void {
        if (this.length + size <= this.buffer.length) return;
        const buffer = new Uint8Array(Math.max(this.buffer.length * 2, this.length + size));
        buffer.set(this.buffer.subarray(0, this.length));
        this.buffer = buffer;
    }

    byte(value: number): void {
        this.reserve(1);
        this.buffer[this.length++] = value;
    }

    bytes(...values: number[]): void {
        this.reserve(values.length);
        for (const value of values) this.buffer[this.length++] = value;
    }

    array(values: ArrayLike<number>): void {
        this.reserve(values.length);
        this.buffer.set(values, this.length);
        this.length += values.length;
    }

    /** the written bytes */
    finish(): Uint8Array {
        return this.buffer.slice(0, this.length);
    }
}
