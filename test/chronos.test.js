const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ChronosEngine } = require('../src/engine');
const { createServer } = require('../src/server');
const { redactSecrets } = require('../src/diff');

function makeTempWorkspace(prefix = 'chronos-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupWorkspace(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('1. Init & Git Stealth Exclusion (.git/info/exclude) + .chronosignore', () => {
  const dir = makeTempWorkspace();
  try {
    fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.chronosignore'), '*.secret\ntmp_folder/\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("hello");\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'api.secret'), 'SUPER_SECRET_KEY', 'utf8');
    fs.mkdirSync(path.join(dir, 'tmp_folder'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tmp_folder', 'cache.txt'), 'cached', 'utf8');

    const engine = new ChronosEngine(dir);
    engine.init();

    const excludeContent = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(excludeContent.includes('.chronos/'), 'Should auto-add .chronos/ to .git/info/exclude');

    const cp = engine.createCheckpoint({ label: 'Initial snap' });
    assert.ok(cp.tree['app.js'], 'Should track app.js');
    assert.equal(cp.tree['api.secret'], undefined, 'Should ignore *.secret');
    assert.equal(cp.tree['tmp_folder/cache.txt'], undefined, 'Should ignore tmp_folder/');
  } finally {
    cleanupWorkspace(dir);
  }
});

test('2. Content-Addressable Storage (CAS) Deduplication, Stat Cache & Binary File Integrity', () => {
  const dir = makeTempWorkspace();
  try {
    const engine = new ChronosEngine(dir);
    engine.init();

    const rawBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe, 0x42]);
    fs.writeFileSync(path.join(dir, 'logo.png'), rawBinary);
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'Line 1\nLine 2\n', 'utf8');

    const cp1 = engine.createCheckpoint({ label: 'Snap 1' });
    assert.equal(cp1.tree['logo.png'].binary, true, 'Should detect binary buffer');
    assert.equal(cp1.tree['readme.txt'].binary, false, 'Should detect text buffer');

    for (let i = 2; i <= 4; i++) {
      fs.writeFileSync(path.join(dir, 'readme.txt'), `Line 1\nLine 2 (v${i})\n`, 'utf8');
      engine.createCheckpoint({ label: `Snap ${i}` });
    }

    const stats = engine.getStorageStats();
    assert.equal(stats.checkpointCount, 4);
    assert.equal(stats.uniqueBlobs, 5);

    fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x00, 0x01]));
    engine.rewindTo(cp1.id);

    const restoredBinary = fs.readFileSync(path.join(dir, 'logo.png'));
    assert.deepEqual(restoredBinary, rawBinary, 'Binary file must be restored byte-for-byte');
  } finally {
    cleanupWorkspace(dir);
  }
});

