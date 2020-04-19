export function isElementAtPointOrChild(elem: Node): boolean {
  function getDirectParent(nodes, elem) {
    return nodes.find((node) => node.contains(elem));
  }

  let rect;
  if (elem.nodeType === Node.TEXT_NODE) {
    let range = document.createRange();
    range.selectNodeContents(elem);
    rect = range.getClientRects()[0];
    elem = elem.parentElement!;
  } else {
    rect = (elem as any).getBoundingClientRect();
  }
  const y = (rect.top + rect.bottom) / 2;
  const x = (rect.left + rect.right) / 2;

  const nodes = document.elementsFromPoint(x, y);
  const isElementCoveredByAnotherElement = nodes[0] !== elem;
  let node: any = null;
  if (isElementCoveredByAnotherElement) {
    node = document.elementFromPoint(x, y);
  } else {
    node = getDirectParent(nodes, elem);
  }
  if (node && elem) {
    console.log(node.contains(elem), elem.contains(node));
  }
  return (
    node &&
    elem &&
    (elem.contains(node) ||
      node.contains(elem) ||
      Number(window.getComputedStyle(node).getPropertyValue('opacity')) < 0.1 ||
      Number(window.getComputedStyle(elem as any).getPropertyValue('opacity')) < 0.1)
  );
}
