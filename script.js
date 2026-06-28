/* =============================================
   Workout Coach – script.js
   Full workout engine, state, and UI controller
   ============================================= */

'use strict';

/* ══════════════════════════════════════════
   STATE
══════════════════════════════════════════ */
const DEFAULT_SETTINGS = {
  darkMode:       true,
  sound:          true,
  vibration:      true,
  backpackWeight: 8,    // kg
  restAdjust:     0     // seconds added/removed from default rest
};

let workoutData = null;
let settings    = {};
let progress    = {};
let history     = [];
let calOffset   = 0;

/*
  session.state machine:
    'idle'   – exercise shown, waiting for user to press Start
    'active' – reps: user doing reps / timer: countdown running
    'rest'   – rest overlay is showing between sets OR exercises
    'done'   – workout finished
*/
let session = {
  dayIndex:       0,
  phaseIndex:     0,   // 0=warmup 1=exercises 2=cooldown
  exerciseIndex:  0,
  setIndex:       0,   // which set we are ON (0-based, already completed sets are < setIndex)
  state:          'idle',
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
  pausedRest:     false,
  // What happens after the current rest finishes:
  // 'next_set'      → stay on same exercise, bump setIndex
  // 'next_exercise' → move to next exercise
  restPendingAction: 'next_set'
};

/* ══════════════════════════════════════════
   LOCAL STORAGE
══════════════════════════════════════════ */
const LS = {
  get:  k       => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set:  (k, v)  => localStorage.setItem(k, JSON.stringify(v)),
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
      dayIndex:          session.dayIndex,
      phaseIndex:        session.phaseIndex,
      exerciseIndex:     session.exerciseIndex,
      setIndex:          session.setIndex,
      totalSeconds:      session.totalSeconds,
      exercisesDone:     session.exercisesDone,
      startTime:         session.startTime,
      restPendingAction: session.restPendingAction
    });
  },
  clearSession() { localStorage.removeItem('wc_session'); }
};

