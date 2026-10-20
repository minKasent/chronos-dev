#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ChronosEngine } = require('../src/engine');
const { createServer } = require('../src/server');
const { setupDemoScenario } = require('../src/demo');
const pkg = require('../package.json');

// ANSI Styling Helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m'
};

function printBanner() {
  console.log(
    `${c.cyan}${c.bold}╭──────────────────────────────────────────────────────────────────────╮${c.reset}`
  );
  console.log(
    `${c.cyan}${c.bold}│ ⏱  CHRONOS-DEV v${pkg.version} // Flight Recorder & Code Time Machine        │${c.reset}`
  );
  console.log(
    `${c.cyan}${c.bold}╰──────────────────────────────────────────────────────────────────────╯${c.reset}`
  );
}

function formatStatusBadge(cp, isLastGreen = false) {
  const tagsStr =
    Array.isArray(cp.tags) && cp.tags.length > 0
      ? ` ${cp.tags.map((t) => `${c.yellow}[🏷 ${t}]${c.reset}`).join(' ')}`
      : '';
  if (cp.status === 'pass') {
    return `${c.green}${c.bold}✅ PASS (0)${c.reset}${isLastGreen ? ` ${c.yellow}🌟 [LAST-GREEN]${c.reset}` : ''}${tagsStr}`;
  }
  if (cp.status === 'fail') {
    return `${c.red}${c.bold}❌ FAIL (${cp.exitCode})${c.reset}${tagsStr}`;
  }
  return `${c.magenta}${c.bold}📸 ${cp.trigger.toUpperCase()}${c.reset}${tagsStr}`;
}

function printTimeline(engine) {
  const index = engine.getIndex();
  const stats = engine.getStorageStats();
  const lastGreen = engine.resolveCheckpoint('--last-green');
  const lastGreenId = lastGreen ? lastGreen.id : null;

  printBanner();
  console.log(
    `${c.gray}Workspace:${c.reset} ${engine.workspaceRoot}\n` +
      `${c.gray}CAS Store:${c.reset} ${c.cyan}${stats.checkpointCount} checkpoints${c.reset} | ` +
      `${c.cyan}${stats.uniqueBlobs} unique blobs${c.reset} | ` +
      `Deduplication saved ${c.green}${c.bold}${stats.savedPercent}%${c.reset} (${(stats.physicalCompressedBytes / 1024).toFixed(1)} KB on disk)\n`
  );

  if (index.checkpoints.length === 0) {
    console.log(`${c.yellow}No checkpoints recorded yet. Run 'ch r <command>' or 'ch snap'.${c.reset}`);
    return;
  }

  const list = [...index.checkpoints].reverse();
  for (const cp of list) {
    const isLG = cp.id === lastGreenId;
    const badge = formatStatusBadge(cp, isLG);
    const time = new Date(cp.timestamp).toLocaleTimeString();
    const d = cp.diffSummary || { totalChangedFiles: 0, addedLines: 0, removedLines: 0 };

    console.log(
      `${c.bold}#${String(cp.seq).padEnd(2)}${c.reset} ${c.cyan}${cp.id}${c.reset}  ${badge}  ${c.gray}⏱ ${cp.durationMs}ms at ${time}${c.reset}`
    );
    console.log(
      `   ${c.gray}├─ Command/Note:${c.reset} ${c.bold}${cp.label}${c.reset}`
    );
    console.log(
      `   ${c.gray}╰─ Delta:${c.reset}        ${d.totalChangedFiles} file(s) changed (${c.green}+${d.addedLines}${c.reset} / ${c.red}-${d.removedLines}${c.reset} lines)\n`
    );
  }
}

function printDiffFilesList(files) {
  for (const file of files) {
    console.log(
      `${c.cyan}━━━ 📄 ${c.bold}${file.path}${c.reset} ${c.gray}(${file.status})${c.reset} ${c.green}+${file.added}${c.reset}/${c.red}-${file.removed}${c.reset} ━━━`
    );
    for (let h = 0; h < file.hunks.length; h++) {
      if (h > 0) console.log(`${c.gray}   ...${c.reset}`);
      for (const line of file.hunks[h].lines) {
        const oldNum = line.oldLine ? String(line.oldLine).padStart(3) : '   ';
        const newNum = line.newLine ? String(line.newLine).padStart(3) : '   ';
        if (line.type === 'add') {
          console.log(`${c.gray}${oldNum} ${newNum} │${c.reset} ${c.green}+ ${line.text}${c.reset}`);
        } else if (line.type === 'del') {
          console.log(`${c.gray}${oldNum} ${newNum} │${c.reset} ${c.red}- ${line.text}${c.reset}`);
        } else {
          console.log(`${c.gray}${oldNum} ${newNum} │   ${line.text}${c.reset}`);
        }
      }
    }
    console.log('');
  }
}

