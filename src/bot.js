// src/bot.js
// PvP bot for BOXING match rules

const mineflayer = require('mineflayer');
const { EventEmitter } = require('events');
const { NN: nnCfg, ZONE, BOXING, PING } = require('../config');
const nn = require('./neural_net');
const log = require('./logger');

const DECISION_INTERVAL_MS = Math.round(1000 / nnCfg.DECISION_HZ);

function randomPing() {
  return Math.floor(Math.random() * (PING.MAX_MS - PING.MIN_MS + 1)) + PING.MIN_MS;
}

function withPing(ping, fn) {
  setTimeout(fn, ping);
}

function norm(v, lo, hi) {
  return (hi === lo) ? 0 : ((v - lo) / (hi - lo)) * 2 - 1;
}

// Clamp a value to [-1, 1]
function clamp1(v) { return Math.max(-1, Math.min(1, v)); }

function buildInputs(selfBot, oppEntity, zoneOriginX, myHits, oppHits) {
  const sp = selfBot.entity.position;
  const sv = selfBot.entity.velocity;

  // If opponent not visible, assume they're 10 blocks ahead on Z
  const opPos = oppEntity ? oppEntity.position : { x: sp.x, y: sp.y, z: sp.z + 10 };
  const opVel = oppEntity ? oppEntity.velocity : { x: 0, y: 0, z: 0 };

  // Relative position to opponent (what actually matters for PvP)
  const relX = opPos.x - sp.x;
  const relY = opPos.y - sp.y;
  const relZ = opPos.z - sp.z;
  const dist = Math.sqrt(relX*relX + relY*relY + relZ*relZ) || 1;

  // Normalised direction to opponent (-1..1 per axis)
  const dirX = clamp1(relX / 20);   // saturates at 20 blocks
  const dirZ = clamp1(relZ / 20);

  // Distance input: 0 = touching, 1 = 20+ blocks away
  const distNorm = clamp1(dist / 20);

  // Relative velocity of opponent vs self (are they closing or fleeing?)
  const relVX = clamp1((opVel.x - sv.x) / 5);
  const relVZ = clamp1((opVel.z - sv.z) / 5);

  return [
    // ── Self state ────────────────────────────────────────
    clamp1(sv.x / 5),                          // 0  self velocity X
    clamp1(sv.z / 5),                          // 1  self velocity Z
    clamp1(sv.y / 10),                         // 2  self velocity Y (falling/jumping)
    selfBot.entity.onGround   ? 1 : -1,        // 3  on ground
    selfBot.entity.sprinting  ? 1 : -1,        // 4  sprinting
    norm(selfBot.health, 0, 20),               // 5  own HP

    // ── Opponent state ────────────────────────────────────
    dirX,                                      // 6  direction to opp (X axis, normalised)
    dirZ,                                      // 7  direction to opp (Z axis, normalised)
    distNorm,                                  // 8  distance to opp (normalised)
    relVX,                                     // 9  relative velocity X
    relVZ,                                     // 10 relative velocity Z
    oppEntity && oppEntity.onGround ? 1 : -1,  // 11 opp on ground (W-tap signal)

    // ── Fight progress ────────────────────────────────────
    norm(myHits,  0, BOXING.HITS_TO_WIN),      // 12 my hit count progress
    norm(oppHits, 0, BOXING.HITS_TO_WIN),      // 13 opp hit count progress
  ];
}

function cfg_zone_spacing_half() {
  // Arena spacing is 60 blocks between centres, so 30 blocks is the safe radius.
  // Used to filter nearestEntity to only find opponents in the same arena.
  return 25;
}

function randomActions() {
  return [
    Math.random() > 0.4,   // fwd
    false,                  // back
    Math.random() > 0.7,   // left
    Math.random() > 0.7,   // right
    Math.random() > 0.85,  // jump
    Math.random() > 0.25,  // attack
    Math.random() > 0.5,   // sprint (explicit)
  ];
}