/* ══════════════════════════════════════════
   AUDIO
══════════════════════════════════════════ */
const SoundFX = {
  ctx: null,
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
  restFinish() { [660, 880, 1100].forEach((f, i) => setTimeout(() => this.beep(f, 0.18), i * 130)); },
  tick()       { this.beep(440, 0.06, 'square'); },
  done()       { this.beep(1320, 0.3); setTimeout(() => this.beep(1100, 0.2), 160); }
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
function getDay(i)               { return workoutData.days[i]; }
function getPhase(day, phase) {
  const d = getDay(day);
  if (phase === 0) return d.warmup   || [];
  if (phase === 1) return d.exercises;
  if (phase === 2) return d.cooldown || [];
  return [];
}
function getCurrentExercise() {
  return getPhase(session.dayIndex, session.phaseIndex)[session.exerciseIndex] || null;
}
function countTotalExercises(di) {
  const d = getDay(di);
  return (d.warmup?.length || 0) + d.exercises.length + (d.cooldown?.length || 0);
}
function getRestDuration(ex) {
  const base = ex.rest ?? 60;
  return Math.max(0, base + (settings.restAdjust || 0));
}
function exerciseIcon(ex) {
  const map = {
    'push':    '💪', 'squat': '🦵', 'lunge':   '🦵', 'plank':    '🧱',
    'run':     '🏃', 'cycle': '🚴', 'walk':    '🚶', 'stretch':  '🧘',
    'climb':   '🧗', 'raise': '🦵', 'curl':    '💪', 'mountain': '⛰️',
    'recover': '🌿', 'rest':  '😴', 'diamond': '💪', 'pike':     '💪',
    'decline': '💪', 'calf':  '🦶', 'hip':     '🦵', 'leg':      '🦵',
    'side':    '🧘', 'arm':   '🤸', 'wrist':   '🤸', 'shoulder': '🤸',
    'jumping': '🤸', 'full':  '🏋️'
  };
  const n = (ex.name || '').toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (n.includes(key)) return emoji;
  }
  return '🏋️';
}
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2,'0')}:${r.toString().padStart(2,'0')}`;
}
function estimateCalories(seconds, type) {
  const mets = { push: 7, legs: 8, cardio: 10, full: 8, recovery: 3, rest: 1 };
  const met = mets[type] || 6;
  return Math.round((met * 70 * seconds) / 3600);
}
function peekNextExercise() {
  const phase  = getPhase(session.dayIndex, session.phaseIndex);
  const next   = session.exerciseIndex + 1;
  if (next < phase.length) return phase[next];
  const np = getPhase(session.dayIndex, session.phaseIndex + 1);
  return np[0] || null;
}

/* ══════════════════════════════════════════
   SCREEN ROUTER
══════════════════════════════════════════ */
const Screens = {
  go(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`screen-${id}`).classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.screen === id);
    });
  }
};

/* ══════════════════════════════════════════
   HOME SCREEN
══════════════════════════════════════════ */
function renderHome() {
  if (!workoutData) return;
  const total     = workoutData.days.length;
  const completed = Object.keys(progress).filter(k => progress[k]?.completed).length;
  const pct       = Math.round((completed / total) * 100);

  // Ring
  const circ = 2 * Math.PI * 54;
  const fill = document.getElementById('progress-ring-fill');
  if (fill) {
    fill.setAttribute('stroke-dasharray', circ);
    fill.setAttribute('stroke-dashoffset', circ - (circ * pct / 100));
  }
  document.getElementById('progress-pct').textContent = pct + '%';
  document.getElementById('progress-sub').textContent = `${completed} of ${total} days complete`;

  // Day chips
  const grid = document.getElementById('day-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const savedSess = LS.get('wc_session');
  workoutData.days.forEach((day, i) => {
    const chip = document.createElement('button');
    chip.className  = 'day-chip';
    chip.textContent = i + 1;
    if (progress[i]?.completed) chip.classList.add('completed');
    const curDay = savedSess ? savedSess.dayIndex : completed;
    if (i === curDay && !progress[i]?.completed) chip.classList.add('current');
    chip.addEventListener('click', () => startDay(i));
    grid.appendChild(chip);
  });

  // Stats
  const streak    = calcStreak();
  const totalSec  = history.reduce((a, h) => a + (h.duration || 0), 0);
  const totalKcal = history.reduce((a, h) => a + (h.calories  || 0), 0);
  document.getElementById('stat-streak').textContent = streak + '🔥';
  document.getElementById('stat-time').textContent   = formatTime(totalSec);
  document.getElementById('stat-kcal').textContent   = totalKcal;
}

function calcStreak() {
  if (!history.length) return 0;
  const dates    = [...new Set(history.map(h => h.date))].sort().reverse();
  const today    = new Date().toISOString().slice(0, 10);
  let streak     = 0;
  let expected   = today;
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
  // Stop any running intervals from a previous session
  clearInterval(session.clockInterval);
  clearInterval(session.timerInterval);
  clearInterval(session.restInterval);

  const savedSess = LS.get('wc_session');
  if (savedSess && savedSess.dayIndex === dayIndex) {
    // Resume
    Object.assign(session, {
      dayIndex:          savedSess.dayIndex,
      phaseIndex:        savedSess.phaseIndex,
      exerciseIndex:     savedSess.exerciseIndex,
      setIndex:          savedSess.setIndex,
      totalSeconds:      savedSess.totalSeconds,
      exercisesDone:     savedSess.exercisesDone,
      startTime:         savedSess.startTime,
      restPendingAction: savedSess.restPendingAction || 'next_set',
      state:             'idle',
      timerInterval:     null,
      restInterval:      null,
      clockInterval:     null,
      pausedTimer:       false,
      pausedRest:        false
    });
  } else {
    // Fresh start
    Object.assign(session, {
      dayIndex:          dayIndex,
      phaseIndex:        0,
      exerciseIndex:     0,
      setIndex:          0,
      totalSeconds:      0,
      exercisesDone:     0,
      startTime:         Date.now(),
      restPendingAction: 'next_set',
      state:             'idle',
      timerInterval:     null,
      restInterval:      null,
      clockInterval:     null,
      pausedTimer:       false,
      pausedRest:        false
    });
    LS.saveSession();
  }

  hideRestTimer(false); // hide without triggering callback
  renderWorkout();
  Screens.go('workout');
}

/* ══════════════════════════════════════════
   WORKOUT PLAYER
══════════════════════════════════════════ */
function renderWorkout() {
  const day = getDay(session.dayIndex);
  const ex  = getCurrentExercise();

  if (!ex) { finishWorkout(); return; }

  // Header
  document.getElementById('workout-day-title').textContent = `Day ${session.dayIndex + 1} – ${day.title}`;
  document.getElementById('workout-day-icon').textContent  = day.icon;

  // Phase badge
  const phaseBadge = document.getElementById('phase-badge');
  const phaseNames  = ['Warm Up', 'Workout', 'Cool Down'];
  phaseBadge.textContent = phaseNames[session.phaseIndex];
  phaseBadge.className   = 'phase-badge ' + ['phase-warmup','phase-workout','phase-cooldown'][session.phaseIndex];

  // Progress bar
  const totalEx = countTotalExercises(session.dayIndex);
  let done = 0;
  for (let p = 0; p < session.phaseIndex; p++) done += getPhase(session.dayIndex, p).length;
  done += session.exerciseIndex;
  document.getElementById('workout-progress-fill').style.width = `${Math.round((done / totalEx) * 100)}%`;

  // Exercise info
  document.getElementById('ex-icon').textContent = exerciseIcon(ex);
  document.getElementById('ex-name').textContent = ex.name;
  const noteEl = document.getElementById('ex-note');
  noteEl.textContent    = ex.note || '';
  noteEl.style.display  = ex.note ? 'block' : 'none';
  document.getElementById('set-indicator').textContent =
    ex.sets > 1 ? `Set ${session.setIndex + 1} of ${ex.sets}` : '';

  renderSetDots(ex);

  // Rep vs timer UI
  const repsDisplay  = document.getElementById('reps-display');
  const timerDisplay = document.getElementById('timer-display');
  const actionZone   = document.getElementById('action-zone');

  if (ex.type === 'reps') {
    repsDisplay.classList.remove('hidden');
    timerDisplay.classList.add('hidden');
    document.getElementById('big-number').textContent = ex.reps;
    document.getElementById('big-label').textContent  = 'REPS';

    actionZone.innerHTML = `
      <button class="btn-start" id="btn-main">▶ Start</button>
      <div class="nav-btns-row">
        <button class="btn-secondary" id="btn-prev-ex">← Prev</button>
        <button class="btn-secondary" id="btn-skip-set">Skip Set →</button>
      </div>
    `;
    document.getElementById('btn-main').addEventListener('click', handleRepsAction);

  } else {
    // timer exercise
    repsDisplay.classList.add('hidden');
    timerDisplay.classList.remove('hidden');
    // Only reset display if we're not already mid-timer
    if (session.state !== 'active') {
      renderCircularTimer(ex.duration, ex.duration);
    }

    actionZone.innerHTML = `
      <button class="btn-start" id="btn-main">▶ Start Timer</button>
      <div class="nav-btns-row">
        <button class="btn-secondary" id="btn-pause-ex">⏸ Pause</button>
        <button class="btn-secondary" id="btn-skip-set">Skip Set →</button>
      </div>
    `;
    document.getElementById('btn-main').addEventListener('click', handleTimerAction);
    document.getElementById('btn-pause-ex').addEventListener('click', handlePauseTimer);
  }

  // Skip Set skips the CURRENT SET only (not the whole exercise)
  document.getElementById('btn-skip-set')?.addEventListener('click', skipCurrentSet);
  document.getElementById('btn-prev-ex')?.addEventListener('click', prevExercise);

  // Workout clock
  if (!session.clockInterval) {
    session.clockInterval = setInterval(() => {
      session.totalSeconds++;
      LS.saveSession();
    }, 1000);
  }
}

function renderSetDots(ex) {
  const container = document.getElementById('set-dots');
  if (!container) return;
  container.innerHTML = '';
  if (ex.sets <= 1) return;
  for (let i = 0; i < ex.sets; i++) {
    const dot = document.createElement('div');
    dot.className = 'set-dot';
    if (i < session.setIndex)      dot.classList.add('done');
    else if (i === session.setIndex) dot.classList.add('active');
    dot.textContent = i + 1;
    container.appendChild(dot);
  }
}

function renderCircularTimer(remaining, total) {
  const circ = 2 * Math.PI * 88;
  const fill = document.getElementById('ctimer-fill');
  if (fill) {
    fill.setAttribute('stroke-dasharray', circ);
    fill.setAttribute('stroke-dashoffset', circ - (circ * (Math.max(0, remaining) / (total || 1))));
  }
  const el = document.getElementById('ctimer-seconds');
  if (el) el.textContent = formatTime(remaining);
}

/* ── Reps flow ── */
function handleRepsAction() {
  const ex = getCurrentExercise();
  SoundFX.getCtx(); // wake AudioContext on user gesture
  if (session.state !== 'active') {
    // Mark set as started
    session.state = 'active';
    const btn = document.getElementById('btn-main');
    btn.textContent = '✓ Done';
    btn.classList.add('green');
    vibrate(50);
  } else {
    // Set completed
    session.state = 'idle';
    SoundFX.done();
    vibrate([50, 30, 50]);
    session.exercisesDone++;
    completeSet(ex);
  }
}

/* ── Timer flow ── */
function handleTimerAction() {
  const ex = getCurrentExercise();
  if (session.state === 'active') return; // already running
  SoundFX.getCtx();
  session.state          = 'active';
  session.timerTotal     = ex.duration;
  session.timerRemaining = ex.duration;
  session.pausedTimer    = false;
  const btn = document.getElementById('btn-main');
  if (btn) { btn.textContent = '⏹ Running…'; btn.disabled = true; }
  runExerciseTimer(ex);
}

function runExerciseTimer(ex) {
  clearInterval(session.timerInterval);
  session.timerInterval = setInterval(() => {
    if (session.pausedTimer) return;
    session.timerRemaining--;
    renderCircularTimer(session.timerRemaining, session.timerTotal);
    if (session.timerRemaining <= 3 && session.timerRemaining > 0) SoundFX.tick();
    if (session.timerRemaining <= 0) {
      clearInterval(session.timerInterval);
      session.timerInterval = null;
      session.state = 'idle';
      SoundFX.done();
      vibrate([50, 30, 50]);
      session.exercisesDone++;
      completeSet(ex);
    }
  }, 1000);
}

function handlePauseTimer() {
  session.pausedTimer = !session.pausedTimer;
  const btn = document.getElementById('btn-pause-ex');
  if (btn) btn.textContent = session.pausedTimer ? '▶ Resume' : '⏸ Pause';
}

/* ══════════════════════════════════════════
   CORE SET / EXERCISE ADVANCEMENT
   This is the heart of the bug fix.

   completeSet(ex):
     Called when a set finishes (reps done OR timer elapsed).
     - If there are more sets:  show rest → then render same exercise with setIndex+1
     - If all sets done:        show rest → then move to next exercise
     
   skipCurrentSet():
     Skip the CURRENT set in progress.
     - If there are more sets remaining: go directly to next set (no rest), re-render same exercise
     - If this was the last set:         go directly to next exercise (no rest)
     
   btn-rest-skip (in rest overlay):
     Skip the REST ONLY. The pending action (next_set or next_exercise) still fires immediately.
══════════════════════════════════════════ */
function completeSet(ex) {
  clearInterval(session.timerInterval);
  session.timerInterval = null;
  const setsLeft = ex.sets - (session.setIndex + 1); // how many sets remain after this one

  if (setsLeft > 0) {
    // More sets to go → rest then show next set of SAME exercise
    session.restPendingAction = 'next_set';
    LS.saveSession();
    const restDur = getRestDuration(ex);
    if (restDur > 0) {
      showRestTimer(restDur, ex, () => {
        session.setIndex++;
        session.state = 'idle';
        LS.saveSession();
        renderWorkout();
      });
    } else {
      session.setIndex++;
      session.state = 'idle';
      LS.saveSession();
      renderWorkout();
    }
  } else {
    // Last set → rest then move to NEXT EXERCISE
    session.restPendingAction = 'next_exercise';
    LS.saveSession();
    const nextEx  = peekNextExercise();
    const restDur = getRestDuration(ex);
    if (nextEx && restDur > 0) {
      showRestTimer(restDur, nextEx, () => {
        session.setIndex = 0;
        session.state    = 'idle';
        moveToNextExercise();
        renderWorkout();
      });
    } else {
      session.setIndex = 0;
      session.state    = 'idle';
      moveToNextExercise();
      renderWorkout();
    }
  }
}

/*
  Skip the CURRENT SET only.
  - Does NOT skip the exercise.
  - Does NOT show a rest (you're skipping it mid-set).
  - Just advances to the next set, or to the next exercise if last set.
*/
function skipCurrentSet() {
  // Stop any running timer for this set
  clearInterval(session.timerInterval);
  session.timerInterval = null;
  session.state         = 'idle';
  session.pausedTimer   = false;

  const ex       = getCurrentExercise();
  if (!ex) return;
  const setsLeft = ex.sets - (session.setIndex + 1);

  if (setsLeft > 0) {
    // More sets remain → just advance set counter, no rest
    session.setIndex++;
    LS.saveSession();
    renderWorkout();
  } else {
    // Was the last set → move to next exercise, no rest
    session.setIndex = 0;
    moveToNextExercise();
    LS.saveSession();
    renderWorkout();
  }
}

/*
  Move to the next exercise (or next phase, or finish).
  Does NOT touch setIndex — caller must reset it.
*/
function moveToNextExercise() {
  const phase = getPhase(session.dayIndex, session.phaseIndex);
  session.exerciseIndex++;

  if (session.exerciseIndex >= phase.length) {
    // End of this phase → move to next phase
    session.exerciseIndex = 0;
    session.phaseIndex++;

    // Skip empty phases (e.g. empty warmup/cooldown)
    while (session.phaseIndex <= 2 && getPhase(session.dayIndex, session.phaseIndex).length === 0) {
      session.phaseIndex++;
    }

    if (session.phaseIndex > 2) {
      // No more phases → workout done
      finishWorkout();
      return;
    }
  }

  session.state = 'idle';
  LS.saveSession();
}

/*
  Go back one exercise (Prev button).
*/
function prevExercise() {
  clearInterval(session.timerInterval);
  session.timerInterval = null;
  clearInterval(session.restInterval);
  session.restInterval  = null;
  hideRestTimer(false);

  session.setIndex    = 0;
  session.state       = 'idle';
  session.pausedTimer = false;

  if (session.exerciseIndex > 0) {
    session.exerciseIndex--;
  } else if (session.phaseIndex > 0) {
    session.phaseIndex--;
    const prev = getPhase(session.dayIndex, session.phaseIndex);
    session.exerciseIndex = Math.max(0, prev.length - 1);
  }

  LS.saveSession();
  renderWorkout();
}

/* ══════════════════════════════════════════
   REST TIMER
══════════════════════════════════════════ */
function showRestTimer(duration, nextEx, onFinish) {
  session.state         = 'rest';
  session.restTotal     = duration;
  session.restRemaining = duration;
  session.pausedRest    = false;
  session._restOnFinish = onFinish; // store so skip can call it

  const overlay = document.getElementById('rest-overlay');
  overlay.classList.add('visible');

  const nameEl = document.getElementById('rest-next-name');
  if (nameEl) nameEl.textContent = nextEx?.name || 'Continue';

  // Reset pause button label
  const pauseBtn = document.getElementById('btn-rest-pause');
  if (pauseBtn) pauseBtn.textContent = '⏸ Pause';

  renderRestCircle(duration, duration);

  clearInterval(session.restInterval);
  session.restInterval = setInterval(() => {
    if (session.pausedRest) return;
    session.restRemaining--;
    renderRestCircle(session.restRemaining, session.restTotal);
    if (session.restRemaining <= 3 && session.restRemaining > 0) SoundFX.tick();
    if (session.restRemaining <= 0) {
      clearInterval(session.restInterval);
      session.restInterval = null;
      SoundFX.restFinish();
      vibrate([100, 50, 100, 50, 200]);
      hideRestTimer(true); // true = fire callback
    }
  }, 1000);
}

function renderRestCircle(remaining, total) {
  const circ = 2 * Math.PI * 88;
  const fill = document.getElementById('rest-ring-fill');
  if (fill) {
    fill.setAttribute('stroke-dasharray', circ);
    fill.setAttribute('stroke-dashoffset', circ - (circ * (Math.max(0, remaining) / (total || 1))));
  }
  const el = document.getElementById('rest-seconds');
  if (el) el.textContent = formatTime(remaining);
}

/*
  hideRestTimer(fireCallback):
    fireCallback=true  → rest finished naturally or skip pressed → run the pending action
    fireCallback=false → cancelled (back button, startDay reset) → do nothing
*/
function hideRestTimer(fireCallback) {
  clearInterval(session.restInterval);
  session.restInterval = null;
  document.getElementById('rest-overlay').classList.remove('visible');
  const cb = session._restOnFinish;
  session._restOnFinish = null;
  session.state = 'idle';
  if (fireCallback && cb) cb();
}

/* ══════════════════════════════════════════
   FINISH WORKOUT
══════════════════════════════════════════ */
function finishWorkout() {
  clearInterval(session.clockInterval);
  clearInterval(session.timerInterval);
  clearInterval(session.restInterval);
  session.clockInterval = null;
  session.timerInterval = null;
  session.restInterval  = null;

  const day = getDay(session.dayIndex);
  const dur = session.totalSeconds;
  const cal = estimateCalories(dur, day.type);

  progress[session.dayIndex] = {
    completed: true,
    date:      new Date().toISOString().slice(0, 10),
    duration:  dur,
    calories:  cal
  };

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
  const colors = ['#6c63ff','#ff6584','#43e97b','#ffd60a','#a78bfa','#38f9d7'];
  const particles = Array.from({ length: 120 }, () => ({
    x:        Math.random() * canvas.width,
    y:        -20,
    vx:       (Math.random() - 0.5) * 4,
    vy:       Math.random() * 3 + 2,
    size:     Math.random() * 8 + 4,
    color:    colors[Math.floor(Math.random() * colors.length)],
    rotation: Math.random() * Math.PI * 2,
    rotV:     (Math.random() - 0.5) * 0.2
  }));
  let frames = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.06; p.rotation += p.rotV;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
      ctx.restore();
    });
    if (++frames < 180) requestAnimationFrame(draw);
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
    renderCalendar();
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
      </div>`;
    list.appendChild(item);
  });
  renderCalendar();
}

