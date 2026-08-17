// ═══════════════════════════════════════════════════════════════════════════
// tools/serve.mjs — 개발용 정적 서버
//
//   node tools/serve.mjs [port]      # 기본 8000
//
// python3 -m http.server 로도 앱은 돌아가지만, 그쪽은 Last-Modified 만 주기
// 때문에 브라우저가 ES module 을 휴리스틱 캐시로 잡아 소스를 고쳐도 이전
// 버전이 계속 뜬다. 여기서는 Cache-Control: no-store 를 붙여 매 요청마다
// 새로 읽게 한다. 배포용이 아니라 개발 중 반복 확인용이다.
// ═══════════════════════════════════════════════════════════════════════════

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.argv[2] || 8000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = normalize(join(ROOT, rel));

  // 루트 밖으로 나가는 경로는 거부한다.
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Cache-Control': 'no-store' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`serving ${ROOT} → http://localhost:${PORT}/  (no-store)`);
});
