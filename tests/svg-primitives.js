const panic = message => {
    console.error(message);
    process.exit(1);
};

// resvg's test cases of the filter primitives (tests/svgs/resvg/filters/fe*), compared like in svg.js
(async () => {
    await require('./util/resvg')(file => file.startsWith('filters/fe'), panic);
})();
