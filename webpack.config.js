const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = (env = {}) => {
  const target = env.target || 'main';

  const mainConfig = {
    mode: env.mode || 'development',
    target: 'electron-main',
    entry: './src/main/main.ts',
    output: {
      path: path.resolve(__dirname, 'dist/main'),
      filename: 'main.js',
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
      ],
    },
    externals: {
      'electron': 'commonjs electron',
      'electron-store': 'commonjs electron-store',
      'puppeteer-core': 'commonjs puppeteer-core',
      'better-sqlite3': 'commonjs better-sqlite3',
    },
    node: {
      __dirname: false,
      __filename: false,
    },
  };

  const preloadConfig = {
    mode: env.mode || 'development',
    target: 'electron-preload',
    entry: './src/preload/preload.ts',
    output: {
      path: path.resolve(__dirname, 'dist/preload'),
      filename: 'preload.js',
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
      ],
    },
    externals: {
      'electron': 'commonjs electron',
    },
    node: {
      __dirname: false,
      __filename: false,
    },
  };

  const rendererConfig = {
    mode: env.mode || 'development',
    target: 'web',
    entry: './src/renderer/index.tsx',
    output: {
      path: path.resolve(__dirname, 'dist/renderer'),
      filename: 'renderer.js',
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/renderer/index.html',
      }),
    ],
    devServer: {
      port: 9000,
      static: path.resolve(__dirname, 'dist/renderer'),
    },
  };

  if (target === 'main') {
    return [mainConfig, preloadConfig];
  }
  return rendererConfig;
};
