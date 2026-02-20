// src/logger.js
// Centralised timestamped logger with stack traces for deep error diagnosis.

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

// ── Log file (appended, not replaced on restart) ──────────────────────────
const LOG_DIR  = path.resolve(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'debug.log');

// Create dir synchronously so it exists before any async I/O.
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function ts() {
  return new Date().toISOString();
}

/** Write one line to the file AND to the console (colour-stripped for file). */
function write(level, tag, msg, extra) {
  const line = `[${ts()}] [${level}] [${tag}] ${msg}`;
  // File: plain text
  logStream.write(line + (extra ? '\n' + extra : '') + '\n');
  return line;
}

// ── Public API ─────────────────────────────────────────────────────────────

function info(tag, msg) {
  console.log(chalk.cyan(`[${tag}]`) + ' ' + msg);
  write('INFO ', tag, msg);
}

function warn(tag, msg) {
  console.log(chalk.yellow(`[${tag}] ⚠ ${msg}`));
  write('WARN ', tag, msg);
}

/**
 * Log an error with full stack trace.
 * @param {string}        tag   - e.g. 'BOT:A1', 'RCON', 'FIGHT:3'
 * @param {string}        msg   - human readable context
 * @param {Error|unknown} err   - the error object
 */
function error(tag, msg, err) {
  const errMsg  = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? (err.stack || '(no stack)') : '(not an Error)';
  const code    = err && err.code    ? ` [code=${err.code}]`    : '';
  const syscall = err && err.syscall ? ` [syscall=${err.syscall}]` : '';
  const address = err && err.address ? ` [addr=${err.address}:${err.port || '?'}]` : '';

  const header = chalk.red(`[${tag}] ✖ ${msg}: ${errMsg}${code}${syscall}${address}`);
  console.error(header);
  console.error(chalk.gray(stack));

  write('ERROR', tag, `${msg}: ${errMsg}${code}${syscall}${address}`, stack);
}

/**
 * Log a "step" — a named checkpoint so we can trace exactly how far the
 * fight lifecycle got before an error.
 */
function step(tag, msg) {
  const out = chalk.gray(`  ↳ [${tag}] ${msg}`);
  console.log(out);
  write('STEP ', tag, msg);
}

module.exports = { info, warn, error, step, LOG_FILE };
