import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createGameServer, scoreSinger } from '../server.js';

test('singer points peak at three quarters and drop when everyone guesses', () => {
  assert.equal(scoreSinger(0, 0), 0);
  assert.deepEqual([0, 1, 2, 3, 4].map((correct) => scoreSinger(correct, 4)), [0, 33, 67, 100, 60]);
  assert.equal(scoreSinger(1, 1), 60);
});

test('a room keeps the clue private, scores timed guesses, and rotates singers', { timeout: 10_000 }, async (t) => {
  const server = createGameServer({ guessMs: 500, prepareMs: 1_000, leadMs: 100 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  async function post(path, body, player) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(player && { Authorization: `Bearer ${player.token}` }) },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }

  async function stream(player) {
    const response = await fetch(`${base}/api/rooms/${player.code}/events?token=${player.token}`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = '';
    return async (matches) => {
      while (true) {
        const end = buffered.indexOf('\n\n');
        if (end === -1) {
          const { value, done } = await reader.read();
          assert.ok(!done, 'Room event stream ended before the expected state');
          buffered += value;
          continue;
        }
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (line.startsWith('data: ')) {
          const state = JSON.parse(line.slice(6));
          if (matches(state)) return state;
        }
      }
    };
  }

  const { status, data: host } = await post('/api/rooms', { name: 'Maya' });
  assert.equal(status, 201);
  assert.match(host.code, /^[A-Z2-9]{5}$/);
  const room = `/api/rooms/${host.code}`;
  const { data: listener } = await post(`${room}/join`, { name: 'Sam' });
  const { data: third } = await post(`${room}/join`, { name: 'Alex' });
  const hostStream = await stream(host);
  const listenerStream = await stream(listener);
  const thirdStream = await stream(third);
  const act = (player, type, args) => post(`${room}/action`, { type, ...args }, player);

  const lobby = await hostStream((state) => state.players.filter((p) => p.online).length === 3);
  const song = lobby.songs.find((s) => s.title === 'Mr. Brightside');
  assert.equal(lobby.canStart, false);
  assert.equal((await act(host, 'start')).status, 400);
  await act(host, 'known', { songId: song.id, known: true });
  await act(listener, 'known', { songId: song.id, known: true });
  const importList = (player, tracks) => post(`${room}/playlist`, { tracks }, player);
  await act(listener, 'add-song', { title: 'Around the World', artist: 'Daft Punk', cover: 'https://example.com/cover.png' });
  const shared = await hostStream((state) => state.canStart && state.songs.some((s) => s.title === 'Around the World'));
  const secondSong = shared.songs.find((s) => s.title === 'Around the World');
  assert.equal(secondSong.cover, 'https://example.com/cover.png');
  assert.equal(shared.songs.find((s) => s.id === song.id).count, 2);
  await act(host, 'known', { songId: secondSong.id, known: true });
  assert.deepEqual(await importList(host, 'Take It Easy – Eagles\nTake It Easy - Eagles\nHost-only song - Maya'), {
    status: 200, data: { count: 2 },
  });
  const hostList = await hostStream((state) => state.playlist.includes('Host-only song'));
  assert.equal(hostList.songs.some((s) => s.title === 'Take It Easy' || s.title === 'Host-only song'), false);
  assert.equal((await importList(listener, 'take it easy\tEAGLES')).status, 200);
  assert.equal((await importList(listener, 'Invalid replacement')).status, 400);
  const overlap = await listenerStream((state) => state.sharedCount === 3);
  assert.equal(overlap.playlist.includes('Host-only song'), false);
  const thirdSong = overlap.songs.find((s) => s.title === 'Take It Easy');
  assert.equal(thirdSong.count, 2);
  assert.equal(thirdSong.inPlaylist, true);
  await importList(listener, '');
  await listenerStream((state) => state.sharedCount === 2 && state.playlist === '');
  await importList(listener, 'Take It Easy - Eagles');
  await act(third, 'add-song', { title: 'Solo pick', artist: 'Alex' });
  const fullLobby = await hostStream((state) => state.sharedCount === 3 && state.songs.some((s) => s.title === 'Solo pick'));
  assert.equal(fullLobby.songs.find((s) => s.title === 'Solo pick').count, 1);
  assert.equal((await act(listener, 'start')).status, 403);
  assert.equal((await act(host, 'start')).status, 200);
  const hostTurn = await hostStream((state) => state.phase === 'recording');
  const listenerTurn = await listenerStream((state) => state.phase === 'recording');
  const queuedTitles = new Set([song.title, secondSong.title, thirdSong.title]);
  assert.equal(queuedTitles.delete(hostTurn.round.title), true);
  assert.equal(hostTurn.totalRounds, 3);
  assert.equal((await act(host, 'known', { songId: song.id, known: false })).status, 400);
  assert.equal(listenerTurn.round.title, undefined);
  assert.equal(listenerTurn.round.artist, undefined);
  assert.equal(listenerTurn.round.cover, undefined);
  assert.deepEqual(listenerTurn.songs, []);

  const roundId = hostTurn.round.id;
  const clipPath = `${base}${room}/clip?round=${roundId}`;
  const audio = Buffer.from('test clip bytes');
  const upload = (player) => fetch(clipPath, {
    method: 'POST', body: audio,
    headers: { Authorization: `Bearer ${player.token}`, 'Content-Type': 'audio/webm;codecs=opus' },
  });
  assert.equal((await upload(listener)).status, 409);
  const segment = (offset, body) => fetch(clipPath + `&offset=${offset}&total=${audio.length}`, {
    method: 'POST', body, headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'audio/webm' },
  });
  assert.deepEqual(await (await segment(0, audio.subarray(0, 5))).json(), { received: 5 });
  assert.deepEqual(await (await segment(0, audio.subarray(0, 5))).json(), { received: 5 });
  assert.equal((await segment(5, audio.subarray(5))).status, 200);
  const acknowledged = await (await upload(host)).json();
  assert.equal(acknowledged.phase, 'preparing');
  const refreshed = await (await fetch(base + room + '/session', {
    headers: { Authorization: `Bearer ${listener.token}` },
  })).json();
  assert.equal(refreshed.round.hasClip, true);
  assert.equal(refreshed.round.title, undefined);
  assert.equal(refreshed.revision, acknowledged.revision);
  const prep = await listenerStream((state) => state.phase === 'preparing');
  assert.equal(prep.round.canGuess, true);
  assert.equal((await fetch(clipPath)).status, 401);
  const download = await fetch(clipPath, { headers: { Authorization: `Bearer ${listener.token}` } });
  assert.equal(download.headers.get('content-type'), 'audio/webm');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), audio);
  await act(listener, 'ready', { roundId });
  await act(third, 'ready', { roundId });
  const timed = await listenerStream((state) => state.phase === 'guessing');
  assert.equal(timed.round.endsAt - timed.round.startsAt, 500);
  await delay(Math.max(0, timed.round.startsAt - Date.now() + 10));
  assert.equal((await act(host, 'guess', { roundId, guess: hostTurn.round.title })).status, 403);
  assert.deepEqual((await act(listener, 'guess', { roundId, guess: 'Hey Jude' })).data, { correct: false });
  assert.deepEqual((await act(listener, 'guess', { roundId, guess: hostTurn.round.title.toLowerCase() })).data, { correct: true });
  const scored = await listenerStream((state) => state.phase === 'guessing' && state.round.correct);
  assert.ok(scored.round.earned >= 20 && scored.round.earned <= 100);
  assert.deepEqual((await act(listener, 'guess', { roundId, guess: hostTurn.round.title })).data, { correct: true });
  const thirdView = await thirdStream((state) => state.phase === 'guessing');
  assert.equal(thirdView.round.correct, false);
  assert.equal(thirdView.round.results, undefined);
  assert.equal(thirdView.players.every((p) => p.score === 0), true);

  const revealed = await hostStream((state) => state.phase === 'reveal');
  if (revealed.round.title === secondSong.title) assert.equal(revealed.round.cover, 'https://example.com/cover.png');
  assert.equal(revealed.round.singerPoints, 67);
  assert.equal(revealed.round.listenerCount, 2);
  assert.equal(revealed.round.results.length, 1);
  assert.equal(revealed.players.find((p) => p.id === scored.you).score, scored.round.earned);
  assert.equal((await act(third, 'guess', { roundId, guess: song.title })).status, 409);
  assert.equal((await act(host, 'next', { roundId })).status, 200);
  assert.equal((await fetch(clipPath, { headers: { Authorization: `Bearer ${listener.token}` } })).status, 404);
  const next = await listenerStream((state) => state.phase === 'recording' && state.round.number === 2);
  assert.equal(next.round.singerId, next.you);
  assert.equal(queuedTitles.delete(next.round.title), true);
  assert.equal((await act(listener, 'skip', { roundId: next.round.id })).status, 200);
  assert.equal((await act(host, 'next', { roundId: next.round.id })).status, 200);
  const last = await hostStream((state) => state.phase === 'recording' && state.round.number === 3);
  assert.equal(last.round.singerId, last.you);
  assert.equal(queuedTitles.delete(last.round.title), true);
  assert.equal(queuedTitles.size, 0);
  assert.equal((await act(host, 'skip', { roundId: last.round.id })).status, 200);
  assert.equal((await act(host, 'next', { roundId: last.round.id })).status, 200);
  const finished = await hostStream((state) => state.phase === 'finished');
  assert.equal(finished.remainingRounds, 0);
  assert.equal((await act(host, 'rematch')).status, 200);
  const rematch = await hostStream((state) => state.phase === 'lobby');
  assert.ok(rematch.players.every((player) => player.score === 0));
});
