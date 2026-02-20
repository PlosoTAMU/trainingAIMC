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
    // After Spigot finishes booting it may have re-written configs.
    // Re-apply our critical overrides now (no restart needed — these take
    // effect on the NEXT boot, but connection-throttle is already -1 from
    // the full spigot.yml we wrote before boot).
    await this._rewriteConfigs();
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

    await fs.writeFile(path.join(this.serverDir, 'eula.txt'), 'eula=true\n');

    // Write ALL config files unconditionally before every boot.
    // Spigot 1.8 will NOT regenerate a file that already exists with a valid
    // config-version header — so writing them here means our values survive.
    await this._rewriteConfigs();
  }

  /**
   * Write server.properties, spigot.yml, and bukkit.yml with all values we
   * need.  Called both before boot (so Spigot never gets a chance to generate
   * its own defaults) and after boot (to overwrite anything Spigot touched).
   */
  async _rewriteConfigs() {
    await fs.writeFile(
      path.join(this.serverDir, 'server.properties'),
      this._buildServerProperties(),
    );
    await fs.writeFile(
      path.join(this.serverDir, 'spigot.yml'),
      this._buildSpigotYml(),
    );
    await fs.writeFile(
      path.join(this.serverDir, 'bukkit.yml'),
      this._buildBukkitYml(),
    );
    log.step('Server', 'configs written');
  }

  _buildServerProperties() {
    // Write every key Spigot 1.8 knows about so it has no reason to regenerate.
    return [
      `#Minecraft server properties`,
      `server-port=${this.port}`,
      `server-ip=${this.bindHost === '0.0.0.0' ? '' : this.bindHost}`,
      `enable-rcon=true`,
      `rcon.port=${this.rconPort}`,
      `rcon.password=${cfg.RCON_PASSWORD}`,
      `online-mode=false`,
      `max-players=10`,
      `view-distance=2`,
      `pvp=true`,
      `difficulty=0`,
      `gamemode=2`,
      `force-gamemode=true`,
      `spawn-npcs=false`,
      `spawn-animals=false`,
      `spawn-monsters=false`,
      `generate-structures=false`,
      `level-type=FLAT`,
      `generator-settings=3;minecraft:bedrock,1;1;`,
      `level-name=world`,
      `motd=PvP Training Server`,
      `network-compression-threshold=-1`,
      `use-native-transport=true`,
      `enable-command-block=true`,
      `allow-flight=true`,
      `max-tick-time=-1`,
      `connection-throttle=-1`,
      `player-idle-timeout=0`,
      `white-list=false`,
      `resource-pack=`,
      `resource-pack-hash=`,
    ].join('\n') + '\n';
  }

  _buildSpigotYml() {
    // Full spigot.yml matching what Spigot 1.8.8 expects.
    // config-version must match so Spigot does not regenerate.
    // Key values: connection-throttle:-1, restart-on-crash:false,
    // timeout-time:300, max-tick-time both -1.
    return `config-version: 8
settings:
  debug: false
  save-user-cache-on-stop-only: true
  moved-wrongly-threshold: 100.0
  moved-too-quickly-threshold: 100.0
  moved-too-quickly-multiplier: 100.0
  bungeecord: false
  late-bind: false
  sample-count: 12
  player-shuffle: 0
  filter-creative-items: true
  user-cache-size: 1000
  int-cache-limit: 1024
  timeout-time: 300
  restart-on-crash: false
  restart-script: ./start.sh
  netty-threads: 2
  connection-throttle: -1
  attribute:
    maxHealth:
      max: 2048.0
    movementSpeed:
      max: 2048.0
    attackDamage:
      max: 2048.0
commands:
  tab-complete: 0
  spam-exclusions:
    - /skill
  replace-commands:
    - setblock
    - summon
    - testforblock
    - tellraw
  log: true
  silent-commandblock-console: false
  send-namespaced: true
messages:
  whitelist: You are not whitelisted on this server!
  unknown-command: Unknown command. Type "/help" for help.
  server-full: The server is full!
  outdated-client: Outdated client! Please use {0}
  outdated-server: Outdated server! I\'m still on {0}
  restart: Server restarting
world-settings:
  default:
    verbose: false
    mob-spawn-range: 4
    anti-xray:
      enabled: false
    entity-activation-range:
      animals: 0
      monsters: 0
      misc: 0
    entity-tracking-range:
      players: 48
      animals: 0
      monsters: 0
      misc: 0
      other: 0
    tick-inactive-villagers: false
    merge-radius:
      exp: 10.0
      item: 10.0
    chunks-per-tick: 650
    clear-tick-list: false
    item-despawn-rate: 6000
    view-distance: 2
    arrow-despawn-rate: 1200
    wither-spawn-sound-radius: 0
    hanging-tick-frequency: 100
    zombie-aggressive-towards-villager: false
    nerf-spawner-mobs: false
    enable-zombie-pigmen-portal-spawns: false
    squid-spawn-range:
      min: 45.0
    growth:
      cactus-modifier: 100
      cane-modifier: 100
      melon-modifier: 100
      mushroom-modifier: 100
      pumpkin-modifier: 100
      sapling-modifier: 100
      wheat-modifier: 100
      netherwart-modifier: 100
    max-tick-time:
      tile: -1
      entity: -1
    max-entity-collisions: 1
    dragon-death-sound-radius: 0
    seed-village: 10387312
    seed-feature: 14357617
    hunger:
      jump-walk-exhaustion: 0.0
      jump-sprint-exhaustion: 0.0
      combat-exhaustion: 0.0
      regen-exhaustion: 0.0
      swim-multiplier: 0.0
      sprint-multiplier: 0.0
      other-multiplier: 0.0
`;
  }

  _buildBukkitYml() {
    return `settings:
  allow-end: false
  warn-on-overload: false
  permissions-file: permissions.yml
  update-folder: update
  plugin-profiling: false
  connection-throttle: -1
  query-plugins: false
  deprecated-verbose: false
  shutdown-message: Server closed
spawn-limits:
  monsters: 0
  animals: 0
  water-animals: 0
  ambient: 0
chunk-gc:
  period-in-ticks: 9999
  load-threshold: 0
ticks-per:
  animal-spawns: 99999
  monster-spawns: 99999
  autosave: -1
aliases: now-in-commands.yml
`;
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