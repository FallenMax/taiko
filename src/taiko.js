const { doActionAwaitingNavigation } = require('./doActionAwaitingNavigation');

const cri = require('chrome-remote-interface');
const childProcess = require('child_process');
const isReachable = require('is-reachable');
const {
  helper,
  wait,
  isString,
  isStrictObject,
  isFunction,
  waitUntil,
  xpath,
  timeouts,
  assertType,
  descEvent,
  isObject,
} = require('./helper');
const { getBrowserContexts } = require('./browserContext');
const { createJsDialogEventName } = require('./util');
const inputHandler = require('./handlers/inputHandler');
const domHandler = require('./handlers/domHandler');
const networkHandler = require('./handlers/networkHandler');
const pageHandler = require('./handlers/pageHandler');
const targetHandler = require('./handlers/targetHandler');
const runtimeHandler = require('./handlers/runtimeHandler');
const browserHandler = require('./handlers/browserHandler');
const emulationHandler = require('./handlers/emulationHandler');
const { logEvent } = require('./logger');
const { BrowserContext } = require('./browserContext');
const keyDefinitions = require('./data/USKeyboardLayout');
const chromePath = require('chrome-location');

const {
  setConfig,
  getConfig,
  defaultConfig,
  setNavigationOptions,
  setClickOptions,
  setBrowserOptions,
} = require('./config');
const fs = require('fs-extra');
const path = require('path');
const { eventHandler } = require('./eventBus');
const overlayHandler = require('./handlers/overlayHandler');
const numRetries = process.env.TAIKO_CRI_CONNECTION_RETRIES || 10;
import * as ts from './ts/taiko_ts';

let chromeProcess,
  temporaryUserDataDir,
  page,
  network,
  input,
  _client,
  dom,
  overlay,
  currentPort,
  currentHost,
  browserDebugUrl,
  browser,
  security,
  device,
  eventHandlerProxy,
  clientProxy,
  browserMode,
  browserContext,
  localProtocol = false;

module.exports.emitter = descEvent;

const createTarget = async () => {
  try {
    const browserTargets = await cri.List({
      host: currentHost,
      port: currentPort,
    });
    if (!browserTargets.length) {
      throw new Error('No targets created yet! bl');
    }
    var target = browserTargets.find((t) => t.type === 'page');
    if (!target) {
      throw new Error('No targets created yet!');
    }
    return target;
  } catch (err) {
    return await createTarget();
  }
};
const createProxyForCDPDomain = (cdpClient, cdpDomainName) => {
  const cdpDomain = cdpClient[cdpDomainName];
  const cdpDomainProxy = new Proxy(cdpDomain, {
    get: (target, name) => {
      const domainApi = target[name];
      if (typeof domainApi === 'function') {
        return async (...args) => {
          return await new Promise((resolve, reject) => {
            eventHandler.removeAllListeners('browserCrashed');
            eventHandler.on('browserCrashed', reject);
            let res = domainApi.apply(null, args);
            if (res instanceof Promise) {
              res.then(resolve).catch(reject);
            } else {
              resolve(res);
            }
          }).catch((e) => {
            if (
              e.message.match(/WebSocket is not open: readyState 3/) &&
              hasChromeProcessCrashed()
            ) {
              throw new Error(errorMessageForChromeprocessCrash());
            }
            throw e;
          });
        };
      } else {
        return domainApi;
      }
    },
  });
  cdpClient[cdpDomainName] = cdpDomainProxy;
  return cdpClient[cdpDomainName];
};
const initCRIProperties = (c) => {
  page = createProxyForCDPDomain(c, 'Page');
  network = createProxyForCDPDomain(c, 'Network');
  createProxyForCDPDomain(c, 'Runtime');
  input = createProxyForCDPDomain(c, 'Input');
  dom = createProxyForCDPDomain(c, 'DOM');
  overlay = createProxyForCDPDomain(c, 'Overlay');
  security = createProxyForCDPDomain(c, 'Security');
  createProxyForCDPDomain(c, 'Browser');
  createProxyForCDPDomain(c, 'Target');
  createProxyForCDPDomain(c, 'Emulation');
  _client = c;
  clientProxy = getEventProxy(_client);
};

export const getInput = () => input;

const initCRI = async (target, n, options = {}) => {
  try {
    var c = await cri({
      target,
      host: currentHost,
      port: currentPort,
      localProtocol,
    });
    if (!options.window) {
      initCRIProperties(c);
      await Promise.all([
        network.enable(),
        page.enable(),
        dom.enable(),
        overlay.enable(),
        security.enable(),
      ]);
      _client.on('disconnect', reconnect);
      // Should be emitted after enabling all domains. All handlers can then perform any action on domains properly.
      eventHandler.emit('createdSession', _client);
    }
    if (defaultConfig.ignoreSSLErrors) {
      security.setIgnoreCertificateErrors({ ignore: true });
    }
    device = process.env.TAIKO_EMULATE_DEVICE;
    if (device) {
      emulateDevice(device);
    }
    logEvent('Session Created');
    return c;
  } catch (error) {
    logEvent(error);
    if (n < 2) {
      throw error;
    }
    return new Promise((r) => setTimeout(r, 1000)).then(
      async () => await initCRI(target, n - 1, options),
    );
  }
};

const connect_to_cri = async (target, options = {}) => {
  if (process.env.LOCAL_PROTOCOL) {
    localProtocol = true;
  }
  if (_client && _client._ws.readyState === 1 && !options.window) {
    await network.setRequestInterception({
      patterns: [],
    });
    _client.removeAllListeners();
  }
  var tgt = target || (await createTarget());
  return initCRI(tgt, numRetries, options);
};

function hasChromeProcessCrashed() {
  return chromeProcess && chromeProcess.killed && chromeProcess.exitCode !== 0;
}

async function reconnect() {
  const response = await isReachable(`${currentHost}:${currentPort}`);
  if (response) {
    try {
      logEvent('Reconnecting');
      eventHandler.emit('reconnecting');
      _client.removeAllListeners();
      const browserTargets = await cri.List({
        host: currentHost,
        port: currentPort,
      });
      const pages = browserTargets.filter((target) => {
        return target.type === 'page';
      });
      await connect_to_cri(pages[0]);
      await dom.getDocument();
      logEvent('Reconnected');
      eventHandler.emit('reconnected');
    } catch (e) {}
  }
}

