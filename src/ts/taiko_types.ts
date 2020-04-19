import { assertNever } from './util/assert';

export namespace Selectors {
  export type CssSelector = {
    type: 'cssSelector';
    cssSelector: string;
  };
  export type Text = {
    type: 'text';
    text: string;
    exact: boolean;
  };
  export type TextBox = {
    type: 'textBox';
    attributes?: {};
  };
  export type Content = CssSelector | Text | TextBox;
  export type SelectorDesc = {
    kind: 'SelectorDesc';
    constraints: ConstraintDesc[];
  } & Content;
}
export type SelectorDesc = Selectors.SelectorDesc;
export const createSelectorDesc = (
  content: Selectors.Content,
  constraints: ConstraintDesc[],
): SelectorDesc => {
  return {
    kind: 'SelectorDesc',
    constraints,
    ...content,
  };
};

export type ConstraintDesc = {
  kind: 'ConstraintDesc';
  type: 'above' | 'below' | 'toLeftOf' | 'toRightOf' | 'near';
  selector: SelectorDesc;
};
export const createConstraintDesc = (
  selector: SelectorDesc,
  type: ConstraintDesc['type'],
): ConstraintDesc => {
  return {
    kind: 'ConstraintDesc',
    selector,
    type: type,
  };
};

export const stringifyConstraint = (constraint: ConstraintDesc): string => {
  const { selector } = constraint;
  switch (constraint.type) {
    case 'above':
      return `above ${stringifySelector(selector)}`;
    case 'below':
      return `below ${stringifySelector(selector)}`;
    case 'toLeftOf':
      return `to left of ${stringifySelector(selector)}`;
    case 'toRightOf':
      return `to right of ${stringifySelector(selector)}`;
    case 'near':
      return `near ${stringifySelector(selector)}`;
    default:
      return assertNever(constraint.type);
  }
};

export const stringifySelector = (selector: SelectorDesc): string => {
  const { constraints } = selector;
  const constraintStr = constraints.map(stringifyConstraint).join(' and ');
  const selectorStr = (() => {
    switch (selector.type) {
      case 'cssSelector':
        return `$(${selector.cssSelector})`;
      case 'text':
        return `${selector.text}`;
      case 'textBox': {
        const attrDesc = selector.attributes
          ? ' (' +
            Object.entries(selector.attributes)
              .map(([key, value]) => `${key}=${value}`)
              .join(', ') +
            ')'
          : '';
        return `text box${attrDesc}`;
      }
      default:
        return assertNever(selector);
    }
  })();
  return [selectorStr, constraintStr].join(' ');
};
