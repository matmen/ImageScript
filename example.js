import {Image} from "jsr:@matmen/imagescript";

const input = await Deno.readFile('./tests/targets/readme.png');
const image = await Image.decode(input);
image.rotate(180);

const output = await image.encode();
await Deno.writeFile('./output.png', output);