function renderCalendar() {
  const now    = new Date();
  const d      = new Date(now.getFullYear(), now.getMonth() + calOffset, 1);
  const year   = d.getFullYear();
  const month  = d.getMonth();
  document.getElementById('cal-label').textContent =
    d.toLocaleString('default', { month: 'long', year: 'numeric' });

  const workedDates = new Set(history.map(h => h.date));
  const today       = now.toISOString().slice(0, 10);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay    = new Date(year, month, 1).getDay();

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  for (let i = 0; i < firstDay; i++) {
    const b = document.createElement('div');
    b.className = 'cal-day empty';
    grid.appendChild(b);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const el = document.createElement('div');
    el.className  = 'cal-day';
    el.textContent = day;
    if (ds === today)              el.classList.add('today');
    else if (workedDates.has(ds))  el.classList.add('worked');
    grid.appendChild(el);
  }
}

/* ══════════════════════════════════════════
   SETTINGS SCREEN
══════════════════════════════════════════ */
function renderSettings() {
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
   NAV + GLOBAL EVENTS
══════════════════════════════════════════ */
function bindNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sc = btn.dataset.screen;
      Screens.go(sc);
      if (sc === 'home')     renderHome();
      if (sc === 'history')  renderHistory();
      if (sc === 'settings') renderSettings();
    });
  });

  // Home CTAs
  document.getElementById('btn-continue')?.addEventListener('click', () => {
    const saved     = LS.get('wc_session');
    const completed = Object.keys(progress).filter(k => progress[k]?.completed).length;
    const dayIndex  = saved ? saved.dayIndex : Math.min(completed, workoutData.days.length - 1);
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
      session.clockInterval = null;
      session.timerInterval = null;
      hideRestTimer(false);
      Screens.go('home');
      renderHome();
    }
  });

  // Rest overlay – Pause/Resume
  document.getElementById('btn-rest-pause')?.addEventListener('click', () => {
    session.pausedRest = !session.pausedRest;
    const btn = document.getElementById('btn-rest-pause');
    if (btn) btn.textContent = session.pausedRest ? '▶ Resume' : '⏸ Pause';
  });

  // Rest overlay – Skip Rest
  // Skips the REST ONLY. Fires the pending callback (next set or next exercise) immediately.
  document.getElementById('btn-rest-skip')?.addEventListener('click', () => {
    hideRestTimer(true); // fire callback = go to whatever was next
  });

  // Complete screen
  document.getElementById('btn-go-home')?.addEventListener('click', () => {
    Screens.go('home');
    renderHome();
  });
}

