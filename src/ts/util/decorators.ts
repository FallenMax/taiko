const isPromise = <T = any>(o: any): o is Promise<T> => {
  return typeof (o && o.then) === 'function';
};

export type AnyFunction = (...args: any[]) => any | Promise<any>;
export type Decorator = <T extends AnyFunction>(fn: T, name?: string) => T;

interface DecoratorOptions<T extends AnyFunction> {
  onCalled?(params: Parameters<T>, fnName: string): void;
  onReturned?(result: ReturnType<T>, params: Parameters<T>, fnName: string): void;
  onError?(error: any, params: Parameters<T>, fnName: string): void;
  fnName?: string;
  self?: any;
}

/** 创建一个函数装饰器 */
export function createDecorator<T extends AnyFunction>({
  onCalled,
  onReturned,
  onError,
  self = null,
}: DecoratorOptions<T>): Decorator {
  const decorator = (fn: AnyFunction, fnName: string) => {
    const decoratedFunction = ((...params: Parameters<T>): ReturnType<T> => {
      if (onCalled) {
        onCalled(params, fnName || fn.name);
      }

      try {
        const result = fn.apply(self, params) as ReturnType<T> | ReturnType<T>;
        if (isPromise(result)) {
          return result.then(
            (result: ReturnType<T>) => {
              if (onReturned) {
                return Promise.resolve(onReturned(result, params, fnName || fn.name)).then(
                  () => result,
                );
              }
              return result;
            },
            (error: any) => {
              if (onError) {
                return Promise.resolve(onError(error, params, fnName || fn.name)).then(() => {
                  throw error;
                });
              }
              throw error;
            },
          );
        } else {
          if (onReturned) {
            onReturned(result, params, fnName || fn.name);
          }
          return result;
        }
      } catch (error) {
        if (onError) {
          onError(error, params, fnName || fn.name);
        }
        throw error;
      }
    }) as T;

    return decoratedFunction;
  };
  return decorator as any;
}
