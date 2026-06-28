/* =============================================
   Workout Coach – script.js
   Full workout engine, state, and UI controller
   ============================================= */

'use strict';

/* ══════════════════════════════════════════
   STATE
══════════════════════════════════════════ */
const DEFAULT_SETTINGS = {
  restTimeMultiplier: 1.0,   // 0.5 / 1.0 / 1.5 / 2.0
  darkMode: true,
  sound: true,
  vibration: true,
  backpackWeight: 8,         // kg
  restAdjust: 0              // seconds added/removed from default rest
};

let workoutData = null;     // loaded from workout.json
let settings    = {};
let progress    = {};       // per-day progress stored in LS
let history     = [];       // completed workout records
let calOffset   = 0;        // calendar month offset

// Live workout session state
let session = {
  dayIndex:       0,        // 0-based
  phaseIndex:     0,        // 0=warmup 1=exercises 2=cooldown
  exerciseIndex:  0,
  setIndex:       0,
  state:          'idle',   // idle | active | rest | done
  startTime:      null,
  totalSeconds:   0,
  exercisesDone:  0,
  timerInterval:  null,
  restInterval:   null,
  clockInterval:  null,
  timerTotal:     0,
  timerRemaining: 0,
  restTotal:      0,
  restRemaining:  0,
  pausedTimer:    false,
  pausedRest:     false
};

/* ══════════════════════════════════════════
   LOCAL STORAGE
══════════════════════════════════════════ */
const LS = {
  get: k        => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v)   => localStorage.setItem(k, JSON.stringify(v)),
  load() {
    settings = { ...DEFAULT_SETTINGS, ...(LS.get('wc_settings') || {}) };
    progress = LS.get('wc_progress') || {};
    history  = LS.get('wc_history')  || [];
  },
  save() {
    LS.set('wc_settings', settings);
    LS.set('wc_progress', progress);
    LS.set('wc_history',  history);
  },
  saveSession() {
    LS.set('wc_session', {
      dayIndex:      session.dayIndex,
      phaseIndex:    session.phaseIndex,
      exerciseIndex: session.exerciseIndex,
      setIndex:      session.setIndex,
      totalSeconds:  session.totalSeconds,
      exercisesDone: session.exercisesDone,
      startTime:     session.startTime
    });
  },
  clearSession() { localStorage.removeItem('wc_session'); }
};

/* ══════════════════════════════════════════
   AUDIO
══════════════════════════════════════════ */
const Audio = {
  ctx: null,
  init() {
    // Lazy init on user interaction
  },
  getCtx() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    }
    return this.ctx;
  },
  beep(freq = 880, dur = 0.12, type = 'sine') {
    if (!settings.sound) return;
    const ctx = this.getCtx();
    if (!ctx) return;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur);
  },
  restFinish() {
    // Three rising tones
    [660, 880, 1100].forEach((f, i) => setTimeout(() => this.beep(f, 0.18), i * 130));
  },
  tick() { this.beep(440, 0.06, 'square'); },
  done() { this.beep(1320, 0.3); setTimeout(() => this.beep(1100, 0.2), 160); }
};

/* ══════════════════════════════════════════
   VIBRATION
══════════════════════════════════════════ */
function vibrate(pattern) {
  if (!settings.vibration) return;
  if (navigator.vibrate) navigator.vibrate(pattern);
}

/* ══════════════════════════════════════════
   DATA HELPERS
══════════════════════════════════════════ */
function getDay(dayIndex) {
  return workoutData.days[dayIndex];
}

function getPhase(dayIndex, phaseIndex) {
  const day = getDay(dayIndex);
  if (phaseIndex === 0) return day.warmup  || [];
  if (phaseIndex === 1) return day.exercises;
  if (phaseIndex === 2) return day.cooldown || [];
  return [];
}

function getCurrentExercise() {
  return getPhase(session.dayIndex, session.phaseIndex)[session.exerciseIndex] || null;
}

function countTotalExercises(dayIndex) {
  const day = getDay(dayIndex);
  return (day.warmup?.length || 0) + day.exercises.length + (day.cooldown?.length || 0);
}

function getRestDuration(exercise) {
  const base = exercise.rest ?? 60;
  const adjusted = base + (settings.restAdjust || 0);
  return Math.max(5, adjusted);
}

