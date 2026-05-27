// dbStateDelta —— ch11：跑完 agent 后 DB 状态的变化是否符合预期
// 由调用方在 sample.metadata.before 提供"跑前 DB 快照"
// 跑完后 state.metadata.after 由 solver 设入；scorer 比对 expected delta
//
// 用法（在 solver 里）：
//   state.metadata.before = await dbSnapshot();
//   // ... agent run ...
//   state.metadata.after = await dbSnapshot();
//
// target.expectedDbDelta 描述期望的变化，比如：
//   { changes: [{ table: 'orders', id: 'o_77543', field: 'status', from: 'paid', to: 'refunded' }] }
import type { Scorer, NamedScorer, Score, Target } from '../types.js';
import { targetIsObject } from '../types.js';

export interface ExpectedDbChange {
  table: string;
  id: string;
  field: string;
  /** 期望的旧值（不指定则不检查 from） */
  from?: unknown;
  /** 期望的新值 */
  to: unknown;
}

interface DbDelta {
  changes: ExpectedDbChange[];
  /** 表示期望"什么都没变"（重要的兜底场景） */
  expectNoChange?: boolean;
}

interface Snapshot {
  [table: string]: { [id: string]: Record<string, unknown> };
}

function getSnapshot(metadata: Record<string, unknown>, key: 'before' | 'after'): Snapshot {
  const v = metadata[key];
  if (typeof v === 'object' && v !== null) return v as Snapshot;
  return {};
}

function getExpectedDelta(target: Target | undefined, field: string): DbDelta {
  if (!targetIsObject(target)) return { changes: [] };
  const v = (target as Record<string, unknown>)[field];
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as DbDelta;
  return { changes: [] };
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function flattenChanges(before: Snapshot, after: Snapshot): ExpectedDbChange[] {
  const out: ExpectedDbChange[] = [];
  const allTables = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const table of allTables) {
    const beforeRows = before[table] ?? {};
    const afterRows = after[table] ?? {};
    const allIds = new Set([...Object.keys(beforeRows), ...Object.keys(afterRows)]);
    for (const id of allIds) {
      const b = beforeRows[id] ?? {};
      const a = afterRows[id] ?? {};
      const fields = new Set([...Object.keys(b), ...Object.keys(a)]);
      for (const f of fields) {
        if (!deepEq(b[f], a[f])) {
          out.push({ table, id, field: f, from: b[f], to: a[f] });
        }
      }
    }
  }
  return out;
}

export function dbStateDelta(opts: { field?: string } = {}): Scorer {
  const field = opts.field ?? 'expectedDbDelta';

  const scorer: NamedScorer = async (state, target) => {
    const before = getSnapshot(state.metadata, 'before');
    const after = getSnapshot(state.metadata, 'after');
    const actualChanges = flattenChanges(before, after);
    const expected = getExpectedDelta(target, field);
    const reasons: string[] = [];

    if (expected.expectNoChange) {
      if (actualChanges.length > 0) {
        reasons.push(
          `期望 DB 无变化，实际 ${actualChanges.length} 处：${actualChanges
            .map((c) => `${c.table}.${c.id}.${c.field}`)
            .join(', ')}`,
        );
      }
    } else {
      // 期望的每条 change 都要在 actual 里找到
      for (const e of expected.changes) {
        const found = actualChanges.find(
          (a) =>
            a.table === e.table &&
            a.id === e.id &&
            a.field === e.field &&
            deepEq(a.to, e.to) &&
            (e.from === undefined || deepEq(a.from, e.from)),
        );
        if (!found) {
          reasons.push(`未找到期望变化：${e.table}.${e.id}.${e.field} → ${JSON.stringify(e.to)}`);
        }
      }
    }

    const score: Score = {
      value: reasons.length === 0 ? 'C' : 'I',
      scorer: 'db_state_delta',
    };
    if (reasons.length > 0) score.explanation = reasons.join('; ');
    score.metadata = { actualChangesCount: actualChanges.length };
    return score;
  };
  scorer.scorerName = 'db_state_delta';
  return scorer;
}
