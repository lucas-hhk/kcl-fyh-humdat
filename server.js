import { createServer } from 'node:http';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/wav.js', ['wav.js', 'text/javascript']],
].map(([url, [file, type]]) => [
  url, [readFileSync(new URL(`./public/${file}`, import.meta.url)), type],
]));

const starterSongs = [
  ['Dancing Queen', 'ABBA'],
  ['Mr. Brightside', 'The Killers'],
  ['Shake It Off', 'Taylor Swift'],
  ['Blinding Lights', 'The Weeknd'],
  ['Rolling in the Deep', 'Adele'],
  ['Seven Nation Army', 'The White Stripes'],
  ['Bad Guy', 'Billie Eilish'],
  ['Hey Jude', 'The Beatles'],
  ['I Wanna Dance with Somebody', 'Whitney Houston'],
  ['Watermelon Sugar', 'Harry Styles'],
  ['Somebody That I Used to Know', 'Gotye'],
  ['Take On Me', 'a-ha'],
];
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const maxClipBytes = 2 * 1024 * 1024;
const maxPlayersPerRoom = 40;
const normalize = (value) => value.toLowerCase().normalize('NFKD')
  .replace(/\p{M}/gu, '').replace(/&/g, 'and').replace(/[^\p{L}\p{N}]/gu, '');

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function field(value, max, label) {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!cleaned || cleaned.length > max || !normalize(cleaned)) {
    fail(`${label} must contain 1–${max} characters, including a letter or number.`);
  }
  return cleaned;
}

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) fail('This upload is too large.', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) fail('This upload is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req, 4096);
  try {
    const value = JSON.parse(body.toString());
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // Return the same validation error for malformed JSON and non-object input.
  }
  fail('Expected a JSON object.');
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function addSong(room, title, artist) {
  const song = { id: randomUUID(), title, artist, knownBy: new Set() };
  room.songs.set(song.id, song);
  return song;
}

function availableSongs(room, singerId) {
  const connected = new Set([...room.players.values()].filter((p) => p.stream).map((p) => p.id));
  return [...room.songs.values()]
    .filter((song) => song.knownBy.has(singerId) && !room.usedSongs.has(song.id))
    .map((song) => ({ song, count: [...song.knownBy].filter((id) => connected.has(id)).length }))
    .filter(({ count }) => count >= 2);
}

export function createGameServer({ guessMs = 20_000, prepareMs = 40_000, leadMs = 500 } = {}) {
  const rooms = new Map();

  function snapshot(room, player) {
    const round = room.round;
    const revealed = room.phase === 'reveal';
    const singer = round?.singerId === player.id;
    const guess = round?.correct.get(player.id);
    const waitingForSong = room.phase === 'lobby' || room.phase === 'between';
    const eligible = waitingForSong
      ? waitingPlayers(room).filter((p) => availableSongs(room, p.id).length)
      : [];
    return {
      code: room.code,
      revision: room.revision,
      you: player.id,
      host: room.hostId,
      phase: room.phase,
      serverTime: Date.now(),
      players: [...room.players.values()].map((p) => ({
        id: p.id, name: p.name, score: p.score, online: Boolean(p.stream),
      })),
      songs: waitingForSong ? [...room.songs.values()].map((song) => ({
        id: song.id, title: song.title, artist: song.artist, known: song.knownBy.has(player.id),
        count: [...song.knownBy].filter((id) => room.onlineIds.has(id)).length,
        used: room.usedSongs.has(song.id),
      })) : [],
      canStart: eligible.length > 0,
      round: round && {
        id: round.id,
        formats: singer ? round.formats : undefined,
        number: room.roundNumber,
        singerId: round.singerId,
        title: singer || revealed ? round.song.title : undefined,
        artist: singer || revealed ? round.song.artist : undefined,
        hasClip: Boolean(round.clip),
        startsAt: round.startsAt,
        endsAt: round.endsAt,
        canGuess: round.listeners.has(player.id),
        correct: Boolean(guess),
        earned: guess?.points,
        skipped: round.skipped,
        results: revealed ? [...round.correct].map(([id, result]) => ({ id, points: result.points })) : undefined,
        singerPoints: revealed ? round.singerPoints : undefined,
      },
    };
  }

  function broadcast(room) {
    room.revision++;
    room.touchedAt = Date.now();
    for (const player of room.players.values()) {
      player.stream?.write(`data: ${JSON.stringify(snapshot(room, player))}\n\n`);
    }
  }

  function waitingPlayers(room) {
    return [...room.players.values()].filter((p) => p.stream && !room.sung.has(p.id));
  }

  function startRound(room) {
    const singer = waitingPlayers(room).find((p) => availableSongs(room, p.id).length);
    if (!singer) fail('Mark a song that at least two connected players know.');
    const options = availableSongs(room, singer.id);
    const topCount = Math.max(...options.map(({ count }) => count));
    const top = options.filter(({ count }) => count === topCount);
    room.phase = 'recording';
    room.roundNumber += 1;
    room.round = {
      id: randomUUID(), singerId: singer.id, song: top[randomInt(top.length)].song,
      formats: ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'].filter((type) =>
        [...room.players.values()].every((p) => p.id === singer.id || p.formats.includes(type))),
      clip: null, mime: null, startsAt: null, endsAt: null, skipped: false,
      listeners: new Set([...room.onlineIds].filter((id) => id !== singer.id)),
      ready: new Set(), correct: new Map(), singerPoints: 0,
    };
  }

  function reveal(room, skipped = false) {
    clearTimeout(room.timer);
    const round = room.round;
    round.skipped = skipped;
    if (!skipped) {
      round.singerPoints = Math.round(100 * round.correct.size / round.listeners.size);
      room.players.get(round.singerId).score += round.singerPoints;
      for (const [id, result] of round.correct) room.players.get(id).score += result.points;
    }
    room.sung.add(round.singerId);
    room.usedSongs.add(round.song.id);
    room.phase = 'reveal';
    broadcast(room);
  }

  function beginGuessing(room) {
    clearTimeout(room.timer);
    const round = room.round;
    round.startsAt = Date.now() + leadMs;
    round.endsAt = round.startsAt + guessMs;
    room.phase = 'guessing';
    room.timer = setTimeout(() => reveal(room), leadMs + guessMs);
    broadcast(room);
  }

  function addPlayer(room, name, formats) {
    if (room.players.size >= maxPlayersPerRoom) {
      fail(`This room is full (maximum ${maxPlayersPerRoom} players).`, 409);
    }
    if ([...room.players.values()].some((p) => normalize(p.name) === normalize(name))) {
      fail('That name is already taken in this room.', 409);
    }
    const player = { id: randomUUID(), name, score: 0, stream: null };
    player.formats = Array.isArray(formats) ? formats.filter((f) => typeof f === 'string').slice(0, 2) : [];
    const token = randomBytes(24).toString('hex');
    room.players.set(player.id, player);
    room.tokens.set(token, player);
    room.hostId ??= player.id;
    return { code: room.code, token };
  }

  function transferHost(room, absentHost) {
    if (room.hostId !== absentHost.id || absentHost.stream) return;
    const next = [...room.players.values()].find((p) => p.stream);
    if (!next) return;
    room.hostId = next.id;
    broadcast(room);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && staticFiles.has(url.pathname)) {
      const [data, type] = staticFiles.get(url.pathname);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      return res.end(data);
    }
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const data = await readJson(req);
      const name = field(data.name, 24, 'Name');
      if (rooms.size >= 100) fail('Too many active rooms. Try again shortly.', 503);
      let code;
      do {
        code = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
      } while (rooms.has(code));
      const room = {
        code, revision: 0, phase: 'lobby', hostId: null, round: null, roundNumber: 0, timer: null,
        players: new Map(), tokens: new Map(), songs: new Map(), onlineIds: new Set(),
        sung: new Set(), usedSongs: new Set(), touchedAt: Date.now(),
      };
      for (const [title, artist] of starterSongs) addSong(room, title, artist);
      rooms.set(code, room);
      return sendJson(res, 201, addPlayer(room, name, data.formats));
    }
    const match = /^\/api\/rooms\/([A-Z2-9]{5})\/(join|events|action|clip|session)$/.exec(url.pathname);
    if (!match) fail('Page not found.', 404);
    const [, code, route] = match;
    const room = rooms.get(code);
    if (!room) fail('Room not found. Check the code and try again.', 404);
    if (req.method === 'POST' && route === 'join') {
      const data = await readJson(req);
      const name = field(data.name, 24, 'Name');
      if (room.phase !== 'lobby') fail('This game has already started.', 409);
      return sendJson(res, 201, addPlayer(room, name, data.formats));
    }

    const token = route === 'events' ? url.searchParams.get('token')
      : /^Bearer ([a-f\d]{48})$/.exec(req.headers.authorization ?? '')?.[1];
    const player = room.tokens.get(token);
    if (!player) fail('Your room session has expired.', 401);
    if (req.method === 'GET' && route === 'session') return sendJson(res, 200, snapshot(room, player));
    if (req.method === 'GET' && route === 'events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
      });
      const previous = player.stream;
      player.stream = res;
      room.onlineIds.add(player.id);
      previous?.end();
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
      res.on('close', () => {
        clearInterval(heartbeat);
        if (player.stream === res) {
          player.stream = null;
          room.onlineIds.delete(player.id);
          broadcast(room);
          if (room.hostId === player.id) {
            setTimeout(() => transferHost(room, player), 15_000).unref();
          }
        }
      });
      if (room.hostId !== player.id && !room.players.get(room.hostId)) {
        room.hostId = player.id;
      }
      return broadcast(room);
    }
    if (route === 'clip' && req.method === 'GET') {
      const round = room.round;
      if (!round?.clip || url.searchParams.get('round') !== round.id) fail('Clip unavailable.', 404);
      res.writeHead(200, {
        'Content-Type': round.mime, 'Cache-Control': 'no-store', 'Content-Length': round.clip.length,
      });
      return res.end(round.clip);
    }
    if (route === 'clip' && req.method === 'POST') {
      const round = room.round;
      if (round?.clip && round.singerId === player.id && url.searchParams.get('round') === round.id) {
        req.resume();
        return sendJson(res, 200, snapshot(room, player));
      }
      const canUpload = () => room.phase === 'recording' && player.id === round.singerId
        && room.round === round && url.searchParams.get('round') === round.id;
      if (!canUpload()) fail('This recording turn has ended.', 409);
      const allowedTypes = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav'];
      const mime = req.headers['content-type']?.split(';')[0].toLowerCase();
      if (!allowedTypes.includes(mime)) fail('This recording format is unsupported.', 415);
      const chunked = url.searchParams.has('offset');
      const offset = Number(url.searchParams.get('offset'));
      const total = Number(url.searchParams.get('total'));
      if (chunked && (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(total)
        || total <= 0 || total > maxClipBytes || offset >= total)) fail('Invalid recording segment.');
      let clip = await readBody(req, chunked ? 16384 : maxClipBytes);
      if (!clip.length) fail('The recording is empty. Try again.');
      if (!canUpload()) fail('This recording turn has ended.', 409);
      if (chunked) {
        if (offset + clip.length > total) fail('Invalid recording length.');
        if (!round.upload && offset === 0) {
          round.upload = { bytes: Buffer.alloc(total), received: 0, mime };
        }
        const upload = round.upload;
        if (!upload || total !== upload.bytes.length || mime !== upload.mime || offset > upload.received) {
          fail('Recording segment arrived out of order.', 409);
        }
        if (offset === upload.received) {
          clip.copy(upload.bytes, offset);
          upload.received += clip.length;
        } else if (offset + clip.length > upload.received || !upload.bytes.subarray(offset, offset + clip.length).equals(clip)) {
          fail('Recording segment does not match.', 409);
        }
        if (upload.received < total) return sendJson(res, 200, { received: upload.received });
        clip = upload.bytes;
      }
      for (const id of room.onlineIds) if (id !== player.id) round.listeners.add(id);
      if (!round.listeners.size) fail('Wait for another player to reconnect before sharing.');
      round.clip = clip;
      round.upload = null;
      round.mime = mime;
      room.phase = 'preparing';
      room.timer = setTimeout(() => beginGuessing(room), prepareMs);
      broadcast(room);
      return sendJson(res, 200, snapshot(room, player));
    }
    if (route !== 'action' || req.method !== 'POST') fail('Page not found.', 404);
    const data = await readJson(req);
    const round = room.round;
    const host = player.id === room.hostId;
    const inPool = room.phase === 'lobby' || room.phase === 'between';
    switch (data.type) {
      case 'known': {
        const song = room.songs.get(data.songId);
        if (!inPool || !song || typeof data.known !== 'boolean' || room.usedSongs.has(song.id)) {
          fail('This song is unavailable.');
        }
        if (data.known) song.knownBy.add(player.id);
        else song.knownBy.delete(player.id);
        break;
      }
      case 'add-song': {
        if (!inPool) fail('You can add songs between rounds.');
        const title = field(data.title, 80, 'Title');
        const artist = field(data.artist, 80, 'Artist');
        const existing = [...room.songs.values()].find((song) =>
          normalize(song.title) === normalize(title) && normalize(song.artist) === normalize(artist));
        if (existing && room.usedSongs.has(existing.id)) fail('That song has already been played.');
        if (!existing && room.songs.size >= 80) fail('The song pool is full.');
        (existing ?? addSong(room, title, artist)).knownBy.add(player.id);
        break;
      }
      case 'start':
        if (!host || !inPool) fail('Only the host can start from the song pool.', 403);
        startRound(room);
        break;
      case 'ready':
        if (room.phase === 'preparing' && round.id === data.roundId && round.listeners.has(player.id)) {
          round.ready.add(player.id);
          if (round.ready.size === round.listeners.size) beginGuessing(room);
        }
        return sendJson(res, 200, { ok: true });
      case 'leave': {
        if (room.phase === 'recording') round.listeners.delete(player.id);
        const stream = player.stream;
        player.stream = null;
        room.onlineIds.delete(player.id);
        room.tokens.delete(token);
        stream?.end();
        if (room.phase === 'lobby') {
          room.players.delete(player.id);
          for (const song of room.songs.values()) song.knownBy.delete(player.id);
        }
        transferHost(room, player);
        if (host && !room.onlineIds.size) room.hostId = null;
        break;
      }
      case 'guess': {
        if (room.phase !== 'guessing' || round.id !== data.roundId) fail('This round is closed.', 409);
        const receivedAt = Date.now();
        if (receivedAt < round.startsAt || receivedAt >= round.endsAt) fail('Guessing is closed.', 409);
        if (!round.listeners.has(player.id)) fail('Only listeners can guess.', 403);
        if (round.correct.has(player.id)) return sendJson(res, 200, { correct: true });
        const guess = field(data.guess, 100, 'Guess');
        if (normalize(guess) !== normalize(round.song.title)) {
          return sendJson(res, 200, { correct: false });
        }
        const points = Math.round(20 + 80 * (round.endsAt - receivedAt) / guessMs);
        round.correct.set(player.id, { points });
        if (round.correct.size === round.listeners.size) reveal(room);
        else broadcast(room);
        return sendJson(res, 200, { correct: true });
      }
      case 'skip':
        if (room.phase !== 'recording' || round.id !== data.roundId
          || (!host && player.id !== round.singerId)) fail('This turn cannot be skipped.', 403);
        reveal(room, true);
        return sendJson(res, 200, { ok: true });
      case 'next':
        if (!host || room.phase !== 'reveal' || round.id !== data.roundId) fail('This round is closed.', 409);
        room.round = null;
        room.phase = waitingPlayers(room).length ? 'between' : 'finished';
        break;
      case 'finish':
        if (!host || room.phase !== 'between') fail('Finish from the song pool between rounds.', 409);
        room.phase = 'finished';
        break;
      case 'rematch':
        if (!host || room.phase !== 'finished') fail('Only the host can start a rematch.', 403);
        for (const p of room.players.values()) p.score = 0;
        room.sung.clear();
        room.usedSongs.clear();
        room.roundNumber = 0;
        room.phase = 'lobby';
        break;
      default:
        fail('Unknown room action.');
    }
    broadcast(room);
    return sendJson(res, 200, { ok: true });
  }

  const server = createServer((req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    handle(req, res).catch((error) => {
      if (!error.status) console.error(error);
      if (res.headersSent || res.destroyed) return res.end();
      if (error.status === 413) {
        res.setHeader('Connection', 'close');
        req.resume();
      }
      sendJson(res, error.status ?? 500, { error: error.status ? error.message : 'Something went wrong.' });
    });
  });
  const maintenance = setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [code, room] of rooms) {
      if (room.touchedAt > cutoff) continue;
      clearTimeout(room.timer);
      rooms.delete(code);
      for (const player of room.players.values()) player.stream?.end();
    }
  }, 60_000);
  maintenance.unref();
  server.on('close', () => {
    clearInterval(maintenance);
    for (const room of rooms.values()) clearTimeout(room.timer);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createGameServer().listen(port, '0.0.0.0', () => {
    console.log(`Humline is running at http://localhost:${port}`);
  });
}