function exerciseIcon(ex) {
  const map = {
    'push': '💪', 'squat': '🦵', 'lunge': '🦵', 'plank': '🧱',
    'run': '🏃', 'cycle': '🚴', 'walk': '🚶', 'stretch': '🧘',
    'climb': '🧗', 'raise': '🦵', 'curl': '💪', 'dip': '💪',
    'row': '🚣', 'rest': '😴', 'recover': '🌿', 'mountain': '⛰️'
  };
  const n = (ex.name || '').toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (n.includes(key)) return emoji;
  }
  return '🏋️';
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

function estimateCalories(seconds, type) {
  // rough estimate: ~5-8 cal/min depending on type
  const mets = { push: 7, legs: 8, cardio: 10, full: 8, recovery: 3, rest: 1 };
  const met = mets[type] || 6;
  return Math.round((met * 70 * seconds) / (3600)); // 70kg assumption
}

/* ══════════════════════════════════════════
   SCREEN ROUTER
══════════════════════════════════════════ */
const Screens = {
  current: 'home',
  go(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`screen-${id}`).classList.add('active');
    // Update nav
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.screen === id);
    });
    this.current = id;
  }
};

/* ══════════════════════════════════════════
   HOME SCREEN
══════════════════════════════════════════ */
function renderHome() {
  if (!workoutData) return;

  const totalDays   = workoutData.days.length;
  const completedDays = Object.keys(progress).filter(k => progress[k]?.completed).length;
  const pct = Math.round((completedDays / totalDays) * 100);

  // Progress ring
  const radius = 54;
  const circ   = 2 * Math.PI * radius;
  const fill   = document.getElementById('progress-ring-fill');
  if (fill) {
    fill.setAttribute('stroke-dasharray', circ);
    fill.setAttribute('stroke-dashoffset', circ - (circ * pct / 100));
  }
  document.getElementById('progress-pct').textContent  = pct + '%';
  document.getElementById('progress-sub').textContent  =
    `${completedDays} of ${totalDays} days complete`;

  // Day grid
  const grid = document.getElementById('day-grid');
  if (!grid) return;
  grid.innerHTML = '';
  workoutData.days.forEach((day, i) => {
    const chip = document.createElement('button');
    chip.className = 'day-chip';
    chip.textContent = i + 1;
    if (progress[i]?.completed) chip.classList.add('completed');
    // Find current active day
    const savedSess = LS.get('wc_session');
    const curDay = savedSess ? savedSess.dayIndex : completedDays;
    if (i === curDay && !progress[i]?.completed) chip.classList.add('current');
    chip.addEventListener('click', () => startDay(i));
    grid.appendChild(chip);
  });

  // Stats
  const streak   = calcStreak();
  const totalSec  = history.reduce((a, h) => a + (h.duration || 0), 0);
  const totalKcal = history.reduce((a, h) => a + (h.calories || 0), 0);
  document.getElementById('stat-streak').textContent = streak + '🔥';
  document.getElementById('stat-time').textContent   = formatTime(totalSec);
  document.getElementById('stat-kcal').textContent   = totalKcal;
}

function calcStreak() {
  // Count consecutive days worked out ending today
  if (!history.length) return 0;
  const dates  = [...new Set(history.map(h => h.date))].sort().reverse();
  const today  = new Date().toISOString().slice(0, 10);
  let streak   = 0;
  let expected = today;
  for (const d of dates) {
    if (d === expected) {
      streak++;
      const dt = new Date(expected);
      dt.setDate(dt.getDate() - 1);
      expected = dt.toISOString().slice(0, 10);
    } else break;
  }
  return streak;
}

function startDay(dayIndex) {
  // Restore or fresh start
  const savedSess = LS.get('wc_session');
  if (savedSess && savedSess.dayIndex === dayIndex) {
    Object.assign(session, savedSess, { state: 'idle', timerInterval: null, restInterval: null, clockInterval: null });
  } else {
    session.dayIndex       = dayIndex;
    session.phaseIndex     = 0;
    session.exerciseIndex  = 0;
    session.setIndex       = 0;
    session.totalSeconds   = 0;
    session.exercisesDone  = 0;
    session.state          = 'idle';
    session.startTime      = Date.now();
    LS.saveSession();
  }
  renderWorkout();
  Screens.go('workout');
}

