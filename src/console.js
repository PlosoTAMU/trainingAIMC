// src/console.js
// Attaches to the training server's stdout and streams it live to the terminal.
// Run in a separate tab alongside `npm run train`.
//
// Usage:  npm run console
//   OR:   node src/console.js
//
// The server must already be running (started by train.js).
// This script tails server/instance/logs/latest.log so it works even if
// the server was started before this script.

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const LOG_FILE = path.resolve(cfg.SERVER_DIR, 'logs', 'latest.log');

console.log(`[console] Tailing: ${LOG_FILE}`);
console.log(`[console] Waiting for log file...`);

// Poll until the file exists (server may not have written it yet)
function waitForFile(cb) {
  if (fs.existsSync(LOG_FILE)) return cb();
  setTimeout(() => waitForFile(cb), 500);
}

waitForFile(() => {
  console.log('[console] Log file found — streaming live output:\n');
  console.log('─'.repeat(80));

  const stream = fs.createReadStream(LOG_FILE, { encoding: 'utf8' });
  stream.pipe(process.stdout);
  stream.on('end', () => {
    // After the initial contents are flushed, watch for new data
    let pos = fs.statSync(LOG_FILE).size;

    fs.watch(LOG_FILE, () => {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size <= pos) {
        // File was truncated (new server boot) — reset position
        pos = 0;
      }
      if (stat.size > pos) {
        const fd = fs.openSync(LOG_FILE, 'r');
        const len = stat.size - pos;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        fs.closeSync(fd);
        pos = stat.size;
        process.stdout.write(buf.toString('utf8'));
      }
    });
  });
});

process.on('SIGINT', () => {
  console.log('\n[console] Detached.');
  process.exit(0);
});