eventHandler.addListener('targetCreated', async (newTarget) => {
  const response = await isReachable(`${currentHost}:${currentPort}`);
  if (response) {
    const browserTargets = await cri.List({
      host: currentHost,
      port: currentPort,
    });
    const pages = browserTargets.filter((target) => {
      return target.id === newTarget.targetInfo.targetId;
    });
    await connect_to_cri(pages[0]).then(() => {
      logEvent(`Target Navigated: Target id: ${newTarget.targetInfo.targetId}`);
      eventHandler.emit('targetNavigated');
    });
    await dom.getDocument();
  }
});

const browserExitEventHandler = () => {
  chromeProcess.killed = true;
  _client.removeAllListeners();
  clientProxy = null;
  eventHandler.emit('browserCrashed', new Error(errorMessageForChromeprocessCrash()));
};
/**
 * Launches a browser with a tab. The browser will be closed when the parent node.js process is closed.<br>
 * Note : `openBrowser` launches the browser in headless mode by default, but when `openBrowser` is called from {@link repl} it launches the browser in headful mode.
 * @example
 * await openBrowser({headless: false})
 * await openBrowser()
 * await openBrowser({args:['--window-size=1440,900']})
 * await openBrowser({args: [
 *      '--disable-gpu',
 *       '--disable-dev-shm-usage',
 *       '--disable-setuid-sandbox',
 *       '--no-first-run',
 *       '--no-sandbox',
 *       '--no-zygote']}) # These are recommended args that has to be passed when running in docker
 *
 * @param {Object} [options={headless:true}] eg. {headless: true|false, args:['--window-size=1440,900']}
 * @param {boolean} [options.headless=true] - Option to open browser in headless/headful mode.
 * @param {Array<string>} [options.args=[]] - Args to open chromium. Refer https://peter.sh/experiments/chromium-command-line-switches/ for values.
 * @param {string} [options.host='127.0.0.1'] - Remote host to connect to.
 * @param {number} [options.port=0] - Remote debugging port, if not given connects to any open port.
 * @param {boolean} [options.ignoreCertificateErrors=false] - Option to ignore certificate errors.
 * @param {boolean} [options.observe=false] - Option to run each command after a delay. Useful to observe what is happening in the browser.
 * @param {number} [options.observeTime=3000] - Option to modify delay time for observe mode. Accepts value in milliseconds.
 * @param {boolean} [options.dumpio=false] - Option to dump IO from browser.
 *
 * @returns {Promise}
 */
module.exports.openBrowser = async (
  options = {
    headless: true,
  },
) => {
  if (!isStrictObject(options)) {
    throw new TypeError(
      'Invalid option parameter. Refer https://docs.taiko.dev/#parameters for the correct format.',
    );
  }

  if (chromeProcess && !chromeProcess.killed) {
    throw new Error('OpenBrowser cannot be called again as there is a chromium instance open.');
  }

  if (options.host && options.port) {
    currentHost = options.host;
    currentPort = options.port;
  } else {
    const BrowserFetcher = require('./browserFetcher');
    const browserFetcher = new BrowserFetcher();
    const chromeExecutable = chromePath;
    console.log('chromeExecutable ', chromeExecutable);
    options = setBrowserOptions(options);
    browserMode = options.headless;
    let args = [
      `--remote-debugging-port=${options.port}`,
      '--disable-features=site-per-process,TranslateUI',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--force-color-profile=srgb',
      '--safebrowsing-disable-auto-update',
      '--password-store=basic',
      '--use-mock-keychain',
      '--enable-automation',
      '--disable-notifications',
      'about:blank',
    ];
    if (options.args) {
      args = args.concat(options.args);
    }
    if (!args.some((arg) => arg.startsWith('--user-data-dir'))) {
      const os = require('os');
      const CHROME_PROFILE_PATH = path.join(os.tmpdir(), 'taiko_dev_profile-');
      const mkdtempAsync = helper.promisify(fs.mkdtemp);
      temporaryUserDataDir = await mkdtempAsync(CHROME_PROFILE_PATH);
      args.push(`--user-data-dir=${temporaryUserDataDir}`);
    }
    if (options.headless) {
      args.push('--headless');
      if (!args.some((arg) => arg.startsWith('--window-size'))) {
        args.push('--window-size=1440,900');
      }
    }
    chromeProcess = await childProcess.spawn(chromeExecutable, args);
    if (options.dumpio) {
      chromeProcess.stderr.pipe(process.stderr);
      chromeProcess.stdout.pipe(process.stdout);
    }
    chromeProcess.once('exit', browserExitEventHandler);
    const endpoint = await browserFetcher.waitForWSEndpoint(
      chromeProcess,
      defaultConfig.navigationTimeout,
    );
    currentHost = endpoint.host;
    currentPort = endpoint.port;
    browserDebugUrl = endpoint.browser;
  }
  await connect_to_cri();
  var description = device ? `Browser opened with viewport ${device}` : 'Browser opened';
  descEvent.emit('success', description);

  if (process.env.TAIKO_EMULATE_NETWORK) {
    await module.exports.emulateNetwork(process.env.TAIKO_EMULATE_NETWORK);
  }
};

/**
 * Closes the browser and along with all of its tabs.
 *
 * @example
 * await closeBrowser()
 *
 * @returns {Promise}
 */
module.exports.closeBrowser = async () => {
  validate();
  await _closeBrowser();
  descEvent.emit('success', 'Browser closed');
};

