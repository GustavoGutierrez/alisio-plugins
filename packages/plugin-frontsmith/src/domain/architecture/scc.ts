/**
 * Strongly connected components with Tarjan's algorithm (iterative, so deep import chains cannot
 * overflow the stack). Only components that form a cycle are returned: more than one node, or a
 * node that imports itself. Each component lists its members sorted; components are sorted too.
 */
export function cycles(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; next: number };
      const targets = edges.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next] as string;
        frame.next += 1;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(target) as number));
        }
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent)
          low.set(
            parent.node,
            Math.min(low.get(parent.node) as number, low.get(frame.node) as number),
          );
        if (low.get(frame.node) === index.get(frame.node)) {
          const component: string[] = [];
          for (;;) {
            const member = stack.pop() as string;
            onStack.delete(member);
            component.push(member);
            if (member === frame.node) break;
          }
          const selfLoop =
            component.length === 1 &&
            (edges.get(component[0] as string) ?? []).includes(component[0] as string);
          if (component.length > 1 || selfLoop) result.push(component.sort());
        }
      }
    }
  }
  return result.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
}
