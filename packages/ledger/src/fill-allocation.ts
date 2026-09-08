/**
 * Complete-evidence fill allocation.
 *
 * Gross base is frozen by the approved FIFO schedule. Quote cost and commissions are then
 * rounded together over the complete fill matrix with a deterministic lower-bounded integer
 * circulation. This is deliberately a final reducer: callers must not use its output until
 * terminal order and COMPLETE account-cut evidence exist.
 */

export const FILL_ALLOCATION_ALGORITHM = 'fifo-circulation-v1' as const;

export interface FillAsset {
  readonly code: string;
  readonly scaleVersion: string;
}

export interface AuthoritativeFill {
  readonly tradeId: string;
  readonly baseAtoms: bigint;
  readonly quoteAtoms: bigint;
  readonly commissionAsset: FillAsset;
  readonly commissionAtoms: bigint;
}

export interface ApprovedAllocation {
  readonly strategyId: string;
  readonly intentId: string;
  readonly requestedGrossBaseAtoms: bigint;
  readonly maxQuoteDebitAtoms: bigint;
  readonly maxBaseDebitAtoms: bigint;
  readonly maxBaseCommissionAtoms: bigint;
  readonly maxQuoteCommissionAtoms: bigint;
  readonly thirdAssetFeeCaps?: Readonly<Record<string, bigint>>;
}

export interface FillAllocationInput {
  readonly side: 'BUY' | 'SELL';
  readonly baseAsset: FillAsset;
  readonly quoteAsset: FillAsset;
  /** Already proven complete and sorted by the verified venue ordering key. */
  readonly fills: readonly AuthoritativeFill[];
  /** The immutable order approved before dispatch. */
  readonly fifo: readonly ApprovedAllocation[];
}

export interface FinalFillCell {
  readonly tradeId: string;
  readonly strategyId: string;
  readonly intentId: string;
  readonly grossBaseAtoms: bigint;
  readonly grossQuoteAtoms: bigint;
  readonly commissionAsset: FillAsset;
  readonly commissionAtoms: bigint;
}

export type FillAllocationResult =
  | {
      readonly ok: true;
      readonly algorithm: typeof FILL_ALLOCATION_ALGORITHM;
      readonly cells: readonly FinalFillCell[];
    }
  | {
      readonly ok: false;
      readonly reason: 'ALLOCATION_INFEASIBLE' | 'FEE_ASSET_UNSUPPORTED';
      readonly detail: string;
    };

interface Fraction {
  readonly n: bigint;
  readonly d: bigint;
}

interface ComponentRow {
  readonly id: string;
  readonly fillIndex: number;
  readonly kind: 'QUOTE_COST' | 'COMMISSION';
  readonly asset: FillAsset;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: bigint;
  readonly denominator: bigint;
  readonly grossByStrategy: readonly bigint[];
}

const keyOf = (asset: FillAsset): string => `${asset.code}:${asset.scaleVersion}`;

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`internal allocation error: missing ${label}`);
  return value;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function add(a: Fraction, b: Fraction): Fraction {
  const common = gcd(a.d, b.d);
  const d = (a.d / common) * b.d;
  const n = a.n * (b.d / common) + b.n * (a.d / common);
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}

const floor = (value: Fraction): bigint => value.n / value.d;
const ceil = (value: Fraction): bigint =>
  value.n % value.d === 0n ? value.n / value.d : value.n / value.d + 1n;

interface Edge {
  to: number;
  reverse: number;
  capacity: bigint;
  initial: bigint;
}

class Flow {
  readonly graph: Edge[][];

  constructor(nodes: number) {
    this.graph = Array.from({ length: nodes }, () => []);
  }

  edge(from: number, to: number, capacity: bigint): Edge {
    const forward: Edge = {
      to,
      reverse: this.graph[to]?.length ?? 0,
      capacity,
      initial: capacity,
    };
    const reverse: Edge = {
      to: from,
      reverse: this.graph[from]?.length ?? 0,
      capacity: 0n,
      initial: 0n,
    };
    this.graph[from]?.push(forward);
    this.graph[to]?.push(reverse);
    return forward;
  }

