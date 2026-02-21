// src/train.js
// Genetic algorithm training loop — PARALLEL INSTANCE VERSION

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const args = require('minimist')(process.argv.slice(2));

const cfg = require('../config');
const { ServerManager } = require('./server_manager');
const { createBot } = require('./bot');
const nn = require('./neural_net');
const log = require('./logger');

const { TRAINING, BOXING } = cfg;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One ServerManager per parallel instance slot
const instances = [];       // instances[i] = ServerManager
let fightCounter = 0;

// ── Startup ────────────────────────────────────────────────────────────────

async function main() {
  log.info('Main', `═══ Training session started (pid=${process.pid}) ═══`);
  log.info('Main', `Log file: ${log.LOG_FILE}`);
  console.log(chalk.bold.cyan('\n⚔  MC 1.8 PvP AI Trainer  ⚔\n'));
  console.log(chalk.gray(`Parallel instances: ${TRAINING.PARALLEL_INSTANCES}`));
  console.log(chalk.gray(`Population size:    ${TRAINING.POP_SIZE}`));

  // Boot all server instances in parallel
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
    for (let i = 0; i < TRAINING.POP_SIZE; i++) {
      population.push(nn.randomWeights());
    }
  }

  // Main training loop
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

    if (generation % TRAINING.SAVE_EVERY_N_GENS === 0) {
      await saveGeneration(generation, ranked, bestScore);
    }

    population = evolve(ranked);
  }
}

// ── Instance management ────────────────────────────────────────────────────

async function bootInstances() {
  console.log(chalk.gray(`Booting ${TRAINING.PARALLEL_INSTANCES} server instance(s)...`));

  const boots = [];
  for (let i = 0; i < TRAINING.PARALLEL_INSTANCES; i++) {
    const port     = cfg.SERVER_PORT      + i * TRAINING.PORT_STRIDE;
    const rconPort = cfg.RCON_PORT        + i * TRAINING.PORT_STRIDE;
    const dir      = path.resolve(cfg.SERVER_DIR + (i === 0 ? '' : `_${i}`));

    const sm = new ServerManager({ port, rconPort, serverDir: dir });
    instances.push(sm);

    boots.push(
      sm.start()
        .then(() => console.log(chalk.green(`  ✓ Instance ${i} ready (port ${port})`)))
        .catch(e  => { log.error(`Boot:${i}`, 'failed to start', e); throw e; })
    );
  }

  await Promise.all(boots);
  console.log(chalk.gray('All instances ready — stabilizing 5s...\n'));
  await sleep(5000);
}

// ── Population evaluation ──────────────────────────────────────────────────

async function evaluatePopulation(population) {
  const scores = new Array(population.length).fill(0);
  const N = TRAINING.PARALLEL_INSTANCES;

  // Build the fight schedule: agent i vs agent (i+1)%n
  const schedule = population.map((_, i) => ({
    idxA: i,
    idxB: (i + 1) % population.length,
  }));

  console.log(chalk.gray(`  ${schedule.length} fights, ${N} at a time\n`));

  // Process in batches of N (one fight per instance slot)
  for (let batchStart = 0; batchStart < schedule.length; batchStart += N) {
    const batch = schedule.slice(batchStart, batchStart + N);

    const results = await Promise.allSettled(
      batch.map(({ idxA, idxB }, slot) => {
        // Each fight in a batch uses a different arena to keep bots separated.
        // Cycle through all 64 arenas across batches.
        const arenaId = ((batchStart / N + slot) * 1) % cfg.ARENAS.length;
        process.stdout.write(chalk.gray(
          `  [inst${slot}|arena${arenaId}] Agent ${idxA} vs ${idxB}... `
        ));
        return runFight(
          instances[slot],
          population[idxA],
          population[idxB],
          idxA,
          idxB,
          arenaId,
        );
      })
    );

    for (const [j, res] of results.entries()) {
      const { idxA, idxB } = batch[j];
      if (res.status === 'fulfilled') {
        const { score, oppScore } = res.value;
        scores[idxA] += score;
        scores[idxB] += oppScore;
        console.log(chalk.green(`${score}-${oppScore}`));
      } else {
        log.error('EvalPop', `batch fight ${batchStart + j} threw`, res.reason);
        console.log(chalk.red(`FAILED: ${res.reason?.message}`));
      }
    }

    // Brief cooldown between batches
    await sleep(1500);
  }

  return scores;
}

// ── Single fight ───────────────────────────────────────────────────────────

