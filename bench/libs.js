// One adapter per library, all with the same operations. Operations take a decoded image and return a new one
// (libraries that change images in place clone first), so every run starts from the same input. Missing operations
// are ones the library doesn't have.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

// IMAGESCRIPT=local measures this checkout (npm run build first) instead of the version from npm
const ImageScript = await import(process.env.IMAGESCRIPT === 'local' ? '../dist/index.js' : 'imagescript');
const ImageScriptV1 = require('imagescript-v1');
const { Jimp, ResizeStrategy } = await import('jimp');
const sharp = (await import('sharp')).default;
const canvas = await import('@napi-rs/canvas');
const imageJS = await import('image-js');
const photon = require('@silvia-odwyer/photon-node');
const { createImageLibrary } = await import('purejsimage');
const { allCodecs } = await import('purejsimage/codecs/all');
const pureJsImage = createImageLibrary(allCodecs);

// the same work in every library: halve the size (bilinear where it can be chosen), rotate by 30° (growing the
// image to fit), blur with a radius/sigma of 5, place a semi-transparent overlay, cut out a quarter
const RESIZE = [960, 540], ANGLE = 30, BLUR = 5, AT = [100, 100], CROP = [480, 270, 960, 540];

// rendering: one line of text in Source Sans 3 at 64px, white; tests/svgs/features.svg (240×160) scaled to 1920 wide
export const FONT_FILE = new URL('../tests/fonts/sourcesans3 regular.otf', import.meta.url);
export const SVG_FILE = new URL('../tests/svgs/features.svg', import.meta.url);
export const TEXT = 'The quick brown fox jumps over the lazy dog, 0123456789', TEXT_SIZE = 64, SVG_WIDTH = 1920;
const font = fs.readFileSync(FONT_FILE), svg = fs.readFileSync(SVG_FILE, 'utf8');
const svgScale = SVG_WIDTH / Number(svg.match(/<svg[^>]*\swidth="(\d+)/)[1]);
const svgAtWidth = svg.replace(/<svg[^>]*>/, tag => tag.replace(/\s(width|height)="(\d+)"/g, (_, name, value) => ` ${name}="${Math.round(value * svgScale)}"`));

const imageScript = (IS, { version, package: pkg, kind, blur = true, webp = true, bilinear = true }) => ({
    name: `ImageScript ${version}`, package: pkg, kind,
    decode: data => IS.Image.decode(data),
    encode: {
        png: image => image.encode(),
        jpeg: image => image.encodeJPEG(80),
        ...webp && { webp: image => image.encodeWebP() }
    },
    resize: image => image.clone().resize(...RESIZE, bilinear ? IS.Image.RESIZE_BILINEAR : IS.Image.RESIZE_NEAREST_NEIGHBOR),
    rotate: image => image.clone().rotate(ANGLE),
    ...blur && { blur: image => image.clone().blur(BLUR) },
    composite: (image, overlay) => image.clone().composite(overlay, ...AT),
    crop: image => image.clone().crop(...CROP),
    clone: image => image.clone(),
    text: () => IS.Image.renderText(font, TEXT_SIZE, TEXT),
    svg: () => IS.Image.renderSVG(svg, SVG_WIDTH, IS.Image.SVG_MODE_WIDTH),
    animation: {
        decode: data => (IS.Animation ?? IS.GIF).decode(data),
        encode: animation => animation.encodeGIF ? animation.encodeGIF() : animation.encode()
    }
});

// sharp works on pipelines: a decoded image is its raw pixels, every operation runs a pipeline back to raw pixels
const raw = (data, info) => ({ data, width: info.width, height: info.height });
const pipeline = image => sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } });
const toRaw = async p => { const { data, info } = await p.raw().toBuffer({ resolveWithObject: true }); return raw(data, info); };

// canvas: a decoded image is a canvas
const drawn = (width, height, draw) => {
    const c = canvas.createCanvas(width, height);
    const ctx = c.getContext('2d');
    draw(ctx);
    ctx.getImageData(0, 0, 1, 1); // Skia draws lazily: reading a pixel makes it actually render inside the measured call
    return c;
};

