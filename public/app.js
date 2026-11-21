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
let heroNoteTransition = () => Promise.resolve();
let welcomeSession;
let backgroundMusic;
let roundApplause;
let catalogPreview;
let gameMusicStopped = false;
let soundVolume = 0.3;
const songMetadata = new Map();
let songMetadataLoading = false;
try {
  const savedVolume = localStorage.getItem('humdat-volume');
  if (savedVolume !== null && Number.isFinite(Number(savedVolume))) {
    soundVolume = Math.max(0, Math.min(1, Number(savedVolume)));
  }
} catch { /* Use the default volume when storage is unavailable. */ }

function setSoundVolume(value) {
  soundVolume = Math.max(0, Math.min(1, Number(value)));
  for (const audio of [backgroundMusic, roundApplause, catalogPreview, media?.audio, ...document.querySelectorAll('audio')]) {
    if (audio) audio.volume = soundVolume;
  }
  document.querySelectorAll('[data-volume-slider]').forEach((slider) => {
    slider.value = String(soundVolume);
  });
  try { localStorage.setItem('humdat-volume', String(soundVolume)); } catch { /* Volume still applies for this page. */ }
}

function startBackgroundMusic() {
  if (gameMusicStopped) return;
  if (backgroundMusic && !backgroundMusic.paused) return;
  if (!backgroundMusic) {
    backgroundMusic = new Audio('/background-music.mp3');
    backgroundMusic.loop = true;
    backgroundMusic.volume = soundVolume;
  }
  backgroundMusic.play().catch(() => {});
}

function stopBackgroundMusic() {
  if (!backgroundMusic) return;
  backgroundMusic.pause();
}

function stopCatalogPreview() {
  if (!catalogPreview) return;
  const previous = catalogPreview;
  previous.pause();
  previous.currentTime = 0;
  if (previous.control?.isConnected) previous.control.textContent = 'Play 30 sec preview';
  catalogPreview = undefined;
}

function syncBackgroundMusic(phase) {
  if (phase !== 'lobby') gameMusicStopped = true;
  if (gameMusicStopped || phase === 'recording' || phase === 'preparing') stopBackgroundMusic();
  else startBackgroundMusic();
}

function playRoundApplause() {
  if (!roundApplause) {
    roundApplause = new Audio('/round-applause.mp3');
    roundApplause.volume = soundVolume;
  }
  roundApplause.currentTime = 0;
  roundApplause.play().catch(() => {});
}

function tell(message, isError = false) {
  clearTimeout(toastTimeout);
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.hidden = false;
  toastTimeout = setTimeout(() => { status.hidden = true; }, 4500);
}

function revealNoteTransition() {
  const overlay = document.querySelector('.note-transition-overlay');
  if (!overlay) return;
  const reveal = overlay.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    { duration: 900, easing: 'ease-out', fill: 'forwards' },
  );
  reveal.finished.then(() => overlay.remove()).catch(() => {});
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
  revealNoteTransition();
  startBackgroundMusic();
  header.innerHTML = '';
  app.innerHTML = `
    <section class="hero">
      <div>
        <div class="eyebrow">A music party game</div>
        <h1 class="hero-title">
          <span class="hero-title-line"><span data-note-anchor="hum">h</span>um da<span data-note-anchor="dat">t</span></span>
          <span class="hero-title-line"><span data-note-anchor="song">s</span>on<span data-note-anchor="g">g</span></span>
          <svg class="bouncing-note" viewBox="0 0 237 366" shape-rendering="crispEdges" aria-hidden="true">
            <path fill="#454b4a" fill-rule="evenodd" d="M109 0h37v18h18v18h18v18h18v18h19v20h18v54h-37v-18h-18v-18h-18V92h-18v164h-18v18h-18v18H74v36H18v-18H0v-36h18v-18h19v-18h72z M37 256h37v18H55v18H37z"/>
            <path fill="#171919" d="M146 55h18v18h18v18h18v18h18v18h19v19h-37v-18h-18v-18h-18V92h-18z"/>
            <path fill="#171919" d="M110 274h36v54h-18v18H37v-18H18v-18h56v-18h36z"/>
          </svg>
        </h1>
        <p class="lede">Hum songs your friends know. Guess what they’re humming before the clock runs out.</p>
      </div>
      <form id="entry" class="panel entry">
        <img class="cat-walk" src="/cat-walking.png" alt="" aria-hidden="true">
        <div class="stack">
          ${inviteCode ? `<div class="join-room-intro"><p class="eyebrow">You’re joining</p><h2>Room ${escapeHtml(inviteCode)}</h2><p class="muted">Choose a name to enter the lobby.</p></div>` : ''}
          <div><label for="name">Your name</label><input id="name" name="name" maxlength="24" placeholder="Enter a nickname" required autocomplete="nickname" ${inviteCode ? 'autofocus' : ''}></div>
          ${inviteCode ? '' : '<button class="button primary" name="intent" value="create">Create a room</button>'}
        </div>
        ${inviteCode ? `<input id="room-code" name="code" type="hidden" value="${escapeHtml(inviteCode)}">
          <button class="button primary join-room-button" name="intent" value="join">Join room ${escapeHtml(inviteCode)}</button>
          <p class="entry-alternate"><a href="/" class="muted">Create your own room</a></p>` : `<hr class="divider">
          <label for="room-code">Room code</label>
          <div class="row entry-room-code">
            <input id="room-code" name="code" maxlength="5" placeholder="ABCDE" autocomplete="off" spellcheck="false" autocapitalize="characters">
            <button class="button" name="intent" value="join">Join room</button>
          </div>`}
      </form>
    </section>`;
  animateHeroNote(app.querySelector('.hero-title'));
}

