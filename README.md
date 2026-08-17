# Topdown Zombie Survival - Multiplayer

## Render
Create a **Web Service**, not Static Site.

- Build Command: `npm install`
- Start Command: `npm start`
- Runtime: Node

The server serves `public/index.html` and Socket.IO from the same origin.

## Modes
- SOLO: local zombie survival.
- CLOSED: local AI battle, **no zombies**.
- TEAM: real online multiplayer, 8 players max per room.
- FFA: real online multiplayer, 8 players max per room.

Team/FFA use Socket.IO. Closed Battle stays local, so AI does not consume server slots.
