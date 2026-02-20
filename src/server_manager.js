// src/server_manager.js

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { Rcon } = require('rcon-client');
const cfg = require('../config');
const log = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Maximum characters to keep in stdout/stderr ring buffers
const MAX_LOG_LENGTH = 32768;

class ServerManager {
  constructor({
    port      = cfg.SERVER_PORT,
    rconPort  = cfg.RCON_PORT,
    serverDir = cfg.SERVER_DIR,
    bindHost  = '127.0.0.1',
  } = {}) {
    this.port      = port;
    this.rconPort  = rconPort;
    this.serverDir = path.resolve(serverDir);
    this.bindHost  = bindHost;
    this.process   = null;
    this._rconClient = null;
    this.ready     = false;
    this._rconQueue = Promise.resolve();
    this._rconReconnecting = false;
  }

  async start() {
    log.step('Server', 'start() — prepareDir');
    await this._prepareDir();
    log.step('Server', 'start() — spawnProcess');
    await this._spawnProcess();
    log.step('Server', 'start() — waitForReady');
    await this._waitForReady();

    // Spigot regenerates spigot.yml / bukkit.yml / server.properties on first
    // boot, overwriting whatever we wrote in _prepareDir.  Now that it has
    // finished starting we patch those files with our required values and
    // immediately stop + relaunch so the server actually runs with them.
    const needsRestart = await this._patchConfigsIfNeeded();
    if (needsRestart) {
      log.step('Server', 'configs patched — restarting server to apply them');
      if (this.process) {
        this.process.kill('SIGKILL');
        this.process = null;
      }
      await sleep(2000);
      await this._spawnProcess();
      await this._waitForReady();
    }

    log.step('Server', 'start() — connectRcon');
    await this._connectRcon();
    log.step('Server', 'start() — applyGlobalRules');
    await this._applyGlobalRules();
    this.ready = true;
    log.info('Server', `✓ Ready on port ${this.port}`);
    console.log(`[Server] ✓ Ready on port ${this.port}`);
  }

  async stop() {
    this.ready = false;
    if (this._rconClient) {
      try { await this._rconClient.send('stop'); } catch {}
      await sleep(2000);
      try { this._rconClient.removeAllListeners(); } catch {}
      try { await this._rconClient.end(); } catch {}
      this._rconClient = null;
    }
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }

  /**
   * Send a single RCON command (queued, resilient).
   * Named sendCommand to avoid shadowing the _rconClient property.
   */
  sendCommand(cmd) {
    this._rconQueue = this._rconQueue
      .then(() => this._sendRcon(cmd))
      .catch(() => {});
    return this._rconQueue;
  }

  // Keep backward-compat alias — but as a method that won't shadow properties
  rcon(cmd) {
    return this.sendCommand(cmd);
  }

  async rconBatch(cmds) {
    for (const cmd of cmds) {
      this._rconQueue = this._rconQueue
        .then(() => this._sendRcon(cmd))
        .catch(() => {});
    }
    return this._rconQueue;
  }

  async _sendRcon(cmd) {
    if (!this._rconClient) {
      log.step('RCON', `_sendRcon("${cmd}") — no client, reconnecting`);
      try { await this._connectRcon(); } catch (e) {
        log.error('RCON', `reconnect failed before "${cmd}"`, e);
        return;
      }
    }
    try {
      return await this._rconClient.send(cmd);
    } catch (e) {
      log.error('RCON', `send("${cmd}") failed`, e);
      // Connection lost — try reconnecting once
      if (!this._rconReconnecting) {
        log.step('RCON', `attempting reconnect after send failure for "${cmd}"`);
        try {
          await this._connectRcon();
          return await this._rconClient.send(cmd);
        } catch (e2) {
          log.error('RCON', `send("${cmd}") failed again after reconnect`, e2);
        }
      }
    }
  }

  async _prepareDir() {
    await fs.ensureDir(this.serverDir);

    const jarSrc = path.resolve(cfg.SERVER_JAR);
    const jarDst = path.join(this.serverDir, 'server.jar');
    if (!await fs.pathExists(jarDst)) {
      await fs.copy(jarSrc, jarDst);
    }

    // Always write eula.txt so the server doesn't refuse to start.
    await fs.writeFile(path.join(this.serverDir, 'eula.txt'), 'eula=true\n');

    // Write server.properties with our required keys merged in.
    // We do NOT simply overwrite — we read what exists and patch key=value
    // lines so Spigot's own generated keys are preserved alongside ours.
    await this._patchProperties(path.join(this.serverDir, 'server.properties'),
      this._requiredProperties());
  }

