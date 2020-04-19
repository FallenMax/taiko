import { evaluate } from './taiko_ts';
import { SelectorDesc, stringifySelector } from './taiko_types';

export class ElementWrapper {
  kind = 'ElementWrapper' as const;
  get description(): string {
    return stringifySelector(this.selectorDesc);
  }

  /** innerText of first element */
  selectorDesc: SelectorDesc;
  nodeId: string;
  constructor(opts: { nodeId: string; selectorDesc: SelectorDesc }) {
    this.selectorDesc = opts.selectorDesc;
    this.nodeId = opts.nodeId;
  }
  toJSON() {
    return this.description;
  }
  toString() {
    return this.description;
  }
  get() {
    return this.nodeId;
  }
  async text() {
    return evaluate(this, function (el) {
      if (el.nodeType === Node.TEXT_NODE) {
        return el.parentElement.innerText;
      } else {
        return el.innerText;
      }
    });
  }
  async value() {
    return evaluate(this, function (el) {
      return el.value;
    });
  }
  // async select(value?: string) {}
  // async deselect() {}
  // async check() {}
  // async uncheck() {}
  // async isChecked() {
  //   return true;
  // }
  async exists(retryInterval?: number, retryTimeout?: number) {
    return true;
  }
  async isVisible() {
    return true;
  }
  async isDisabled() {
    return evaluate(this, function (el: HTMLInputElement) {
      return el.disabled;
    });
  }
}
