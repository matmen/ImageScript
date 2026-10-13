'use strict';

/**
 * SVG renderer supporting a static subset of SVG 1.1/2:
 * shapes, paths, transforms, nested svg/use/symbol, presentation attributes, inline styles and simple
 * <style> sheets (type, class and id selectors), solid colors, linear and radial gradients, strokes
 * (joins, caps, dashes), opacity, clip paths and luminance masks.
 * Not supported: text, images, filters, patterns, markers, animation and scripting.
 */

const UNSUPPORTED = new Set(['text', 'image', 'filter', 'pattern', 'marker', 'foreignObject', 'script', 'style', 'title', 'desc', 'metadata',
    'defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'symbol', 'font', 'font-face', 'animate', 'animateTransform', 'animateMotion', 'set']);

const INHERITED = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
    'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'color', 'visibility', 'clip-rule', 'font-size']);

// elements a switch may choose from
const SWITCHABLE = new Set(['svg', 'g', 'a', 'switch', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'foreignObject']);

const PROPERTIES = new Set([...INHERITED, 'opacity', 'display', 'clip-path', 'mask', 'stop-color', 'stop-opacity', 'transform']);

const DEFAULTS = {
    'fill': 'black', 'fill-opacity': '1', 'fill-rule': 'nonzero', 'stroke': 'none', 'stroke-width': '1', 'stroke-opacity': '1',
    'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'stroke-miterlimit': '4', 'stroke-dasharray': 'none', 'stroke-dashoffset': '0',
    'color': 'black', 'visibility': 'visible', 'clip-rule': 'nonzero', 'font-size': '16', 'opacity': '1', 'display': 'inline',
    'stop-color': 'black', 'stop-opacity': '1'
};

const SAMPLES = 16; // sub-scanlines per pixel

/**
 * @param {string|Uint8Array} source
 * @param {number} mode 1 = scale by size, 2 = fit width to size, 3 = fit height to size
 * @param {number} size
 * @return {{width: number, height: number, pixels: Uint8Array}}
 */
function render(source, mode, size) {
    if (typeof source !== 'string') source = new TextDecoder().decode(source);

    const root = parseXML(source).children.find(node => node.name === 'svg' && node.svg);
    if (!root) throw new Error('SVG: no <svg> element');

    const document = new Document(root);
    const viewBox = parseViewBox(root.attrs.viewBox);

    const lengthOf = (value, fallback) => {
        if (value === undefined || value === 'auto') return fallback;
        if (/%\s*$/.test(value)) return fallback * parseFloat(value) / 100;
        return parseLength(value, null, 16);
    };

    const width = lengthOf(root.attrs.width, viewBox ? viewBox[2] : 100);
    const height = lengthOf(root.attrs.height, viewBox ? viewBox[3] : 100);
    if (!(width > 0) || !(height > 0)) throw new Error('SVG: invalid dimensions');

    let outWidth, outHeight;
    if (mode === 2) {
        outWidth = Math.round(size);
        outHeight = Math.round(height * size / width);
    } else if (mode === 3) {
        outHeight = Math.round(size);
        outWidth = Math.round(width * size / height);
    } else {
        outWidth = Math.round(width * size);
        outHeight = Math.round(height * size);
    }

    outWidth = Math.max(1, outWidth);
    outHeight = Math.max(1, outHeight);

    const canvas = new Layer(outWidth, outHeight);

    let matrix0 = [outWidth / width, 0, 0, outHeight / height, 0, 0];
    // transform on the root element (SVG 2) applies before the viewBox mapping
    const rootStyle = document.computeStyle(root, null);
    if (rootStyle.transform) matrix0 = multiply(matrix0, parseTransform(rootStyle.transform));
    if (viewBox) matrix0 = multiply(matrix0, viewBoxTransform(viewBox, width, height, root.attrs.preserveAspectRatio));

    const viewport = viewBox ? { width: viewBox[2], height: viewBox[3] } : { width, height };
    document.renderNode(root, { matrix: matrix0, style: null, viewport, layer: canvas, depth: 0 }, true);

    return { width: outWidth, height: outHeight, pixels: canvas.toRGBA() };
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function parseXML(text) {
    const root = { name: '#root', attrs: {}, children: [], text: '', svg: false };
    const stack = [root];
    const namespaces = [{ '': SVG_NS }];
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

    // entities declared in the DOCTYPE may contain markup, expand them before parsing
    const doctype = /<!DOCTYPE[^[>]*\[([\s\S]*?)\]\s*>/i.exec(text);
    if (doctype) {
        const custom = {};
        for (const [, name, a, b] of doctype[1].matchAll(/<!ENTITY\s+([\w.-]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g))
            custom[name] = a !== undefined ? a : b;

        let rest = text.slice(doctype.index + doctype[0].length);
        for (let pass = 0; pass < 4; pass++)
            rest = rest.replace(/&([\w.-]+);/g, (match, name) => name in custom ? custom[name] : match);
        text = text.slice(0, doctype.index) + rest;
    }

    const decode = s => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z_][\w.-]*);/gi, (match, name) => {
        if (name[0] === '#') return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
        return name in entities ? entities[name] : match;
    });

    let i = 0;
    while (i < text.length) {
        if (text[i] !== '<') {
            const end = text.indexOf('<', i);
            stack[stack.length - 1].text += decode(text.slice(i, end === -1 ? text.length : end));
            i = end === -1 ? text.length : end;
            continue;
        }

        if (text.startsWith('<!--', i)) {
            const end = text.indexOf('-->', i + 4);
            i = end === -1 ? text.length : end + 3;
        } else if (text.startsWith('<![CDATA[', i)) {
            const end = text.indexOf(']]>', i);
            stack[stack.length - 1].text += text.slice(i + 9, end === -1 ? text.length : end);
            i = end === -1 ? text.length : end + 3;
        } else if (text.startsWith('<!', i)) {
            let depth = 0, j = i + 2;
            for (; j < text.length; j++) {
                if (text[j] === '[') depth++;
                else if (text[j] === ']') depth--;
                else if (text[j] === '>' && depth <= 0) break;
            }
            i = j + 1;
        } else if (text.startsWith('<?', i)) {
            const end = text.indexOf('?>', i);
            i = end === -1 ? text.length : end + 2;
        } else if (text.startsWith('</', i)) {
            const end = text.indexOf('>', i);
            if (stack.length > 1) {
                stack.pop();
                namespaces.pop();
            }
            i = end === -1 ? text.length : end + 1;
        } else {
            const match = /^<([^\s/>]+)/.exec(text.slice(i, i + 256));
            if (!match) {
                i++;
                continue;
            }

            const qualified = match[1];
            const node = { name: '', attrs: {}, children: [], text: '', svg: false };
            i += match[0].length;

            const attribute = /\s*([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;
            for (; ;) {
                if (/^\s*\/?>/.test(text.slice(i, i + 64))) break;
                attribute.lastIndex = i;
                const a = attribute.exec(text);
                if (!a) break;
                node.attrs[a[1]] = decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '');
                i = attribute.lastIndex;
            }

            // resolve the element's namespace
            const scope = Object.assign({}, namespaces[namespaces.length - 1]);
            for (const name in node.attrs) {
                if (name === 'xmlns') scope[''] = node.attrs[name];
                else if (name.startsWith('xmlns:')) scope[name.slice(6)] = node.attrs[name];
            }

            const colon = qualified.indexOf(':');
            const prefix = colon === -1 ? '' : qualified.slice(0, colon);
            node.name = colon === -1 ? qualified : qualified.slice(colon + 1);
            node.svg = scope[prefix] === SVG_NS;

            const close = /\s*(\/?)>/y;
            close.lastIndex = i;
            const end = close.exec(text);
            i = end ? close.lastIndex : text.length;

            stack[stack.length - 1].children.push(node);
            if (!end || !end[1]) {
                stack.push(node);
                namespaces.push(scope);
            }
        }
    }

    return root;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function parseStyleSheet(text) {
    const rules = [];
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');

    let order = 0;
    const blocks = /([^{}@]+)\{([^{}]*)\}|@[^{;]*(\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}|;)/g;
    for (const [, selectors, body] of text.matchAll(blocks)) {
        if (selectors === undefined) continue;
        const declarations = parseDeclarations(body);

        for (const selector of selectors.split(',')) {
            const parsed = parseSelector(selector.trim());
            if (parsed) rules.push({ ...parsed, order: order++, declarations });
        }
    }

    return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
}

// supports type, universal, class, id, attribute and :first-child selectors with descendant, child and sibling combinators
function parseSelector(selector) {
    const tokens = selector.match(/\s*[>+~]\s*|\s+|[^\s>+~]+/g);
    if (!tokens) return null;

    const compounds = [];
    let combinator = null;
    let specificity = 0;

    for (const token of tokens) {
        const trimmed = token.trim();
        if (!trimmed || trimmed === '>' || trimmed === '+' || trimmed === '~') {
            if (compounds.length) combinator = trimmed || ' ';
            continue;
        }

        const tests = [];
        const part = /([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]|:(first-child)|(.)/g;
        for (const m of trimmed.matchAll(part)) {
            if (m[10] !== undefined) return null;
            if (m[1]) {
                if (m[1] !== '*') {
                    tests.push(node => node.name === m[1]);
                    specificity += 1;
                }
            } else if (m[2]) {
                tests.push(node => node.attrs.id === m[2]);
                specificity += 100;
            } else if (m[3]) {
                tests.push(node => (node.attrs.class || '').split(/\s+/).includes(m[3]));
                specificity += 10;
            } else if (m[4]) {
                const name = m[4], op = m[5], value = m[6] !== undefined ? m[6] : m[7] !== undefined ? m[7] : m[8];
                tests.push(node => {
                    const v = node.attrs[name];
                    if (v === undefined) return false;
                    if (!op) return true;
                    if (op === '=') return v === value;
                    if (op === '~=') return v.split(/\s+/).includes(value);
                    if (op === '^=') return v.startsWith(value);
                    if (op === '$=') return v.endsWith(value);
                    if (op === '*=') return v.includes(value);
                    return v === value || v.startsWith(value + '-');
                });
                specificity += 10;
            } else if (m[9]) {
                tests.push(node => !node.parent || node.parent.children.find(c => c.name) === node);
                specificity += 10;
            }
        }

        compounds.push({ combinator: compounds.length ? combinator || ' ' : null, test: node => tests.every(t => t(node)) });
        combinator = null;
    }

    if (!compounds.length) return null;

    const matchAt = (node, index) => {
        if (!node || !compounds[index].test(node)) return false;
        if (index === 0) return true;

        const { combinator } = compounds[index];
        if (combinator === '>') return matchAt(node.parent, index - 1);
        if (combinator === '+' || combinator === '~') {
            const siblings = node.parent ? node.parent.children : [];
            const position = siblings.indexOf(node);
            if (combinator === '+') return matchAt(siblings[position - 1], index - 1);
            return siblings.slice(0, position).some(sibling => matchAt(sibling, index - 1));
        }
        for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent)
            if (matchAt(ancestor, index - 1)) return true;
        return false;
    };

    return { specificity, match: node => matchAt(node, compounds.length - 1) };
}

// returns {normal: {name: value}, important: {name: value}}
function parseDeclarations(text) {
    const declarations = { normal: {}, important: {} };
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');

    for (const part of text.split(';')) {
        const colon = part.indexOf(':');
        if (colon === -1) continue;
        const name = part.slice(0, colon).trim().toLowerCase();
        let value = part.slice(colon + 1).trim();
        const important = /!\s*important\s*$/i.test(value);
        if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
        if (name && value) (important ? declarations.important : declarations.normal)[name] = value;
    }

    return declarations;
}

// rejects values that would be ignored by the cascade
function validProperty(name, value) {
    switch (name) {
        case 'fill': case 'stroke':
            return value === 'none' || value === 'currentColor' || value === 'inherit' || /^context-(fill|stroke)$/.test(value)
                || /^url\(/.test(value) || parseColor(value) !== null;
        case 'color': case 'stop-color':
            return value === 'currentColor' || value === 'inherit' || parseColor(value) !== null;
        case 'opacity': case 'fill-opacity': case 'stroke-opacity': case 'stop-opacity':
            return value === 'inherit' || parseStrictNumber(value) !== null;
        default:
            return true;
    }
}

// ---------------------------------------------------------------------------
// document & rendering
// ---------------------------------------------------------------------------

class Document {
    constructor(root) {
        this.ids = new Map();
        this.active = new Set(); // clip paths and masks being rendered, to break reference cycles
        const styles = [];

        const walk = node => {
            if (node.attrs.id && !this.ids.has(node.attrs.id)) this.ids.set(node.attrs.id, node);
            if (node.name === 'style' && node.svg && (!node.attrs.type || node.attrs.type === 'text/css')) styles.push(node.text);
            for (const child of node.children) {
                child.parent = node;
                walk(child);
            }
        };
        walk(root);

        this.root = root;
        this.rules = parseStyleSheet(styles.join('\n'));
    }

    reference(value) {
        if (!value) return null;
        const match = /url\(\s*['"]?\s*#([^)'"]+?)\s*['"]?\s*\)/.exec(value) || /^\s*#(.+?)\s*$/.exec(value);
        return match ? this.ids.get(match[1]) || null : null;
    }

    href(node) {
        return node.attrs.href || node.attrs['xlink:href'];
    }

    // cascade: presentation attributes < style sheet rules < style attribute < !important rules < !important style attribute
    computeStyle(node, parent) {
        if (node.computed && node.computedParent === parent) return node.computed;

        const own = {};
        const apply = declarations => {
            for (const name in declarations) if (validProperty(name, declarations[name])) own[name] = declarations[name];
        };

        const presentation = {};
        for (const name in node.attrs) if (PROPERTIES.has(name)) presentation[name] = node.attrs[name];
        apply(presentation);

        const rules = this.rules.filter(rule => rule.match(node));
        const inline = node.attrs.style ? parseDeclarations(node.attrs.style) : null;
        for (const rule of rules) apply(rule.declarations.normal);
        if (inline) apply(inline.normal);
        for (const rule of rules) apply(rule.declarations.important);
        if (inline) apply(inline.important);

        const style = {};
        for (const name of PROPERTIES) {
            if (name === 'transform') continue;
            let value = own[name];
            if (value === 'inherit' || (value === undefined && INHERITED.has(name))) value = parent ? parent[name] : DEFAULTS[name];
            if (value === undefined || value === 'initial') value = DEFAULTS[name];
            style[name] = value === undefined ? undefined : String(value).trim();
        }

        // currentColor resolves to the color of the element using it
        style['mask-type'] = own['mask-type'] || node.attrs['mask-type'];
        style.transform = own.transform;
        node.computed = style;
        node.computedParent = parent;
        return style;
    }

    // style of an element inheriting along its document ancestors
    styleOf(node) {
        return this.computeStyle(node, node.parent && node.parent.name !== '#root' ? this.styleOf(node.parent) : null);
    }

    renderChildren(node, context) {
        for (const child of node.children) this.renderNode(child, context);
    }

    // conditional processing attributes, evaluated for an English user agent
    passesConditions(node) {
        if (node.attrs.requiredExtensions !== undefined) return false;
        const languages = node.attrs.systemLanguage;
        if (languages === undefined) return true;
        return languages.split(',').some(lang => {
            lang = lang.trim().toLowerCase();
            return lang === 'en' || lang.startsWith('en-');
        });
    }

    renderNode(node, context, root = false) {
        if (!node.svg || UNSUPPORTED.has(node.name) || context.depth > 32 || !this.passesConditions(node)) return;

        const style = this.computeStyle(node, context.style);
        if (style.display === 'none') return;

        let matrix = context.matrix;
        if (style.transform && !root) matrix = multiply(matrix, parseTransform(style.transform));

        const opacity = clamp01(parseNumber(style.opacity, 1));
        if (opacity <= 0) return;

        // missing and recursive references are ignored, references to other elements disable rendering
        const clip = this.reference(style['clip-path']);
        const mask = this.reference(style.mask);
        if ((clip && clip.name !== 'clipPath') || (mask && mask.name !== 'mask')) return;
        const clipping = clip && !this.active.has(clip);
        const masking = mask && !this.active.has(mask);

        const draw = layer => {
            const ctx = { ...context, matrix, style, layer, depth: context.depth + 1 };

            switch (node.name) {
                case 'svg': return root ? this.renderChildren(node, ctx) : this.renderNestedSvg(node, ctx);
                case 'g': case 'a': return this.renderChildren(node, ctx);
                case 'switch': {
                    const first = node.children.find(child => child.svg && SWITCHABLE.has(child.name) && this.passesConditions(child));
                    if (first) this.renderNode(first, ctx);
                    return;
                }
                case 'use': return this.renderUse(node, ctx);
                default: {
                    const path = shapePath(node, ctx.viewport, parseNumber(style['font-size'], 16));
                    if (path) this.paintPath(path, node, ctx);
                }
            }
        };

        if (opacity >= 1 && !clipping && !masking) return draw(context.layer);

        // render into a separate layer, then composite with opacity, clip path and mask
        const layer = new Layer(context.layer.width, context.layer.height);
        draw(layer);

        let alpha = null;
        if (clipping) alpha = this.clipMask(clip, node, matrix, context);
        if (masking) {
            const values = this.maskValues(mask, node, matrix, context);
            if (alpha) for (let i = 0; i < alpha.length; i++) alpha[i] *= values[i];
            else alpha = values;
        }

        context.layer.composite(layer, opacity, alpha);
    }

    // renders into a layer clipped to a rectangle in user space (viewports of nested svg and symbol elements)
    clipped(ctx, x, y, width, height, draw) {
        const layer = new Layer(ctx.layer.width, ctx.layer.height);
        draw(layer);

        const { width: w } = ctx.layer;
        const alpha = new Float32Array(w * ctx.layer.height);
        const coverage = rasterize([transformPoints([x, y, x + width, y, x + width, y + height, x, y + height], ctx.matrix)], false, w, ctx.layer.height);
        if (coverage)
            for (let row = 0; row < coverage.h; row++)
                for (let column = 0; column < coverage.w; column++)
                    alpha[(coverage.y0 + row) * w + coverage.x0 + column] = coverage.data[row * coverage.w + column];

        ctx.layer.composite(layer, 1, alpha);
    }

    renderNestedSvg(node, ctx) {
        const { viewport } = ctx;
        const x = parseLength(node.attrs.x, viewport, 16, 'x');
        const y = parseLength(node.attrs.y, viewport, 16, 'y');
        const width = node.attrs.width === undefined ? viewport.width : parseLength(node.attrs.width, viewport, 16, 'x');
        const height = node.attrs.height === undefined ? viewport.height : parseLength(node.attrs.height, viewport, 16, 'y');
        if (!(width > 0) || !(height > 0)) return;

        const viewBox = parseViewBox(node.attrs.viewBox);
        let matrix = multiply(ctx.matrix, [1, 0, 0, 1, x, y]);
        if (viewBox) matrix = multiply(matrix, viewBoxTransform(viewBox, width, height, node.attrs.preserveAspectRatio));

        const inner = { ...ctx, matrix, viewport: viewBox ? { width: viewBox[2], height: viewBox[3] } : { width, height } };
        if (/^(visible|auto)$/.test(node.attrs.overflow || '')) return this.renderChildren(node, inner);
        this.clipped(ctx, x, y, width, height, layer => this.renderChildren(node, { ...inner, layer }));
    }

    renderUse(node, ctx) {
        const target = this.reference(this.href(node));
        if (!target || ctx.depth > 24) return;

        // a use must not reference one of its ancestors
        for (let p = node; p; p = p.parent) if (p === target) return;

        const x = parseLength(node.attrs.x, ctx.viewport, 16, 'x');
        const y = parseLength(node.attrs.y, ctx.viewport, 16, 'y');
        const matrix = multiply(ctx.matrix, [1, 0, 0, 1, x, y]);

        if (target.name === 'symbol' || target.name === 'svg') {
            const style = this.computeStyle(target, ctx.style);
            if (style.display === 'none') return;

            const width = node.attrs.width !== undefined ? parseLength(node.attrs.width, ctx.viewport, 16, 'x')
                : target.attrs.width !== undefined ? parseLength(target.attrs.width, ctx.viewport, 16, 'x') : ctx.viewport.width;
            const height = node.attrs.height !== undefined ? parseLength(node.attrs.height, ctx.viewport, 16, 'y')
                : target.attrs.height !== undefined ? parseLength(target.attrs.height, ctx.viewport, 16, 'y') : ctx.viewport.height;
            if (!(width > 0) || !(height > 0)) return;

            const viewBox = parseViewBox(target.attrs.viewBox);
            let outer = matrix;
            if (target.name === 'svg') outer = multiply(outer, [1, 0, 0, 1, parseLength(target.attrs.x, ctx.viewport, 16, 'x'), parseLength(target.attrs.y, ctx.viewport, 16, 'y')]);
            const inner = viewBox ? multiply(outer, viewBoxTransform(viewBox, width, height, target.attrs.preserveAspectRatio)) : outer;

            const opacity = clamp01(parseNumber(style.opacity, 1));
            const innerContext = { ...ctx, matrix: inner, style, viewport: viewBox ? { width: viewBox[2], height: viewBox[3] } : { width, height } };
            const draw = layer => /^(visible|auto)$/.test(target.attrs.overflow || '')
                ? this.renderChildren(target, { ...innerContext, layer })
                : this.clipped({ ...ctx, matrix: outer, layer }, 0, 0, width, height, inner => this.renderChildren(target, { ...innerContext, layer: inner }));

            if (opacity >= 1) return draw(ctx.layer);
            const layer = new Layer(ctx.layer.width, ctx.layer.height);
            draw(layer);
            ctx.layer.composite(layer, opacity, null);
            return;
        }

        // render the referenced element as if it were a child of the use element
        const computed = target.computed, computedParent = target.computedParent;
        target.computed = null;
        this.renderNode(target, { ...ctx, matrix });
        target.computed = computed;
        target.computedParent = computedParent;
    }

    paintPath(path, node, ctx) {
        const { style, matrix, layer } = ctx;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return;

        const scale = Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])) || 1e-9;
        const tolerance = 0.1 / scale;
        const subpaths = flatten(path, tolerance);
        const bbox = boundingBox(subpaths);

        const fill = this.paint(style.fill, style, node, bbox, matrix, style['fill-opacity'], ctx);
        if (fill && node.name !== 'line') {
            const polygons = subpaths.map(points => transformPoints(points.points, matrix));
            const coverage = rasterize(polygons, style['fill-rule'] === 'evenodd', layer.width, layer.height);
            if (coverage) layer.fill(coverage, fill);
        }

        const stroke = this.paint(style.stroke, style, node, bbox, matrix, style['stroke-opacity'], ctx);
        const strokeWidth = parseLength(style['stroke-width'], ctx.viewport, 16, 'diagonal');
        if (stroke && strokeWidth > 0) {
            let lines = subpaths;
            const fontSize = parseNumber(style['font-size'], 16);
            const dashes = parseDashArray(style['stroke-dasharray'], ctx.viewport, fontSize);
            if (dashes) lines = dash(subpaths, dashes, parseLength(style['stroke-dashoffset'], ctx.viewport, fontSize, 'diagonal'));

            const polygons = strokePolygons(lines, strokeWidth / 2, style['stroke-linecap'], style['stroke-linejoin'],
                Math.max(1, parseNumber(style['stroke-miterlimit'], 4)), tolerance).map(points => transformPoints(points, matrix));
            const coverage = rasterize(polygons, false, layer.width, layer.height);
            if (coverage) layer.fill(coverage, stroke);
        }
    }

    // returns a paint function (x, y) => [r, g, b, a] in device pixels, or null for no paint
    paint(value, style, node, bbox, matrix, opacityValue, ctx) {
        if (!value || value === 'none') return null;
        const opacity = clamp01(parseNumber(opacityValue, 1));

        let color = value;
        if (/^url\(/.test(value)) {
            const server = this.reference(value);
            const fallback = value.replace(/^\s*url\([^)]*\)\s*/, '');
            if (server && (server.name === 'linearGradient' || server.name === 'radialGradient')) {
                const gradient = this.gradient(server, bbox, matrix, opacity, ctx);
                if (gradient !== undefined || !fallback) return gradient || null;
            }

            // missing, invalid or unsupported paint servers use the fallback color, if any
            color = fallback;
            if (!color || color === 'none') return null;
        }

        const parsed = parseColor(color === 'currentColor' ? style.color : color);
        if (!parsed || parsed[3] * opacity <= 0) return null;
        return solidPaint([parsed[0], parsed[1], parsed[2], parsed[3] * opacity]);
    }

    // collects gradient attributes and stops along href chains
    gradientAttributes(node) {
        const attrs = {};
        let stops = null;
        const geometry = node.name === 'linearGradient' ? ['x1', 'y1', 'x2', 'y2'] : ['cx', 'cy', 'r', 'fx', 'fy', 'fr'];

        for (let current = node, depth = 0; current && depth < 16; current = this.reference(this.href(current)), depth++) {
            if (current.name !== 'linearGradient' && current.name !== 'radialGradient') break;

            // geometry is only inherited from gradients of the same kind
            const names = current.name === node.name ? [...geometry, 'gradientUnits', 'gradientTransform', 'spreadMethod'] : ['gradientUnits', 'gradientTransform', 'spreadMethod'];
            for (const name of names)
                if (attrs[name] === undefined && current.attrs[name] !== undefined) attrs[name] = current.attrs[name];

            if (!stops) {
                const own = current.children.filter(child => child.name === 'stop');
                if (own.length) stops = own.map(stop => {
                    const style = this.styleOf(stop);
                    const offset = clamp01(parseStrictNumber(stop.attrs.offset) || 0);
                    const color = parseColor(style['stop-color'] === 'currentColor' ? style.color : style['stop-color']) || [0, 0, 0, 1];
                    return { offset, color: [color[0], color[1], color[2], color[3] * clamp01(parseNumber(style['stop-opacity'], 1))] };
                });
            }
        }

        return { attrs, stops: stops || [] };
    }

    gradient(node, bbox, matrix, opacity, ctx) {
        const { attrs, stops } = this.gradientAttributes(node);
        // undefined: invalid gradient, the fallback color is used if there is one
        if (!stops.length) return undefined;

        // offsets must be increasing
        for (let i = 1; i < stops.length; i++) stops[i].offset = Math.max(stops[i].offset, stops[i - 1].offset);

        if (stops.length === 1) {
            const c = stops[0].color;
            return c[3] * opacity > 0 ? solidPaint([c[0], c[1], c[2], c[3] * opacity]) : null;
        }

        const objectBox = attrs.gradientUnits !== 'userSpaceOnUse';
        if (objectBox && (!bbox || bbox.width <= 0 || bbox.height <= 0)) return null;

        const coordinate = (value, fallback, axis) => {
            if (value === undefined) return fallback;
            if (objectBox) return /%\s*$/.test(value) ? parseFloat(value) / 100 : parseNumber(value, fallback);
            return parseLength(value, ctx.viewport, 16, axis);
        };

        let gradientMatrix = matrix;
        if (objectBox) gradientMatrix = multiply(gradientMatrix, [bbox.width, 0, 0, bbox.height, bbox.x, bbox.y]);
        if (attrs.gradientTransform) gradientMatrix = multiply(gradientMatrix, parseTransform(attrs.gradientTransform));
        const inverse = invert(gradientMatrix);
        if (!inverse) return null;

        const spread = attrs.spreadMethod === 'reflect' ? 1 : attrs.spreadMethod === 'repeat' ? 2 : 0;
        const lookup = gradientLookup(stops, opacity);
        const color = t => {
            if (spread === 2) t -= Math.floor(t);
            else if (spread === 1) {
                t = Math.abs(t) % 2;
                if (t > 1) t = 2 - t;
            }
            return lookup[Math.round(clamp01(t) * 1023)];
        };

        if (node.name === 'linearGradient') {
            const x1 = coordinate(attrs.x1, 0, 'x'), y1 = coordinate(attrs.y1, 0, 'y');
            const x2 = coordinate(attrs.x2, objectBox ? 1 : ctx.viewport.width, 'x'), y2 = coordinate(attrs.y2, 0, 'y');
            const dx = x2 - x1, dy = y2 - y1;
            const length = dx * dx + dy * dy;
            if (length === 0) return this.lastStopPaint(stops, opacity);

            return (px, py) => {
                const x = inverse[0] * px + inverse[2] * py + inverse[4];
                const y = inverse[1] * px + inverse[3] * py + inverse[5];
                return color(((x - x1) * dx + (y - y1) * dy) / length);
            };
        }

        const cx = coordinate(attrs.cx, objectBox ? 0.5 : ctx.viewport.width / 2, 'x');
        const cy = coordinate(attrs.cy, objectBox ? 0.5 : ctx.viewport.height / 2, 'y');
        const r = coordinate(attrs.r, objectBox ? 0.5 : Math.hypot(ctx.viewport.width, ctx.viewport.height) / Math.SQRT2 / 2, 'diagonal');
        let fx = coordinate(attrs.fx, cx, 'x'), fy = coordinate(attrs.fy, cy, 'y');
        const fr = coordinate(attrs.fr, 0, 'diagonal');
        if (!(r > 0)) return this.lastStopPaint(stops, opacity);

        // keep the focal point inside the end circle
        const fd = Math.hypot(fx - cx, fy - cy);
        if (fd > r * 0.999) {
            fx = cx + (fx - cx) * r * 0.999 / fd;
            fy = cy + (fy - cy) * r * 0.999 / fd;
        }

        const cdx = cx - fx, cdy = cy - fy, dr = r - fr;
        const a = cdx * cdx + cdy * cdy - dr * dr;

        return (px, py) => {
            const x = inverse[0] * px + inverse[2] * py + inverse[4] - fx;
            const y = inverse[1] * px + inverse[3] * py + inverse[5] - fy;
            const b = x * cdx + y * cdy + fr * dr;
            const c = x * x + y * y - fr * fr;
            // solve |p - f - t (c - f)| = fr + t (r - fr) for the largest t with a non-negative radius
            let t;
            if (Math.abs(a) < 1e-9) t = c / (2 * b);
            else {
                const discriminant = b * b - a * c;
                if (discriminant < 0) return TRANSPARENT;
                const root = Math.sqrt(discriminant);
                const t1 = (b + root) / a, t2 = (b - root) / a;
                t = Math.max(t1, t2);
                if (fr + t * dr < 0) t = Math.min(t1, t2);
            }
            if (!isFinite(t) || fr + t * dr < 0) return TRANSPARENT;
            return color(t);
        };
    }

    lastStopPaint(stops, opacity) {
        const c = stops[stops.length - 1].color;
        return solidPaint([c[0], c[1], c[2], c[3] * opacity]);
    }

    // renders a clipPath into a coverage mask
    clipMask(clip, node, matrix, context) {
        const { width, height } = context.layer;
        const alpha = new Float32Array(width * height);
        const style = this.styleOf(clip);
        this.active.add(clip);

        let clipMatrix = matrix;
        if (style.transform) clipMatrix = multiply(clipMatrix, parseTransform(style.transform));
        if (clip.attrs.clipPathUnits === 'objectBoundingBox') {
            const path = shapePath(node, context.viewport, 16);
            const bbox = path ? boundingBox(flatten(path, 0.1)) : this.groupBoundingBox(node, context.viewport);
            if (!bbox || bbox.width <= 0 || bbox.height <= 0) return alpha;
            clipMatrix = multiply(clipMatrix, [bbox.width, 0, 0, bbox.height, bbox.x, bbox.y]);
        }

        for (const child of clip.children) {
            if (UNSUPPORTED.has(child.name) && child.name !== 'text') continue;
            const childStyle = this.computeStyle(child, style);
            if (childStyle.display === 'none' || childStyle.visibility === 'hidden') continue;

            let childMatrix = clipMatrix;
            if (childStyle.transform) childMatrix = multiply(childMatrix, parseTransform(childStyle.transform));

            let shape = child;
            if (child.name === 'use') {
                const target = this.reference(this.href(child));
                if (!target || !['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(target.name)) continue;
                childMatrix = multiply(childMatrix, [1, 0, 0, 1, parseLength(child.attrs.x, context.viewport, 16, 'x'), parseLength(child.attrs.y, context.viewport, 16, 'y')]);
                const targetStyle = this.computeStyle(target, childStyle);
                if (targetStyle.transform) childMatrix = multiply(childMatrix, parseTransform(targetStyle.transform));
                shape = target;
            }

            const path = shapePath(shape, context.viewport, 16);
            if (!path) continue;

            const scale = Math.sqrt(Math.abs(childMatrix[0] * childMatrix[3] - childMatrix[1] * childMatrix[2])) || 1e-9;
            const polygons = flatten(path, 0.1 / scale).map(points => transformPoints(points.points, childMatrix));
            const coverage = rasterize(polygons, this.computeStyle(shape, childStyle)['clip-rule'] === 'evenodd', width, height);
            if (!coverage) continue;

            // a child's own clip-path intersects with its shape
            const own = this.reference(childStyle['clip-path']);
            const ownMask = own && own.name === 'clipPath' && !this.active.has(own) ? this.clipMask(own, shape, childMatrix, context) : null;

            const { x0, y0, w, h, data } = coverage;
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                    let c = data[y * w + x];
                    const i = (y0 + y) * width + x0 + x;
                    if (ownMask) c *= ownMask[i];
                    alpha[i] = alpha[i] + c - alpha[i] * c;
                }
        }

        // the clipPath element itself may be clipped
        const nested = this.reference(style['clip-path']);
        if (nested && nested.name === 'clipPath' && !this.active.has(nested)) {
            const outer = this.clipMask(nested, node, matrix, context);
            for (let i = 0; i < alpha.length; i++) alpha[i] *= outer[i];
        }

        this.active.delete(clip);
        return alpha;
    }

    groupBoundingBox(node, viewport) {
        let box = null;
        const visit = (n, matrix) => {
            const path = shapePath(n, viewport, 16);
            if (path) {
                const points = flatten(path, 0.1).map(p => transformPoints(p.points, matrix));
                const b = boundingBox(points.map(p => ({ points: p })));
                if (b) box = box ? union(box, b) : b;
            }
            for (const child of n.children)
                visit(child, child.attrs.transform ? multiply(matrix, parseTransform(child.attrs.transform)) : matrix);
        };
        visit(node, [1, 0, 0, 1, 0, 0]);
        return box;
    }

    // renders a mask's content and returns its luminance times alpha
    maskValues(mask, node, matrix, context) {
        const { width, height } = context.layer;
        const values = new Float32Array(width * height);

        const path = shapePath(node, context.viewport, 16);
        const bbox = path ? boundingBox(flatten(path, 0.1)) : this.groupBoundingBox(node, context.viewport);
        const userSpace = mask.attrs.maskUnits === 'userSpaceOnUse';
        const contentBox = mask.attrs.maskContentUnits === 'objectBoundingBox';
        if ((!userSpace || contentBox) && (!bbox || bbox.width <= 0 || bbox.height <= 0)) return values;

        const region = (name, fallback, axis, origin, extent) => {
            const value = mask.attrs[name];
            if (userSpace) return value === undefined ? fallback * (axis === 'x' ? context.viewport.width : context.viewport.height) + (name === 'x' || name === 'y' ? 0 : 0) : parseLength(value, context.viewport, 16, axis);
            const v = value === undefined ? fallback : /%\s*$/.test(value) ? parseFloat(value) / 100 : parseNumber(value, fallback);
            return origin + v * extent;
        };

        const rx = region('x', -0.1, 'x', bbox ? bbox.x : 0, bbox ? bbox.width : 0);
        const ry = region('y', -0.1, 'y', bbox ? bbox.y : 0, bbox ? bbox.height : 0);
        const rw = userSpace ? (mask.attrs.width === undefined ? 1.2 * context.viewport.width : parseLength(mask.attrs.width, context.viewport, 16, 'x')) : region('width', 1.2, 'x', 0, bbox.width);
        const rh = userSpace ? (mask.attrs.height === undefined ? 1.2 * context.viewport.height : parseLength(mask.attrs.height, context.viewport, 16, 'y')) : region('height', 1.2, 'y', 0, bbox.height);

        const layer = new Layer(width, height);
        let contentMatrix = matrix;
        if (contentBox) contentMatrix = multiply(contentMatrix, [bbox.width, 0, 0, bbox.height, bbox.x, bbox.y]);
        const maskStyle = this.styleOf(mask);
        this.active.add(mask);
        this.renderChildren(mask, { ...context, matrix: contentMatrix, style: maskStyle, layer, depth: context.depth + 1 });
        const alphaMask = maskStyle['mask-type'] === 'alpha';

        // limit to the mask region
        const regionCoverage = rasterize([transformPoints([rx, ry, rx + rw, ry, rx + rw, ry + rh, rx, ry + rh], matrix)], false, width, height);
        if (!regionCoverage) {
            this.active.delete(mask);
            return values;
        }

        const { x0, y0, w, h, data } = regionCoverage;
        const d = layer.data;
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const i = (y0 + y) * width + x0 + x;
                // luminance of premultiplied color equals luminance * alpha
                values[i] = data[y * w + x] * (alphaMask ? d[i * 4 + 3] : 0.2125 * d[i * 4] + 0.7154 * d[i * 4 + 1] + 0.0721 * d[i * 4 + 2]);
            }

        // the mask element itself may be masked
        const nested = this.reference(maskStyle.mask);
        if (nested && nested.name === 'mask' && !this.active.has(nested)) {
            const outer = this.maskValues(nested, node, matrix, context);
            for (let i = 0; i < values.length; i++) values[i] *= outer[i];
        } else if (nested) values.fill(0);

        this.active.delete(mask);

        return values;
    }
}

const TRANSPARENT = [0, 0, 0, 0];

function solidPaint(color) {
    const paint = () => color;
    paint.solid = color;
    return paint;
}

function gradientLookup(stops, opacity) {
    const table = new Array(1024);
    for (let i = 0; i < 1024; i++) {
        const t = i / 1023;
        let k = 0;
        while (k < stops.length - 1 && stops[k + 1].offset < t) k++;

        let c;
        if (t <= stops[0].offset) c = stops[0].color;
        else if (k >= stops.length - 1) c = stops[stops.length - 1].color;
        else {
            const a = stops[k], b = stops[k + 1];
            const span = b.offset - a.offset;
            const f = span > 0 ? (t - a.offset) / span : 1;
            c = [0, 1, 2, 3].map(j => a.color[j] + (b.color[j] - a.color[j]) * f);
        }

        table[i] = [c[0], c[1], c[2], c[3] * opacity];
    }
    return table;
}

// premultiplied float RGBA surface
class Layer {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.data = new Float32Array(width * height * 4);
    }

    // composites a paint through a coverage mask (source over)
    fill({ x0, y0, w, h, data }, paint) {
        const d = this.data;
        const solid = paint.solid;

        for (let y = 0; y < h; y++) {
            let i = ((y0 + y) * this.width + x0) * 4;

            for (let x = 0, o = y * w; x < w; x++, o++, i += 4) {
                const c = data[o];
                if (c <= 0) continue;

                const color = solid || paint(x0 + x + 0.5, y0 + y + 0.5);
                const a = color[3] * c;
                if (a <= 0) continue;

                if (a >= 1) {
                    d[i] = color[0];
                    d[i + 1] = color[1];
                    d[i + 2] = color[2];
                    d[i + 3] = 1;

                    // extend runs of full coverage of a solid color by copying the pixel
                    if (solid) {
                        let run = 1;
                        while (x + run < w && data[o + run] >= 1) run++;
                        if (run > 1) {
                            for (let filled = 1; filled < run; filled *= 2)
                                d.copyWithin(i + filled * 4, i, i + Math.min(filled, run - filled) * 4);
                            x += run - 1;
                            o += run - 1;
                            i += (run - 1) * 4;
                        }
                    }
                    continue;
                }

                const inv = 1 - a;
                d[i] = color[0] * a + d[i] * inv;
                d[i + 1] = color[1] * a + d[i + 1] * inv;
                d[i + 2] = color[2] * a + d[i + 2] * inv;
                d[i + 3] = a + d[i + 3] * inv;
            }
        }
    }

    composite(layer, opacity, mask) {
        const s = layer.data, d = this.data;
        for (let p = 0, i = 0; p < this.width * this.height; p++, i += 4) {
            if (s[i + 3] <= 0) continue;
            const f = mask ? opacity * mask[p] : opacity;
            if (f <= 0) continue;

            const a = s[i + 3] * f;
            const inv = 1 - a;
            d[i] = s[i] * f + d[i] * inv;
            d[i + 1] = s[i + 1] * f + d[i + 1] * inv;
            d[i + 2] = s[i + 2] * f + d[i + 2] * inv;
            d[i + 3] = a + d[i + 3] * inv;
        }
    }

    toRGBA() {
        // clamped arrays round and clamp on assignment
        const out = new Uint8ClampedArray(this.width * this.height * 4);
        const d = this.data;
        for (let i = 0; i < d.length; i += 4) {
            const a = d[i + 3];
            if (a <= 0) continue;

            const f = a >= 1 ? 255 : 255 / a;
            out[i] = d[i] * f;
            out[i + 1] = d[i + 1] * f;
            out[i + 2] = d[i + 2] * f;
            out[i + 3] = a * 255;
        }
        return new Uint8Array(out.buffer);
    }
}

// ---------------------------------------------------------------------------
// rasterization
// ---------------------------------------------------------------------------

/**
 * Computes anti-aliased coverage of polygons with a nonzero or even-odd fill rule:
 * SAMPLES sub-scanlines per pixel row with exact horizontal span coverage
 * @param {Array<Array<number>>} polygons flat [x0, y0, x1, y1, ...] lists in device pixels, implicitly closed
 * @return {{x0: number, y0: number, w: number, h: number, data: Float32Array}|null}
 */
function rasterize(polygons, evenOdd, width, height) {
    const edges = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const points of polygons) {
        const n = points.length >> 1;
        if (n < 2) continue;

        for (let i = 0; i < n; i++) {
            const ax = points[i * 2], ay = points[i * 2 + 1];
            const j = (i + 1) % n;
            const bx = points[j * 2], by = points[j * 2 + 1];
            if (!isFinite(ax) || !isFinite(ay) || !isFinite(bx) || !isFinite(by) || ay === by) continue;

            const down = ay < by;
            const top = down ? ay : by, bottom = down ? by : ay;
            const topX = down ? ax : bx;
            edges.push({ top, bottom, x: topX, slope: (down ? bx - ax : ax - bx) / (bottom - top), dir: down ? 1 : -1 });

            minY = Math.min(minY, top);
            maxY = Math.max(maxY, bottom);
            minX = Math.min(minX, ax, bx);
            maxX = Math.max(maxX, ax, bx);
        }
    }

    if (!edges.length) return null;

    const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(width, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(height, Math.ceil(maxY));
    if (x0 >= x1 || y0 >= y1) return null;

    const w = x1 - x0, h = y1 - y0;
    const data = new Float32Array(w * h);
    const row = new Float32Array(w + 2);
    const steps = new Float32Array(w + 2);
    const weight = 1 / SAMPLES;

    edges.sort((a, b) => a.top - b.top);
    let next = 0;
    let active = [];
    const crossings = [];

    const span = (a, b) => {
        a = Math.max(a, x0) - x0;
        b = Math.min(b, x1) - x0;
        if (b <= a) return;

        const ia = Math.floor(a), ib = Math.floor(b);
        if (ia === ib) row[ia] += (b - a) * weight;
        else {
            row[ia] += (ia + 1 - a) * weight;
            steps[ia + 1] += weight;
            steps[ib] -= weight;
            row[ib] += (b - ib) * weight;
        }
    };

    for (let py = y0; py < y1; py++) {
        row.fill(0);
        steps.fill(0);

        while (next < edges.length && edges[next].top < py + 1) active.push(edges[next++]);
        active = active.filter(edge => edge.bottom > py);

        for (let s = 0; s < SAMPLES; s++) {
            const sy = py + (s + 0.5) / SAMPLES;
            crossings.length = 0;

            for (const edge of active)
                if (sy >= edge.top && sy < edge.bottom) crossings.push(edge.x + (sy - edge.top) * edge.slope, edge.dir);

            if (crossings.length < 4) continue;

            // insertion sort pairs by x
            for (let i = 2; i < crossings.length; i += 2) {
                const x = crossings[i], dir = crossings[i + 1];
                let j = i - 2;
                for (; j >= 0 && crossings[j] > x; j -= 2) {
                    crossings[j + 2] = crossings[j];
                    crossings[j + 3] = crossings[j + 1];
                }
                crossings[j + 2] = x;
                crossings[j + 3] = dir;
            }

            let winding = 0;
            for (let i = 0; i < crossings.length - 2; i += 2) {
                winding += crossings[i + 1];
                if (evenOdd ? winding & 1 : winding !== 0) span(crossings[i], crossings[i + 2]);
            }
        }

        let step = 0;
        const o = (py - y0) * w;
        for (let x = 0; x < w; x++) {
            step += steps[x];
            const v = row[x] + step;
            data[o + x] = v > 1 ? 1 : v;
        }
    }

    return { x0, y0, w, h, data };
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

// returns path commands (M/L/C/Z, absolute) for a basic shape or path element
function shapePath(node, viewport, fontSize) {
    const length = (name, axis, fallback = 0) => node.attrs[name] === undefined ? fallback : parseLength(node.attrs[name], viewport, fontSize, axis);

    switch (node.name) {
        case 'path':
            return parsePath(node.attrs.d || '');

        case 'rect': {
            const x = length('x', 'x'), y = length('y', 'y');
            const w = length('width', 'x'), h = length('height', 'y');
            if (!(w > 0) || !(h > 0)) return null;

            let rx = node.attrs.rx === undefined || node.attrs.rx === 'auto' ? undefined : length('rx', 'x');
            let ry = node.attrs.ry === undefined || node.attrs.ry === 'auto' ? undefined : length('ry', 'y');
            if (rx === undefined || rx < 0) rx = ry !== undefined && ry >= 0 ? ry : 0;
            if (ry === undefined || ry < 0) ry = rx;
            rx = Math.min(rx, w / 2);
            ry = Math.min(ry, h / 2);

            if (!rx || !ry) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];

            const k = 0.5522847498;
            return [
                ['M', x + rx, y], ['L', x + w - rx, y],
                ['C', x + w - rx + k * rx, y, x + w, y + ry - k * ry, x + w, y + ry], ['L', x + w, y + h - ry],
                ['C', x + w, y + h - ry + k * ry, x + w - rx + k * rx, y + h, x + w - rx, y + h], ['L', x + rx, y + h],
                ['C', x + rx - k * rx, y + h, x, y + h - ry + k * ry, x, y + h - ry], ['L', x, y + ry],
                ['C', x, y + ry - k * ry, x + rx - k * rx, y, x + rx, y], ['Z']
            ];
        }

        case 'circle': case 'ellipse': {
            const cx = length('cx', 'x'), cy = length('cy', 'y');
            let rx, ry;
            if (node.name === 'circle') rx = ry = length('r', 'diagonal');
            else {
                rx = node.attrs.rx === undefined || node.attrs.rx === 'auto' ? undefined : length('rx', 'x');
                ry = node.attrs.ry === undefined || node.attrs.ry === 'auto' ? undefined : length('ry', 'y');
                if (rx < 0) rx = undefined;
                if (ry < 0) ry = undefined;
                if (rx === undefined) rx = ry;
                if (ry === undefined) ry = rx;
            }
            if (!(rx > 0) || !(ry > 0)) return null;

            const k = 0.5522847498;
            return [
                ['M', cx + rx, cy],
                ['C', cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry],
                ['C', cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy],
                ['C', cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry],
                ['C', cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy],
                ['Z']
            ];
        }

        case 'line':
            return [['M', length('x1', 'x'), length('y1', 'y')], ['L', length('x2', 'x'), length('y2', 'y')]];

        case 'polyline': case 'polygon': {
            const numbers = parseNumberList(node.attrs.points || '');
            if (numbers.length < 4) return null;
            const path = [['M', numbers[0], numbers[1]]];
            for (let i = 2; i + 1 < numbers.length; i += 2) path.push(['L', numbers[i], numbers[i + 1]]);
            if (node.name === 'polygon') path.push(['Z']);
            return path;
        }
    }

    return null;
}

function parsePath(d) {
    const path = [];
    const tokens = /([MmZzLlHhVvCcSsQqTtAa])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
    // numbers stay strings so compact arc flags can be split later
    const items = [];
    for (const m of d.matchAll(tokens)) items.push(m[1] ? { command: m[1] } : m[2]);

    let i = 0, command = null;
    let x = 0, y = 0, sx = 0, sy = 0;
    let lastControlX = 0, lastControlY = 0, lastCommand = '';

    const number = () => typeof items[i] === 'string' ? parseFloat(items[i++]) : NaN;
    const flag = () => {
        // flags may be written without separators, e.g. "a1 1 0 00 1 1"
        const v = items[i];
        if (typeof v !== 'string' || (v[0] !== '0' && v[0] !== '1')) return NaN;
        if (v.length === 1) i++;
        else items[i] = v.slice(1);
        return +v[0];
    };

    while (i < items.length) {
        if (typeof items[i] === 'object') command = items[i++].command;
        else if (command === null) return path; // path data must start with a command
        else if (command === 'M') command = 'L';
        else if (command === 'm') command = 'l';
        else if (command === 'Z' || command === 'z') return path;

        const relative = command === command.toLowerCase();
        const ox = relative ? x : 0, oy = relative ? y : 0;
        const upper = command.toUpperCase();

        if (upper === 'Z') {
            path.push(['Z']);
            x = sx;
            y = sy;
            lastCommand = 'Z';
            continue;
        }

        if (!path.length && upper !== 'M') return path;

        if (upper === 'M') {
            const nx = number() + ox, ny = number() + oy;
            if (isNaN(nx) || isNaN(ny)) return path;
            x = sx = nx;
            y = sy = ny;
            path.push(['M', x, y]);
        } else if (upper === 'L') {
            const nx = number() + ox, ny = number() + oy;
            if (isNaN(nx) || isNaN(ny)) return path;
            x = nx;
            y = ny;
            path.push(['L', x, y]);
        } else if (upper === 'H') {
            const nx = number() + ox;
            if (isNaN(nx)) return path;
            x = nx;
            path.push(['L', x, y]);
        } else if (upper === 'V') {
            const ny = number() + oy;
            if (isNaN(ny)) return path;
            y = ny;
            path.push(['L', x, y]);
        } else if (upper === 'C' || upper === 'S') {
            let c1x, c1y;
            if (upper === 'S') {
                const smooth = lastCommand === 'C' || lastCommand === 'S';
                c1x = smooth ? 2 * x - lastControlX : x;
                c1y = smooth ? 2 * y - lastControlY : y;
            } else {
                c1x = number() + ox;
                c1y = number() + oy;
            }
            const c2x = number() + ox, c2y = number() + oy;
            const nx = number() + ox, ny = number() + oy;
            if ([c1x, c1y, c2x, c2y, nx, ny].some(isNaN)) return path;
            path.push(['C', c1x, c1y, c2x, c2y, nx, ny]);
            lastControlX = c2x;
            lastControlY = c2y;
            x = nx;
            y = ny;
        } else if (upper === 'Q' || upper === 'T') {
            let cx, cy;
            if (upper === 'T') {
                const smooth = lastCommand === 'Q' || lastCommand === 'T';
                cx = smooth ? 2 * x - lastControlX : x;
                cy = smooth ? 2 * y - lastControlY : y;
            } else {
                cx = number() + ox;
                cy = number() + oy;
            }
            const nx = number() + ox, ny = number() + oy;
            if ([cx, cy, nx, ny].some(isNaN)) return path;
            path.push(['C', x + 2 / 3 * (cx - x), y + 2 / 3 * (cy - y), nx + 2 / 3 * (cx - nx), ny + 2 / 3 * (cy - ny), nx, ny]);
            lastControlX = cx;
            lastControlY = cy;
            x = nx;
            y = ny;
        } else if (upper === 'A') {
            const rx = number(), ry = number(), rotation = number();
            const large = flag(), sweep = flag();
            const nx = number() + ox, ny = number() + oy;
            if ([rx, ry, rotation, large, sweep, nx, ny].some(isNaN)) return path;
            arcToCubics(path, x, y, rx, ry, rotation, large, sweep, nx, ny);
            x = nx;
            y = ny;
        } else return path;

        lastCommand = upper;
    }

    return path;
}

// SVG implementation notes F.6.5: endpoint to center parameterization, split into <= 90 degree cubic segments
function arcToCubics(path, x1, y1, rx, ry, rotation, large, sweep, x2, y2) {
    if (x1 === x2 && y1 === y2) return;
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (!rx || !ry) return path.push(['L', x2, y2]);

    const phi = rotation * Math.PI / 180;
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;

    const lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
    if (lambda > 1) {
        rx *= Math.sqrt(lambda);
        ry *= Math.sqrt(lambda);
    }

    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let coefficient = Math.sqrt(Math.max(0, num / den));
    if (large === sweep) coefficient = -coefficient;

    const cxp = coefficient * rx * y1p / ry, cyp = -coefficient * ry * x1p / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

    const angle = (ux, uy, vx, vy) => {
        const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        return a;
    };

    const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    else if (sweep && delta < 0) delta += 2 * Math.PI;

    const segments = Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9);
    const step = delta / segments;
    const k = 4 / 3 * Math.tan(step / 4);

    const point = t => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
    const derivative = t => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];

    let t = theta1;
    for (let i = 0; i < segments; i++) {
        const t2 = t + step;
        const [px, py] = point(t), [qx, qy] = i === segments - 1 ? [x2, y2] : point(t2);
        const [dpx, dpy] = derivative(t), [dqx, dqy] = derivative(t2);
        path.push(['C', px + k * dpx, py + k * dpy, qx - k * dqx, qy - k * dqy, qx, qy]);
        t = t2;
    }
}