function printDiff(engine, baseRef = '--last-green', targetRef = 'WORKTREE') {
  const diff = engine.compareWith(baseRef, targetRef);
  const baseCp = diff.baseCheckpoint;

  printBanner();
  console.log(
    `${c.bold}🔍 TIME-MACHINE DIFF ANALYSIS${c.reset}\n` +
      `   ${c.gray}Base Checkpoint:${c.reset} ${c.cyan}${c.bold}${baseCp.id}${c.reset} — ${baseCp.label} (${formatStatusBadge(baseCp)})\n` +
      `   ${c.gray}Compared With:${c.reset}   ${c.yellow}${c.bold}${diff.compareLabel}${c.reset}\n` +
      `   ${c.gray}Summary:${c.reset}         ${c.bold}${diff.summary.totalChangedFiles} file(s) modified${c.reset} ` +
      `(${c.green}+${diff.summary.addedLines} additions${c.reset}, ${c.red}-${diff.summary.removedLines} deletions${c.reset})\n`
  );

  if (diff.envDrift && diff.envDrift.length > 0) {
    console.log(
      `   ${c.yellow}${c.bold}⚠️  ENVIRONMENT DRIFT DETECTED:${c.reset} ${diff.envDrift.join(' | ')}\n`
    );
  }

  if (diff.files.length === 0) {
    console.log(`${c.green}✨ Working directory is identical to ${baseCp.id}!${c.reset}`);
    return;
  }

  printDiffFilesList(diff.files);
}

function getShellHookSnippet(shell = 'powershell') {
  const s = shell.toLowerCase();
  if (s === 'powershell' || s === 'pwsh') {
    return `# Add to your PowerShell $PROFILE (notepad $PROFILE):
function chr { chronos run @args }
function chd { chronos diff --last-green @args }
function chb { chronos rewind --last-green @args }
function cht { chronos timeline }`;
  }
  return `# Add to your ~/.bashrc or ~/.zshrc:
alias chr='chronos run'
alias chd='chronos diff --last-green'
alias chb='chronos rewind --last-green'
alias cht='chronos timeline'`;
}

