// src/bot.js
// PvP bot for BOXING match rules:
//   - Adventure mode (no block break/place)
//   - 1 unbreakable diamond sword
//   - Simulated network ping (random 10–150ms delay on all actions)
//   - Hit counting via entityHurt + attack timing correlation
//   - Bots are healed after every hit so the fight goes to 100 hits, not death

const mineflayer = require('mineflayer');
const { NN: nnCfg, ZONE, BOXING, PING } = require('../config');
const nn = require('./neural_net');

const DECISION_INTERVAL_MS = Math.round(1000 / nnCfg.DECISION_HZ);

// ── Ping simulation ───────────────────────────────────────────────────────────
function randomPing() {
  return Math.floor(Math.random() * (PING.MAX_MS - PING.MIN_MS + 1)) + PING.MIN_MS;
}

// Wrap any action in a one-way latency delay
function withPing(ping, fn) {
  setTimeout(fn, ping);
}

// ── State normalisation ───────────────────────────────────────────────────────
function norm(v, lo, hi) {
  return (hi === lo) ? 0 : ((v - lo) / (hi - lo)) * 2 - 1;
}

function buildInputs(selfBot, oppEntity, zoneOriginX, myHits, oppHits) {
  const sp = selfBot.entity.position;
  const sv = selfBot.entity.velocity;

  const opPos = oppEntity ? oppEntity.position : { x: sp.x + 5, y: sp.y, z: sp.z };
  const opVel = oppEntity ? oppEntity.velocity : { x: 0, y: 0, z: 0 };

  // Positions relative to zone origin, normalised to ±1 over ±250 blocks
  const rX  = (sp.x - zoneOriginX) / 250;
  const rZ  = sp.z / 250;
  const orX = (opPos.x - zoneOriginX) / 250;
  const orZ = opPos.z / 250;
  const dX  = orX - rX;
  const dZ  = orZ - rZ;

  return [
    Math.max(-1, Math.min(1, rX)),
    Math.max(-1, Math.min(1, rZ)),
    Math.max(-1, Math.min(1, sv.y / 10)),
    norm(selfBot.health, 0, 20),
    selfBot.entity.onGround ? 1 : -1,
    selfBot.entity.sprinting ? 1 : -1,

    Math.max(-1, Math.min(1, orX)),
    Math.max(-1, Math.min(1, orZ)),
    Math.max(-1, Math.min(1, opVel.y / 10)),
    // Opponent health: exposed via entity metadata in 1.8 for other players
    oppEntity && oppEntity.health != null ? norm(oppEntity.health, 0, 20) : 1,
    oppEntity && oppEntity.sprinting ? 1 : -1,
    oppEntity && oppEntity.onGround ? 1 : -1,

    norm(myHits, 0, BOXING.HITS_TO_WIN),      // how close am I to winning?
    norm(oppHits, 0, BOXING.HITS_TO_WIN),     // how close is opponent to winning?
  ];
}

