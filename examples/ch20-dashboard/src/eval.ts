// ch20 demo —— 最小可上线 dashboard：HTTP 服务读 runs/ 目录展示评测历史
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLogs, parseLog } from '@inferloop/evalkit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIRS = [
  resolve(__dirname, '../../ch04-dataset-seed/runs'),
  resolve(__dirname, '../../ch11-trajectory/runs'),
  resolve(__dirname, '../../ch17-dataset-v2/runs'),
];

function collectLogs(): ReturnType<typeof listLogs> {
  const out: ReturnType<typeof listLogs> = [];
  for (const dir of RUNS_DIRS) {
    try {
      out.push(...listLogs(dir));
    } catch {
      // skip dir 不存在
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

const port = parseInt(process.env.PORT ?? '3091', 10);

const server = createServer((req, res) => {
  if (!req.url || req.url === '/' || req.url === '/index.html') {
    const infos = collectLogs();
    const rows = infos
      .map(
        (i) =>
          `<tr><td>${i.mtime.toISOString().slice(0, 19).replace('T', ' ')}</td><td>${i.taskName}</td><td>${i.model}</td><td>${i.sampleCount}</td><td>${i.accuracy !== undefined ? i.accuracy.toFixed(3) : '-'}</td><td><a href="/log?path=${encodeURIComponent(i.path)}">view</a></td></tr>`,
      )
      .join('\n');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>EvalKit Dashboard</title>
<style>body{font-family:monospace;padding:24px}table{border-collapse:collapse}td,th{padding:6px 12px;border-bottom:1px solid #ddd;text-align:left}</style>
</head><body><h2>EvalKit 评测历史</h2><table><thead><tr><th>时间</th><th>task</th><th>model</th><th>n</th><th>acc</th><th>详情</th></tr></thead><tbody>${rows || '<tr><td colspan=6>暂无日志，先跑 ch04 / ch11 / ch17 demo</td></tr>'}</tbody></table></body></html>`);
    return;
  }
  if (req.url.startsWith('/log')) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.searchParams.get('path');
    if (!p) {
      res.statusCode = 400;
      res.end('missing path');
      return;
    }
    try {
      const log = parseLog(p);
      const rows = log.samples
        .map((s) => {
          const passed = s.scores.every((sc) => sc.value === 'C');
          const reason = s.scores.find((sc) => sc.explanation)?.explanation ?? '';
          return `<tr style="background:${passed ? '#efe' : '#fee'}"><td>${passed ? '✓' : '✗'}</td><td>${s.sampleId}</td><td>${s.timingMs}ms</td><td>${reason}</td></tr>`;
        })
        .join('\n');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><body style="font-family:monospace;padding:24px"><h3>${log.header.taskName} (${log.header.model})</h3><a href="/">← back</a><table>${rows}</table></body></html>`);
    } catch (err) {
      res.statusCode = 500;
      res.end((err as Error).message);
    }
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(port, () => {
  console.log(`[ch20] dashboard at http://localhost:${port}/`);
});
