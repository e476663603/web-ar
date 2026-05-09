const config = {
  projectName: 'web-ar',
  date: '2024-01-01',
  designWidth: 375,
  deviceRatio: {
    375: 1,
    750: 0.5
  },
  sourceRoot: 'src',
  outputRoot: 'dist',
  plugins: [],
  defineConstants: {},
  copy: {
    patterns: [
      { from: 'src/assets/ar/', to: 'dist/assets/ar/' }
    ],
    options: {}
  },
  framework: 'react',
  compiler: 'webpack5',
  cache: {
    enable: false
  },
  h5: {
    publicPath: './',
    staticDirectory: 'static',
    esnextModules: ['three'],
    webpackChain(chain) {
      chain.resolve.set('fallback', {
        util: false,
        fs: false,
        path: false,
        crypto: false,
        stream: false,
        buffer: false,
        worker_threads: false,
        'node-fetch': false,
        'string_decoder': false
      })
    },
    postcss: {
      pxtransform: {
        enable: false
      },
      autoprefixer: {
        enable: true,
        config: {}
      },
      cssModules: {
        enable: false,
        config: {
          namingPattern: 'module',
          generateScopedName: '[name]__[local]___[hash:base64:5]'
        }
      }
    },
    router: {
      mode: 'hash'
    },
    devServer: {
      port: 10086,
      https: true
    }
  }
}

module.exports = function (merge) {
  if (process.env.NODE_ENV === 'development') {
    return merge({}, config, require('./dev'))
  }
  return merge({}, config, require('./prod'))
}
