// config.js - CONSERVATIVE SETTINGS FOR STABLE TRAINING

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
    '-Xmx4G', '-Xms4G',              // More heap for 128 simultaneous bots
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
    '-Dio.netty.eventLoopThreads=4',  // More threads for many simultaneous connections
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
    HIT_TIMEOUT_MS: 5000,   // 5s per fight — short rounds, fast iteration
    HEAL_ON_HIT: true,
    HEAL_DELAY_MS: 50,
  },

  // ── Ping simulation ────────────────────────────────────────────────────────
  PING: {
    MIN_MS: 10,
    MAX_MS: 150,
  },

  // ── Training (Genetic Algorithm) ──────────────────────────────────────────
  // Single server hosts all 64 arenas simultaneously.
  // POP_SIZE=128 → 64 fights fire at once (one per arena), no batching needed.
  TRAINING: {
    PARALLEL_INSTANCES: 1,           // one server — all arenas run on it
    PORT_STRIDE: 10,
    POP_SIZE: 128,                   // 64 pairs fill every arena simultaneously
    FIGHTS_PER_AGENT: 1,
    TOP_FRACTION: 0.5,
    MUTATION_RATE: 0.1,
    MUTATION_STRENGTH: 0.3,
    SAVE_EVERY_N_GENS: 10,
    WEIGHTS_DIR: './weights',
  },

  // ── Neural network ─────────────────────────────────────────────────────────
  NN: {
    INPUTS: 14,
    HIDDEN1: 32,
    HIDDEN2: 24,
    OUTPUTS: 7,   // fwd, back, left, right, jump, attack, block
    DECISION_HZ: 10,
  },

  // ── Play server ────────────────────────────────────────────────────────────
  PLAY: {
    SERVER_DIR: './server/play_instance',
    CHAMPION_WEIGHTS: './weights/champion.json',
    BOT_USERNAME: 'PvP_AI',
    BIND_HOST: '0.0.0.0',
  },
};