/* ══════════════════════════════════════════
   WORKOUT PLAYER
══════════════════════════════════════════ */
function renderWorkout() {
  const day = getDay(session.dayIndex);
  const ex  = getCurrentExercise();

  if (!ex) {
    finishWorkout();
    return;
  }

  // Header
  document.getElementById('workout-day-title').textContent = `Day ${session.dayIndex + 1} – ${day.title}`;
  document.getElementById('workout-day-icon').textContent  = day.icon;

  // Phase badge
  const phaseBadge = document.getElementById('phase-badge');
  const phaseNames = ['Warm Up', 'Workout', 'Cool Down'];
  phaseBadge.textContent = phaseNames[session.phaseIndex];
  phaseBadge.className   = 'phase-badge';
  phaseBadge.classList.add(['phase-warmup','phase-workout','phase-cooldown'][session.phaseIndex]);

  // Overall progress bar
  const totalEx   = countTotalExercises(session.dayIndex);
  let doneCount   = 0;
  for (let p = 0; p < session.phaseIndex; p++) doneCount += getPhase(session.dayIndex, p).length;
  doneCount += session.exerciseIndex;
  document.getElementById('workout-progress-fill').style.width = `${Math.round((doneCount / totalEx) * 100)}%`;

  // Exercise info
  document.getElementById('ex-icon').textContent = exerciseIcon(ex);
  document.getElementById('ex-name').textContent = ex.name;
  document.getElementById('ex-note').textContent = ex.note || '';
  document.getElementById('ex-note').style.display = ex.note ? 'block' : 'none';
  document.getElementById('set-indicator').textContent =
    ex.sets > 1 ? `Set ${session.setIndex + 1} of ${ex.sets}` : '';

  // Set dots
  renderSetDots(ex);

  // Rep vs timer display
  const repsDisplay  = document.getElementById('reps-display');
  const timerDisplay = document.getElementById('timer-display');
  const actionZone   = document.getElementById('action-zone');

  if (ex.type === 'reps') {
    repsDisplay.classList.remove('hidden');
    timerDisplay.classList.add('hidden');
    document.getElementById('big-number').textContent = ex.reps;
    document.getElementById('big-label').textContent  = 'REPS';

    actionZone.innerHTML = `
      <button class="btn-start" id="btn-main">
        ${session.state === 'active' ? '✓ Done' : '▶ Start'}
      </button>
      <div class="nav-btns-row">
        <button class="btn-secondary" id="btn-prev-ex">← Prev</button>
        <button class="btn-secondary" id="btn-skip-ex">Skip →</button>
      </div>
    `;
    document.getElementById('btn-main').addEventListener('click', handleRepsAction);

  } else {
    repsDisplay.classList.add('hidden');
    timerDisplay.classList.remove('hidden');
    renderCircularTimer(ex.duration, ex.duration);

    actionZone.innerHTML = `
      <button class="btn-start" id="btn-main">▶ Start Timer</button>
      <div class="nav-btns-row">
        <button class="btn-secondary" id="btn-pause-ex">⏸ Pause</button>
        <button class="btn-secondary" id="btn-skip-ex">Skip →</button>
      </div>
    `;
    document.getElementById('btn-main').addEventListener('click', handleTimerAction);
    document.getElementById('btn-pause-ex').addEventListener('click', handlePauseTimer);
  }

  // Shared skip/prev
  document.getElementById('btn-skip-ex')?.addEventListener('click', skipExercise);
  document.getElementById('btn-prev-ex')?.addEventListener('click', prevExercise);

  // Start workout clock
  if (!session.clockInterval) {
    session.clockInterval = setInterval(() => {
      session.totalSeconds++;
      LS.saveSession();
    }, 1000);
  }

  // Animate entrance
  document.querySelector('.exercise-stage')?.classList.add('fade-in');
}

function renderSetDots(ex) {
  const container = document.getElementById('set-dots');
  if (!container) return;
  container.innerHTML = '';
  if (ex.sets <= 1) return;
  for (let i = 0; i < ex.sets; i++) {
    const dot = document.createElement('div');
    dot.className = 'set-dot';
    if (i < session.setIndex) dot.classList.add('done');
    else if (i === session.setIndex) dot.classList.add('active');
    dot.textContent = i + 1;
    container.appendChild(dot);
  }
}