// flattens path commands into polylines: [{points: [x, y, ...], closed}]
function flatten(path, tolerance) {
    const subpaths = [];
    let current = null;
    let x = 0, y = 0, sx = 0, sy = 0;

    const start = (px, py) => {
        current = { points: [px, py], closed: false };
        subpaths.push(current);
    };

    for (const command of path) {
        switch (command[0]) {
            case 'M':
                x = sx = command[1];
                y = sy = command[2];
                start(x, y);
                break;
            case 'L':
                if (!current) start(x, y);
                x = command[1];
                y = command[2];
                current.points.push(x, y);
                break;
            case 'C': {
                if (!current) start(x, y);
                const [, c1x, c1y, c2x, c2y, ex, ey] = command;
                const ddx = Math.max(Math.abs(x - 2 * c1x + c2x), Math.abs(c1x - 2 * c2x + ex));
                const ddy = Math.max(Math.abs(y - 2 * c1y + c2y), Math.abs(c1y - 2 * c2y + ey));
                const n = Math.min(512, Math.max(1, Math.ceil(Math.sqrt(0.75 * Math.hypot(ddx, ddy) / tolerance))));
                for (let i = 1; i <= n; i++) {
                    const t = i / n, mt = 1 - t;
                    current.points.push(
                        mt * mt * mt * x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * ex,
                        mt * mt * mt * y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * ey
                    );
                }
                x = ex;
                y = ey;
                break;
            }
            case 'Z':
                if (current) {
                    current.closed = true;
                    x = sx;
                    y = sy;
                    current = null;
                }
                break;
        }
    }

    return subpaths;
}