function showWelcome() {
  document.body.classList.add('welcome-active');
  const screen = document.createElement('section');
  screen.className = 'welcome-screen';
  screen.setAttribute('aria-label', 'Welcome to humdat');
  screen.innerHTML = `
    <div class="welcome-content">
      <div class="wordmark welcome-wordmark"><img class="brand-icon" src="/music-note.svg" alt=""> #humdat</div>
      <button class="button primary welcome-start" type="button" data-welcome-start>Start</button>
    </div>`;
  const welcomeVolume = document.createElement('div');
  welcomeVolume.className = 'volume-control welcome-volume';
  welcomeVolume.setAttribute('role', 'group');
  welcomeVolume.setAttribute('aria-label', 'Sound volume');
  welcomeVolume.innerHTML = `<svg class="volume-icon" viewBox="0 0 100 100" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M8 35h30V20h14v60H38V65H8z"/><path fill="currentColor" d="M66 30h10v10h10v20H76v10H66V60h10V40H66zM82 14h10v10h8v52h-8v10H82V76h8V24h-8z"/></svg><input class="volume-slider" data-volume-slider type="range" min="0" max="1" step="0.01" value="${soundVolume}" aria-label="All sound volume" title="All sound volume">`;
  screen.append(welcomeVolume);
  document.body.append(screen);
  startBackgroundMusic();
}

