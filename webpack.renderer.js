const path = require('path');

module.exports = {
  mode: 'development',
  entry: './src/renderer/app.ts',
  target: 'web',
  devtool: 'source-map',
  module: {
    rules: [{
      test: /\.ts$/,
      use: 'ts-loader',
      exclude: /node_modules/,
    }],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: 'app.js',
    path: path.resolve(__dirname, 'dist/renderer'),
  },
};