function boundingBox(subpaths) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { points } of subpaths)
        for (let i = 0; i < points.length; i += 2) {
            minX = Math.min(minX, points[i]);
            maxX = Math.max(maxX, points[i]);
            minY = Math.min(minY, points[i + 1]);
            maxY = Math.max(maxY, points[i + 1]);
        }
    return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function union(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function transformPoints(points, m) {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i += 2) {
        const x = points[i], y = points[i + 1];
        out[i] = m[0] * x + m[2] * y + m[4];
        out[i + 1] = m[1] * x + m[3] * y + m[5];
    }
    return out;
}

// splits polylines into dashes
function dash(subpaths, pattern, offset) {
    const total = pattern.reduce((a, b) => a + b, 0);
    const result = [];

    for (const { points, closed } of subpaths) {
        const pts = closed ? [...points, points[0], points[1]] : points;

        let index = 0;
        let remaining = ((offset % total) + total) % total;
        while (remaining >= pattern[index]) {
            remaining -= pattern[index];
            index = (index + 1) % pattern.length;
        }
        remaining = pattern[index] - remaining;

        let on = index % 2 === 0;
        let current = on ? [pts[0], pts[1]] : null;

        for (let i = 0; i + 3 < pts.length; i += 2) {
            let ax = pts[i], ay = pts[i + 1];
            const bx = pts[i + 2], by = pts[i + 3];
            let length = Math.hypot(bx - ax, by - ay);

            while (length > 0) {
                if (remaining >= length) {
                    remaining -= length;
                    if (on) current.push(bx, by);
                    length = 0;
                } else {
                    const t = remaining / length;
                    const mx = ax + (bx - ax) * t, my = ay + (by - ay) * t;
                    if (on) {
                        current.push(mx, my);
                        result.push({ points: current, closed: false });
                        current = null;
                    } else current = [mx, my];
                    on = !on;
                    length -= remaining;
                    ax = mx;
                    ay = my;
                    index = (index + 1) % pattern.length;
                    remaining = pattern[index];
                }
            }
        }

        if (on && current && current.length >= 4) result.push({ points: current, closed: false });
    }

    return result;
}

