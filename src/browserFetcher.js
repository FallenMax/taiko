const fs = require('fs-extra');
var url = require('url');

const { helper, assert } = require('./helper');
const readline = require('readline');
const readdirAsync = helper.promisify(fs.readdir.bind(fs));
const mkdirAsync = helper.promisify(fs.mkdir.bind(fs));
const unlinkAsync = helper.promisify(fs.unlink.bind(fs));
const chmodAsync = helper.promisify(fs.chmod.bind(fs));

class BrowserFetcher {
  waitForWSEndpoint(chromeProcess, timeout) {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({
        input: chromeProcess.stderr,
      });
      let stderr = '';
      const listeners = [
        helper.addEventListener(rl, 'line', onLine),
        helper.addEventListener(rl, 'close', () => onClose()),
        helper.addEventListener(chromeProcess, 'exit', () => onClose()),
        helper.addEventListener(chromeProcess, 'error', (error) => onClose(error)),
      ];
      const timeoutId = timeout ? setTimeout(onTimeout, timeout) : 0;

      function onClose(error) {
        cleanup();
        reject(
          new Error(
            'Failed to launch chrome!' + (error ? ' ' + error.message : '') + '\n' + stderr,
          ),
        );
      }

      function onTimeout() {
        cleanup();
        reject(new Error(`Timed out after ${timeout} ms while trying to connect to Chrome!`));
      }

      /**
       * @param {string} line
       */
      function onLine(line) {
        stderr += line + '\n';
        const match = line.match(/^DevTools listening on (ws:\/\/.*)$/);
        if (!match) {
          return;
        }
        cleanup();
        const endpoint = {
          host: url.parse(match[1]).hostname,
          port: url.parse(match[1]).port,
          browser: url.parse(match[1]).href,
        };
        resolve(endpoint);
      }

      function cleanup() {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        helper.removeEventListeners(listeners);
      }
    });
  }
}

module.exports = BrowserFetcher;
