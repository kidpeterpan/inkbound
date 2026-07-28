const NN = /^(\d+)_/;

export function orderChapters(basenames: string[]): string[] {
  const numbered = basenames.filter((b) => NN.test(b));
  const rest = basenames.filter((b) => !NN.test(b));
  numbered.sort((a, b) => parseInt(NN.exec(a)![1], 10) - parseInt(NN.exec(b)![1], 10));
  rest.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
