// TaskState 工厂 —— 每条 sample 跑前都新建一个 state
// 对照 inspect_ai: src/inspect_ai/solver/_task_state.py
import type { Sample, TaskConfig, TaskState } from '../types.js';

export function createTaskState(sample: Sample, _config?: TaskConfig): TaskState {
  return {
    sample,
    messages: [],
    toolCalls: [],
    metadata: {},
    completed: false,
  };
}
