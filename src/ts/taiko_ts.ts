import { defaultConfig } from '../config';
import domHandler from '../handlers/domHandler';
import inputHandler, { sendCharacter } from '../handlers/inputHandler';
import overlayHandler from '../handlers/overlayHandler';
import runtimeHandler from '../handlers/runtimeHandler';
import { descEvent } from '../helper';
import { logEvaluate, logPageAction, logWait } from '../logger';
import { getInput } from '../taiko';
import { ElementWrapper } from './element_wrapper';
import { ElementWrapperList } from './element_wrapper_list';
import { isRelativeSearchElement, RelativeSearchElement } from './relative_search_element';
import {
  ConstraintDesc,
  createConstraintDesc,
  createSelectorDesc,
  SelectorDesc,
} from './taiko_types';
import { assert, assertNever } from './util/assert';
import { waitUntil } from './util/async/retry';
import { wait } from './util/async/wait';
import { createDecorator, Decorator } from './util/decorators';
import { isElementAtPointOrChild } from './util/dom/at_point';

type Selector = string | ElementWrapper | ElementWrapperList;
const isSelector = (o: any): o is Selector => {
  return typeof o === 'string' || o instanceof ElementWrapper || o instanceof ElementWrapperList;
};

const select = (
  selector: Selector,
  relativeSelectors: RelativeSearchElement[] = [],
): ElementWrapperList => {
  if (typeof selector === 'string') {
    return text(selector, ...relativeSelectors);
  } else if (selector instanceof ElementWrapperList) {
    if (relativeSelectors.length) {
      const desc: SelectorDesc = {
        ...selector.selectorDesc,
        constraints: selector.selectorDesc.constraints.concat(
          relativeSelectors.map((r) => r.constaintDesc),
        ),
      };
      return new ElementWrapperList({ selectorDesc: desc });
    } else {
      return selector;
    }
  } else if (selector instanceof ElementWrapper) {
    if (relativeSelectors.length) {
      const desc: SelectorDesc = {
        ...selector.selectorDesc,
        constraints: selector.selectorDesc.constraints.concat(
          relativeSelectors.map((r) => r.constaintDesc),
        ),
      };
      return new ElementWrapperList({ selectorDesc: desc });
    } else {
      return new ElementWrapperList({ element: selector });
    }
  } else {
    return assertNever(selector);
  }
};

const validate = () => {};

export const withEmittingSuccess = createDecorator({
  async onReturned(result, params, fnName) {
    descEvent.emit('success', '');
  },
});
const withWaitAfterAction = createDecorator({
  async onReturned(result, params, fnName) {
    await wait(16);
    logWait('[wait] wait for page ready');
    await waitUntil(async () =>
      _evaluate(function () {
        return top.document.readyState === 'complete';
      }),
    );
    logWait('[wait] page ready');
  },
});

const withLogging = createDecorator({
  onCalled(params, fnName) {
    logPageAction(`[${fnName}]`, ...params);
  },
  onReturned(result, params, fnName) {
    logPageAction(`[${fnName}]`, result);
  },
  onError(error, params, fnName) {
    logPageAction(`[${fnName}] error:`);
    console.error(error);
  },
});

const just = <T>(t: T): T => t;

//-------------- Page Actions --------------
const wrapPageAction: Decorator = (fn) => withWaitAfterAction(withLogging(fn));

export const highlight = async (
  selector: Selector,
  ...relativeSelectors: RelativeSearchElement[]
) => {
  const el = await select(selector, relativeSelectors).firstElement();
  assert(el, 'element not found');
  if (defaultConfig.headful) {
    if (defaultConfig.highlightOnAction.toLowerCase() !== 'true') {
      return;
    }
    let result = await domHandler.getBoxModel(el.get());
    await overlayHandler.highlightQuad(result.model.border);
    await wait(defaultConfig.highlightTime);
    await overlayHandler.hideHighlight();
  }
};

export type ClickOptions = {
  button?: 'left' | 'right' | 'middle';
};
export const click = wrapPageAction(
  async (
    selector: Selector,
    options?: ClickOptions | RelativeSearchElement,
    ...relativeSelectors: RelativeSearchElement[]
  ) => {
    const _options = options && !isRelativeSearchElement(options) ? options : ({} as ClickOptions);
    const { button = 'left' } = _options || {};
    const _relativeSelectors = [options, ...relativeSelectors].filter(isRelativeSearchElement);
    const elems = await select(selector, _relativeSelectors).elements();
    for (const el of elems) {
      await scrollTo(select(el));
      const { x, y } = await domHandler.boundingBoxCenter(el.get());
      if (await evaluate(el, isElementAtPointOrChild)) {
        await highlight(el);
        const input = getInput();
        await input.dispatchMouseEvent({
          type: 'mouseMoved',
          x,
          y,
          clickCount: 1,
        });
        await input.dispatchMouseEvent({
          type: 'mousePressed',
          x,
          y,
          button,
          clickCount: 1,
        });
        await input.dispatchMouseEvent({
          type: 'mouseReleased',
          x,
          y,
          button,
          clickCount: 1,
        });
        return;
      }
    }
    throw new Error('no clickable elements');
  },
);