async function beginWelcome() {
  const screen = document.querySelector('.welcome-screen');
  const brand = screen.querySelector('.welcome-wordmark');
  const from = brand.getBoundingClientRect();
  document.body.classList.remove('welcome-active');
  const target = document.querySelector('.topbar .wordmark').getBoundingClientRect();
  const deltaX = target.left - from.left;
  const deltaY = target.top - from.top;
  const scaleX = target.width / from.width;
  const scaleY = target.height / from.height;
  brand.style.position = 'fixed';
  brand.style.left = `${from.left}px`;
  brand.style.top = `${from.top}px`;
  brand.style.margin = '0';
  brand.style.transformOrigin = 'top left';
  brand.style.zIndex = '1';
  const clip = `inset(${target.top}px ${innerWidth - target.right}px ${innerHeight - target.bottom}px ${target.left}px round 12px)`;
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 300 : 900;
  const easing = 'cubic-bezier(.76, 0, .24, 1)';
  const pageMotion = screen.animate([
    { clipPath: 'inset(0 0 0 0 round 0)' },
    { clipPath: clip },
  ], { duration, easing, fill: 'forwards' });
  const logoMotion = brand.animate([
    { transform: 'translate(0, 0) scale(1, 1)' },
    { transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})` },
  ], { duration, easing, fill: 'forwards' });
  await Promise.all([pageMotion.finished, logoMotion.finished]);
  screen.remove();
  if (welcomeSession) {
    const nextSession = welcomeSession;
    welcomeSession = undefined;
    openRoom(nextSession);
  }
}

function animateHeroNote(title) {
  const note = title.querySelector('.bouncing-note');
  const anchors = Object.fromEntries([...title.querySelectorAll('[data-note-anchor]')]
    .map((anchor) => [anchor.dataset.noteAnchor, anchor]));
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let activeMovement;
  let isTransitioning = false;
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
    activeMovement = animation;
    await animation.finished.catch(() => {});
    if (isTransitioning) return;
    note.style.transform = keyframes.at(-1).transform;
    animation.cancel();
    activeMovement = undefined;
  };

  heroNoteTransition = async () => {
    if (isTransitioning || !note.isConnected) return;
    isTransitioning = true;
    activeMovement?.pause();
    const rect = note.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const headerBottom = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
    const transitionTop = Math.max(0, headerBottom);
    const centerY = rect.top + rect.height / 2 - transitionTop;
    const transitionHeight = Math.max(0, innerHeight - transitionTop);
    const radius = Math.ceil(Math.max(
      Math.hypot(centerX, centerY),
      Math.hypot(innerWidth - centerX, centerY),
      Math.hypot(centerX, transitionHeight - centerY),
      Math.hypot(innerWidth - centerX, transitionHeight - centerY),
    ));
    activeMovement?.cancel();
    activeMovement = undefined;
    const overlay = document.createElement('div');
    overlay.className = 'note-transition-overlay';
    overlay.style.top = `${transitionTop}px`;
    overlay.setAttribute('aria-hidden', 'true');
    note.classList.remove('bouncing-note');
    note.classList.add('note-transition-note');
    note.style.left = `${rect.left}px`;
    note.style.top = `${rect.top - transitionTop}px`;
    note.style.width = `${rect.width}px`;
    note.style.height = `${rect.height}px`;
    note.style.transform = 'none';
    overlay.append(note);
    document.body.append(overlay);
    const duration = reducedMotion ? 450 : 900;
    const wipe = overlay.animate([
      { clipPath: `circle(0px at ${centerX}px ${centerY}px)` },
      { clipPath: `circle(${radius}px at ${centerX}px ${centerY}px)` },
    ], { duration, easing: 'ease-in', fill: 'forwards' });
    const zoom = note.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(36)' }],
      { duration, easing: 'ease-in', fill: 'forwards' },
    );
    await Promise.all([wipe.finished, zoom.finished].map((finished) => finished.catch(() => {})));
  };

  placeAt('hum');
  note.style.opacity = 1;
  if (reducedMotion) {
    return;
  }
  (async () => {
    while (title.isConnected && !isTransitioning) {
      await moveBetween('hum', 'dat', 3200);
      if (!title.isConnected || isTransitioning) break;
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
  stopCatalogPreview();
  guessInProgress = false;
  session = undefined;
  state = undefined;
  gameMusicStopped = false;
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
  revealNoteTransition();
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
  const roundStarted = Boolean(state && ['lobby', 'between'].includes(state.phase)
    && next.phase === 'recording' && state.round?.id !== next.round?.id);
  const sameRound = next.round?.id === state?.round?.id;
  if (!sameRound || next.phase === 'reveal') releaseMedia();
  if (state?.phase === 'recording' && (!sameRound || next.phase !== 'recording')) releaseRecording();
  state = next;
  syncBackgroundMusic(next.phase);
  clockOffset = next.serverTime - Date.now();
  renderRoom();
  if (roundStarted) {
    playRoundApplause();
    animateRoundIntro();
  }
}

function animateRoundIntro() {
  const dock = document.querySelector('.round-role-icon');
  if (!dock || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const target = dock.getBoundingClientRect();
  const scale = Math.min(3.2, (innerHeight * .82) / target.height, (innerWidth * .9) / target.width);
  const largeWidth = target.width * scale;
  const largeHeight = target.height * scale;
  const middleX = (innerWidth - largeWidth) / 2;
  const middleY = (innerHeight - largeHeight) / 2;
  const startX = -largeWidth * .72;
  const startY = middleY;
  dock.classList.add('is-intro-hidden');

  const overlay = document.createElement('div');
  overlay.className = 'round-intro-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  const icon = document.createElement('img');
  icon.className = 'round-intro-icon';
  icon.src = dock.src;
  icon.alt = '';
  icon.style.left = `${startX}px`;
  icon.style.top = `${startY}px`;
  icon.style.width = `${largeWidth}px`;
  icon.style.height = `${largeHeight}px`;
  overlay.append(icon);
  document.body.append(overlay);

  const animation = icon.animate([
    { left: `${startX}px`, top: `${startY}px`, width: `${largeWidth}px`, height: `${largeHeight}px`, offset: 0,
      easing: 'cubic-bezier(.2,.7,.3,1)' },
    { left: `${middleX}px`, top: `${middleY}px`, width: `${largeWidth}px`, height: `${largeHeight}px`, offset: .52,
      easing: 'cubic-bezier(.2,.8,.2,1)' },
    { left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, height: `${target.height}px`, offset: 1 },
  ], { duration: 1750, fill: 'forwards' });
  animation.finished.catch(() => {}).then(() => {
    overlay.remove();
    dock.classList.remove('is-intro-hidden');
  });
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
      if (code) code.value = nextSession.code;
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
  const spotify = state.phase === 'lobby' ? `<section class="spotify-connect" aria-labelledby="spotify-heading">
    <p class="eyebrow">Your music</p>
    <h3 id="spotify-heading">Link Spotify</h3>
    <p class="muted">Bring your top tracks into a future round. This preview will not access or save anything yet.</p>
    ${button('Continue with Spotify', 'spotify', 'spotify-button')}
  </section>` : '';
  document.querySelector('#scores').innerHTML = `${spotify}<section class="player-list"><h3>Players</h3><ol>${players.map((p) => `
    <li><span>${escapeHtml(p.name)}${p.id === state.you ? ' (you)' : ''}
      ${p.id === state.host || !p.online ? `<small>${[p.id === state.host && 'Host', !p.online && 'Offline'].filter(Boolean).join(' · ')}</small>` : ''}
    </span><b>${p.score} pts</b></li>`).join('')}</ol></section>`;
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
  <section class="panel lobby-invite">
    <div>
      <p class="eyebrow">Invite friends</p>
      <strong class="invite-code">${state.code}</strong>
      <p class="muted">Scan this QR code to join this room.</p>
    </div>
    <img class="invite-qr" src="/api/rooms/${state.code}/qr" alt="QR code to join room ${state.code}">
  </section>
  <section class="panel stack">
    <div class="songs" id="songs" aria-label="Songs"></div>
    <div id="pool-footer" class="stack"></div>
  </section>`;
}

function songMetadataKey(song) {
  return `${song.title}\u0000${song.artist}`;
}

async function loadSongMetadata() {
  if (songMetadataLoading || state?.phase !== 'lobby') return;
  const missing = state.songs.filter((song) => !songMetadata.has(songMetadataKey(song)));
  if (!missing.length) return;
  songMetadataLoading = true;
  try {
    const response = await request('/api/music', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songs: missing.map(({ title, artist }) => ({ title, artist })) }),
    });
    const { results } = await response.json();
    for (const result of results) {
      songMetadata.set(`${result.title}\u0000${result.artist}`, result.metadata);
    }
    if (state?.phase === 'lobby') updatePool();
  } catch {
    // Covers and samples are enhancements, not a dependency for playing the game.
  } finally {
    songMetadataLoading = false;
  }
}

