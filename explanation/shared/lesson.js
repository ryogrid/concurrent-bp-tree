/* Resolve each teaching step against generated, unmodified Go source. */
(function () {
  "use strict";
  function section(file, symbol, anchor, before = 3, after = 9) {
    const lines = GoSource[file];
    const start = lines.findIndex(l => l.startsWith('func ') &&
      new RegExp('(?:^func |\\) )' + symbol + '\\(').test(l));
    if (start < 0) throw new Error(`Missing Go function ${file}:${symbol}`);
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('func ')) end++;
    const hit = anchor ? lines.findIndex((l, i) => i >= start && i < end && l.includes(anchor)) : start;
    if (hit < 0) throw new Error(`Missing Go anchor ${symbol}: ${anchor}`);
    const lo = Math.max(start, hit - before), hi = Math.min(end, hit + after + 1);
    return { file, symbol, hl: [hit + 1], lines: lines.slice(lo, hi).map((text, i) => ({ no: lo + i + 1, text })) };
  }
  function sourceFor(step, operation) {
    const op = step.operation || operation || 'put';
    const tree = (anchor, before, after) => section('tree.go', op, anchor, before, after);
    const node = name => section('node.go', name,
      name === 'leafInsertSplit' ? 'const leftN' : name === 'internalInsertSplit' ? 'const mid' : null, 0, 22);
    switch (step.tag) {
      case 'init': return [tree(null, 0, 5)];
      case 'latch-root': return [tree('t.rootMu.', 0, 14)];
      case 'descend': return [tree('ci := internalFindChildIdx', 0, 12), node('internalFindChildIdx')];
      case 'release-parent': return [tree('cf.latch.RLock()', 0, 6)];
      case 'descend-safe': return [tree('if safeFor' + (op === 'put' ? 'Insert' : 'Delete') + '(cf.', 1, 5)];
      case 'descend-unsafe': return [tree('held.frames = append', 5, 4)];
      case 'leaf-find': return [tree('pos, found :=', 0, 9), node('leafFindPos')];
      case 'overwrite': return [tree('leafSetPair(cur.', 2, 4), node('leafSetPair')];
      case 'insert': return [tree('leafInsertAt(cur.', 1, 5), node('leafInsertAt')];
      case 'leaf-split': return [tree('sep := leafInsertSplit', 8, 2), node('leafInsertSplit')];
      case 'leaf-link': return [tree('leafSetNext(rightF.', 1, 3)];
      case 'propagate': return [tree('internalInsertKeyAt(parent.', 1, 5), node('internalInsertKeyAt')];
      case 'internal-split': return [tree('sep = internalInsertSplit', 1, 6), node('internalInsertSplit')];
      case 'root-grow': return [tree('internalInitRoot(nrf.', 1, 5), node('internalInitRoot')];
      case 'leaf-remove': return [tree('var removedValue', 1, 8), node('leafRemoveAt')];
      case 'underflow': return [tree('>= MinLeafPairs', 0, 12)];
      case 'borrow-right': return [tree('if int(nodeCount(sib.data[:])) > minKeys', 0, 15)];
      case 'borrow-left': return [tree('// Borrow one entry from the left sibling.', 0, 15)];
      case 'merge-right': return [tree('// Merge right into cur.', 0, 22)];
      case 'merge-left': return [tree('// Merge cur into the left sibling.', 0, 22)];
      case 'root-shrink': return [tree('newRoot := internalChild', 1, 10), section('freelist.go', 'freePageLocked', null, 0, 12)];
      case 'trylock-fail': return [tree('} else if !sib.latch.TryLock()', 2, 14)];
      case 'restart': return [section('tree.go', 'retryOp', null, 0, 16)];
      case 'release': return [section('tree.go', op === 'get' ? 'get' : 'release', op === 'get' ? 'return v, found, nil' : null, op === 'get' ? 3 : 0, 5), ...(op === 'get' ? [] : [section('tree.go', 'writeMeta', null, 0, 14)])];
      default: throw new Error(`Unmapped teaching step ${step.tag}`);
    }
  }
  globalThis.sourceFor = sourceFor;
})();
