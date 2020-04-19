import { ElementWrapper } from './element_wrapper';
import { find } from './find';
import { SelectorDesc, stringifySelector } from './taiko_types';
import { waitUntil } from './util/async/retry';

export class ElementWrapperList {
  kind = 'ElementWrapperList' as const;
  get description(): string {
    return stringifySelector(this.selectorDesc);
  }
  text = '';
  selectorDesc: SelectorDesc;
  _elements: ElementWrapper[] = [];
  constructor(opts: { selectorDesc?: SelectorDesc; element?: ElementWrapper }) {
    if (opts.element) {
      this.selectorDesc = opts.element.selectorDesc;
      this._elements = [opts.element];
    } else if (opts.selectorDesc) {
      this.selectorDesc = opts.selectorDesc;
    } else {
      throw new TypeError('expected selectorDesct or element');
    }
  }
  toJSON() {
    return this.description;
  }
  toString() {
    return this.description;
  }
  async exists() {
    return Boolean(await this.firstElement());
  }
  async isVisible() {
    return await this.firstElement();
  }
  async isDisabled() {
    return false;
  }
  async elements(): Promise<ElementWrapper[]> {
    if (this._elements.length) {
      return this._elements;
    }
    await waitUntil(
      async () => {
        const ids = await find(this.selectorDesc);
        if (!ids.length) {
          return false;
        } else {
          this._elements = ids.map(
            (id) => new ElementWrapper({ nodeId: id, selectorDesc: this.selectorDesc }),
          );
          return true;
        }
      },
      100,
      3000,
    ).catch((e) => {
      console.warn('elements(): cannot find any');
    });
    return this._elements;
  }
  async firstElement(): Promise<ElementWrapper | undefined> {
    return (await this.elements())[0];
  }
}
