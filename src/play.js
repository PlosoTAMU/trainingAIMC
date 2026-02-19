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
const PLAYER_ZONE = 0;

const { BOXING } = cfg;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  await server.rcon('gamerule naturalRegeneration true');

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

  const monitor = async () => {
    while (true) {
      await sleep(2000);
      try {
        const list = await server._sendRcon('list');
        if (!list) continue;

        const countMatch = list.match(/There are (\d+)/);
        const total = countMatch ? parseInt(countMatch[1]) : 0;
        const humanCount = aiBot ? total - 1 : total;

        if (humanCount > 0 && !aiBot) {
          const nameMatch = list.match(/players online:\s*(.+)/);
          if (nameMatch) {
            const names = nameMatch[1].split(',').map(n => n.trim()).filter(n => n !== BOT_NAME);
            humanName = names[0] || 'Player';
          }
          console.log(chalk.green(`\n[Match] ${humanName} connected — spawning AI...`));
          humanHits = 0;
          aiHits = 0;
          aiBot = await spawnAI(server, weights);
          matchActive = true;

          aiBot.on('hitLanded', count => {
            aiHits = count;
            if (BOXING.HEAL_ON_HIT) {
              setTimeout(
                () => server.rcon(`effect ${humanName} minecraft:instant_health 1 1 true`),
                BOXING.HEAL_DELAY_MS,
              );
            }
            if (count >= BOXING.HITS_TO_WIN) {
              console.log(chalk.red.bold(`\n[Match] AI wins — ${BOXING.HITS_TO_WIN} hits!`));
              announceResult(server, true, humanName);
              matchActive = false;
            }
          });

          aiBot.on('hitTaken', count => {
            humanHits = count;
            if (BOXING.HEAL_ON_HIT) {
              setTimeout(
                () => server.rcon(`effect ${BOT_NAME} minecraft:instant_health 1 1 true`),
                BOXING.HEAL_DELAY_MS,
              );
            }
            if (count >= BOXING.HITS_TO_WIN) {
              console.log(chalk.green.bold(`\n[Match] ${humanName} wins — ${BOXING.HITS_TO_WIN} hits!`));
              announceResult(server, false, humanName);
              matchActive = false;
            }
          });

        } else if (humanCount === 0 && aiBot) {
          console.log(chalk.yellow('\n[Match] Human disconnected — AI leaving.'));
          aiBot.stopFighting();
          aiBot.disconnect();
          aiBot = null;
          matchActive = false;
        }
      } catch {}
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
    if (aiBot) { try { aiBot.disconnect(); } catch {} }
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function spawnAI(server, weights) {
  const sp = ServerManager.zoneSpawnB(PLAYER_ZONE);

  const ctrl = await createBot({
    host: '127.0.0.1',
    port: PLAY_PORT,
    username: BOT_NAME,
    weights,
    zoneOriginX: 0,
  });

  await server.rconBatch([
    `tp ${BOT_NAME} ${sp.x} ${sp.y} ${sp.z} ${sp.yaw} 0`,
    `clear ${BOT_NAME}`,
    `give ${BOT_NAME} minecraft:diamond_sword 1 0 {Unbreakable:1}`,
    `effect ${BOT_NAME} minecraft:instant_health 1 255 true`,
    `gamemode 2 ${BOT_NAME}`,
  ]);

  ctrl.startFighting();
  console.log(chalk.cyan(`  AI ping: ${ctrl.ping}ms`));
  return ctrl;
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