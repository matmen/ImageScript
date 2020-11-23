const HEAD = Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const AEB = Uint8Array.of(0x21, 0xFF, 0x0B, 0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00);

export function encode(frames, opts) {
    let size = 0;

    for (const frame of frames) {
        frame.size = 1;
        let r_offset = 0;
        let p_offset = 0;
        const table = frame.table = new Map;
        const refs = new Uint8Array(frame.width * frame.height);

        while (p_offset < frame.pixels.length) {
            const slice = frame.pixels.subarray(p_offset, p_offset += 4);

            if (0 === slice[3]) refs[r_offset++] = 0;
            else {
                const hash = slice[2] | (slice[1] << 8) | (slice[0] << 16);

                const prev = table.get(hash);
                if (prev) refs[r_offset++] = prev;

                else if (256 > frame.size) {
                    table.set(hash, frame.size);
                    refs[r_offset++] = frame.size++;
                } else refs[r_offset++] = find_nearest(table, slice);
            }
        }

        frame.bits = Math.max(2, Math.ceil(Math.log2(frame.size)));
        size += 3 * (1 << frame.bits) + (frame.compressed = compress(refs, frame.bits)).length;
    }

    const buffer = new ArrayBuffer(size
        + 1 // END
        + 8 // LSD
        + AEB.length // AEB
        + HEAD.length // HEAD
        + (4 + opts.comment.length) // CE
        + ((1 + 1 + 8 + 10) * frames.length) // frames metadata
    );

    const u8 = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // HB 0:5
    u8.set(HEAD, 0);

    // LSD 6:12
    view.setUint16(6, opts.width, true);
    view.setUint16(8, opts.height, true);
    // 10:12 - (GCT flag, color resolution, sort flag, size of GCT), (background color index), (pixel aspect ratio)

    let offset = 13;
    // GCT if (GCT_f)

    // AEB
    u8.set(AEB, offset);
    offset += AEB.length;
    view.setUint16(offset - 3, opts.loop, true);

    for (const frame of frames) {
        // GCE 8b
        u8[offset++] = 0x21;
        u8[offset++] = 0xF9;
        u8[offset++] = 0x04;
        u8[offset++] = 0b00000001;
        view.setUint16(offset, frame.delay / 10, true);

        offset += 2;
        u8[offset++] = 0x00;
        u8[offset++] = 0x00;

        // ID 10b
        u8[offset++] = 0x2C;
        view.setUint16(4 + offset, frame.width, true);
        view.setUint16(6 + offset, frame.height, true);

        offset += 8;
        u8[offset++] = 0x00 | (1 << 7) | ((frame.bits - 1) & 0x07);

        const color_table = new Uint8Array(3 * (1 << frame.bits));

        for (const pair of frame.table) {
            const t_offset = 3 * pair[1];
            color_table[t_offset] = pair[0] >> 16;
            color_table[2 + t_offset] = pair[0] & 0xff;
            color_table[1 + t_offset] = pair[0] >> 8 & 0xff;
        }

        // LCT
        u8.set(color_table, offset);
        offset += color_table.length;

        // IDa
        u8[offset++] = frame.bits;
        u8.set(frame.compressed, offset);
        offset += frame.compressed.length;

        u8[offset++] = 0x00;
    }

    // CE
    u8[offset++] = 0x21;
    u8[offset++] = 0xFE;
    u8[offset++] = opts.comment.length;

    u8.set(opts.comment, offset);
    offset += opts.comment.length;

    u8[offset++] = 0x00;
    return (u8[offset] = 0x3B, u8);
};

function find_nearest(table, slice) {
    let index = 0;
    let distance = Infinity;

    for (const pair of table) {
        const hypot = Math.hypot(
            slice[0] - pair[0] >> 16,
            slice[2] - pair[0] & 0xff,
            slice[1] - pair[0] >> 8 & 0xff,
        );

        if (hypot < distance) {
            index = pair[1];
            distance = hypot;
        }
    }

    return index;
}

const BITS = 8;
const LENGTH = 12;
const LIMIT = 1 << BITS;

class blocks_buffer extends Array {
    constructor() {
        super();
        this.byte = 0;
        this.offset = 0;
        this.b_offset = 0;
        this.block = new Uint8Array(LIMIT);
    }


    u8() {
        const u8 = new Uint8Array(this.length + super.reduce((length, array) => length + array.length, 0));

        let offset = 0;
        for (const block of this) {
            u8[offset++] = block.length;

            u8.set(block, offset);
            offset += block.length;
        }

        return u8;
    }

    pack(code, length) {
        if (LIMIT <= this.b_offset + (this.offset ? 1 : 0) + Math.ceil(length / BITS)) this.new_block();

        let offset = 0;
        while (offset < length) {
            this.byte |= ((code >> offset++) & 1) << this.offset++;
            if (BITS === this.offset) (this.block[this.b_offset++] = this.byte, this.byte = 0, this.offset = 0);
        }
    }

    new_block() {
        if (0 === this.b_offset) return;
        super.push(this.block.slice(0, this.b_offset));

        this.b_offset = 0;
    }

    end() {
        if (0 !== this.offset) this.block[this.b_offset++] = (this.byte);

        super.push(this.block.subarray(0, this.b_offset));
    }
}

function compress(refs, bits) {
    const clear_code = 1 << bits;
    const end_code = 1 + clear_code;

    let s = '';
    let code_len = 1 + bits;
    let dictionary = new Map;
    const buffer = new blocks_buffer;
    let dictionary_len = 1 + end_code;
    buffer.pack(clear_code, code_len);

    for (const ref of refs) {
        const char = String.fromCharCode(ref);

        const key = s + char;
        if (1 === key.length || dictionary.has(key)) s = key;
        else {
            if (1 < s.length) buffer.pack(dictionary.get(s), code_len);
            else buffer.pack(s.charCodeAt(0), code_len);

            dictionary.set(key, dictionary_len++);
            code_len = Math.ceil(Math.log2(dictionary_len));

            if ((1 << LENGTH) <= dictionary_len) {
                dictionary = new Map;
                dictionary_len = 1 + end_code;
                buffer.pack(clear_code, code_len);
                code_len = Math.ceil(Math.log2(dictionary_len));
            }

            s = char;
        }
    }

    if (s !== '') {
        if (1 < s.length) buffer.pack(dictionary.get(s), code_len);
        else buffer.pack(s.charCodeAt(0), code_len);
    }

    buffer.pack(end_code, code_len);

    buffer.end();
    return buffer.u8();
}
