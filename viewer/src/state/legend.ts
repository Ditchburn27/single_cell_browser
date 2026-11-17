// Which categories a pane is hiding. Kept as plain set operations so the "last one
// standing" rules are testable without a DOM.

/**
 * Click on a legend entry: hide it, or show it again if already hidden.
 * Hiding the only group still visible would leave an empty plot, so that click
 * shows everything instead.
 */
export function toggleHidden(hidden: Set<number>, code: number, nCats: number): void {
  if (!hidden.has(code) && hidden.size === nCats - 1) hidden.clear();
  else if (hidden.has(code)) hidden.delete(code);
  else hidden.add(code);
}

/**
 * Double-click on a legend entry: show only that group. Repeating it on the group
 * that is already on its own restores the full set.
 */
export function isolate(hidden: Set<number>, code: number, nCats: number): void {
  const only = !hidden.has(code) && hidden.size === nCats - 1;
  hidden.clear();
  if (!only) for (let k = 0; k < nCats; k++) if (k !== code) hidden.add(k);
}
