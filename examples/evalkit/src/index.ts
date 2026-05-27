// @inferloop/evalkit —— 公开导出入口

export * from './types.js';
export { defineTask } from './task.js';

// dataset
export { jsonlDataset, csvDataset, rowToSample } from './dataset/index.js';

// solver
export {
  chain,
  systemMessage,
  promptTemplate,
  useTools,
  generate,
  defaultGenerate,
} from './solver/index.js';
export type { ToolDef } from './solver/index.js';
export { userSimulator } from './solver/user_simulator.js';
export type { UserSimulatorOpts } from './solver/user_simulator.js';
export { multiTurn } from './solver/multi_turn.js';

// scorer
export { match, includes, toolCallMatch } from './scorer/index.js';
export { trajectoryMatch } from './scorer/trajectory_match.js';
export { dbStateDelta } from './scorer/db_state_delta.js';
export type { ExpectedDbChange } from './scorer/db_state_delta.js';
export { sessionCompletion } from './scorer/session_completion.js';
export { roleAdherence } from './scorer/role_adherence.js';
export { turnEfficiency } from './scorer/turn_efficiency.js';
export { schemaMatch, latencyScorer, toolSchemaMatch, toolLatency } from './scorer/tool_use/index.js';
export {
  contextPrecision,
  contextRecall,
  faithfulness,
  answerRelevancy,
} from './scorer/rag/index.js';
export { modelGraded, pairwiseJudge } from './scorer/judge/index.js';

// eval
export { runTask } from './eval/runner.js';
export { createTaskState } from './eval/state.js';
export { multiTrialAnalysis, formatPassKTable } from './eval/multi_trial.js';
export type { MultiTrialReport } from './eval/multi_trial.js';

// log
export { JsonlRecorder, parseLog, listLogs } from './log/index.js';
export type {
  LogEntry,
  HeaderEntry,
  SampleEntry,
  FooterEntry,
  ParsedLog,
  LogFileInfo,
} from './log/index.js';

// provider
export {
  ProviderRouter,
  getDefaultRouter,
  setDefaultRouter,
  defaultProviders,
  OpenAIProvider,
  AnthropicProvider,
  deepseekProvider,
  qwenProvider,
  zhipuProvider,
  openaiProvider,
  withCache,
  withRetry,
  providerRegistry,
  getProviderByName,
  FileCache,
  retry,
  Semaphore,
  AdaptiveSemaphore,
  pmap,
} from './provider/index.js';
export type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  CacheOptions,
  RetryOptions,
  RouterOptions,
} from './provider/index.js';

// stats
export {
  cohensKappa,
  bradleyTerry,
  EloRating,
  judgy,
  passKForSample,
  passKDataset,
  passKCurve,
  passHatK,
  passKAcrossTasks,
  mcnemar,
} from './stats/index.js';
export type {
  KappaResult,
  BradleyTerryResult,
  JudgyResult,
  PassKDatasetInput,
  McNemarResult,
} from './stats/index.js';
