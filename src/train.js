// src/train.js
// Genetic algorithm training loop — PARALLEL INSTANCE VERSION

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
const instances = [];       // instances[i] = ServerManager
let fightCounter = 0;

// ── Startup ────────────────────────────────────────────────────────────────

async function main() {
  log.info('Main', `═══ Training session started (pid=${process.pid}) ═══`);
  log.info('Main', `Log file: ${log.LOG_FILE}`);
  console.log(chalk.bold.cyan('\n⚔  MC 1.8 PvP AI Trainer  ⚔\n'));
  console.log(chalk.gray(`Parallel instances: ${TRAINING.PARALLEL_INSTANCES}`));
  console.log(chalk.gray(`Population size:    ${TRAINING.POP_SIZE}`));
  console.log(chalk.gray(`Active arenas:      ${TRAINING.ACTIVE_ARENAS}`));
  console.log(chalk.gray(`Weights dir:        ${TRAINING.WEIGHTS_DIR}`));

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

    // Print top-5 leaderboard
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
  console.log(chalk.gray('All instances ready — stabilizing 3s...\n'));
  await sleep(3000);
}

// ── Population evaluation ──────────────────────────────────────────────────

async function evaluatePopulation(population) {
  const scores = new Array(population.length).fill(0);
  const server = instances[0];  // single server hosts all arenas
  const activeArenas = TRAINING.ACTIVE_ARENAS;

  // Pair agent i vs agent (i+1)%n — each pair gets its own arena slot.
  const schedule = population.map((_, i) => ({
    idxA: i,
    idxB: (i + 1) % population.length,
    arenaId: i % activeArenas,
  }));

  console.log(chalk.gray(`  ${schedule.length} fights firing simultaneously across ${activeArenas} arenas\n`));

  // Fire ALL fights at once — each uses a different arena so bots never collide
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
  if (errCount > 0) {
    console.log(chalk.red(`  ⚠  ${errCount}/${results.length} fights failed (see log for details)`));
  } else {
    console.log(chalk.gray(`  ✓ All ${results.length} fights completed`));
  }

  return scores;
}

// ── Single fight ───────────────────────────────────────────────────────────

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

    await server.rconBatch([`kick ${nameA} reset`, `kick ${nameB} reset`]);
    await sleep(100);

    // Connect both bots concurrently — they go to different arenas so no collision
    [botA, botB] = await Promise.all([
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

    // Wire live hit events so we can see hits as they happen
    let hitsLiveA = 0, hitsLiveB = 0;
    botA.on('hitLanded', total => {
      hitsLiveA = total;
      process.stdout.write(chalk.green(`${tag}${nameA}→HIT(${total}) `));
    });
    botB.on('hitLanded', total => {
      hitsLiveB = total;
      process.stdout.write(chalk.yellow(`${tag}${nameB}→HIT(${total}) `));
    });
    botA.on('kicked', reason => {
      console.log(`\n${tag} ${chalk.red(`${nameA} KICKED:`)} ${JSON.stringify(reason)}`);
    });
    botB.on('kicked', reason => {
      console.log(`\n${tag} ${chalk.red(`${nameB} KICKED:`)} ${JSON.stringify(reason)}`);
    });

    await sleep(500);
    await server.rconBatch([
      `gamemode 2 ${nameA}`,
      `gamemode 2 ${nameB}`,
      `effect ${nameA} resistance 9999 4 true`,
      `effect ${nameB} resistance 9999 4 true`,
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

    // Sample proximity every 500ms — reward agents that close the gap.
    // Score bonus = number of samples where dist < APPROACH_THRESHOLD blocks.
    const APPROACH_THRESHOLD = 6;   // within sword range = 4.5, generous for learning
    const APPROACH_BONUS = 0.5;     // points per sample tick spent close
    const SAMPLE_INTERVAL = 500;
    let proximityA = 0;
    let proximityB = 0;
    const proximitySampler = setInterval(() => {
      try {
        const posA = botA.bot.entity?.position;
        const posB = botB.bot.entity?.position;
        if (posA && posB) {
          const dist = Math.sqrt(
            (posA.x - posB.x) ** 2 +
            (posA.y - posB.y) ** 2 +
            (posA.z - posB.z) ** 2,
          );
          if (dist < APPROACH_THRESHOLD) {
            proximityA += APPROACH_BONUS;
            proximityB += APPROACH_BONUS;
          }
        }
      } catch {}
    }, SAMPLE_INTERVAL);

    await sleep(BOXING.HIT_TIMEOUT_MS);

    clearInterval(proximitySampler);
    botA.stopFighting();
    botB.stopFighting();
    const elapsed = ((Date.now() - fightStart) / 1000).toFixed(1);

    const hitsA = botA.getHits().myHits;
    const hitsB = botB.getHits().myHits;
    const scoreA = hitsA + proximityA;
    const scoreB = hitsB + proximityB;

    // Determine winner
    let resultLine;
    if (hitsA > hitsB) {
      resultLine = chalk.green(`WINNER: Agent ${idxA} (${nameA})`) +
        chalk.gray(` | ${nameA}: ${hitsA}hits +${proximityA.toFixed(1)}prox = ${scoreA.toFixed(1)} | ${nameB}: ${hitsB}hits +${proximityB.toFixed(1)}prox = ${scoreB.toFixed(1)}`);
    } else if (hitsB > hitsA) {
      resultLine = chalk.green(`WINNER: Agent ${idxB} (${nameB})`) +
        chalk.gray(` | ${nameA}: ${hitsA}hits +${proximityA.toFixed(1)}prox = ${scoreA.toFixed(1)} | ${nameB}: ${hitsB}hits +${proximityB.toFixed(1)}prox = ${scoreB.toFixed(1)}`);
    } else {
      resultLine = chalk.gray(`DRAW`) +
        chalk.gray(` | ${nameA}: ${hitsA}hits +${proximityA.toFixed(1)}prox | ${nameB}: ${hitsB}hits +${proximityB.toFixed(1)}prox`);
    }
    console.log(`\n${tag} ${chalk.bold('⏹  FIGHT OVER')} (${elapsed}s) — ${resultLine}`);

    log.step(FTAG, `done — ${nameA}:${hitsA}hits+${proximityA.toFixed(1)}prox ${nameB}:${hitsB}hits+${proximityB.toFixed(1)}prox`);

    return { score: scoreA, oppScore: scoreB };

  } finally {
    if (botA) { try { botA.stopFighting(); botA.disconnect(); } catch {} }
    if (botB) { try { botB.stopFighting(); botB.disconnect(); } catch {} }
    await sleep(200);
    await server.rconBatch([
      `kick ${nameA} cleanup`,
      `kick ${nameB} cleanup`,
    ]).catch(() => {});
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

function evolve(ranked) {
  const topN = Math.floor(ranked.length * TRAINING.TOP_FRACTION);
  const elite = ranked.slice(0, topN);
  const newPop = [];
  for (const { weights } of elite) newPop.push(new Float32Array(weights));
  while (newPop.length < TRAINING.POP_SIZE) {
    const parent = elite[Math.floor(Math.random() * elite.length)].weights;
    newPop.push(mutate(parent));
  }
  return newPop;
}

function mutate(weights) {
  const child = new Float32Array(weights);
  for (let i = 0; i < child.length; i++) {
    if (Math.random() < TRAINING.MUTATION_RATE) {
      child[i] += (Math.random() - 0.5) * TRAINING.MUTATION_STRENGTH;
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