async function runFight(server, weightsA, weightsB, idxA, idxB, arenaId = 0) {
  fightCounter++;
  const nameA = `A${fightCounter}`;
  const nameB = `B${fightCounter}`;
  const FTAG  = `FIGHT:${fightCounter}`;

  const spawnA = ServerManager.spawnA(arenaId);
  const spawnB = ServerManager.spawnB(arenaId);

  let botA = null;
  let botB = null;

  try {
    log.step(FTAG, `starting — agents ${idxA} vs ${idxB}, names ${nameA}/${nameB}`);

    await server.rconBatch([`kick ${nameA} reset`, `kick ${nameB} reset`]);
    await sleep(300);

    botA = await connectBotWithRetry({
      host: '127.0.0.1',
      port: server.port,
      username: nameA,
      weights: weightsA,
      zoneOriginX: 0,
    });
    await sleep(1500);
    botB = await connectBotWithRetry({
      host: '127.0.0.1',
      port: server.port,
      username: nameB,
      weights: weightsB,
      zoneOriginX: 0,
    });

    await sleep(1000);
    await server.rconBatch([
      `gamemode 2 ${nameA}`,
      `gamemode 2 ${nameB}`,
      `tp ${nameA} ${spawnA.x} ${spawnA.y} ${spawnA.z} ${spawnA.yaw} 0`,
      `tp ${nameB} ${spawnB.x} ${spawnB.y} ${spawnB.z} ${spawnB.yaw} 0`,
      `clear ${nameA}`,
      `clear ${nameB}`,
      `give ${nameA} diamond_sword 1 0 {Unbreakable:1}`,
      `give ${nameB} diamond_sword 1 0 {Unbreakable:1}`,
      `effect ${nameA} instant_health 1 255 true`,
      `effect ${nameB} instant_health 1 255 true`,
      // Infinite resistance (level 5 = immune to all damage) so bots
      // never accidentally die and leave the fight early.
      `effect ${nameA} resistance 9999 4 true`,
      `effect ${nameB} resistance 9999 4 true`,
    ]);

    await sleep(400);
    botA.startFighting();
    botB.startFighting();

    await sleep(BOXING.HIT_TIMEOUT_MS);

    botA.stopFighting();
    botB.stopFighting();

    const hitsA = botA.getHits().myHits;
    const hitsB = botB.getHits().myHits;
    log.step(FTAG, `done — ${nameA}:${hitsA} ${nameB}:${hitsB}`);

    return { score: hitsA, oppScore: hitsB };

  } finally {
    if (botA) { try { botA.stopFighting(); botA.disconnect(); } catch {} }
    if (botB) { try { botB.stopFighting(); botB.disconnect(); } catch {} }
    await sleep(400);
    await server.rconBatch([
      `kick ${nameA} cleanup`,
      `kick ${nameB} cleanup`,
    ]).catch(() => {});
    await sleep(1000);
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
        await sleep(3000 * attempt);
      } else {
        throw err;
      }
    }
  }
}

function evolve(ranked) {
  const topN = Math.floor(ranked.length * TRAINING.TOP_FRACTION);
  const elite = ranked.slice(0, topN);
  const newPop = [];
  for (const { weights } of elite) newPop.push(new Float64Array(weights));
  while (newPop.length < TRAINING.POP_SIZE) {
    const parent = elite[Math.floor(Math.random() * elite.length)].weights;
    newPop.push(mutate(parent));
  }
  return newPop;
}

function mutate(weights) {
  const child = new Float64Array(weights);
  for (let i = 0; i < child.length; i++) {
    if (Math.random() < TRAINING.MUTATION_RATE) {
      child[i] += (Math.random() - 0.5) * TRAINING.MUTATION_STRENGTH;
    }
  }
  return child;
}

async function saveGeneration(gen, ranked, bestScore) {
  const data = {
    generation: gen,
    bestScore,
    population: ranked.map(r => nn.toJSON(r.weights)),
  };
  await fs.ensureDir(cfg.TRAINING.WEIGHTS_DIR);
  await fs.writeJSON(
    path.join(cfg.TRAINING.WEIGHTS_DIR, `gen_${gen}.json`), data, { spaces: 2 });
  await fs.writeJSON(
    path.join(cfg.TRAINING.WEIGHTS_DIR, 'champion.json'),
    { generation: gen, score: bestScore, weights: nn.toJSON(ranked[0].weights) },
    { spaces: 2 });
  console.log(chalk.gray(`  Saved generation ${gen}`));
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