import http from 'node:http';
import { Readable, pipeline } from 'node:stream';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function sendText(res, statusCode, message) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/health') {
    sendText(res, 200, 'ok');
    return;
  }

  if (requestUrl.pathname !== '/proxy') {
    sendText(res, 404, 'Use /proxy?url=http://camera-ip:81/stream');
    return;
  }

  const target = requestUrl.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    sendText(res, 400, 'Missing or invalid "url" query parameter.');
    return;
  }

  let upstream;
  try {
    upstream = await fetch(target, { method: 'GET', redirect: 'follow' });
  } catch (err) {
    sendText(res, 502, `Upstream fetch failed: ${err.message}`);
    return;
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  res.writeHead(upstream.status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  pipeline(Readable.fromWeb(upstream.body), res, (err) => {
    if (err) {
      console.error('[camera-proxy] stream pipeline error:', err.message);
      if (!res.writableEnded) {
        res.end();
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[camera-proxy] listening on http://${HOST}:${PORT}`);
  console.log('[camera-proxy] proxy endpoint: /proxy?url=http://camera-ip:81/stream');
});
