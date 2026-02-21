// src/keepawake.js
// Prevents Windows from sleeping while training is running.
// Spawns a PowerShell command that holds a "SystemRequired + DisplayRequired"
// power request for as long as this process is alive.
// Also sets the active power plan to High Performance.
//
// This module is required by train.js at startup — it has no exports.

const { execSync, spawn } = require('child_process');
const log = require('./logger');

const IS_WINDOWS = process.platform === 'win32';

if (!IS_WINDOWS) {
  // On Linux/macOS (WSL native, etc.) just log — no action needed
  log.info('KeepAwake', 'Non-Windows platform — skipping power management');
} else {
  try {
    // Switch to High Performance power plan (prevents CPU throttling + sleep)
    // GUID 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c = High Performance
    execSync(
      'powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
      { stdio: 'ignore' },
    );
    log.info('KeepAwake', 'Power plan → High Performance');
  } catch (e) {
    log.warn('KeepAwake', `Could not set power plan: ${e.message}`);
  }

  // Spawn a PowerShell keep-alive that holds a power request as long as this
  // Node process is alive.  The PowerShell script waits on stdin (which never
  // sends data) so it lives until we kill it.
  let ps;
  try {
    ps = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        // SetThreadExecutionState ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_AWAYMODE_REQUIRED
        // This prevents sleep AND lid-close sleep on most systems.
        `Add-Type -Name NM -Namespace Win32 -MemberDefinition '` +
        `[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);';\n` +
        `[Win32.NM]::SetThreadExecutionState(0x80000003) | Out-Null;\n` +
        `Write-Host 'KeepAwake: holding ES_SYSTEM_REQUIRED|ES_AWAYMODE_REQUIRED';\n` +
        `$null = [Console]::In.ReadToEnd()`,
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );

    ps.stdout.on('data', d => {
      const msg = d.toString().trim();
      if (msg) log.info('KeepAwake', msg);
    });
    ps.on('exit', code => log.info('KeepAwake', `PowerShell exited (code ${code})`));
    log.info('KeepAwake', 'Sleep prevention active — safe to close laptop lid');
    console.log('  [KeepAwake] Sleep prevention ON — safe to close lid\n');

  } catch (e) {
    log.warn('KeepAwake', `Could not start keep-awake process: ${e.message}`);
  }

  // On exit restore Balanced power plan and release the power request
  function cleanup() {
    if (ps) {
      try { ps.stdin.end(); } catch {}
      try { ps.kill(); } catch {}
    }
    try {
      // GUID 381b4222-f694-41f0-9685-ff5bb260df2e = Balanced
      execSync('powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e', { stdio: 'ignore' });
      log.info('KeepAwake', 'Power plan restored to Balanced');
    } catch {}
  }

  process.on('exit',    cleanup);
  process.on('SIGINT',  cleanup);
  process.on('SIGTERM', cleanup);
}