export const doubleClick = wrapPageAction(
  async (
    selector: Selector,
    options?: ClickOptions | RelativeSearchElement,
    ...relativeSelectors: RelativeSearchElement[]
  ) => {
    const _options = options && !isRelativeSearchElement(options) ? options : ({} as ClickOptions);
    const { button = 'left' } = _options || {};
    const _relativeSelectors = [options, ...relativeSelectors].filter(isRelativeSearchElement);
    const elems = await select(selector, _relativeSelectors).elements();
    for (const el of elems) {
      await scrollTo(select(el));
      const { x, y } = await domHandler.boundingBoxCenter(el.get());
      if (await evaluate(el, isElementAtPointOrChild)) {
        await highlight(el);
        const input = getInput();
        await input.dispatchMouseEvent({
          type: 'mouseMoved',
          x,
          y,
          clickCount: 1,
        });
        await input.dispatchMouseEvent({
          type: 'mousePressed',
          x,
          y,
          button,
          clickCount: 1,
        });
        await input.dispatchMouseEvent({
          type: 'mouseReleased',
          x,
          y,
          button,
          clickCount: 1,
        });
        await input.dispatchMouseEvent({
          type: 'mousePressed',
          x,
          y,
          button,
          clickCount: 1,
        });
        await input.dispatchMouseEvent({
          type: 'mouseReleased',
          x,
          y,
          button,
          clickCount: 1,
        });
        return;
      }
    }
    throw new Error('no clickable elements');
  },
);

export const press = wrapPageAction(async (keys: string | string[]) => {
  let _keys = ([] as string[]).concat(keys);
  for (let i = 0; i < _keys.length; i++) {
    await inputHandler.down(_keys[i]);
  }
  await wait(10);

  _keys = _keys.reverse();
  for (let i = 0; i < _keys.length; i++) {
    await inputHandler.up(_keys[i]);
  }
});

export const hover = wrapPageAction(
  async (selector: Selector, ...relativeSelectors: RelativeSearchElement[]) => {
    const el = await select(selector, relativeSelectors).firstElement();
    assert(el, 'element not found');
    await scrollTo(select(el));
    const { x, y } = await domHandler.boundingBoxCenter(el.get());
    await highlight(el);
    const input = getInput();
    await input.dispatchMouseEvent({
      type: 'mouseMoved',
      x,
      y,
    });
  },
);

export const tap = wrapPageAction(
  async (selector: Selector, ...relativeSelectors: RelativeSearchElement[]) => {
    const el = await select(selector, relativeSelectors).firstElement();
    assert(el, 'element not found');
    await scrollTo(select(el));
    const { x, y } = await domHandler.boundingBoxCenter(el.get());
    await highlight(el);
    await inputHandler.tap(x, y);
  },
);

export const write = wrapPageAction(
  async (
    text: string,
    selector?: Selector,
    ...relativeSelectors: RelativeSearchElement[]
  ): Promise<void> => {
    if (selector) {
      const sel = select(selector, relativeSelectors);
      await highlight(sel);
      await focus(sel);
      await waitUntil(() =>
        evaluate(sel, function (elem: HTMLInputElement | HTMLTextAreaElement) {
          return elem === document.activeElement && !elem.readOnly && !elem.disabled;
        }),
      );
    } else {
      await waitUntil(() =>
        evaluate(function () {
          const el = document.activeElement as HTMLTextAreaElement | HTMLInputElement;
          if (el && ['textarea', 'input'].includes(el.nodeName.toLowerCase())) {
            return !el.readOnly && !el.disabled;
          } else {
            return false;
          }
        }),
      );
    }
    await sendCharacter(text);
  },
);

export const clear = wrapPageAction(
  async (selector?: Selector, ...relativeSelectors: RelativeSearchElement[]): Promise<void> => {
    if (selector) {
      const sel = select(selector, relativeSelectors);
      await highlight(sel);
      await focus(sel);
      await waitUntil(() =>
        evaluate(sel!, function (elem: HTMLInputElement | HTMLTextAreaElement) {
          return elem === document.activeElement && !elem.readOnly && !elem.disabled;
        }),
      );
    } else {
      await waitUntil(() =>
        evaluate(function () {
          const el = document.activeElement as HTMLTextAreaElement | HTMLInputElement;
          if (el && ['textarea', 'input'].includes(el.nodeName.toLowerCase())) {
            return !el.readOnly && !el.disabled;
          } else {
            return false;
          }
        }),
      );
    }
    await evaluate(function () {
      document.execCommand('selectall', false, undefined);
    });
    await inputHandler.down('Backspace');
    await inputHandler.up('Backspace');
  },
);

