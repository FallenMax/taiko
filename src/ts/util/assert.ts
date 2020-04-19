export const assertNever = (o: never): never => {
  throw new TypeError('Unexpected type:' + JSON.stringify(o));
};

export function assert<T>(
  condition: T,
  message: string,
): asserts condition is Exclude<T, undefined | null | 0 | ''> {
  if (!condition) {
    throw new Error(message);
  }
}
