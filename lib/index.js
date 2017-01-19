const assign = require('lodash').assign;
const dirname = require('path').dirname;
const genericNames = require('generic-names');
const globToRegex = require('glob-to-regexp');
const identity = require('lodash').identity;
const negate = require('lodash').negate;
const camelCaseFunc = require('lodash').camelCase;
const mapKeys = require('lodash').mapKeys;
const readFileSync = require('fs').readFileSync;
const relative = require('path').relative;
const resolve = require('path').resolve;
const validate = require('./validate');

const postcss = require('postcss');
const Values = require('postcss-modules-values');
const LocalByDefault = require('postcss-modules-local-by-default');
const ExtractImports = require('postcss-modules-extract-imports');
const Scope = require('postcss-modules-scope');
const Parser = require('postcss-modules-parser');

const debugFetch = require('debug')('css-modules:fetch');
const debugTokens = require('debug')('css-modules:tokens');
const debugSetup = require('debug')('css-modules:setup');

module.exports = function setupHook({
  devMode,
  extensions = '.css',
  ignore,
  preprocessCss = identity,
  processCss,
  processTokens,
  processorOpts,
  camelCase,
  append = [],
  prepend = [],
  createImportedName,
  generateScopedName,
  hashPrefix,
  mode,
  use,
  rootDir: context = process.cwd(),
}) {
  debugSetup(arguments[0]);
  validate(arguments[0]);

  const tokensByFile = {};

  // debug option is preferred NODE_ENV === 'development'
  const debugMode = typeof devMode !== 'undefined'
    ? devMode
    : process.env.NODE_ENV === 'development';

  let scopedName;
  if (generateScopedName) {
    scopedName = typeof generateScopedName !== 'function'
      ? genericNames(generateScopedName, {context, hashPrefix}) //  for example '[name]__[local]___[hash:base64:5]'
      : generateScopedName;
  } else {
    // small fallback
    scopedName = (local, filename) => {
      return Scope.generateScopedName(local, relative(context, filename));
    };
  }

  const plugins = (use || [
    ...prepend,
    Values,
    mode
      ? new LocalByDefault({mode})
      : LocalByDefault,
    createImportedName
      ? new ExtractImports({createImportedName})
      : ExtractImports,
    new Scope({generateScopedName: scopedName}),
    ...append,
  ]).concat(new Parser({fetch})); // no pushing in order to avoid the possible mutations;

  // https://github.com/postcss/postcss#options
  const runner = postcss(plugins);

  /**
   * @param  {string} _to
   * @param  {string} from
   * @return {string}
   */
  function resolveFilename(_to, from) {
    // getting absolute path to the processing file
    return /[^\\/?%*:|"<>\.]/i.test(_to[0])
      ? require.resolve(_to)
      : resolve(dirname(from), _to);
  }

  /**
   * @todo   think about replacing sequential fetch function calls with requires calls
   * @param  {string} _to
   * @param  {string} from
   * @return {object}
   */
  function fetch(_to, from) {
    const filename = resolveFilename(_to, from);

    // checking cache
    let tokens = tokensByFile[filename];
    if (tokens) {
      debugFetch(`${filename} → cache`);
      debugTokens(tokens);
      return tokens;
    }

    debugFetch(`${filename} → fs`);

    const source = preprocessCss(readFileSync(filename, 'utf8'), filename);
    // https://github.com/postcss/postcss/blob/master/docs/api.md#processorprocesscss-opts
    const lazyResult = runner.process(source, assign({}, processorOpts, {from: filename}));

    // https://github.com/postcss/postcss/blob/master/docs/api.md#lazywarnings
    lazyResult.warnings().forEach(message => console.warn(message.text));

    tokens = lazyResult.root.tokens;

    if (camelCase) {
      tokens = assign(mapKeys(tokens, (value, key) => camelCaseFunc(key)), tokens);
    }

    if (processCss) {
      processCss(lazyResult.css, filename);
    }

    if (processTokens) {
      tokens = processTokens(tokens, filename, lazyResult);
    }

    if (!debugMode) {
      // updating cache
      tokensByFile[filename] = tokens;
    } else {
      // clearing cache in development mode
      delete require.cache[filename];
    }

    debugTokens(tokens);

    return tokens;
  };

  /**
   * @param filename
   */
  function fetchProxy(filename) {
    // Don't actually process the file until it is used, return a proxy instead
    return new Proxy({}, {
      get: (target, name) => {
        // Process the file now that an object property is being accessed
        if (typeof name === 'symbol' && String(name) === 'Symbol(util.inspect.custom)') {
          // Special case: util.inspect is used eg. when transforming in console.log
          return target.cache || tokensByFile[filename] || fetch(filename, filename);
        }

        if (target[name]) {
          // Custom defined property from setter
          return target[name];
        } else if (target.cache && target.cache[name]) {
          // Debug mode proxy cache
          return target.cache[name];
        } else if (!tokensByFile[filename]) {
          // Process this file for the first time
          const tokens = fetch(filename, filename);

          // In debug mode, every prop access would result in reprocessing, so we use a proxy cache
          if (debugMode) {
            target.cache = tokens;
          }

          return tokens[name];
        }

        return tokensByFile[filename][name];
      },
      set: (target, name, value, receiver) => {
        target[name] = value;
        return true;
      }
    });
  }

  const exts = toArray(extensions);
  const isException = buildExceptionChecker(ignore);

  // @todo add possibility to specify particular config for each extension
  exts.forEach(extension => {
    const existingHook = require.extensions[extension];

    require.extensions[extension] = function cssModulesHook(module, filename) {
      if (isException(filename)) {
        existingHook(m, filename);
      } else {
        const fullFilename = resolveFilename(filename, filename);
        debugFetch(`${filename} → require`);

        // Cache the CSS proxy for the compiled code below
        const ccc = fetchProxy(fullFilename);
        require.cache[`${filename}.proxy`] = ccc;

        // Compile another proxy to be exported, so that we can use the CSS proxy
        module._compile(
            `
          module.exports = new Proxy({filename: ${JSON.stringify(fullFilename)}}, {
            get: (target, name) => {
              if (name === '__esModule') {
                return target.__esModule;
              }
              return require.cache[\`\${target.filename}.proxy\`][name];
            }
          })
          `,
            filename
        );
      }
    };
  });
};

/**
 * @param  {*} option
 * @return {array}
 */
function toArray(option) {
  return Array.isArray(option)
    ? option
    : [option];
}

/**
 * @param  {function|regex|string} ignore glob, regex or function
 * @return {function}
 */
function buildExceptionChecker(ignore) {
  if (ignore instanceof RegExp) {
    return filepath => ignore.test(filepath);
  }

  if (typeof ignore === 'string') {
    return filepath => globToRegex(ignore).test(filepath);
  }

  return ignore || negate(identity);
}
