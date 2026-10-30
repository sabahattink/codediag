/** Calls `visit` with each name, one at a time. */
export function eachName(names: string[], visit: (name: string) => void) {
  for (const name of names) visit(name);
}
