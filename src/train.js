// src/train.js
// Genetic algorithm training loop - SEQUENTIAL VERSION

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const args = require('minimist')(process.argv.slice(2));

const cfg = require('../config');
const { ServerManager } = require('./server_manager');
const { createBot } = require('./bot');
const nn = require('./neural_net');

const { TRAINING, BOXING } = cfg;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Global state
let server = null;
let activeConnections = 0;

async function main() {
  console.log(chalk.bold.cyan('\n⚔  MC 1.8 PvP AI Trainer  ⚔\n'));

  server = new ServerManager();
  console.log(chalk.gray('Starting training server...'));
  await server.start();

  // Wait for server to fully stabilize
  console.log(chalk.gray('Waiting for server to stabilize...'));
  await sleep(5000);

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

    const ranked = population.map((w, i) => ({ weights: w, score: scores[i] }))
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

async function evaluatePopulation(population) {
  const scores = new Array(population.length).fill(0);

  console.log(chalk.gray(`  Running ${population.length} fights sequentially...\n`));

  for (let i = 0; i < population.length; i++) {
    const oppIdx = (i + 1) % population.length;

    process.stdout.write(chalk.gray(`  Fight ${i + 1}/${population.length}: Agent ${i} vs ${oppIdx}... `));

    try {
      const result = await runFight(population[i], population[oppIdx], i, oppIdx);
      scores[result.idx] += result.score;
      scores[result.oppIdx] += result.oppScore;
      console.log(chalk.green(`${result.score}-${result.oppScore}`));
    } catch (err) {
      console.log(chalk.red(`FAILED: ${err.message}`));
    }

    // Cooldown between fights
    await sleep(2000);
  }

  return scores;
}

async function runFight(weightsA, weightsB, idxA, idxB) {
  const spawnA = ServerManager.zoneSpawnA(0);
  const spawnB = ServerManager.zoneSpawnB(0);

  let botA = null;
  let botB = null;

  try {
    // Connect bot A
    await sleep(3000);
    botA = await createBot({
      host: '127.0.0.1',
      port: cfg.SERVER_PORT,
      username: `BotA`,
      weights: weightsA,
      zoneOriginX: 0,
    });
    activeConnections++;

    // Wait between connections
    await sleep(3000);

    // Connect bot B
    botB = await createBot({
      host: '127.0.0.1',
      port: cfg.SERVER_PORT,
      username: `BotB`,
      weights: weightsB,
      zoneOriginX: 0,
    });
    activeConnections++;

    // Setup arena
    await sleep(1000);
    await server.rconBatch([
      `tp BotA ${spawnA.x} ${spawnA.y} ${spawnA.z}`,
      `tp BotB ${spawnB.x} ${spawnB.y} ${spawnB.z}`,
      `clear BotA`,
      `clear BotB`,
      `give BotA diamond_sword 1 0 {Unbreakable:1}`,
      `give BotB diamond_sword 1 0 {Unbreakable:1}`,
      `effect BotA instant_health 1 255 true`,
      `effect BotB instant_health 1 255 true`,
      `gamemode 2 BotA`,
      `gamemode 2 BotB`,
    ]);

    // Start fight
    await sleep(500);
    botA.startFighting();
    botB.startFighting();

    // Wait for fight duration
    await sleep(BOXING.HIT_TIMEOUT_MS);

    // Get results
    const hitsA = botA.getHits().myHits;
    const hitsB = botB.getHits().myHits;

    return {
      idx: idxA,
      oppIdx: idxB,
      score: hitsA,
      oppScore: hitsB,
    };

  } finally {
    // ALWAYS cleanup
    if (botA) {
      try {
        botA.stopFighting();
        botA.disconnect();
        activeConnections--;
      } catch {}
    }
    if (botB) {
      try {
        botB.stopFighting();
        botB.disconnect();
        activeConnections--;
      } catch {}
    }

    // Wait for server to process disconnections
    await sleep(2000);
  }
}

function evolve(ranked) {
  const topN = Math.floor(ranked.length * TRAINING.TOP_FRACTION);
  const elite = ranked.slice(0, topN);
  const newPop = [];

  for (const { weights } of elite) {
    newPop.push(new Float64Array(weights));
  }

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
    path.join(cfg.TRAINING.WEIGHTS_DIR, `gen_${gen}.json`),
    data,
    { spaces: 2 }
  );

  await fs.writeJSON(
    path.join(cfg.TRAINING.WEIGHTS_DIR, 'champion.json'),
    {
      generation: gen,
      score: bestScore,
      weights: nn.toJSON(ranked[0].weights),
    },
    { spaces: 2 }
  );

  console.log(chalk.gray(`  Saved generation ${gen}`));
}

async function findLatestWeights() {
  const dir = cfg.TRAINING.WEIGHTS_DIR;
  if (!await fs.pathExists(dir)) return null;

  const files = (await fs.readdir(dir))
    .filter(f => f.startsWith('gen_') && f.endsWith('.json'))
    .sort((a, b) => {
      const aNum = parseInt(a.match(/\d+/)[0]);
      const bNum = parseInt(b.match(/\d+/)[0]);
      return bNum - aNum;
    });

  return files.length > 0 ? path.join(dir, files[0]) : null;
}

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n\nShutting down...'));
  if (server) await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (server) await server.stop();
  process.exit(0);
});

main().catch(e => {
  console.error(chalk.red('\nFatal:'), e);
  process.exit(1);
});