  max(source: number, sink: number): bigint {
    let total = 0n;
    for (;;) {
      const level = new Array<number>(this.graph.length).fill(-1);
      level[source] = 0;
      const queue = [source];
      for (let head = 0; head < queue.length; head += 1) {
        const node = queue[head];
        if (node === undefined) continue;
        for (const edge of this.graph[node] ?? []) {
          if (edge.capacity > 0n && (level[edge.to] ?? -1) < 0) {
            level[edge.to] = (level[node] ?? -1) + 1;
            queue.push(edge.to);
          }
        }
      }
      if ((level[sink] ?? -1) < 0) return total;
      const cursor = new Array<number>(this.graph.length).fill(0);
      const send = (node: number, available: bigint): bigint => {
        if (node === sink) return available;
        const edges = this.graph[node] ?? [];
        while ((cursor[node] ?? 0) < edges.length) {
          const edge = edges[cursor[node] ?? 0];
          if (
            edge !== undefined &&
            edge.capacity > 0n &&
            level[edge.to] === (level[node] ?? -1) + 1
          ) {
            const pushed = send(edge.to, available < edge.capacity ? available : edge.capacity);
            if (pushed > 0n) {
              edge.capacity -= pushed;
              const reverse = this.graph[edge.to]?.[edge.reverse];
              if (reverse !== undefined) reverse.capacity += pushed;
              return pushed;
            }
          }
          cursor[node] = (cursor[node] ?? 0) + 1;
        }
        return 0n;
      };
      for (;;) {
        const pushed = send(source, 1n << 120n);
        if (pushed === 0n) break;
        total += pushed;
      }
    }
  }
}

interface BoundEdge {
  readonly from: number;
  readonly to: number;
  readonly lower: bigint;
  readonly upper: bigint;
  readonly capture?: { row: number; strategy: number };
}

