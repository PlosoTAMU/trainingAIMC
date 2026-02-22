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

// Hall of Fame: keep best agents from previous generations to prevent collapse
const hallOfFame = [];
const MAX_HALL_SIZE = 5;

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
  console.log(chalk.bold.cyan('\n⚔  MC 1.8 PvP AI Trainer (ANTI-SPIN EDITION)  ⚔\n'));
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
      
      // Restore hall of fame if available
      if (data.hallOfFame) {
        hallOfFame.push(...data.hallOfFame.slice(0, MAX_HALL_SIZE));
      }
      
      console.log(chalk.green(`Resumed from generation ${generation}`));
      if (hallOfFame.length > 0) {
        console.log(chalk.gray(`  Hall of Fame: ${hallOfFame.length} champions loaded`));
      }
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
    const worstScore = ranked[ranked.length - 1].score;

    // Update hall of fame
    updateHallOfFame(ranked[0].weights, bestScore);

    console.log(chalk.green(`\nBest: ${bestScore.toFixed(1)}  Avg: ${avgScore.toFixed(1)}  Worst: ${worstScore.toFixed(1)}`));
    console.log(chalk.gray(`  Score spread: ${(bestScore - worstScore).toFixed(1)}`));
    console.log(chalk.bold.white('\n  Top 5 agents this generation:'));
    ranked.slice(0, 5).forEach(({ score }, i) => {
      const medal = ['🥇','🥈','🥉','  4','  5'][i];
      console.log(`  ${medal}  Agent ${i.toString().padStart(2)} — score: ${chalk.yellow(score.toFixed(1))}`);
    });

    if (generation % TRAINING.SAVE_EVERY_N_GENS === 0) {
      await saveGeneration(generation, ranked, bestScore);
    } else {
      await savePopulation(generation, ranked, bestScore);
      console.log(chalk.gray(`  💾 Population saved (gen ${generation}, best ${bestScore.toFixed(1)})`));
    }

    population = evolve(ranked, generation);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hall of Fame Management
// ─────────────────────────────────────────────────────────────────────────────