function renderCircularTimer(remaining, total) {
  const radius = 88;
  const circ   = 2 * Math.PI * radius;
  const fill   = document.getElementById('ctimer-fill');
  if (fill) {
    fill.setAttribute('stroke-dasharray', circ);
    const offset = circ - (circ * (remaining / (total || 1)));
    fill.setAttribute('stroke-dashoffset', offset);
  }
  const el = document.getElementById('ctimer-seconds');
  if (el) el.textContent = formatTime(remaining);
}

/* ── Reps flow ── */
function handleRepsAction() {
  const ex = getCurrentExercise();
  Audio.getCtx(); // wake audio on user gesture
  if (session.state !== 'active') {
    session.state = 'active';
    document.getElementById('btn-main').textContent = '✓ Done';
    document.getElementById('btn-main').classList.add('green');
    vibrate(50);
  } else {
    // Done with set
    Audio.done();
    vibrate([50, 30, 50]);
    session.exercisesDone++;
    advanceSet(ex);
  }
}

/* ── Timer flow ── */
function handleTimerAction() {
  const ex = getCurrentExercise();
  if (session.state !== 'active') {
    Audio.getCtx();
    session.state          = 'active';
    session.timerTotal     = ex.duration;
    session.timerRemaining = ex.duration;
    session.pausedTimer    = false;
    document.getElementById('btn-main').textContent = '⏹ Running…';
    document.getElementById('btn-main').disabled    = true;
    startExerciseTimer(ex);
  }
}

function startExerciseTimer(ex) {
  clearInterval(session.timerInterval);
  session.timerInterval = setInterval(() => {
    if (session.pausedTimer) return;
    session.timerRemaining--;
    renderCircularTimer(session.timerRemaining, session.timerTotal);
    if (session.timerRemaining <= 3 && session.timerRemaining > 0) Audio.tick();
    if (session.timerRemaining <= 0) {
      clearInterval(session.timerInterval);
      Audio.done();
      vibrate([50, 30, 50]);
      session.exercisesDone++;
      advanceSet(ex);
    }
  }, 1000);
}

function handlePauseTimer() {
  session.pausedTimer = !session.pausedTimer;
  const btn = document.getElementById('btn-pause-ex');
  if (btn) btn.textContent = session.pausedTimer ? '▶ Resume' : '⏸ Pause';
}

/* ── Advance set / exercise ── */
function advanceSet(ex) {
  session.setIndex++;
  session.state = 'idle';

  if (session.setIndex >= ex.sets) {
    // All sets done → next exercise
    session.setIndex = 0;
    const restDur = getRestDuration(ex);

    // Start rest if there is a next exercise
    const nextEx = peekNextExercise();
    if (nextEx && restDur > 0) {
      showRestTimer(restDur, nextEx, () => {
        advanceExercise();
        renderWorkout();
      });
    } else {
      advanceExercise();
      renderWorkout();
    }
  } else {
    // More sets → rest between sets
    const restDur = getRestDuration(ex);
    if (restDur > 0) {
      showRestTimer(restDur, ex, () => renderWorkout());
    } else {
      renderWorkout();
    }
  }
  LS.saveSession();
}

function peekNextExercise() {
  const phase = getPhase(session.dayIndex, session.phaseIndex);
  const nextIdx = session.exerciseIndex + 1;
  if (nextIdx < phase.length) return phase[nextIdx];
  const nextPhase = getPhase(session.dayIndex, session.phaseIndex + 1);
  return nextPhase[0] || null;
}

function advanceExercise() {
  const phase = getPhase(session.dayIndex, session.phaseIndex);
  session.exerciseIndex++;
  if (session.exerciseIndex >= phase.length) {
    session.exerciseIndex = 0;
    session.phaseIndex++;
    if (session.phaseIndex > 2) {
      finishWorkout();
      return;
    }
    // Skip empty phases
    while (session.phaseIndex <= 2 && getPhase(session.dayIndex, session.phaseIndex).length === 0) {
      session.phaseIndex++;
    }
    if (session.phaseIndex > 2) { finishWorkout(); return; }
  }
  session.state = 'idle';
  LS.saveSession();
}

function skipExercise() {
  clearInterval(session.timerInterval);
  session.setIndex  = 0;
  session.state     = 'idle';
  advanceExercise();
  hideRestTimer();
  renderWorkout();
}