// ── Create a PvP bot ──────────────────────────────────────────────────────────
// Options:
//   host, port, username  — connection
//   weights               — Float64Array NN weights (null → random behaviour)
//   zoneOriginX           — world x of this zone's origin
//
// Returned controller:
//   .stats         { hitsLanded, hitsTaken }
//   .startFighting()
//   .stopFighting()
//   .disconnect()
//   .on('hitLanded',  cb(count))  — we landed a hit on opponent
//   .on('hitTaken',   cb(count))  — opponent hit us
//   .on('death', cb)
function createBot({ host, port, username, weights, zoneOriginX = 0 }) {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({
      host,
      port,
      username,
      version: '1.8.9',
      auth: 'offline',
    });

    const ping = randomPing();
    const stats = { hitsLanded: 0, hitsTaken: 0 };
    const emitter = new (require('events').EventEmitter)();

    let fightInterval = null;
    let fighting = false;
    let lastHp = 20;
    let myHits = 0;
    let oppHits = 0;
    let lastAttackTime = 0; // ms timestamp of most recent attack() call

    // ── Connection events ──────────────────────────────────────────────────
    bot.on('error', reject);
    bot.on('kicked', reason => {
      stopFighting();
      emitter.emit('kicked', reason);
    });

    bot.once('spawn', () => {
      bot.removeListener('error', reject);
      lastHp = bot.health;
      resolve(controller);
    });

    // ── Health tracking — detect incoming hits ─────────────────────────────
    bot.on('health', () => {
      const hp = bot.health;
      if (hp < lastHp - 0.1) {                 // health dropped → we were hit
        stats.hitsTaken++;
        oppHits++;
        emitter.emit('hitTaken', stats.hitsTaken);
      }
      lastHp = hp;
      // Note: we do NOT emit 'death' here — the arena heals us before hp→0.
      // If we somehow die, bot.on('death') fires.
    });

    bot.on('death', () => {
      stopFighting();
      emitter.emit('death');
    });

    // ── Hit detection — did our attack connect? ────────────────────────────
    // Strategy: mineflayer fires 'entityHurt' for any entity taking damage.
    // We correlate: if we attacked within the last 300ms, and the entity hurt
    // is our current opponent, count it as a hit.
    // This is the most reliable approach without a server plugin.
    bot.on('entityHurt', entity => {
      if (!fighting) return;
      if (entity.type !== 'player') return;
      if (entity.username === bot.username) return;

      const sinceAttack = Date.now() - lastAttackTime;
      if (sinceAttack < 400) {    // within 400ms window of our attack call
        stats.hitsLanded++;
        myHits++;
        emitter.emit('hitLanded', stats.hitsLanded);
      }
    });

    // ── Decision loop ──────────────────────────────────────────────────────
    function tick() {
      if (!fighting) return;

      const oppEntity = bot.nearestEntity(e =>
        e.type === 'player' &&
        e.username !== bot.username &&
        // Stay within our zone — don't get confused by bots in adjacent zones
        Math.abs(e.position.x - zoneOriginX) < cfg_zone_spacing_half()
      );

      const inputs = buildInputs(bot, oppEntity, zoneOriginX, myHits, oppHits);
      const actions = weights ? nn.decide(weights, inputs) : randomActions();
      const [fwd, back, left, right, jump, attack] = actions;

      // Sprint is always on when moving — 1.8 optimal play
      const moving = fwd || back || left || right;

      // All control states go through the ping delay
      withPing(ping, () => {
        if (!fighting) return;
        bot.setControlState('forward', fwd && !back);
        bot.setControlState('back',    back && !fwd);
        bot.setControlState('left',    left && !right);
        bot.setControlState('right',   right && !left);
        bot.setControlState('sprint',  moving);
        bot.setControlState('jump',    jump);
      });

      // Attack — also delayed by ping
      if (attack && oppEntity) {
        const dist = bot.entity.position.distanceTo(oppEntity.position);
        if (dist < 4.5) {
          withPing(ping, () => {
            if (!fighting) return;
            lastAttackTime = Date.now() + ping; // account for when hit will register
            // Look at opponent, then swing
            bot.lookAt(oppEntity.position.offset(0, 1.62, 0), true);
            bot.attack(oppEntity);
          });
        }
      }
    }

    function startFighting() {
      if (fightInterval) return;
      fighting = true;
      fightInterval = setInterval(tick, DECISION_INTERVAL_MS);
    }

    function stopFighting() {
      if (!fightInterval) return;
      clearInterval(fightInterval);
      fightInterval = null;
      fighting = false;
      for (const c of ['forward','back','left','right','sprint','jump','sneak']) {
        try { bot.setControlState(c, false); } catch {}
      }
    }

    function disconnect() {
      stopFighting();
      try { bot.quit(); } catch {}
    }

    // Expose hit counters for the arena to read back
    controller.getHits = () => ({ myHits, oppHits });

    const controller = {
      bot,
      stats,
      ping,
      startFighting,
      stopFighting,
      disconnect,
      getHits: () => ({ myHits, oppHits }),
      on:   emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      off:  emitter.off.bind(emitter),
    };
  });
}

// Half the zone spacing — used to keep bots from seeing adjacent zones
function cfg_zone_spacing_half() {
  return require('../config').ZONE.SPACING / 2;
}

function randomActions() {
  return [
    Math.random() > 0.4,  // forward
    false,
    Math.random() > 0.7,  // left
    Math.random() > 0.7,  // right
    Math.random() > 0.85, // jump (crits!)
    Math.random() > 0.25, // attack aggressively
  ];
}

module.exports = { createBot };