function updatePool() {
  const songs = document.querySelector('#songs');
  const activeSong = document.activeElement?.dataset.song;
  const songMarkup = state.songs.map((song) => {
    const metadata = songMetadata.get(songMetadataKey(song));
    const cover = metadata?.artworkUrl
      ? `<img class="song-cover" src="${escapeHtml(metadata.artworkUrl)}" alt="Album cover for ${escapeHtml(song.title)}">`
      : '<span class="song-cover song-cover-placeholder" aria-hidden="true">♪</span>';
    const preview = metadata?.previewUrl
      ? `<button type="button" class="preview-button" data-action="preview-song" data-preview="${escapeHtml(metadata.previewUrl)}">Play 30 sec preview</button>`
      : '<span class="preview-unavailable">Preview unavailable</span>';
    const storeLink = metadata?.storeUrl
      ? `<a class="store-link" href="${escapeHtml(metadata.storeUrl)}" target="_blank" rel="noopener noreferrer">View on iTunes ↗</a>`
      : '';
    return `<article class="song-card ${song.count >= 2 ? 'shared' : ''}">
      ${cover}
      <button type="button" class="song" data-action="known" data-song="${song.id}" aria-pressed="${song.known}">
        <span class="song-label"><strong>${escapeHtml(song.title)}</strong><span>${escapeHtml(song.artist)}</span></span>
        <span class="count">${song.count} know</span>
      </button>
      <div class="song-preview">${preview}${storeLink}</div>
    </article>`;
  }).join('');
  if (songs.dataset.content !== songMarkup) {
    songs.dataset.content = songMarkup;
    songs.innerHTML = songMarkup;
    if (activeSong) songs.querySelector(`[data-song="${activeSong}"]`)?.focus({ preventScroll: true });
  }
  loadSongMetadata();
  const footer = document.querySelector('#pool-footer');
  const message = state.canStart ? `${state.sharedCount} ${state.sharedCount === 1 ? 'round' : 'rounds'} ready to play.`
    : 'Mark some of the same songs as your friends to start.';
  const knowsEverySong = state.songs.every((song) => song.known);
  const footerMarkup = `<p class="muted">${message}</p><p class="itunes-attribution">Artwork and previews provided courtesy of iTunes.</p><div class="pool-actions">
    ${button(knowsEverySong ? 'All songs selected' : 'I know every song', 'known-all', 'subtle', knowsEverySong)}
    ${state.you === state.host ? button('Start game', 'start', 'primary', !state.canStart) : ''}
  </div>`;
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
      <div class="hum-visualizer" id="hum-visualizer">
        <canvas class="hum-canvas" id="hum-canvas" aria-hidden="true"></canvas>
        <div class="hum-orb" aria-hidden="true"><span>hum</span></div>
        <p class="hum-caption" id="hum-caption" aria-live="polite">Ready when you are</p>
      </div>
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
    contents = `<div class="guess-vibe" aria-hidden="true">
      <span class="guess-note guess-note-one">♪</span><span class="guess-note guess-note-two">♫</span><span class="guess-note guess-note-three">♪</span>
      <div class="mystery-disc">?</div>
      <div class="sound-bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    </div>
    <div class="guess-heading"><p class="eyebrow">Listen close · guess fast</p><h2>${singer ? 'Your friends are guessing' : 'Name that hum'}</h2>
      <p class="muted">${singer ? 'Keep an eye on the timer — every second counts for your listeners.' : 'Catch the melody, then type the title before the beat drops.'}</p></div>
      <div class="timer" id="timer" role="timer"></div><div class="timer-track" aria-hidden="true"><div id="timer-bar"></div></div>
      ${round.canGuess ? `<div class="audio-controls">
        <p id="clue-message" class="muted" role="status"></p>
        ${button('Play clue again', 'play-clue', 'subtle', true)}
      </div>
      <form class="row" id="guess">
        <input id="guess-title" name="guess" aria-label="Song title" placeholder="Enter song title" maxlength="100" autocomplete="off" required disabled>
        <button class="button primary" disabled>Lock in guess</button>
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
  const roleArt = phase === 'recording' ? `<div class="round-role-art"><img class="round-role-icon" src="/${singer ? 'pixel-microphone.svg' : 'pixel-headphones.svg'}" alt="" aria-hidden="true"></div>` : '';
  return `<section class="panel stage stack${phase === 'recording' ? ' recording-stage' : ''}${phase === 'guessing' ? ' guessing-stage' : ''}">
    <div class="round-stage-copy">${heading}${contents}</div>${roleArt}
  </section>`;
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
    clue.audio.volume = soundVolume;
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

async function playSongPreview(control) {
  const url = control.dataset.preview;
  if (!url) return;
  if (catalogPreview?.src === url && !catalogPreview.paused) {
    stopCatalogPreview();
    control.textContent = 'Play 30 sec preview';
    startBackgroundMusic();
    return;
  }
  stopCatalogPreview();
  stopBackgroundMusic();
  const preview = new Audio(url);
  preview.volume = soundVolume;
  preview.control = control;
  catalogPreview = preview;
  control.textContent = 'Pause preview';
  preview.addEventListener('ended', () => {
    if (catalogPreview !== preview) return;
    catalogPreview = undefined;
    if (control.isConnected) control.textContent = 'Play 30 sec preview';
    startBackgroundMusic();
  }, { once: true });
  try {
    await preview.play();
  } catch {
    if (catalogPreview === preview) catalogPreview = undefined;
    control.textContent = 'Play 30 sec preview';
    startBackgroundMusic();
    throw new Error('Could not play this preview.');
  }
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
  stopHumVisualizer(previous);
  if (previous.recorder?.state === 'recording') previous.recorder.stop();
  previous.stream?.getTracks().forEach((track) => track.stop());
}

function stopHumVisualizer(clue) {
  const visualizer = clue?.visualizer;
  if (!visualizer) return;
  cancelAnimationFrame(visualizer.frame);
  visualizer.source.disconnect();
  visualizer.analyser.disconnect();
  visualizer.context.close().catch(() => {});
  clue.visualizer = undefined;
}

function startHumVisualizer(stream, clue) {
  const canvas = document.querySelector('#hum-canvas');
  const container = document.querySelector('#hum-visualizer');
  const caption = document.querySelector('#hum-caption');
  if (!canvas || !container || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.82;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    const visualizer = { context, analyser, source, spectrum, frame: 0, caption: '' };
    clue.visualizer = visualizer;
    container.classList.add('is-listening');
    context.resume().catch(() => {});

    const draw = () => {
      if (recording !== clue || clue.recorder?.state !== 'recording' || !canvas.isConnected) return;
      const bounds = canvas.getBoundingClientRect();
      const scale = Math.min(devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * scale));
      const height = Math.max(1, Math.round(bounds.height * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const drawing = canvas.getContext('2d');
      drawing.setTransform(scale, 0, 0, scale, 0, 0);
      drawing.clearRect(0, 0, bounds.width, bounds.height);
      analyser.getByteFrequencyData(spectrum);

      const usable = spectrum.slice(2, 160);
      const level = usable.reduce((total, value) => total + value, 0) / (usable.length * 255);
      container.style.setProperty('--hum-level', level.toFixed(3));
      const nextCaption = level > 0.16 ? 'Your hum is painting the room' : 'Give it a hum…';
      if (nextCaption !== visualizer.caption) {
        visualizer.caption = nextCaption;
        caption.textContent = nextCaption;
      }

      const centerX = bounds.width / 2;
      const centerY = bounds.height / 2;
      const baseRadius = Math.min(bounds.width, bounds.height) * 0.23;
      const bars = 72;
      drawing.lineCap = 'round';
      for (let index = 0; index < bars; index++) {
        const value = spectrum[3 + Math.floor(index * 1.8)] / 255;
        const angle = (index / bars) * Math.PI * 2 - Math.PI / 2;
        const inner = baseRadius + 5;
        const outer = inner + 8 + value * (50 + level * 48);
        const hue = 196 + index / bars * 48;
        drawing.strokeStyle = `hsla(${hue}, 62%, ${47 + value * 22}%, ${0.2 + value * 0.8})`;
        drawing.lineWidth = 1.5 + value * 3.5;
        drawing.shadowColor = `hsla(${hue}, 80%, 62%, ${value * 0.75})`;
        drawing.shadowBlur = 8 + value * 16;
        drawing.beginPath();
        drawing.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner);
        drawing.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer);
        drawing.stroke();
      }
      drawing.shadowBlur = 0;
      visualizer.frame = requestAnimationFrame(draw);
    };
    visualizer.frame = requestAnimationFrame(draw);
  } catch {
    // Recording still works when the browser cannot create an analyser.
  }
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
      stopHumVisualizer(next);
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
    startHumVisualizer(stream, next);
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
      const nextSession = await response.json();
      await heroNoteTransition();
      openRoom(nextSession);
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
  const welcomeStart = event.target.closest('[data-welcome-start]');
  if (welcomeStart) {
    welcomeStart.disabled = true;
    startBackgroundMusic();
    try {
      await beginWelcome();
    } catch (error) {
      document.querySelector('.welcome-screen')?.remove();
      document.body.classList.remove('welcome-active');
      tell(error.message, true);
    }
    return;
  }
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
      const url = new URL('/join', location.href);
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
    } else if (type === 'spotify') {
      window.open('https://accounts.spotify.com/login', 'spotify-login', 'popup,width=480,height=720,noopener');
      tell('Spotify sign-in opened. This preview does not access your account yet.');
    } else if (type === 'preview-song') {
      await playSongPreview(control);
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
      if (type === 'start' && state.phase === 'lobby') {
        gameMusicStopped = true;
        stopBackgroundMusic();
      }
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

document.addEventListener('input', (event) => {
  if (event.target.matches('[data-volume-slider]')) setSoundVolume(event.target.value);
});

setInterval(tick, 100);
let saved;
try { saved = JSON.parse(sessionStorage.getItem(storageKey)); } catch { /* Start at the entry screen. */ }
if (saved?.token && /^[A-Z2-9]{5}$/.test(saved.code) && (!inviteCode || inviteCode === saved.code)) welcomeSession = saved;
showHome();
if (!inviteCode) showWelcome();
setSoundVolume(soundVolume);
