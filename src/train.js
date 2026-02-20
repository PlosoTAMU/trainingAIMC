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

// Global connection semaphore - only ONE bot can be connecting at any time
let isConnecting = false;
let connectionCount = 0;

async function acquireConnectionLock() {
  while (isConnecting) {
    await sleep(200);
  }
  isConnecting = true;
  connectionCount++;
  console.log(`  [Connection ${connectionCount}] Acquiring lock...`);
}

function releaseConnectionLock() {
  isConnecting = false;
  console.log(`  [Connection ${connectionCount}] Released.`);
}
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
  
  // Run fights ONE AT A TIME instead of in parallel
  console.log(chalk.gray(`  Running ${population.length} fights sequentially...`));
  
  for (let i = 0; i < population.length; i++) {
    const idx = i;
    const oppIdx = (i + 1) % population.length;
    
    const result = await runFight(server, 0, population[idx], population[oppIdx], idx, oppIdx);
    
    scores[result.idx] += result.score;
    scores[result.oppIdx] += result.oppScore;
    
    // Progress indicator
    if ((i + 1) % 5 === 0) {
      process.stdout.write(chalk.gray(`\r  Progress: ${i + 1}/${population.length} fights`));
    }
  }
  console.log(''); // newline
  
  return scores;
}

async function runFight(server, zoneId, weightsA, weightsB, idxA, idxB) {
  const spawnA = ServerManager.zoneSpawnA(zoneId);
  const spawnB = ServerManager.zoneSpawnB(zoneId);

  let botA, botB;
  
  try {
    // Bot A - acquire lock, wait 3 seconds, connect
    await acquireConnectionLock();
    console.log(`    Connecting Bot A${idxA}...`);
    await sleep(3000); // 3 second delay before connection
    
    botA = await createBot({
      host: '127.0.0.1',
      port: cfg.SERVER_PORT,
      username: `A${idxA}`,
      weights: weightsA,
      zoneOriginX: 0,
    });
    
    releaseConnectionLock();
    console.log(`    Bot A${idxA} connected ✓`);
    
    await sleep(2000); // Wait 2 seconds between bot connections
    
    // Bot B - acquire lock, wait 3 seconds, connect
    await acquireConnectionLock();
    console.log(`    Connecting Bot B${idxB}...`);
    await sleep(3000);
    
    botB = await createBot({
      host: '127.0.0.1',
      port: cfg.SERVER_PORT,
      username: `B${idxB}`,
      weights: weightsB,
      zoneOriginX: 0,
    });
    
    releaseConnectionLock();
    console.log(`    Bot B${idxB} connected ✓`);
    
    await sleep(1000); // Let both bots fully spawn
    
    // Setup fight
    console.log(`    Setting up arena...`);
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

    console.log(`    Fight starting: A${idxA} vs B${idxB}`);
    botA.startFighting();
    botB.startFighting();

    // Shorter fight for testing
    await sleep(10000); // 10 seconds

    const hitsA = botA.getHits().myHits;
    const hitsB = botB.getHits().myHits;
    
    console.log(`    Fight complete: A${idxA}=${hitsA} hits, B${idxB}=${hitsB} hits`);

    return {
      idx: idxA,
      oppIdx: idxB,
      score: hitsA,
      oppScore: hitsB,
    };
    
  } catch (error) {
    console.error(`    Fight ${idxA} vs ${idxB} FAILED: ${error.message}`);
    return {
      idx: idxA,
      oppIdx: idxB,
      score: 0,
      oppScore: 0,
    };
  } finally {
    // Cleanup
    console.log(`    Disconnecting bots...`);
    if (botA) {
      try { 
        botA.stopFighting();
        botA.disconnect(); 
      } catch {}
    }
    if (botB) {
      try { 
        botB.stopFighting();
        botB.disconnect(); 
      } catch {}
    }
    
    // Critical: wait before allowing next connection
    await sleep(3000);
    console.log(`    Cooldown complete.\n`);
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

main().catch(e => {
  console.error(chalk.red('\nFatal:'), e);
  process.exit(1);
});