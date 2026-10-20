const http = require('http');
const fs = require('fs');
const path = require('path');
const { ChronosEngine } = require('./engine');
const { stripAnsi } = require('./diff');

const UI_HTML_PATH = path.join(__dirname, 'ui.html');

function createServer(workspaceRoot, port = 4321) {
  const engine = new ChronosEngine(workspaceRoot);
  engine.ensureInitialized();

  const sseClients = new Set();

  const broadcastUpdate = (eventType = 'update') => {
    const payload = `data: ${JSON.stringify({ type: eventType, time: Date.now() })}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  let watchTimer = null;
  let fsWatcher = null;
  try {
    fsWatcher = fs.watch(engine.chronosDir, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => broadcastUpdate('cli-sync'), 120);
    });
  } catch {
    // Ignore watcher errors
  }

  const sendJson = (res, status, data) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
  };

  const parseBody = (req) =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    try {
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        const index = engine.getIndex();
        const stats = engine.getStorageStats();
        const worktree = engine.getWorktreeStatus();
        const lastGreen = engine.resolveCheckpoint('--last-green');
        return sendJson(res, 200, {
          workspace: engine.workspaceRoot,
          stats,
          worktree,
          tags: index.tags || {},
          lastGreenId: lastGreen ? lastGreen.id : null,
          checkpoints: [...index.checkpoints].reverse()
        });
      }

      if (pathname === '/api/checkpoint' && req.method === 'GET') {
        const id = parsedUrl.searchParams.get('id') || 'latest';
        const cp = engine.resolveCheckpoint(id);
        if (!cp) return sendJson(res, 404, { error: 'Checkpoint not found' });

        let diffVsPrev = { files: [], summary: cp.diffSummary };
        if (cp.seq > 1) {
          const prevCp = engine.resolveCheckpoint(String(cp.seq - 1));
          if (prevCp) {
            diffVsPrev = engine.diffTrees(
              prevCp.tree,
              cp.tree,
              (_p, meta) => engine.readBlob(meta.hash, true),
              (_p, meta) => engine.readBlob(meta.hash, true)
            );
          }
        } else {
          diffVsPrev = engine.diffTrees(
            {},
            cp.tree,
            () => '',
            (_p, meta) => engine.readBlob(meta.hash, true)
          );
        }

        const fileContents = {};
        for (const [relPath, meta] of Object.entries(cp.tree)) {
          fileContents[relPath] = meta.binary
            ? `[Binary file: ${meta.size} bytes | SHA-256: ${meta.hash}]`
            : engine.readBlob(meta.hash, true);
        }

        return sendJson(res, 200, {
          checkpoint: {
            ...cp,
            cleanStdout: stripAnsi(cp.stdout || ''),
            cleanStderr: stripAnsi(cp.stderr || '')
          },
          diffVsPrev,
          fileContents
        });
      }

      if (pathname === '/api/diff' && req.method === 'GET') {
        const base = parsedUrl.searchParams.get('base') || '--last-green';
        const target = parsedUrl.searchParams.get('target') || 'WORKTREE';
        const diff = engine.compareWith(base, target);
        return sendJson(res, 200, diff);
      }

      if (pathname === '/api/file-history' && req.method === 'GET') {
        const filePath = parsedUrl.searchParams.get('path') || '';
        const history = engine.getFileHistory(filePath);
        return sendJson(res, 200, history);
      }

      if (pathname === '/api/doctor' && req.method === 'GET') {
        const doc = engine.doctor();
        return sendJson(res, 200, doc);
      }

      if (pathname === '/api/export' && req.method === 'GET') {
        const id = parsedUrl.searchParams.get('id') || 'latest';
        const markdown = engine.exportReport(id, { redact: true });
        return sendJson(res, 200, { markdown });
      }

      if (pathname === '/api/run' && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.command) return sendJson(res, 400, { error: 'Missing command' });
        const cp = await engine.runCommandAndRecord(body.command, { silent: true });
        broadcastUpdate('run');
        return sendJson(res, 200, { checkpoint: cp });
      }

      if (pathname === '/api/snap' && req.method === 'POST') {
        const body = await parseBody(req);
        const cp = engine.createCheckpoint({
          trigger: 'manual',
          label: body.label || 'Manual Studio Snapshot'
        });
        broadcastUpdate('snap');
        return sendJson(res, 200, { checkpoint: cp });
      }

      if (pathname === '/api/tag' && req.method === 'POST') {
        const body = await parseBody(req);
        const resTag = engine.tagCheckpoint(body.target || 'latest', body.tag);
        broadcastUpdate('tag');
        return sendJson(res, 200, resTag);
      }

      if (pathname === '/api/rewind' && req.method === 'POST') {
        const body = await parseBody(req);
        const target = body.target || '--last-green';
        const result = engine.rewindTo(target);
        broadcastUpdate('rewind');
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/pick' && req.method === 'POST') {
        const body = await parseBody(req);
        const result = engine.checkoutFiles(body.target || '--last-green', body.files || []);
        broadcastUpdate('pick');
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/bisect' && req.method === 'POST') {
        const body = await parseBody(req);
        const cmd = body.command || 'node test.js';
        const result = await engine.bisect(cmd, body.goodRef || '1', body.badRef || 'latest');
        return sendJson(res, 200, result);
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(UI_HTML_PATH, 'utf8'));
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  server.on('close', () => {
    if (fsWatcher) fsWatcher.close();
    for (const client of sseClients) client.end();
  });

  return new Promise((resolve, reject) => {
    let currentPort = port;
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && currentPort < port + 15) {
          currentPort++;
          tryListen();
        } else {
          reject(err);
        }
      });
      server.listen(currentPort, '127.0.0.1', () => {
        resolve({ server, port: currentPort, url: `http://localhost:${currentPort}` });
      });
    };
    tryListen();
  });
}

module.exports = { createServer };