export const focus = wrapPageAction(
  async (selector: Selector, ...relativeSelectors: RelativeSearchElement[]) => {
    const el = await select(selector, relativeSelectors).firstElement();
    assert(el, 'element not found');

    await highlight(el);
    await scrollTo(el);
    await evaluate(el, function focusElement(elem: any) {
      if (elem.disabled == true) {
        throw new Error('Element is not focusable');
      }
      elem.focus();
      if (document.activeElement === elem) {
        return;
      } else {
        throw new Error('cannot focus element');
      }
    });
  },
);

export const scrollTo = wrapPageAction(
  async (selector: Selector, ...relativeSelectors: RelativeSearchElement[]) => {
    await evaluate(select(selector, relativeSelectors), function scrollToNode(elem: any) {
      const element = elem.nodeType === Node.TEXT_NODE ? elem.parentElement : elem;
      element.scrollIntoViewIfNeeded();
    });
  },
);

const _evaluate = (async (
  selector: Selector,
  expOrFunc: Function,
  options: { args?: any[] } = {},
) => {
  logEvaluate('[evalute]', expOrFunc, selector, options);
  validate();
  let sel: Selector | undefined;
  if (isSelector(selector)) {
    sel = selector;
  } else {
    sel = $('body');
    options = expOrFunc as { args?: any[] };
    expOrFunc = selector as any;
  }
  const elem = await select(sel).firstElement();
  const nodeId = elem && elem.nodeId;
  logEvaluate('[evalute] selector ', selector, elem, nodeId);
  assert(nodeId, 'nodeId empty');
  const result = await runtimeHandler.runtimeCallFunctionOn(
    async function evalFunc(this: any, { callback, args }) {
      // console.log('[evaluating]', this, callback, args);
      let fn;
      eval(`fn = ${callback}`);
      return await fn(this, args);
    },
    null,
    {
      nodeId,
      arg: { callback: expOrFunc.toString(), args: options && options.args },
      returnByValue: true,
    },
  );
  if (!result) {
    return undefined;
  }
  if (result.result.subtype === 'error') {
    console.error(result.result);
    throw new Error(result.result.description);
  }
  logEvaluate('[evalute] result: ', result.result.value);
  return result.result.value;
}) as (
  selector: Selector | string | Function,
  expOrFunc?: string | Function | object,
  options?: { args?: any[] },
) => Promise<any>;

export const evaluate = wrapPageAction(_evaluate);

//-------------- Selectors  --------------

export const $ = (
  cssSelector: string,
  ...relatives: RelativeSearchElement[]
): ElementWrapperList => {
  const selectorDesc = createSelectorDesc(
    {
      type: 'cssSelector',
      cssSelector: cssSelector,
    },
    relatives.filter(isRelativeSearchElement).map((r) => r.constaintDesc),
  );
  return new ElementWrapperList({ selectorDesc });
};

export const text = (
  str: string,
  options?: { exactMatch: boolean } | RelativeSearchElement,
  ...relatives: RelativeSearchElement[]
): ElementWrapperList => {
  const args = [str, options, ...relatives];
  const _options = options && !isRelativeSearchElement(options) ? options : { exactMatch: false };
  const exact = _options && typeof _options.exactMatch === 'boolean' ? _options.exactMatch : false;
  const selectorDesc = createSelectorDesc(
    {
      type: 'text',
      text: str,
      exact,
    },
    args.filter(isRelativeSearchElement).map((r) => r.constaintDesc),
  );
  return new ElementWrapperList({ selectorDesc });
};

export const textBox = (
  attrValuePairs?: object,
  ...relatives: RelativeSearchElement[]
): ElementWrapperList => {
  const args = [attrValuePairs, ...relatives];
  const attrs = args.find((a) => typeof a === 'object' && !isRelativeSearchElement(a)) || undefined;
  const selectorDesc = createSelectorDesc(
    {
      type: 'textBox',
      attributes: attrs,
    },
    args.filter(isRelativeSearchElement).map((r) => r.constaintDesc),
  );
  return new ElementWrapperList({ selectorDesc });
};

//-------------- Proximity selectors  --------------

const createRelativeApi = (type: ConstraintDesc['type']) => (
  selector: Selector,
): RelativeSearchElement => {
  const constaintDesc = createConstraintDesc(select(selector).selectorDesc, type);
  return new RelativeSearchElement({ constaintDesc });
};

export const above = createRelativeApi('above');
export const below = createRelativeApi('below');
export const toLeftOf = createRelativeApi('toLeftOf');
export const toRightOf = createRelativeApi('toRightOf');
export const near = createRelativeApi('near');
