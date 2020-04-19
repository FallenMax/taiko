import runtimeHandler from '../handlers/runtimeHandler';
import { logFind } from '../logger';
import { ConstraintDesc, SelectorDesc, stringifySelector } from './taiko_types';

type Rect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

type ConstraintResolved = ConstraintDesc & {
  selector: SelectorResolved;
};

type SelectorResolved = SelectorDesc & {
  elements: { elem: Node; rect: Rect; score: number }[];
  constraints: ConstraintResolved[];
};

async function findSelectorFunc(selector: SelectorDesc): Promise<Node[]> {
  // console.log('start looking for:', JSON.stringify(selector));

  const assertNever = (o: never): never => {
    throw new TypeError('Unexpected type:' + JSON.stringify(o));
  };

  const getRect = (elem: Node): Rect | undefined => {
    if (elem.nodeType === Node.TEXT_NODE) {
      let range = document.createRange();
      range.selectNodeContents(elem);
      const rect = range.getClientRects()[0];
      if (!rect) return undefined;
      const { left, top, bottom, right } = rect;
      return { left, top, bottom, right };
    } else {
      const rect = (elem as HTMLElement).getBoundingClientRect();
      if (!rect) {
        return undefined;
      }
      const { left, top, bottom, right } = rect;
      return { left, top, bottom, right };
    }
  };

  const getDistance = (refRect: Rect, rect: Rect, type: ConstraintDesc['type']): number => {
    switch (type) {
      case 'above':
        return refRect.top - rect.bottom;
      case 'below':
        return rect.top - refRect.bottom;
      case 'toLeftOf':
        return refRect.left - rect.right;
      case 'toRightOf':
        return rect.left - refRect.right;
      case 'near': {
        const vDist = (refRect.top + refRect.bottom) / 2 - (rect.top + rect.bottom) / 2;
        const hDist = (refRect.left + refRect.right) / 2 - (rect.left + rect.right) / 2;
        const dist = Math.sqrt(vDist * vDist + hDist * hDist);
        return dist;
      }
    }
  };

  const resolveSelectorWithoutConstraint = (
    selector: SelectorDesc,
  ): { elem: Node; rect: Rect; score: number }[] => {
    switch (selector.type) {
      case 'cssSelector':
        return ([] as Node[]).slice
          .apply(document.querySelectorAll(selector.cssSelector))
          .map((elem) => {
            return {
              elem,
              rect: getRect(elem),
              score: 0,
            };
          })
          .filter((elem) => {
            return elem.rect;
          }) as { elem: Node; rect: Rect; score: number }[];

      case 'text': {
        const treeWalker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT, {
          acceptNode() {
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        const texts: Text[] = [];
        while (treeWalker.nextNode()) {
          texts.push(treeWalker.currentNode as Text);
        }

        const exactMatch: { elem: Node; rect: Rect; score: number }[] = [];
        const containMatch: { elem: Node; rect: Rect; score: number }[] = [];
        texts.forEach((node) => {
          const text = node.textContent || '';
          if (text === selector.text) {
            const rect = getRect(node);
            if (rect) {
              exactMatch.push({
                elem: node,
                rect,
                score: 0,
              });
            }
          } else if (!selector.exact && text.includes(selector.text)) {
            if (node.parentElement) {
              const rect = getRect(node);
              if (rect) {
                containMatch.push({
                  elem: node,
                  rect,
                  score: 10,
                });
              }
            }
          }
        });
        // also try matching TextNode's parentElement
        (texts.map((t) => t.parentNode).filter(Boolean) as HTMLElement[]).forEach((node) => {
          const text = node.textContent || '';
          if (text === selector.text) {
            const rect = getRect(node);
            if (rect) {
              exactMatch.push({
                elem: node,
                rect,
                score: 5,
              });
            }
          } else if (!selector.exact && text.includes(selector.text)) {
            if (node.parentElement) {
              const rect = getRect(node);
              if (rect) {
                containMatch.push({
                  elem: node,
                  rect,
                  score: 15,
                });
              }
            }
          }
        });

        const inputTypes = 'email,number,password,text,url,tel,search'.split(',');
        const inputs: (HTMLInputElement | HTMLTextAreaElement)[] = [].slice
          .apply(document.querySelectorAll(`input,textarea`))
          .filter((el: HTMLInputElement | HTMLTextAreaElement) => {
            if (el.nodeName.toLowerCase() === 'input') {
              return inputTypes.includes(el.type) || !el.type;
            }
            return true;
          });
        inputs.forEach((input) => {
          const text = input.value || input.placeholder || '';
          if (text === selector.text) {
            exactMatch.push({
              elem: input,
              rect: input.getBoundingClientRect(),
              score: 0,
            });
          } else if (!selector.exact && text.includes(selector.text)) {
            containMatch.push({
              elem: input,
              rect: input.getBoundingClientRect(),
              score: 10,
            });
          }
        });
        return exactMatch.concat(containMatch);
      }
      case 'textBox': {
        const inputTypes = 'email,number,password,text,url,tel,search'.split(',');
        let inputs: HTMLElement[] = [].slice
          .apply(document.querySelectorAll(`input,textarea`))
          .filter((el: HTMLInputElement | HTMLTextAreaElement) => {
            if (el.nodeName.toLowerCase() === 'input') {
              return inputTypes.includes(el.type) || !el.type;
            }
            return true;
          });
        if (selector.attributes) {
          const keyValuePairs = Object.entries(selector.attributes);
          inputs = inputs.filter((input) => {
            return keyValuePairs.every(([key, value]) => input[key] == value);
          });
        }
        return inputs.map((input) => {
          return {
            elem: input,
            rect: input.getBoundingClientRect(),
            score: 0,
          };
        });
      }
      default:
        return assertNever(selector);
    }
  };

  const resolveSelector = (selector: SelectorDesc): SelectorResolved => {
    if (selector.kind !== 'SelectorDesc') {
      console.error(selector);
      throw new TypeError('not SelectorDesc');
    }
    const { constraints } = selector;
    const constraintsResolved = constraints.map(
      (constraint): ConstraintResolved => {
        if (constraint.kind !== 'ConstraintDesc') {
          console.error(constraint);
          throw new TypeError('not ConstraintDesc');
        }
        return {
          ...constraint,
          selector: resolveSelector(constraint.selector),
        };
      },
    );

    const candicates = resolveSelectorWithoutConstraint(selector);
    // console.log('candicates ', candicates);

    if (!candicates.length) {
      throw new Error('no matching elements, even without applying constraints');
    }

    const visibleElements = candicates
      .map((c) => {
        const { left, top, bottom, right } = c.rect;

        return {
          ...c,
          rect: { left, top, bottom, right },
        };
      })
      .filter((el) => {
        // rule out empty/invisible/unclickable elements
        return el.rect && el.rect.bottom > el.rect.top && el.rect.right > el.rect.left;
      });
    // console.log('visibleElements ', visibleElements);

    const matchingElems = visibleElements
      .map((el) => {
        // apply constraints
        const { rect, elem } = el;
        let score = el.score; // the lower the better
        // ALL constraint must be met
        for (const con of constraintsResolved) {
          const {
            selector: { elements: refElements },
            type,
          } = con;
          let minDistance = Infinity;
          // ONLY Ref Element is required to pass test for single constraint, but we need to find minimal distance
          for (const refEl of refElements) {
            const refRect = refEl.rect;
            const distance = getDistance(refRect, rect, type);
            if (distance >= 0 && distance < minDistance) {
              minDistance = distance;
            }
          }
          if (minDistance == Infinity) {
            return { rect, elem, score: -1 };
          }
          score += minDistance;
        }

        return {
          rect,
          elem,
          score,
        };
      })
      .filter((el) => {
        return el.score >= 0;
      })
      .sort((a, b) => {
        return a.score - b.score;
      })
      .slice(0, 50);
    // console.log('matchedElements ', matchingElems);
    if (!matchingElems.length) {
      throw new Error('no matching elements');
    }

    // const clickableElems = matchingElems.filter((el) => isElementAtPointOrChild(el.elem));
    // if (!clickableElems.length) {
    //   throw new Error('no clickable elements');
    // }

    return {
      ...selector,
      constraints: constraintsResolved,
      elements: matchingElems,
    };
  };

  try {
    const resolved = resolveSelector(selector);
    // console.log('resolved ', resolved);
    return resolved.elements.map((e) => e.elem);
  } catch (error) {
    console.warn('elements not found:', selector, error);
    // console.error(error);
    return [];
  }
}

export const find = async (selector: SelectorDesc): Promise<string[]> => {
  logFind('searching: ', stringifySelector(selector));
  const nodeIds = await runtimeHandler.findElements(findSelectorFunc, selector);
  logFind('found: ', nodeIds);
  return nodeIds;
};