  /**
   * Read a Java properties file, overlay our required key=value pairs, write back.
   * Lines that already have the correct value are left untouched.
   * New keys are appended.  Returns true if any value was changed.
   */
  async _patchProperties(filePath, required) {
    let existing = {};
    let lines = [];
    if (await fs.pathExists(filePath)) {
      const raw = await fs.readFile(filePath, 'utf8');
      lines = raw.split('\n');
      for (const line of lines) {
        const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
        if (m) existing[m[1].trim()] = m[2].trim();
      }
    }

    let changed = false;
    for (const [k, v] of Object.entries(required)) {
      if (String(existing[k]) !== String(v)) {
        changed = true;
        // Update in-place if the key already exists
        let found = false;
        lines = lines.map(line => {
          const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
          if (m && m[1].trim() === k) { found = true; return `${k}=${v}`; }
          return line;
        });
        if (!found) lines.push(`${k}=${v}`);
      }
    }

    await fs.writeFile(filePath, lines.join('\n'));
    return changed;
  }

  _requiredProperties() {
    return {
      'server-port':                    this.port,
      'server-ip':                      this.bindHost === '0.0.0.0' ? '' : this.bindHost,
      'enable-rcon':                    'true',
      'rcon.port':                      this.rconPort,
      'rcon.password':                  cfg.RCON_PASSWORD,
      'online-mode':                    'false',
      'max-players':                    '10',
      'view-distance':                  '2',
      'pvp':                            'true',
      'difficulty':                     '0',      // peaceful = 0
      'gamemode':                       '2',
      'spawn-npcs':                     'false',
      'spawn-animals':                  'false',
      'spawn-monsters':                 'false',
      'generate-structures':            'false',
      'level-type':                     'FLAT',
      'level-name':                     'world',
      'motd':                           'PvP Training Server',
      'network-compression-threshold':  '-1',
      'use-native-transport':           'true',
      'enable-command-block':           'true',
      'allow-flight':                   'true',
      'max-tick-time':                  '-1',
      'connection-throttle':            '-1',
    };
  }

  /**
   * Read a YAML file and patch specific scalar values using simple regex
   * (no full YAML parser needed — these are flat key: value lines).
   * Returns true if anything changed.
   */
  async _patchYaml(filePath, patches) {
    if (!await fs.pathExists(filePath)) return false;
    let text = await fs.readFile(filePath, 'utf8');
    let changed = false;
    for (const [key, value] of Object.entries(patches)) {
      // Match "  key: <anything>" (any indentation level)
      const re = new RegExp(`^(\\s*${key}:\\s*)(.+)$`, 'm');
      const replacement = `$1${value}`;
      const updated = text.replace(re, replacement);
      if (updated !== text) { text = updated; changed = true; }
    }
    if (changed) await fs.writeFile(filePath, text);
    return changed;
  }

  /**
   * After first boot, Spigot has regenerated its config files.
   * Patch the critical values and return true if anything changed
   * (caller will restart the server to pick them up).
   */
  async _patchConfigsIfNeeded() {
    log.step('Server', 'patching configs post-boot');

    const spigotChanged = await this._patchYaml(
      path.join(this.serverDir, 'spigot.yml'), {
        'connection-throttle': '-1',
        'timeout-time':        '300',
        'netty-threads':       '2',
        'moved-wrongly-threshold':    '100.0',
        'moved-too-quickly-multiplier': '100.0',
      }
    );

    const bukkitChanged = await this._patchYaml(
      path.join(this.serverDir, 'bukkit.yml'), {
        'connection-throttle': '-1',
        'warn-on-overload':    'false',
      }
    );

    const propsChanged = await this._patchProperties(
      path.join(this.serverDir, 'server.properties'),
      this._requiredProperties()
    );

    if (spigotChanged)  log.step('Server', 'spigot.yml was patched');
    if (bukkitChanged)  log.step('Server', 'bukkit.yml was patched');
    if (propsChanged)   log.step('Server', 'server.properties was patched');

    return spigotChanged || bukkitChanged || propsChanged;
  }

