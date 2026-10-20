/**
 * Check if a Buffer likely contains binary data (presence of NULL byte in first 8KB)
 */
function isBinaryBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  const sampleLength = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Strip ANSI escape sequences from terminal output when needed
 */
function stripAnsi(str = '') {
  return String(str).replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ''
  );
}

/**
 * Automatically redact sensitive tokens, passwords, JWTs, and connection credentials
 */
function redactSecrets(text = '') {
  if (!text) return '';
  return String(text)
    // JWT tokens
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<REDACTED_JWT>')
    // Bearer tokens
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<REDACTED_TOKEN>')
    // Database connection URLs (postgres://user:pass@host, mongodb://..., redis://...)
    .replace(/((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:)([^@\s]+)(@)/gi, '$1<REDACTED_PASSWORD>$3')
    // Common API key patterns (sk-..., ghp_..., gho_..., AIza..., AKIA...)
    .replace(/\b(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/g, '<REDACTED_API_KEY>')
    // Generic key=value secrets
    .replace(/((?:password|passwd|secret|api_key|apikey|access_token|private_key)\s*[:=]\s*['"]?)([^\s'",;]+)(['"]?)/gi, '$1<REDACTED>$3');
}

/**
 * Compute line-by-line diff using Longest Common Subsequence (LCS)
 * Returns structured diff lines and statistics (+added / -removed)
 */
function computeLineDiff(oldText = '', newText = '') {
  const oldLines = oldText === '' ? [] : oldText.replace(/\r\n/g, '\n').split('\n');
  const newLines = newText === '' ? [] : newText.replace(/\r\n/g, '\n').split('\n');

  const n = oldLines.length;
  const m = newLines.length;

  // Safeguard for huge files
  if (n * m > 2_500_000) {
    return {
      added: Math.max(0, m - n),
      removed: Math.max(0, n - m),
      ops: [{ type: 'info', oldLine: null, newLine: null, text: '[Large file changed — line diff omitted for speed]' }]
    };
  }

  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;

  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'equal', oldLine: i + 1, newLine: j + 1, text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', oldLine: i + 1, newLine: null, text: oldLines[i] });
      removed++;
      i++;
    } else {
      ops.push({ type: 'add', oldLine: null, newLine: j + 1, text: newLines[j] });
      added++;
      j++;
    }
  }

  while (i < n) {
    ops.push({ type: 'del', oldLine: i + 1, newLine: null, text: oldLines[i] });
    removed++;
    i++;
  }

  while (j < m) {
    ops.push({ type: 'add', oldLine: null, newLine: j + 1, text: newLines[j] });
    added++;
    j++;
  }

  return { added, removed, ops };
}

/**
 * Filter ops to only show context lines around changes (default 3 lines of context)
 */
function buildContextualHunks(ops, contextRadius = 3) {
  const changedIndices = [];
  ops.forEach((op, idx) => {
    if (op.type !== 'equal') changedIndices.push(idx);
  });

  if (changedIndices.length === 0) return [];

  const include = new Uint8Array(ops.length);
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextRadius);
    const end = Math.min(ops.length - 1, idx + contextRadius);
    for (let k = start; k <= end; k++) include[k] = 1;
  }

  const hunks = [];
  let currentHunk = null;

  for (let idx = 0; idx < ops.length; idx++) {
    if (include[idx]) {
      if (!currentHunk) {
        currentHunk = { lines: [] };
        hunks.push(currentHunk);
      }
      currentHunk.lines.push(ops[idx]);
    } else {
      currentHunk = null;
    }
  }

  return hunks;
}

module.exports = {
  isBinaryBuffer,
  stripAnsi,
  redactSecrets,
  computeLineDiff,
  buildContextualHunks
};
