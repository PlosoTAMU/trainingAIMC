// src/logger.js
// Centralised timestamped logger with stack traces for deep error diagnosis.
//
// Console output policy:
//   info()  → console (always visible)
//   warn()  → console (always visible)
//   error() → console, but RATE-LIMITED: same tag+code combo prints at most
//             once per ERROR_THROTTLE_MS to prevent spam; full details always
//             written to the log file regardless.
//   step()  → FILE ONLY (breadcrumb detail, not needed in terminal)
//   MC server stdout/stderr → FILE ONLY (too noisy for terminal)

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

// ── Log file (appended, not replaced on restart) ──────────────────────────
const LOG_DIR  = path.resolve(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'debug.log');

// Create dir synchronously so it exists before any async I/O.
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// ── Rate-limit state for error console output ─────────────────────────────
const ERROR_THROTTLE_MS = 1000;   // max one console print per tag+code per second
const _errorLastPrinted = new Map(); // key → timestamp

function ts() {
  return new Date().toISOString();
}

function writeFile(level, tag, msg, extra) {
  const line = `[${ts()}] [${level}] [${tag}] ${msg}`;
  logStream.write(line + (extra ? '\n' + extra : '') + '\n');
}

// ── Public API ─────────────────────────────────────────────────────────────

function info(tag, msg) {
  console.log(chalk.cyan(`[${tag}]`) + ' ' + msg);
  writeFile('INFO ', tag, msg);
}

function warn(tag, msg) {
  console.log(chalk.yellow(`[${tag}] ⚠ ${msg}`));
  writeFile('WARN ', tag, msg);
}

/**
 * Log an error with full stack trace.
 * Console output is throttled per (tag + error code) so a repeating error
 * only prints once per second instead of flooding the terminal.
 * The log FILE always receives every occurrence.
 */
function error(tag, msg, err) {
  const errMsg  = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? (err.stack || '(no stack)') : '(not an Error)';
  const code    = err && err.code    ? ` [code=${err.code}]`    : '';
  const syscall = err && err.syscall ? ` [syscall=${err.syscall}]` : '';
  const address = err && err.address ? ` [addr=${err.address}:${err.port || '?'}]` : '';

  // Always write full detail to file
  writeFile('ERROR', tag, `${msg}: ${errMsg}${code}${syscall}${address}`, stack);

  // Rate-limit console output
  const throttleKey = `${tag}::${err && err.code ? err.code : errMsg.slice(0, 40)}`;
  const now = Date.now();
  const lastPrinted = _errorLastPrinted.get(throttleKey) || 0;

  if (now - lastPrinted >= ERROR_THROTTLE_MS) {
    _errorLastPrinted.set(throttleKey, now);
    console.error(chalk.red(`[${tag}] ✖ ${msg}: ${errMsg}${code}${syscall}${address}`));
    console.error(chalk.gray(stack));
    console.error(chalk.gray(`  (further identical errors suppressed for ${ERROR_THROTTLE_MS}ms — see logs/debug.log)`));
  }
}

/**
 * Breadcrumb step — written to the log file ONLY, not the console.
 * Use this for high-frequency lifecycle checkpoints.
 */
function step(tag, msg) {
  writeFile('STEP ', tag, msg);
}

module.exports = { info, warn, error, step, LOG_FILE };
