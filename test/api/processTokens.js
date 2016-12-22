const detachHook = require('../sugar').detachHook;
const dropCache = require('../sugar').dropCache;
const identity = require('lodash').identity;

suite('api/processTokens()', () => {
  const processTokens = spy(identity);

  test('should be called', () => assert(processTokens.called));

  setup(() => {
    hook({processTokens});
    require('./fixture/oceanic.css');
  });

  teardown(() => {
    detachHook('.css');
    dropCache('./api/fixture/oceanic.css');
  });
});
