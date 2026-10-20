const http = require('http');
const fs = require('fs');
const { ChronosEngine } = require('./engine');
const { stripAnsi } = require('./diff');

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

  // Watch .chronos directory for external CLI changes and push live updates via SSE
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
        const lastGreen = engine.resolveCheckpoint('--last-green');
        return sendJson(res, 200, {
          workspace: engine.workspaceRoot,
          stats,
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
          label: body.label || 'Manual UI Snapshot'
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
      res.end(getDashboardHtml());
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

function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CHRONOS-DEV v2.0 // Flight Recorder & Code Time Machine</title>
  <style>
    :root {
      --bg-0: #070b12;
      --bg-1: #0d1320;
      --bg-2: #141e30;
      --bg-3: #1c2942;
      --border: #243452;
      --text: #e2e8f0;
      --muted: #8b9bb4;
      --green: #10b981;
      --green-bg: rgba(16, 185, 129, 0.14);
      --red: #f43f5e;
      --red-bg: rgba(244, 63, 94, 0.14);
      --cyan: #06b6d4;
      --amber: #f59e0b;
      --purple: #a855f7;
      --font-mono: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
      --font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-0);
      color: var(--text);
      font-family: var(--font-sans);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      background: var(--bg-1);
      border-bottom: 1px solid var(--border);
      padding: 11px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      flex-wrap: wrap;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo {
      width: 36px; height: 36px; border-radius: 8px;
      background: linear-gradient(135deg, var(--cyan), var(--purple));
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; color: #fff;
      box-shadow: 0 0 18px rgba(6, 182, 212, 0.4);
    }
    .brand-title { font-weight: 800; font-size: 15.5px; display: flex; align-items: center; gap: 8px; }
    .brand-sub { font-size: 11.5px; color: var(--muted); font-family: var(--font-mono); }
    .stats-bar { display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); font-size: 11.5px; }
    .stat-pill {
      background: var(--bg-2); border: 1px solid var(--border);
      padding: 5px 10px; border-radius: 6px;
    }
    .stat-pill strong { color: var(--cyan); }
    .actions-bar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    button {
      cursor: pointer; font-family: var(--font-sans); font-weight: 600; font-size: 12px;
      padding: 7px 11px; border-radius: 6px; border: 1px solid var(--border);
      background: var(--bg-2); color: var(--text); transition: all 0.14s ease;
      display: inline-flex; align-items: center; gap: 5px;
    }
    button:hover { background: var(--bg-3); border-color: var(--cyan); }
    button.btn-green { background: rgba(16, 185, 129, 0.15); border-color: var(--green); color: #34d399; }
    button.btn-amber { background: rgba(245, 158, 11, 0.15); border-color: var(--amber); color: #fbbf24; }
    button.btn-cyan { background: rgba(6, 182, 212, 0.15); border-color: var(--cyan); color: #22d3ee; }
    button.btn-purple { background: rgba(168, 85, 247, 0.15); border-color: var(--purple); color: #c084fc; }
    button.btn-sm { padding: 4px 8px; font-size: 11px; font-family: var(--font-mono); }

    .runner-bar {
      background: #080d17; border-bottom: 1px solid var(--border);
      padding: 8px 20px; display: flex; align-items: center; gap: 10px;
    }
    .runner-prompt { font-family: var(--font-mono); color: var(--cyan); font-size: 13px; font-weight: bold; }
    .runner-input {
      flex: 1; background: var(--bg-1); border: 1px solid var(--border); color: var(--text);
      font-family: var(--font-mono); font-size: 12.5px; padding: 6px 12px; border-radius: 6px; outline: none;
    }
    .runner-input:focus { border-color: var(--cyan); }

    .workspace-grid { display: grid; grid-template-columns: 360px 1fr; flex: 1; overflow: hidden; }
    .timeline-pane { background: var(--bg-1); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
    .pane-header {
      padding: 10px 14px; font-size: 11.5px; text-transform: uppercase; letter-spacing: 1px;
      color: var(--muted); font-weight: 700; border-bottom: 1px solid var(--border);
      display: flex; justify-content: space-between; align-items: center;
    }
    .timeline-list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .cp-card {
      background: var(--bg-2); border: 1px solid var(--border); border-left: 4px solid var(--cyan);
      border-radius: 8px; padding: 10px 12px; cursor: pointer; transition: all 0.14s ease;
    }
    .cp-card:hover { background: var(--bg-3); }
    .cp-card.active { border-color: var(--cyan); box-shadow: 0 0 0 1px var(--cyan); background: var(--bg-3); }
    .cp-card.status-pass { border-left-color: var(--green); }
    .cp-card.status-fail { border-left-color: var(--red); }
    .cp-card.status-snap { border-left-color: var(--purple); }
    .cp-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; gap: 6px; }
    .cp-id { font-family: var(--font-mono); font-size: 12px; font-weight: 700; }
    .badge { font-family: var(--font-mono); font-size: 10.5px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
    .badge-pass { background: var(--green-bg); color: #34d399; border: 1px solid rgba(16,185,129,0.3); }
    .badge-fail { background: var(--red-bg); color: #fb7185; border: 1px solid rgba(244,63,94,0.3); }
    .badge-snap { background: rgba(168,85,247,0.15); color: #c084fc; border: 1px solid rgba(168,85,247,0.3); }
    .badge-tag { background: rgba(245,158,11,0.18); color: #fbbf24; border: 1px solid rgba(245,158,11,0.35); margin-left: 4px; }
    .cp-cmd { font-family: var(--font-mono); font-size: 12px; color: #cbd5e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 6px; }
    .cp-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); font-family: var(--font-mono); }
    .diff-stat-add { color: #34d399; }
    .diff-stat-del { color: #fb7185; }

    .detail-pane { display: flex; flex-direction: column; overflow: hidden; background: var(--bg-0); }
    .detail-header {
      padding: 12px 20px; background: var(--bg-1); border-bottom: 1px solid var(--border);
      display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .detail-title { font-family: var(--font-mono); font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .tab-bar {
      background: var(--bg-1); border-bottom: 1px solid var(--border); padding: 0 20px;
      display: flex; gap: 18px;
    }
    .tab-btn {
      background: transparent; border: none; border-bottom: 2px solid transparent;
      border-radius: 0; padding: 10px 4px; color: var(--muted); font-size: 12.5px;
    }
    .tab-btn:hover { background: transparent; color: var(--text); }
    .tab-btn.active { color: var(--cyan); border-bottom-color: var(--cyan); }

    .detail-body { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 16px; }
    .panel { background: var(--bg-1); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .panel-title {
      background: var(--bg-2); padding: 8px 14px; font-size: 12px; font-weight: 700;
      font-family: var(--font-mono); border-bottom: 1px solid var(--border);
      display: flex; justify-content: space-between; align-items: center;
    }
    .terminal-output {
      padding: 13px; font-family: var(--font-mono); font-size: 12px; line-height: 1.55;
      white-space: pre-wrap; background: #05080f; color: #d1d5db; max-height: 220px; overflow-y: auto;
    }
    .terminal-stderr { color: #fda4af; border-top: 1px dashed rgba(244,63,94,0.3); margin-top: 8px; padding-top: 8px; }
    .diff-file { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 14px; background: var(--bg-1); }
    .diff-file-header {
      background: var(--bg-2); padding: 8px 14px; font-family: var(--font-mono); font-size: 12px;
      font-weight: 700; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border);
    }
    .diff-table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: 12px; }
    .diff-table td { padding: 2px 10px; white-space: pre; vertical-align: top; }
    .diff-ln { width: 42px; text-align: right; color: #4b5563; user-select: none; border-right: 1px solid #1f2937; }
    .diff-row-add { background: rgba(16, 185, 129, 0.14); color: #a7f3d0; }
    .diff-row-del { background: rgba(244, 63, 94, 0.16); color: #fecdd3; }
    .diff-row-eq { color: #94a3b8; }
    .diff-hunk-sep { background: #111827; color: var(--cyan); font-family: var(--font-mono); font-size: 11px; padding: 4px 12px; }
    .toast {
      position: fixed; bottom: 20px; right: 20px; background: var(--bg-2); border: 1px solid var(--cyan);
      color: var(--text); padding: 12px 18px; border-radius: 8px; font-family: var(--font-mono);
      font-size: 12.5px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); display: none; z-index: 100;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo">⏱</div>
      <div>
        <div class="brand-title">
          CHRONOS-DEV v2.0
          <span class="badge badge-pass">🟢 LIVE SSE SYNC</span>
        </div>
        <div class="brand-sub" id="workspace-path">Loading workspace...</div>
      </div>
    </div>

    <div class="stats-bar">
      <div class="stat-pill">Checkpoints: <strong id="stat-cp">0</strong></div>
      <div class="stat-pill">Unique Blobs: <strong id="stat-blobs">0</strong></div>
      <div class="stat-pill">CAS Saved: <strong id="stat-saved">0%</strong></div>
    </div>

    <div class="actions-bar">
      <button class="btn-green" onclick="compareLastGreen()">⚡ Diff vs --last-green</button>
      <button class="btn-purple" onclick="runBisect()">🕵️‍♂️ Auto-Bisect Culprit</button>
      <button class="btn-cyan" onclick="copyReport()">📋 Copy Bug Report</button>
      <button class="btn-amber" onclick="rewindLastGreen()">⏪ Rewind --last-green</button>
      <button onclick="manualSnap()">📸 Snap</button>
    </div>
  </header>

  <div class="runner-bar">
    <span class="runner-prompt">ch r &gt;</span>
    <input
      type="text"
      id="cmd-input"
      class="runner-input"
      placeholder="Run any command & snapshot code (e.g. node test.js)"
      value="node test.js"
      onkeydown="if(event.key==='Enter') runCommand()"
    />
    <button class="btn-cyan" onclick="runCommand()">▶ Run &amp; Record</button>
  </div>

  <div class="workspace-grid">
    <aside class="timeline-pane">
      <div class="pane-header">
        <span>Flight Timeline</span>
        <span id="last-green-indicator" style="color: var(--green); font-family: var(--font-mono); font-size: 11px;"></span>
      </div>
      <div class="timeline-list" id="timeline-list"></div>
    </aside>

    <main class="detail-pane">
      <div class="detail-header">
        <div class="detail-title" id="detail-title">Select a checkpoint</div>
        <div id="detail-actions" style="display:flex; gap:8px;"></div>
      </div>
      <div class="tab-bar">
        <button class="tab-btn active" id="tab-diff" onclick="switchTab('diff')">🔍 Code Changes &amp; Terminal Log</button>
        <button class="tab-btn" id="tab-files" onclick="switchTab('files')">📂 Time-Capsule File Explorer</button>
      </div>
      <div class="detail-body" id="detail-body"></div>
    </main>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    let appState = null;
    let selectedCpId = null;
    let currentCpData = null;
    let activeTab = 'diff';

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 3800);
    }

    function escapeHtml(str = '') {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    // Subscribe to real-time SSE updates from CLI or Server
    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type && msg.type !== 'connected') {
        loadState(true);
      }
    };

    async function loadState(selectLatest = false) {
      const res = await fetch('/api/state');
      appState = await res.json();

      document.getElementById('workspace-path').textContent = appState.workspace;
      document.getElementById('stat-cp').textContent = appState.stats.checkpointCount;
      document.getElementById('stat-blobs').textContent = appState.stats.uniqueBlobs;
      document.getElementById('stat-saved').textContent =
        appState.stats.savedPercent + '% (' +
        Math.round(appState.stats.physicalCompressedBytes / 1024 * 10) / 10 + ' KB)';

      document.getElementById('last-green-indicator').textContent =
        appState.lastGreenId ? '🌟 ' + appState.lastGreenId : 'No green build yet';

      renderTimeline();

      if ((selectLatest || !selectedCpId) && appState.checkpoints.length > 0) {
        selectCheckpoint(appState.checkpoints[0].id);
      }
    }

    function renderTimeline() {
      const container = document.getElementById('timeline-list');
      container.innerHTML = appState.checkpoints.map(cp => {
        const badgeClass = cp.status === 'pass' ? 'badge-pass' : cp.status === 'fail' ? 'badge-fail' : 'badge-snap';
        const badgeText = cp.status === 'pass' ? '✅ PASS (0)' : cp.status === 'fail' ? '❌ FAIL (' + cp.exitCode + ')' : '📸 ' + cp.trigger.toUpperCase();
        const isLastGreen = cp.id === appState.lastGreenId;
        const timeStr = new Date(cp.timestamp).toLocaleTimeString();
        const d = cp.diffSummary || { addedLines: 0, removedLines: 0, totalChangedFiles: 0 };
        const tagsHtml = (cp.tags || []).map(t => '<span class="badge badge-tag">🏷 ' + escapeHtml(t) + '</span>').join('');

        return \`
          <div class="cp-card status-\${cp.status} \${cp.id === selectedCpId ? 'active' : ''}" onclick="selectCheckpoint('\${cp.id}')">
            <div class="cp-top">
              <span class="cp-id">#\${cp.seq} · \${cp.id} \${isLastGreen ? '🌟' : ''}\${tagsHtml}</span>
              <span class="badge \${badgeClass}">\${badgeText}</span>
            </div>
            <div class="cp-cmd">\${escapeHtml(cp.label || cp.command || 'Snapshot')}</div>
            <div class="cp-meta">
              <span>\${timeStr} (\${cp.durationMs}ms)</span>
              <span>
                \${d.totalChangedFiles}f
                <span class="diff-stat-add">+\${d.addedLines}</span> /
                <span class="diff-stat-del">-\${d.removedLines}</span>
              </span>
            </div>
          </div>
        \`;
      }).join('');
    }

    function switchTab(tab) {
      activeTab = tab;
      document.getElementById('tab-diff').classList.toggle('active', tab === 'diff');
      document.getElementById('tab-files').classList.toggle('active', tab === 'files');
      if (currentCpData) renderCurrentCheckpointView();
    }

    async function selectCheckpoint(id) {
      selectedCpId = id;
      renderTimeline();

      const res = await fetch('/api/checkpoint?id=' + encodeURIComponent(id));
      currentCpData = await res.json();
      renderCurrentCheckpointView();
    }

    function renderCurrentCheckpointView() {
      const cp = currentCpData.checkpoint;
      const badgeClass = cp.status === 'pass' ? 'badge-pass' : cp.status === 'fail' ? 'badge-fail' : 'badge-snap';
      const badgeText = cp.status === 'pass' ? '✅ EXIT 0 (PASS)' : cp.status === 'fail' ? '❌ EXIT ' + cp.exitCode + ' (FAIL)' : '📸 SNAPSHOT';
      const tagsHtml = (cp.tags || []).map(t => '<span class="badge badge-tag">🏷 ' + escapeHtml(t) + '</span>').join('');

      document.getElementById('detail-title').innerHTML = \`
        <span>\${cp.id}</span>
        <span class="badge \${badgeClass}">\${badgeText}</span>
        \${tagsHtml}
        <span style="color: var(--muted); font-size: 12.5px;">\${escapeHtml(cp.label)}</span>
      \`;

      document.getElementById('detail-actions').innerHTML = \`
        <button onclick="promptTag('\${cp.id}')">🏷 Tag Checkpoint</button>
        <button class="btn-amber" onclick="rewindTo('\${cp.id}')">⏪ Rewind All to #\${cp.seq}</button>
      \`;

      if (activeTab === 'files') {
        const filesHtml = Object.entries(currentCpData.fileContents).map(([relPath, content]) => \`
          <div class="diff-file">
            <div class="diff-file-header">
              <span>📄 \${escapeHtml(relPath)}</span>
              <button class="btn-sm btn-cyan" onclick="pickSingleFile('\${cp.id}', '\${escapeHtml(relPath)}')">⏪ Restore Only This File</button>
            </div>
            <pre class="terminal-output" style="max-height:300px;">\${escapeHtml(content)}</pre>
          </div>
        \`).join('');
        document.getElementById('detail-body').innerHTML = filesHtml;
        return;
      }

      const diffHtml = renderDiffFiles(currentCpData.diffVsPrev.files, cp.id);
      const envInfo = cp.env
        ? \`Node \${cp.env.nodeVersion} · \${cp.env.platform}\${cp.env.gitBranch ? ' · branch: ' + cp.env.gitBranch : ''}\`
        : '';

      document.getElementById('detail-body').innerHTML = \`
        <div class="panel">
          <div class="panel-title">
            <span>🖥 TERMINAL FLIGHT RECORD (\${cp.command ? escapeHtml(cp.command) : 'Snapshot'})</span>
            <span style="color: var(--muted)">\${envInfo} | \${cp.durationMs}ms | \${cp.fileCount} files</span>
          </div>
          <div class="terminal-output">
\${escapeHtml(cp.cleanStdout || '(no stdout output)')}
\${cp.cleanStderr ? '<div class="terminal-stderr">' + escapeHtml(cp.cleanStderr) + '</div>' : ''}
          </div>
        </div>

        <div>
          <div style="margin-bottom: 10px; font-family: var(--font-mono); font-size: 12.5px; color: var(--muted);">
            🔍 CODE CHANGES IN THIS CHECKPOINT (Click "Restore Only This File" for surgical checkout)
          </div>
          \${diffHtml}
        </div>
      \`;
    }

    function renderDiffFiles(files, sourceRef = '--last-green') {
      if (!files || files.length === 0) {
        return '<div class="panel" style="padding: 16px; color: var(--muted); font-family: var(--font-mono); font-size: 12.5px;">No file changes between these checkpoints.</div>';
      }

      return files.map(file => {
        const hunksHtml = file.hunks.map((hunk, hIdx) => {
          const rows = hunk.lines.map(line => {
            const rowClass = line.type === 'add' ? 'diff-row-add' : line.type === 'del' ? 'diff-row-del' : 'diff-row-eq';
            const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
            return \`
              <tr class="\${rowClass}">
                <td class="diff-ln">\${line.oldLine || ''}</td>
                <td class="diff-ln">\${line.newLine || ''}</td>
                <td>\${prefix} \${escapeHtml(line.text)}</td>
              </tr>
            \`;
          }).join('');
          return (hIdx > 0 ? '<tr><td colspan="3" class="diff-hunk-sep">...</td></tr>' : '') + rows;
        }).join('');

        return \`
          <div class="diff-file">
            <div class="diff-file-header">
              <span>📄 \${escapeHtml(file.path)} <span style="color: var(--muted); font-weight: normal;">(\${file.status})</span></span>
              <span style="display:flex; align-items:center; gap:10px;">
                <span>
                  <span class="diff-stat-add">+\${file.added}</span> /
                  <span class="diff-stat-del">-\${file.removed}</span>
                </span>
                <button class="btn-sm btn-cyan" onclick="pickSingleFile('\${sourceRef}', '\${escapeHtml(file.path)}')">⏪ Restore Only This File</button>
              </span>
            </div>
            <table class="diff-table">
              <tbody>\${hunksHtml}</tbody>
            </table>
          </div>
        \`;
      }).join('');
    }

    async function compareLastGreen() {
      const res = await fetch('/api/diff?base=--last-green&target=WORKTREE');
      const data = await res.json();
      if (data.error) return showToast('⚠️ ' + data.error);

      document.getElementById('detail-title').innerHTML = \`
        <span>⚡ DIFF: \${data.baseCheckpoint.id} (Last Green ✅) ➔ Current Working Tree</span>
      \`;
      document.getElementById('detail-actions').innerHTML = \`
        <button class="btn-amber" onclick="rewindLastGreen()">⏪ Restore All Files to Last Green</button>
      \`;

      const driftHtml = data.envDrift && data.envDrift.length > 0
        ? '<div class="panel" style="padding:12px; border-color:var(--amber); color:#fbbf24; font-family:var(--font-mono); font-size:12px;">⚠️ ENVIRONMENT DRIFT: ' + escapeHtml(data.envDrift.join(' | ')) + '</div>'
        : '';

      document.getElementById('detail-body').innerHTML = \`
        \${driftHtml}
        <div class="panel" style="padding: 14px; font-family: var(--font-mono); font-size: 12.5px;">
          Comparing last passing checkpoint <strong>\${data.baseCheckpoint.id}</strong> against live workspace files:
          <strong>\${data.summary.totalChangedFiles} files modified</strong>
          (<span class="diff-stat-add">+\${data.summary.addedLines} lines</span> /
           <span class="diff-stat-del">-\${data.summary.removedLines} lines</span>).
          Click <strong>"⏪ Restore Only This File"</strong> on any file below to surgically fix it from Last Green!
        </div>
        \${renderDiffFiles(data.files, data.baseCheckpoint.id)}
      \`;
      showToast('Showing exact code changes since last green build!');
    }

    async function runBisect() {
      const command = document.getElementById('cmd-input').value.trim() || 'node test.js';
      showToast('🕵️‍♂️ Running binary-search bisect across timeline with: ' + command + '...');
      const res = await fetch('/api/bisect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, goodRef: '1', badRef: 'latest' })
      });
      const data = await res.json();
      if (data.error) return showToast('⚠️ ' + data.error);

      const c = data.culpritCheckpoint;
      const stepsRows = data.steps.map((s, i) => \`
        <tr>
          <td style="padding:6px 10px;">Step \${i + 1}</td>
          <td style="padding:6px 10px;">#\${s.seq} (\${s.id})</td>
          <td style="padding:6px 10px;">\${s.passed ? '✅ PASS (0)' : '❌ FAIL (' + s.exitCode + ')'}</td>
          <td style="padding:6px 10px;">\${s.durationMs}ms</td>
        </tr>
      \`).join('');

      document.getElementById('detail-title').innerHTML = \`
        <span>🕵️‍♂️ BISECT CULPRIT FOUND: #\${c.seq} (\${c.id})</span>
      \`;
      document.getElementById('detail-body').innerHTML = \`
        <div class="panel" style="padding: 14px; font-family: var(--font-mono); font-size: 12.5px; border-color: var(--purple);">
          🎯 <strong>First Bad Checkpoint Identified in \${data.steps.length} binary-search steps:</strong>
          <span style="color:var(--cyan);">\${c.id}</span> — \${escapeHtml(c.label)}
          <table style="width:100%; margin-top:10px; border-collapse:collapse; font-size:12px;">
            <tbody>\${stepsRows}</tbody>
          </table>
        </div>
        \${data.culpritDiff ? renderDiffFiles(data.culpritDiff.files, String(c.seq - 1)) : ''}
      \`;
      showToast('🎯 Found first bad checkpoint: ' + c.id);
    }

    async function copyReport() {
      const id = selectedCpId || 'latest';
      const res = await fetch('/api/export?id=' + encodeURIComponent(id));
      const data = await res.json();
      if (data.markdown) {
        await navigator.clipboard.writeText(data.markdown);
        showToast('📋 Secret-redacted Markdown Bug Report copied to clipboard!');
      }
    }

    async function pickSingleFile(targetRef, filePath) {
      const res = await fetch('/api/pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: targetRef, files: [filePath] })
      });
      const data = await res.json();
      if (data.error) return showToast('⚠️ ' + data.error);
      showToast('✨ Surgically restored ' + filePath + ' from ' + data.targetCheckpoint.id);
      await loadState(true);
    }

    async function promptTag(targetId) {
      const tag = prompt('Enter a bookmark/tag name for ' + targetId + ' (e.g. stable-v1, before-refactor):');
      if (!tag) return;
      const res = await fetch('/api/tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: targetId, tag })
      });
      const data = await res.json();
      if (data.error) return showToast('⚠️ ' + data.error);
      showToast('🏷 Tagged ' + targetId + ' as "' + data.tag + '"');
      await loadState(false);
    }

    async function rewindTo(target) {
      const res = await fetch('/api/rewind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
      });
      const data = await res.json();
      if (data.error) return showToast('⚠️ ' + data.error);
      showToast('⏪ Rewound ' + data.restoredCount + ' files to ' + data.targetCheckpoint.id + '!');
      await loadState(true);
    }

    function rewindLastGreen() { rewindTo('--last-green'); }

    async function runCommand() {
      const input = document.getElementById('cmd-input');
      const command = input.value.trim();
      if (!command) return;
      showToast('▶ Running: ' + command + '...');
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
      const data = await res.json();
      await loadState(true);
      showToast('Recorded Checkpoint ' + data.checkpoint.id + ' (exit ' + data.checkpoint.exitCode + ')');
    }

    async function manualSnap() {
      const res = await fetch('/api/snap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Manual Dashboard Snapshot' })
      });
      const data = await res.json();
      await loadState(true);
      showToast('📸 Created snapshot ' + data.checkpoint.id);
    }

    loadState(true);
  </script>
</body>
</html>`;
}

module.exports = { createServer };