// builds fill polygons (counter-clockwise, to be filled nonzero) for stroked polylines
function strokePolygons(subpaths, halfWidth, cap, join, miterLimit, tolerance) {
    const polygons = [];
    const add = polygon => {
        let area = 0;
        for (let i = 0, n = polygon.length; i < n; i += 2) {
            const j = (i + 2) % n;
            area += polygon[i] * polygon[j + 1] - polygon[j] * polygon[i + 1];
        }
        if (area < 0) {
            const reversed = [];
            for (let i = polygon.length - 2; i >= 0; i -= 2) reversed.push(polygon[i], polygon[i + 1]);
            polygon = reversed;
        }
        polygons.push(polygon);
    };

    const circleSegments = Math.max(8, Math.min(256, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tolerance / halfWidth)))));
    const circle = (cx, cy) => {
        const polygon = [];
        for (let i = 0; i < circleSegments; i++) {
            const a = i / circleSegments * 2 * Math.PI;
            polygon.push(cx + Math.cos(a) * halfWidth, cy + Math.sin(a) * halfWidth);
        }
        add(polygon);
    };

    for (const { points: raw, closed } of subpaths) {
        // drop consecutive duplicate points
        const points = [raw[0], raw[1]];
        for (let i = 2; i < raw.length; i += 2)
            if (Math.abs(raw[i] - points[points.length - 2]) > 1e-9 || Math.abs(raw[i + 1] - points[points.length - 1]) > 1e-9) points.push(raw[i], raw[i + 1]);
        if (closed && points.length > 4 && Math.abs(points[0] - points[points.length - 2]) < 1e-9 && Math.abs(points[1] - points[points.length - 1]) < 1e-9)
            points.length -= 2;

        const n = points.length >> 1;
        if (n === 1) {
            // zero length subpaths only produce caps
            const [x, y] = points;
            if (cap === 'round') circle(x, y);
            else if (cap === 'square') add([x - halfWidth, y - halfWidth, x + halfWidth, y - halfWidth, x + halfWidth, y + halfWidth, x - halfWidth, y + halfWidth]);
            continue;
        }

        const segmentCount = closed ? n : n - 1;
        const directions = [];
        for (let i = 0; i < segmentCount; i++) {
            const ax = points[i * 2], ay = points[i * 2 + 1];
            const j = (i + 1) % n;
            const dx = points[j * 2] - ax, dy = points[j * 2 + 1] - ay;
            const length = Math.hypot(dx, dy);
            directions.push([dx / length, dy / length]);

            const nx = -dy / length * halfWidth, ny = dx / length * halfWidth;
            const bx = points[j * 2], by = points[j * 2 + 1];
            add([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]);
        }

        // joins between consecutive segments
        for (let i = closed ? 0 : 1; i < (closed ? segmentCount : n - 1); i++) {
            const prev = directions[(i - 1 + segmentCount) % segmentCount], next = directions[i % segmentCount];
            const vx = points[i * 2], vy = points[i * 2 + 1];
            const cross = prev[0] * next[1] - prev[1] * next[0];
            const dot = prev[0] * next[0] + prev[1] * next[1];
            if (Math.abs(cross) < 1e-9 && dot > 0) continue;

            if (join === 'round') {
                circle(vx, vy);
                continue;
            }

            // the outer side of the turn
            const side = cross > 0 ? -1 : 1;
            const ax = vx + side * -prev[1] * halfWidth, ay = vy + side * prev[0] * halfWidth;
            const bx = vx + side * -next[1] * halfWidth, by = vy + side * next[0] * halfWidth;

            const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
            const ratio = 1 / Math.sin((Math.PI - theta) / 2);
            if ((join === 'miter' || join === 'miter-clip' || join === 'arcs') && ratio <= miterLimit && Math.abs(cross) > 1e-9) {
                // intersection of the two offset lines
                const t = ((bx - ax) * next[1] - (by - ay) * next[0]) / (prev[0] * next[1] - prev[1] * next[0]);
                add([vx, vy, ax, ay, ax + prev[0] * t, ay + prev[1] * t, bx, by]);
            } else add([vx, vy, ax, ay, bx, by]);
        }

        if (!closed) {
            for (const [index, direction, sign] of [[0, directions[0], -1], [n - 1, directions[segmentCount - 1], 1]]) {
                const x = points[index * 2], y = points[index * 2 + 1];
                if (cap === 'round') circle(x, y);
                else if (cap === 'square') {
                    const dx = direction[0] * halfWidth * sign, dy = direction[1] * halfWidth * sign;
                    const nx = -direction[1] * halfWidth, ny = direction[0] * halfWidth;
                    add([x + nx, y + ny, x + nx + dx, y + ny + dy, x - nx + dx, y - ny + dy, x - nx, y - ny]);
                }
            }
        }
    }

    return polygons;
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

