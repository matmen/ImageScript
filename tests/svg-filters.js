const panic = message => {
    console.error(message);
    process.exit(1);
};

// resvg's filter test cases (tests/svgs/resvg/filters) but the primitives' (see svg-primitives.js): regions, units,
// references, filter functions, flood colors; compared like in svg.js
(async () => {
    await require('./util/resvg')(file => file.startsWith('filters/') && !file.startsWith('filters/fe'), panic);
})();
