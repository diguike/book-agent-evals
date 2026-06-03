#!/usr/bin/env node
// 仓库环境检查脚本 —— 读者克隆后第一件事跑 `npm run doctor`
// 配套书章节：见 CLAUDE.md 第 6 条"所有代码必须仓库内可跑"
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
}

const checks: Check[] = [];

// 1. Node 版本
function checkNode(): Check {
  const versionStr = process.versions.node;
  const major = Number(versionStr.split('.')[0]);
  return {
    name: 'Node 版本 ≥ 22',
    ok: major >= 22,
    detail: `当前 v${versionStr}`,
    fix: '安装 Node 22 或更高版本（shopagent 依赖 node:sqlite，22.5+ 起支持）：https://nodejs.org/ 直接装最新 LTS；或用 nvm：`nvm install 22 && nvm use 22 && nvm alias default 22`（最后一步把 22 设为默认，避免每次 npm 钩子触发 nvm 时回退到 "default -> N/A"）',
  };
}

// 2. 仓库根 package.json + workspaces
function checkRootPackageJson(): Check {
  const path = resolve(repoRoot, 'package.json');
  if (!existsSync(path)) {
    return {
      name: 'workspaces 根 package.json',
      ok: false,
      detail: '未找到 package.json',
      fix: '在仓库根目录创建 package.json 并启用 npm workspaces',
    };
  }
  const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { workspaces?: string[] };
  const hasWorkspaces = Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0;
  return {
    name: 'workspaces 根 package.json',
    ok: hasWorkspaces,
    detail: hasWorkspaces ? `${pkg.workspaces!.length} 个 workspace 模式已配置` : '缺少 workspaces 字段',
    fix: '在根 package.json 加 "workspaces": ["examples/*"]',
  };
}

// 3. evalkit 包能被识别
function checkEvalKitWorkspace(): Check {
  const path = resolve(repoRoot, 'examples/evalkit/package.json');
  if (!existsSync(path)) {
    return {
      name: '@inferloop/evalkit 包',
      ok: false,
      detail: 'examples/evalkit/package.json 不存在',
      fix: '检查仓库是否完整 clone',
    };
  }
  const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { name?: string };
  const ok = pkg.name === '@inferloop/evalkit';
  return {
    name: '@inferloop/evalkit 包',
    ok,
    detail: ok ? '已识别' : `name 字段是 ${pkg.name}，应该是 @inferloop/evalkit`,
    fix: '检查 examples/evalkit/package.json',
  };
}

// 4. shopagent 包能被识别
function checkShopAgentWorkspace(): Check {
  const path = resolve(repoRoot, 'examples/shopagent/package.json');
  if (!existsSync(path)) {
    return {
      name: '@inferloop/shopagent 包',
      ok: false,
      detail: 'examples/shopagent/package.json 不存在',
      fix: '检查仓库是否完整 clone',
    };
  }
  const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { name?: string };
  const ok = pkg.name === '@inferloop/shopagent';
  return {
    name: '@inferloop/shopagent 包',
    ok,
    detail: ok ? '已识别' : `name 字段是 ${pkg.name}，应该是 @inferloop/shopagent`,
    fix: '检查 examples/shopagent/package.json',
  };
}

// 5. .env 是否已配置（OPENAI_API_KEY）
function checkEnvFile(): Check {
  const envPath = resolve(repoRoot, '.env');
  const examplePath = resolve(repoRoot, '.env.example');
  if (!existsSync(envPath)) {
    return {
      name: '.env 文件',
      ok: false,
      detail: '.env 不存在',
      fix: `cp ${examplePath} ${envPath} 并填入 OPENAI_API_KEY`,
    };
  }
  const content = readFileSync(envPath, 'utf-8');
  const m = content.match(/^OPENAI_API_KEY\s*=\s*(.+)$/m);
  const key = m?.[1]?.trim() ?? '';
  if (!key) {
    return {
      name: '.env 文件',
      ok: false,
      detail: 'OPENAI_API_KEY 未填写',
      fix: '编辑 .env 填入 OpenAI API key',
    };
  }
  if (key.length < 20) {
    return {
      name: '.env 文件',
      ok: false,
      detail: 'OPENAI_API_KEY 看起来不像有效 key',
      fix: '检查 .env 里的 OPENAI_API_KEY',
    };
  }
  return {
    name: '.env 文件',
    ok: true,
    detail: `OPENAI_API_KEY 已配置（${key.slice(0, 7)}…）`,
  };
}