function openBrowser(url) {
  const plat = process.platform;
  const cmd =
    plat === 'win32'
      ? `start "" "${url}"`
      : plat === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  spawn(cmd, { shell: true, detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--version') || args.includes('-v')) {
    console.log(pkg.version);
    return;
  }

  // Support --cwd flag anywhere in arguments
  let cwd = process.cwd();
  const cwdIdx = args.indexOf('--cwd');
  if (cwdIdx !== -1 && args[cwdIdx + 1]) {
    cwd = path.resolve(args[cwdIdx + 1]);
    args.splice(cwdIdx, 2);
  }

  const cmd = args[0] || 'help';
  const engine = new ChronosEngine(cwd);

  if (cmd === 'init') {
    engine.init();
    printBanner();
    console.log(`${c.green}✅ Initialized Chronos Flight Recorder in ${engine.chronosDir}${c.reset}`);
    return;
  }

  if (cmd === 'run' || cmd === 'r' || cmd === 'exec') {
    const commandStr = args.slice(1).join(' ');
    if (!commandStr) {
      console.error(`${c.red}Usage: ch r <command> (e.g. ch r npm test)${c.reset}`);
      process.exit(1);
    }
    console.log(`${c.cyan}[CHRONOS] ▶ Executing & recording:${c.reset} ${c.bold}${commandStr}${c.reset}\n`);
    const cp = await engine.runCommandAndRecord(commandStr);
    const d = cp.diffSummary;
    const statusIcon =
      cp.exitCode === 0
        ? `${c.green}✅ PASS (exit 0)${c.reset}`
        : `${c.red}❌ FAIL (exit ${cp.exitCode})${c.reset}`;
    console.log(
      `\n${c.cyan}╭─ [CHRONOS FLIGHT RECORDER] ──────────────────────────────────────────╮${c.reset}`
    );
    console.log(
      `${c.cyan}│${c.reset} 📸 Saved ${c.bold}${cp.id}${c.reset} | ${statusIcon} in ${cp.durationMs}ms`
    );
    console.log(
      `${c.cyan}│${c.reset} 📊 Delta: ${d.totalChangedFiles} file(s) changed (${c.green}+${d.addedLines}${c.reset}/${c.red}-${d.removedLines}${c.reset} lines)`
    );
    if (cp.exitCode !== 0) {
      console.log(
        `${c.cyan}│${c.reset} 💡 Quick Fix: ${c.yellow}${c.bold}ch d${c.reset} (diff), ${c.yellow}${c.bold}ch pick --last-green <file>${c.reset}, or ${c.yellow}${c.bold}ch back${c.reset}`
      );
    }
    console.log(
      `${c.cyan}╰──────────────────────────────────────────────────────────────────────╯${c.reset}`
    );
    process.exit(cp.exitCode || 0);
  }

  if (cmd === 'snap' || cmd === 's') {
    const label = args.slice(1).join(' ') || 'Manual snapshot';
    const cp = engine.createCheckpoint({ trigger: 'manual', label });
    console.log(
      `${c.green}📸 Created Checkpoint ${c.bold}${cp.id}${c.reset}: "${label}" (${cp.fileCount} files tracked)`
    );
    return;
  }

  if (cmd === 'tag') {
    const ref = args[1];
    const tagName = args[2];
    if (!ref || !tagName) {
      console.error(`${c.red}Usage: ch tag <checkpoint-ref> <tag-name> (e.g. ch tag --last-green v1-stable)${c.reset}`);
      process.exit(1);
    }
    const res = engine.tagCheckpoint(ref, tagName);
    console.log(
      `${c.green}🏷  Tagged checkpoint ${c.cyan}${c.bold}${res.checkpoint.id}${c.reset} as ${c.yellow}${c.bold}"${res.tag}"${c.reset}`
    );
    return;
  }

  if (cmd === 'timeline' || cmd === 'tl' || cmd === 'log' || cmd === 'status') {
    printTimeline(engine);
    return;
  }

  if (cmd === 'inspect' || cmd === 'show' || cmd === 'i') {
    const ref = args[1] || 'latest';
    const cp = engine.resolveCheckpoint(ref);
    if (!cp) {
      console.error(`${c.red}Checkpoint not found: ${ref}${c.reset}`);
      process.exit(1);
    }
    printBanner();
    console.log(
      `${c.bold}🔎 CHECKPOINT FLIGHT RECORD:${c.reset} ${c.cyan}${c.bold}${cp.id}${c.reset} (${formatStatusBadge(cp)})\n` +
        `   ${c.gray}Timestamp:${c.reset} ${cp.timestamp}\n` +
        `   ${c.gray}Command:${c.reset}   ${c.bold}${cp.command || cp.label}${c.reset}\n` +
        `   ${c.gray}Duration:${c.reset}  ${cp.durationMs}ms | Files tracked: ${cp.fileCount}\n`
    );
    console.log(`${c.cyan}━━━ 🖥  CAPTURED TERMINAL OUTPUT (stdout/stderr) ━━━${c.reset}`);
    if (cp.stdout) console.log(cp.stdout);
    if (cp.stderr) console.log(`${c.red}${cp.stderr}${c.reset}`);
    if (!cp.stdout && !cp.stderr) console.log(`${c.gray}(no terminal output)${c.reset}`);
    console.log('');
    if (cp.seq > 1) {
      printDiff(engine, String(cp.seq - 1), cp.id);
    }
    return;
  }

  if (cmd === 'diff' || cmd === 'd') {
    const baseRef = args[1] || '--last-green';
    const targetRef = args[2] || 'WORKTREE';
    printDiff(engine, baseRef, targetRef);
    return;
  }

  if (cmd === 'pick' || cmd === 'checkout' || cmd === 'co') {
    const targetRef = args[1] || '--last-green';
    const files = args.slice(2);
    if (files.length === 0) {
      console.error(
        `${c.red}Usage: ch pick <checkpoint-ref> <file1> [file2...] (e.g. ch pick --last-green src/pricing.js)${c.reset}`
      );
      process.exit(1);
    }
    const res = engine.checkoutFiles(targetRef, files);
    printBanner();
    console.log(
      `${c.green}${c.bold}✨ SURGICAL FILE RESTORE COMPLETE!${c.reset}\n` +
        `   Source Checkpoint: ${c.cyan}${c.bold}${res.targetCheckpoint.id}${c.reset} (${res.targetCheckpoint.label})\n` +
        `   Restored File(s):  ${c.bold}${res.restoredFiles.join(', ') || 'none'}${c.reset}`
    );
    return;
  }

  if (cmd === 'bisect' || cmd === 'bs') {
    const commandStr = args.slice(1).join(' ') || 'node test.js';
    printBanner();
    console.log(
      `${c.magenta}${c.bold}🕵️‍♂️ RUNNING AUTOMATED BINARY-SEARCH BISECT:${c.reset} ${c.cyan}${commandStr}${c.reset}\n`
    );
    const res = await engine.bisect(commandStr, '1', 'latest');
    for (let i = 0; i < res.steps.length; i++) {
      const s = res.steps[i];
      const icon = s.passed ? `${c.green}✅ PASS${c.reset}` : `${c.red}❌ FAIL (exit ${s.exitCode})${c.reset}`;
      console.log(
        `   Step ${i + 1}: Tested #${s.seq} (${c.cyan}${s.id}${c.reset}) ➔ ${icon} (${s.durationMs}ms)`
      );
    }
    const culprit = res.culpritCheckpoint;
    console.log(
      `\n${c.yellow}${c.bold}🎯 CULPRIT IDENTIFIED IN ${res.steps.length} STEP(S):${c.reset} ` +
        `${c.cyan}${c.bold}#${culprit.seq} (${culprit.id})${c.reset} — "${culprit.label}"\n`
    );
    if (res.culpritDiff && res.culpritDiff.files.length > 0) {
      console.log(`${c.bold}Exact changes introduced in #${culprit.seq} that broke the build:${c.reset}\n`);
      printDiffFilesList(res.culpritDiff.files);
    }
    return;
  }

  if (cmd === 'export' || cmd === 'report') {
    const outIdx = args.indexOf('--out');
    let outFile = null;
    if (outIdx !== -1 && args[outIdx + 1]) {
      outFile = args[outIdx + 1];
      args.splice(outIdx, 2);
    }
    const ref = args[1] || 'latest';
    const md = engine.exportReport(ref, { redact: true });
    if (outFile) {
      fs.writeFileSync(path.resolve(cwd, outFile), md, 'utf8');
      console.log(`${c.green}📋 Exported secret-redacted Flight Report to ${outFile}${c.reset}`);
    } else {
      console.log(md);
    }
    return;
  }

  if (cmd === 'rewind' || cmd === 'rw' || cmd === 'back' || cmd === 'restore') {
    const targetRef = args[1] || '--last-green';
    const res = engine.rewindTo(targetRef);
    printBanner();
    if (res.safetySnapshot) {
      console.log(
        `${c.cyan}🛡  Auto-saved dirty state to safety checkpoint:${c.reset} ${c.bold}${res.safetySnapshot.id}${c.reset}`
      );
    }
    console.log(
      `${c.green}${c.bold}⏪ TIME TRAVEL COMPLETE!${c.reset}\n` +
        `   Restored ${c.bold}${res.restoredCount} files${c.reset} to exact state of ${c.cyan}${c.bold}${res.targetCheckpoint.id}${c.reset} (${res.targetCheckpoint.label})`
    );
    return;
  }

  if (cmd === 'gc' || cmd === 'clean') {
    const keepCount = Number(args[1]) || 20;
    const res = engine.gc(keepCount);
    printBanner();
    console.log(
      `${c.green}🧹 Garbage Collection Complete:${c.reset}\n` +
        `   Pruned ${c.bold}${res.removedCheckpoints} old checkpoints${c.reset} & ${c.bold}${res.removedBlobs} orphaned blobs${c.reset} (${(res.bytesFreed / 1024).toFixed(1)} KB freed)`
    );
    return;
  }

  if (cmd === 'hook') {
    const shell = args[1] || (process.platform === 'win32' ? 'powershell' : 'bash');
    console.log(getShellHookSnippet(shell));
    return;
  }

  if (cmd === 'watch' || cmd === 'w') {
    const execIdx = args.indexOf('--exec');
    const autoCmd = execIdx !== -1 ? args[execIdx + 1] : null;
    printBanner();
    console.log(`${c.green}👀 Watching workspace for changes:${c.reset} ${engine.workspaceRoot}`);
    if (autoCmd) {
      console.log(`${c.cyan}⚡ Auto-running on save:${c.reset} ${c.bold}${autoCmd}${c.reset}`);
    }

    let timer = null;
    fs.watch(engine.workspaceRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const norm = filename.replace(/\\/g, '/');
      if (norm.startsWith('.chronos') || norm.startsWith('.git') || norm.startsWith('node_modules')) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (autoCmd) {
          console.log(`\n${c.cyan}[WATCH] File changed: ${norm} -> Running '${autoCmd}'...${c.reset}`);
          await engine.runCommandAndRecord(autoCmd);
        } else {
          const cp = engine.createCheckpoint({
            trigger: 'watch',
            label: `Auto-saved on modifying ${norm}`
          });
          console.log(
            `${c.magenta}[WATCH] 📸 Micro-snapshot ${cp.id}${c.reset} (${norm} | +${cp.diffSummary.addedLines}/-${cp.diffSummary.removedLines})`
          );
        }
      }, 350);
    });
    return;
  }

  if (cmd === 'ui') {
    const shouldOpen = args.includes('--open') || args.includes('-o');
    const portArg = args.slice(1).find((a) => !a.startsWith('-'));
    const port = Number(portArg) || 4321;
    const { url } = await createServer(cwd, port);
    printBanner();
    console.log(`${c.green}${c.bold}🚀 Chronos Flight Recorder Web UI v2.0 is live at:${c.reset} ${c.cyan}${c.bold}${url}${c.reset}`);
    console.log(`${c.gray}   Tracking workspace: ${cwd}${c.reset}`);
    if (shouldOpen) openBrowser(url);
    return;
  }

  if (cmd === 'demo') {
    const sandboxDir = path.join(cwd, 'playground');
    printBanner();
    console.log(`${c.cyan}🎬 Setting up interactive Time-Machine Demo in:${c.reset} ${sandboxDir}\n`);
    const demoEngine = await setupDemoScenario(sandboxDir);
    demoEngine.tagCheckpoint('2', 'v1-stable');
    printTimeline(demoEngine);
    console.log(`${c.yellow}${c.bold}🔥 Look! Checkpoints #1 and #2 passed (✅), then #3 and #4 broke the build (❌)!${c.reset}`);
    console.log(`${c.cyan}Try running these v2.0 MAXPING commands:${c.reset}`);
    console.log(`  1. ${c.bold}ch --cwd ./playground d${c.reset}                               (Diff vs --last-green)`);
    console.log(`  2. ${c.bold}ch --cwd ./playground bisect node test.js${c.reset}             (Auto-Bisect exact culprit!)`);
    console.log(`  3. ${c.bold}ch --cwd ./playground pick --last-green src/shipping.js${c.reset} (Surgical 1-file restore)`);
    console.log(`  4. ${c.bold}ch --cwd ./playground export${c.reset}                          (Generate Markdown Bug Report)`);
    console.log(`  5. ${c.bold}ch --cwd ./playground back${c.reset}                            (Rewind all to --last-green)\n`);
    return;
  }

  // Help menu
  printBanner();
  console.log(`
${c.bold}USAGE:${c.reset}
  chronos <command> [options]   ${c.gray}(or use the fast alias: ${c.cyan}${c.bold}ch${c.reset}${c.gray})${c.reset}

${c.bold}ULTRA-FAST ALIASES (v2.0 MAXPING):${c.reset}
  ${c.cyan}ch r <cmd>${c.reset}                        Run command & record flight checkpoint (e.g. ${c.bold}ch r npm test${c.reset})
  ${c.cyan}ch d [ref]${c.reset}                        Diff current broken code against ${c.green}--last-green${c.reset} (or tag/id)
  ${c.cyan}ch pick <ref> <file...>${c.reset}           Surgically restore ONLY specific file(s) from a checkpoint
  ${c.cyan}ch bisect <cmd>${c.reset}                   Binary-search timeline to find the exact checkpoint that broke tests
  ${c.cyan}ch tag <ref> <name>${c.reset}               Bookmark a checkpoint (e.g. ${c.bold}ch tag --last-green v1-stable${c.reset})
  ${c.cyan}ch export [ref] [--out file.md]${c.reset}   Generate secret-redacted Markdown Bug Report
  ${c.cyan}ch back [ref]${c.reset}                     Rewind entire workspace to ${c.green}--last-green${c.reset} (with safety backup)
  ${c.cyan}ch tl${c.reset}                             Show visual timeline of checkpoints, tags & storage stats
  ${c.cyan}ch i [id]${c.reset}                         Inspect terminal logs (stdout/stderr) & diff of a checkpoint
  ${c.cyan}ch ui [--open]${c.reset}                    Launch real-time SSE Flight Recorder Web Dashboard
  ${c.cyan}ch gc [keepCount]${c.reset}                 Prune old checkpoints while preserving ${c.green}--last-green${c.reset} & tags
`);
}

main().catch((err) => {
  console.error(`${c.red}Error: ${err.message}${c.reset}`);
  process.exit(1);
});