test('3. Execution Recording, --last-green Diffing, Safety Backup & Nested Directory Cleanup on Rewind', async () => {
  const dir = makeTempWorkspace();
  try {
    const engine = new ChronosEngine(dir);
    engine.init();

    fs.writeFileSync(path.join(dir, 'math.js'), 'module.exports = (a, b) => a + b;\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'test.js'),
      'const add = require("./math"); if (add(2, 3) !== 5) { console.error("Math broken!"); process.exit(1); } console.log("All good!");\n',
      'utf8'
    );

    const cp1 = await engine.runCommandAndRecord('node test.js', { silent: true });
    assert.equal(cp1.exitCode, 0);
    assert.equal(cp1.status, 'pass');
    assert.ok(cp1.stdout.includes('All good!'));

    fs.writeFileSync(path.join(dir, 'math.js'), 'module.exports = (a, b) => a - b;\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'experimental', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'experimental', 'deep', 'temp.js'), '// temp', 'utf8');

    const cp2 = await engine.runCommandAndRecord('node test.js', { silent: true });
    assert.equal(cp2.exitCode, 1);
    assert.equal(cp2.status, 'fail');
    assert.ok(cp2.stderr.includes('Math broken!'));

    fs.writeFileSync(path.join(dir, 'math.js'), 'module.exports = (a, b) => a * b; // dirty edit\n', 'utf8');

    const diff = engine.compareWith('--last-green', 'WORKTREE');
    assert.equal(diff.baseCheckpoint.id, cp1.id);
    assert.equal(diff.summary.modifiedFiles, 1);
    assert.equal(diff.summary.addedFiles, 1);

    const rewindRes = engine.rewindTo('--last-green');
    assert.ok(rewindRes.safetySnapshot, 'Must create a pre-rewind safety backup for dirty worktree');
    assert.equal(rewindRes.targetCheckpoint.id, cp1.id);
    assert.equal(fs.existsSync(path.join(dir, 'experimental')), false, 'Empty nested directory should be cleaned up');

    const cpAfterRewind = await engine.runCommandAndRecord('node test.js', { silent: true });
    assert.equal(cpAfterRewind.exitCode, 0);

    engine.rewindTo(rewindRes.safetySnapshot.id);
    const recoveredContent = fs.readFileSync(path.join(dir, 'math.js'), 'utf8');
    assert.ok(recoveredContent.includes('dirty edit'), 'Should be able to restore pre-rewind safety snapshot');
  } finally {
    cleanupWorkspace(dir);
  }
});

test('4. Garbage Collection (gc) preserves --last-green, tagged checkpoints & prunes unreferenced blobs', async () => {
  const dir = makeTempWorkspace();
  try {
    const engine = new ChronosEngine(dir);
    engine.init();

    fs.writeFileSync(path.join(dir, 'code.js'), 'v1-green\n', 'utf8');
    await engine.runCommandAndRecord('node -e "process.exit(0)"', { silent: true });

    for (let i = 2; i <= 5; i++) {
      fs.writeFileSync(path.join(dir, 'code.js'), `v${i}-broken\n`, 'utf8');
      await engine.runCommandAndRecord('node -e "process.exit(1)"', { silent: true });
    }

    // Tag checkpoint #2 so GC must preserve both #1 (last-green) and #2 (tagged)!
    engine.tagCheckpoint('2', 'important-milestone');

    const gcRes = engine.gc(2);
    assert.equal(gcRes.removedCheckpoints, 1, 'Should remove only #3 while keeping #1 (green), #2 (tagged), #4, #5');

    const taggedCp = engine.resolveCheckpoint('important-milestone');
    assert.ok(taggedCp, 'Must resolve and preserve tagged checkpoint across GC');
    assert.equal(taggedCp.seq, 2);
  } finally {
    cleanupWorkspace(dir);
  }
});

test('5. Surgical File Checkout (checkoutFiles / ch pick)', () => {
  const dir = makeTempWorkspace();
  try {
    const engine = new ChronosEngine(dir);
    engine.init();

    fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1; // good\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.js'), 'const b = 1; // good\n', 'utf8');
    const cp1 = engine.createCheckpoint({ label: 'Good state', exitCode: 0 });

    // Modify both a.js and b.js
    fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 999; // broken!\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.js'), 'const b = 2; // new feature we want to keep!\n', 'utf8');
    engine.createCheckpoint({ label: 'Mixed state', exitCode: 1 });

    // Surgically restore ONLY a.js from cp1 while keeping b.js untouched
    const pickRes = engine.checkoutFiles(cp1.id, ['a.js']);
    assert.deepEqual(pickRes.restoredFiles, ['a.js']);
    assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'const a = 1; // good\n');
    assert.equal(
      fs.readFileSync(path.join(dir, 'b.js'), 'utf8'),
      'const b = 2; // new feature we want to keep!\n'
    );
  } finally {
    cleanupWorkspace(dir);
  }
});

