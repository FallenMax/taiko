const debug = require('debug');
const logEvent = debug('taiko:event');
const logQuery = debug('taiko:query');
const logFind = debug('taiko:find');
const logEvaluate = debug('taiko:evaluate');
const logPageAction = debug('taiko:page');
const logWait = debug('taiko:wait');

module.exports = {
  logEvent,
  logQuery,
  logFind,
  logEvaluate,
  logPageAction,
  logWait,
};
