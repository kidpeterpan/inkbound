const NN = /^(\d+)_/;

export function orderChapters(basenames: string[]): string[] {
  const numbered = basenames.filter((b) => NN.test(b));
  const rest = basenames.filter((b) => !NN.test(b));
  numbered.sort((a, b) => parseInt(NN.exec(a)![1], 10) - parseInt(NN.exec(b)![1], 10));
  rest.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...numbered, ...rest];
}

// 009-index-order-parts (research R6): orderChapters' rule over items that
// carry a name, so a folder's unlinked notes AND unlinked subfolders can be
// ordered together (FR-012) — a subfolder participates under its folder name.
// Same comparison as orderChapters on purpose (plain code-point order, so
// uppercase sorts before lowercase): "today's order" is defined by that
// function, and this must agree with it for every list of plain strings.
// Array.prototype.sort is stable, so equal names keep input order.
export function orderByName<T>(items: T[], key: (item: T) => string): T[] {
  const numbered = items.filter((i) => NN.test(key(i)));
  const rest = items.filter((i) => !NN.test(key(i)));
  numbered.sort((a, b) => parseInt(NN.exec(key(a))![1], 10) - parseInt(NN.exec(key(b))![1], 10));
  rest.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return [...numbered, ...rest];
}

export function pickIndexNote(
  candidates: { basename: string; tags: string[] }[],
  folderName: string
): string | null {
  const tagged = candidates.find((c) => c.tags.includes("book") && c.tags.includes("main"));
  if (tagged) return tagged.basename;
  const named = candidates.find((c) => c.basename === folderName);
  return named ? named.basename : null;
}

export function bfsLinked(
  links: Record<string, Record<string, number>>,
  start: string,
  depth: number
): string[] {
  const seen = new Set<string>([start]);
  const out: string[] = [start];
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const target of Object.keys(links[node] ?? {})) {
        if (!target.endsWith(".md") || seen.has(target)) continue;
        seen.add(target);
        next.push(target);
      }
    }
    next.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    out.push(...next);
    frontier = next;
  }
  return out;
}