function multiply(a, b) {
    return [
        a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
    ];
}

function invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det || !isFinite(det)) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

function parseTransform(value) {
    let matrix = [1, 0, 0, 1, 0, 0];
    const functions = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;

    for (const [, name, args] of value.matchAll(functions)) {
        const a = parseNumberList(args);
        let m;
        switch (name) {
            case 'matrix': if (a.length !== 6) return [1, 0, 0, 1, 0, 0]; m = a; break;
            case 'translate': m = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
            case 'scale': m = [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0]; break;
            case 'rotate': {
                const r = (a[0] || 0) * Math.PI / 180;
                const cos = Math.cos(r), sin = Math.sin(r);
                m = [cos, sin, -sin, cos, 0, 0];
                if (a.length === 3) m = multiply(multiply([1, 0, 0, 1, a[1], a[2]], m), [1, 0, 0, 1, -a[1], -a[2]]);
                break;
            }
            case 'skewX': m = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0]; break;
            case 'skewY': m = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0]; break;
        }
        if (m.some(v => !isFinite(v))) return [1, 0, 0, 1, 0, 0];
        matrix = multiply(matrix, m);
    }

    return matrix;
}

function parseViewBox(value) {
    if (!value) return null;
    const v = parseNumberList(value);
    return v.length === 4 && v[2] > 0 && v[3] > 0 ? v : null;
}

