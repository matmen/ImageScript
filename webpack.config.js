const path = require('path');

module.exports = {
	entry: './ImageScript.js',
	output: {
		library: 'ImageScript',
		libraryTarget: 'umd',
		path: path.resolve('./browser'),
		filename: 'ImageScript.js'
	},
	devtool: 'source-map'
};