function prevExercise() {
  clearInterval(session.timerInterval);
  session.setIndex = 0;
  session.state    = 'idle';
  hideRestTimer();
  if (session.exerciseIndex > 0) {
    session.exerciseIndex--;
  } else if (session.phaseIndex > 0) {
    session.phaseIndex--;
    const prev = getPhase(session.dayIndex, session.phaseIndex);
    session.exerciseIndex = Math.max(0, prev.length - 1);
  }
  renderWorkout();
}

/* ══════════════════════════════════════════
   REST TIMER
══════════════════════════════════════════ */
function showRestTimer(duration, nextEx, onFinish) {
  session.state        = 'rest';
  session.restTotal    = duration;
  session.restRemaining = duration;
  session.pausedRest   = false;

  const overlay = document.getElementById('rest-overlay');
  overlay.classList.add('visible');

  const nameEl = document.getElementById('rest-next-name');
  if (nameEl) nameEl.textContent = nextEx?.name || 'Next Exercise';

  renderCircularTimer(duration, duration); // reuse big timer visually (it's separate SVG)
  renderRestCircle(duration, duration);

  clearInterval(session.restInterval);
  session.restInterval = setInterval(() => {
    if (session.pausedRest) return;
    session.restRemaining--;
    renderRestCircle(session.restRemaining, session.restTotal);
    if (session.restRemaining <= 3 && session.restRemaining > 0) Audio.tick();
    if (session.restRemaining <= 0) {
      clearInterval(session.restInterval);
      Audio.restFinish();
      vibrate([100, 50, 100, 50, 200]);
      hideRestTimer();
      onFinish();
    }
  }, 1000);
}

function renderRestCircle(remaining, total) {
  const radius = 88;
  const circ   = 2 * Math.PI * radius;
  const fill   = document.getElementById('rest-ring-fill');
  if (fill) {
    fill.setAttribute('stroke-dasharray', circ);
    fill.setAttribute('stroke-dashoffset', circ - (circ * (remaining / (total || 1))));
  }
  const el = document.getElementById('rest-seconds');
  if (el) el.textContent = formatTime(remaining);
}

function hideRestTimer() {
  clearInterval(session.restInterval);
  document.getElementById('rest-overlay').classList.remove('visible');
  session.state = 'idle';
}

/* ══════════════════════════════════════════
   FINISH
══════════════════════════════════════════ */
function finishWorkout() {
  clearInterval(session.clockInterval);
  clearInterval(session.timerInterval);
  clearInterval(session.restInterval);
  session.clockInterval = null;

  const day = getDay(session.dayIndex);
  const dur = session.totalSeconds;
  const cal = estimateCalories(dur, day.type);

  // Mark day complete
  progress[session.dayIndex] = {
    completed: true,
    date: new Date().toISOString().slice(0, 10),
    duration: dur,
    calories: cal
  };

  // Add to history
  history.push({
    dayIndex:  session.dayIndex,
    title:     day.title,
    icon:      day.icon,
    type:      day.type,
    duration:  dur,
    calories:  cal,
    exercises: session.exercisesDone,
    date:      new Date().toISOString().slice(0, 10),
    ts:        Date.now()
  });

  LS.save();
  LS.clearSession();

  // Show complete screen
  document.getElementById('complete-time').textContent      = formatTime(dur);
  document.getElementById('complete-exercises').textContent = session.exercisesDone;
  document.getElementById('complete-kcal').textContent      = cal;
  document.getElementById('complete-day').textContent       = `Day ${session.dayIndex + 1}`;
  Screens.go('complete');
  launchConfetti();
}

/* ══════════════════════════════════════════
   CONFETTI
══════════════════════════════════════════ */
function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  const ctx    = canvas.getContext('2d');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const colors    = ['#6c63ff','#ff6584','#43e97b','#ffd60a','#a78bfa','#38f9d7'];

  for (let i = 0; i < 120; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: -20,
      vx: (Math.random() - 0.5) * 4,
      vy: Math.random() * 3 + 2,
      size: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.2
    });
  }

  let frames = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.06;
      p.rotation += p.rotV;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
      ctx.restore();
    });
    frames++;
    if (frames < 180) requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(draw);
}

