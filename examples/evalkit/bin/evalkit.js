#!/usr/bin/env node
// Thin shim：让 npm install 时这个文件永远存在 → npm 才会创建 node_modules/.bin/evalkit 软链。
// 运行时再 dynamic import 已经 build 出来的 dist/cli/index.js。
// 否则读者第一次跑 `npm install` 时 dist/ 还不存在，bin 链接会被 npm 跳过，后续 `evalkit view ...` 全部找不到命令。
import('../dist/cli/index.js').catch((err) => {
  if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(err.message))) {
    console.error('[evalkit] CLI 还没 build。请在仓库根目录跑：npm run build');
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