export const libraries = [
    imageScript(ImageScript, { version: '3', package: 'imagescript', kind: 'JavaScript' }),
    imageScript(ImageScriptV1, { version: '1', package: 'imagescript-v1', kind: 'WebAssembly', blur: false, webp: false, bilinear: false }),
    {
        name: 'Jimp', package: 'jimp', kind: 'JavaScript',
        decode: data => Jimp.fromBuffer(data),
        encode: {
            png: image => image.getBuffer('image/png'),
            jpeg: image => image.getBuffer('image/jpeg', { quality: 80 })
        },
        resize: image => image.clone().resize({ w: RESIZE[0], h: RESIZE[1], mode: ResizeStrategy.BILINEAR }),
        rotate: image => image.clone().rotate(ANGLE),
        blur: image => image.clone().gaussian(BLUR),
        composite: (image, overlay) => image.clone().composite(overlay, ...AT),
        crop: image => image.clone().crop({ x: CROP[0], y: CROP[1], w: CROP[2], h: CROP[3] }),
        clone: image => image.clone()
    },
    {
        name: 'image-js', package: 'image-js', kind: 'JavaScript',
        decode: data => imageJS.decode(data).convertColor('RGBA'),
        encode: {
            png: image => imageJS.encodePng(image),
            jpeg: image => imageJS.encodeJpeg(image, { quality: 80 })
        },
        resize: image => image.resize({ width: RESIZE[0], height: RESIZE[1], interpolationType: 'bilinear' }),
        rotate: image => image.transformRotate(ANGLE, { fullImage: true }),
        blur: image => image.gaussianBlur({ sigma: BLUR }),
        composite: (image, overlay) => overlay.copyTo(image.clone(), { origin: { column: AT[0], row: AT[1] } }),
        crop: image => image.crop({ origin: { column: CROP[0], row: CROP[1] }, width: CROP[2], height: CROP[3] }),
        clone: image => image.clone()
    },
    {
        // PureJsImage works on pipelines from encoded data to encoded data, without decoded images: a decoded image is
        // a BMP, its fastest uncompressed format (a BMP to BMP pipeline takes about 40 ms on the photo), and every
        // operation runs a pipeline from it back to a BMP, like sharp's raw pixels
        name: 'PureJsImage', package: 'purejsimage', kind: 'JavaScript',
        decode: async data => toBmp(await pureJsImage.open(data)),
        encode: {
            png: async image => (await pureJsImage.open(image)).png().toUint8Array(),
            jpeg: async image => (await pureJsImage.open(image)).jpeg({ quality: 80 }).toUint8Array(),
            webp: async image => (await pureJsImage.open(image)).webp({ lossless: true }).toUint8Array()
        },
        resize: async image => toBmp((await pureJsImage.open(image)).resize({ width: RESIZE[0], height: RESIZE[1], kernel: 'bilinear', fit: 'fill' })),
        rotate: async image => toBmp((await pureJsImage.open(image)).rotate(ANGLE, { background: 'transparent' })),
        crop: async image => toBmp((await pureJsImage.open(image)).crop({ x: CROP[0], y: CROP[1], width: CROP[2], height: CROP[3] })),
        clone: image => new Uint8Array(image)
    },
    {
        name: 'Photon', package: '@silvia-odwyer/photon-node', kind: 'WebAssembly', collect: true,
        decode: data => photon.PhotonImage.new_from_byteslice(new Uint8Array(data)),
        encode: {
            png: image => image.get_bytes(),
            jpeg: image => image.get_bytes_jpeg(80),
            webp: image => image.get_bytes_webp()
        },
        resize: image => photon.resize(image, ...RESIZE, photon.SamplingFilter.Triangle),
        rotate: image => photon.rotate(image, ANGLE),
        blur: image => { const copy = clonePhoton(image); photon.gaussian_blur(copy, BLUR); return copy; },
        composite: (image, overlay) => { const copy = clonePhoton(image); photon.watermark(copy, overlay, BigInt(AT[0]), BigInt(AT[1])); return copy; },
        crop: image => photon.crop(image, CROP[0], CROP[1], CROP[0] + CROP[2], CROP[1] + CROP[3]),
        clone: image => clonePhoton(image)
    },
    {
        name: 'sharp', package: 'sharp', kind: 'native (libvips)',
        decode: async data => toRaw(sharp(data).ensureAlpha()),
        encode: {
            png: image => pipeline(image).png().toBuffer(),
            jpeg: image => pipeline(image).jpeg({ quality: 80 }).toBuffer(),
            webp: image => pipeline(image).webp({ lossless: true }).toBuffer()
        },
        resize: image => toRaw(pipeline(image).resize(...RESIZE, { kernel: 'linear', fit: 'fill' })),
        rotate: image => toRaw(pipeline(image).rotate(ANGLE, { background: { r: 0, g: 0, b: 0, alpha: 0 } })),
        blur: image => toRaw(pipeline(image).blur(BLUR)),
        composite: async (image, overlay) => toRaw(pipeline(image).composite([{
            input: overlay.data, raw: { width: overlay.width, height: overlay.height, channels: 4 }, left: AT[0], top: AT[1]
        }])),
        crop: image => toRaw(pipeline(image).extract({ left: CROP[0], top: CROP[1], width: CROP[2], height: CROP[3] })),
        clone: image => raw(Buffer.from(image.data), image),
        // pango sizes fonts in points: at 72 dpi a point is a pixel
        text: () => toRaw(sharp({ text: { text: `<span foreground="white">${TEXT}</span>`, font: `Source Sans 3 ${TEXT_SIZE}`, fontfile: fileURLToPath(FONT_FILE), dpi: 72, rgba: true } })),
        svg: () => toRaw(sharp(Buffer.from(svg), { density: 72 * svgScale }).ensureAlpha()),
        animation: {
            decode: async data => { const { data: pixels, info } = await sharp(data, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { pixels, info }; },
            encode: ({ pixels, info }) => sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4, pageHeight: info.pageHeight } })
                .gif({ delay: info.delay, loop: info.loop }).toBuffer()
        }
    },
    {
        name: '@napi-rs/canvas', package: '@napi-rs/canvas', kind: 'native (Skia)', collect: true,
        decode: async data => { const image = await canvas.loadImage(data); return drawn(image.width, image.height, ctx => ctx.drawImage(image, 0, 0)); },
        encode: {
            png: c => c.encode('png'),
            jpeg: c => c.encode('jpeg', 80),
            webp: c => c.encode('webp', 100)
        },
        resize: c => drawn(...RESIZE, ctx => ctx.drawImage(c, 0, 0, ...RESIZE)),
        rotate: c => {
            const r = ANGLE * Math.PI / 180, w = Math.ceil(c.width * Math.cos(r) + c.height * Math.sin(r)), h = Math.ceil(c.width * Math.sin(r) + c.height * Math.cos(r));
            return drawn(w, h, ctx => { ctx.translate(w / 2, h / 2); ctx.rotate(-r); ctx.drawImage(c, -c.width / 2, -c.height / 2); });
        },
        blur: c => drawn(c.width, c.height, ctx => { ctx.filter = `blur(${BLUR}px)`; ctx.drawImage(c, 0, 0); }),
        composite: (c, overlay) => drawn(c.width, c.height, ctx => { ctx.drawImage(c, 0, 0); ctx.drawImage(overlay, ...AT); }),
        crop: c => drawn(CROP[2], CROP[3], ctx => ctx.drawImage(c, -CROP[0], -CROP[1])),
        clone: c => drawn(c.width, c.height, ctx => ctx.drawImage(c, 0, 0)),
        text: () => {
            const measure = canvas.createCanvas(1, 1).getContext('2d');
            measure.font = `${TEXT_SIZE}px "Source Sans 3"`;
            const m = measure.measureText(TEXT);
            return drawn(Math.ceil(m.width), Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent), ctx => {
                ctx.font = measure.font; ctx.fillStyle = '#fff'; ctx.fillText(TEXT, 0, Math.ceil(m.actualBoundingBoxAscent));
            });
        },
        // Skia rasterizes an SVG at its own width and height, so they're set to the output size (the viewBox scales)
        svg: async () => {
            const image = await canvas.loadImage(Buffer.from(svgAtWidth));
            return drawn(image.width, image.height, ctx => ctx.drawImage(image, 0, 0));
        }
    }
];
canvas.GlobalFonts.register(font, 'Source Sans 3');

function toBmp(image) {
    return image.bmp({ alpha: true }).toUint8Array();
}

function clonePhoton(image) {
    return new photon.PhotonImage(image.get_raw_pixels(), image.get_width(), image.get_height());
}

