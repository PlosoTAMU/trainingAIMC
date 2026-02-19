// config.js - Debian-optimized settings

module.exports = {
  // ── Minecraft server ───────────────────────────────────────────────────────
  MC_VERSION: '1.8.9',
  SERVER_JAR: './server/paper-1.8.9.jar',
  SERVER_DIR: './server/instance',
  SERVER_PORT: 25570,                    // training server (localhost only)
  PLAY_SERVER_PORT: 25565,               // play server (LAN accessible)
  RCON_PORT: 25575,
  RCON_PASSWORD: 'pvptrainer',

  // Debian-tuned Aikar flags
  // Adjust -Xmx/-Xms based on available RAM:
  //   4GB system  -> -Xmx2G -Xms2G
  //   8GB system  -> -Xmx4G -Xms4G
  //   16GB system -> -Xmx6G -Xms6G
  JAVA_FLAGS: [
    '-Xmx4G', '-Xms4G',
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
    // Debian-specific: use server JVM explicitly
    '-server',
    '-Dusing.aikars.flags=true',
    '-Dfile.encoding=UTF-8',
    '-jar',
  ],

  // ── Zone layout ────────────────────────────────────────────────────────────
  ZONE: {
    SPACING: 500,
    FLOOR_Y: 5,
    FIGHTER_SEP: 10,
  },

  // ── Boxing match rules ─────────────────────────────────────────────────────
  BOXING: {
    HITS_TO_WIN: 100,
    HIT_TIMEOUT_MS: 60_000,
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
    // Reduce PARALLEL_ZONES if you have limited resources:
    //   4GB RAM  -> 4 zones
    //   8GB RAM  -> 8 zones (default)
    //   16GB RAM -> 12-16 zones
    PARALLEL_ZONES: 8,
    POP_SIZE: 32,
    FIGHTS_PER_AGENT: 5,
    TOP_FRACTION: 0.28,
    MUTATION_RATE: 0.06,
    MUTATION_STRENGTH: 0.20,
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
    // 0.0.0.0 = accessible from any network interface
    // Change to your specific IP if you want to restrict access
    BIND_HOST: '0.0.0.0',
  },
};