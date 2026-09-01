const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const gameContainerEl = document.getElementById('game-container');
const scoreEl = document.getElementById('score');
const messageEl = document.getElementById('message');
const nameEntryEl = document.getElementById('name-entry');
const nameInputEl = document.getElementById('name-input');
const nameErrorEl = document.getElementById('name-error');
const saveScoreBtn = document.getElementById('save-score-btn');
const skipScoreBtn = document.getElementById('skip-score-btn');
const leaderboardListEl = document.getElementById('leaderboard-list');
const darkModeToggleEl = document.getElementById('dark-mode-toggle');

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playTone(frequency, duration, startTime, volume) {
  const ac = getAudioContext();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'square';
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, ac.currentTime + startTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + startTime + duration);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(ac.currentTime + startTime);
  osc.stop(ac.currentTime + startTime + duration);
}

function playJumpSound() {
  const ac = getAudioContext();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(300, ac.currentTime);
  osc.frequency.exponentialRampToValueAtTime(750, ac.currentTime + 0.12);
  gain.gain.setValueAtTime(0.15, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.15);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + 0.15);
}

function playMilestoneSound() {
  const notes = [523.25, 659.25, 783.99, 1046.5]; // arcade-style ascending arpeggio (C5 E5 G5 C6)
  notes.forEach((freq, i) => playTone(freq, 0.15, i * 0.1, 0.18));
}

const LEADERBOARD_SIZE = 100;

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function renderLeaderboard() {
  const { data, error } = await supabaseClient
    .from('leaderboard')
    .select('name, score')
    .order('score', { ascending: false })
    .limit(LEADERBOARD_SIZE);

  if (error) {
    console.error('Erro ao carregar o leaderboard:', error);
    return;
  }

  leaderboardListEl.innerHTML = '';
  data.forEach((entry) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'lb-name';
    name.textContent = entry.name;
    const points = document.createElement('span');
    points.className = 'lb-score';
    points.textContent = entry.score;
    li.appendChild(name);
    li.appendChild(points);
    leaderboardListEl.appendChild(li);
  });
}

async function saveScore(name, points) {
  const { error } = await supabaseClient.from('leaderboard').insert({ name, score: points });
  if (error) {
    console.error('Erro ao salvar a pontuação:', error);
  }
  await renderLeaderboard();
}

const GROUND_Y = 170;
const GRAVITY = 0.6;
const JUMP_VELOCITY = -11;
const BASE_SPEED = 6;
const MIN_GAP_FRAMES = 60; // reaction time (in frames) guaranteed between obstacles
const EXTRA_GAP_FRAMES = 40; // random extra reaction time on top of the minimum
const BIRD_DUCK_Y = GROUND_Y - 60; // high bird: hits standing dino only, avoid by ducking
const BIRD_JUMP_Y = GROUND_Y - 38; // mid bird: hits standing and ducking dino, avoid by jumping
const MILESTONE_FREEZE_FRAMES = 120; // ~2s at 60fps: how long score counting pauses at each 100
const MAX_SCORE = 9999;
const DAY_BG = '#f7f7f7';
const NIGHT_BG = '#535353';
const DAY_FG = '#535353';
const NIGHT_FG = '#f7f7f7';
const DAY_CLOUD = '#c7c7c7';
const NIGHT_CLOUD = '#838383';

let darkMode = false;
try {
  darkMode = localStorage.getItem('dino-dark-mode') === 'true';
} catch {
  // storage blocked (private mode, site data disabled): fall back to light mode
}

function setDarkMode(enabled) {
  darkMode = enabled;
  try {
    localStorage.setItem('dino-dark-mode', String(enabled));
  } catch {
    // preference just won't persist
  }
  darkModeToggleEl.textContent = enabled ? '☼' : '☾';
  gameContainerEl.classList.toggle('night', enabled);
  document.body.classList.toggle('night', enabled);
}

darkModeToggleEl.addEventListener('click', () => setDarkMode(!darkMode));
setDarkMode(darkMode);