/* ══════════════════════════════════════════
   PWA
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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
}

/* ══════════════════════════════════════════
   INIT
══════════════════════════════════════════ */
async function init() {
  LS.load();
  try {
    const res   = await fetch('./workout.json');
    workoutData = await res.json();
  } catch {
    document.body.innerHTML =
      '<p style="color:white;padding:40px;font-family:sans-serif">⚠️ Could not load workout.json.<br>Please serve via a local server or Netlify.</p>';
    return;
  }

  bindNav();
  bindSettings();
  initPWA();
  renderHome();
  Screens.go('home');

  // Resume banner
  const savedSess = LS.get('wc_session');
  if (savedSess) {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;bottom:80px;left:20px;right:20px;z-index:99;padding:14px 18px;background:rgba(108,99,255,0.95);border-radius:16px;display:flex;align-items:center;gap:12px;color:#fff;font-weight:600;font-size:14px;backdrop-filter:blur(20px);box-shadow:0 8px 32px rgba(108,99,255,0.4)';
    banner.innerHTML = `
      <span style="flex:1">▶ Day ${savedSess.dayIndex + 1} in progress</span>
      <button onclick="this.parentElement.remove();startDay(${savedSess.dayIndex})"
        style="border:none;background:rgba(255,255,255,0.2);color:#fff;padding:8px 14px;border-radius:10px;font-weight:700;cursor:pointer">
        Resume
      </button>
      <button onclick="this.parentElement.remove()"
        style="border:none;background:none;color:rgba(255,255,255,0.6);font-size:20px;cursor:pointer;padding:0 4px">
        ×
      </button>`;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 8000);
  }
}

window.startDay = startDay;
document.addEventListener('DOMContentLoaded', init);
