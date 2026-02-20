// config.js

module.exports = {
  // ── Minecraft server ───────────────────────────────────────────────────────
  MC_VERSION: '1.8.8',
  SERVER_JAR: './server/spigot-1.8.8.jar',
  SERVER_DIR: './server/instance',
  SERVER_PORT: 25570,
  PLAY_SERVER_PORT: 25565,
  RCON_PORT: 25575,
  RCON_PASSWORD: 'pvptrainer',

  JAVA_FLAGS: [
    '-Xmx2G', '-Xms2G',
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
    '-Dusing.aikars.flags=true',
    '-jar',
  ],

  ZONE: {
    SPACING: 500,
    FLOOR_Y: 5,
    FIGHTER_SEP: 10,
  },

  BOXING: {
    HITS_TO_WIN: 100,
    HIT_TIMEOUT_MS: 60_000,
    HEAL_ON_HIT: true,
    HEAL_DELAY_MS: 50,
  },

  PING: {
    MIN_MS: 10,
    MAX_MS: 150,
  },

  TRAINING: {
    PARALLEL_ZONES: 4,
    POP_SIZE: 32,
    FIGHTS_PER_AGENT: 5,
    TOP_FRACTION: 0.28,
    MUTATION_RATE: 0.06,
    MUTATION_STRENGTH: 0.20,
    SAVE_EVERY_N_GENS: 5,
    WEIGHTS_DIR: './weights',
  },

  NN: {
    INPUTS: 14,
    HIDDEN1: 32,
    HIDDEN2: 24,
    OUTPUTS: 6,
    DECISION_HZ: 10,
  },

  PLAY: {
    SERVER_DIR: './server/play_instance',
    CHAMPION_WEIGHTS: './weights/champion.json',
    BOT_USERNAME: 'PvP_AI',
    BIND_HOST: '0.0.0.0',
  },
};