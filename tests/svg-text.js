const panic = message => {
    console.error(message);
    process.exit(1);
};

// resvg's text test cases (tests/svgs/resvg/text) with its test fonts: chunks, spans, positions, anchors, spacing,
// baselines, decorations, text paths, vertical text, bidi, fallback fonts and color glyphs; compared like in svg.js
(async () => {
    await require('./util/resvg')(file => file.startsWith('text/'), panic);
})();