function createBot({ host, port, username, weights, zoneOriginX = 0 }) {
  const TAG = `BOT:${username}`;
  return new Promise((resolve, reject) => {
    log.step(TAG, `createBot() called → ${host}:${port}`);

    // Connection timeout
    const connectionTimeout = setTimeout(() => {
      log.error(TAG, 'connection timeout (30s)', new Error('Connection timeout'));
      cleanup();
      reject(new Error(`${username}: Connection timeout`));
    }, 30000);

    let resolved = false;
    let bot;

    function cleanup() {
      clearTimeout(connectionTimeout);
      if (bot && !resolved) {
        try { bot.removeAllListeners(); } catch {}
      }
    }

    try {
      log.step(TAG, 'calling mineflayer.createBot()');
      bot = mineflayer.createBot({
        host,
        port,
        username,
        version: '1.8.9',
        auth: 'offline',
        checkTimeoutInterval: 60000,
        hideErrors: true,
      });
    } catch (err) {
      log.error(TAG, 'mineflayer.createBot() threw synchronously', err);
      cleanup();
      reject(err);
      return;
    }

    const ping = randomPing();
    const stats = { hitsLanded: 0, hitsTaken: 0 };
    const emitter = new EventEmitter();

    let fightInterval = null;
    let fighting = false;
    let lastHp = 20;
    let myHits = 0;
    let oppHits = 0;
    let lastAttackTime = 0;
    let isDisconnected = false;

    // ── Socket-level error handler ─────────────────────────────────────────
    // Fires BEFORE spawn (connection errors) AND after spawn (mid-session errors).
    const errorHandler = (err) => {
      log.error(TAG, `bot "error" event (resolved=${resolved})`, err);
      if (!resolved) {
        cleanup();
        reject(err);
        return;
      }
      // After successful spawn, absorb — these are typically ECONNRESET on disconnect
    };
    bot.on('error', errorHandler);

    // Also intercept errors on the raw minecraft-protocol client socket
    // mineflayer creates bot._client (minecraft-protocol Client) which has a socket
    // We attach after the next tick so bot._client is definitely populated
    setImmediate(() => {
      try {
        if (bot._client) {
          bot._client.on('error', (err) => {
            log.error(TAG, 'bot._client "error" event (minecraft-protocol level)', err);
          });
          if (bot._client.socket) {
            bot._client.socket.on('error', (err) => {
              log.error(TAG, 'bot._client.socket "error" event (raw TCP level)', err);
            });
            bot._client.socket.on('close', (hadError) => {
              log.step(TAG, `raw socket "close" event (hadError=${hadError})`);
            });
          }
          bot._client.on('end', () => {
            log.step(TAG, 'bot._client "end" event');
          });
        }
      } catch (e) {
        log.warn(TAG, `could not attach _client listeners: ${e.message}`);
      }
    });

    bot.on('kicked', reason => {
      log.warn(TAG, `kicked: ${JSON.stringify(reason)}`);
      isDisconnected = true;
      stopFighting();
      emitter.emit('kicked', reason);
    });

    bot.on('end', (reason) => {
      log.step(TAG, `bot "end" event (reason=${reason || 'none'})`);
      isDisconnected = true;
      stopFighting();
    });

    bot.on('health', () => {
      if (isDisconnected) return;
      const hp = bot.health;
      if (hp < lastHp - 0.1) {
        stats.hitsTaken++;
        oppHits++;
        emitter.emit('hitTaken', stats.hitsTaken);
      }
      lastHp = hp;
    });

    bot.on('death', () => {
      stopFighting();
      emitter.emit('death');
    });

    bot.on('entityHurt', entity => {
      if (!fighting || isDisconnected) return;
      if (entity.type !== 'player') return;
      if (entity.username === bot.username) return;

      const sinceAttack = Date.now() - lastAttackTime;
      if (sinceAttack < 400) {
        stats.hitsLanded++;
        myHits++;
        emitter.emit('hitLanded', stats.hitsLanded);
      }
    });

    function tick() {
      if (!fighting || isDisconnected) return;
      if (!bot.entity) return;

      let oppEntity;
      try {
        oppEntity = bot.nearestEntity(e =>
          e.type === 'player' &&
          e.username !== bot.username &&
          Math.abs(e.position.x - zoneOriginX) < cfg_zone_spacing_half()
        );
      } catch {
        return;
      }

      const inputs = buildInputs(bot, oppEntity, zoneOriginX, myHits, oppHits);
      const actions = weights ? nn.decide(weights, inputs) : randomActions();
      const [fwd, back, left, right, jump, attack, sprint] = actions;

      withPing(ping, () => {
        if (!fighting || isDisconnected) return;
        try {
          bot.setControlState('forward', fwd && !back);
          bot.setControlState('back',    back && !fwd);
          bot.setControlState('left',    left && !right);
          bot.setControlState('right',   right && !left);
          bot.setControlState('sprint',  sprint && (fwd || left || right) && !back);
          bot.setControlState('jump',    jump);
          bot.setControlState('sneak',   false);
        } catch {}
      });

      if (attack && oppEntity) {
        try {
          const dist = bot.entity.position.distanceTo(oppEntity.position);
          if (dist < 4.5) {
            withPing(ping, () => {
              if (!fighting || isDisconnected) return;
              try {
                lastAttackTime = Date.now() + ping;
                bot.lookAt(oppEntity.position.offset(0, 1.62, 0), true);
                bot.attack(oppEntity);
              } catch {}
            });
          }
        } catch {}
      }
    }

    function startFighting() {
      if (fightInterval || isDisconnected) return;
      fighting = true;
      fightInterval = setInterval(tick, DECISION_INTERVAL_MS);
    }

    function stopFighting() {
      fighting = false;
      if (fightInterval) {
        clearInterval(fightInterval);
        fightInterval = null;
      }
      if (!isDisconnected && bot.entity) {
        try {
          for (const c of ['forward','back','left','right','sprint','jump','sneak']) {
            bot.setControlState(c, false);
          }
        } catch {}
      }
    }

    function disconnect() {
      if (isDisconnected) return;
      log.step(TAG, 'disconnect() called');
      isDisconnected = true;
      stopFighting();
      try {
        bot.removeAllListeners();
        // Also silence the underlying client
        if (bot._client) {
          try { bot._client.removeAllListeners('error'); } catch {}
          bot._client.on('error', (err) => {
            log.step(TAG, `suppressed post-disconnect _client error: ${err.message}`);
          });
        }
        bot.quit();
      } catch (e) {
        log.warn(TAG, `bot.quit() threw: ${e.message}`);
      }
      // Force-close the socket after a short grace period
      setTimeout(() => {
        try {
          if (bot._client && bot._client.socket) {
            bot._client.socket.destroy();
            log.step(TAG, 'socket force-destroyed');
          }
        } catch {}
      }, 1000);
    }

    // Create controller ONCE, properly
    const controller = {
      bot,
      stats,
      ping,
      startFighting,
      stopFighting,
      disconnect,
      getHits: () => ({ myHits, oppHits }),
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      off: emitter.off.bind(emitter),
    };

    bot.once('spawn', () => {
      log.step(TAG, `spawned successfully (hp=${bot.health}, ping=${ping}ms)`);
      clearTimeout(connectionTimeout);
      resolved = true;
      lastHp = bot.health || 20;
      resolve(controller);
    });
  });
}

module.exports = { createBot };