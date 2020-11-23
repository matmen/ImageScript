import {Frame, GIF} from '../ImageScript.js';
import { equal } from "https://deno.land/std/bytes/mod.ts";

(async () => {
    const frames = [];
    for (let i = 0; i < 30; i++) {
        const frame = Frame.new(128, 128);
        frame.fill(x => Frame.hslToColor(x / frame.width + i / 30, 1, 0.5));
        frames.push(frame);
    }

    const gif = new GIF(frames);

    const encoded = await gif.encode();
    const desired = await Deno.readFile('./tests/gif.gif');
    Deno.exit(equal(desired, encoded) ? 0 : 1);
})();