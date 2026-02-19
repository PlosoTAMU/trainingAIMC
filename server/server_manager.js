// src/server_manager.js
// Owns the single PaperMC server process shared by all training zones.
// Handles startup, shutdown, RCON, game-rule setup, and zone allocation.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { Rcon } = require('rcon-client');
const cfg = require('../config');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class ServerManager {
  constructor({
    port      = cfg.SERVER_PORT,
    rconPort  = cfg.RCON_PORT,
    serverDir = cfg.SERVER_DIR,
    // Training server: '127.0.0.1' — never exposed to the network.
    // Play server:    '0.0.0.0'   — reachable from other machines on LAN.
    bindHost  = '127.0.0.1',
  } = {}) {
    this.port      = port;
    this.rconPort  = rconPort;
    this.serverDir = path.resolve(serverDir);
    this.bindHost  = bindHost;
    this.process   = null;
    this.rcon      = null;
    this.ready     = false;
    this._rconQueue = Promise.resolve();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async start() {
    await this._prepareDir();
    await this._spawnProcess();
    await this._waitForReady();
    await this._connectRcon();
    await this._applyGlobalRules();
    this.ready = true;
    console.log(`[Server] ✓ Ready on port ${this.port}`);
  }

  async stop() {
    this.ready = false;
    if (this.rcon) {
      try { await this.rcon.send('stop'); } catch {}
      await sleep(1500);
      try { this.rcon.disconnect(); } catch {}
      this.rcon = null;
    }
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }

  // ── RCON (serialised to avoid interleaving) ────────────────────────────────
  rcon(cmd) {
    this._rconQueue = this._rconQueue
      .then(() => this._sendRcon(cmd))
      .catch(() => {}); // swallow errors silently; RCON blips are non-fatal
    return this._rconQueue;
  }

  // Batch: fire all commands without waiting for responses (fast path)
  async rconBatch(cmds) {
    for (const cmd of cmds) {
      this._rconQueue = this._rconQueue
        .then(() => this._sendRcon(cmd))
        .catch(() => {});
    }
    return this._rconQueue; // await this to know when the batch finished
  }

  async _sendRcon(cmd) {
    if (!this.rcon) return;
    try {
      return await this.rcon.send(cmd);
    } catch (e) {
      // RCON occasionally drops; try to reconnect once
      try {
        await this._connectRcon();
        return await this.rcon.send(cmd);
      } catch {}
    }
  }

  // ── Server setup ───────────────────────────────────────────────────────────
  async _prepareDir() {
    await fs.ensureDir(this.serverDir);

    const jarSrc = path.resolve(cfg.SERVER_JAR);
    const jarDst = path.join(this.serverDir, 'server.jar');
    if (!await fs.pathExists(jarDst)) {
      await fs.copy(jarSrc, jarDst);
    }

    await fs.writeFile(path.join(this.serverDir, 'server.properties'),
      this._serverProperties());
    await fs.writeFile(path.join(this.serverDir, 'eula.txt'), 'eula=true\n');

    // Write Paper-specific config for maximum performance
    await this._writePaperConfig();
    await this._writeSpigotConfig();
    await this._writeBukkitConfig();
  }

  _serverProperties() {
    const maxPlayers = cfg.TRAINING.PARALLEL_ZONES * 2 + 4; // zones×2 + headroom
    return [
      `server-port=${this.port}`,
      // server-ip blank = all interfaces; explicit value locks to one interface.
      // Training server uses 127.0.0.1 (loopback). Play server uses 0.0.0.0.
      `server-ip=${this.bindHost === '0.0.0.0' ? '' : this.bindHost}`,
      `enable-rcon=true`,
      `rcon.port=${this.rconPort}`,
      `rcon.password=${cfg.RCON_PASSWORD}`,
      `online-mode=false`,
      `max-players=${maxPlayers}`,
      `view-distance=2`,             // absolute minimum — bots don't need to see far
      `pvp=true`,
      `difficulty=peaceful`,         // no hostile mobs, no hunger
      `gamemode=2`,                  // adventure — cannot break/place blocks
      `spawn-npcs=false`,
      `spawn-animals=false`,
      `spawn-monsters=false`,
      `generate-structures=false`,
      `level-type=FLAT`,
      `generator-settings=3;minecraft:bedrock,1;1;`,
      `level-name=world`,
      `motd=PvP Training Server`,
      `network-compression-threshold=256`,
      `use-native-transport=true`,
      `enable-command-block=true`,
      `allow-flight=true`,           // bots jump a lot; prevent kick
      `max-tick-time=-1`,            // disable watchdog — training load is intentional
    ].join('\n');
  }

  // paper.yml — the big one for performance
  async _writePaperConfig() {
    const config = `
world-settings:
  default:
    optimize-explosions: true
    game-mechanics:
      disable-chest-cat-detection: true
      disable-player-crits: false      # crits must work for pvp
      disable-sprint-interruption-on-attack: false
    max-auto-save-chunks-per-tick: 0   # do NOT save chunks during training
    prevent-moving-into-unloaded-chunks: false
    entity-per-chunk-save-limit:
      experience_orb: 0
      snowball: 0
      ender_pearl: 0
      arrow: 0
    chunks:
      auto-save-interval: -1           # disable chunk auto-save entirely
settings:
  async-chunks:
    enable: true
    threads: -1
  chunk-tasks-per-tick: 1000
  incoming-packet-spam-threshold: 9999
  save-player-data: false              # no disk writes for player data
  use-alternative-luck-formula: false
  console:
    enable-brigadier-highlighting: false
    enable-brigadier-completions: false
  watchdog:
    early-warning-every: -1
    early-warning-delay: -1
`.trimStart();
    await fs.ensureDir(path.join(this.serverDir, 'config'));
    await fs.writeFile(path.join(this.serverDir, 'paper.yml'), config);
  }

  async _writeSpigotConfig() {
    const config = `
settings:
  save-user-cache-on-stop-only: true
  moved-wrongly-threshold: 100.0      # relax anti-cheat; bots move weird
  moved-too-quickly-multiplier: 100.0
world-settings:
  default:
    mob-spawn-range: 0
    entity-activation-range:
      animals: 0
      monsters: 0
      misc: 0
    entity-tracking-range:
      players: 32
      animals: 0
      monsters: 0
      misc: 0
      other: 0
    tick-inactive-villagers: false
    merge-radius:
      exp: 10.0
      item: 10.0
    max-tick-time:
      tile: 1000
      entity: 1000
`.trimStart();
    await fs.writeFile(path.join(this.serverDir, 'spigot.yml'), config);
  }

  async _writeBukkitConfig() {
    const config = `
settings:
  allow-end: false
  warn-on-overload: false
  plugin-profiling: false
  connection-throttle: -1             # don't throttle rapid reconnects
  query.plugins: false
spawn-limits:
  monsters: 0
  animals: 0
  water-animals: 0
  ambient: 0
chunk-gc:
  period-in-ticks: 9999
ticks-per:
  animal-spawns: 99999
  monster-spawns: 99999
  autosave: -1                        # handled per-world above
`.trimStart();
    await fs.writeFile(path.join(this.serverDir, 'bukkit.yml'), config);
  }

  async _spawnProcess() {
    const args = [...cfg.JAVA_FLAGS, 'server.jar', 'nogui'];
    this.process = spawn('java', args, {
      cwd: this.serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._stdout = '';
    this.process.stdout.on('data', d => { this._stdout += d.toString(); });
    this.process.stderr.on('data', () => {}); // suppress

    this.process.on('exit', code => {
      if (this.ready) {
        console.error(`[Server] Process exited unexpectedly (code ${code})`);
        this.ready = false;
      }
    });
  }

  async _waitForReady() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Server start timeout (90s)')), 90_000);

      const check = setInterval(() => {
        if (this._stdout.includes('Done') || this._stdout.includes('For help')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve();
        }
      }, 250);

      this.process.on('exit', () => {
        clearTimeout(timeout);
        clearInterval(check);
        reject(new Error('Server exited during startup'));
      });
    });
  }

  async _connectRcon() {
    await sleep(800);
    this.rcon = new Rcon({
      host: '127.0.0.1',
      port: this.rconPort,
      password: cfg.RCON_PASSWORD,
      timeout: 5000,
    });
    await this.rcon.connect();
  }

  async _applyGlobalRules() {
    // These apply once at server start
    await this.rconBatch([
      'gamerule doDaylightCycle false',
      'gamerule doWeatherCycle false',
      'gamerule naturalRegeneration false',  // we manage healing manually
      'gamerule doMobSpawning false',
      'gamerule doFireTick false',
      'gamerule keepInventory true',
      'gamerule logAdminCommands false',
      'gamerule sendCommandFeedback false',
      'gamerule commandBlockOutput false',
      'gamerule mobGriefing false',
      'gamerule doEntityDrops false',        // no item drops
      'gamerule showDeathMessages false',
      'time set 6000',
    ]);
  }

  // ── Zone coordinate helpers (static) ──────────────────────────────────────
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