let speed = BASE_SPEED;
let score = 0;
let highScore = 0;
try {
  highScore = Math.floor(Number(sessionStorage.getItem('dino-high-score')) || 0);
} catch {
  // storage blocked: high score just starts at zero
}
let frame = 0;
let running = false;
let started = false;
let obstacles = [];
let clouds = [];
let distanceSinceSpawn = 0;
let nextSpawnGap = 0;
let awaitingName = false;
let pendingScore = 0;
let lastMilestone = 0;
let milestoneFreezeFrames = 0;

function triggerMilestone() {
  scoreEl.classList.remove('milestone');
  void scoreEl.offsetWidth; // restart the CSS animation
  scoreEl.classList.add('milestone');
}

function scheduleNextObstacle() {
  nextSpawnGap = (MIN_GAP_FRAMES + Math.random() * EXTRA_GAP_FRAMES) * speed;
}

const dino = {
  x: 50,
  y: GROUND_Y - 47,
  width: 44,
  height: 47,
  vy: 0,
  ducking: false,
  legFrame: 0,
};

function resetGame() {
  speed = BASE_SPEED;
  score = 0;
  frame = 0;
  lastMilestone = 0;
  scoreEl.classList.remove('milestone');
  obstacles = [];
  clouds = [];
  dino.y = GROUND_Y - dino.height;
  dino.vy = 0;
  dino.ducking = false;
  running = true;
  started = true;
  distanceSinceSpawn = 0;
  scheduleNextObstacle();
  messageEl.classList.add('hidden');
}

function gameOver() {
  running = false;
  const flooredFinalScore = Math.floor(score);
  if (flooredFinalScore > highScore) {
    highScore = flooredFinalScore;
    try {
      sessionStorage.setItem('dino-high-score', String(highScore));
    } catch {
      // high score just won't survive a reload
    }
  }
  pendingScore = flooredFinalScore;
  awaitingName = true;
  messageEl.classList.add('hidden');
  nameEntryEl.classList.remove('hidden');
  nameInputEl.value = '';
  nameInputEl.classList.remove('error');
  nameErrorEl.classList.add('hidden');
  nameInputEl.focus();
}

const touchControlsQuery = window.matchMedia('(max-width: 900px), (pointer: coarse)');

function restartMessage() {
  return touchControlsQuery.matches
    ? 'Pressione uma das setas para reiniciar'
    : 'Pressione ESPAÇO para reiniciar';
}

async function submitName() {
  const name = nameInputEl.value.trim();
  if (!name) {
    nameInputEl.classList.add('error');
    nameErrorEl.classList.remove('hidden');
    nameInputEl.focus();
    return;
  }
  awaitingName = false;
  nameEntryEl.classList.add('hidden');
  messageEl.textContent = 'Salvando pontuação...';
  messageEl.classList.remove('hidden');
  await saveScore(name.toUpperCase().slice(0, 10), pendingScore);
  messageEl.textContent = restartMessage();
}

function skipNameEntry() {
  awaitingName = false;
  nameEntryEl.classList.add('hidden');
  messageEl.textContent = restartMessage();
  messageEl.classList.remove('hidden');
}

saveScoreBtn.addEventListener('click', submitName);
skipScoreBtn.addEventListener('click', skipNameEntry);
nameInputEl.addEventListener('input', () => {
  nameInputEl.classList.remove('error');
  nameErrorEl.classList.add('hidden');
});
nameInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitName();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    skipNameEntry();
  }
});

function jump() {
  if (awaitingName) return;
  if (!started) {
    resetGame();
    return;
  }
  if (!running) {
    resetGame();
    return;
  }
  if (dino.y >= GROUND_Y - dino.height && !dino.ducking) {
    dino.vy = JUMP_VELOCITY;
    playJumpSound();
  }
}

function setDuck(isDucking) {
  if (dino.y >= GROUND_Y - dino.height) {
    dino.ducking = isDucking;
  }
}