  async _spawnProcess() {
    const args = [...cfg.JAVA_FLAGS, 'server.jar', 'nogui'];
    this.process = spawn('java', args, {
      cwd: this.serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Use ring-buffered strings to prevent unbounded memory growth.
    // Only the tail of the output is kept (enough for startup detection).
    this._stdout = '';
    this._stderr = '';

    this.process.stdout.on('data', d => {
      let chunk;
      try { chunk = d.toString(); } catch { return; }
      this._stdout += chunk;
      if (this._stdout.length > MAX_LOG_LENGTH) {
        this._stdout = this._stdout.slice(-MAX_LOG_LENGTH);
      }
      // Mirror every line of MC output to the debug log file
      const trimmed = chunk.trim();
      if (trimmed) log.step('MC-OUT', trimmed);
    });

    this.process.stderr.on('data', d => {
      let chunk;
      try { chunk = d.toString(); } catch { return; }
      this._stderr += chunk;
      if (this._stderr.length > MAX_LOG_LENGTH) {
        this._stderr = this._stderr.slice(-MAX_LOG_LENGTH);
      }
      const trimmed = chunk.trim();
      if (trimmed) log.step('MC-ERR', trimmed);
    });

    this.process.on('exit', code => {
      if (this.ready) {
        log.error('Server', `Process exited unexpectedly (code ${code})`, new Error(`exit code ${code}`));
        this.ready = false;
      }
    });

    // Prevent unhandled error events from crashing the process
    this.process.on('error', err => {
      log.error('Server', 'Process spawn error', err);
    });
  }

  async _waitForReady() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Server start timeout (120s)')), 120000);

      const check = setInterval(() => {
        if (this._stdout.includes('Done') || this._stdout.includes('For help')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 500);

      this.process.on('exit', () => {
        clearTimeout(timeout);
        clearInterval(check);
        reject(new Error('Server exited during startup'));
      });
    });
  }

  async _connectRcon() {
    if (this._rconReconnecting) {
      log.step('RCON', '_connectRcon called while already reconnecting — skipping');
      return;
    }
    this._rconReconnecting = true;
    log.step('RCON', `_connectRcon start (port ${this.rconPort})`);

    try {
      // Clean up old connection
      if (this._rconClient) {
        log.step('RCON', 'tearing down stale client');
        try { this._rconClient.removeAllListeners(); } catch {}
        try { await this._rconClient.end(); } catch {}
        this._rconClient = null;
      }

      await sleep(1000);

      const maxRetries = 5;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        log.step('RCON', `connect attempt ${attempt}/${maxRetries}`);
        try {
          const rcon = new Rcon({
            host: '127.0.0.1',
            port: this.rconPort,
            password: cfg.RCON_PASSWORD,
            timeout: 10000,
          });

          // Absorb socket-level errors so they don't crash the process
          rcon.on('error', err => {
            log.error('RCON', 'socket error on live connection', err);
          });

          rcon.on('end', () => {
            log.step('RCON', 'connection ended — will reconnect on next command');
            // Mark client as gone so _sendRcon knows to reconnect
            if (this._rconClient === rcon) {
              this._rconClient = null;
            }
          });

          await rcon.connect();
          this._rconClient = rcon;
          log.step('RCON', `connected successfully on attempt ${attempt}`);
          return;
        } catch (err) {
          log.error('RCON', `connect attempt ${attempt} failed`, err);
          if (attempt < maxRetries) {
            const delay = 2000 * attempt;
            log.step('RCON', `waiting ${delay}ms before retry`);
            await sleep(delay);
          } else {
            throw err;
          }
        }
      }
    } finally {
      this._rconReconnecting = false;
    }
  }

  async _applyGlobalRules() {
    await this.rconBatch([
      'gamerule doDaylightCycle false',
      'gamerule doWeatherCycle false',
      'gamerule naturalRegeneration false',
      'gamerule doMobSpawning false',
      'gamerule doFireTick false',
      'gamerule keepInventory true',
      'gamerule logAdminCommands false',
      'gamerule sendCommandFeedback false',
      'gamerule commandBlockOutput false',
      'gamerule mobGriefing false',
      'gamerule doEntityDrops false',
      'gamerule showDeathMessages false',
      'time set 6000',
    ]);
  }

  static zoneSpawnA(zoneId) {
    const ox = zoneId * cfg.ZONE.SPACING;
    return { x: ox + 0.5, y: cfg.ZONE.FLOOR_Y, z: 0.5, yaw: 90 };
  }

  static zoneSpawnB(zoneId) {
    const ox = zoneId * cfg.ZONE.SPACING;
    return { x: ox + cfg.ZONE.FIGHTER_SEP + 0.5, y: cfg.ZONE.FLOOR_Y, z: 0.5, yaw: 270 };
  }
}

module.exports = { ServerManager };