import { encodeWav } from './wav.js';

const app = document.querySelector('#app');
const header = document.querySelector('#header-room');
const status = document.querySelector('#status');
const storageKey = 'humline-room';
let inviteCode = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '';
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const button = (label, action, style = '', disabled = false) =>
  `<button type="button" class="button ${style}" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;

let session;
let releaseSessionLock;
let events;
let state;
let renderedPhase;
let clockOffset = 0;
let toastTimeout;
let media;
let syncTimer;
let playbackContext;
let recording;
let uploadInProgress = false;
let guessInProgress = false;

function tell(message, isError = false) {
  clearTimeout(toastTimeout);
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.hidden = false;
  toastTimeout = setTimeout(() => { status.hidden = true; }, 4500);
}

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.error ?? 'The server could not handle that request.'), { status: response.status });
  }
  return response;
}

function roomPath(route, current = session) {
  return `/api/rooms/${current.code}/${route}`;
}

function roomRequest(route, options = {}, current = session) {
  return request(roomPath(route, current), {
    ...options, headers: { ...options.headers, Authorization: `Bearer ${current.token}` },
  });
}

async function action(type, data = {}, current = session) {
  const response = await roomRequest('action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...data }),
  }, current);
  return response.json();
}

function showHome() {
  header.innerHTML = '';
  app.innerHTML = `
    <section class="hero">
      <div>
        <div class="eyebrow">A music party game</div>
        <h1 class="hero-title">
          <span class="hero-title-line"><span data-note-anchor="hum">h</span>um da<span data-note-anchor="dat">t</span></span>
          <span class="hero-title-line"><span data-note-anchor="song">s</span>on<span data-note-anchor="g">g</span></span>
          <img class="bouncing-note" src="/music-note.svg" alt="" aria-hidden="true">
        </h1>
        <p class="lede">Hum songs your friends know. Guess what they’re humming before the clock runs out.</p>
      </div>
      <form id="entry" class="panel entry">
        <img class="cat-walk" src="/cat-walking.png" alt="" aria-hidden="true">
        <div class="stack">
          <div><label for="name">Your name</label><input id="name" name="name" maxlength="24" placeholder="Enter a nickname" required autocomplete="nickname"></div>
          ${inviteCode ? '' : '<button class="button primary" name="intent" value="create">Create a room</button>'}
        </div>
        <hr class="divider">
        <label for="room-code">Room code</label>
        <div class="row">
          <input id="room-code" name="code" maxlength="5" placeholder="ABCDE" value="${escapeHtml(inviteCode)}" autocomplete="off" spellcheck="false" autocapitalize="characters">
          <button class="button ${inviteCode ? 'primary' : ''}" name="intent" value="join">Join room</button>
        </div>
        ${inviteCode ? '<p style="margin-top: 12px"><a href="/" class="muted">Create your own room</a></p>' : ''}
      </form>
    </section>`;
  animateHeroNote(app.querySelector('.hero-title'));
}

function animateHeroNote(title) {
  const note = title.querySelector('.bouncing-note');
  const anchors = Object.fromEntries([...title.querySelectorAll('[data-note-anchor]')]
    .map((anchor) => [anchor.dataset.noteAnchor, anchor]));
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const getPosition = (name) => {
    const titleRect = title.getBoundingClientRect();
    const anchorRect = anchors[name].getBoundingClientRect();
    return {
      x: anchorRect.left - titleRect.left + anchorRect.width / 2 - note.offsetWidth / 2,
      y: anchorRect.top - titleRect.top - note.offsetHeight + 22,
    };
  };
  const placeAt = (name) => {
    const { x, y } = getPosition(name);
    note.style.transform = `translate(${x}px, ${y}px)`;
  };
  const moveBetween = async (from, to, duration) => {
    const start = getPosition(from);
    const end = getPosition(to);
    const keyframes = Array.from({ length: 9 }, (_, index) => {
      const progress = index / 8;
      const x = start.x + (end.x - start.x) * progress;
      const y = start.y + (end.y - start.y) * progress - Math.sin(progress * Math.PI * 6) * 8;
      return { transform: `translate(${x}px, ${y}px)`, offset: progress };
    });
    const animation = note.animate(keyframes, { duration, easing: 'linear' });
    await animation.finished.catch(() => {});
    note.style.transform = keyframes.at(-1).transform;
    animation.cancel();
  };

  placeAt('hum');
  note.style.opacity = 1;
  if (reducedMotion) {
    return;
  }
  (async () => {
    while (title.isConnected) {
      await moveBetween('hum', 'dat', 3200);
      if (!title.isConnected) break;
      await moveBetween('dat', 'hum', 3200);
    }
  })();
}

function reset() {
  events?.close();
  clearInterval(syncTimer);
  releaseSessionLock?.();
  releaseSessionLock = undefined;
  releaseMedia();
  releaseRecording();
  guessInProgress = false;
  session = undefined;
  state = undefined;
  renderedPhase = undefined;
  sessionStorage.removeItem(storageKey);
  history.replaceState(null, '', '/');
  inviteCode = '';
  showHome();
}

function connect(nextSession) {
  session = nextSession;
  sessionStorage.setItem(storageKey, JSON.stringify(session));
  header.innerHTML = `<div class="header-actions">${button('Copy invite', 'invite')}${button('Leave room', 'leave', 'subtle')}</div>`;
  app.innerHTML = '<section class="panel"><p>Connecting to the room…</p></section>';
  events = new EventSource(roomPath(`events?token=${encodeURIComponent(session.token)}`));
  events.onmessage = ({ data }) => applyState(JSON.parse(data), nextSession);
  let syncing = false;
  async function syncRoom() {
    if (syncing || session !== nextSession) return;
    syncing = true;
    try {
      const response = await roomRequest('session', { signal: AbortSignal.timeout(6000) }, nextSession);
      applyState(await response.json(), nextSession);
    } catch (error) {
      if (session === nextSession && [401, 404].includes(error.status)) {
        reset();
        tell('Your room has expired.', true);
      }
    } finally {
      syncing = false;
    }
  }
  syncTimer = setInterval(syncRoom, 2500);
  events.onerror = syncRoom;
}

function applyState(next, nextSession) {
  if (session !== nextSession || (state && next.revision <= state.revision)) return;
  const sameRound = next.round?.id === state?.round?.id;
  if (!sameRound || next.phase === 'reveal') releaseMedia();
  if (state?.phase === 'recording' && (!sameRound || next.phase !== 'recording')) releaseRecording();
  state = next;
  clockOffset = next.serverTime - Date.now();
  renderRoom();
}

function openRoom(nextSession) {
  if (!navigator.locks) {
    connect(nextSession);
    return;
  }
  // Duplicated tabs can inherit sessionStorage. Keep each player in just one tab.
  navigator.locks.request(`humline:${nextSession.token}`, { ifAvailable: true }, (lock) => {
    if (!lock) {
      sessionStorage.removeItem(storageKey);
      showHome();
      const code = document.querySelector('#room-code');
      code.value = nextSession.code;
      tell('This room is open in another tab. Join with a different name to play here.');
      return;
    }
    connect(nextSession);
    return new Promise((resolve) => { releaseSessionLock = resolve; });
  }).catch((error) => {
    showHome();
    tell(error.message, true);
  });
}

function renderRoom() {
  const phaseKey = `${state.phase}:${state.round?.id ?? ''}:${state.you === state.host}:${state.phase === 'reveal' && state.hasNextRound}`;
  if (phaseKey !== renderedPhase) {
    renderedPhase = phaseKey;
    app.innerHTML = '<div class="room-layout"><div id="room-main" class="room-main"></div><aside id="scores" class="panel scoreboard"></aside></div>';
    const stage = document.querySelector('#room-main');
    if (state.phase === 'lobby') stage.innerHTML = poolView();
    else stage.innerHTML = roundView();
  }
  const players = [...state.players].sort((a, b) => b.score - a.score);
  document.querySelector('#scores').innerHTML = `<h3>Players</h3><ol>${players.map((p) => `
    <li><span>${escapeHtml(p.name)}${p.id === state.you ? ' (you)' : ''}
      ${p.id === state.host || !p.online ? `<small>${[p.id === state.host && 'Host', !p.online && 'Offline'].filter(Boolean).join(' · ')}</small>` : ''}
    </span><b>${p.score} pts</b></li>`).join('')}</ol>`;
  if (state.phase === 'lobby') {
    updatePool();
  } else if (state.phase === 'recording') {
    updateRecording();
  } else if (state.round?.hasClip && state.round.canGuess && ['preparing', 'guessing'].includes(state.phase)) {
    loadClue();
  }
  tick();
}

function poolView() {
  return `<div class="room-title">
    <p class="eyebrow">Room ${state.code}</p>
    <h2>Shared song pool</h2>
    <p class="muted">Tap every song you know. Each song marked by at least two players becomes one round.</p>
  </div>
  <section class="panel stack">
    <div class="songs" id="songs" aria-label="Songs"></div>
    <form class="add-form" id="add-song">
      <div><label for="song-title">Song title</label><input id="song-title" name="title" maxlength="80" placeholder="Add a favourite" required></div>
      <div><label for="song-artist">Artist</label><input id="song-artist" name="artist" maxlength="80" placeholder="Artist name" required></div>
      <button class="button" type="submit">Add song</button>
    </form>
    <div id="pool-footer" class="stack"></div>
  </section>`;
}

function updatePool() {
  const songs = document.querySelector('#songs');
  const activeSong = document.activeElement?.dataset.song;
  const songMarkup = state.songs.map((song) => `
    <button type="button" class="song ${song.count >= 2 ? 'shared' : ''}" data-action="known" data-song="${song.id}"
        aria-pressed="${song.known}">
      <span class="song-label"><strong>${escapeHtml(song.title)}</strong><span>${escapeHtml(song.artist)}</span></span>
      <span class="count">${song.count} know</span>
    </button>`).join('');
  if (songs.dataset.content !== songMarkup) {
    songs.dataset.content = songMarkup;
    songs.innerHTML = songMarkup;
    if (activeSong) [...songs.children].find((el) => el.dataset.song === activeSong)?.focus({ preventScroll: true });
  }
  const footer = document.querySelector('#pool-footer');
  const message = state.canStart ? `${state.sharedCount} ${state.sharedCount === 1 ? 'round' : 'rounds'} ready to play.`
    : 'Mark some of the same songs as your friends to start.';
  const footerMarkup = `<p class="muted">${message}</p>${state.you === state.host ? `<div class="row">
    ${button('Start game', 'start', 'primary', !state.canStart)}
  </div>` : ''}`;
  if (footer.dataset.content !== footerMarkup) {
    footer.dataset.content = footerMarkup;
    footer.innerHTML = footerMarkup;
  }
}

function roundView() {
  const { phase, round, you, host, players } = state;
  const name = (id) => escapeHtml(players.find((p) => p.id === id)?.name ?? 'Player');
  const singer = round?.singerId === you;
  const heading = `<p class="eyebrow">Room ${state.code}${round ? ` · Round ${round.number} of ${state.totalRounds}` : ''}</p>`;
  let contents;
  if (phase === 'recording') {
    contents = singer ? `
      <h2>${escapeHtml(round.title)}</h2><p class="muted">${escapeHtml(round.artist)} · Hum up to 12 seconds.</p>
      <div class="audio-controls" id="recording-controls">
        ${button('Record clue', 'record', 'primary')}
        ${button('Stop and send', 'stop')}
        <span id="recording-timer" class="recording-timer"></span>
        <p id="recording-status" class="muted" role="status"></p>
        ${button('Retry sending', 'retry-send')}
      </div>
      <div>${button('Skip song', 'skip', 'subtle')}</div>`
      : `<h2>${name(round.singerId)} is up</h2><p class="muted">They’re recording a clue. Get ready to guess the song title.</p>
        ${you === host ? `<div>${button('Skip turn', 'skip', 'subtle')}</div>` : ''}`;
  } else if (phase === 'preparing') {
    contents = `<h2>Get ready to listen</h2><p class="muted">${singer ? 'Your clue is on its way.' : 'The clue is loading. The guessing clock starts for everyone together.'}</p>`;
  } else if (phase === 'guessing') {
    contents = `<h2>${singer ? 'Your friends are guessing' : '#humdat'}</h2>
      <div class="timer" id="timer" role="timer"></div><div class="timer-track" aria-hidden="true"><div id="timer-bar"></div></div>
      ${round.canGuess ? `<div class="audio-controls">
        <p id="clue-message" class="muted" role="status"></p>
        ${button('Play clue', 'play-clue', 'subtle', true)}
      </div>
      <form class="row" id="guess">
        <input id="guess-title" name="guess" aria-label="Song title" placeholder="Enter song title" maxlength="100" autocomplete="off" required disabled>
        <button class="button primary" disabled>Guess</button>
      </form><p id="correct" role="status" hidden></p>` : ''}`;
  } else if (phase === 'reveal') {
    contents = `<h2>${escapeHtml(round.title)}</h2><p class="muted">${escapeHtml(round.artist)}</p>
      ${round.skipped ? '<p>This turn was skipped.</p>' : `<p>${name(round.singerId)} earned <strong>${round.singerPoints} points</strong>. ${round.results.length} of ${round.listenerCount} listeners guessed correctly.</p>
      ${round.results.length ? `<ul class="results">${round.results.map((result) => `<li>${name(result.id)} guessed it for <strong>${result.points} points</strong></li>`).join('')}</ul>` : '<p>Nobody guessed this one.</p>'}`}
      ${you === host ? `<div>${button(state.hasNextRound ? 'Next round' : 'Final scores', 'next', 'primary')}</div>` : '<p class="muted">Waiting for the host to continue.</p>'}`;
  } else {
    const highScore = Math.max(...players.map((p) => p.score));
    const winners = players.filter((p) => p.score === highScore);
    contents = `<h2>Game over</h2><p>${winners.map((p) => name(p.id)).join(', ')} ${winners.length === 1 ? 'wins' : 'tie'} with <strong>${highScore} points</strong>.</p>
      ${state.totalRounds > 0 && state.remainingRounds ? '<p class="muted">Some rounds could not be played with the players still connected.</p>' : ''}
      ${you === host ? `<div>${button('Play again', 'rematch', 'primary')}</div>` : ''}`;
  }
  return `<section class="panel stage stack">${heading}${contents}</section>`;
}

function releaseMedia() {
  if (!media) return;
  media.controller.abort();
  media.source?.stop();
  media.source?.disconnect();
  media.audio?.pause();
  if (media.url) URL.revokeObjectURL(media.url);
  media = undefined;
}

function enableSound() {
  try {
    // On iOS, the default ambient category follows the phone's silent switch.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {
    // The native player remains available.
  }
  try {
    playbackContext ??= new AudioContext();
    if (playbackContext.state !== 'running') playbackContext.resume().then(tick).catch(() => {});
  } catch {
    // The guessing screen displays the playback status.
  }
}

async function loadClue(attempt = 1) {
  const roundId = state.round.id;
  if (media?.id === roundId) return;
  const current = session;
  const clue = { id: roundId, controller: new AbortController(), buffer: null, source: null, error: false };
  media = clue;
  const timeout = setTimeout(() => clue.controller.abort(), 35000);
  try {
    const response = await roomRequest(`clip?round=${roundId}`, {
      signal: clue.controller.signal,
    }, current);
    const blob = await response.blob();
    if (media !== clue || session !== current) return;
    clue.url = URL.createObjectURL(blob);
    clue.audio = new Audio(clue.url);
    clue.audio.preload = 'auto';
    try {
      clue.buffer = await new OfflineAudioContext(1, 1, 24000).decodeAudioData(await blob.arrayBuffer());
    } catch {
      // Some browsers can play the recording in a media element even when Web Audio cannot decode it.
    }
    if (media !== clue || session !== current) return;
    clue.loaded = true;
    if (state.phase === 'preparing') await action('ready', { roundId }, current);
  } catch {
    if (media === clue && !clue.loaded) {
      clue.error = true;
      if (attempt < 3) setTimeout(() => {
        if (media !== clue) return;
        releaseMedia();
        loadClue(attempt + 1);
      }, 500 * attempt);
    }
  } finally {
    clearTimeout(timeout);
  }
  tick();
}

async function playClue() {
  const clue = media;
  if (!clue?.loaded) return;
  clue.useNative = true;
  clue.source?.stop();
  clue.source = null;
  try {
    clue.audio.currentTime = 0;
    await clue.audio.play();
    if (media === clue) clue.playError = false;
  } catch {
    if (media !== clue) return;
    clue.playError = true;
    clue.useNative = false;
  }
  tick();
}

function tick() {
  if (state?.phase === 'recording') {
    const timer = document.querySelector('#recording-timer');
    if (timer && recording?.recorder?.state === 'recording') {
      timer.textContent = `${Math.max(0, Math.ceil((recording.endsAt - performance.now()) / 1000))} seconds left`;
    }
  }
  if (state?.phase !== 'guessing') return;
  const { round } = state;
  const now = Date.now() + clockOffset;
  const started = now >= round.startsAt;
  const remaining = Math.max(0, round.endsAt - now);
  const seconds = Math.ceil((started ? remaining : round.startsAt - now) / 1000);
  document.querySelector('#timer').textContent = started ? `0:${String(seconds).padStart(2, '0')}` : `Starts in ${seconds}`;
  document.querySelector('#timer-bar').style.transform = `scaleX(${Math.min(1, remaining / (round.endsAt - round.startsAt))})`;
  if (!round.canGuess) return;
  const form = document.querySelector('#guess');
  form.hidden = round.correct;
  for (const element of form.elements) element.disabled = !started || !remaining || round.correct;
  form.querySelector('button').disabled ||= guessInProgress;
  const correct = document.querySelector('#correct');
  correct.hidden = !round.correct;
  if (round.correct) correct.textContent = `Correct! You earned ${round.earned} points.`;
  const playing = playbackContext?.state === 'running';
  const message = media?.error ? 'Could not load the clue.' : !media?.loaded ? 'Loading clue…'
    : media.playError ? 'Could not play the clue. Tap Play clue to try again.'
    : !media.useNative && (!playing || !media.buffer) ? 'Tap Play clue to hear the recording.' : '';
  const clueMessage = document.querySelector('#clue-message');
  if (clueMessage.textContent !== message) clueMessage.textContent = message;
  document.querySelector('[data-action="play-clue"]').disabled = !started || !remaining || !media?.loaded;
  if (remaining && playing && media?.buffer && !media.source && !media.useNative) {
    const source = playbackContext.createBufferSource();
    source.buffer = media.buffer;
    source.connect(playbackContext.destination);
    media.source = source;
    source.onended = () => source.disconnect();
    source.start(playbackContext.currentTime + Math.max(0, round.startsAt - now) / 1000);
  } else if (started && remaining && media?.loaded && !media.buffer && !media.nativeAttempted && !media.useNative) {
    media.nativeAttempted = true;
    playClue();
  }
}

function releaseRecording() {
  if (!recording) return;
  const previous = recording;
  recording = undefined;
  uploadInProgress = false;
  clearTimeout(previous.timer);
  if (previous.recorder?.state === 'recording') previous.recorder.stop();
  previous.stream?.getTracks().forEach((track) => track.stop());
}

function updateRecording() {
  const controls = document.querySelector('#recording-controls');
  if (!controls) return;
  const active = recording?.recorder?.state === 'recording';
  const record = controls.querySelector('[data-action="record"]');
  record.hidden = Boolean(recording);
  const stop = controls.querySelector('[data-action="stop"]');
  stop.hidden = !active;
  const timer = controls.querySelector('#recording-timer');
  timer.hidden = !active;
  controls.querySelector('#recording-status').textContent = recording?.sendingMessage ?? '';
  controls.querySelector('[data-action="retry-send"]').hidden = !recording?.blob || uploadInProgress;
}

async function sendRecording() {
  if (uploadInProgress || !recording?.blob) return;
  const clue = recording;
  uploadInProgress = true;
  clue.sendingMessage = 'Sending clue…';
  updateRecording();
  try {
    const current = session;
    const roundId = state.round.id;
    const bytes = await clue.blob.arrayBuffer();
    let offset = clue.received ?? 0;
    while (offset < bytes.byteLength && recording === clue) {
      const end = Math.min(bytes.byteLength, offset + 12288);
      const path = `clip?round=${roundId}&offset=${offset}&total=${bytes.byteLength}`;
      clue.sendingMessage = `Sending clue… ${Math.floor(100 * offset / bytes.byteLength)}%`;
      updateRecording();
      try {
        const response = await roomRequest(path, {
          method: 'POST', headers: { 'Content-Type': clue.blob.type }, body: bytes.slice(offset, end),
          signal: AbortSignal.timeout(12000),
        }, current);
        const result = await response.json();
        if (result.phase) {
          applyState(result, current);
          break;
        }
        if (result.received !== end) throw new Error('The server could not confirm receipt of the clue.');
        offset = clue.received = end;
        clue.retryOffset = undefined;
      } catch (error) {
        if (clue.retryOffset === offset || error.status < 500) throw error;
        clue.retryOffset = offset;
      }
    }
  } catch (error) {
    if (recording !== clue) return;
    uploadInProgress = false;
    clue.sendingMessage = error.message;
    updateRecording();
  }
}

async function startRecording() {
  if (recording) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error('Recording needs a supported browser using HTTPS or localhost.');
  }
  const next = {};
  recording = next;
  updateRecording();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (recording !== next) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    next.stream = stream;
    const sharedFormat = state.round.formats?.find((type) => MediaRecorder.isTypeSupported(type));
    const mimeType = sharedFormat ?? ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 24000 });
    next.recorder = recorder;
    const chunks = [];
    recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      clearTimeout(next.timer);
      if (recording !== next) return;
      next.sendingMessage = 'Preparing clue…';
      updateRecording();
      const original = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type });
      try {
        if (!original.size) throw new Error('The recording was empty. Try again.');
        if (sharedFormat) {
          next.blob = original;
        } else {
          const decoder = new OfflineAudioContext(1, 1, 24000);
          const decoded = await decoder.decodeAudioData(await original.arrayBuffer());
          if (recording !== next) return;
          next.blob = encodeWav(decoded);
        }
        await sendRecording();
      } catch (error) {
        if (recording !== next) return;
        releaseRecording();
        tell(original.size ? 'Could not prepare this recording for playback. Try again.' : error.message, true);
      }
      updateRecording();
    };
    recorder.onerror = () => {
      if (recording !== next) return;
      releaseRecording();
      updateRecording();
      tell('The recording failed. Try again.', true);
    };
    recorder.start();
    next.endsAt = performance.now() + 12_000;
    next.timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 12_000);
    updateRecording();
    tick();
  } catch (error) {
    if (recording !== next) return;
    releaseRecording();
    updateRecording();
    if (error.name === 'NotAllowedError') throw new Error('Allow microphone access in your browser to record a clue.');
    throw error;
  }
}

document.addEventListener('submit', async (event) => {
  const form = event.target;
  event.preventDefault();
  const data = new FormData(form);
  const submitter = event.submitter ?? form.querySelector('button');
  if (submitter.disabled) return;
  enableSound();
  submitter.disabled = true;
  try {
    if (form.id === 'entry') {
      const code = String(data.get('code')).trim().toUpperCase();
      const joining = submitter.value === 'join' || (submitter.value !== 'create' && code);
      if (joining && !/^[A-Z2-9]{5}$/.test(code)) throw new Error('Enter the five-character room code.');
      for (const element of form.querySelectorAll('button')) element.disabled = true;
      const probe = new Audio();
      const formats = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'].filter((type) => probe.canPlayType(type));
      const response = await request(joining ? `/api/rooms/${code}/join` : '/api/rooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.get('name'), formats }),
      }).finally(() => {
        for (const element of form.querySelectorAll('button')) element.disabled = false;
      });
      openRoom(await response.json());
    } else if (form.id === 'add-song') {
      await action('add-song', { title: data.get('title'), artist: data.get('artist') });
      form.reset();
    } else if (form.id === 'guess') {
      if (guessInProgress) return;
      guessInProgress = true;
      const { correct } = await action('guess', { guess: data.get('guess'), roundId: state.round.id });
      if (!correct) {
        tell('Try another title.');
        form.elements.guess.select();
      }
    }
  } catch (error) {
    tell(error.message, true);
  } finally {
    submitter.disabled = false;
    if (form.id === 'guess') {
      guessInProgress = false;
      tick();
    }
  }
});

document.addEventListener('click', async (event) => {
  enableSound();
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const type = control.dataset.action;
  try {
    if (type === 'leave') {
      control.disabled = true;
      try {
        await action('leave');
      } finally {
        reset();
      }
    } else if (type === 'invite') {
      const url = new URL('/', location.href);
      url.searchParams.set('room', session.code);
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(url.href);
          tell(`Invite copied. Room ${session.code}.`);
          return;
        } catch {
          // Display the code if clipboard permission is unavailable.
        }
      }
      tell(`Share this code with friends: ${session.code}`);
    } else if (type === 'record') {
      await startRecording();
    } else if (type === 'stop') {
      if (recording?.recorder?.state === 'recording') recording.recorder.stop();
    } else if (type === 'play-clue') {
      await playClue();
    } else if (type === 'retry-send') {
      await sendRecording();
    } else if (type === 'known') {
      control.disabled = true;
      try {
        await action(type, { songId: control.dataset.song, known: control.getAttribute('aria-pressed') !== 'true' });
      } finally {
        control.disabled = false;
      }
    } else {
      control.disabled = true;
      try {
        await action(type, { roundId: state.round?.id });
      } finally {
        control.disabled = false;
      }
    }
  } catch (error) {
    tell(error.message, true);
  }
});

setInterval(tick, 100);
let saved;
try { saved = JSON.parse(sessionStorage.getItem(storageKey)); } catch { /* Start at the entry screen. */ }
if (saved?.token && /^[A-Z2-9]{5}$/.test(saved.code) && (!inviteCode || inviteCode === saved.code)) openRoom(saved);
else showHome();
