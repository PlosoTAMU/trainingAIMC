// src/server_manager.js

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

  rcon(cmd) {
    this._rconQueue = this._rconQueue
      .then(() => this._sendRcon(cmd))
      .catch(() => {});
    return this._rconQueue;
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
    if (!this.rcon) return;
    try {
      return await this.rcon.send(cmd);
    } catch (e) {
      try {
        await this._connectRcon();
        return await this.rcon.send(cmd);
      } catch {}
    }
  }

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

    await this._writeSpigotConfig();
    await this._writeBukkitConfig();
  }

  _serverProperties() {
    const maxPlayers = 10;
    return [
      `server-port=${this.port}`,
      `server-ip=${this.bindHost === '0.0.0.0' ? '' : this.bindHost}`,
      `enable-rcon=true`,
      `rcon.port=${this.rconPort}`,
      `rcon.password=${cfg.RCON_PASSWORD}`,
      `online-mode=false`,
      `max-players=${maxPlayers}`,
      `view-distance=2`,
      `pvp=true`,
      `difficulty=peaceful`,
      `gamemode=2`,
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
      `connection-throttle=0`,
    ].join('\n');
  }

  async _writeSpigotConfig() {
    const config = `
settings:
  save-user-cache-on-stop-only: true
  moved-wrongly-threshold: 100.0
  moved-too-quickly-multiplier: 100.0
  connection-throttle: -1
  timeout-time: 300
  player-shuffle: 0
world-settings:
  default:
    mob-spawn-range: 0
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
  connection-throttle: -1
  query-plugins: false
  shutdown-message: Server closed
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
  autosave: -1
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
    this._stderr = '';

    this.process.stdout.on('data', d => {
      this._stdout += d.toString();
      // Uncomment for debugging:
      // console.log('[Server]', d.toString().trim());
    });

    this.process.stderr.on('data', d => {
      this._stderr += d.toString();
      // Uncomment for debugging:
      // console.error('[Server ERR]', d.toString().trim());
    });

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
    await sleep(1000);
    this.rcon = new Rcon({
      host: '127.0.0.1',
      port: this.rconPort,
      password: cfg.RCON_PASSWORD,
      timeout: 10000,
    });
    await this.rcon.connect();
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