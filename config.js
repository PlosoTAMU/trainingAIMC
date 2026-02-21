// config.js - CONSERVATIVE SETTINGS FOR STABLE TRAINING

// Weights are stored on the Linux desktop (accessible from WSL).
// When running under WSL or native Linux this resolves directly.
// When running under Windows Node.js, map via the WSL filesystem mount.
const path = require('path');
const os   = require('os');
function resolveWeightsDir() {
  const desktopPath = '/home/plosouser/Desktop/pvp_weights';
  if (process.platform !== 'win32') return desktopPath;
  // Windows: access WSL filesystem via \\wsl$\...
  // Use the local fallback so Windows Node can write it without WSL mounted drive issues
  return path.join(os.homedir(), 'Desktop', 'pvp_weights');
}

module.exports = {
  // ── Minecraft server ───────────────────────────────────────────────────────
  MC_VERSION: '1.8.8',
  SERVER_JAR: './server/paper-1.8.8.jar',
  SERVER_DIR: './server/instance',
  SERVER_PORT: 25570,
  PLAY_SERVER_PORT: 25565,
  RCON_PORT: 25575,
  RCON_PASSWORD: 'pvptrainer',

  JAVA_FLAGS: [
    '-Xmx6G', '-Xms6G',
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    // Use ALL available CPU cores for GC (0 = auto-detect)
    '-XX:ParallelGCThreads=0',
    '-XX:ConcGCThreads=0',
    '-Dio.netty.transport.noNative=true', // Force NIO, avoid epoll crash
    '-Dusing.aikars.flags=true',
    '-jar',
  ],

  ARENAS: (() => {
  const Y = 102;
  const ix = -419.5, iz = 130.5;
  const offsetx = -60;  // -419.5 - (-359.5) = -60
  const offsetz1 = 60;  // 130.5 - 70.5 = 60
  const offsetz2 = 20;  // 130.5 - 110.5 = 20
  const arenas = [];
  for (let i = 0; i < 8; i++) {
    const x = ix - offsetx * i;  // subtracting negative = adding
    for (let j = 0; j < 8; j++) {
      const zA = iz - offsetz1 * j;
      const zB = zA - offsetz2;  // opponent is offsetz2 closer (20 blocks south)
      arenas.push({
        A: { x, y: Y, z: zA, yaw: 180 },  // Bot A
        B: { x, y: Y, z: zB, yaw:   0 },  // Bot B
      });
    }
  }
  return arenas;
})(),

  // Keep ZONE for any play.js / legacy references
  ZONE: {
    FLOOR_Y: 102,
  },

  // ── Boxing match rules ─────────────────────────────────────────────────────
  BOXING: {
    HITS_TO_WIN: 100,
    HIT_TIMEOUT_MS: 8000,   // 8s — more signal per fight with approach reward
    HEAL_ON_HIT: true,
    HEAL_DELAY_MS: 50,
  },

  // ── Ping simulation ────────────────────────────────────────────────────────
  // Zero ping during training — simulated latency is pure overhead with 64
  // simultaneous bots and adds no training value.
  PING: {
    MIN_MS: 0,
    MAX_MS: 0,
  },

  // ── Training (Genetic Algorithm) ──────────────────────────────────────────
  // ACTIVE_ARENAS: how many of the 64 arenas to use simultaneously.
  // Each arena = 2 bots. Tune down if server runs out of memory or kicks bots.
  // POP_SIZE must equal ACTIVE_ARENAS * 2.
  TRAINING: {
    PARALLEL_INSTANCES: 1,
    PORT_STRIDE: 10,
    ACTIVE_ARENAS: 32,               // 32 arenas × 2 bots = 64 bots at once
    POP_SIZE: 64,                    // must = ACTIVE_ARENAS * 2
    FIGHTS_PER_AGENT: 1,
    TOP_FRACTION: 0.25,              // stronger selection pressure = faster convergence
    MUTATION_RATE: 0.15,             // more exploration from fresh start
    MUTATION_STRENGTH: 0.4,
    SAVE_EVERY_N_GENS: 10,           // full population snapshot every 10 gens
    WEIGHTS_DIR: resolveWeightsDir(),
  },

  // ── Neural network ─────────────────────────────────────────────────────────
  NN: {
    INPUTS: 14,
    HIDDEN1: 32,
    HIDDEN2: 24,
    OUTPUTS: 7,   // fwd, back, left, right, jump, attack, block
    DECISION_HZ: 20,  // 20 decisions/sec — richer signal per fight
  },

  // ── Play server ────────────────────────────────────────────────────────────
  PLAY: {
    SERVER_DIR: './server/play_instance',
    CHAMPION_WEIGHTS: path.join(resolveWeightsDir(), 'champion.json'),
    BOT_USERNAME: 'PvP_AI',
    BIND_HOST: '0.0.0.0',
  },
};