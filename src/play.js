// src/play.js
// Dedicated play server

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const args = require('minimist')(process.argv.slice(2));

const cfg = require('../config');
const { ServerManager } = require('./server_manager');
const { createBot } = require('./bot');
const nn = require('./neural_net');

const WEIGHTS_FILE = args.weights || cfg.PLAY.CHAMPION_WEIGHTS;
const BOT_NAME = cfg.PLAY.BOT_USERNAME;
const PLAY_PORT = args.port ? parseInt(args.port) : cfg.PLAY_SERVER_PORT;
const BIND_HOST = args.bind || cfg.PLAY.BIND_HOST;
const PLAY_RCON = cfg.RCON_PORT + 1;

function pickArena() {
  return Math.floor(Math.random() * cfg.ARENAS.length);
}

const { BOXING } = cfg;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function reTeleport(server, name, sp) {
  await sleep(600);
  await server.rcon(`tp ${name} ${sp.x} ${sp.y} ${sp.z} ${sp.yaw} 0`);
}

function getLanIps() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

async function main() {
  console.log(chalk.bold.yellow('\n⚔  PvP Boxing — Play Server  ⚔\n'));

  let weights = null;
  if (await fs.pathExists(WEIGHTS_FILE)) {
    const data = await fs.readJSON(WEIGHTS_FILE);
    weights = nn.fromJSON(data.weights);
    console.log(chalk.green(`Loaded champion (generation ${data.generation || '?'})`));
  } else {
    console.log(chalk.yellow(`No weights at ${WEIGHTS_FILE} — AI will play randomly`));
  }

  const server = new ServerManager({
    port: PLAY_PORT,
    rconPort: PLAY_RCON,
    serverDir: path.resolve(cfg.PLAY.SERVER_DIR),
    bindHost: BIND_HOST,
  });

  console.log(chalk.cyan('Starting play server...'));
  await server.start();

  await server.rconBatch([
    'gamerule naturalRegeneration true',
    'op Ploso',
  ]);

  const lanIps = getLanIps();
  console.log(chalk.green.bold(`\n✓ Server ready (port ${PLAY_PORT})\n`));
  console.log(chalk.white('  Connect with Minecraft 1.8.9:\n'));
  console.log(chalk.cyan.bold(`    localhost:${PLAY_PORT}`) + chalk.gray('  ← from THIS machine'));
  for (const { name, address } of lanIps) {
    console.log(chalk.cyan.bold(`    ${address}:${PLAY_PORT}`) + chalk.gray(`  ← from LAN (${name})`));
  }
  if (lanIps.length === 0) {
    console.log(chalk.yellow('  (Could not detect LAN IP)'));
  }
  console.log(chalk.gray(`\n  The AI bot "${BOT_NAME}" joins automatically when you connect.`));
  console.log(chalk.gray(`  Boxing rules: first to ${BOXING.HITS_TO_WIN} hits wins.\n`));

  let aiBot = null;
  let matchActive = false;
  let humanName = null;
  let humanHits = 0;
  let aiHits = 0;
  let currentArena = 0;
  let isSpawningAI = false;  // NEW: prevent duplicate spawns

  // Clean up AI bot properly
  async function cleanupAI() {
    if (aiBot) {
      try { aiBot.stopFighting(); } catch {}
      try { aiBot.disconnect(); } catch {}
      aiBot = null;
    }
    // Give server time to fully disconnect the bot
    await sleep(500);
  }

  async function spawnAI(arenaId = 0) {
    // Prevent duplicate spawn attempts
    if (isSpawningAI) {
      console.log(chalk.gray('  [spawnAI] Already spawning, skipping...'));
      return null;
    }
    isSpawningAI = true;

    try {
      const sp = ServerManager.zoneSpawnB(arenaId);

      // Clean up any existing AI first
      await cleanupAI();

      // Kick any stale session and wait for it to clear
      await server.rconBatch([`kick ${BOT_NAME} cleanup`]).catch(() => {});
      await sleep(1500);  // IMPORTANT: give server time to fully remove the player

      console.log(chalk.gray(`  [spawnAI] Connecting bot ${BOT_NAME}...`));

      const ctrl = await createBot({
        host: '127.0.0.1',
        port: PLAY_PORT,
        username: BOT_NAME,
        weights,
        zoneOriginX: 0,
      });

      // Wait for bot to fully spawn
      await sleep(500);

      await server.rconBatch([
        `gamemode 2 ${BOT_NAME}`,
        `effect ${BOT_NAME} resistance 9999 4 true`,
        `effect ${BOT_NAME} saturation 9999 255 true`,  // FIXED: was humanName
        `tp ${BOT_NAME} ${sp.x} ${sp.y} ${sp.z} ${sp.yaw} 0`,
        `clear ${BOT_NAME}`,
        `give ${BOT_NAME} minecraft:diamond_sword 1 0 {Unbreakable:1}`,
        `effect ${BOT_NAME} instant_health 1 255 true`,
      ]);

      await reTeleport(server, BOT_NAME, sp);

      ctrl.startFighting();
      console.log(chalk.cyan(`  AI spawned (ping: ${ctrl.ping}ms)`));

      return ctrl;
    } catch (err) {
      console.log(chalk.red(`  [spawnAI] Failed: ${err.message}`));
      return null;
    } finally {
      isSpawningAI = false;
    }
  }

  const resetMatch = async () => {
    await sleep(4000);
    if (!humanName) return;

    try {
      const list = await server.sendCommand('list');
      if (!list || !list.includes(humanName)) return;
    } catch { return; }

    console.log(chalk.cyan('\n[Match] Starting rematch...'));
    humanHits = 0;
    aiHits = 0;
    currentArena = pickArena();
    console.log(chalk.gray(`  Arena: ${currentArena}`));

    const sp = ServerManager.zoneSpawnA(currentArena);
    await server.rconBatch([
      `effect ${humanName} resistance 9999 4 true`,
      `effect ${humanName} saturation 9999 255 true`,
      `tp ${humanName} ${sp.x} ${sp.y} ${sp.z} ${sp.yaw} 0`,
      `clear ${humanName}`,
      `give ${humanName} minecraft:diamond_sword 1 0 {Unbreakable:1}`,
      `effect ${humanName} instant_health 1 255 true`,
    ]);
    await reTeleport(server, humanName, sp);

    await cleanupAI();
    aiBot = await spawnAI(currentArena);
    if (aiBot) {
      attachAiBotListeners();
      matchActive = true;
    }
  };

  const attachAiBotListeners = () => {
    if (!aiBot) return;

    aiBot.on('hitLanded', count => {
      if (!matchActive) return;
      aiHits = count;
      if (BOXING.HEAL_ON_HIT) {
        setTimeout(
          () => server.rcon(`effect ${humanName} minecraft:instant_health 1 1 true`),
          BOXING.HEAL_DELAY_MS,
        );
      }
      if (count >= BOXING.HITS_TO_WIN) {
        console.log(chalk.red.bold(`\n[Match] AI wins — ${BOXING.HITS_TO_WIN} hits!`));
        matchActive = false;
        announceResult(server, true, humanName).then(resetMatch);
      }
    });

    aiBot.on('hitTaken', count => {
      if (!matchActive) return;
      humanHits = count;
      if (BOXING.HEAL_ON_HIT) {
        setTimeout(
          () => server.rcon(`effect ${BOT_NAME} minecraft:instant_health 1 1 true`),
          BOXING.HEAL_DELAY_MS,
        );
      }
      if (count >= BOXING.HITS_TO_WIN) {
        console.log(chalk.green.bold(`\n[Match] ${humanName} wins — ${BOXING.HITS_TO_WIN} hits!`));
        matchActive = false;
        announceResult(server, false, humanName).then(resetMatch);
      }
    });

    // Handle AI getting kicked/disconnected unexpectedly
    aiBot.on('kicked', reason => {
      console.log(chalk.yellow(`\n[Match] AI was kicked: ${JSON.stringify(reason)}`));
      if (matchActive && humanName) {
        matchActive = false;
        // Don't immediately respawn - wait a bit
        setTimeout(() => {
          if (humanName && !aiBot) {
            console.log(chalk.cyan('[Match] Respawning AI after kick...'));
            spawnAI(currentArena).then(bot => {
              if (bot) {
                aiBot = bot;
                attachAiBotListeners();
                matchActive = true;
              }
            });
          }
        }, 3000);
      }
    });
  };

  const monitor = async () => {
    while (true) {
      await sleep(2000);

      // Skip if already spawning
      if (isSpawningAI) continue;

      try {
        const list = await server.sendCommand('list');
        if (!list) continue;

        const countMatch = list.match(/There are (\d+)/);
        const total = countMatch ? parseInt(countMatch[1]) : 0;
        const humanCount = aiBot ? total - 1 : total;

        if (humanCount > 0 && !aiBot && !isSpawningAI) {
          const nameMatch = list.match(/players online:\s*(.+)/);
          if (nameMatch) {
            const names = nameMatch[1].split(',').map(n => n.trim()).filter(n => n !== BOT_NAME);
            humanName = names[0] || 'Player';
          }
          console.log(chalk.green(`\n[Match] ${humanName} connected — spawning AI...`));
          humanHits = 0;
          aiHits = 0;
          currentArena = pickArena();
          console.log(chalk.gray(`  Arena: ${currentArena}`));

          const sp = ServerManager.zoneSpawnA(currentArena);
          await server.rconBatch([
            `effect ${humanName} resistance 9999 4 true`,
            `effect ${humanName} saturation 9999 255 true`,
            `gamemode 0 ${humanName}`,
            `tp ${humanName} ${sp.x} ${sp.y} ${sp.z} ${sp.yaw} 0`,
            `clear ${humanName}`,
            `give ${humanName} minecraft:diamond_sword 1 0 {Unbreakable:1}`,
            `effect ${humanName} instant_health 1 255 true`,
          ]);
          await reTeleport(server, humanName, sp);

          aiBot = await spawnAI(currentArena);
          if (aiBot) {
            attachAiBotListeners();
            matchActive = true;
          }

        } else if (humanCount === 0 && aiBot) {
          console.log(chalk.yellow('\n[Match] Human disconnected — AI leaving.'));
          matchActive = false;
          await cleanupAI();
          humanName = null;
        }
      } catch (err) {
        // Silently continue on errors
      }
    }
  };
  monitor();

  setInterval(() => {
    if (matchActive && aiBot) {
      process.stdout.write(chalk.gray(
        `\r  ${humanName || 'Player'}: ${humanHits} hits   AI: ${aiHits} hits` +
        `   (AI ping: ${aiBot.ping}ms)   `,
      ));
    }
  }, 500);

  const shutdown = async () => {
    console.log(chalk.yellow('\n\nShutting down...'));
    await cleanupAI();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function announceResult(server, aiWon, humanName) {
  const winTitle = '{"text":"YOU WIN!","color":"gold","bold":true}';
  const loseTitle = '{"text":"AI WINS","color":"red","bold":true}';
  if (aiWon) {
    await server.rcon(`title ${BOT_NAME} title ${winTitle}`);
    await server.rcon(`title ${humanName} title ${loseTitle}`);
    await server.rcon(`playsound random.levelup master ${BOT_NAME}`);
  } else {
    await server.rcon(`title ${humanName} title ${winTitle}`);
    await server.rcon(`title ${BOT_NAME} title ${loseTitle}`);
    await server.rcon(`playsound random.levelup master ${humanName}`);
  }
}

main().catch(e => {
  console.error(chalk.red('\nFatal:'), e);
  process.exit(1);
});