const _closeBrowser = async () => {
  timeouts.forEach((timeout) => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
  let timeout;
  networkHandler.resetInterceptors();
  if (_client) {
    await reconnect();
    await page.close();
    await new Promise((resolve) => {
      timeout = setTimeout(() => {
        resolve();
      }, 5000);
      Promise.all(promisesToBeResolvedBeforeCloseBrowser).then(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await _client.removeAllListeners();
    await _client.close();
  }
  const waitForChromeToClose = new Promise((fulfill) => {
    chromeProcess.removeAllListeners();
    chromeProcess.once('exit', () => {
      fulfill();
    });
    if (chromeProcess.killed) {
      fulfill();
    }
    timeout = setTimeout(() => {
      fulfill();
      chromeProcess.removeAllListeners();
      chromeProcess.kill('SIGKILL');
    }, 5000);
  });
  chromeProcess.kill('SIGTERM');
  await waitForChromeToClose;
  clearTimeout(timeout);
  if (temporaryUserDataDir) {
    try {
      fs.removeSync(temporaryUserDataDir);
    } catch (e) {}
  }
};

function errorMessageForChromeprocessCrash() {
  let message;
  if (chromeProcess.exitCode === null) {
    message = `Chrome process with pid ${chromeProcess.pid} exited with signal ${chromeProcess.signalCode}.`;
  } else {
    message = `Chrome process with pid ${chromeProcess.pid} exited with status code ${chromeProcess.exitCode}.`;
  }
  return message;
}

function getEventProxy(target) {
  let unsupportedClientMethods = [
    'removeListener',
    'emit',
    'removeAllListeners',
    'setMaxListeners',
    'off',
  ];
  const handler = {
    get: (target, name) => {
      if (unsupportedClientMethods.includes(name)) {
        throw new Error(`Unsupported action ${name} on client`);
      }
      return target[name];
    },
  };
  return new Proxy(target, handler);
}

/**
 * Gives CRI client object (a wrapper around Chrome DevTools Protocol). Refer https://github.com/cyrus-and/chrome-remote-interface
 * This is useful while writing plugins or if use some API of [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
 *
 * @returns {Object}
 */
module.exports.client = () => clientProxy;

/**
 * Allows switching between tabs using URL or page title or Open Window.
 *
 * @example
 * # switch using URL
 * await switchTo('https://taiko.dev')
 * # switch using Title
 * await switchTo('Taiko')
 * # switch using regex URL
 * await switchTo(/http(s?):\/\/(www?).google.(com|co.in|co.uk)/)
 * # switch using regex Title
 * await switchTo(/Go*gle/)
 *
 * @param {string} arg - URL/Page title of the tab to switch.
 *
 * @returns {Promise}
 */

module.exports.switchTo = async (arg) => {
  validate();
  if (isObject(arg) && !Object.prototype.toString.call(arg).includes('RegExp')) {
    const contexts = getBrowserContexts();
    if (contexts.size !== 0) {
      await _switchToIncognitoBrowser(arg);
      descEvent.emit('success', `Switched to Incognito window matching ${arg.name}`);
    }
  } else {
    if (typeof arg != 'string' && !Object.prototype.toString.call(arg).includes('RegExp')) {
      throw new TypeError(
        'The "targetUrl" argument must be of type string or regex. Received type ' + typeof arg,
      );
    }
    if (typeof arg === 'string' && arg.trim() === '') {
      throw new Error(
        'Cannot switch to tab or window. Hint: The targetUrl is empty. Please use a valid string or regex',
      );
    }
    if (Object.prototype.toString.call(arg).includes('RegExp')) {
      arg = new RegExp(arg);
    }
    const targets = await targetHandler.getCriTargets(arg, currentHost, currentPort);
    if (targets.matching.length === 0) {
      throw new Error(`No tab(s) matching ${arg} found`);
    }
    await connect_to_cri(targets.matching[0]);
    await dom.getDocument();
    descEvent.emit('success', `Switched to tab matching ${arg}`);
  }
};

/**
 * Add interceptor for the network call. Helps in overriding request or to mock response of a network call.
 *
 * @example
 * # case 1: block URL :
 * await intercept(url)
 * # case 2: mockResponse :
 * await intercept(url, {mockObject})
 * # case 3: override request :
 * await intercept(url, (request) => {request.continue({overrideObject})})
 * # case 4: redirect always :
 * await intercept(url, redirectUrl)
 * # case 5: mockResponse based on request :
 * await intercept(url, (request) => { request.respond({mockResponseObject}) })
 * # case 6: block URL twice:
 * await intercept(url, undefined, 2)
 * # case 7: mockResponse only 3 times :
 * await intercept(url, {mockObject}, 3)
 *
 * @param {string} requestUrl request URL to intercept
 * @param {function|Object} option action to be done after interception. For more examples refer to https://github.com/getgauge/taiko/issues/98#issuecomment-42024186
 * @param {number} count number of times the request has to be intercepted . Optional parameter
 *
 * @returns {Promise}
 */
module.exports.intercept = async (requestUrl, option, count) => {
  await networkHandler.addInterceptor({
    requestUrl: requestUrl,
    action: option,
    count,
  });
  descEvent.emit('success', 'Interceptor added for ' + requestUrl);
};

/**
 * Activates emulation of network conditions.
 *
 * @example
 * await emulateNetwork("Offline")
 * await emulateNetwork("Good2G")
 *
 * @param {string} networkType - 'GPRS','Regular2G','Good2G','Good3G','Regular3G','Regular4G','DSL','WiFi, Offline'
 *
 * @returns {Promise}
 */

module.exports.emulateNetwork = async (networkType) => {
  validate();
  await networkHandler.setNetworkEmulation(networkType);
  descEvent.emit('success', 'Set network emulation with values ' + JSON.stringify(networkType));
};

/**
 * Overrides the values of device screen dimensions according to a predefined list of devices. To provide custom device dimensions, use setViewPort API.
 *
 * @example
 * await emulateDevice('iPhone 6')
 *
 * @param {string} deviceModel - See [device model](https://github.com/getgauge/taiko/blob/master/lib/data/devices.js) for a list of all device models.
 *
 * @returns {Promise}
 */

module.exports.emulateDevice = emulateDevice;
async function emulateDevice(deviceModel) {
  validate();
  const devices = require('./data/devices').default;
  const deviceEmulate = devices[deviceModel];
  let deviceNames = Object.keys(devices);
  if (deviceEmulate == undefined) {
    throw new Error(`Please set one of the given device models \n${deviceNames.join('\n')}`);
  }
  await Promise.all([
    emulationHandler.setViewport(deviceEmulate.viewport),
    network.setUserAgentOverride({
      userAgent: deviceEmulate.userAgent,
    }),
  ]);
  descEvent.emit('success', 'Device emulation set to ' + deviceModel);
}

/**
 * Overrides the values of device screen dimensions
 *
 * @example
 * await setViewPort({width:600, height:800})
 *
 * @param {Object} options - See [chrome devtools setDeviceMetricsOverride](https://chromedevtools.github.io/devtools-protocol/tot/Emulation#method-setDeviceMetricsOverride) for a list of options
 *
 * @returns {Promise}
 */
module.exports.setViewPort = async (options) => {
  validate();
  await emulationHandler.setViewport(options);
  descEvent.emit(
    'success',
    'ViewPort is set to width ' + options.width + ' and height ' + options.height,
  );
};

/**
 * Changes the timezone of the page. See [`metaZones.txt`](https://cs.chromium.org/chromium/src/third_party/icu/source/data/misc/metaZones.txt?rcl=faee8bc70570192d82d2978a71e2a615788597d1)
 * for a list of supported timezone IDs.
 * @example
 * await emulateTimezone('America/Jamaica')
 */

module.exports.emulateTimezone = async (timezoneId) => {
  await emulationHandler.setTimeZone(timezoneId);
  descEvent.emit('success', 'Timezone set to ' + timezoneId);
};

/**
 * Launches a new tab. If url is provided, the new tab is opened with the url loaded.
 * @example
 * await openTab('https://taiko.dev')
 * await openTab() # opens a blank tab.
 *
 * @param {string} [targetUrl=undefined] - Url of page to open in newly created tab.
 * @param {Object} options
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the reload. Default navigation timeout is 5000 milliseconds, to override pass `{ navigationTimeout: 10000 }` in `options` parameter.
 * @param {number} [options.navigationTimeout=5000] - Navigation timeout value in milliseconds for navigation after click. Accepts value in milliseconds.
 * @param {number} [options.waitForStart=100] - time to wait to check for occurrence of page load events. Accepts value in milliseconds.
 * @param {string[]} [options.waitForEvents = ['firstMeaningfulPaint']] - Page load events to implicitly wait for. Events available to wait for ['DOMContentLoaded', 'loadEventFired', 'networkAlmostIdle', 'networkIdle', 'firstPaint', 'firstContentfulPaint', 'firstMeaningfulPaint']]
 *
 * @returns {Promise}
 */
module.exports.openTab = async (
  targetUrl,
  options = {
    navigationTimeout: defaultConfig.navigationTimeout,
  },
) => {
  validate();
  options = setNavigationOptions(options);
  targetUrl = targetUrl ? targetUrl : 'about:blank';

  if (!/^https?:\/\//i.test(targetUrl) && !/^file/i.test(targetUrl)) {
    targetUrl = 'http://' + targetUrl;
  }

  const newCritarget = async () => {
    _client.removeAllListeners();
    let target = await cri.New({
      host: currentHost,
      port: currentPort,
      url: targetUrl,
    });
    await connect_to_cri(target);
  };

  if (targetUrl.includes('about:blank')) {
    newCritarget();
  } else {
    await doActionAwaitingNavigation(options, newCritarget);
  }
  descEvent.emit('success', 'Opened tab with URL ' + targetUrl);
};

/**
 * @deprecated Use openIncognitoWindow
 * Opens the specified URL in the browser's window. Adds `http` protocol to the URL if not present.
 * @example
 * await openWindow('https://google.com', { name: 'windowName' }) - Opens a Incognito window
 * await openWindow('https://google.com', { name: 'windowName', incognito: false }) - Opens normal window
 * @param {string} url - URL to navigate page to.
 * @param {Object} options
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the goto. Default navigationTimeout is 30 seconds to override pass `{ navigationTimeout: 10000 }` in `options` parameter.
 * @param {string[]} [options.waitForEvents = ['firstMeaningfulPaint']] - Events available to wait for ['DOMContentLoaded', 'loadEventFired', 'networkAlmostIdle', 'networkIdle', 'firstPaint', 'firstContentfulPaint', 'firstMeaningfulPaint']
 * @param {number} [options.navigationTimeout=30000] - Navigation timeout value in milliseconds for navigation after click.
 * @param {Object} options.headers - Map with extra HTTP headers.
 * @param {number} [options.waitForStart = 100] - time to wait for navigation to start. Accepts value in milliseconds.
 *
 * @returns {Promise}
 */
module.exports.openWindow = async (url, options = {}) => {
  validate();
  options = {
    ...{ navigationTimeout: defaultConfig.navigationTimeout, incognito: true },
    ...options,
  };
  if (typeof url != 'string') {
    throw new TypeError('Url needs to be provided to openWindow');
  }
  if (!browserMode && options.incognito) {
    console.warn('Incognito windows in non-headless mode is unstable and may have issues');
  }

  if (!/^https?:\/\//i.test(url) && !/^file/i.test(url)) {
    url = 'http://' + url;
  }
  browser = await connect_to_cri(browserDebugUrl, { window: true });
  createProxyForCDPDomain(browser, 'Target');
  browserContext = new BrowserContext(browser, this);
  const targetId = await browserContext.createBrowserContext(url, options);
  await connect_to_cri(targetId);
  options = setNavigationOptions(options);
  await doActionAwaitingNavigation(options, async () => {
    await pageHandler.handleNavigation(url);
  });
  options.incognito
    ? descEvent.emit('success', `Incognito window opened with name ${options.name}`)
    : descEvent.emit('success', `Window opened with name ${options.name}`);
};

/**
 * Opens the specified URL in the browser's window. Adds `http` protocol to the URL if not present.
 * @example
 * await openIncognitoWindow('https://google.com', { name: 'windowName' }) - Open a incognito window
 * @param {string} url - URL to navigate page to.
 * @param {Object} options
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the goto. Default navigationTimeout is 30 seconds to override pass `{ navigationTimeout: 10000 }` in `options` parameter.
 * @param {string[]} [options.waitForEvents = ['firstMeaningfulPaint']] - Events available to wait for ['DOMContentLoaded', 'loadEventFired', 'networkAlmostIdle', 'networkIdle', 'firstPaint', 'firstContentfulPaint', 'firstMeaningfulPaint']
 * @param {number} [options.navigationTimeout=30000] - Navigation timeout value in milliseconds for navigation after click.
 * @param {Object} options.headers - Map with extra HTTP headers.
 * @param {number} [options.waitForStart = 100] - time to wait for navigation to start. Accepts value in milliseconds.
 *
 * @returns {Promise}
 */
module.exports.openIncognitoWindow = async (url, options = {}) => {
  validate();
  options = {
    ...{ navigationTimeout: defaultConfig.navigationTimeout, incognito: true },
    ...options,
  };
  if (typeof url != 'string') {
    throw new TypeError('Url needs to be provided to openIncognitoWindow');
  }

  if (!options.name) {
    throw new TypeError('Window name needs to be provided');
  }

  if (!browserMode && options.incognito) {
    console.warn('Incognito windows in non-headless mode is unstable and may have issues');
  }

  if (!/^https?:\/\//i.test(url) && !/^file/i.test(url)) {
    url = 'http://' + url;
  }
  browser = await connect_to_cri(browserDebugUrl, { window: true });
  browserContext = new BrowserContext(browser, this);
  const targetId = await browserContext.createBrowserContext(url, options);
  await connect_to_cri(targetId);
  options = setNavigationOptions(options);
  await doActionAwaitingNavigation(options, async () => {
    await pageHandler.handleNavigation(url);
  });
  options.incognito
    ? descEvent.emit('success', `Incognito window opened with name ${options.name}`)
    : descEvent.emit('success', `Window opened with name ${options.name}`);
};

/**
 * @deprecated Use closeIncognitoWindow
 * Closes the specified browser window.
 * @example
 * await closeWindow('windowName') - Closes a window with given arg
 */
module.exports.closeWindow = async (arg) => {
  await browserContext.closeBrowserContext(arg);
  _client.close();
  await reconnect();
  descEvent.emit('success', `Window with name ${arg} closed`);
};

/**
 * Closes the specified browser window.
 * @example
 * await closeIncognitoWindow('windowName') - Close incognito window
 * @param {string}  windowName - incognito window name
 */
module.exports.closeIncognitoWindow = async (arg) => {
  if (!arg) {
    throw new TypeError('Window name needs to be provided');
  }
  await browserContext.closeBrowserContext(arg);
  const promiseReconnect = new Promise((resolve) => {
    eventHandler.once('reconnected', resolve);
  });
  await promiseReconnect;
  descEvent.emit('success', `Window with name ${arg} closed`);
};

const _switchToIncognitoBrowser = async (arg) => {
  await browserContext.switchBrowserContext(connect_to_cri, arg);
  await dom.getDocument();
};

/**
 * Closes the given tab with given URL or closes current tab.
 *
 * @example
 * # Closes the current tab.
 * await closeTab()
 * # Closes all the tabs with Title 'Open Source Test Automation Framework | Gauge'.
 * await closeTab('Open Source Test Automation Framework | Gauge')
 * # Closes all the tabs with URL 'https://gauge.org'.
 * await closeTab('https://gauge.org')
 * # Closes all the tabs with Regex Title 'Go*gle'
 * await closeTab(/Go*gle/)
 * # Closes all the tabs with Regex URL '/http(s?):\/\/(www?).google.(com|co.in|co.uk)/'
 * await closeTab(/http(s?):\/\/(www?).google.(com|co.in|co.uk)/)
 *
 * @param {string} [targetUrl=undefined] - URL/Page title of the tab to close.
 *
 * @returns {Promise}
 */
module.exports.closeTab = async (targetUrl) => {
  validate();
  if (
    targetUrl != null &&
    (Object.prototype.toString.call(targetUrl).includes('RegExp') || typeof targetUrl != 'string')
  ) {
    targetUrl = new RegExp(targetUrl);
  }
  const { matching, others } = await targetHandler.getCriTargets(
    targetUrl,
    currentHost,
    currentPort,
  );
  if (!others.length) {
    await _closeBrowser();
    descEvent.emit('success', 'Closing last target and browser.');
    return;
  }
  if (!matching.length) {
    throw new Error(`No tab(s) matching ${targetUrl} found`);
  }
  let currentUrl = await currentURL();
  let closedTabUrl;
  for (let target of matching) {
    closedTabUrl = target.url;
    await cri.Close({
      host: currentHost,
      port: currentPort,
      id: target.id,
    });
    await _client.close();
  }
  if (
    !targetHandler.isMatchingUrl(others[0], currentUrl) &&
    !targetHandler.isMatchingRegex(others[0], currentUrl)
  ) {
    _client.removeAllListeners();
    await connect_to_cri(others[0]);
    await dom.getDocument();
  }
  let message = targetUrl
    ? `Closed tab(s) matching ${targetUrl}`
    : `Closed current tab matching ${closedTabUrl}`;
  descEvent.emit('success', message);
};

/**
 * Override specific permissions to the given origin
 *
 * @example
 * await overridePermissions('http://maps.google.com',['geolocation']);
 *
 * @param {string} origin - url origin to override permissions
 * @param {Array<string>} permissions - See [chrome devtools permission types](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#type-PermissionType) for a list of permission types.
 *
 * @returns {Promise}
 */
module.exports.overridePermissions = async (origin, permissions) => {
  validate();
  await browserHandler.overridePermissions(origin, permissions);
  descEvent.emit('success', 'Override permissions with ' + permissions);
};

/**
 * Clears all permission overrides for all origins.
 *
 * @example
 * await clearPermissionOverrides()
 *
 * @returns {Promise}
 */
module.exports.clearPermissionOverrides = async () => {
  validate();
  await browserHandler.clearPermissionOverrides();
  descEvent.emit('success', 'Cleared permission overrides');
};

/**
 * Sets a cookie with the given cookie data. It may overwrite equivalent cookie if it already exists.
 *
 * @example
 * await setCookie("CSRFToken","csrfToken", {url: "http://the-internet.herokuapp.com"})
 * await setCookie("CSRFToken","csrfToken", {domain: "herokuapp.com"})
 *
 * @param {string} name - Cookie name.
 * @param {string} value - Cookie value.
 * @param {Object} options
 * @param {string} [options.url=undefined] - sets cookie with the URL.
 * @param {string} [options.domain=undefined] - sets cookie with the exact domain.
 * @param {string} [options.path=undefined] - sets cookie with the exact path.
 * @param {boolean} [options.secure=undefined] - True if cookie to be set is secure.
 * @param {boolean} [options.httpOnly=undefined] - True if cookie to be set is http-only.
 * @param {string} [options.sameSite=undefined] - Represents the cookie's 'SameSite' status: Refer https://tools.ietf.org/html/draft-west-first-party-cookies.
 * @param {number} [options.expires=undefined] - UTC time in seconds, counted from January 1, 1970. eg: 2019-02-16T16:55:45.529Z
 *
 * @returns {Promise}
 */
module.exports.setCookie = async (name, value, options = {}) => {
  validate();
  if (options.url === undefined && options.domain === undefined) {
    throw new Error('At least URL or domain needs to be specified for setting cookies');
  }
  options.name = name;
  options.value = value;
  let res = await network.setCookie(options);
  if (!res.success) {
    throw new Error('Unable to set ' + name + ' cookie');
  }
  descEvent.emit('success', name + ' cookie set successfully');
};

/**
 * Deletes browser cookies with matching name and URL or domain/path pair. If cookie name is not given or empty, all browser cookies are deleted.
 *
 * @example
 * await deleteCookies() # clears all browser cookies
 * await deleteCookies("CSRFToken", {url: "http://the-internet.herokuapp.com"})
 * await deleteCookies("CSRFToken", {domain: "herokuapp.com"})
 *
 * @param {string} [cookieName=undefined] - Cookie name.
 * @param {Object} options
 * @param {string} [options.url=undefined] - deletes all the cookies with the given name where domain and path match provided URL. eg: https://google.com
 * @param {string} [options.domain=undefined] - deletes only cookies with the exact domain. eg: google.com
 * @param {string} [options.path=undefined] - deletes only cookies with the exact path. eg: Google/Chrome/Default/Cookies/..
 *
 * @returns {Promise}
 */
module.exports.deleteCookies = async (cookieName, options = {}) => {
  validate();
  if (!cookieName || !cookieName.trim()) {
    await network.clearBrowserCookies();
    descEvent.emit('success', 'Browser cookies deleted successfully');
  } else {
    if (options.url === undefined && options.domain === undefined) {
      throw new Error('At least URL or domain needs to be specified for deleting cookies');
    }
    options.name = cookieName;
    await network.deleteCookies(options);
    descEvent.emit('success', `"${cookieName}" cookie deleted successfully`);
  }
};

/**
 * Get browser cookies
 *
 * @example
 * await getCookies()
 * await getCookies({urls:['https://the-internet.herokuapp.com']})
 *
 * @param {Object} options
 * @param {Array} [options.urls=undefined] - The list of URLs for which applicable cookies will be fetched
 *
 * @returns {Promise<Object[]>} - Array of cookie objects
 */
module.exports.getCookies = async (options = {}) => {
  validate();
  return (await network.getCookies(options)).cookies;
};

/**
 * Overrides the Geolocation Position
 *
 * @example
 * await setLocation({ latitude: 27.1752868, longitude: 78.040009, accuracy:20 })
 *
 * @param {Object} options Latitue, logitude and accuracy to set the location.
 * @param {number} options.latitude - Mock latitude
 * @param {number} options.longitude - Mock longitude
 * @param {number} options.accuracy - Mock accuracy
 *
 * @returns {Promise}
 */
module.exports.setLocation = async (options) => {
  validate();
  await emulationHandler.setLocation(options);
  descEvent.emit('success', 'Geolocation set');
};

/**
 * Opens the specified URL in the browser's tab. Adds `http` protocol to the URL if not present.
 * @example
 * await goto('https://google.com')
 * await goto('google.com')
 * await goto({ navigationTimeout:10000, headers:{'Authorization':'Basic cG9zdG1hbjpwYXNzd29y2A=='}})
 *
 * @param {string} url - URL to navigate page to.
 * @param {Object} options
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the goto. Default navigationTimeout is 30 seconds to override pass `{ navigationTimeout: 10000 }` in `options` parameter.
 * @param {string[]} [options.waitForEvents = ['firstMeaningfulPaint']] - Events available to wait for ['DOMContentLoaded', 'loadEventFired', 'networkAlmostIdle', 'networkIdle', 'firstPaint', 'firstContentfulPaint', 'firstMeaningfulPaint']
 * @param {number} [options.navigationTimeout=30000] - Navigation timeout value in milliseconds for navigation after click.
 * @param {Object} options.headers - Map with extra HTTP headers.
 * @param {number} [options.waitForStart = 100] - time to wait for navigation to start. Accepts value in milliseconds.
 *
 * @returns {Promise}
 */
module.exports.goto = async (
  url,
  options = { navigationTimeout: defaultConfig.navigationTimeout },
) => {
  validate();
  if (!/^https?:\/\//i.test(url) && !/^file/i.test(url)) {
    url = 'http://' + url;
  }
  if (options.headers) {
    networkHandler.setHTTPHeaders(options.headers, url);
  }
  options = setNavigationOptions(options);
  await doActionAwaitingNavigation(options, async () => {
    await pageHandler.handleNavigation(url);
  });
  descEvent.emit('success', 'Navigated to URL ' + url);
};

/**
 * Reloads the page.
 * @example
 * await reload('https://google.com')
 * await reload('https://google.com', { navigationTimeout: 10000 })
 *
 * @param {string} url - DEPRECATED URL to reload
 * @param {Object} options
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the reload. Default navigation timeout is 30 seconds, to override pass `{ navigationTimeout: 10000 }` in `options` parameter.
 * @param {string[]} [options.waitForEvents = ['firstMeaningfulPaint']] - Events available to wait for ['DOMContentLoaded', 'loadEventFired', 'networkAlmostIdle', 'networkIdle', 'firstPaint', 'firstContentfulPaint', 'firstMeaningfulPaint']
 * @param {number} [options.navigationTimeout=30000] - Navigation timeout value in milliseconds for navigation after click.
 * @param {number} [options.waitForStart = 100] - time to wait for navigation to start. Accepts value in milliseconds.
 * @param {boolean} [options.ignoreCache = false] - Ignore Cache on reload - Default to false
 *
 * @returns {Promise}
 */
module.exports.reload = async (
  url,
  options = { navigationTimeout: defaultConfig.navigationTimeout },
) => {
  if (isString(url)) {
    console.warn('DEPRECATION WARNING: url is deprecated on reload');
  }
  if (typeof url === 'object') {
    options = Object.assign(url, options);
  }
  validate();
  options = setNavigationOptions(options);
  await doActionAwaitingNavigation(options, async () => {
    const value = options.ignoreCache || false;
    await page.reload({ ignoreCache: value });
  });
  let windowLocation = (await runtimeHandler.runtimeEvaluate('window.location.toString()')).result
    .value;
  descEvent.emit('success', windowLocation + 'reloaded');
};

/**
 * Mimics browser back button click functionality.
 * @example
 * await goBack()
 *
 * @param {Object} options
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the goBack. Default navigation timeout is 30 seconds, to override pass `{ navigationTimeout: 10000 }` in `options` parameter.
 * @param {string[]} [options.waitForEvents = ['firstMeaningfulPaint']] - Events available to wait for ['DOMContentLoaded', 'loadEventFired', 'networkAlmostIdle', 'networkIdle', 'firstPaint', 'firstContentfulPaint', 'firstMeaningfulPaint']
 * @param {number} [options.navigationTimeout=30000] - Navigation timeout value in milliseconds for navigation after click.
 * @param {number} [options.waitForStart = 100] - time to wait for navigation to start. Accepts value in milliseconds.
 *
 * @returns {Promise}
 */
module.exports.goBack = async (
  options = { navigationTimeout: defaultConfig.navigationTimeout },
) => {
  validate();
  await _go(-1, options);
  descEvent.emit('success', 'Performed clicking on browser back button');
};

/**
 * Mimics browser forward button click functionality.
 * @example
 * await goForward()
 *
 * @param {Object} options
 * @param {boolean} [options.waitForNavigation=true] - Wait for navigation after the goForward. Default navigation timeout is 30 seconds, to override pass `{ navigationTimeout: 10000 }` in `options` parameter.
 * @param {string[]} [options.waitForEvents = ['firstMeaningfulPaint']] - Events available to wait for ['DOMContentLoaded', 'loadEventFired', 'networkAlmostIdle', 'networkIdle', 'firstPaint', 'firstContentfulPaint', 'firstMeaningfulPaint']
 * @param {number} [options.navigationTimeout=30000] - Navigation timeout value in milliseconds for navigation after click.
 * @param {number} [options.waitForStart = 100] - time to wait for navigation to start. Accepts value in milliseconds.
 *
 * @returns {Promise}
 */
module.exports.goForward = async (
  options = { navigationTimeout: defaultConfig.navigationTimeout },
) => {
  validate();
  await _go(+1, options);
  descEvent.emit('success', 'Performed clicking on browser forward button');
};

const _go = async (delta, options) => {
  const history = await page.getNavigationHistory();
  const entry = history.entries[history.currentIndex + delta];
  if (!entry) {
    return null;
  }
  if (
    entry.url === 'about:blank' &&
    !Object.prototype.hasOwnProperty.call(options, 'waitForNavigation')
  ) {
    options.waitForNavigation = false;
  }
  options = setNavigationOptions(options);
  await doActionAwaitingNavigation(options, async () => {
    await page.navigateToHistoryEntry({ entryId: entry.id });
  });
};

/**
 * Returns window's current URL.
 * @example
 * await openBrowser();
 * await goto("www.google.com");
 * await currentURL(); # returns "https://www.google.com/?gws_rd=ssl"
 *
 * @returns {Promise<string>} - The URL of the current window.
 */
const currentURL = async () => {
  validate();
  const locationObj = await runtimeHandler.runtimeEvaluate('window.location.toString()');
  return locationObj.result.value;
};
module.exports.currentURL = currentURL;

/**
 * Returns page's title.
 * @example
 * await openBrowser();
 * await goto("www.google.com");
 * await title(); # returns "Google"
 *
 * @returns {Promise<string>} - The title of the current page.
 */
module.exports.title = async () => {
  validate();
  const result = await runtimeHandler.runtimeEvaluate(
    'document.querySelector("title").textContent',
  );
  return result.result.value;
};

module.exports.click = ts.withEmittingSuccess(ts.click);
module.exports.hover = ts.withEmittingSuccess(ts.hover);
module.exports.focus = ts.withEmittingSuccess(ts.focus);
module.exports.write = ts.withEmittingSuccess(ts.write);
module.exports.clear = ts.withEmittingSuccess(ts.clear);
module.exports.press = ts.withEmittingSuccess(ts.press);
module.exports.highlight = ts.withEmittingSuccess(ts.highlight);
module.exports.scrollTo = ts.withEmittingSuccess(ts.scrollTo);
module.exports.tap = ts.withEmittingSuccess(ts.tap);
module.exports.evaluate = ts.withEmittingSuccess(ts.evaluate);

module.exports.$ = ts.$;
module.exports.textBox = ts.textBox;
module.exports.text = ts.text;
module.exports.toLeftOf = ts.toLeftOf;
module.exports.toRightOf = ts.toRightOf;
module.exports.above = ts.above;
module.exports.below = ts.below;
module.exports.near = ts.near;

/**
 * Accept or dismiss an `alert` matching a text.<br>
 *
 * @example
 * alert('Message', async () => await accept())
 * alert('Message', async () => await dismiss())
 *
 * // Note: Taiko's `alert` listener has to be setup before the alert
 * // displays on the page. For example, if clicking on a button
 * // shows the alert, the Taiko script is
 * alert('Message', async () => await accept())
 * await click('Show Alert')
 *
 * @param {string} message - Identify alert based on this message.
 * @param {function} callback - Action to perform. accept/dismiss.
 */
module.exports.alert = (message, callback) => dialog('alert', message, callback);

/**
 * Accept or dismiss a `prompt` matching a text.<br>
 * Write into the `prompt` with `accept('Something')`.
 *
 * @example
 * prompt('Message', async () => await accept('Something'))
 * prompt('Message', async () => await dismiss())
 *
 * // Note: Taiko's `prompt` listener has to be setup before the prompt
 * // displays on the page. For example, if clicking on a button
 * // shows the prompt, the Taiko script is
 * prompt('Message', async () => await accept('Something'))
 * await click('Show Prompt')
 *
 * @param {string} message - Identify prompt based on this message.
 * @param {function} callback - Action to perform. accept/dismiss.
 */
module.exports.prompt = (message, callback) => dialog('prompt', message, callback);

/**
 * Accept or dismiss a `confirm` popup matching a text.<br>
 *
 * @example
 * confirm('Message', async () => await accept())
 * confirm('Message', async () => await dismiss())
 *
 * // Note: Taiko's `confirm` listener has to be setup before the confirm
 * // popup displays on the page. For example, if clicking on a button
 * // shows the confirm popup, the Taiko script is
 * confirm('Message', async () => await accept())
 * await click('Show Confirm')
 *
 * @param {string} message - Identify confirm based on this message.
 * @param {function} callback - Action to perform. accept/dismiss.
 */
module.exports.confirm = (message, callback) => dialog('confirm', message, callback);

/**
 * Accept or dismiss a `beforeunload` popup.<br>
 *
 * @example
 * beforeunload(async () => await accept())
 * beforeunload(async () => await dismiss())
 *
 * // Note: Taiko's `beforeunload` listener can be setup anywhere in the
 * // script. The listener will run when the popup displays on the page.
 *
 * @param {function} callback - Action to perform. Accept/Dismiss.
 */
module.exports.beforeunload = (callback) => dialog('beforeunload', '', callback);

/**
 * Action to perform on dialogs
 *
 * @example
 * prompt('Message', async () => await accept('Something'))
 */
module.exports.accept = async (text = '') => {
  await page.handleJavaScriptDialog({
    accept: true,
    promptText: text,
  });
  descEvent.emit('success', 'Accepted dialog');
};

/**
 * Action to perform on dialogs
 *
 * @example
 * prompt('Message', async () => await dismiss())
 */
module.exports.dismiss = async () => {
  await page.handleJavaScriptDialog({
    accept: false,
  });
  descEvent.emit('success', 'Dismissed dialog');
};

/**
 * Lets you read the global configurations.
 *
 * @example
 * getConfig("retryInterval");
 *
 * @param {String} optionName - Specifies the name of the configuration option/paramter you want to get (optional). If not specified, returns a shallow copy of the full global configuration.
 * @param {String} ["navigationTimeout"] Navigation timeout value in milliseconds for navigation after performing
 * @param {String} ["observeTime"] Option to modify delay time in milliseconds for observe mode.
 * @param {String} ["retryInterval"] Option to modify delay time in milliseconds to retry the search of element existence.
 * @param {String} ["retryTimeout"] Option to modify timeout in milliseconds while retrying the search of element existence.
 * @param {String} ["observe"] Option to run each command after a delay. Useful to observe what is happening in the browser.
 * @param {String} ["waitForNavigation"] Wait for navigation after performing <a href="#goto">goto</a>, <a href="#click">click</a>,
 * <a href="#doubleclick">doubleClick</a>, <a href="#rightclick">rightClick</a>, <a href="#write">write</a>, <a href="#clear">clear</a>,
 * <a href="#press">press</a> and <a href="#evaluate">evaluate</a>.
 * @param {String} ["ignoreSSLErrors"] Option to ignore SSL errors encountered by the browser.
 * @param {String} ["headful"] Option to open browser in headless/headful mode.
 * @param {String} ["highlightOnAction"] Option to highlight an element on action.
 */
module.exports.getConfig = getConfig;

/**
 * Lets you configure global configurations.
 *
 * @example
 * setConfig( { observeTime: 3000});
 *
 * @param {Object} options
 * @param {number} [options.observeTime = 3000 ] - Option to modify delay time in milliseconds for observe mode.
 * @param {number} [options.navigationTimeout = 30000 ] Navigation timeout value in milliseconds for navigation after performing
 * <a href="#opentab">openTab</a>, <a href="#goto">goto</a>, <a href="#reload">reload</a>, <a href="#goback">goBack</a>,
 * <a href="#goforward">goForward</a>, <a href="#click">click</a>, <a href="#write">write</a>, <a href="#clear">clear</a>,
 * <a href="#press">press</a> and <a href="#evaluate">evaluate</a>.
 * @param {number} [options.retryInterval = 100 ] Option to modify delay time in milliseconds to retry the search of element existence.
 * @param {number} [options.retryTimeout = 10000 ] Option to modify timeout in milliseconds while retrying the search of element existence.
 * @param {boolean} [options.waitForNavigation = true ] Wait for navigation after performing <a href="#goto">goto</a>, <a href="#click">click</a>,
 * <a href="#doubleclick">doubleClick</a>, <a href="#rightclick">rightClick</a>, <a href="#write">write</a>, <a href="#clear">clear</a>,
 * <a href="#press">press</a> and <a href="#evaluate">evaluate</a>.
 */
module.exports.setConfig = setConfig;

const promisesToBeResolvedBeforeCloseBrowser = [];
const dialog = (dialogType, dialogMessage, callback) => {
  validate();
  let resolver = null;
  if (dialogType === 'beforeunload') {
    promisesToBeResolvedBeforeCloseBrowser.push(
      new Promise((resolve) => {
        resolver = resolve;
      }),
    );
  }
  return eventHandler.once(
    createJsDialogEventName(dialogMessage, dialogType),
    async ({ message }) => {
      if (dialogMessage === message) {
        await callback();
        resolver && resolver();
      }
    },
  );
};

const validate = () => {
  if (!_client) {
    throw new Error('Browser or page not initialized. Call `openBrowser()` before using this API');
  }
  if (_client._ws.readyState > 1) {
    if (chromeProcess && chromeProcess.killed) {
      throw new Error(
        'The Browser instance was closed either via `closeBrowser()` call, or it crashed for reasons unknown to Taiko. You can try launching a fresh instance using `openBrowser()` or inspect the logs for details of the possible crash.',
      );
    }
    throw new Error(
      "Connection to browser lost. This probably isn't a problem with Taiko, inspect logs for possible causes.",
    );
  }
};

const realFuncs = {};
for (const func in module.exports) {
  realFuncs[func] = module.exports[func];
  if (realFuncs[func].constructor.name === 'AsyncFunction') {
    module.exports[func] = async function () {
      if (defaultConfig.observe) {
        await waitFor(defaultConfig.observeTime);
      }
      return await realFuncs[func].apply(this, arguments);
    };
  }
}

/**
 * Removes interceptor for the provided URL or all interceptors if no URL is specified
 *
 * @example
 * # case 1: Remove intercept for a single  URL :
 * await clearIntercept(requestUrl)
 * # case 2: Reset intercept for all URL :
 * await clearIntercept()
 *
 * @param {string} requestUrl request URL to intercept. Optional parameters
 */
module.exports.clearIntercept = (requestUrl) => {
  if (requestUrl) {
    var success = networkHandler.resetInterceptor(requestUrl);
    if (success) {
      descEvent.emit('success', 'Intercepts reset for url ' + requestUrl);
    } else {
      descEvent.emit('success', 'Intercepts not found for url ' + requestUrl);
    }
  } else {
    networkHandler.resetInterceptors();
    descEvent.emit('success', 'Intercepts reset for all url');
  }
};

module.exports.ts = require('./ts/taiko_ts');