/* ══════════════════════════════════════════
   HISTORY SCREEN
══════════════════════════════════════════ */
function renderHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  if (!history.length) {
    list.innerHTML = `<div class="empty-state"><div class="big">🏆</div><p>Complete your first workout to see it here!</p></div>`;
    return;
  }
  [...history].reverse().forEach(h => {
    const item = document.createElement('div');
    item.className = 'history-item glass fade-in';
    item.innerHTML = `
      <div class="history-icon">${h.icon}</div>
      <div class="history-text">
        <h3>Day ${h.dayIndex + 1} – ${h.title}</h3>
        <p>${h.date} · ${h.exercises} exercises</p>
      </div>
      <div class="history-meta">
        <div class="dur">${formatTime(h.duration)}</div>
        <div class="kcal">${h.calories} kcal</div>
      </div>
    `;
    list.appendChild(item);
  });
  renderCalendar();
}

function renderCalendar() {
  const now    = new Date();
  const d      = new Date(now.getFullYear(), now.getMonth() + calOffset, 1);
  const year   = d.getFullYear();
  const month  = d.getMonth();
  const label  = d.toLocaleString('default', { month: 'long', year: 'numeric' });

  document.getElementById('cal-label').textContent = label;

  const workedDates = new Set(history.map(h => h.date));
  const today       = now.toISOString().slice(0, 10);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay    = new Date(year, month, 1).getDay(); // 0=Sun

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  for (let i = 0; i < firstDay; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-day empty';
    grid.appendChild(blank);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const el      = document.createElement('div');
    el.className  = 'cal-day';
    el.textContent = d;
    if (dateStr === today)         el.classList.add('today');
    else if (workedDates.has(dateStr)) el.classList.add('worked');
    grid.appendChild(el);
  }
}

/* ══════════════════════════════════════════
   SETTINGS SCREEN
══════════════════════════════════════════ */
function renderSettings() {
  // Sync toggles
  document.getElementById('tog-sound').checked     = settings.sound;
  document.getElementById('tog-vibration').checked = settings.vibration;
  document.getElementById('tog-dark').checked      = settings.darkMode;
  document.getElementById('weight-val').textContent = settings.backpackWeight + ' kg';
  document.getElementById('rest-val').textContent   =
    settings.restAdjust >= 0 ? `+${settings.restAdjust}s` : `${settings.restAdjust}s`;
}

function bindSettings() {
  document.getElementById('tog-sound').addEventListener('change', e => {
    settings.sound = e.target.checked; LS.save();
  });
  document.getElementById('tog-vibration').addEventListener('change', e => {
    settings.vibration = e.target.checked; LS.save();
  });
  document.getElementById('tog-dark').addEventListener('change', e => {
    settings.darkMode = e.target.checked; LS.save();
    // Could toggle light theme here
  });
  document.getElementById('weight-minus').addEventListener('click', () => {
    settings.backpackWeight = Math.max(0, settings.backpackWeight - 1);
    document.getElementById('weight-val').textContent = settings.backpackWeight + ' kg';
    LS.save();
  });
  document.getElementById('weight-plus').addEventListener('click', () => {
    settings.backpackWeight = Math.min(40, settings.backpackWeight + 1);
    document.getElementById('weight-val').textContent = settings.backpackWeight + ' kg';
    LS.save();
  });
  document.getElementById('rest-minus').addEventListener('click', () => {
    settings.restAdjust = Math.max(-30, (settings.restAdjust || 0) - 10);
    document.getElementById('rest-val').textContent =
      settings.restAdjust >= 0 ? `+${settings.restAdjust}s` : `${settings.restAdjust}s`;
    LS.save();
  });
  document.getElementById('rest-plus').addEventListener('click', () => {
    settings.restAdjust = Math.min(120, (settings.restAdjust || 0) + 10);
    document.getElementById('rest-val').textContent =
      settings.restAdjust >= 0 ? `+${settings.restAdjust}s` : `${settings.restAdjust}s`;
    LS.save();
  });
  document.getElementById('btn-reset-progress').addEventListener('click', () => {
    if (confirm('Reset all progress? This cannot be undone.')) {
      progress = {}; history = [];
      LS.save(); LS.clearSession();
      renderHome();
      alert('Progress reset.');
    }
  });
}