function updateHallOfFame(weights, score) {
  // Add to hall if it's better than worst member OR hall isn't full
  if (hallOfFame.length < MAX_HALL_SIZE) {
    hallOfFame.push({ weights: new Float32Array(weights), score });
    hallOfFame.sort((a, b) => b.score - a.score);
  } else if (score > hallOfFame[hallOfFame.length - 1].score) {
    hallOfFame[hallOfFame.length - 1] = { weights: new Float32Array(weights), score };
    hallOfFame.sort((a, b) => b.score - a.score);
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
// Single fight (REBALANCED REWARDS)
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

    // ══════════════════════════════════════════════════════════════════════
    // REWARD SHAPING (REBALANCED TO PREVENT SPIN/JUMP EXPLOITATION)
    // ══════════════════════════════════════════════════════════════════════

    const SAMPLE_INTERVAL = 200;

    // PRIMARY REWARDS (what we actually want)
    const R_HIT_LANDED = 50.0;          // MUCH higher - this is the goal
    const P_HIT_TAKEN = 25.0;           // Significant penalty

    // ANTI-DEGENERATE PENALTIES
    const P_CUMULATIVE_SPIN = 0.02;     // Per radian of total rotation
    const P_JUMP_WHILE_FAR = 1.5;       // Jumping when opponent > 5 blocks away
    const P_ATTACK_WHILE_NOT_FACING = 2.0; // Clicked but wasn't aiming
    const P_STATIONARY = 0.8;           // Not moving horizontally
    const P_EXTREME_PITCH = 1.0;        // Looking at sky/ground

    // SHAPING (small guidance, not exploitable)
    const R_AIM_AND_ATTACK = 3.0;       // Clicked WHILE crosshair on enemy
    const R_APPROACH_WHEN_FAR = 0.1;    // Small reward for closing distance when far
    const R_MAINTAIN_COMBAT_RANGE = 0.2; // In [2.5, 4.0] range

    // THRESHOLDS
    const COMBAT_RANGE_MIN = 2.5;
    const COMBAT_RANGE_MAX = 4.0;
    const FAR_THRESHOLD = 6.0;
    const EXTREME_PITCH_THRESH = Math.PI * 0.3;
    const MIN_MOVE_SPEED = 0.08;

    let shapedA = 0, shapedB = 0;

    // Track cumulative rotation (anti-spin)
    let totalYawRotationA = 0, totalYawRotationB = 0;
    let lastYawA = null, lastYawB = null;

    // Track attack quality
    let attacksWhileAimingA = 0, attacksWhileAimingB = 0;
    let totalAttacksA = 0, totalAttacksB = 0;

    // Track previous state for movement detection
    let prevPosA = null, prevPosB = null;

    // ─── Click handlers - track if we were aiming when we clicked ──────
    botA.on('leftClick', () => {
      totalAttacksA++;
      const entA = botA.bot.entity;
      const entB = botB.bot.entity;
      if (entA && entB && crosshairOnEnemy(entA, entB)) {
        attacksWhileAimingA++;
        shapedA += R_AIM_AND_ATTACK;  // Reward: clicked while aiming!
      } else {
        shapedA -= P_ATTACK_WHILE_NOT_FACING;  // Penalty: wasted click
      }
    });

    botB.on('leftClick', () => {
      totalAttacksB++;
      const entA = botA.bot.entity;
      const entB = botB.bot.entity;
      if (entA && entB && crosshairOnEnemy(entB, entA)) {
        attacksWhileAimingB++;
        shapedB += R_AIM_AND_ATTACK;
      } else {
        shapedB -= P_ATTACK_WHILE_NOT_FACING;
      }
    });

    // ─── Hit rewards (core combat) ──────────────────────────────────────
    botA.on('hitLanded', (total) => {
      shapedA += R_HIT_LANDED;
      process.stdout.write(chalk.green(`${tag}${nameA}→HIT(${total}) `));
    });
    botB.on('hitLanded', (total) => {
      shapedB += R_HIT_LANDED;
      process.stdout.write(chalk.yellow(`${tag}${nameB}→HIT(${total}) `));
    });
    botA.on('hitTaken', () => { shapedA -= P_HIT_TAKEN; });
    botB.on('hitTaken', () => { shapedB -= P_HIT_TAKEN; });

    // ─── Kicked handlers ────────────────────────────────────────────────
    botA.on('kicked', reason => console.log(`\n${tag} ${chalk.red(`${nameA} KICKED:`)} ${JSON.stringify(reason)}`));
    botB.on('kicked', reason => console.log(`\n${tag} ${chalk.red(`${nameB} KICKED:`)} ${JSON.stringify(reason)}`));

    // ─── Proximity sampler (shaping rewards) ────────────────────────────
    const proximitySampler = setInterval(() => {
      try {
        const entA = botA.bot.entity;
        const entB = botB.bot.entity;
        if (!entA || !entB) return;

        const posA = entA.position;
        const posB = entB.position;
        const dx = posA.x - posB.x;
        const dz = posA.z - posB.z;
        const dist = Math.sqrt(dx*dx + dz*dz);  // Horizontal distance

        // ─── CUMULATIVE SPIN PENALTY ─────────────────────────────────
        // Track total yaw change - spinning racks up huge penalties
        if (lastYawA !== null) {
          const yawDelta = Math.abs(wrapPi(entA.yaw - lastYawA));
          totalYawRotationA += yawDelta;
        }
        if (lastYawB !== null) {
          const yawDelta = Math.abs(wrapPi(entB.yaw - lastYawB));
          totalYawRotationB += yawDelta;
        }
        lastYawA = entA.yaw;
        lastYawB = entB.yaw;

        // ─── JUMPING WHILE FAR PENALTY ───────────────────────────────
        // Jumping only makes sense in close combat
        if (!entA.onGround && dist > FAR_THRESHOLD) {
          shapedA -= P_JUMP_WHILE_FAR;
        }
        if (!entB.onGround && dist > FAR_THRESHOLD) {
          shapedB -= P_JUMP_WHILE_FAR;
        }

        // ─── COMBAT RANGE REWARD ─────────────────────────────────────
        // Small reward for being in effective PvP range
        if (dist >= COMBAT_RANGE_MIN && dist <= COMBAT_RANGE_MAX) {
          shapedA += R_MAINTAIN_COMBAT_RANGE;
          shapedB += R_MAINTAIN_COMBAT_RANGE;
        }

        // ─── APPROACH REWARD (only when far) ─────────────────────────
        if (dist > FAR_THRESHOLD && prevPosA && prevPosB) {
          const prevDistA = Math.sqrt(
            (prevPosA.x - posB.x) ** 2 + (prevPosA.z - posB.z) ** 2
          );
          const prevDistB = Math.sqrt(
            (prevPosB.x - posA.x) ** 2 + (prevPosB.z - posA.z) ** 2
          );
          
          // Only reward if actually closing distance significantly
          if (dist < prevDistA - 0.1) shapedA += R_APPROACH_WHEN_FAR;
          if (dist < prevDistB - 0.1) shapedB += R_APPROACH_WHEN_FAR;
        }

        // ─── STATIONARY PENALTY ──────────────────────────────────────
        if (prevPosA) {
          const moveA = Math.sqrt((posA.x - prevPosA.x)**2 + (posA.z - prevPosA.z)**2);
          if (moveA < MIN_MOVE_SPEED) shapedA -= P_STATIONARY;
        }
        if (prevPosB) {
          const moveB = Math.sqrt((posB.x - prevPosB.x)**2 + (posB.z - prevPosB.z)**2);
          if (moveB < MIN_MOVE_SPEED) shapedB -= P_STATIONARY;
        }

        // ─── EXTREME PITCH PENALTY ───────────────────────────────────
        if (Math.abs(entA.pitch) > EXTREME_PITCH_THRESH) shapedA -= P_EXTREME_PITCH;
        if (Math.abs(entB.pitch) > EXTREME_PITCH_THRESH) shapedB -= P_EXTREME_PITCH;

        prevPosA = posA.clone();
        prevPosB = posB.clone();
      } catch {}
    }, SAMPLE_INTERVAL);

    // ─── Wait for fight to complete ──────────────────────────────────────
    await sleep(BOXING.HIT_TIMEOUT_MS);
    clearInterval(proximitySampler);

    // ─── Apply cumulative spin penalty ───────────────────────────────────
    // This is the KEY anti-spin mechanism
    // A full rotation = 2π radians (~6.28)
    // Spinning constantly for 15s at 1 rev/sec = ~94 radians
    // That would be 94 * 0.02 = 1.88 penalty
    shapedA -= P_CUMULATIVE_SPIN * totalYawRotationA;
    shapedB -= P_CUMULATIVE_SPIN * totalYawRotationB;

    // ─── Stop fighting and calculate results ─────────────────────────────
    botA.stopFighting();
    botB.stopFighting();

    const elapsed = ((Date.now() - fightStart) / 1000).toFixed(1);

    const hitsA = botA.getHits().myHits;
    const hitsB = botB.getHits().myHits;

    const scoreA = (hitsA * R_HIT_LANDED) + shapedA;
    const scoreB = (hitsB * R_HIT_LANDED) + shapedB;

    // Log attack efficiency for debugging
    const effA = totalAttacksA > 0 ? (attacksWhileAimingA / totalAttacksA * 100).toFixed(0) : 0;
    const effB = totalAttacksB > 0 ? (attacksWhileAimingB / totalAttacksB * 100).toFixed(0) : 0;

    let resultLine;
    if (hitsA > hitsB) resultLine = chalk.green(`WINNER: Agent ${idxA} (${nameA})`);
    else if (hitsB > hitsA) resultLine = chalk.green(`WINNER: Agent ${idxB} (${nameB})`);
    else resultLine = chalk.gray('DRAW');

    const breakdown = (name, hits, shaped, total, rot, eff) =>
      chalk.gray(
        `${name}: ${hits}hits +${shaped.toFixed(1)}shape -${(P_CUMULATIVE_SPIN * rot).toFixed(1)}spin = ` +
        chalk.white(total.toFixed(1)) + chalk.dim(` (aim:${eff}%, rot:${rot.toFixed(1)}rad)`)
      );

    console.log(
      `\n${tag} ${chalk.bold('⏹  FIGHT OVER')} (${elapsed}s) — ${resultLine}\n` +
      `${tag}  ${breakdown(nameA, hitsA, shapedA + (P_CUMULATIVE_SPIN * totalYawRotationA), scoreA, totalYawRotationA, effA)}\n` +
      `${tag}  ${breakdown(nameB, hitsB, shapedB + (P_CUMULATIVE_SPIN * totalYawRotationB), scoreB, totalYawRotationB, effB)}`
    );

    log.step(
      FTAG,
      `done — ${nameA}:${hitsA}hits+${shapedA.toFixed(1)}shape-${(P_CUMULATIVE_SPIN*totalYawRotationA).toFixed(1)}spin=${scoreA.toFixed(1)} ` +
      `${nameB}:${hitsB}hits+${shapedB.toFixed(1)}shape-${(P_CUMULATIVE_SPIN*totalYawRotationB).toFixed(1)}spin=${scoreB.toFixed(1)}`
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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
        await sleep(1000 * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Genetic Algorithm (IMPROVED DIVERSITY)
// ─────────────────────────────────────────────────────────────────────────────

function evolve(ranked, generation) {
  const newPop = [];
  
  // ─── Adaptive Mutation (starts high, decays over time) ─────────
  const baseMutRate = TRAINING.MUTATION_RATE || 0.15;
  const baseMutStr = TRAINING.MUTATION_STRENGTH || 0.5;
  
  const decay = Math.pow(0.997, generation);
  const mutRate = Math.max(0.08, baseMutRate * (0.6 + 0.4 * decay));
  const mutStrength = Math.max(0.2, baseMutStr * (0.5 + 0.5 * decay));
  
  console.log(chalk.gray(`  Mutation: rate=${(mutRate*100).toFixed(1)}% strength=${mutStrength.toFixed(2)}`));

  // ─── Elitism: Keep top 3 unchanged ─────────────────────────────
  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    newPop.push(new Float32Array(ranked[i].weights));
  }

  // ─── Diversity Injection: 10% random individuals ───────────────
  // This prevents population collapse into local optima
  const numRandom = Math.floor(TRAINING.POP_SIZE * 0.10);
  for (let i = 0; i < numRandom; i++) {
    newPop.push(nn.randomWeights());
  }

  // ─── Hall of Fame: Keep historical champions ───────────────────
  if (hallOfFame.length > 0 && Math.random() < 0.1) {
    const historic = hallOfFame[Math.floor(Math.random() * hallOfFame.length)];
    newPop.push(new Float32Array(historic.weights));
  }

  // ─── Tournament Selection + Crossover ──────────────────────────
  while (newPop.length < TRAINING.POP_SIZE) {
    const parent1 = tournamentSelect(ranked, 3);
    const parent2 = tournamentSelectDiverse(ranked, 3, parent1);
    
    let child;
    if (Math.random() < 0.75 && parent1 !== parent2) {
      child = uniformCrossover(parent1.weights, parent2.weights);
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

// Diverse tournament: pick someone different from parent1
function tournamentSelectDiverse(ranked, k, avoid) {
  let best = null;
  for (let i = 0; i < k * 2; i++) {  // Try more candidates
    const idx = Math.floor(Math.random() * ranked.length);
    const candidate = ranked[idx];
    if (candidate === avoid) continue;
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }
  return best || ranked[Math.floor(Math.random() * ranked.length)];
}

// Uniform crossover: each gene picked randomly from either parent
function uniformCrossover(w1, w2) {
  const child = new Float32Array(w1.length);
  for (let i = 0; i < w1.length; i++) {
    child[i] = Math.random() < 0.5 ? w1[i] : w2[i];
  }
  return child;
}

function mutate(weights, rate, strength) {
  const child = new Float32Array(weights);
  for (let i = 0; i < child.length; i++) {
    if (Math.random() < rate) {
      // Gaussian-ish noise (sum of uniforms approximates normal)
      const noise = (Math.random() + Math.random() + Math.random() - 1.5) * strength;
      child[i] += noise;
      child[i] = Math.max(-3, Math.min(3, child[i])); // Soft clamp
    }
  }
  return child;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

async function savePopulation(gen, ranked, bestScore) {
  await fs.ensureDir(cfg.TRAINING.WEIGHTS_DIR);
  
  // Always save full population as "latest.json" (overwritten each gen)
  await fs.writeJSON(
    path.join(cfg.TRAINING.WEIGHTS_DIR, 'latest.json'),
    { 
      generation: gen, 
      bestScore, 
      population: ranked.map(r => nn.toJSON(r.weights)),
      hallOfFame: hallOfFame.map(h => nn.toJSON(h.weights)),
    },
    { spaces: 0 },
  );
  
  // Save champion separately
  await fs.writeJSON(
    path.join(cfg.TRAINING.WEIGHTS_DIR, 'champion.json'),
    { generation: gen, score: bestScore, weights: nn.toJSON(ranked[0].weights) },
    { spaces: 0 },
  );
}

async function saveGeneration(gen, ranked, bestScore) {
  await fs.ensureDir(cfg.TRAINING.WEIGHTS_DIR);
  
  // Snapshot at milestone generations
  await fs.writeJSON(
    path.join(cfg.TRAINING.WEIGHTS_DIR, `gen_${gen}.json`),
    { 
      generation: gen, 
      bestScore, 
      population: ranked.map(r => nn.toJSON(r.weights)),
      hallOfFame: hallOfFame.map(h => nn.toJSON(h.weights)),
    },
    { spaces: 0 },
  );
  
  // Always save latest too
  await savePopulation(gen, ranked, bestScore);
  
  console.log(chalk.gray(`  💾 Full generation snapshot saved → gen_${gen}.json`));
}

async function findLatestWeights() {
  const dir = cfg.TRAINING.WEIGHTS_DIR;
  if (!await fs.pathExists(dir)) return null;
  
  // First try latest.json (saved every generation)
  const latestPath = path.join(dir, 'latest.json');
  if (await fs.pathExists(latestPath)) {
    return latestPath;
  }
  
  // Fall back to most recent gen_N.json
  const files = (await fs.readdir(dir))
    .filter(f => f.startsWith('gen_') && f.endsWith('.json'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || '0');
      const numB = parseInt(b.match(/\d+/)?.[0] || '0');
      return numB - numA;
    });
  
  if (files.length > 0) {
    return path.join(dir, files[0]);
  }
  
  return null;
}

// ─── Shutdown ───────────────────────────────────────────────────────────────

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