function solveGroup(
  rows: readonly ComponentRow[],
  strategies: readonly ApprovedAllocation[],
  groupAsset: FillAsset,
  side: 'BUY' | 'SELL',
  baseAsset: FillAsset,
  quoteAsset: FillAsset,
): bigint[][] | null {
  const rowCount = rows.length;
  const strategyCount = strategies.length;
  const componentKinds = [...new Set(rows.map((row) => row.kind))].sort();
  const source = 0;
  const rowStart = 1;
  const componentStart = rowStart + rowCount;
  const componentNode = (kindIndex: number, strategyIndex: number): number =>
    componentStart + kindIndex * strategyCount + strategyIndex;
  const strategyStart = componentStart + componentKinds.length * strategyCount;
  const sink = strategyStart + strategyCount;
  const nodeCount = sink + 1;
  const bounds: BoundEdge[] = [];
  const fixed = rows.map((row) =>
    row.grossByStrategy.map((gross) => (row.amount * gross) / row.denominator),
  );

  for (let r = 0; r < rowCount; r += 1) {
    const row = must(rows[r], `row ${String(r)}`);
    const floorSum = must(fixed[r], `fixed row ${String(r)}`).reduce(
      (sum, value) => sum + value,
      0n,
    );
    const residual = row.amount - floorSum;
    bounds.push({ from: source, to: rowStart + r, lower: residual, upper: residual });
    const kindIndex = componentKinds.indexOf(row.kind);
    for (let s = 0; s < strategyCount; s += 1) {
      const gross = row.grossByStrategy[s] ?? 0n;
      if (gross === 0n || (row.amount * gross) % row.denominator === 0n) continue;
      bounds.push({
        from: rowStart + r,
        to: componentNode(kindIndex, s),
        lower: 0n,
        upper: 1n,
        capture: { row: r, strategy: s },
      });
    }
  }

  for (let s = 0; s < strategyCount; s += 1) {
    const strategy = must(strategies[s], `strategy ${String(s)}`);
    let totalFraction: Fraction = { n: 0n, d: 1n };
    let totalFixed = 0n;
    for (let k = 0; k < componentKinds.length; k += 1) {
      const kind = must(componentKinds[k], `component ${String(k)}`);
      let componentFraction: Fraction = { n: 0n, d: 1n };
      let componentFixed = 0n;
      for (let r = 0; r < rowCount; r += 1) {
        const row = must(rows[r], `row ${String(r)}`);
        if (row.kind !== kind) continue;
        const gross = row.grossByStrategy[s] ?? 0n;
        componentFraction = add(componentFraction, {
          n: row.amount * gross,
          d: row.denominator,
        });
        componentFixed += fixed[r]?.[s] ?? 0n;
      }
      totalFraction = add(totalFraction, componentFraction);
      totalFixed += componentFixed;
      let upper = ceil(componentFraction) - componentFixed;
      const lower = floor(componentFraction) - componentFixed;
      if (kind === 'COMMISSION') {
        const assetKey = keyOf(groupAsset);
        let cap: bigint | undefined;
        // The concrete fee cap is selected by the asset below. Keep it separate from the
        // strategy's shared quote-debit cap so commission cannot consume the cost allowance.
        cap =
          assetKey === keyOf(baseAsset)
            ? strategy.maxBaseCommissionAtoms
            : assetKey === keyOf(quoteAsset)
              ? strategy.maxQuoteCommissionAtoms
              : strategy.thirdAssetFeeCaps?.[assetKey];
        if (side === 'BUY' && assetKey === keyOf(baseAsset)) {
          const acquired = rows
            .filter((row) => row.kind === 'COMMISSION')
            .reduce((sum, row) => sum + (row.grossByStrategy[s] ?? 0n), 0n);
          if (cap === undefined || acquired < cap) cap = acquired;
        }
        if (cap === undefined) return null;
        if (cap < componentFixed) return null;
        const capResidual = cap - componentFixed;
        if (capResidual < upper) upper = capResidual;
      }
      if (lower > upper) return null;
      bounds.push({
        from: componentNode(k, s),
        to: strategyStart + s,
        lower,
        upper,
      });
    }

    let upper = ceil(totalFraction) - totalFixed;
    const lower = floor(totalFraction) - totalFixed;
    const assetKey = keyOf(groupAsset);
    let cap: bigint | undefined;
    if (side === 'BUY' && assetKey === keyOf(quoteAsset)) cap = strategy.maxQuoteDebitAtoms;
    if (side === 'SELL' && assetKey === keyOf(baseAsset)) {
      cap = strategy.maxBaseDebitAtoms - strategy.requestedGrossBaseAtoms;
    }
    if (assetKey !== keyOf(baseAsset) && assetKey !== keyOf(quoteAsset)) {
      cap = strategy.thirdAssetFeeCaps?.[assetKey];
    }
    if (cap !== undefined) {
      if (cap < totalFixed) return null;
      const capResidual = cap - totalFixed;
      if (capResidual < upper) upper = capResidual;
    }
    if (lower > upper) return null;
    bounds.push({ from: strategyStart + s, to: sink, lower, upper });
  }

  // Standard lower-bound circulation reduction. The sink-to-source edge closes the exact
  // source/row and strategy/sink demands; insertion order pins the chosen feasible flow.
  const superSource = nodeCount;
  const superSink = nodeCount + 1;
  const flow = new Flow(nodeCount + 2);
  const demand = new Array<bigint>(nodeCount).fill(0n);
  const captured: { edge: Edge; lower: bigint; row: number; strategy: number }[] = [];
  for (const bound of bounds) {
    if (bound.lower < 0n || bound.upper < bound.lower) return null;
    const edge = flow.edge(bound.from, bound.to, bound.upper - bound.lower);
    demand[bound.from] = (demand[bound.from] ?? 0n) - bound.lower;
    demand[bound.to] = (demand[bound.to] ?? 0n) + bound.lower;
    if (bound.capture !== undefined) captured.push({ edge, lower: bound.lower, ...bound.capture });
  }
  flow.edge(sink, source, 1n << 120n);
  let required = 0n;
  for (let node = 0; node < nodeCount; node += 1) {
    const value = demand[node] ?? 0n;
    if (value > 0n) {
      flow.edge(superSource, node, value);
      required += value;
    } else if (value < 0n) {
      flow.edge(node, superSink, -value);
    }
  }
  if (flow.max(superSource, superSink) !== required) return null;
  const result = fixed.map((values) => [...values]);
  for (const item of captured) {
    const resultRow = must(result[item.row], `result row ${String(item.row)}`);
    resultRow[item.strategy] =
      (resultRow[item.strategy] ?? 0n) + item.lower + (item.edge.initial - item.edge.capacity);
  }
  return result;
}

