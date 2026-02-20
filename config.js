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
    '-Xmx1G', '-Xms1G',              // Conservative memory
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
    '-Dio.netty.eventLoopThreads=2',  // Limit Netty threads
    '-Dio.netty.transport.noNative=true', // Force NIO, avoid epoll crash
    '-Dusing.aikars.flags=true',
    '-jar',
  ],

  // ── Zone layout ────────────────────────────────────────────────────────────
  ZONE: {
    SPACING: 500,
    FLOOR_Y: 4,
    FIGHTER_SEP: 10,
  },

  // ── Boxing match rules ─────────────────────────────────────────────────────
  BOXING: {
    HITS_TO_WIN: 100,
    HIT_TIMEOUT_MS: 15000,           // 15 seconds per fight (reduced)
    HEAL_ON_HIT: true,
    HEAL_DELAY_MS: 50,
  },

  // ── Ping simulation ────────────────────────────────────────────────────────
  PING: {
    MIN_MS: 10,
    MAX_MS: 150,
  },

  // ── Training (Genetic Algorithm) ──────────────────────────────────────────
  TRAINING: {
    PARALLEL_ZONES: 1,               // MUST be 1 - sequential only
    POP_SIZE: 4,                     // Start with 4 agents
    FIGHTS_PER_AGENT: 1,
    TOP_FRACTION: 0.5,
    MUTATION_RATE: 0.1,
    MUTATION_STRENGTH: 0.3,
    SAVE_EVERY_N_GENS: 5,
    WEIGHTS_DIR: './weights',
  },

  // ── Neural network ─────────────────────────────────────────────────────────
  NN: {
    INPUTS: 14,
    HIDDEN1: 32,
    HIDDEN2: 24,
    OUTPUTS: 6,
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