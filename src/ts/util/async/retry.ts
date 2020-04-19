import { wait } from './wait';

type Decorator = <T>(fn: T) => T;
export const withRetry = (interval = 100, timeout = 10000): Decorator =>
  ((fn: Function) => async (...args: any[]) => {
    let start = new Date().getTime();
    let end = start + timeout;
    while (true) {
      try {
        return await fn(...args);
      } catch (error) {
        const now = new Date().getTime();
        if (now > end) {
          throw error;
        }
        console.warn(`retrying in ${interval / 1000}s`);
        await wait(interval);
      }
    }
  }) as any;

export const waitUntil = async (
  condition: () => Promise<boolean>,
  retryInterval: number = 100,
  retryTimeout: number = 10000,
) => {
  if (!retryTimeout) {
    return;
  }
  const start = new Date().getTime();
  const end = start + retryTimeout;
  while (true) {
    let error;
    try {
      if (await condition()) {
        break;
      }
    } catch (e) {
      error = e;
    }
    if (new Date().getTime() > end) {
      if (!error) {
        error = new Error(`waiting failed: retryTimeout ${retryTimeout}ms exceeded`);
      }
      throw error;
    }
    await wait(retryInterval);
  }
};
