// 创建 Task —— 纯数据装饰器，inspect_ai 同款设计
// 对照 inspect_ai: src/inspect_ai/_eval/task/task.py:61
import type { Task } from './types.js';

export function defineTask(task: Task): Task {
  if (!task.name) throw new Error('Task.name 不能为空');
  if (!task.dataset) throw new Error('Task.dataset 不能为空');
  if (!task.solver) throw new Error('Task.solver 不能为空');
  if (!task.scorer) throw new Error('Task.scorer 不能为空');
  return task;
}