test('6. Automated Binary-Search Bug Detective (bisect)', async () => {
  const dir = makeTempWorkspace();
  try {
    const engine = new ChronosEngine(dir);
    engine.init();

    fs.writeFileSync(
      path.join(dir, 'check.js'),
      'const v = require("./val"); process.exit(v < 4 ? 0 : 1);\n',
      'utf8'
    );

    // Create 6 checkpoints: #1, #2, #3 pass (v = 1, 2, 3), #4, #5, #6 fail (v = 4, 5, 6)
    for (let v = 1; v <= 6; v++) {
      fs.writeFileSync(path.join(dir, 'val.js'), `module.exports = ${v};\n`, 'utf8');
      engine.createCheckpoint({ label: `Set val to ${v}` });
    }

    const res = await engine.bisect('node check.js', '1', '6');
    assert.equal(res.culpritCheckpoint.seq, 4, 'Must pinpoint checkpoint #4 as the exact first bad state');
    assert.ok(res.steps.length <= 3, 'Binary search across 6 items must take at most 3 steps');

    // Verify original workspace state (v = 6) was restored after bisect
    assert.equal(fs.readFileSync(path.join(dir, 'val.js'), 'utf8'), 'module.exports = 6;\n');
  } finally {
    cleanupWorkspace(dir);
  }
});

test('7. Secret Redactor, Environment Drift & Markdown Diagnostic Report Exporter', async () => {
  const dir = makeTempWorkspace();
  try {
    const engine = new ChronosEngine(dir);
    engine.init();

    fs.writeFileSync(path.join(dir, '.env'), 'DB_URL=postgres://admin:secret123@localhost:5432/db\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'service.js'), 'console.log("ok");\n', 'utf8');
    await engine.runCommandAndRecord('node service.js', { silent: true });

    // Modify .env to trigger environment drift, and output sensitive tokens in stderr
    fs.writeFileSync(path.join(dir, '.env'), 'DB_URL=postgres://admin:newpass999@localhost:5432/db\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'service.js'),
      'console.error("Failed connecting to postgres://admin:mySuperPassword@10.0.0.1:5432/prod with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"); process.exit(1);\n',
      'utf8'
    );
    await engine.runCommandAndRecord('node service.js', { silent: true });

    const report = engine.exportReport('latest', { redact: true });
    assert.ok(report.includes('<REDACTED_PASSWORD>'), 'Should redact DB password in report');
    assert.ok(report.includes('<REDACTED_JWT>'), 'Should redact JWT token in report');
    assert.ok(!report.includes('mySuperPassword'), 'Must not leak raw password');
    assert.ok(report.includes('Environment Drift'), 'Should flag .env configuration drift');
  } finally {
    cleanupWorkspace(dir);
  }
});

test('8. Web Dashboard HTTP Server v2.0 API & Port Conflict Auto-Fallback', async () => {
  const dir = makeTempWorkspace();
  let srv1 = null;
  let srv2 = null;
  try {
    const engine = new ChronosEngine(dir);
    engine.init();
    fs.writeFileSync(path.join(dir, 'hello.js'), 'console.log("hi");\n', 'utf8');
    await engine.runCommandAndRecord('node hello.js', { silent: true });

    srv1 = await createServer(dir, 4520);
    srv2 = await createServer(dir, 4520);
    assert.notEqual(srv1.port, srv2.port, 'Should auto-increment port when port is busy');

    const stateRes = await fetch(`${srv1.url}/api/state`);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.checkpoints.length, 1);

    const tagRes = await fetch(`${srv1.url}/api/tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: '1', tag: 'v1-release' })
    });
    const tagJson = await tagRes.json();
    assert.equal(tagJson.tag, 'v1-release');

    const exportRes = await fetch(`${srv1.url}/api/export?id=v1-release`);
    const exportJson = await exportRes.json();
    assert.ok(exportJson.markdown.includes('Chronos Flight Recorder Diagnostic Report'));
  } finally {
    if (srv1 && srv1.server) srv1.server.close();
    if (srv2 && srv2.server) srv2.server.close();
    cleanupWorkspace(dir);
  }
});
