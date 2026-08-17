const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
const TICK = 50; // 20 Hz

// ---------- Rooms ----------
// mode: 'team' | 'ffa'
// team duration 300s, ffa 600s
const rooms = new Map();

function roomId(mode, index) {
  return `${mode}-${index}`;
}

function ensureRooms() {
  for (const mode of ['team', 'ffa']) {
    for (let i = 1; i <= 4; i++) {
      const id = roomId(mode, i);
      if (!rooms.has(id)) {
        rooms.set(id, createRoom(id, mode));
      }
    }
  }
}

function createRoom(id, mode) {
  return {
    id,
    mode,
    maxPlayers: 8,
    duration: mode === 'team' ? 300 : 600,
    players: new Map(), // socketId -> player
    bullets: [],
    started: false,
    matchTime: 0,
    scores: {}, // name -> kills
    lastTick: Date.now()
  };
}

function publicRoomList() {
  ensureRooms();
  const list = [];
  for (const room of rooms.values()) {
    list.push({
      id: room.id,
      mode: room.mode,
      name: room.id.replace('-', ' ').replace(/^\w/, c => c.toUpperCase()).replace('team', 'Team').replace('ffa', 'FFA'),
      players: room.players.size,
      max: room.maxPlayers,
      started: room.started
    });
  }
  return list;
}

function spawnPoint(room) {
  // simple corners / edges
  const spots = [
    { x: 120, y: 120 },
    { x: 880, y: 120 },
    { x: 120, y: 520 },
    { x: 880, y: 520 },
    { x: 500, y: 100 },
    { x: 500, y: 540 },
    { x: 100, y: 320 },
    { x: 900, y: 320 }
  ];
  return spots[room.players.size % spots.length];
}

function createPlayer(socketId, name, room) {
  const pos = spawnPoint(room);
  let team = 0;
  if (room.mode === 'team') {
    // balance teams
    let t0 = 0, t1 = 0;
    for (const p of room.players.values()) {
      if (p.team === 0) t0++; else t1++;
    }
    team = t0 <= t1 ? 0 : 1;
  } else {
    team = -1; // ffa
  }
  return {
    id: socketId,
    name: String(name).slice(0, 16) || 'Player',
    x: pos.x,
    y: pos.y,
    angle: 0,
    hp: 100,
    maxHp: 100,
    team,
    kills: 0,
    deaths: 0,
    weapon: 'rifle',
    alive: true,
    invuln: 1.5,
    lastShot: 0,
    color: room.mode === 'team' ? (team === 0 ? '#3a8fd4' : '#e74c3c') : randomColor(socketId)
  };
}

function randomColor(seed) {
  const colors = ['#e74c3c', '#9b59b6', '#3498db', '#1abc9c', '#f1c40f', '#e67e22', '#2ecc71', '#e91e63'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h + seed.charCodeAt(i) * 17) % colors.length;
  return colors[h];
}

function roomSnapshot(room) {
  return {
    id: room.id,
    mode: room.mode,
    matchTime: room.matchTime,
    duration: room.duration,
    started: room.started,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      angle: p.angle,
      hp: p.hp,
      maxHp: p.maxHp,
      team: p.team,
      kills: p.kills,
      deaths: p.deaths,
      alive: p.alive,
      color: p.color,
      weapon: p.weapon
    })),
    bullets: room.bullets.map(b => ({
      id: b.id,
      x: b.x,
      y: b.y,
      angle: b.angle,
      color: b.color
    })),
    scores: room.scores
  };
}