function viewBoxTransform([vx, vy, vw, vh], width, height, preserve = 'xMidYMid meet') {
    const parts = preserve.trim().split(/\s+/);
    const align = parts[0] === 'defer' ? parts[1] : parts[0];
    const slice = parts[parts.length - 1] === 'slice';

    let sx = width / vw, sy = height / vh;
    if (align === 'none') return [sx, 0, 0, sy, -vx * sx, -vy * sy];

    sx = sy = slice ? Math.max(sx, sy) : Math.min(sx, sy);
    let tx = -vx * sx, ty = -vy * sy;
    const extraX = width - vw * sx, extraY = height - vh * sy;

    if (/xMid/.test(align)) tx += extraX / 2;
    else if (/xMax/.test(align)) tx += extraX;
    if (/YMid/.test(align)) ty += extraY / 2;
    else if (/YMax/.test(align)) ty += extraY;
    if (!/^x(Min|Mid|Max)Y(Min|Mid|Max)$/.test(align)) {
        tx = -vx * sx + extraX / 2;
        ty = -vy * sy + extraY / 2;
    }

    return [sx, 0, 0, sy, tx, ty];
}

const UNITS = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

function parseLength(value, viewport, fontSize = 16, axis = 'x') {
    if (value === undefined || value === null) return 0;
    const match = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/.exec(String(value));
    if (!match) return 0;

    const number = parseFloat(match[1]);
    const unit = match[2];
    if (!unit) return number;
    if (unit === 'em') return number * fontSize;
    if (unit === 'ex') return number * fontSize / 2;
    if (unit === '%') {
        if (!viewport) return 0;
        const reference = axis === 'x' ? viewport.width : axis === 'y' ? viewport.height
            : Math.hypot(viewport.width, viewport.height) / Math.SQRT2;
        return number / 100 * reference;
    }
    return number * UNITS[unit];
}