export function allocateCompleteFills(input: FillAllocationInput): FillAllocationResult {
  if (input.fifo.length === 0) {
    return { ok: false, reason: 'ALLOCATION_INFEASIBLE', detail: 'FIFO schedule is empty' };
  }
  if (
    input.fills.some(
      (fill) =>
        fill.baseAtoms <= 0n ||
        fill.quoteAtoms < 0n ||
        fill.commissionAtoms < 0n ||
        fill.tradeId.length === 0,
    )
  ) {
    return { ok: false, reason: 'ALLOCATION_INFEASIBLE', detail: 'invalid source fill' };
  }
  if (
    input.fifo.some(
      (item) =>
        item.requestedGrossBaseAtoms <= 0n ||
        item.maxQuoteDebitAtoms < 0n ||
        item.maxBaseDebitAtoms < 0n ||
        item.maxBaseCommissionAtoms < 0n ||
        item.maxQuoteCommissionAtoms < 0n,
    )
  ) {
    return { ok: false, reason: 'ALLOCATION_INFEASIBLE', detail: 'invalid approval cap' };
  }

  const remaining = input.fifo.map((item) => item.requestedGrossBaseAtoms);
  const grossMatrix: bigint[][] = [];
  for (const fill of input.fills) {
    let unallocated = fill.baseAtoms;
    const row = input.fifo.map(() => 0n);
    for (let s = 0; s < input.fifo.length && unallocated > 0n; s += 1) {
      const capacity = remaining[s] ?? 0n;
      const amount = capacity < unallocated ? capacity : unallocated;
      row[s] = amount;
      remaining[s] = capacity - amount;
      unallocated -= amount;
    }
    if (unallocated !== 0n) {
      return {
        ok: false,
        reason: 'ALLOCATION_INFEASIBLE',
        detail: `fill ${fill.tradeId} exceeds approved gross base`,
      };
    }
    grossMatrix.push(row);
  }

  const rows: ComponentRow[] = [];
  for (let fillIndex = 0; fillIndex < input.fills.length; fillIndex += 1) {
    const fill = must(input.fills[fillIndex], `fill ${String(fillIndex)}`);
    rows.push({
      id: `${fill.tradeId}:quote`,
      fillIndex,
      kind: 'QUOTE_COST',
      asset: input.quoteAsset,
      direction: input.side === 'BUY' ? 'DEBIT' : 'CREDIT',
      amount: fill.quoteAtoms,
      denominator: fill.baseAtoms,
      grossByStrategy: must(grossMatrix[fillIndex], `gross row ${String(fillIndex)}`),
    });
    if (fill.commissionAtoms > 0n) {
      const feeKey = keyOf(fill.commissionAsset);
      if (
        feeKey !== keyOf(input.baseAsset) &&
        feeKey !== keyOf(input.quoteAsset) &&
        input.fifo.some(
          (item, strategyIndex) =>
            (grossMatrix[fillIndex]?.[strategyIndex] ?? 0n) > 0n &&
            item.thirdAssetFeeCaps?.[feeKey] === undefined,
        )
      ) {
        return {
          ok: false,
          reason: 'FEE_ASSET_UNSUPPORTED',
          detail: `no approved fee claim for ${feeKey}`,
        };
      }
      rows.push({
        id: `${fill.tradeId}:commission`,
        fillIndex,
        kind: 'COMMISSION',
        asset: fill.commissionAsset,
        direction: 'DEBIT',
        amount: fill.commissionAtoms,
        denominator: fill.baseAtoms,
        grossByStrategy: must(grossMatrix[fillIndex], `gross row ${String(fillIndex)}`),
      });
    }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));

  const rounded = new Map<ComponentRow, readonly bigint[]>();
  const groupKeys = [...new Set(rows.map((row) => `${keyOf(row.asset)}:${row.direction}`))].sort();
  for (const groupKey of groupKeys) {
    const group = rows.filter((row) => `${keyOf(row.asset)}:${row.direction}` === groupKey);
    const first = must(group[0], `group ${groupKey}`);
    const values = solveGroup(
      group,
      input.fifo,
      first.asset,
      input.side,
      input.baseAsset,
      input.quoteAsset,
    );
    if (values === null) {
      return {
        ok: false,
        reason: 'ALLOCATION_INFEASIBLE',
        detail: `integer circulation infeasible for ${groupKey}`,
      };
    }
    group.forEach((row, index) =>
      rounded.set(row, must(values[index], `rounded row ${String(index)}`)),
    );
  }

  const cells: FinalFillCell[] = [];
  for (let f = 0; f < input.fills.length; f += 1) {
    const fill = must(input.fills[f], `fill ${String(f)}`);
    const quoteRow = must(
      rows.find((row) => row.fillIndex === f && row.kind === 'QUOTE_COST'),
      `quote row ${String(f)}`,
    );
    const feeRow = rows.find((row) => row.fillIndex === f && row.kind === 'COMMISSION');
    for (let s = 0; s < input.fifo.length; s += 1) {
      const grossBaseAtoms = grossMatrix[f]?.[s] ?? 0n;
      if (grossBaseAtoms === 0n) continue;
      const approved = must(input.fifo[s], `approval ${String(s)}`);
      cells.push({
        tradeId: fill.tradeId,
        strategyId: approved.strategyId,
        intentId: approved.intentId,
        grossBaseAtoms,
        grossQuoteAtoms: rounded.get(quoteRow)?.[s] ?? 0n,
        commissionAsset: fill.commissionAsset,
        commissionAtoms: feeRow === undefined ? 0n : (rounded.get(feeRow)?.[s] ?? 0n),
      });
    }
  }
  return { ok: true, algorithm: FILL_ALLOCATION_ALGORITHM, cells };
}