document.addEventListener('keydown', (e) => {
  if (awaitingName) return;
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    jump();
  } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
    e.preventDefault();
    setDuck(true);
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowDown' || e.code === 'KeyS') {
    setDuck(false);
  }
});

canvas.addEventListener('mousedown', jump);
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  jump();
}, { passive: false });

const duckBtnEl = document.getElementById('duck-btn');
const jumpBtnEl = document.getElementById('jump-btn');

jumpBtnEl.addEventListener('touchstart', (e) => {
  e.preventDefault();
  jump();
}, { passive: false });

duckBtnEl.addEventListener('touchstart', (e) => {
  e.preventDefault();
  setDuck(true);
}, { passive: false });

duckBtnEl.addEventListener('touchend', (e) => {
  e.preventDefault();
  setDuck(false);
});

duckBtnEl.addEventListener('touchcancel', (e) => {
  e.preventDefault();
  setDuck(false);
});

function spawnObstacle() {
  const roll = Math.random();
  if (roll < 0.25 && score > 300) {
    // bird
    const heights = [BIRD_DUCK_Y, BIRD_JUMP_Y];
    obstacles.push({
      type: 'bird',
      x: canvas.width + 20,
      y: heights[Math.floor(Math.random() * heights.length)],
      width: 46,
      height: 34,
      wingFrame: 0,
    });
  } else if (roll < 0.6) {
    // small cactus cluster
    const count = 1 + Math.floor(Math.random() * 3);
    obstacles.push({
      type: 'cactus',
      x: canvas.width + 20,
      y: GROUND_Y - 35,
      width: 17 * count,
      height: 35,
    });
  } else {
    // large cactus
    obstacles.push({
      type: 'cactus',
      x: canvas.width + 20,
      y: GROUND_Y - 47,
      width: 25,
      height: 47,
    });
  }
}

function spawnCloud() {
  clouds.push({
    x: canvas.width + 20,
    y: 20 + Math.random() * 60,
    width: 46,
  });
}

function update() {
  frame++;

  if (milestoneFreezeFrames > 0) {
    milestoneFreezeFrames--;
  } else if (score < MAX_SCORE) {
    score = Math.min(score + 0.15, MAX_SCORE);
  }
  speed = BASE_SPEED + Math.min(score / 100, 6);

  const flooredScore = Math.floor(score);
  if (flooredScore > 0 && flooredScore % 100 === 0 && flooredScore !== lastMilestone) {
    lastMilestone = flooredScore;
    milestoneFreezeFrames = MILESTONE_FREEZE_FRAMES;
    triggerMilestone();
    playMilestoneSound();
  }

  // dino physics
  dino.vy += GRAVITY;
  dino.y += dino.vy;
  if (dino.y > GROUND_Y - dino.height) {
    dino.y = GROUND_Y - dino.height;
    dino.vy = 0;
  }
  if (frame % 6 === 0) {
    dino.legFrame = 1 - dino.legFrame;
  }

  // obstacles
  distanceSinceSpawn += speed;
  if (distanceSinceSpawn >= nextSpawnGap) {
    spawnObstacle();
    distanceSinceSpawn = 0;
    scheduleNextObstacle();
  }
  obstacles.forEach((o) => {
    o.x -= speed;
    if (o.type === 'bird' && frame % 10 === 0) {
      o.wingFrame = 1 - o.wingFrame;
    }
  });
  obstacles = obstacles.filter((o) => o.x + o.width > 0);

  // clouds
  if (frame % 120 === 0) spawnCloud();
  clouds.forEach((c) => (c.x -= speed * 0.3));
  clouds = clouds.filter((c) => c.x + c.width > 0);

  // collision
  const dHeight = dino.ducking ? 25 : dino.height;
  const dY = dino.ducking ? GROUND_Y - 25 : dino.y;
  const dBox = { x: dino.x + 6, y: dY + 4, width: dino.width - 12, height: dHeight - 8 };

  for (const o of obstacles) {
    const oBox = { x: o.x + 3, y: o.y + 3, width: o.width - 6, height: o.height - 6 };
    if (
      dBox.x < oBox.x + oBox.width &&
      dBox.x + dBox.width > oBox.x &&
      dBox.y < oBox.y + oBox.height &&
      dBox.y + dBox.height > oBox.y
    ) {
      gameOver();
      break;
    }
  }
}