function parseNumber(value, fallback) {
    const v = parseStrictNumber(value);
    return v === null ? fallback : v;
}

// a number or percentage (as a fraction), null for anything else
function parseStrictNumber(value) {
    if (value === undefined || value === null) return null;
    const match = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(%?)\s*$/.exec(String(value));
    if (!match) return null;
    return match[2] ? parseFloat(match[1]) / 100 : parseFloat(match[1]);
}

function parseNumberList(value) {
    return [...String(value).matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)].map(m => parseFloat(m[0]));
}

function parseDashArray(value, viewport, fontSize) {
    if (!value || value === 'none') return null;
    let dashes = value.split(/[\s,]+/).filter(Boolean).map(v => parseLength(v, viewport, fontSize, 'diagonal'));
    if (!dashes.length || dashes.some(d => d < 0 || isNaN(d))) return null;
    if (dashes.length % 2) dashes = [...dashes, ...dashes];
    return dashes.reduce((a, b) => a + b, 0) > 0 ? dashes : null;
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

// returns [r, g, b, a] with components in [0, 1], or null
function parseColor(value) {
    if (!value) return null;
    value = value.trim().toLowerCase();
    if (value === 'transparent') return [0, 0, 0, 0];

    let match = /^#([0-9a-f]{3,8})$/.exec(value);
    if (match) {
        const hex = match[1];
        if (hex.length === 3 || hex.length === 4) return [...hex].map((c, i) => parseInt(c + c, 16) / 255).concat(hex.length === 3 ? [1] : []);
        if (hex.length === 6 || hex.length === 8) return [0, 2, 4, 6].slice(0, hex.length / 2).map(i => parseInt(hex.slice(i, i + 2), 16) / 255).concat(hex.length === 6 ? [1] : []);
        return null;
    }

    match = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(value);
    if (match) {
        const parts = match[2].split(/\s*[,/]\s*|\s+/).filter(Boolean);
        if (parts.length < 3) return null;
        const alpha = parts.length > 3 ? clamp01(parseNumber(parts[3], 1)) : 1;

        if (match[1].startsWith('rgb')) {
            const channel = p => clamp01(/%$/.test(p) ? parseFloat(p) / 100 : parseFloat(p) / 255);
            return [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
        }

        const h = (((parseFloat(parts[0]) % 360) + 360) % 360) / 360;
        const s = clamp01(parseFloat(parts[1]) / 100), l = clamp01(parseFloat(parts[2]) / 100);
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        const hue = t => {
            t = (t + 1) % 1;
            return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
        };
        return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3), alpha];
    }

    const named = NAMED_COLORS[value];
    return named === undefined ? null : [(named >> 16 & 255) / 255, (named >> 8 & 255) / 255, (named & 255) / 255, 1];
}

