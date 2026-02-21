// src/train.js
// Genetic algorithm training loop — PARALLEL INSTANCE VERSION

function wrapPi(a) {
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const args = require('minimist')(process.argv.slice(2));

// Prevent laptop sleep / lid-close sleep, set High Performance power plan
require('./keepawake');

const cfg = require('../config');
const { ServerManager } = require('./server_manager');
const { createBot } = require('./bot');
const nn = require('./neural_net');
const log = require('./logger');

const { TRAINING, BOXING } = cfg;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One ServerManager per parallel instance slot
const instances = [];
let fightCounter = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Aim ray/hitbox shaping helpers (crosshair-on-enemy hitbox)
// ─────────────────────────────────────────────────────────────────────────────

function forwardFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: -Math.sin(pitch),
    z:  Math.cos(yaw) * cp,
  };
}

function rayIntersectsAABB(rayOrigin, rayDir, boxMin, boxMax, tMax) {
  // Slab method
  let tmin = 0;
  let tmax = tMax;

  for (const ax of ['x', 'y', 'z']) {
    const o = rayOrigin[ax];
    const d = rayDir[ax];
    const min = boxMin[ax];
    const max = boxMax[ax];

    if (Math.abs(d) < 1e-8) {
      if (o < min || o > max) return false;
      continue;
    }

    const invD = 1 / d;
    let t1 = (min - o) * invD;
    let t2 = (max - o) * invD;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }

    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmax < tmin) return false;
  }
  return true;
}

