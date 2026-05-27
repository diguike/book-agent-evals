// schemaMatch —— ch12：工具调用的 args 是否符合 JSON Schema
// 实战中 LLM 经常生成 schema 不合法的 args（缺必填、类型错、多余字段）
// 这里给一个极简 JSON Schema 校验，只覆盖：type / required / properties / enum
import type { Scorer, NamedScorer, Score } from '../../types.js';
import type { ToolDef } from '../../solver/use_tools.js';

interface SchemaMatchOpts {
  /** state.metadata.tools 里有完整工具定义；scorer 用工具名找 schema */
  toolsField?: string;
  /** 'strict' 多余字段也报错；'lax'（默认）只检查 required + type */
  mode?: 'strict' | 'lax';
}

interface SimpleSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, SimpleSchema>;
  enum?: unknown[];
  items?: SimpleSchema;
}

function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function validate(value: unknown, schema: SimpleSchema, path: string, strict: boolean): string[] {
  const errs: string[] = [];
  if (schema.type) {
    const actual = jsType(value);
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    // JSON Schema 的 "integer" 在 JS 里也是 number
    const ok = expectedTypes.some((t) => (t === 'integer' ? actual === 'number' : t === actual));
    if (!ok) errs.push(`${path}: 期望 ${expectedTypes.join('|')}，实际 ${actual}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errs.push(`${path}: 值不在 enum 中`);
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (schema.required) {
      for (const r of schema.required) {
        if (!(r in obj)) errs.push(`${path}: 缺少 required 字段 ${r}`);
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in obj) {
          errs.push(...validate(obj[k], sub, `${path}.${k}`, strict));
        }
      }
      if (strict) {
        for (const k of Object.keys(obj)) {
          if (!(k in schema.properties)) errs.push(`${path}: 多余字段 ${k}`);
        }
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errs.push(...validate(item, schema.items!, `${path}[${i}]`, strict));
    });
  }
  return errs;
}

export function schemaMatch(opts: SchemaMatchOpts = {}): Scorer {
  const toolsField = opts.toolsField ?? 'tools';
  const strict = opts.mode === 'strict';

  const scorer: NamedScorer = async (state) => {
    const tools = (state.metadata[toolsField] as ToolDef[] | undefined) ?? [];
    const toolMap = new Map(tools.map((t) => [t.function.name, t.function.parameters as SimpleSchema]));
    const reasons: string[] = [];
    for (let i = 0; i < state.toolCalls.length; i++) {
      const tc = state.toolCalls[i]!;
      const schema = toolMap.get(tc.tool);
      if (!schema) {
        reasons.push(`第 ${i + 1} 次调用 ${tc.tool}：无 schema 可校验（工具未注册）`);
        continue;
      }
      const errs = validate(tc.args, schema, `${tc.tool}.args`, strict);
      if (errs.length > 0) {
        reasons.push(`第 ${i + 1} 次调用 ${tc.tool}：${errs.join('; ')}`);
      }
    }
    const score: Score = {
      value: reasons.length === 0 ? 'C' : 'I',
      scorer: 'schema_match',
    };
    if (reasons.length > 0) score.explanation = reasons.join(' | ');
    return score;
  };
  scorer.scorerName = 'schema_match';
  return scorer;
}