const NAMED_COLORS = {
    aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4, azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4,
    black: 0x000000, blanchedalmond: 0xffebcd, blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a, burlywood: 0xdeb887, cadetblue: 0x5f9ea0,
    chartreuse: 0x7fff00, chocolate: 0xd2691e, coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c, cyan: 0x00ffff,
    darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b,
    darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc, darkred: 0x8b0000, darksalmon: 0xe9967a,
    darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3,
    deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969, dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0,
    forestgreen: 0x228b22, fuchsia: 0xff00ff, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700, goldenrod: 0xdaa520, gray: 0x808080,
    grey: 0x808080, green: 0x008000, greenyellow: 0xadff2f, honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c, indigo: 0x4b0082,
    ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa, lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6,
    lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3, lightgreen: 0x90ee90, lightgrey: 0xd3d3d3,
    lightpink: 0xffb6c1, lightsalmon: 0xffa07a, lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899,
    lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32, linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000,
    mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371,
    mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585, midnightblue: 0x191970,
    mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5, navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6, olive: 0x808000,
    olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500, orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98,
    paleturquoise: 0xafeeee, palevioletred: 0xdb7093, papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd,
    powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399, red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513,
    salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57, seashell: 0xfff5ee, sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb,
    slateblue: 0x6a5acd, slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f, steelblue: 0x4682b4, tan: 0xd2b48c,
    teal: 0x008080, thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3, white: 0xffffff,
    whitesmoke: 0xf5f5f5, yellow: 0xffff00, yellowgreen: 0x9acd32
};

module.exports = { render };
