const http = require('http');
const path = require('path');
const { ChronosEngine } = require('./engine');

function createServer(workspaceRoot, port = 4321) {
  const engine = new ChronosEngine(workspaceRoot);

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
      if (pathname === '/api/state' && req.method === 'GET') {
        const index = engine.getIndex();
        const stats = engine.getStorageStats();
        const lastGreen = engine.resolveCheckpoint('--last-green');
        return sendJson(res, 200, {
          workspace: engine.workspaceRoot,
          stats,
          lastGreenId: lastGreen ? lastGreen.id : null,
          checkpoints: [...index.checkpoints].reverse()
        });
      }

      if (pathname === '/api/checkpoint' && req.method === 'GET') {
        const id = parsedUrl.searchParams.get('id') || 'latest';
        const cp = engine.resolveCheckpoint(id);
        if (!cp) return sendJson(res, 404, { error: 'Checkpoint not found' });

        // Compute diff vs previous checkpoint
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
            ? `[Binary file: ${meta.size} bytes]`
            : engine.readBlob(meta.hash, true);
        }

        return sendJson(res, 200, {
          checkpoint: cp,
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

      if (pathname === '/api/run' && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.command) return sendJson(res, 400, { error: 'Missing command' });
        const cp = await engine.runCommandAndRecord(body.command, { silent: true });
        return sendJson(res, 200, { checkpoint: cp });
      }

      if (pathname === '/api/snap' && req.method === 'POST') {
        const body = await parseBody(req);
        const cp = engine.createCheckpoint({
          trigger: 'manual',
          label: body.label || 'Manual UI Snapshot'
        });
        return sendJson(res, 200, { checkpoint: cp });
      }

      if (pathname === '/api/rewind' && req.method === 'POST') {
        const body = await parseBody(req);
        const target = body.target || '--last-green';
        const result = engine.rewindTo(target);
        return sendJson(res, 200, result);
      }

      // Serve Dashboard HTML
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHtml());
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
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
  <title>CHRONOS-DEV // Flight Recorder & Code Time Machine</title>
  <style>
    :root {
      --bg-0: #090d16;
      --bg-1: #0f1624;
      --bg-2: #162033;
      --bg-3: #1e2b45;
      --border: #263554;
      --text: #e2e8f0;
      --muted: #8b9bb4;
      --green: #10b981;
      --green-bg: rgba(16, 185, 129, 0.14);
      --red: #f43f5e;
      --red-bg: rgba(244, 63, 94, 0.14);
      --cyan: #06b6d4;
      --cyan-bg: rgba(6, 182, 212, 0.14);
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
    /* Header */
    header {
      background: var(--bg-1);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-logo {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--cyan), var(--purple));
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-family: var(--font-mono);
      font-size: 18px;
      color: #fff;
      box-shadow: 0 0 16px rgba(6, 182, 212, 0.35);
    }
    .brand-title {
      font-weight: 800;
      letter-spacing: 0.5px;
      font-size: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand-sub {
      font-size: 12px;
      color: var(--muted);
      font-family: var(--font-mono);
    }
    .stats-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .stat-pill {
      background: var(--bg-2);
      border: 1px solid var(--border);
      padding: 6px 10px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .stat-pill strong { color: var(--cyan); }
    .actions-bar {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    button {
      cursor: pointer;
      font-family: var(--font-sans);
      font-weight: 600;
      font-size: 12.5px;
      padding: 8px 13px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-2);
      color: var(--text);
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button:hover { background: var(--bg-3); border-color: var(--cyan); }
    button.btn-green {
      background: rgba(16, 185, 129, 0.15);
      border-color: var(--green);
      color: #34d399;
    }
    button.btn-green:hover { background: rgba(16, 185, 129, 0.28); }
    button.btn-amber {
      background: rgba(245, 158, 11, 0.15);
      border-color: var(--amber);
      color: #fbbf24;
    }
    button.btn-amber:hover { background: rgba(245, 158, 11, 0.28); }
    button.btn-cyan {
      background: rgba(6, 182, 212, 0.15);
      border-color: var(--cyan);
      color: #22d3ee;
    }
    /* Command Runner Bar */
    .runner-bar {
      background: #0b111d;
      border-bottom: 1px solid var(--border);
      padding: 8px 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .runner-prompt {
      font-family: var(--font-mono);
      color: var(--cyan);
      font-size: 13px;
      font-weight: bold;
    }
    .runner-input {
      flex: 1;
      background: var(--bg-1);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 13px;
      padding: 7px 12px;
      border-radius: 6px;
      outline: none;
    }
    .runner-input:focus { border-color: var(--cyan); }

    /* Layout */
    .workspace-grid {
      display: grid;
      grid-template-columns: 360px 1fr;
      flex: 1;
      overflow: hidden;
    }
    .timeline-pane {
      background: var(--bg-1);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .pane-header {
      padding: 12px 16px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--muted);
      font-weight: 700;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .timeline-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .cp-card {
      background: var(--bg-2);
      border: 1px solid var(--border);
      border-left: 4px solid var(--cyan);
      border-radius: 8px;
      padding: 11px 13px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .cp-card:hover { background: var(--bg-3); }
    .cp-card.active {
      border-color: var(--cyan);
      border-left-width: 4px;
      box-shadow: 0 0 0 1px var(--cyan);
      background: var(--bg-3);
    }
    .cp-card.status-pass { border-left-color: var(--green); }
    .cp-card.status-fail { border-left-color: var(--red); }
    .cp-card.status-snap { border-left-color: var(--purple); }
    .cp-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .cp-id {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      color: var(--text);
    }
    .badge {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 4px;
    }
    .badge-pass { background: var(--green-bg); color: #34d399; border: 1px solid rgba(16,185,129,0.3); }
    .badge-fail { background: var(--red-bg); color: #fb7185; border: 1px solid rgba(244,63,94,0.3); }
    .badge-snap { background: rgba(168,85,247,0.15); color: #c084fc; border: 1px solid rgba(168,85,247,0.3); }
    .cp-cmd {
      font-family: var(--font-mono);
      font-size: 12.5px;
      color: #cbd5e1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 7px;
    }
    .cp-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--muted);
      font-family: var(--font-mono);
    }
    .diff-stat-add { color: #34d399; }
    .diff-stat-del { color: #fb7185; }

    /* Main Detail Pane */
    .detail-pane {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg-0);
    }
    .detail-header {
      padding: 14px 20px;
      background: var(--bg-1);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .detail-title {
      font-family: var(--font-mono);
      font-size: 15px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .detail-body {
      flex: 1;
      overflow-y: auto;
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .panel {
      background: var(--bg-1);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    .panel-title {
      background: var(--bg-2);
      padding: 9px 14px;
      font-size: 12px;
      font-weight: 700;
      font-family: var(--font-mono);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .terminal-output {
      padding: 14px;
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.55;
      white-space: pre-wrap;
      background: #06090f;
      color: #d1d5db;
      max-height: 240px;
      overflow-y: auto;
    }
    .terminal-stderr {
      color: #fda4af;
      border-top: 1px dashed rgba(244,63,94,0.3);
      margin-top: 8px;
      padding-top: 8px;
    }
    /* Code Diff Table */
    .diff-file {
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 14px;
      background: var(--bg-1);
    }
    .diff-file-header {
      background: var(--bg-2);
      padding: 8px 14px;
      font-family: var(--font-mono);
      font-size: 12.5px;
      font-weight: 700;
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
    }
    .diff-table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-size: 12.5px;
    }
    .diff-table td {
      padding: 2px 10px;
      white-space: pre;
      vertical-align: top;
    }
    .diff-ln {
      width: 44px;
      text-align: right;
      color: #4b5563;
      user-select: none;
      border-right: 1px solid #1f2937;
    }
    .diff-row-add { background: rgba(16, 185, 129, 0.14); color: #a7f3d0; }
    .diff-row-del { background: rgba(244, 63, 94, 0.16); color: #fecdd3; }
    .diff-row-eq { color: #94a3b8; }
    .diff-hunk-sep {
      background: #111827;
      color: var(--cyan);
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 4px 12px;
      border-top: 1px solid #1f2937;
      border-bottom: 1px solid #1f2937;
    }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: var(--bg-2);
      border: 1px solid var(--cyan);
      color: var(--text);
      padding: 12px 18px;
      border-radius: 8px;
      font-family: var(--font-mono);
      font-size: 13px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      display: none;
      z-index: 100;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo">⏱</div>
      <div>
        <div class="brand-title">
          CHRONOS-DEV
          <span class="badge badge-pass">FLIGHT RECORDER ACTIVE</span>
        </div>
        <div class="brand-sub" id="workspace-path">Loading workspace...</div>
      </div>
    </div>

    <div class="stats-bar">
      <div class="stat-pill">Checkpoints: <strong id="stat-cp">0</strong></div>
      <div class="stat-pill">CAS Blobs: <strong id="stat-blobs">0</strong></div>
      <div class="stat-pill">Storage Saved: <strong id="stat-saved">0%</strong></div>
    </div>

    <div class="actions-bar">
      <button class="btn-green" onclick="compareLastGreen()">⚡ Diff vs --last-green</button>
      <button class="btn-amber" onclick="rewindLastGreen()">⏪ Rewind to --last-green</button>
      <button onclick="manualSnap()">📸 Manual Snap</button>
    </div>
  </header>

  <div class="runner-bar">
    <span class="runner-prompt">chronos exec &gt;</span>
    <input
      type="text"
      id="cmd-input"
      class="runner-input"
      placeholder="Run any command & record checkpoint (e.g. node test.js)"
      value="node test.js"
      onkeydown="if(event.key==='Enter') runCommand()"
    />
    <button class="btn-cyan" onclick="runCommand()">▶ Run &amp; Snapshot</button>
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
      <div class="detail-header" id="detail-header">
        <div class="detail-title" id="detail-title">Select a checkpoint</div>
        <div id="detail-actions"></div>
      </div>
      <div class="detail-body" id="detail-body"></div>
    </main>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    let appState = null;
    let selectedCpId = null;

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 3500);
    }

    function escapeHtml(str = '') {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

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
        appState.lastGreenId ? 'Last Green: ' + appState.lastGreenId : 'No green build yet';

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

        return \`
          <div class="cp-card status-\${cp.status} \${cp.id === selectedCpId ? 'active' : ''}" onclick="selectCheckpoint('\${cp.id}')">
            <div class="cp-top">
              <span class="cp-id">#\${cp.seq} · \${cp.id} \${isLastGreen ? '🌟' : ''}</span>
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

    async function selectCheckpoint(id) {
      selectedCpId = id;
      renderTimeline();

      const res = await fetch('/api/checkpoint?id=' + encodeURIComponent(id));
      const data = await res.json();
      const cp = data.checkpoint;

      const badgeClass = cp.status === 'pass' ? 'badge-pass' : cp.status === 'fail' ? 'badge-fail' : 'badge-snap';
      const badgeText = cp.status === 'pass' ? '✅ EXIT 0 (PASS)' : cp.status === 'fail' ? '❌ EXIT ' + cp.exitCode + ' (FAIL)' : '📸 SNAPSHOT';

      document.getElementById('detail-title').innerHTML = \`
        <span>\${cp.id}</span>
        <span class="badge \${badgeClass}">\${badgeText}</span>
        <span style="color: var(--muted); font-size: 13px;">\${escapeHtml(cp.label)}</span>
      \`;

      document.getElementById('detail-actions').innerHTML = \`
        <button class="btn-amber" onclick="rewindTo('\${cp.id}')">⏪ Rewind Workspace to #\${cp.seq}</button>
      \`;

      const diffHtml = renderDiffFiles(data.diffVsPrev.files);

      document.getElementById('detail-body').innerHTML = \`
        <div class="panel">
          <div class="panel-title">
            <span>🖥 TERMINAL FLIGHT RECORD (\${cp.command ? escapeHtml(cp.command) : 'No command executed'})</span>
            <span style="color: var(--muted)">Duration: \${cp.durationMs}ms | Files tracked: \${cp.fileCount}</span>
          </div>
          <div class="terminal-output">
\${escapeHtml(cp.stdout || '(no stdout output)')}
\${cp.stderr ? '<div class="terminal-stderr">' + escapeHtml(cp.stderr) + '</div>' : ''}
          </div>
        </div>

        <div>
          <div style="margin-bottom: 10px; font-family: var(--font-mono); font-size: 13px; color: var(--muted);">
            🔍 CODE CHANGES IN THIS CHECKPOINT (vs Previous Checkpoint)
          </div>
          \${diffHtml}
        </div>
      \`;
    }

    function renderDiffFiles(files) {
      if (!files || files.length === 0) {
        return '<div class="panel" style="padding: 18px; color: var(--muted); font-family: var(--font-mono); font-size: 13px;">No file changes between these checkpoints.</div>';
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
              <span>
                <span class="diff-stat-add">+\${file.added}</span> /
                <span class="diff-stat-del">-\${file.removed}</span>
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
      if (data.error) {
        showToast('⚠️ ' + data.error);
        return;
      }

      document.getElementById('detail-title').innerHTML = \`
        <span>⚡ DIFF: \${data.baseCheckpoint.id} (Last Green ✅) ➔ Current Working Tree</span>
      \`;
      document.getElementById('detail-actions').innerHTML = \`
        <button class="btn-amber" onclick="rewindLastGreen()">⏪ Restore Last Green State Now</button>
      \`;

      document.getElementById('detail-body').innerHTML = \`
        <div class="panel" style="padding: 14px; font-family: var(--font-mono); font-size: 13px;">
          Comparing last passing checkpoint <strong>\${data.baseCheckpoint.id}</strong> against live workspace files:
          <strong>\${data.summary.totalChangedFiles} files modified</strong>
          (<span class="diff-stat-add">+\${data.summary.addedLines} lines</span> /
           <span class="diff-stat-del">-\${data.summary.removedLines} lines</span>)
        </div>
        \${renderDiffFiles(data.files)}
      \`;
      showToast('Showing exact code changes since last green build!');
    }

    async function rewindTo(target) {
      const res = await fetch('/api/rewind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
      });
      const data = await res.json();
      if (data.error) {
        showToast('⚠️ ' + data.error);
        return;
      }
      showToast('⏪ Rewound ' + data.restoredCount + ' files to ' + data.targetCheckpoint.id + '!');
      await loadState(true);
    }

    function rewindLastGreen() {
      rewindTo('--last-green');
    }

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
