const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ChronosEngine } = require('../src/engine');
const { createServer } = require('../src/server');

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
    // Simulate a git repository
    fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.chronosignore'), '*.secret\ntmp_folder/\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("hello");\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'api.secret'), 'SUPER_SECRET_KEY', 'utf8');
    fs.mkdirSync(path.join(dir, 'tmp_folder'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tmp_folder', 'cache.txt'), 'cached', 'utf8');

    const engine = new ChronosEngine(dir);
    engine.init();

    // Verify .git/info/exclude contains .chronos/
    const excludeContent = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(excludeContent.includes('.chronos/'), 'Should auto-add .chronos/ to .git/info/exclude');

    // Verify .chronosignore rules are respected
    const cp = engine.createCheckpoint({ label: 'Initial snap' });
    assert.ok(cp.tree['app.js'], 'Should track app.js');
    assert.equal(cp.tree['api.secret'], undefined, 'Should ignore *.secret');
    assert.equal(cp.tree['tmp_folder/cache.txt'], undefined, 'Should ignore tmp_folder/');
  } finally {
    cleanupWorkspace(dir);
  }
});

test('2. Content-Addressable Storage (CAS) Deduplication & Binary File Integrity', () => {
  const dir = makeTempWorkspace();
  try {
    const engine = new ChronosEngine(dir);
    engine.init();

    // Create a text file and a binary file (with null bytes 0x00)
    const rawBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe, 0x42]);
    fs.writeFileSync(path.join(dir, 'logo.png'), rawBinary);
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'Line 1\nLine 2\n', 'utf8');

    const cp1 = engine.createCheckpoint({ label: 'Snap 1' });
    assert.equal(cp1.tree['logo.png'].binary, true, 'Should detect binary buffer');
    assert.equal(cp1.tree['readme.txt'].binary, false, 'Should detect text buffer');

    // Create 3 more snapshots where logo.png is unchanged
    for (let i = 2; i <= 4; i++) {
      fs.writeFileSync(path.join(dir, 'readme.txt'), `Line 1\nLine 2 (v${i})\n`, 'utf8');
      engine.createCheckpoint({ label: `Snap ${i}` });
    }

    const stats = engine.getStorageStats();
    assert.equal(stats.checkpointCount, 4);
    // 1 logo.png blob + 4 versions of readme.txt = 5 unique blobs total
    assert.equal(stats.uniqueBlobs, 5);

    // Corrupt logo.png on disk, then rewind to cp1 and verify byte-for-byte restoration
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

    // Checkpoint #1: Working code (exit 0)
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

    // Checkpoint #2: Broken code (exit 1) + extra nested folder
    fs.writeFileSync(path.join(dir, 'math.js'), 'module.exports = (a, b) => a - b;\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'experimental', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'experimental', 'deep', 'temp.js'), '// temp', 'utf8');

    const cp2 = await engine.runCommandAndRecord('node test.js', { silent: true });
    assert.equal(cp2.exitCode, 1);
    assert.equal(cp2.status, 'fail');
    assert.ok(cp2.stderr.includes('Math broken!'));

    // Make uncommitted dirty edits in worktree before rewinding
    fs.writeFileSync(path.join(dir, 'math.js'), 'module.exports = (a, b) => a * b; // dirty edit\n', 'utf8');

    // Diff --last-green vs live worktree
    const diff = engine.compareWith('--last-green', 'WORKTREE');
    assert.equal(diff.baseCheckpoint.id, cp1.id);
    assert.equal(diff.summary.modifiedFiles, 1);
    assert.equal(diff.summary.addedFiles, 1);

    // Rewind to --last-green
    const rewindRes = engine.rewindTo('--last-green');
    assert.ok(rewindRes.safetySnapshot, 'Must create a pre-rewind safety backup for dirty worktree');
    assert.equal(rewindRes.targetCheckpoint.id, cp1.id);

    // Verify nested experimental folder was removed and cleaned up
    assert.equal(fs.existsSync(path.join(dir, 'experimental')), false, 'Empty nested directory should be cleaned up');

    // Verify math.js is back to working state
    const cpAfterRewind = await engine.runCommandAndRecord('node test.js', { silent: true });
    assert.equal(cpAfterRewind.exitCode, 0);

    // Verify we can even recover the dirty edit from the safety snapshot!
    engine.rewindTo(rewindRes.safetySnapshot.id);
    const recoveredContent = fs.readFileSync(path.join(dir, 'math.js'), 'utf8');
    assert.ok(recoveredContent.includes('dirty edit'), 'Should be able to restore pre-rewind safety snapshot');
  } finally {
    cleanupWorkspace(dir);
  }
});

test('4. Garbage Collection (gc) preserves --last-green & prunes unreferenced blobs', async () => {
  const dir = makeTempWorkspace();
  try {
    const engine = new ChronosEngine(dir);
    engine.init();

    // Checkpoint #1: PASS (our only green checkpoint!)
    fs.writeFileSync(path.join(dir, 'code.js'), 'v1-green\n', 'utf8');
    await engine.runCommandAndRecord('node -e "process.exit(0)"', { silent: true });

    // Checkpoints #2, #3, #4, #5: All FAIL
    for (let i = 2; i <= 5; i++) {
      fs.writeFileSync(path.join(dir, 'code.js'), `v${i}-broken\n`, 'utf8');
      await engine.runCommandAndRecord('node -e "process.exit(1)"', { silent: true });
    }

    // Run GC keeping only the last 2 checkpoints (plus --last-green automatically!)
    const gcRes = engine.gc(2);
    assert.equal(gcRes.removedCheckpoints, 2, 'Should remove #2 and #3 while keeping #1 (last-green), #4, #5');
    assert.equal(gcRes.removedBlobs, 2, 'Should prune blobs for v2 and v3');

    const lastGreen = engine.resolveCheckpoint('--last-green');
    assert.ok(lastGreen, 'Must preserve --last-green even during aggressive GC');
    assert.equal(lastGreen.seq, 1);
  } finally {
    cleanupWorkspace(dir);
  }
});

test('5. Web Dashboard HTTP Server API & Port Conflict Auto-Fallback', async () => {
  const dir = makeTempWorkspace();
  let srv1 = null;
  let srv2 = null;
  try {
    const engine = new ChronosEngine(dir);
    engine.init();
    fs.writeFileSync(path.join(dir, 'hello.js'), 'console.log("hi");\n', 'utf8');
    await engine.runCommandAndRecord('node hello.js', { silent: true });

    // Start first server on port 4510
    srv1 = await createServer(dir, 4510);
    // Start second server requesting same port 4510 -> should auto-fallback to 4511!
    srv2 = await createServer(dir, 4510);
    assert.notEqual(srv1.port, srv2.port, 'Should auto-increment port when port is busy');

    // Test /api/state
    const stateRes = await fetch(`${srv1.url}/api/state`);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.checkpoints.length, 1);
    assert.ok(stateJson.lastGreenId);

    // Test /api/snap
    const snapRes = await fetch(`${srv1.url}/api/snap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'API test snapshot' })
    });
    const snapJson = await snapRes.json();
    assert.equal(snapJson.checkpoint.seq, 2);
  } finally {
    if (srv1 && srv1.server) srv1.server.close();
    if (srv2 && srv2.server) srv2.server.close();
    cleanupWorkspace(dir);
  }
});