/* ══════════════════════════════════════════
   NAV + EVENTS
══════════════════════════════════════════ */
function bindNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sc = btn.dataset.screen;
      Screens.go(sc);
      if (sc === 'home')     renderHome();
      if (sc === 'history')  renderHistory();
      if (sc === 'settings') { renderSettings(); }
    });
  });

  // Home buttons
  document.getElementById('btn-continue')?.addEventListener('click', () => {
    const saved = LS.get('wc_session');
    const completedCount = Object.keys(progress).filter(k => progress[k]?.completed).length;
    const dayIndex = saved ? saved.dayIndex : Math.min(completedCount, workoutData.days.length - 1);
    startDay(dayIndex);
  });

  document.getElementById('btn-new-cycle')?.addEventListener('click', () => {
    if (!progress[0] || confirm('Start a fresh cycle? Your history will be kept.')) {
      progress = {};
      LS.save(); LS.clearSession();
      startDay(0);
    }
  });

  // Calendar nav
  document.getElementById('cal-prev')?.addEventListener('click', () => { calOffset--; renderCalendar(); });
  document.getElementById('cal-next')?.addEventListener('click', () => { calOffset++; renderCalendar(); });

  // Workout back
  document.getElementById('btn-workout-back')?.addEventListener('click', () => {
    if (confirm('Exit workout? Your progress is saved.')) {
      clearInterval(session.clockInterval);
      clearInterval(session.timerInterval);
      clearInterval(session.restInterval);
      session.clockInterval = null;
      hideRestTimer();
      Screens.go('home');
      renderHome();
    }
  });

  // Rest overlay controls
  document.getElementById('btn-rest-pause')?.addEventListener('click', () => {
    session.pausedRest = !session.pausedRest;
    const btn = document.getElementById('btn-rest-pause');
    btn.textContent = session.pausedRest ? '▶ Resume' : '⏸ Pause';
  });
  document.getElementById('btn-rest-skip')?.addEventListener('click', () => {
    clearInterval(session.restInterval);
    hideRestTimer();
    advanceExercise();
    renderWorkout();
  });

  // Complete screen
  document.getElementById('btn-go-home')?.addEventListener('click', () => {
    Screens.go('home');
    renderHome();
  });
}

/* ══════════════════════════════════════════
   PWA INSTALL
══════════════════════════════════════════ */
let deferredInstall = null;
function initPWA() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    const banner = document.getElementById('install-banner');
    if (banner && !localStorage.getItem('pwa-dismissed')) {
      setTimeout(() => banner.classList.add('visible'), 2000);
    }
  });
  document.getElementById('btn-install')?.addEventListener('click', () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      deferredInstall.userChoice.then(() => { deferredInstall = null; });
    }
    document.getElementById('install-banner').classList.remove('visible');
  });
  document.getElementById('btn-install-close')?.addEventListener('click', () => {
    document.getElementById('install-banner').classList.remove('visible');
    localStorage.setItem('pwa-dismissed', '1');
  });

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {
      // Try relative path for file:// serving
      navigator.serviceWorker.register('./service-worker.js').catch(() => {});
    });
  }
}

/* ══════════════════════════════════════════
   INIT
══════════════════════════════════════════ */
async function init() {
  LS.load();

  // Load workout data
  try {
    const res  = await fetch('./workout.json');
    workoutData = await res.json();
  } catch {
    document.body.innerHTML = '<p style="color:white;padding:40px">Error loading workout.json. Please serve via a local server.</p>';
    return;
  }

  bindNav();
  bindSettings();
  initPWA();
  renderHome();
  Screens.go('home');

  // Check for in-progress workout
  const savedSess = LS.get('wc_session');
  if (savedSess) {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;bottom:80px;left:20px;right:20px;z-index:99;padding:14px 18px;background:rgba(108,99,255,0.95);border-radius:16px;display:flex;align-items:center;gap:12px;color:#fff;font-weight:600;font-size:14px;backdrop-filter:blur(20px)';
    banner.innerHTML = `<span style="flex:1">▶ Workout in progress – Day ${savedSess.dayIndex + 1}</span><button onclick="this.parentElement.remove();startDay(${savedSess.dayIndex})" style="border:none;background:rgba(255,255,255,0.2);color:#fff;padding:8px 14px;border-radius:10px;font-weight:700;cursor:pointer">Resume</button><button onclick="this.parentElement.remove()" style="border:none;background:none;color:rgba(255,255,255,0.6);font-size:20px;cursor:pointer">×</button>`;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 8000);
  }
}

// Make startDay global for inline handlers
window.startDay = startDay;

document.addEventListener('DOMContentLoaded', init);
