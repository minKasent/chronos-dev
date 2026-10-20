const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const {
  isBinaryBuffer,
  stripAnsi,
  redactSecrets,
  computeLineDiff,
  buildContextualHunks
} = require('./diff');

const DEFAULT_IGNORES = new Set([
  '.chronos',
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.gradle',
  '.idea',
  '.vscode',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv'
]);

class ChronosEngine {
  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.chronosDir = path.join(this.workspaceRoot, '.chronos');
    this.objectsDir = path.join(this.chronosDir, 'objects');
    this.checkpointsDir = path.join(this.chronosDir, 'checkpoints');
    this.indexFile = path.join(this.chronosDir, 'index.json');
    this.statCacheFile = path.join(this.chronosDir, 'stat-cache.json');
  }

  init() {
    fs.mkdirSync(this.objectsDir, { recursive: true });
    fs.mkdirSync(this.checkpointsDir, { recursive: true });
    if (!fs.existsSync(this.indexFile)) {
      fs.writeFileSync(
        this.indexFile,
        JSON.stringify(
          {
            version: '2.0.0',
            createdAt: new Date().toISOString(),
            workspace: this.workspaceRoot,
            tags: {},
            checkpoints: []
          },
          null,
          2
        ),
        'utf8'
      );
    }

    // Automatically hide .chronos/ from Git via .git/info/exclude so we never dirty git status
    const gitExclude = path.join(this.workspaceRoot, '.git', 'info', 'exclude');
    if (fs.existsSync(path.dirname(gitExclude))) {
      try {
        const existing = fs.existsSync(gitExclude) ? fs.readFileSync(gitExclude, 'utf8') : '';
        if (!existing.includes('.chronos')) {
          const prefix = existing.endsWith('\n') || existing === '' ? '' : '\n';
          fs.writeFileSync(gitExclude, `${existing}${prefix}.chronos/\n`, 'utf8');
        }
      } catch {
        // Ignore permission errors on read-only .git folders
      }
    }

    return this.getIndex();
  }

  ensureInitialized() {
    if (!fs.existsSync(this.indexFile)) {
      this.init();
    }
  }

  getIndex() {
    this.ensureInitialized();
    const data = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    if (!data.tags) data.tags = {};
    return data;
  }

  saveIndex(indexData) {
    fs.writeFileSync(this.indexFile, JSON.stringify(indexData, null, 2), 'utf8');
  }

  loadStatCache() {
    try {
      if (fs.existsSync(this.statCacheFile)) {
        return JSON.parse(fs.readFileSync(this.statCacheFile, 'utf8'));
      }
    } catch {
      // Fallback to empty cache
    }
    return {};
  }

  saveStatCache(cache) {
    try {
      fs.writeFileSync(this.statCacheFile, JSON.stringify(cache), 'utf8');
    } catch {
      // Ignore cache write errors
    }
  }

  /**
   * Capture lightweight environment & Git context without spawning external processes
   */
  captureEnvironment() {
    let gitBranch = null;
    let gitCommit = null;
    try {
      const headFile = path.join(this.workspaceRoot, '.git', 'HEAD');
      if (fs.existsSync(headFile)) {
        const head = fs.readFileSync(headFile, 'utf8').trim();
        if (head.startsWith('ref: ')) {
          const refPath = head.slice(5);
          gitBranch = refPath.replace(/^refs\/heads\//, '');
          const commitFile = path.join(this.workspaceRoot, '.git', refPath);
          if (fs.existsSync(commitFile)) {
            gitCommit = fs.readFileSync(commitFile, 'utf8').trim().slice(0, 8);
          }
        } else {
          gitCommit = head.slice(0, 8);
        }
      }
    } catch {
      // Ignore git read errors
    }

    // Check .env keys fingerprint (only key names + hashed values so no secrets are stored in plain text)
    let envKeysHash = null;
    try {
      const dotenvPath = path.join(this.workspaceRoot, '.env');
      if (fs.existsSync(dotenvPath)) {
        const content = fs.readFileSync(dotenvPath, 'utf8');
        envKeysHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
      }
    } catch {
      // Ignore
    }

    return {
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      gitBranch,
      gitCommit,
      envKeysHash
    };
  }

  /**
   * Detect environment drift between two environment records
   */
  diffEnvironment(oldEnv = {}, newEnv = {}) {
    const drifts = [];
    if (oldEnv.nodeVersion && newEnv.nodeVersion && oldEnv.nodeVersion !== newEnv.nodeVersion) {
      drifts.push(`Node.js runtime changed: ${oldEnv.nodeVersion} ➔ ${newEnv.nodeVersion}`);
    }
    if (oldEnv.gitBranch !== newEnv.gitBranch && (oldEnv.gitBranch || newEnv.gitBranch)) {
      drifts.push(`Git branch changed: ${oldEnv.gitBranch || 'none'} ➔ ${newEnv.gitBranch || 'none'}`);
    }
    if (oldEnv.envKeysHash !== newEnv.envKeysHash && (oldEnv.envKeysHash || newEnv.envKeysHash)) {
      drifts.push(`.env configuration modified (${oldEnv.envKeysHash || 'none'} ➔ ${newEnv.envKeysHash || 'none'})`);
    }
    return drifts;
  }

  /**
   * Load custom ignore rules from .chronosignore (if present)
   */
  loadCustomIgnores() {
    const custom = new Set();
    const ignoreFile = path.join(this.workspaceRoot, '.chronosignore');
    if (fs.existsSync(ignoreFile)) {
      const lines = fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        custom.add(line.replace(/^\/+|\/+$/g, ''));
      }
    }
    return custom;
  }

  shouldIgnore(entryName, relPath, customIgnores) {
    if (DEFAULT_IGNORES.has(entryName)) return true;
    if (customIgnores.has(entryName) || customIgnores.has(relPath)) return true;
    for (const pattern of customIgnores) {
      if (pattern.startsWith('*.') && entryName.endsWith(pattern.slice(1))) {
        return true;
      }
    }
    return false;
  }

  blobExists(hash) {
    if (!hash) return false;
    const blobPath = path.join(this.objectsDir, hash.slice(0, 2), hash.slice(2));
    return fs.existsSync(blobPath);
  }

  /**
   * Store a file buffer in Content-Addressable Storage (SHA-256 + zlib deflate)
   */
  storeBlob(buffer) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const prefix = hash.slice(0, 2);
    const rest = hash.slice(2);
    const dir = path.join(this.objectsDir, prefix);
    const blobPath = path.join(dir, rest);

    if (!fs.existsSync(blobPath)) {
      fs.mkdirSync(dir, { recursive: true });
      const compressed = zlib.deflateSync(buffer);
      fs.writeFileSync(blobPath, compressed);
    }
    return hash;
  }

  /**
   * Read a blob by its SHA-256 hash
   */
  readBlob(hash, asText = true) {
    if (!hash) return asText ? '' : Buffer.alloc(0);
    const prefix = hash.slice(0, 2);
    const rest = hash.slice(2);
    const blobPath = path.join(this.objectsDir, prefix, rest);
    if (!fs.existsSync(blobPath)) {
      throw new Error(`CAS blob missing: ${hash}`);
    }
    const compressed = fs.readFileSync(blobPath);
    const buffer = zlib.inflateSync(compressed);
    return asText ? buffer.toString('utf8') : buffer;
  }

  /**
   * Scan the workspace using Incremental Stat Cache (mtimeMs + size) for blazing-fast snapshots
   */
  scanWorkspace(persistBlobs = true) {
    this.ensureInitialized();
    const rawTree = {};
    const customIgnores = this.loadCustomIgnores();
    const statCache = this.loadStatCache();
    const nextCache = {};

    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');

        if (this.shouldIgnore(entry.name, relPath, customIgnores)) continue;

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 10 * 1024 * 1024) continue;
            const mtimeMs = Math.round(stat.mtimeMs);
            const cached = statCache[relPath];

            // Fast path: if size and mtimeMs match and blob is already in CAS store, skip disk read!
            if (
              cached &&
              cached.size === stat.size &&
              cached.mtimeMs === mtimeMs &&
              cached.hash &&
              this.blobExists(cached.hash)
            ) {
              rawTree[relPath] = cached;
              nextCache[relPath] = cached;
              continue;
            }

            const buffer = fs.readFileSync(fullPath);
            const binary = isBinaryBuffer(buffer);
            const hash = persistBlobs
              ? this.storeBlob(buffer)
              : crypto.createHash('sha256').update(buffer).digest('hex');

            const meta = {
              hash,
              size: stat.size,
              binary,
              mtimeMs
            };
            rawTree[relPath] = meta;
            if (persistBlobs) nextCache[relPath] = meta;
          } catch {
            // Skip transient or locked OS files
          }
        }
      }
    };

    walk(this.workspaceRoot);

    if (persistBlobs) {
      this.saveStatCache(nextCache);
    }

    const sortedTree = {};
    for (const key of Object.keys(rawTree).sort()) {
      sortedTree[key] = rawTree[key];
    }
    return sortedTree;
  }

  /**
   * Compute deterministic SHA-256 hash of a tree (based solely on path + blob hash)
   */
  computeTreeHash(tree) {
    const canonical = Object.keys(tree)
      .sort()
      .map((p) => `${p}:${tree[p].hash}`)
      .join('\n');
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Compare two trees and compute summary + per-file line diffs
   */
  diffTrees(oldTree = {}, newTree = {}, getOldContent, getNewContent) {
    const allPaths = Array.from(
      new Set([...Object.keys(oldTree), ...Object.keys(newTree)])
    ).sort();

    const files = [];
    let totalAddedLines = 0;
    let totalRemovedLines = 0;
    let addedFiles = 0;
    let modifiedFiles = 0;
    let deletedFiles = 0;

    for (const relPath of allPaths) {
      const oldMeta = oldTree[relPath];
      const newMeta = newTree[relPath];

      if (!oldMeta && newMeta) {
        addedFiles++;
        if (newMeta.binary) {
          files.push({
            path: relPath,
            status: 'added',
            binary: true,
            oldHash: null,
            newHash: newMeta.hash,
            added: 0,
            removed: 0,
            hunks: [
              {
                lines: [
                  {
                    type: 'add',
                    oldLine: null,
                    newLine: 1,
                    text: `[Binary file added: ${newMeta.size} bytes]`
                  }
                ]
              }
            ]
          });
          continue;
        }
        const newText = getNewContent(relPath, newMeta);
        const lineDiff = computeLineDiff('', newText);
        totalAddedLines += lineDiff.added;
        files.push({
          path: relPath,
          status: 'added',
          oldHash: null,
          newHash: newMeta.hash,
          added: lineDiff.added,
          removed: 0,
          hunks: buildContextualHunks(lineDiff.ops, 3)
        });
      } else if (oldMeta && !newMeta) {
        deletedFiles++;
        if (oldMeta.binary) {
          files.push({
            path: relPath,
            status: 'deleted',
            binary: true,
            oldHash: oldMeta.hash,
            newHash: null,
            added: 0,
            removed: 0,
            hunks: [
              {
                lines: [
                  {
                    type: 'del',
                    oldLine: 1,
                    newLine: null,
                    text: `[Binary file deleted: ${oldMeta.size} bytes]`
                  }
                ]
              }
            ]
          });
          continue;
        }
        const oldText = getOldContent(relPath, oldMeta);
        const lineDiff = computeLineDiff(oldText, '');
        totalRemovedLines += lineDiff.removed;
        files.push({
          path: relPath,
          status: 'deleted',
          oldHash: oldMeta.hash,
          newHash: null,
          added: 0,
          removed: lineDiff.removed,
          hunks: buildContextualHunks(lineDiff.ops, 3)
        });
      } else if (oldMeta.hash !== newMeta.hash) {
        modifiedFiles++;
        if (oldMeta.binary || newMeta.binary) {
          files.push({
            path: relPath,
            status: 'modified',
            binary: true,
            oldHash: oldMeta.hash,
            newHash: newMeta.hash,
            added: 0,
            removed: 0,
            hunks: [
              {
                lines: [
                  {
                    type: 'del',
                    oldLine: 1,
                    newLine: null,
                    text: `[Binary file old: ${oldMeta.size} bytes (${oldMeta.hash.slice(0, 8)})]`
                  },
                  {
                    type: 'add',
                    oldLine: null,
                    newLine: 1,
                    text: `[Binary file new: ${newMeta.size} bytes (${newMeta.hash.slice(0, 8)})]`
                  }
                ]
              }
            ]
          });
          continue;
        }
        const oldText = getOldContent(relPath, oldMeta);
        const newText = getNewContent(relPath, newMeta);
        const lineDiff = computeLineDiff(oldText, newText);
        totalAddedLines += lineDiff.added;
        totalRemovedLines += lineDiff.removed;
        files.push({
          path: relPath,
          status: 'modified',
          oldHash: oldMeta.hash,
          newHash: newMeta.hash,
          added: lineDiff.added,
          removed: lineDiff.removed,
          hunks: buildContextualHunks(lineDiff.ops, 3)
        });
      }
    }

    return {
      summary: {
        addedFiles,
        modifiedFiles,
        deletedFiles,
        totalChangedFiles: addedFiles + modifiedFiles + deletedFiles,
        addedLines: totalAddedLines,
        removedLines: totalRemovedLines
      },
      files
    };
  }

  /**
   * Create a new Checkpoint (snapshot of files + optional command execution record)
   */
  createCheckpoint(options = {}) {
    this.ensureInitialized();
    const index = this.getIndex();
    const lastSeq =
      index.checkpoints.length > 0
        ? index.checkpoints[index.checkpoints.length - 1].seq
        : 0;
    const seq = lastSeq + 1;
    const tree = this.scanWorkspace(true);
    const env = this.captureEnvironment();

    const treeHash = this.computeTreeHash(tree);
    const shortHash = treeHash.slice(0, 6);
    const id = `cp-${String(seq).padStart(3, '0')}-${shortHash}`;

    const prevMeta = index.checkpoints[index.checkpoints.length - 1];
    let diffSummary = {
      addedFiles: Object.keys(tree).length,
      modifiedFiles: 0,
      deletedFiles: 0,
      totalChangedFiles: Object.keys(tree).length,
      addedLines: 0,
      removedLines: 0
    };

    if (prevMeta) {
      const prevCp = this.getCheckpoint(prevMeta.id);
      if (prevCp) {
        const diffResult = this.diffTrees(
          prevCp.tree,
          tree,
          (_p, meta) => this.readBlob(meta.hash, true),
          (_p, meta) => this.readBlob(meta.hash, true)
        );
        diffSummary = diffResult.summary;
      }
    } else {
      let initialLines = 0;
      for (const meta of Object.values(tree)) {
        if (meta.binary) continue;
        const content = this.readBlob(meta.hash, true);
        initialLines += content ? content.split('\n').length : 0;
      }
      diffSummary.addedLines = initialLines;
    }

    const timestamp = options.timestamp || new Date().toISOString();
    const status =
      options.exitCode === 0
        ? 'pass'
        : typeof options.exitCode === 'number'
        ? 'fail'
        : 'snap';

    const checkpointData = {
      id,
      seq,
      timestamp,
      trigger: options.trigger || 'manual',
      label: options.label || options.command || 'Manual snapshot',
      command: options.command || null,
      exitCode: typeof options.exitCode === 'number' ? options.exitCode : null,
      status,
      durationMs: options.durationMs || 0,
      stdout: options.stdout || '',
      stderr: options.stderr || '',
      env,
      tags: options.tags || [],
      treeHash,
      fileCount: Object.keys(tree).length,
      diffSummary,
      tree
    };

    const cpFile = path.join(this.checkpointsDir, `${id}.json`);
    fs.writeFileSync(cpFile, JSON.stringify(checkpointData, null, 2), 'utf8');

    const { tree: _omittedTree, stdout: _o1, stderr: _o2, ...indexEntry } = checkpointData;
    index.checkpoints.push(indexEntry);
    this.saveIndex(index);

    return checkpointData;
  }

  /**
   * Tag / Bookmark a checkpoint with a human-friendly name (e.g. 'v1-working', 'before-refactor')
   */
  tagCheckpoint(ref, tagName) {
    if (!tagName || typeof tagName !== 'string') {
      throw new Error('Tag name is required');
    }
    const cleanTag = tagName.trim();
    const cp = this.resolveCheckpoint(ref);
    if (!cp) {
      throw new Error(`Could not find checkpoint matching '${ref}'`);
    }

    const index = this.getIndex();
    index.tags[cleanTag] = cp.id;

    const idxEntry = index.checkpoints.find((c) => c.id === cp.id);
    if (idxEntry) {
      idxEntry.tags = Array.from(new Set([...(idxEntry.tags || []), cleanTag]));
    }
    this.saveIndex(index);

    cp.tags = Array.from(new Set([...(cp.tags || []), cleanTag]));
    const cpFile = path.join(this.checkpointsDir, `${cp.id}.json`);
    fs.writeFileSync(cpFile, JSON.stringify(cp, null, 2), 'utf8');

    return { tag: cleanTag, checkpoint: cp };
  }

  /**
   * Resolve a checkpoint reference ('--last-green', 'latest', tag name, seq number, or ID prefix)
   */
  resolveCheckpoint(ref) {
    const index = this.getIndex();
    const list = index.checkpoints;
    if (list.length === 0) return null;

    if (!ref || ref === 'latest' || ref === 'HEAD') {
      return this.getCheckpoint(list[list.length - 1].id);
    }

    if (ref === '--last-green' || ref === 'last-green' || ref === 'green') {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].status === 'pass' || list[i].exitCode === 0) {
          return this.getCheckpoint(list[i].id);
        }
      }
      return null;
    }

    // Check named tags first
    if (index.tags && index.tags[ref]) {
      return this.getCheckpoint(index.tags[ref]);
    }

    const numeric = Number(String(ref).replace(/^#/, ''));
    if (!Number.isNaN(numeric) && numeric > 0) {
      const found = list.find((c) => c.seq === numeric);
      if (found) return this.getCheckpoint(found.id);
    }

    const match = list.find(
      (c) =>
        c.id === ref ||
        c.id.startsWith(ref) ||
        c.id.endsWith(ref) ||
        (Array.isArray(c.tags) && c.tags.includes(ref))
    );
    return match ? this.getCheckpoint(match.id) : null;
  }

  getCheckpoint(id) {
    const cpFile = path.join(this.checkpointsDir, `${id}.json`);
    if (!fs.existsSync(cpFile)) return null;
    return JSON.parse(fs.readFileSync(cpFile, 'utf8'));
  }

  /**
   * Diff between a target checkpoint (e.g. --last-green) and either another checkpoint or live working tree
   */
  compareWith(targetRef = '--last-green', secondRef = 'WORKTREE') {
    const baseCp = this.resolveCheckpoint(targetRef);
    if (!baseCp) {
      if (targetRef === '--last-green' || targetRef === 'last-green') {
        throw new Error(
          `No passing checkpoint (--last-green with exit code 0) found yet. Specify a checkpoint ID or #seq (e.g. 'ch d #1').`
        );
      }
      throw new Error(`Could not find checkpoint matching '${targetRef}'`);
    }

    let compareTree;
    let compareLabel;
    let compareGetter;
    let compareCp = null;
    let compareEnv = null;

    if (!secondRef || secondRef === 'WORKTREE') {
      compareTree = this.scanWorkspace(false);
      compareLabel = 'Current Working Directory (LIVE)';
      compareEnv = this.captureEnvironment();
      compareGetter = (relPath) =>
        fs.readFileSync(path.join(this.workspaceRoot, relPath), 'utf8');
    } else {
      compareCp = this.resolveCheckpoint(secondRef);
      if (!compareCp) {
        throw new Error(`Could not find checkpoint matching '${secondRef}'`);
      }
      compareTree = compareCp.tree;
      compareLabel = `${compareCp.id} (${compareCp.label})`;
      compareEnv = compareCp.env || {};
      compareGetter = (_relPath, meta) => this.readBlob(meta.hash, true);
    }

    const diffResult = this.diffTrees(
      baseCp.tree,
      compareTree,
      (_relPath, meta) => this.readBlob(meta.hash, true),
      compareGetter
    );

    const envDrift = this.diffEnvironment(baseCp.env || {}, compareEnv || {});

    return {
      baseCheckpoint: baseCp,
      compareCheckpoint: compareCp,
      compareLabel,
      envDrift,
      ...diffResult
    };
  }

  /**
   * Run a shell command, stream its output live, capture stdout/stderr/exitCode, and record a Checkpoint
   */
  runCommandAndRecord(commandStr, options = {}) {
    return new Promise((resolve) => {
      this.ensureInitialized();
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';

      const child = spawn(commandStr, {
        cwd: this.workspaceRoot,
        shell: true,
        env: { ...process.env, FORCE_COLOR: '1' }
      });

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (!options.silent) process.stdout.write(text);
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        if (!options.silent) process.stderr.write(text);
      });

      child.on('close', (code) => {
        const durationMs = Date.now() - startTime;
        const exitCode = typeof code === 'number' ? code : 1;

        if (options.recordCheckpoint === false) {
          return resolve({
            exitCode,
            durationMs,
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd()
          });
        }

        const cp = this.createCheckpoint({
          trigger: 'exec',
          label: options.label || commandStr,
          command: commandStr,
          exitCode,
          durationMs,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          timestamp: options.timestamp
        });

        resolve(cp);
      });
    });
  }

  /**
   * Materialize a checkpoint's file tree onto the working directory without creating a new checkpoint
   */
  materializeTree(targetTree) {
    const currentTree = this.scanWorkspace(false);
    const dirsToCheck = new Set();

    for (const relPath of Object.keys(currentTree)) {
      if (!targetTree[relPath]) {
        const fullPath = path.join(this.workspaceRoot, relPath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          dirsToCheck.add(path.dirname(fullPath));
        }
      }
    }

    for (const dir of dirsToCheck) {
      let cur = dir;
      while (cur.startsWith(this.workspaceRoot) && cur !== this.workspaceRoot) {
        if (fs.existsSync(cur) && fs.readdirSync(cur).length === 0) {
          fs.rmdirSync(cur);
          cur = path.dirname(cur);
        } else {
          break;
        }
      }
    }

    let restoredCount = 0;
    for (const [relPath, meta] of Object.entries(targetTree)) {
      const fullPath = path.join(this.workspaceRoot, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const buffer = this.readBlob(meta.hash, false);
      fs.writeFileSync(fullPath, buffer);
      restoredCount++;
    }

    return restoredCount;
  }

  /**
   * Time-travel rewind: restore workspace files to the exact state of targetRef
   */
  rewindTo(targetRef = '--last-green') {
    const targetCp = this.resolveCheckpoint(targetRef);
    if (!targetCp) {
      throw new Error(`No checkpoint found matching '${targetRef}'`);
    }

    const currentTree = this.scanWorkspace(false);
    const currentHash = this.computeTreeHash(currentTree);

    const latestCp = this.resolveCheckpoint('latest');
    let safetySnapshot = null;

    if (!latestCp || latestCp.treeHash !== currentHash) {
      safetySnapshot = this.createCheckpoint({
        trigger: 'pre-rewind',
        label: `Auto-backup before rewinding to ${targetCp.id}`
      });
    }

    const restoredCount = this.materializeTree(targetCp.tree);

    const rewindCp = this.createCheckpoint({
      trigger: 'rewind',
      label: `Rewound workspace to ${targetCp.id} (${targetCp.label})`,
      command: targetCp.command,
      exitCode: targetCp.exitCode,
      durationMs: 0,
      stdout: `[CHRONOS TIME MACHINE] Restored ${restoredCount} files from ${targetCp.id}`,
      stderr: ''
    });

    return {
      targetCheckpoint: targetCp,
      safetySnapshot,
      rewindCheckpoint: rewindCp,
      restoredCount
    };
  }

  /**
   * Surgical File Checkout: Restore specific file(s) from a checkpoint without rewinding the rest of the project
   */
  checkoutFiles(targetRef = '--last-green', filePaths = []) {
    const targetCp = this.resolveCheckpoint(targetRef);
    if (!targetCp) {
      throw new Error(`No checkpoint found matching '${targetRef}'`);
    }
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error('At least one file path must be specified');
    }

    const restoredFiles = [];
    const removedFiles = [];

    for (const rawPath of filePaths) {
      const relPath = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
      const meta = targetCp.tree[relPath];
      const fullPath = path.join(this.workspaceRoot, relPath);

      if (meta) {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        const buffer = this.readBlob(meta.hash, false);
        fs.writeFileSync(fullPath, buffer);
        restoredFiles.push(relPath);
      } else if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        removedFiles.push(relPath);
      } else {
        throw new Error(`File '${relPath}' does not exist in checkpoint ${targetCp.id}`);
      }
    }

    const cp = this.createCheckpoint({
      trigger: 'pick',
      label: `Surgical restore of [${[...restoredFiles, ...removedFiles].join(', ')}] from ${targetCp.id}`
    });

    return {
      targetCheckpoint: targetCp,
      checkpoint: cp,
      restoredFiles,
      removedFiles
    };
  }

  /**
   * Automated Binary Search Bug Detective (chronos bisect)
   * Finds the exact first checkpoint where `commandStr` started failing!
   */
  async bisect(commandStr, goodRef = '1', badRef = 'latest') {
    this.ensureInitialized();
    const index = this.getIndex();
    if (index.checkpoints.length < 2) {
      throw new Error('Bisect requires at least 2 checkpoints in timeline.');
    }

    const goodCp = this.resolveCheckpoint(goodRef) || this.getCheckpoint(index.checkpoints[0].id);
    const badCp = this.resolveCheckpoint(badRef) || this.resolveCheckpoint('latest');

    if (!goodCp || !badCp) {
      throw new Error('Could not resolve good/bad bounds for bisect.');
    }
    if (goodCp.seq >= badCp.seq) {
      throw new Error(
        `Good checkpoint (#${goodCp.seq}) must be older than bad checkpoint (#${badCp.seq}).`
      );
    }

    // Save current live workspace state so we can restore it 100% after bisect finishes
    const originalTree = this.scanWorkspace(true);

    const candidates = index.checkpoints.filter(
      (c) => c.seq >= goodCp.seq && c.seq <= badCp.seq
    );

    const steps = [];
    let low = 0;
    let high = candidates.length - 1;
    let culpritMeta = candidates[high];

    try {
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const currentMeta = candidates[mid];
        const cp = this.getCheckpoint(currentMeta.id);

        this.materializeTree(cp.tree);
        const execRes = await this.runCommandAndRecord(commandStr, {
          silent: true,
          recordCheckpoint: false
        });

        const passed = execRes.exitCode === 0;
        steps.push({
          seq: cp.seq,
          id: cp.id,
          label: cp.label,
          exitCode: execRes.exitCode,
          passed,
          durationMs: execRes.durationMs
        });

        if (passed) {
          low = mid + 1;
        } else {
          culpritMeta = currentMeta;
          high = mid - 1;
        }
      }
    } finally {
      // Always restore original workspace state
      this.materializeTree(originalTree);
    }

    const culpritCp = this.getCheckpoint(culpritMeta.id);
    let culpritDiff = null;
    if (culpritCp.seq > 1) {
      const prevCp = this.resolveCheckpoint(String(culpritCp.seq - 1));
      if (prevCp) {
        culpritDiff = this.diffTrees(
          prevCp.tree,
          culpritCp.tree,
          (_p, meta) => this.readBlob(meta.hash, true),
          (_p, meta) => this.readBlob(meta.hash, true)
        );
      }
    }

    return {
      command: commandStr,
      goodCheckpoint: goodCp,
      badCheckpoint: badCp,
      culpritCheckpoint: culpritCp,
      culpritDiff,
      steps
    };
  }

  /**
   * Generate a secret-redacted Markdown Flight Report for debugging / sharing
   */
  exportReport(ref = 'latest', options = { redact: true }) {
    const cp = this.resolveCheckpoint(ref);
    if (!cp) {
      throw new Error(`Checkpoint not found: ${ref}`);
    }

    const lastGreen = this.resolveCheckpoint('--last-green');
    const clean = (txt) => {
      const stripped = stripAnsi(txt);
      return options.redact !== false ? redactSecrets(stripped) : stripped;
    };

    const lines = [
      `# ⏱ Chronos Flight Recorder Diagnostic Report`,
      ``,
      `- **Checkpoint:** \`${cp.id}\` (#${cp.seq})`,
      `- **Status:** ${cp.status === 'pass' ? '✅ PASS (exit 0)' : cp.status === 'fail' ? `❌ FAIL (exit ${cp.exitCode})` : `📸 ${cp.trigger.toUpperCase()}`}`,
      `- **Command:** \`${cp.command || cp.label}\``,
      `- **Timestamp:** ${cp.timestamp} (${cp.durationMs}ms)`,
      `- **Environment:** Node \`${cp.env?.nodeVersion || process.version}\` on \`${cp.env?.platform || process.platform}\`${cp.env?.gitBranch ? ` (Git branch: \`${cp.env.gitBranch}\`)` : ''}`,
      ``
    ];

    if (cp.stdout || cp.stderr) {
      lines.push(`## 🖥 Terminal Output (\`stdout\` / \`stderr\`)`);
      lines.push('```text');
      if (cp.stdout) lines.push(clean(cp.stdout));
      if (cp.stderr) {
        if (cp.stdout) lines.push('--- STDERR ---');
        lines.push(clean(cp.stderr));
      }
      lines.push('```');
      lines.push('');
    }

    const baseCp =
      lastGreen && lastGreen.id !== cp.id
        ? lastGreen
        : cp.seq > 1
        ? this.resolveCheckpoint(String(cp.seq - 1))
        : null;

    if (baseCp) {
      const diff = this.compareWith(baseCp.id, cp.id);
      lines.push(
        `## 🔍 Code Changes (vs \`${baseCp.id}\` — ${baseCp.status === 'pass' ? 'Last Green ✅' : baseCp.label})`
      );
      if (diff.envDrift && diff.envDrift.length > 0) {
        lines.push(`> ⚠️ **Environment Drift:** ${diff.envDrift.join(' | ')}`);
        lines.push('');
      }
      for (const file of diff.files) {
        lines.push(`### 📄 \`${file.path}\` (${file.status}: +${file.added}/-${file.removed})`);
        lines.push('```diff');
        for (const hunk of file.hunks) {
          for (const l of hunk.lines) {
            const p = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
            lines.push(`${p} ${clean(l.text)}`);
          }
        }
        lines.push('```');
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Garbage Collection: Keep the latest N checkpoints (plus --last-green and all tagged checkpoints)
   */
  gc(keepCount = 20) {
    this.ensureInitialized();
    const index = this.getIndex();
    const totalBefore = index.checkpoints.length;

    if (totalBefore <= keepCount) {
      return { removedCheckpoints: 0, removedBlobs: 0, bytesFreed: 0 };
    }

    const lastGreen = this.resolveCheckpoint('--last-green');
    const keepIds = new Set(index.checkpoints.slice(-keepCount).map((cp) => cp.id));
    if (lastGreen) keepIds.add(lastGreen.id);
    if (index.tags) {
      for (const taggedId of Object.values(index.tags)) {
        keepIds.add(taggedId);
      }
    }

    const activeBlobs = new Set();
    const remainingCheckpoints = [];
    let removedCheckpoints = 0;

    for (const entry of index.checkpoints) {
      if (keepIds.has(entry.id) || (entry.tags && entry.tags.length > 0)) {
        remainingCheckpoints.push(entry);
        const cp = this.getCheckpoint(entry.id);
        if (cp && cp.tree) {
          for (const meta of Object.values(cp.tree)) {
            activeBlobs.add(meta.hash);
          }
        }
      } else {
        removedCheckpoints++;
        const cpFile = path.join(this.checkpointsDir, `${entry.id}.json`);
        if (fs.existsSync(cpFile)) fs.unlinkSync(cpFile);
      }
    }

    index.checkpoints = remainingCheckpoints;
    this.saveIndex(index);

    let removedBlobs = 0;
    let bytesFreed = 0;

    if (fs.existsSync(this.objectsDir)) {
      for (const prefix of fs.readdirSync(this.objectsDir)) {
        const sub = path.join(this.objectsDir, prefix);
        if (!fs.statSync(sub).isDirectory()) continue;
        for (const rest of fs.readdirSync(sub)) {
          const fullHash = `${prefix}${rest}`;
          if (!activeBlobs.has(fullHash)) {
            const blobPath = path.join(sub, rest);
            bytesFreed += fs.statSync(blobPath).size;
            fs.unlinkSync(blobPath);
            removedBlobs++;
          }
        }
        if (fs.readdirSync(sub).length === 0) {
          fs.rmdirSync(sub);
        }
      }
    }

    return { removedCheckpoints, removedBlobs, bytesFreed };
  }

  /**
   * Compute CAS storage deduplication statistics
   */
  getStorageStats() {
    this.ensureInitialized();
    const index = this.getIndex();

    let logicalBytes = 0;
    for (const entry of index.checkpoints) {
      const cp = this.getCheckpoint(entry.id);
      if (cp && cp.tree) {
        for (const f of Object.values(cp.tree)) {
          logicalBytes += f.size || 0;
        }
      }
    }

    let physicalCompressedBytes = 0;
    let uniqueBlobs = 0;
    if (fs.existsSync(this.objectsDir)) {
      for (const prefix of fs.readdirSync(this.objectsDir)) {
        const sub = path.join(this.objectsDir, prefix);
        if (fs.statSync(sub).isDirectory()) {
          for (const file of fs.readdirSync(sub)) {
            uniqueBlobs++;
            physicalCompressedBytes += fs.statSync(path.join(sub, file)).size;
          }
        }
      }
    }

    const savedPercent =
      logicalBytes > 0
        ? Math.max(0, (1 - physicalCompressedBytes / logicalBytes) * 100).toFixed(1)
        : '0.0';

    return {
      checkpointCount: index.checkpoints.length,
      uniqueBlobs,
      logicalBytes,
      physicalCompressedBytes,
      savedPercent
    };
  }
}

module.exports = { ChronosEngine };