function drawGround(fg) {
  ctx.strokeStyle = fg;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(canvas.width, GROUND_Y);
  ctx.stroke();
}

function drawDino(fg, bg) {
  ctx.fillStyle = fg;
  if (dino.ducking) {
    const y = GROUND_Y - 25;
    ctx.fillRect(dino.x, y, 58, 25);
    ctx.fillRect(dino.x + 45, y - 10, 15, 12);
  } else {
    ctx.fillRect(dino.x, dino.y, dino.width, dino.height - 8);
    ctx.fillRect(dino.x + 28, dino.y - 4, 16, 20);
    // legs animation
    if (running) {
      if (dino.legFrame === 0) {
        ctx.fillRect(dino.x + 6, dino.y + dino.height - 8, 8, 8);
        ctx.fillRect(dino.x + 26, dino.y + dino.height - 8, 8, 8);
      } else {
        ctx.fillRect(dino.x + 10, dino.y + dino.height - 8, 8, 8);
        ctx.fillRect(dino.x + 22, dino.y + dino.height - 8, 8, 8);
      }
    } else {
      ctx.fillRect(dino.x + 8, dino.y + dino.height - 8, 8, 8);
      ctx.fillRect(dino.x + 24, dino.y + dino.height - 8, 8, 8);
    }
    // eye
    ctx.fillStyle = bg;
    ctx.fillRect(dino.x + 34, dino.y, 4, 4);
  }
}

function drawObstacles(fg) {
  ctx.fillStyle = fg;
  obstacles.forEach((o) => {
    if (o.type === 'cactus') {
      ctx.fillRect(o.x, o.y, o.width, o.height);
    } else {
      // bird
      const wingUp = o.wingFrame === 0;
      ctx.beginPath();
      ctx.moveTo(o.x, o.y + 15);
      ctx.lineTo(o.x + 15, wingUp ? o.y : o.y + 15);
      ctx.lineTo(o.x + 23, o.y + 10);
      ctx.lineTo(o.x + 31, wingUp ? o.y : o.y + 15);
      ctx.lineTo(o.x + 46, o.y + 15);
      ctx.lineTo(o.x + 31, o.y + 20);
      ctx.lineTo(o.x + 23, o.y + 15);
      ctx.lineTo(o.x + 15, o.y + 20);
      ctx.closePath();
      ctx.fill();
    }
  });
}

function drawClouds(cloudColor) {
  ctx.fillStyle = cloudColor;
  clouds.forEach((c) => {
    ctx.fillRect(c.x, c.y, c.width, 6);
    ctx.fillRect(c.x + 8, c.y - 4, c.width - 16, 6);
  });
}

function draw() {
  const bg = darkMode ? NIGHT_BG : DAY_BG;
  const fg = darkMode ? NIGHT_FG : DAY_FG;
  const cloudColor = darkMode ? NIGHT_CLOUD : DAY_CLOUD;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawClouds(cloudColor);
  drawGround(fg);
  drawObstacles(fg);
  drawDino(fg, bg);

  scoreEl.textContent =
    String(Math.floor(score)).padStart(5, '0') +
    (highScore > 0 ? '   HI ' + String(highScore).padStart(5, '0') : '');
}

function loop() {
  if (running) {
    update();
  }
  draw();
  requestAnimationFrame(loop);
}

messageEl.textContent = touchControlsQuery.matches
  ? 'Pressione uma das setas para começar'
  : 'Pressione ESPAÇO para começar';

renderLeaderboard();
draw();
loop();