// ---------- Socket ----------
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.emit('serverList', publicRoomList());

  socket.on('getServers', () => {
    socket.emit('serverList', publicRoomList());
  });

  socket.on('joinRoom', ({ roomId: rid, name }) => {
    ensureRooms();
    const room = rooms.get(rid);
    if (!room) {
      socket.emit('errorMsg', 'Сервер не найден');
      return;
    }
    if (room.players.size >= room.maxPlayers) {
      socket.emit('errorMsg', 'Сервер заполнен');
      return;
    }
    // leave previous
    leaveRoom(socket, currentRoom);
    currentRoom = room.id;

    const player = createPlayer(socket.id, name, room);
    room.players.set(socket.id, player);
    room.scores[player.name] = room.scores[player.name] || 0;
    socket.join(room.id);

    if (!room.started && room.players.size >= 1) {
      room.started = true;
      room.matchTime = 0;
    }

    socket.emit('joined', { roomId: room.id, playerId: socket.id, snapshot: roomSnapshot(room) });
    io.to(room.id).emit('roomState', roomSnapshot(room));
    io.emit('serverList', publicRoomList());
  });

  socket.on('input', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;

    // clamp movement
    const speed = 3.4 * (data.sprint ? 1.55 : 1);
    let dx = 0, dy = 0;
    if (data.up) dy -= 1;
    if (data.down) dy += 1;
    if (data.left) dx -= 1;
    if (data.right) dx += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy) || 1;
      dx = (dx / len) * speed;
      dy = (dy / len) * speed;
      p.x = Math.max(20, Math.min(980, p.x + dx));
      p.y = Math.max(20, Math.min(620, p.y + dy));
    }
    if (typeof data.angle === 'number') p.angle = data.angle;
    if (data.weapon) p.weapon = data.weapon;
  });

  socket.on('shoot', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    const now = Date.now();
    if (now - p.lastShot < 100) return; // rate limit
    p.lastShot = now;
    const angle = typeof data.angle === 'number' ? data.angle : p.angle;
    room.bullets.push({
      id: `${socket.id}-${now}`,
      x: p.x + Math.cos(angle) * 18,
      y: p.y + Math.sin(angle) * 18,
      angle,
      speed: 14,
      dmg: 18,
      life: 0.9,
      ownerId: p.id,
      ownerTeam: p.team,
      color: p.color
    });
  });

  socket.on('disconnect', () => {
    leaveRoom(socket, currentRoom);
    currentRoom = null;
    io.emit('serverList', publicRoomList());
  });
});

function leaveRoom(socket, roomId) {
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(roomId);
  if (room.players.size === 0) {
    room.started = false;
    room.matchTime = 0;
    room.bullets = [];
    room.scores = {};
  } else {
    io.to(room.id).emit('roomState', roomSnapshot(room));
  }
}

// ---------- Game loop ----------
setInterval(() => {
  const dt = TICK / 1000;
  for (const room of rooms.values()) {
    if (!room.started || room.players.size === 0) continue;

    room.matchTime += dt;

    // invuln
    for (const p of room.players.values()) {
      if (p.invuln > 0) p.invuln -= dt;
    }

    // bullets
    for (let i = room.bullets.length - 1; i >= 0; i--) {
      const b = room.bullets[i];
      b.x += Math.cos(b.angle) * b.speed;
      b.y += Math.sin(b.angle) * b.speed;
      b.life -= dt;
      if (b.life <= 0 || b.x < -20 || b.x > 1020 || b.y < -20 || b.y > 660) {
        room.bullets.splice(i, 1);
        continue;
      }
      for (const p of room.players.values()) {
        if (!p.alive || p.id === b.ownerId) continue;
        if (room.mode === 'team' && p.team === b.ownerTeam) continue;
        if (p.invuln > 0) continue;
        const d = Math.hypot(p.x - b.x, p.y - b.y);
        if (d < 16) {
          p.hp -= b.dmg;
          room.bullets.splice(i, 1);
          if (p.hp <= 0) {
            p.hp = 0;
            p.alive = false;
            p.deaths++;
            const killer = room.players.get(b.ownerId);
            if (killer) {
              killer.kills++;
              room.scores[killer.name] = (room.scores[killer.name] || 0) + 1;
            }
            // respawn after 3s
            setTimeout(() => {
              if (!room.players.has(p.id)) return;
              const pos = spawnPoint(room);
              p.x = pos.x;
              p.y = pos.y;
              p.hp = p.maxHp;
              p.alive = true;
              p.invuln = 2;
            }, 3000);
          }
          break;
        }
      }
    }

    // match end
    if (room.matchTime >= room.duration) {
      io.to(room.id).emit('matchEnd', {
        scores: room.scores,
        players: [...room.players.values()].map(p => ({
          name: p.name,
          kills: p.kills,
          deaths: p.deaths,
          team: p.team
        }))
      });
      // reset room after short delay
      room.started = false;
      room.matchTime = 0;
      room.bullets = [];
      for (const p of room.players.values()) {
        p.kills = 0;
        p.deaths = 0;
        p.hp = 100;
        p.alive = true;
        const pos = spawnPoint(room);
        p.x = pos.x;
        p.y = pos.y;
      }
      room.scores = {};
      setTimeout(() => {
        if (room.players.size > 0) {
          room.started = true;
          io.to(room.id).emit('roomState', roomSnapshot(room));
        }
      }, 5000);
    }

    io.to(room.id).emit('roomState', roomSnapshot(room));
  }
}, TICK);

ensureRooms();
server.listen(PORT, () => {
  console.log(`TZS multiplayer server on :${PORT}`);
});
