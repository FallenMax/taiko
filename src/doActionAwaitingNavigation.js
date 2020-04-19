const { timeouts, waitUntil } = require('./helper');
const networkHandler = require('./handlers/networkHandler');
const pageHandler = require('./handlers/pageHandler');
const runtimeHandler = require('./handlers/runtimeHandler');
const { defaultConfig } = require('./config');
const { logWait } = require('./logger');

const doActionAwaitingNavigation = async (options, action) => {
  if (!options.waitForNavigation) {
    return action();
  }
  pageHandler.resetPromises();
  networkHandler.resetPromises();
  options.navigationTimeout = options.navigationTimeout || defaultConfig.navigationTimeout;

  try {
    logWait('wait for action');
    await action();
    logWait('wait for navigation');
    await waitForNavigation(options.navigationTimeout, []);
    logWait('wait complete');
  } catch (e) {
    if (e === 'Timedout') {
      throw new Error(
        `Navigation took more than ${options.navigationTimeout}ms. Please increase the navigationTimeout.`,
      );
    }
    throw e;
  }
};

const waitForNavigation = (timeout, promises = []) => {
  return new Promise((resolve, reject) => {
    Promise.all(promises)
      .then(() => {
        waitUntil(
          async () => {
            return (
              (await runtimeHandler.runtimeEvaluate('top.document.readyState')).result.value ===
              'complete'
            );
          },
          defaultConfig.retryInterval,
          timeout,
        )
          .then(resolve)
          .catch(() => reject('Timedout'));
      })
      .catch(reject);
    const timeoutId = setTimeout(() => reject('Timedout'), timeout);
    timeouts.push(timeoutId);
  });
};

module.exports = {
  doActionAwaitingNavigation,
};
