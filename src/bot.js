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

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function wrapPi(a) {
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}
function degToRad(d) { return (d * Math.PI) / 180; }

function buildInputs(selfBot, oppEntity, zoneOriginX, myHits, oppHits, ticksSinceAttack) {
  const sp = selfBot.entity.position;
  const sv = selfBot.entity.velocity;

  const opPos = oppEntity ? oppEntity.position : { x: sp.x, y: sp.y, z: sp.z + 10 };
  const opVel = oppEntity ? oppEntity.velocity : { x: 0, y: 0, z: 0 };

  // Relative position to opponent
  const relX = opPos.x - sp.x;
  const relY = opPos.y - sp.y;
  const relZ = opPos.z - sp.z;
  const dist = Math.sqrt(relX*relX + relY*relY + relZ*relZ) || 1;

  const dirX = clamp1(relX / 20);
  const dirZ = clamp1(relZ / 20);
  const distNorm = clamp1(dist / 20);

  const relVX = clamp1((opVel.x - sv.x) / 5);
  const relVZ = clamp1((opVel.z - sv.z) / 5);

  // ─── Angle to opponent relative to where we're looking ────
  const angleToOpp = Math.atan2(-relX, relZ); // Minecraft yaw convention
  const yawDiff = wrapPi(selfBot.entity.yaw - angleToOpp);
  const facingOpp = clamp1(yawDiff / Math.PI); // -1 = opp on left, +1 = opp on right, 0 = facing them

  // ─── Pitch relative to opponent (are they above/below?) ───
  const vertAngleToOpp = Math.atan2(relY, Math.sqrt(relX*relX + relZ*relZ));
  const pitchDiff = clamp1((selfBot.entity.pitch - vertAngleToOpp) / (Math.PI / 2));

  // ─── Current pitch (to help avoid looking at sky) ─────────
  const currentPitch = clamp1(selfBot.entity.pitch / (Math.PI / 2));

  // ─── NEW: Attack cooldown state ────────────────────────────────
  // MC 1.8 has ~0.5s attack cooldown for full damage
  // ticksSinceAttack in range [0, 20] for 20 ticks = 1 second
  const attackReady = clamp1((ticksSinceAttack - 10) / 10);  // -1 = just attacked, +1 = ready

  // ─── NEW: In attack range? ─────────────────────────────────────
  const inRange = (dist < 4.0) ? 1 : -1;

  // ─── NEW: Opponent velocity relative to us (approaching?) ──────
  const approachSpeed = -(relVX * dirX + relVZ * dirZ);  // Dot product
  const approachNorm = clamp1(approachSpeed / 0.3);

  return [
    // Self state (0-5)
    clamp1(sv.x / 5),
    clamp1(sv.z / 5),
    clamp1(sv.y / 10),
    selfBot.entity.onGround ? 1 : -1,
    selfBot.entity.sprinting ? 1 : -1,
    norm(selfBot.health, 0, 20),

    // Opponent relative state (6-11)
    dirX,
    dirZ,
    distNorm,
    relVX,
    relVZ,
    oppEntity && oppEntity.onGround ? 1 : -1,

    // Fight progress (12-13)
    norm(myHits, 0, BOXING.HITS_TO_WIN),
    norm(oppHits, 0, BOXING.HITS_TO_WIN),

    // Aiming state (14-16)
    facingOpp,      // How far off our yaw is from facing opponent
    pitchDiff,      // How far off our pitch is from opponent's height
    currentPitch,   // Raw pitch (penalize extremes)

    // NEW: Attack timing state (17-19)
    attackReady,    // Can we attack now?
    inRange,        // Are we in attack range?
    approachNorm,   // Is opponent approaching or fleeing?
  ];
}

function cfg_zone_spacing_half() {
  // Arena spacing is 60 blocks between centres, so 30 blocks is the safe radius.
  return 25;
}

function randomActionsObj() {
  return {
    fwd: Math.random() > 0.4,
    back: false,
    left: Math.random() > 0.7,
    right: Math.random() > 0.7,
    jump: Math.random() > 0.85,
    attack: Math.random() > 0.25,
    sprint: Math.random() > 0.5,
    yawDelta: (Math.random() * 2 - 1),
    pitchDelta: (Math.random() * 2 - 1),
  };
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

    const stats = { hitsLanded: 0, hitsTaken: 0, leftClicks: 0 };
    const emitter = new EventEmitter();

    let fightInterval = null;
    let fighting = false;
    let lastHp = 20;
    let myHits = 0;
    let oppHits = 0;
    let lastAttackTime = 0;
    let ticksSinceAttack = 20;  // Start ready to attack
    let isDisconnected = false;

    // NEW: for "no autoclick" (click must be spam-toggled)
    let lastAttackPressed = false;

    // ── Socket-level error handler ─────────────────────────────────────────
    const errorHandler = (err) => {
      log.error(TAG, `bot "error" event (resolved=${resolved})`, err);
      if (!resolved) {
        cleanup();
        reject(err);
        return;
      }
    };
    bot.on('error', errorHandler);

    // Attach minecraft-protocol socket listeners
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

      // Increment attack cooldown counter
      ticksSinceAttack = Math.min(ticksSinceAttack + 1, 20);

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

      const inputs = buildInputs(bot, oppEntity, zoneOriginX, myHits, oppHits, ticksSinceAttack);
      const a = weights ? nn.decide(weights, inputs) : randomActionsObj();

      withPing(ping, () => {
        if (!fighting || isDisconnected) return;
        try {
          bot.setControlState('forward', a.fwd && !a.back);
          bot.setControlState('back',    a.back && !a.fwd);
          bot.setControlState('left',    a.left && !a.right);
          bot.setControlState('right',   a.right && !a.left);
          bot.setControlState('sprint',  a.sprint && (a.fwd || a.left || a.right) && !a.back);
          bot.setControlState('jump',    a.jump);
          bot.setControlState('sneak',   false);

          // View control (NO AUTO AIM)
          const MAX_YAW_DEG_PER_TICK = 18;
          const MAX_PITCH_DEG_PER_TICK = 12;

          const newYaw = wrapPi(bot.entity.yaw + degToRad(MAX_YAW_DEG_PER_TICK) * a.yawDelta);
          const newPitch = clamp(
            bot.entity.pitch + degToRad(MAX_PITCH_DEG_PER_TICK) * a.pitchDelta,
            degToRad(-90),
            degToRad(90)
          );
          bot.look(newYaw, newPitch, true);
        } catch {}
      });

      // "No autoclick": click only on rising edge
      const clickNow = !!a.attack && !lastAttackPressed;
      lastAttackPressed = !!a.attack;

      if (clickNow) {
        stats.leftClicks++;
        emitter.emit('leftClick', stats.leftClicks);

        if (oppEntity) {
          try {
            const dist = bot.entity.position.distanceTo(oppEntity.position);
            if (dist < 4.5) {
              withPing(ping, () => {
                if (!fighting || isDisconnected) return;
                try {
                  lastAttackTime = Date.now() + ping;
                  ticksSinceAttack = 0;  // Reset attack cooldown counter
                  bot.attack(oppEntity);
                } catch {}
              });
            }
          } catch {}
        }
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
      setTimeout(() => {
        try {
          if (bot._client && bot._client.socket) {
            bot._client.socket.destroy();
            log.step(TAG, 'socket force-destroyed');
          }
        } catch {}
      }, 1000);
    }

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