function crosshairOnEnemy(botEnt, enemyEnt) {
  // Bot eye position
  const eye = botEnt.position.offset(0, 1.62, 0);
  const dir = forwardFromYawPitch(botEnt.yaw, botEnt.pitch);

  // 1.8 player hitbox approximation
  // width 0.6 (half-width 0.3), height 1.8
  const hw = 0.3;
  const min = enemyEnt.position.offset(-hw, 0, -hw);
  const max = enemyEnt.position.offset(hw, 1.8, hw);

  // Keep reward present always, but only true if ray intersects within trace distance.
  // Using 4.5 to align with the bot's attack gating distance in bot.js [8].
  const MAX_TRACE = 4.5;
  return rayIntersectsAABB(
    { x: eye.x, y: eye.y, z: eye.z },
    dir,
    { x: min.x, y: min.y, z: min.z },
    { x: max.x, y: max.y, z: max.z },
    MAX_TRACE
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log.info('Main', `═══ Training session started (pid=${process.pid}) ═══`);
  log.info('Main', `Log file: ${log.LOG_FILE}`);
  console.log(chalk.bold.cyan('\n⚔  MC 1.8 PvP AI Trainer  ⚔\n'));
  console.log(chalk.gray(`Parallel instances: ${TRAINING.PARALLEL_INSTANCES}`));
  console.log(chalk.gray(`Population size:    ${TRAINING.POP_SIZE}`));
  console.log(chalk.gray(`Active arenas:      ${TRAINING.ACTIVE_ARENAS}`));
  console.log(chalk.gray(`Weights dir:        ${TRAINING.WEIGHTS_DIR}`));

  await bootInstances();

  let generation = 0;
  let population = [];

  if (args.resume) {
    const latest = await findLatestWeights();
    if (latest) {
      const data = await fs.readJSON(latest);
      generation = data.generation || 0;
      population = data.population.map(w => nn.fromJSON(w));
      console.log(chalk.green(`Resumed from generation ${generation}`));
    }
  }

  if (population.length === 0) {
    console.log(chalk.yellow('Initializing random population...'));
    for (let i = 0; i < TRAINING.POP_SIZE; i++) population.push(nn.randomWeights());
  }

  while (true) {
    generation++;
    console.log(chalk.bold.magenta(`\n═══ Generation ${generation} ═══\n`));

    const scores = await evaluatePopulation(population);

    const ranked = population
      .map((w, i) => ({ weights: w, score: scores[i] }))
      .sort((a, b) => b.score - a.score);

    const bestScore = ranked[0].score;
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    console.log(chalk.green(`\nBest: ${bestScore.toFixed(1)}  Avg: ${avgScore.toFixed(1)}`));
    console.log(chalk.bold.white('\n  Top 5 agents this generation:'));
    ranked.slice(0, 5).forEach(({ score }, i) => {
      const medal = ['🥇','🥈','🥉','  4','  5'][i];
      console.log(`  ${medal}  Agent ${i.toString().padStart(2)} — score: ${chalk.yellow(score.toFixed(1))}`);
    });
    const worstScore = ranked[ranked.length - 1].score;
    console.log(chalk.gray(`  Worst: ${worstScore.toFixed(1)}  Spread: ${(bestScore - worstScore).toFixed(1)}\n`));

    if (generation % TRAINING.SAVE_EVERY_N_GENS === 0) {
      await saveGeneration(generation, ranked, bestScore);
    } else {
      await saveChampion(generation, ranked[0].weights, bestScore);
      console.log(chalk.gray(`  💾 Champion saved (gen ${generation}, score ${bestScore.toFixed(1)}) → ${cfg.TRAINING.WEIGHTS_DIR}`));
    }

    population = evolve(ranked, generation);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Instance management
// ─────────────────────────────────────────────────────────────────────────────

async function bootInstances() {
  console.log(chalk.gray(`Booting ${TRAINING.PARALLEL_INSTANCES} server instance(s)...`));

  const boots = [];
  for (let i = 0; i < TRAINING.PARALLEL_INSTANCES; i++) {
    const port     = cfg.SERVER_PORT + i * TRAINING.PORT_STRIDE;
    const rconPort = cfg.RCON_PORT   + i * TRAINING.PORT_STRIDE;
    const dir      = path.resolve(cfg.SERVER_DIR + (i === 0 ? '' : `_${i}`));

    const sm = new ServerManager({ port, rconPort, serverDir: dir });
    instances.push(sm);

    boots.push(
      sm.start()
        .then(() => console.log(chalk.green(`  ✓ Instance ${i} ready (port ${port})`)))
        .catch(e => { log.error(`Boot:${i}`, 'failed to start', e); throw e; })
    );
  }

  await Promise.all(boots);
  console.log(chalk.gray('All instances ready — stabilizing 3s...\n'));
  await sleep(3000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Population evaluation
// ─────────────────────────────────────────────────────────────────────────────

async function evaluatePopulation(population) {
  const scores = new Array(population.length).fill(0);
  const server = instances[0];
  const activeArenas = TRAINING.ACTIVE_ARENAS;

  const schedule = population.map((_, i) => ({
    idxA: i,
    idxB: (i + 1) % population.length,
    arenaId: i % activeArenas,
  }));

  console.log(chalk.gray(`  ${schedule.length} fights firing simultaneously across ${activeArenas} arenas\n`));

  const results = await Promise.allSettled(
    schedule.map(({ idxA, idxB, arenaId }) =>
      runFight(server, population[idxA], population[idxB], idxA, idxB, arenaId)
    )
  );

  let errCount = 0;
  for (const [i, res] of results.entries()) {
    const { idxA, idxB } = schedule[i];
    if (res.status === 'fulfilled') {
      const { score, oppScore } = res.value;
      scores[idxA] += score;
      scores[idxB] += oppScore;
      process.stdout.write(chalk.green(`[${idxA}v${idxB}:${score.toFixed(0)}-${oppScore.toFixed(0)}] `));
    } else {
      errCount++;
      log.error('EvalPop', `fight ${i} threw`, res.reason);
      process.stdout.write(chalk.red(`[${idxA}v${idxB}:ERR] `));
    }
  }
  console.log();
  if (errCount > 0) console.log(chalk.red(`  ⚠  ${errCount}/${results.length} fights failed (see log for details)`));
  else console.log(chalk.gray(`  ✓ All ${results.length} fights completed`));

  return scores;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single fight
// ─────────────────────────────────────────────────────────────────────────────

async function runFight(server, weightsA, weightsB, idxA, idxB, arenaId = 0) {
  fightCounter++;
  const fightId = fightCounter;

  const nameA = `A${fightId}`;
  const nameB = `B${fightId}`;
  const FTAG  = `FIGHT:${fightId}`;
  const tag   = chalk.cyan(`[F${fightId}|A${arenaId}]`);

  const spawnA = ServerManager.spawnA(arenaId);
  const spawnB = ServerManager.spawnB(arenaId);

  let botA = null;
  let botB = null;

  try {
    log.step(FTAG, `starting — agents ${idxA} vs ${idxB}, names ${nameA}/${nameB}`);
    console.log(`${tag} ${chalk.white(`Agent ${idxA} vs Agent ${idxB}`)} — connecting...`);

    await server.rconBatch([`kick ${nameA} reset`, `kick ${nameB} reset`]).catch(() => {});
    await sleep(100);

    // Connect both bots concurrently
    ;[botA, botB] = await Promise.all([
      connectBotWithRetry({
        host: '127.0.0.1',
        port: server.port,
        username: nameA,
        weights: weightsA,
        zoneOriginX: 0,
      }),
      connectBotWithRetry({
        host: '127.0.0.1',
        port: server.port,
        username: nameB,
        weights: weightsB,
        zoneOriginX: 0,
      }),
    ]);

    console.log(`${tag} ${chalk.green('✓ Both bots connected')}`);

    // Live hit printing (existing behavior)
    botA.on('hitLanded', total => process.stdout.write(chalk.green(`${tag}${nameA}→HIT(${total}) `)));
    botB.on('hitLanded', total => process.stdout.write(chalk.yellow(`${tag}${nameB}→HIT(${total}) `)));
    botA.on('kicked', reason => console.log(`\n${tag} ${chalk.red(`${nameA} KICKED:`)} ${JSON.stringify(reason)}`));
    botB.on('kicked', reason => console.log(`\n${tag} ${chalk.red(`${nameB} KICKED:`)} ${JSON.stringify(reason)}`));

    await sleep(500);

    // Setup: resistance + saturation + gear + tp
    await server.rconBatch([
      `gamemode 2 ${nameA}`,
      `gamemode 2 ${nameB}`,
      `effect ${nameA} resistance 9999 4 true`,
      `effect ${nameB} resistance 9999 4 true`,
      `effect ${nameA} saturation 9999 255 true`,
      `effect ${nameB} saturation 9999 255 true`,
      `tp ${nameA} ${spawnA.x} ${spawnA.y} ${spawnA.z} ${spawnA.yaw} 0`,
      `tp ${nameB} ${spawnB.x} ${spawnB.y} ${spawnB.z} ${spawnB.yaw} 0`,
      `clear ${nameA}`,
      `clear ${nameB}`,
      `give ${nameA} diamond_sword 1 0 {Unbreakable:1}`,
      `give ${nameB} diamond_sword 1 0 {Unbreakable:1}`,
      `effect ${nameA} instant_health 1 255 true`,
      `effect ${nameB} instant_health 1 255 true`,
    ]);

    console.log(
      `${tag} ${chalk.magenta('Teleported')} ` +
      `${nameA}→(${spawnA.x.toFixed(1)}, ${spawnA.y}, ${spawnA.z.toFixed(1)}) ` +
      `${nameB}→(${spawnB.x.toFixed(1)}, ${spawnB.y}, ${spawnB.z.toFixed(1)})`
    );

    await sleep(200);
    botA.startFighting();
    botB.startFighting();
    const fightStart = Date.now();
    console.log(`${tag} ${chalk.bold.yellow('⚔  FIGHT START')} (timeout: ${BOXING.HIT_TIMEOUT_MS}ms)`);

    /// ── Reward shaping ───────────────────────────────────────────────────
    // 
    // Goals:
    //   1. Penalize standing still
    //   2. Penalize looking at sky/ground (extreme pitch)
    //   3. Reward facing the opponent
    //   4. Reward closing distance when far, maintaining distance when close
    //   5. Existing: range bonus, aim bonus, hit rewards

    const SAMPLE_INTERVAL = 200;

    // Proximity shaping (peak at ideal melee range)
    const IDEAL_RANGE = 3.0;
    const RANGE_SIGMA = 1.5;
    const RANGE_BONUS = 0.6;

    // Movement shaping
    const P_STATIONARY = 0.3;         // Penalty per sample for standing still
    const MIN_MOVE_SPEED = 0.08;      // Below this = "stationary"

    // Orientation shaping  
    const P_EXTREME_PITCH = 0.2;      // Penalty for looking too far up/down
    const EXTREME_PITCH_THRESH = Math.PI * 0.35;  // ~63 degrees
    const R_FACING_OPPONENT = 0.2;    // Reward for yaw pointing toward enemy

    // Combat rewards
    const R_AIM_SAMPLE = 0.15;        // Crosshair on enemy hitbox
    const R_LEFT_CLICK = 0.05;        // Attempted attack
    const R_HIT_LANDED = 12.0;        // Successful hit
    const P_HIT_TAKEN = 6.0;          // Got hit

    // Approach/retreat shaping
    const R_CLOSING_WHEN_FAR = 0.1;   // Reward for approaching when > 6 blocks
    const FAR_THRESHOLD = 6.0;

    let rangeA = 0, rangeB = 0;
    let shapedA = 0, shapedB = 0;
    let pendingClickA = 0, pendingClickB = 0;

    // Track previous positions for velocity calculation
    let prevPosA = null, prevPosB = null;

    // Click shaping
    botA.on('leftClick', () => { shapedA += R_LEFT_CLICK; pendingClickA++; });
    botB.on('leftClick', () => { shapedB += R_LEFT_CLICK; pendingClickB++; });

    // Hit shaping
    botA.on('hitLanded', () => {
      shapedA += R_HIT_LANDED;
      if (pendingClickA > 0) { shapedA -= R_LEFT_CLICK; pendingClickA--; }
    });
    botB.on('hitLanded', () => {
      shapedB += R_HIT_LANDED;
      if (pendingClickB > 0) { shapedB -= R_LEFT_CLICK; pendingClickB--; }
    });

    botA.on('hitTaken', () => { shapedA -= P_HIT_TAKEN; });
    botB.on('hitTaken', () => { shapedB -= P_HIT_TAKEN; });

    const proximitySampler = setInterval(() => {
      try {
        const entA = botA.bot.entity;
        const entB = botB.bot.entity;
        if (!entA || !entB) return;

        const posA = entA.position;
        const posB = entB.position;

        // ─── Distance & Range Gaussian ───────────────────────────────
        const dx = posA.x - posB.x;
        const dy = posA.y - posB.y;
        const dz = posA.z - posB.z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

        const gaussianRange = (d) =>
          Math.exp(-0.5 * ((d - IDEAL_RANGE) / RANGE_SIGMA) ** 2);

        const bonus = RANGE_BONUS * gaussianRange(dist);
        rangeA += bonus;
        rangeB += bonus;

        // ─── Movement Penalty (STANDING STILL) ───────────────────────
        if (prevPosA) {
          const moveA = Math.sqrt(
            (posA.x - prevPosA.x) ** 2 + 
            (posA.z - prevPosA.z) ** 2
          );
          if (moveA < MIN_MOVE_SPEED) {
            shapedA -= P_STATIONARY;
          }
        }
        if (prevPosB) {
          const moveB = Math.sqrt(
            (posB.x - prevPosB.x) ** 2 + 
            (posB.z - prevPosB.z) ** 2
          );
          if (moveB < MIN_MOVE_SPEED) {
            shapedB -= P_STATIONARY;
          }
        }
        prevPosA = posA.clone();
        prevPosB = posB.clone();

        // ─── Extreme Pitch Penalty (LOOKING AT SKY/GROUND) ───────────
        if (Math.abs(entA.pitch) > EXTREME_PITCH_THRESH) {
          shapedA -= P_EXTREME_PITCH;
        }
        if (Math.abs(entB.pitch) > EXTREME_PITCH_THRESH) {
          shapedB -= P_EXTREME_PITCH;
        }

        // ─── Facing Opponent Reward ──────────────────────────────────
        // Calculate angle between where bot is looking and where opponent is
        const angleToOppA = Math.atan2(-(posB.x - posA.x), posB.z - posA.z);
        const angleToOppB = Math.atan2(-(posA.x - posB.x), posA.z - posB.z);
        
        const yawDiffA = Math.abs(wrapPi(entA.yaw - angleToOppA));
        const yawDiffB = Math.abs(wrapPi(entB.yaw - angleToOppB));
        
        // Reward scales: 1.0 when perfectly facing, 0.0 when looking away
        const facingBonusA = R_FACING_OPPONENT * (1 - yawDiffA / Math.PI);
        const facingBonusB = R_FACING_OPPONENT * (1 - yawDiffB / Math.PI);
        shapedA += facingBonusA;
        shapedB += facingBonusB;

        // ─── Approach Reward (when far away) ─────────────────────────
        if (dist > FAR_THRESHOLD && prevPosA && prevPosB) {
          // Did A get closer to B?
          const prevDistA = Math.sqrt(
            (prevPosA.x - posB.x) ** 2 + (prevPosA.z - posB.z) ** 2
          );
          if (dist < prevDistA) shapedA += R_CLOSING_WHEN_FAR;
          
          const prevDistB = Math.sqrt(
            (prevPosB.x - posA.x) ** 2 + (prevPosB.z - posA.z) ** 2
          );
          if (dist < prevDistB) shapedB += R_CLOSING_WHEN_FAR;
        }

        // ─── Aim Reward (crosshair on enemy hitbox) ──────────────────
        if (crosshairOnEnemy(entA, entB)) shapedA += R_AIM_SAMPLE;
        if (crosshairOnEnemy(entB, entA)) shapedB += R_AIM_SAMPLE;

      } catch {}
    }, SAMPLE_INTERVAL);
    await sleep(BOXING.HIT_TIMEOUT_MS);

    clearInterval(proximitySampler);
    botA.stopFighting();
    botB.stopFighting();

    const elapsed = ((Date.now() - fightStart) / 1000).toFixed(1);

    const hitsA = botA.getHits().myHits;
    const hitsB = botB.getHits().myHits;

    const scoreA = hitsA + rangeA + shapedA;
    const scoreB = hitsB + rangeB + shapedB;

    let resultLine;
    if (hitsA > hitsB) resultLine = chalk.green(`WINNER: Agent ${idxA} (${nameA})`);
    else if (hitsB > hitsA) resultLine = chalk.green(`WINNER: Agent ${idxB} (${nameB})`);
    else resultLine = chalk.gray('DRAW');

    const breakdown = (name, hits, range, shaped, total) =>
      chalk.gray(
        `${name}: ${hits}hits +${range.toFixed(1)}range +${shaped.toFixed(1)}shape = ${chalk.white(total.toFixed(1))}`
      );

    console.log(
      `\n${tag} ${chalk.bold('⏹  FIGHT OVER')} (${elapsed}s) — ${resultLine}\n` +
      `${tag}  ${breakdown(nameA, hitsA, rangeA, shapedA, scoreA)}\n` +
      `${tag}  ${breakdown(nameB, hitsB, rangeB, shapedB, scoreB)}`
    );

    log.step(
      FTAG,
      `done — ${nameA}:${hitsA}hits+${rangeA.toFixed(1)}range+${shapedA.toFixed(1)}shape ` +
      `${nameB}:${hitsB}hits+${rangeB.toFixed(1)}range+${shapedB.toFixed(1)}shape`
    );

    return { score: scoreA, oppScore: scoreB };
  } finally {
    if (botA) { try { botA.stopFighting(); botA.disconnect(); } catch {} }
    if (botB) { try { botB.stopFighting(); botB.disconnect(); } catch {} }

    await sleep(200);
    await server.rconBatch([`kick ${nameA} cleanup`, `kick ${nameB} cleanup`]).catch(() => {});
    await sleep(300);
    log.step(FTAG, 'cleanup done');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function connectBotWithRetry(opts, maxRetries = 3) {
  const TAG = `CONNECT:${opts.username}`;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await createBot(opts);
    } catch (err) {
      log.error(TAG, `attempt ${attempt} failed`, err);
      const retryable =
        err.message.includes('ECONNRESET') ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('timeout') ||
        err.message.includes('Timed out');
      if (attempt < maxRetries && retryable) {
        await sleep(1000 * attempt);  // 1s, 2s — faster than 3s×attempt
      } else {
        throw err;
      }
    }
  }
}

function evolve(ranked, generation) {
  const newPop = [];
  
  // ─── Adaptive Mutation ─────────────────────────────────────────
  // Start high, decay over generations to fine-tune later
  const mutRate = Math.max(
    TRAINING.MUTATION_FLOOR,
    TRAINING.MUTATION_RATE * Math.pow(TRAINING.MUTATION_DECAY, generation)
  );
  const mutStrength = TRAINING.MUTATION_STRENGTH * (0.5 + 0.5 * (mutRate / TRAINING.MUTATION_RATE));
  
  console.log(chalk.gray(`  Mutation: rate=${(mutRate*100).toFixed(1)}% strength=${mutStrength.toFixed(2)}`));

  // ─── Elitism: Keep top performers unchanged ────────────────────
  const eliteCount = Math.max(2, Math.floor(ranked.length * 0.05)); // Top 5%
  for (let i = 0; i < eliteCount; i++) {
    newPop.push(new Float32Array(ranked[i].weights));
  }

  // ─── Tournament Selection + Crossover + Mutation ───────────────
  while (newPop.length < TRAINING.POP_SIZE) {
    const parent1 = tournamentSelect(ranked, TRAINING.TOURNAMENT_SIZE || 4);
    const parent2 = tournamentSelect(ranked, TRAINING.TOURNAMENT_SIZE || 4);
    
    // 70% chance of crossover, 30% chance of just mutating one parent
    let child;
    if (Math.random() < 0.7) {
      child = crossover(parent1.weights, parent2.weights);
    } else {
      child = new Float32Array(parent1.weights);
    }
    
    newPop.push(mutate(child, mutRate, mutStrength));
  }

  return newPop;
}

function tournamentSelect(ranked, k) {
  let best = null;
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(Math.random() * ranked.length);
    if (!best || ranked[idx].score > best.score) {
      best = ranked[idx];
    }
  }
  return best;
}

function crossover(weights1, weights2) {
  const child = new Float32Array(weights1.length);
  
  // Uniform crossover with some contiguous segments
  const segmentSize = Math.floor(weights1.length / 10);
  let useParent1 = Math.random() < 0.5;
  
  for (let i = 0; i < weights1.length; i++) {
    // Switch parents occasionally (creates contiguous gene segments)
    if (i % segmentSize === 0 && Math.random() < 0.3) {
      useParent1 = !useParent1;
    }
    // Per-gene crossover chance
    if (Math.random() < 0.1) {
      useParent1 = !useParent1;
    }
    
    child[i] = useParent1 ? weights1[i] : weights2[i];
  }
  return child;
}

function mutate(weights, rate, strength) {
  const child = new Float32Array(weights);
  for (let i = 0; i < child.length; i++) {
    if (Math.random() < rate) {
      // Gaussian-ish mutation (sum of uniforms approximates normal)
      const noise = (Math.random() + Math.random() + Math.random() - 1.5) * strength;
      child[i] += noise;
      // Soft clamp to prevent weight explosion
      child[i] = Math.max(-3, Math.min(3, child[i]));
    }
  }
  return child;
}

async function saveChampion(gen, weights, bestScore) {
  await fs.ensureDir(cfg.TRAINING.WEIGHTS_DIR);
  await fs.writeJSON(
    path.join(cfg.TRAINING.WEIGHTS_DIR, 'champion.json'),
    { generation: gen, score: bestScore, weights: nn.toJSON(weights) },
    { spaces: 0 },  // compact JSON — faster write
  );
}

async function saveGeneration(gen, ranked, bestScore) {
  await fs.ensureDir(cfg.TRAINING.WEIGHTS_DIR);
  // Compact JSON (spaces:0) — full population can be ~1MB, no need for pretty-print
  await fs.writeJSON(
    path.join(cfg.TRAINING.WEIGHTS_DIR, `gen_${gen}.json`),
    { generation: gen, bestScore, population: ranked.map(r => nn.toJSON(r.weights)) },
    { spaces: 0 },
  );
  await saveChampion(gen, ranked[0].weights, bestScore);
  console.log(chalk.gray(`  Saved generation ${gen} → ${cfg.TRAINING.WEIGHTS_DIR}`));
}

async function findLatestWeights() {
  const dir = cfg.TRAINING.WEIGHTS_DIR;
  if (!await fs.pathExists(dir)) return null;
  const files = (await fs.readdir(dir))
    .filter(f => f.startsWith('gen_') && f.endsWith('.json'))
    .sort((a, b) => parseInt(b.match(/\d+/)[0]) - parseInt(a.match(/\d+/)[0]));
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

// ── Shutdown ───────────────────────────────────────────────────────────────

async function shutdown() {
  console.log(chalk.yellow('\n\nShutting down...'));
  await Promise.allSettled(instances.map(sm => sm.stop()));
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message ?? String(reason);
  log.error('UnhandledRejection', 'caught', reason instanceof Error ? reason : new Error(msg));
  if (!msg.includes('ECONNRESET') && !msg.includes('ECONNREFUSED') &&
      !msg.includes('This socket has been ended') && !msg.includes('write after end')) {
    console.error(chalk.yellow('[Unhandled Rejection]'), msg);
  }
});

process.on('uncaughtException', (err) => {
  log.error('UncaughtException', 'UNCAUGHT — exiting', err);
  console.error(chalk.red('[UncaughtException]'), err);
  process.exit(1);
});

main().catch(e => {
  console.error(chalk.red('\nFatal:'), e);
  process.exit(1);
});
