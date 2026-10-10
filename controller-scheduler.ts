// Stable, dependency-aware scheduling of explicit changes. All other atomics
// remain scheduled; missing history never licenses dropping a requirement.
type Node = Record<string, any>;
export type ScheduledModule = { index: number; total: number; nodeId: string; name: string; rootContext: string; moduleContext: string; subtree: Node };
export function prioritizeEvolution(modules: ScheduledModule[]): ScheduledModule[] {
  const nodes = new Map<string, Node>();
  const atoms: { node: Node; owner: ScheduledModule; parents: Node[]; changed: boolean }[] = [];
  const changed = (n: Node) => /^(ADD|CHANGE|MODIFY|NEW)$/i.test(String(n.change_type ?? ''))
    || /Modified Feature Description|New Feature Description/i.test(String(n.description ?? ''))
    || (n.scenarios ?? []).some((s: Node) => /evolution/i.test(String(s.name ?? '')));
  const visit = (node: Node, owner: ScheduledModule, parents: Node[]) => {
    if (nodes.has(node.id)) throw new Error(`Duplicate requirement ID: ${node.id}`);
    nodes.set(node.id, node);
    if (node.type === 'ATOMIC') atoms.push({ node, owner, parents, changed: [...parents, node].some(changed) });
    for (const child of node.children ?? []) visit(child, owner, [...parents, node]);
  };
  modules.forEach(m => visit(m.subtree, m, []));
  if (!atoms.some(a => a.changed)) return modules;
  // Unknown/empty module shapes retain the original complete tree.
  if (modules.some(m => !atoms.some(a => a.owner === m))) return modules;
  const ids = new Set(atoms.map(a => a.node.id));
  const descendants = (id: string): string[] => {
    const n = nodes.get(id);
    if (!n) return []; // External baseline requirement: context, not new work.
    if (ids.has(id)) return [id];
    return (n.children ?? []).flatMap((c: Node) => descendants(c.id));
  };
  const deps = new Map(atoms.map(a => [a.node.id, new Set<string>([...a.parents, a.node]
    .flatMap(n => (n.dependencies ?? []).filter((id: string) => !["ROOT", a.node.id, ...a.parents.map(p => p.id)].includes(id)).flatMap(descendants)).filter((id: string) => id !== a.node.id))]));
  const urgent = new Set<string>();
  const mark = (id: string) => { if (urgent.has(id)) return; urgent.add(id); for (const d of deps.get(id) ?? []) mark(d); };
  atoms.filter(a => a.changed).forEach(a => mark(a.node.id));
  const pending = [...atoms], done = new Set<string>(), ordered: typeof atoms = [];
  while (pending.length) {
    const ready = pending.filter(a => [...deps.get(a.node.id)!].every(d => done.has(d)));
    const next = ready.find(a => urgent.has(a.node.id)) ?? ready[0];
    if (!next) throw new Error('Requirement dependency cycle; retaining original schedule');
    ordered.push(next); done.add(next.node.id); pending.splice(pending.indexOf(next), 1);
  }
  const groups: { owner: ScheduledModule; items: typeof atoms; chars: number; scenarios: number; urgent: boolean }[] = [];
  for (const atom of ordered) {
    const chars = JSON.stringify(atom.node).length, scenarios = (atom.node.scenarios ?? []).length;
    let group = groups.at(-1);
    if (!group || group.owner !== atom.owner || group.urgent !== urgent.has(atom.node.id)
      || group.items.length >= 4 || group.chars + chars > 20000 || group.scenarios + scenarios > 12) {
      group = { owner: atom.owner, items: [], chars: 0, scenarios: 0, urgent: urgent.has(atom.node.id) }; groups.push(group);
    }
    group.items.push(atom); group.chars += chars; group.scenarios += scenarios;
  }
  return groups.map((g, index) => {
    const selected = new Set(g.items.map(a => a.node.id));
    const rank = new Map(g.items.map((a, i) => [a.node.id, i]));
    const order = (n: Node): number => rank.get(n.id) ?? Math.min(...(n.children ?? []).map(order));
    const prune = (node: Node): Node | undefined => {
      if (node.type === 'ATOMIC') return selected.has(node.id) ? structuredClone(node) : undefined;
      const children = (node.children ?? []).map(prune).filter(Boolean).sort((a: Node, b: Node) => order(a) - order(b));
      return children.length ? { ...structuredClone(node), children } : undefined;
    };
    return { ...g.owner, index: index + 1, total: groups.length, subtree: prune(g.owner.subtree)! };
  });
}
