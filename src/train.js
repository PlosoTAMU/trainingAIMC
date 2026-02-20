// src/train.js
// Genetic algorithm training loop

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

async function main() {
  console.log(chalk.bold.cyan('\n⚔  MC 1.8 PvP AI Trainer  ⚔\n'));

  const server = new ServerManager();
  console.log(chalk.gray('Starting training server...'));
  await server.start();

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

  while (true) {
    generation++;
    console.log(chalk.bold.magenta(`\n═══ Generation ${generation} ═══\n`));

    const scores = await evaluatePopulation(server, population);

    const ranked = population.map((w, i) => ({ weights: w, score: scores[i] }))
      .sort((a, b) => b.score - a.score);

    const bestScore = ranked[0].score;
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    console.log(chalk.green(`Best: ${bestScore.toFixed(1)}  Avg: ${avgScore.toFixed(1)}`));

    if (generation % TRAINING.SAVE_EVERY_N_GENS === 0) {
      await saveGeneration(generation, ranked, bestScore);
    }

    population = evolve(ranked);
  }
}

async function evaluatePopulation(server, population) {
  const scores = new Array(population.length).fill(0);
  const zones = TRAINING.PARALLEL_ZONES;

  for (let round = 0; round < Math.ceil(TRAINING.FIGHTS_PER_AGENT / zones); round++) {
    const fights = [];

    for (let z = 0; z < zones && fights.length < population.length; z++) {
      const idx = (round * zones + z) % population.length;
      const oppIdx = (idx + 1) % population.length;

      fights.push(runFight(server, z, population[idx], population[oppIdx], idx, oppIdx));
    }

    const results = await Promise.all(fights);

    for (const { idx, oppIdx, score, oppScore } of results) {
      scores[idx] += score;
      scores[oppIdx] += oppScore;
    }
  }

  return scores;
}

async function runFight(server, zoneId, weightsA, weightsB, idxA, idxB) {
  const spawnA = ServerManager.zoneSpawnA(zoneId);
  const spawnB = ServerManager.zoneSpawnB(zoneId);

  const botA = await createBot({
    host: '127.0.0.1',
    port: cfg.SERVER_PORT,
    username: `A${idxA}_Z${zoneId}`,
    weights: weightsA,
    zoneOriginX: zoneId * cfg.ZONE.SPACING,
  });

  await sleep(500);  // ADD THIS LINE - 500ms delay between bots

  const botB = await createBot({
    host: '127.0.0.1',
    port: cfg.SERVER_PORT,
    username: `B${idxB}_Z${zoneId}`,
    weights: weightsB,
    zoneOriginX: zoneId * cfg.ZONE.SPACING,
  });

  await server.rconBatch([
    `tp ${botA.bot.username} ${spawnA.x} ${spawnA.y} ${spawnA.z}`,
    `tp ${botB.bot.username} ${spawnB.x} ${spawnB.y} ${spawnB.z}`,
    `clear ${botA.bot.username}`,
    `clear ${botB.bot.username}`,
    `give ${botA.bot.username} diamond_sword 1 0 {Unbreakable:1}`,
    `give ${botB.bot.username} diamond_sword 1 0 {Unbreakable:1}`,
    `effect ${botA.bot.username} instant_health 1 255 true`,
    `effect ${botB.bot.username} instant_health 1 255 true`,
    `gamemode 2 ${botA.bot.username}`,
    `gamemode 2 ${botB.bot.username}`,
  ]);

  botA.startFighting();
  botB.startFighting();

  await sleep(BOXING.HIT_TIMEOUT_MS);

  const hitsA = botA.getHits().myHits;
  const hitsB = botB.getHits().myHits;

  botA.disconnect();
  botB.disconnect();

  return {
    idx: idxA,
    oppIdx: idxB,
    score: hitsA,
    oppScore: hitsB,
  };
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

main().catch(e => {
  console.error(chalk.red('\nFatal:'), e);
  process.exit(1);
});