// 6. node_modules 是否已装
function checkNodeModules(): Check {
  const path = resolve(repoRoot, 'node_modules');
  return {
    name: '依赖已安装',
    ok: existsSync(path),
    detail: existsSync(path) ? 'node_modules 存在' : 'node_modules 不存在',
    fix: '在仓库根目录跑 npm install',
  };
}

// 7. ShopAgent DB 是否已 seed —— 评测必需，否则 get_order / search_faq 都没数据
function checkShopAgentDb(): Check {
  const dbPath = resolve(repoRoot, 'examples/shopagent/data/shopagent.db');
  const exists = existsSync(dbPath);
  return {
    name: 'ShopAgent DB 已 seed',
    ok: exists,
    detail: exists ? 'examples/shopagent/data/shopagent.db 存在（5000 订单 / 500 用户 / 200 SKU / 100 FAQ）' : 'data/shopagent.db 不存在',
    fix: 'cd examples/shopagent && npm run seed',
  };
}

// 8. workspace 包已 build —— evalkit / shopagent 是 TS 包，main 指向 dist/index.js，没 build 则 import 报 ERR_MODULE_NOT_FOUND
function checkWorkspaceBuild(): Check {
  const evalkitDist = resolve(repoRoot, 'examples/evalkit/dist/index.js');
  const shopagentDist = resolve(repoRoot, 'examples/shopagent/dist/index.js');
  const missing: string[] = [];
  if (!existsSync(evalkitDist)) missing.push('@inferloop/evalkit');
  if (!existsSync(shopagentDist)) missing.push('@inferloop/shopagent');
  const ok = missing.length === 0;
  return {
    name: 'workspace 包已 build',
    ok,
    detail: ok ? 'evalkit / shopagent 的 dist/ 都已生成' : `${missing.join(' / ')} 缺少 dist/，import 时会报 ERR_MODULE_NOT_FOUND`,
    fix: '在仓库根跑 `npm run build`（等价 `npm run build -ws --if-present`），首次拉仓库后必跑一次；之后改了 evalkit/shopagent 源码也要重跑',
  };
}

checks.push(checkNode());
checks.push(checkRootPackageJson());
checks.push(checkNodeModules());
checks.push(checkEvalKitWorkspace());
checks.push(checkShopAgentWorkspace());
checks.push(checkWorkspaceBuild());
checks.push(checkShopAgentDb());
checks.push(checkEnvFile());

// 输出报告
console.log('\n[doctor] book-agent-evals 环境检查\n');
let allOk = true;
for (const c of checks) {
  const mark = c.ok ? '✓' : '✗';
  console.log(`  ${mark} ${c.name}${c.detail ? `  —  ${c.detail}` : ''}`);
  if (!c.ok) {
    allOk = false;
    if (c.fix) {
      console.log(`      修复：${c.fix}`);
    }
  }
}

if (allOk) {
  console.log('\n[doctor] 全部通过，可以开始跑评测了。\n');
  process.exit(0);
} else {
  // Node 版本是一切其他检查的前置条件——版本不达标时，DB seed、依赖装载、tsx 启动等都会顺势报错。
  // 单独打一行 hint，免得读者按 DB seed 那条 ✗ 的修复指引去跑 npm run seed，结果撞到 node:sqlite 报错才回来排查根因。
  const nodeCheck = checks[0];
  if (!nodeCheck.ok) {
    console.log('\n[doctor] ⚠️  Node 版本未达标——请先升级 Node 22+ 再重跑 doctor。');
    console.log('         上面其他 ✗（DB seed / 依赖 / 包识别 等）大概率是 Node 版本不达标的级联效应，');
    console.log('         升级后多半一起消失，没消失的再单独修。');
  }
  console.log('\n[doctor] 有检查未通过，按上面的修复指引处理后重试。\n');
  process.exit(1);
}
