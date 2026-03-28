// ═══════════════════════════════════════════════════════
//  AUGMENT — App Logic (Stitch UI)
// ═══════════════════════════════════════════════════════

let currentTab = 'home';
let charts = {};
let taskFilter = 'all';

// Timer state
let timerInterval = null;
let timerSeconds = 25 * 60;
let timerRunning = false;
const TIMER_TOTAL = 25 * 60;
const TIMER_CIRC = 2 * Math.PI * 52;
let calendarView = 'day';
let calendarEventsCache = [];
let calendarIsDemo = false;
let lastCalendarError = '';
const TAB_STORAGE_KEY = 'augment_active_tab';
const HOME_HISTORY_HIDDEN_KEY = 'augment_home_history_hidden';
const PIPELINE_COMPLETED_COLLAPSED_KEY = 'augment_pipeline_completed_collapsed';
let latestTasksCache = [];
let latestGoalsCache = [];

// ── API helper ──────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

// ── Util ────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
function csvEsc(s) { return s ? `"${s.replace(/"/g,'""')}"` : ''; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r.toISOString().split('T')[0]; }
function relDate(d) { if (!d) return ''; const diff = Math.ceil((new Date(d) - new Date()) / 86400000); if (diff < 0) return 'OVERDUE'; if (diff === 0) return 'DUE TODAY'; if (diff === 1) return 'DUE TOMORROW'; return `DUE IN ${diff} DAYS`; }
function formatCronHuman(cronExpr) {
  const parts = String(cronExpr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [min, hour, dom, month, dow] = parts;
  const dowNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const isDaily = dom === '*' && month === '*' && dow === '*';
  const isWeekly = dom === '*' && month === '*' && /^[0-6]$/.test(dow);
  const isHourly = min !== '*' && hour === '*' && dom === '*' && month === '*' && dow === '*';
  const isMinuteStep = /^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && month === '*' && dow === '*';
  const isDailyAtTime = /^\d+$/.test(min) && /^\d+$/.test(hour) && isDaily;

  if (isMinuteStep) {
    const every = min.split('/')[1];
    return `Every ${every} minutes`;
  }

  if (isHourly) {
    return `Every hour at :${String(Number(min)).padStart(2, '0')}`;
  }

  if (isDailyAtTime || isWeekly) {
    const h = Number(hour);
    const m = Number(min);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (isWeekly) return `Every ${dowNames[Number(dow)]} at ${time}`;
    return `Every day at ${time}`;
  }

  return null;
}

function notifyCalendarErrorOnce(msg) {
  if (!msg) return;
  if (lastCalendarError === msg) return;
  lastCalendarError = msg;
  notify(msg, 7000);
}

// ── Navigation ──────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function getSavedTab() {
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    const allowed = ['home', 'strategy', 'velocity', 'rituals', 'calendar'];
    return allowed.includes(saved) ? saved : 'home';
  } catch {
    return 'home';
  }
}

function setSavedTab(tab) {
  try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch {}
}

function isHomeHistoryHidden() {
  try {
    const raw = localStorage.getItem(HOME_HISTORY_HIDDEN_KEY);
    if (raw === null) return true;
    return raw === '1';
  } catch {
    return true;
  }
}

function setHomeHistoryHidden(hidden) {
  try { localStorage.setItem(HOME_HISTORY_HIDDEN_KEY, hidden ? '1' : '0'); } catch {}
}

function applyHomeHistoryHidden(hidden) {
  const layout = document.querySelector('.home-layout');
  if (layout) layout.classList.toggle('hide-history', !!hidden);
}

function isPipelineCompletedCollapsed() {
  try {
    const raw = localStorage.getItem(PIPELINE_COMPLETED_COLLAPSED_KEY);
    if (raw === null) return true;
    return raw === '1';
  } catch {
    return true;
  }
}

function setPipelineCompletedCollapsed(collapsed) {
  try { localStorage.setItem(PIPELINE_COMPLETED_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
}

function switchTab(tab) {
  currentTab = tab;
  setSavedTab(tab);
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));

  // Update topbar context
  const labels = { home: 'PRODUCTIVITY COACHING', strategy: 'STRATEGIC EXECUTION', velocity: 'THE PULSE', rituals: 'SUBCONSCIOUS ARCHITECTURE', calendar: 'SCHEDULE INTELLIGENCE' };
  document.getElementById('topbarContext').textContent = labels[tab] || '';

  if (tab === 'strategy') loadTasksAndGoals();
  if (tab === 'velocity') loadAnalytics();
  if (tab === 'rituals') loadHabits();
  if (tab === 'calendar') {
    setCalendarDateBadge();
    setCalendarView(calendarView);
    loadGoogleWidgets();
  }
}

document.querySelectorAll('#calendarViewToggle .seg').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#calendarViewToggle .seg').forEach(s => s.classList.remove('active'));
    b.classList.add('active');
    setCalendarView(b.dataset.view);
  });
});

// ── Notification ────────────────────────────────────
let notifTimer = null;
function notify(text, dur = 4000) {
  const bar = document.getElementById('notifBar');
  document.getElementById('notifText').textContent = text;
  bar.classList.remove('hidden');
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => bar.classList.add('hidden'), dur);
}
window.dismissNotif = () => document.getElementById('notifBar').classList.add('hidden');

// ── Chat ────────────────────────────────────────────
const chatFeed = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
let currentSessionId = null;
const DURATION_PROFILE_KEY = 'augment_duration_profile_v1';
const TASK_CHECK_STORAGE_KEY = 'augment_task_completion_checks_v1';
const TASK_CHECK_SNOOZE_MIN = 10;
const DURATION_PRESETS = {
  coding: [30, 60, 90, 120],
  learning: [30, 45, 60, 90],
  exercise: [20, 30, 45, 60],
  meeting: [15, 30, 45, 60],
  planning: [15, 30, 45, 60],
  writing: [25, 45, 60, 90],
  default: [30, 60, 120],
};

chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px'; });
sendBtn.addEventListener('click', sendMessage);
window.sendQuickPrompt = t => { chatInput.value = t; sendMessage(); };

async function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  const w = document.getElementById('welcomeState');
  if (w) w.remove();
  appendMsg('user', msg);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  const typing = showTyping();
  try {
    const data = await api('/chat', { method: 'POST', body: { message: msg, session_id: currentSessionId } });
    if(data.session_id && currentSessionId !== data.session_id) {
        currentSessionId = data.session_id;
        loadSessions();
    }
    typing.remove();
    const assistantReply = data.reply || 'Apologies - I could not process that directive.';
    appendMsg('assistant', assistantReply);
    const taskHint = inferTaskFromText(msg);
    if (taskHint) appendDurationPicker(taskHint);
  } catch {
    typing.remove();
    appendMsg('assistant', 'Connection error - is Ollama running?');
  }
  loadSidebarStats();
}

function inferTaskFromText(text) {
  if (!text) return null;
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length < 4) return null;
  const lower = normalized.toLowerCase();
  const looksLikeSmallTalk = /^(hi|hello|hey|yo|how are you|how do you do|good morning|good afternoon|good evening)\b/.test(lower);
  const looksLikeQuestion = /\?$/.test(normalized) || /^(what|why|how|when|where)\b/.test(lower);
  const explicitTaskIntent = /(remind me to|remember to|i need to|i have to|i should|let's|task\s*[:\-]|objective\s*[:\-]|goal\s*[:\-]|work on|start|finish|complete|practice|learn|study|write|read|build|plan)/.test(lower);

  if (looksLikeSmallTalk && !explicitTaskIntent) return null;
  // Avoid showing time picker for normal knowledge questions.
  if (looksLikeQuestion && !explicitTaskIntent) return null;

  const patterns = [
    /(?:remind me to|remember to|i need to|i have to|i should|let's)\s+([^.!?\n]{3,90})/i,
    /(?:task|objective|goal)\s*[:\-]\s*([^.!?\n]{3,90})/i,
    /(?:work on|start|finish|complete|practice|learn|study|write|read|build|plan)\s+([^.!?\n]{3,90})/i,
  ];

  let candidate = null;
  for (const re of patterns) {
    const hit = normalized.match(re);
    if (hit && hit[1]) {
      candidate = hit[1];
      break;
    }
  }

  if (!candidate && !looksLikeQuestion && /(learn|study|practice|work on|build|write|read|exercise|workout|review|plan|debug|design|coding)/.test(lower)) {
    candidate = normalized;
  }

  if (!candidate) return null;
  let clean = candidate
    .replace(/^to\s+/i, '')
    .replace(/\b(?:today|tonight|tomorrow|right now|now)\b/gi, '')
    .replace(/\bfor\s+\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b.*$/i, '')
    .replace(/[.;:,\-]+$/g, '')
    .trim();

  if (clean.length < 3) return null;
  if (clean.length > 80) clean = clean.slice(0, 80).trim();
  return clean;
}

function classifyTask(taskText) {
  const t = String(taskText || '').toLowerCase();
  if (/(code|coding|program|debug|dev|feature|bug|build app|javascript|python)/.test(t)) return 'coding';
  if (/(learn|study|course|tutorial|reading|read|revise|practice)/.test(t)) return 'learning';
  if (/(workout|exercise|gym|run|walk|yoga|training)/.test(t)) return 'exercise';
  if (/(meeting|call|sync|standup|1:1|interview)/.test(t)) return 'meeting';
  if (/(plan|planning|roadmap|strategy|priorit|organize)/.test(t)) return 'planning';
  if (/(write|draft|blog|doc|documentation|journal)/.test(t)) return 'writing';
  return 'default';
}

function getDurationProfile() {
  try {
    const raw = localStorage.getItem(DURATION_PROFILE_KEY);
    if (!raw) return { global: {}, byCategory: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { global: {}, byCategory: {} };
    return {
      global: parsed.global && typeof parsed.global === 'object' ? parsed.global : {},
      byCategory: parsed.byCategory && typeof parsed.byCategory === 'object' ? parsed.byCategory : {},
    };
  } catch {
    return { global: {}, byCategory: {} };
  }
}

function saveDurationProfile(profile) {
  try { localStorage.setItem(DURATION_PROFILE_KEY, JSON.stringify(profile)); } catch {}
}

function getTopDurationMinutes(bucket) {
  return Object.entries(bucket || {})
    .map(([min, count]) => [Number(min), Number(count)])
    .filter(([min, count]) => Number.isFinite(min) && min > 0 && Number.isFinite(count) && count > 0)
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .map(([min]) => min);
}

function normalizeMinuteValue(min) {
  const rounded = Math.round(Number(min) / 5) * 5;
  return Math.min(240, Math.max(10, rounded));
}

function getSuggestedDurations(taskText) {
  const category = classifyTask(taskText);
  const profile = getDurationProfile();
  const categoryTop = getTopDurationMinutes(profile.byCategory[category] || {});
  const globalTop = getTopDurationMinutes(profile.global || {});
  const anchor = categoryTop[0] || globalTop[0] || null;
  const preset = DURATION_PRESETS[category] || DURATION_PRESETS.default;

  if (!anchor) return [...preset];

  const around = [anchor - 15, anchor, anchor + 15, anchor + 45]
    .map(normalizeMinuteValue)
    .filter((m, i, arr) => arr.indexOf(m) === i);

  const filled = [...around];
  for (const m of preset) {
    if (filled.length >= 4) break;
    if (!filled.includes(m)) filled.push(m);
  }
  return filled.sort((a, b) => a - b).slice(0, 4);
}

function formatDurationLabel(min) {
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? '' : 's'}`;
  if (min > 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}h ${m}m`;
  }
  return `${min} min`;
}

function parseDurationInput(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;

  const compact = text.replace(/\s+/g, '');
  const hm = compact.match(/^(\d{1,2})h(?:(\d{1,2})m?)?$/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2] || 0);
    return normalizeMinuteValue(h * 60 + m);
  }

  const minOnly = compact.match(/^(\d{1,3})(m|min|mins|minute|minutes)?$/);
  if (minOnly) return normalizeMinuteValue(Number(minOnly[1]));

  const hrWords = text.match(/^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)$/);
  if (hrWords) return normalizeMinuteValue(Number(hrWords[1]) * 60);

  const withWords = text.match(/^(\d{1,2})\s*(?:hour|hours|hr|hrs)\s*(\d{1,2})?\s*(?:min|mins|minute|minutes|m)?$/);
  if (withWords) return normalizeMinuteValue(Number(withWords[1]) * 60 + Number(withWords[2] || 0));

  const colon = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (colon) return normalizeMinuteValue(Number(colon[1]) * 60 + Number(colon[2]));

  return null;
}

function rememberDurationChoice(taskText, minute) {
  const min = normalizeMinuteValue(minute);
  const category = classifyTask(taskText);
  const profile = getDurationProfile();

  const globalKey = String(min);
  profile.global[globalKey] = (profile.global[globalKey] || 0) + 1;
  profile.byCategory[category] = profile.byCategory[category] || {};
  profile.byCategory[category][globalKey] = (profile.byCategory[category][globalKey] || 0) + 1;

  saveDurationProfile(profile);
}

function getPendingTaskChecks() {
  try {
    const raw = localStorage.getItem(TASK_CHECK_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePendingTaskChecks(list) {
  try { localStorage.setItem(TASK_CHECK_STORAGE_KEY, JSON.stringify(list || [])); } catch {}
}

function upsertPendingTaskCheck(check) {
  const list = getPendingTaskChecks();
  const idx = list.findIndex((it) => it.id === check.id);
  if (idx >= 0) list[idx] = check;
  else list.push(check);
  savePendingTaskChecks(list);
}

function removePendingTaskCheck(id) {
  const list = getPendingTaskChecks().filter((it) => it.id !== id);
  savePendingTaskChecks(list);
}

const taskCheckTimers = {};

function clearTaskCheckTimer(id) {
  if (taskCheckTimers[id]) {
    clearTimeout(taskCheckTimers[id]);
    delete taskCheckTimers[id];
  }
}

function scheduleTaskCompletionCheck(taskText, minutes) {
  const now = Date.now();
  const check = {
    id: `task_check_${now}_${Math.random().toString(36).slice(2, 8)}`,
    task: String(taskText || '').trim(),
    duration_min: normalizeMinuteValue(minutes),
    due_ts: new Date(now + normalizeMinuteValue(minutes) * 60000).toISOString(),
    created_ts: new Date(now).toISOString(),
  };
  upsertPendingTaskCheck(check);
  armTaskCompletionCheck(check);

  const dueLabel = new Date(check.due_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  appendMsg('assistant', `Plan set. I will check at ${dueLabel} if "${check.task}" is completed. Stats will update only after your confirmation.`);
}

function armTaskCompletionCheck(check) {
  clearTaskCheckTimer(check.id);
  const dueMs = new Date(check.due_ts).getTime();
  const delay = Math.max(600, dueMs - Date.now());
  taskCheckTimers[check.id] = setTimeout(() => promptTaskCompletionCheck(check.id), delay);
}

function resumeTaskCompletionChecks() {
  const list = getPendingTaskChecks();
  if (!list.length) return;
  list.forEach((check) => {
    const dueMs = new Date(check.due_ts).getTime();
    if (!Number.isFinite(dueMs)) {
      removePendingTaskCheck(check.id);
      return;
    }
    if (dueMs <= Date.now()) promptTaskCompletionCheck(check.id);
    else armTaskCompletionCheck(check);
  });
}

function normalizeTaskText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTaskMatch(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80;

  const aw = a.split(' ').filter((w) => w.length > 2);
  const bw = b.split(' ').filter((w) => w.length > 2);
  if (!aw.length || !bw.length) return 0;
  let overlap = 0;
  aw.forEach((w) => { if (bw.includes(w)) overlap += 1; });
  return Math.round((overlap / Math.max(aw.length, bw.length)) * 60);
}

async function markMatchingTaskCompleted(taskName) {
  try {
    const tasks = await api('/tasks');
    const normalizedTarget = normalizeTaskText(taskName);
    const pending = tasks.filter((t) => t.status !== 'completed');
    if (!pending.length) return false;

    const best = pending
      .map((t) => ({ task: t, score: scoreTaskMatch(normalizeTaskText(t.title), normalizedTarget) }))
      .sort((a, b) => b.score - a.score)[0];

    if (!best || best.score < 45) return false;

    await api(`/tasks/${best.task.id}`, { method: 'PATCH', body: { status: 'completed' } });
    return true;
  } catch {
    return false;
  }
}

function promptTaskCompletionCheck(id) {
  clearTaskCheckTimer(id);
  const check = getPendingTaskChecks().find((it) => it.id === id);
  if (!check) return;

  const d = document.createElement('div');
  d.className = 'message assistant';
  d.innerHTML = `
    <div class="msg-avatar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
    <div>
      <div class="msg-body duration-msg">
        <div class="duration-msg-title">Time check: "${esc(check.task)}"</div>
        <div class="duration-msg-meta">Did you complete it?</div>
        <div class="duration-chip-row">
          <button class="duration-chip duration-chip-success">Yes, completed</button>
          <button class="duration-chip duration-chip-muted">Not yet (+10m)</button>
        </div>
      </div>
      <div class="msg-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
    </div>
  `;

  chatFeed.appendChild(d);
  chatFeed.scrollTop = chatFeed.scrollHeight;

  const buttons = Array.from(d.querySelectorAll('.duration-chip'));
  const yesBtn = buttons[0];
  const noBtn = buttons[1];
  const meta = d.querySelector('.duration-msg-meta');
  let handled = false;

  yesBtn.addEventListener('click', async () => {
    if (handled) return;
    handled = true;
    buttons.forEach((b) => { b.disabled = true; });

    try {
      await api('/activity', {
        method: 'POST',
        body: { action: 'Completed Planned Task', task: check.task, duration_min: check.duration_min },
      });
      const linked = await markMatchingTaskCompleted(check.task);
      meta.textContent = linked
        ? 'Great work. Completed and linked task marked done.'
        : 'Great work. Completed and stats updated.';
      removePendingTaskCheck(check.id);
      await Promise.allSettled([loadSidebarStats(), loadTasksAndGoals(), loadAnalytics()]);
    } catch {
      handled = false;
      buttons.forEach((b) => { b.disabled = false; });
      meta.textContent = 'Could not update right now. Please try again.';
    }
  });

  noBtn.addEventListener('click', () => {
    if (handled) return;
    handled = true;
    buttons.forEach((b) => { b.disabled = true; });
    const nextDue = new Date(Date.now() + TASK_CHECK_SNOOZE_MIN * 60000).toISOString();
    upsertPendingTaskCheck({ ...check, due_ts: nextDue });
    armTaskCompletionCheck({ ...check, due_ts: nextDue });
    meta.textContent = `No problem. I will ask again in ${TASK_CHECK_SNOOZE_MIN} minutes.`;
  });
}

function appendDurationPicker(taskText) {
  const pickedTask = String(taskText || '').trim();
  if (!pickedTask) return;
  const suggestions = getSuggestedDurations(pickedTask);

  const d = document.createElement('div');
  d.className = 'message assistant';
  d.innerHTML = `
    <div class="msg-avatar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
    <div>
      <div class="msg-body duration-msg">
        <div class="duration-msg-title">How long do you want to spend on "${esc(pickedTask)}"?</div>
        <div class="duration-chip-row"></div>
        <div class="duration-custom-row">
          <input class="duration-custom-input" type="text" placeholder="Custom (e.g. 45m or 1h 30m)" />
          <button class="duration-custom-btn">Set</button>
        </div>
        <div class="duration-msg-meta">Tip: I will personalize these options based on what you often choose.</div>
      </div>
      <div class="msg-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
    </div>
  `;

  chatFeed.appendChild(d);
  chatFeed.scrollTop = chatFeed.scrollHeight;

  const chipRow = d.querySelector('.duration-chip-row');
  const input = d.querySelector('.duration-custom-input');
  const btn = d.querySelector('.duration-custom-btn');
  const meta = d.querySelector('.duration-msg-meta');
  let submitted = false;

  const submitChoice = async (minutes) => {
    if (submitted) return;
    submitted = true;
    rememberDurationChoice(pickedTask, minutes);
    const durationText = formatDurationLabel(minutes);
    meta.textContent = `Planned: ${durationText}. I will ask at the end if you completed it.`;
    d.querySelectorAll('.duration-chip, .duration-custom-btn, .duration-custom-input').forEach(el => el.disabled = true);
    appendMsg('user', `${pickedTask} - ${durationText}`);
    scheduleTaskCompletionCheck(pickedTask, minutes);
  };

  suggestions.forEach((min) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'duration-chip';
    chip.textContent = formatDurationLabel(min);
    chip.addEventListener('click', () => submitChoice(min));
    chipRow.appendChild(chip);
  });

  btn.addEventListener('click', () => {
    const parsed = parseDurationInput(input.value);
    if (!parsed) {
      meta.textContent = 'Use formats like 45m, 1h, or 1h 30m.';
      input.focus();
      return;
    }
    submitChoice(parsed);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btn.click();
    }
  });
}

function appendMsg(role, content, ts) {
  const d = document.createElement('div');
  d.className = `message ${role}`;
  const time = ts || new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  const avatar = role === 'user'
    ? '<div class="msg-avatar"><svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/></svg></div>'
    : '<div class="msg-avatar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>';
  d.innerHTML = `${avatar}<div><div class="msg-body">${esc(content)}</div><div class="msg-time">${time}</div></div>`;
  chatFeed.appendChild(d);
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

function showTyping() {
  const d = document.createElement('div');
  d.className = 'message assistant';
  d.innerHTML = '<div class="msg-avatar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div><div class="msg-body"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
  chatFeed.appendChild(d);
  chatFeed.scrollTop = chatFeed.scrollHeight;
  return d;
}

// Load history
async function loadChatHistory() {
  chatFeed.innerHTML = '';
  if (!currentSessionId) {
    chatFeed.innerHTML = `<div class="welcome-state" id="welcomeState">
      <div class="welcome-ai-mark">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      </div>
      <p class="welcome-text">Good morning. Based on your current trajectory, let me help you optimize today's output.</p>
    </div>`;
    return;
  }
  const msgs = await api(`/chat/history?session_id=${currentSessionId}&limit=50`);
  if (!msgs.length) return;
  const sep = document.createElement('div');
  sep.className = 'chat-sep';
  sep.textContent = 'Previous messages';
  chatFeed.appendChild(sep);
  msgs.forEach(m => {
    const t = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
    appendMsg(m.role, m.content, t);
  });
}

// ── Session UI ──────────────────────────────────────
const newChatBtn = document.getElementById('newChatBtn');
if (newChatBtn) newChatBtn.addEventListener('click', () => {
    currentSessionId = null;
    loadChatHistory();
    document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
});

const toggleHistoryBtn = document.getElementById('toggleHistoryBtn');
if (toggleHistoryBtn) {
    toggleHistoryBtn.addEventListener('click', () => {
        const layout = document.querySelector('.home-layout');
        if (!layout) return;
        const nextHidden = !layout.classList.contains('hide-history');
        applyHomeHistoryHidden(nextHidden);
        setHomeHistoryHidden(nextHidden);
    });
}

async function loadSessions() {
    try {
        const sessions = await api('/chat/sessions');
        const list = document.getElementById('sessionList');
        if(!list) return;
        list.innerHTML = sessions.map(s => `
            <div class="session-item ${s.id === currentSessionId ? 'active' : ''}" data-id="${s.id}">
                <div class="session-title">${esc(s.title || 'Chat')}</div>
                <button class="session-del" onclick="deleteSession('${s.id}', event)">✕</button>
            </div>
        `).join('');
        list.querySelectorAll('.session-item').forEach(item => {
            item.addEventListener('click', () => {
                currentSessionId = item.dataset.id;
                loadSessions();
                loadChatHistory();
            });
        });
        
        if (!currentSessionId && sessions.length > 0) {
            currentSessionId = sessions[0].id;
            loadChatHistory();
            loadSessions();
        }
    } catch(e) {}
}

window.deleteSession = async (id, e) => {
    e.stopPropagation();
    await api(`/chat/sessions/${id}`, { method: 'DELETE' });
    if(currentSessionId === id) {
        currentSessionId = null;
        loadChatHistory();
    }
    loadSessions();
};

// ── Right Panel: Cognitive Load + Active Insights ───
let currentPulseFullText = '';
const pulseFloatEl = document.getElementById('pulseFloat');
if(pulseFloatEl) {
    pulseFloatEl.addEventListener('click', function() {
        this.classList.add('expanded');
        const textEl = document.getElementById('pulseFloatText');
        if(textEl) textEl.textContent = currentPulseFullText;
    });
}

async function loadRightPanel() {
  // Cognitive Load = productivity score
  try {
    const score = await api('/analytics/score');
    document.getElementById('cognitiveScore').textContent = score.score + '%';
    document.getElementById('cognitiveBar').style.width = score.score + '%';

    const hints = ['Optimal for creative tasks', 'High capacity — deep work mode', 'Moderate capacity available', 'Rest recommended'];
    const hint = score.score >= 70 ? hints[1] : score.score >= 40 ? hints[0] : score.score >= 20 ? hints[2] : hints[3];
    document.getElementById('cognitiveHint').textContent = hint;
  } catch {}

  // Active Insights = proactive messages
  try {
    const msgs = await api('/proactive');
    const feed = document.getElementById('activeInsights');

    if (msgs.length > 0) {
      feed.innerHTML = msgs.map(m => {
        const typeClass = { reminder:'t-reminder', challenge:'t-challenge', insight:'t-insight', motivation:'t-motivation' }[m.type] || 't-insight';
        return `<div class="insight-item">
          <div class="insight-type ${typeClass}">${m.type.toUpperCase()}<span class="insight-arrow">↗</span></div>
          <div class="insight-text">${esc(m.content).substring(0, 120)}${m.content.length > 120 ? '...' : ''}</div>
        </div>`;
      }).join('');
    } else {
      feed.innerHTML = '<p class="empty-hint">No new insights yet</p>';
    }

    const unreadMsgs = await api('/proactive/unread');
    const badge = document.getElementById('bellDot');
    
    if (unreadMsgs.length > 0) {
      badge.classList.remove('hidden');
      showPulse(unreadMsgs[0]);
    } else {
      badge.classList.add('hidden');
    }
  } catch {}

  // Active Timers
  try {
    const reminders = await api('/reminders/active');
    const feed = document.getElementById('activeTimers');
    if (feed) {
      if (reminders.length > 0) {
        window._activeTimersData = reminders;
        renderTimers();
        if (!window._timerInterval) {
          window._timerInterval = setInterval(renderTimers, 1000);
        }
      } else {
        feed.innerHTML = '<p class="empty-hint">No active timers</p>';
        if (window._timerInterval) { clearInterval(window._timerInterval); window._timerInterval = null; }
      }
    }
  } catch(e) { console.error('Error loading timers:', e); }
}

window.renderTimers = () => {
    const feed = document.getElementById('activeTimers');
    if (!feed || !window._activeTimersData) return;
    
    const html = window._activeTimersData.map(r => {
        let displayTime = r.time_rule;
        let meta = 'Recurring reminder';
        let state = 'cron';
        let stateLabel = 'CRON';
        const targetMs = new Date(r.time_rule).getTime();
        let isCron = r.is_recurring || isNaN(targetMs);
        
        if (!isCron) {
            const diff = targetMs - Date.now();
            if (diff > 0) {
                const totalSec = Math.floor(diff/1000);
                const hrs = Math.floor(totalSec/3600);
                const mins = Math.floor((totalSec%3600)/60);
                const secs = totalSec%60;
                displayTime = `<span class="tm-urgent">IN ${hrs?hrs+'H ':''}${mins}M ${secs}S</span>`;
                state = diff <= 15 * 60 * 1000 ? 'soon' : 'scheduled';
                stateLabel = state === 'soon' ? 'SOON' : 'UPCOMING';
                meta = `Triggers at ${new Date(targetMs).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}`;
            } else {
                displayTime = '<span class="tm-urgent">TRIGGERING NOW</span>';
                state = 'live';
                stateLabel = 'LIVE';
                meta = 'Dispatching reminder now';
            }
        } else {
            const friendlyCron = formatCronHuman(r.time_rule);
            displayTime = friendlyCron
                ? `<span class="tm-cron">${friendlyCron}</span>`
                : `<span class="tm-cron">Recurring schedule</span>`;
            meta = friendlyCron ? `Rule: ${r.time_rule}` : `Cron rule: ${r.time_rule}`;
        }
        
        return `
        <div class="timer-item timer-${state}">
            <div class="timer-pulse"></div>
            <div class="timer-details">
                <div class="timer-headline">
                    <div class="timer-title">${esc(r.title)}</div>
                    <span class="timer-badge">${stateLabel}</span>
                </div>
                <div class="timer-countdown">${displayTime}</div>
                <div class="timer-meta">${meta}</div>
            </div>
        </div>`;
    }).join('');
    
    if (feed.innerHTML !== html) feed.innerHTML = html;
};

function showPulse(msg) {
  const el = document.getElementById('pulseFloat');
  currentPulseFullText = msg.content;
  document.getElementById('pulseFloatText').textContent = currentPulseFullText.substring(0, 140) + (currentPulseFullText.length > 140 ? '...' : '');
  el.classList.remove('hidden');
  el.classList.remove('expanded');
  
  // Do not mark as read here automatically if we want them to use the dropdown, but it's OK to do so if they saw the pulse.
  api(`/proactive/${msg.id}/read`, { method: 'PATCH' }).catch(()=>{});

  setTimeout(() => { 
    if (!el.classList.contains('expanded')) el.classList.add('hidden'); 
  }, 15000);
}

// ── Notification Dropdown ───────────────────────────
document.getElementById('notifBell').addEventListener('click', (e) => {
  e.stopPropagation();
  const dropdown = document.getElementById('notifDropdown');
  if (!dropdown) return;
  dropdown.classList.toggle('hidden');
  if (!dropdown.classList.contains('hidden')) {
    document.getElementById('bellDot').classList.add('hidden');
    renderNotifDropdown();
  }
});
window.addEventListener('click', (e) => {
  if (!e.target.closest('.notif-wrapper')) {
    const d = document.getElementById('notifDropdown');
    if (d && !d.classList.contains('hidden')) d.classList.add('hidden');
  }
});

async function renderNotifDropdown() {
  try {
    const list = document.getElementById('notifList');
    if (!list) return;
    list.innerHTML = '<p class="empty-hint" style="padding:12px">Loading...</p>';
    const msgs = await api('/proactive');
    if (msgs.length > 0) {
      list.innerHTML = msgs.slice(0, 15).map(m => {
        const color = m.type==='reminder'?'--red':m.type==='insight'?'--teal':m.type==='challenge'?'--amber':m.type==='briefing'?'--amber':'--purple';
        const extraClass = m.type === 'briefing' ? ' briefing-card' : '';
        return `
        <div class="dropdown-item${extraClass}">
          <div class="dropdown-item-type" style="color:var(${color})">${m.type === 'briefing' ? '☀️ DAILY BRIEFING' : m.type}</div>
          <div class="dropdown-item-text">${esc(m.content)}</div>
          <div class="dropdown-item-time" style="font-size:10px;color:var(--text-4);margin-top:4px;">${new Date(m.timestamp).toLocaleString(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'})}</div>
        </div>`;
      }).join('');
      // mark any unread proactively
      const unread = await api('/proactive/unread');
      unread.forEach(u => api(`/proactive/${u.id}/read`, {method:'PATCH'}).catch(()=>{}));
    } else {
      list.innerHTML = '<p class="empty-hint" style="padding:12px">No notifications</p>';
    }
  } catch(e) { console.error(e) }
}

// ── Chip Select Logic ───────────────────────────────
function setupChipGroup(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    group.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
    if (chip.dataset.days === 'custom') {
      const ci = group.parentElement.querySelector('.form-input-sm');
      if (ci) ci.classList.remove('hidden');
    } else {
      const ci = group.parentElement.querySelector('.form-input-sm');
      if (ci) ci.classList.add('hidden');
    }
  });
}

function getChipValue(groupId) {
  const g = document.getElementById(groupId);
  if (!g) return null;
  const s = g.querySelector('.chip.selected');
  return s ? (s.dataset.val || s.dataset.days) : null;
}

function getDeadline(chipGroupId, customInputId) {
  const val = getChipValue(chipGroupId);
  if (!val) return null;
  if (val === 'custom') return document.getElementById(customInputId).value || null;
  return addDays(new Date(), parseInt(val));
}

setupChipGroup('goalTypeChips');
setupChipGroup('goalDeadlineChips');
setupChipGroup('taskPriorityChips');
setupChipGroup('taskDeadlineChips');

// ── Goals / Objectives ──────────────────────────────
document.getElementById('newInitiativeBtn').addEventListener('click', () => {
  switchTab('strategy');
  document.getElementById('addGoalForm').classList.toggle('hidden');
});

document.getElementById('cancelGoalBtn').addEventListener('click', () => document.getElementById('addGoalForm').classList.add('hidden'));

document.getElementById('saveGoalBtn').addEventListener('click', async () => {
  const title = document.getElementById('goalTitle').value.trim();
  if (!title) return;
  await api('/goals', { method: 'POST', body: {
    title,
    type: getChipValue('goalTypeChips') || 'productivity',
    deadline: getDeadline('goalDeadlineChips', 'goalDeadlineCustom'),
  }});
  document.getElementById('goalTitle').value = '';
  document.getElementById('addGoalForm').classList.add('hidden');
  notify('✦ Objective created');
  loadTasksAndGoals();
  loadSidebarStats();
});

// ── Tasks ───────────────────────────────────────────
document.getElementById('addTaskBtn').addEventListener('click', () => { document.getElementById('addTaskForm').classList.toggle('hidden'); populateGoalDropdown(); });
document.getElementById('cancelTaskBtn').addEventListener('click', () => document.getElementById('addTaskForm').classList.add('hidden'));

document.getElementById('saveTaskBtn').addEventListener('click', async () => {
  const title = document.getElementById('taskTitle').value.trim();
  if (!title) return;
  await api('/tasks', { method: 'POST', body: {
    title,
    priority: getChipValue('taskPriorityChips') || 'medium',
    deadline: getDeadline('taskDeadlineChips', 'taskDeadlineCustom'),
    goal_id: document.getElementById('taskGoalId').value || null,
  }});
  document.getElementById('taskTitle').value = '';
  document.getElementById('addTaskForm').classList.add('hidden');
  notify('✦ Task added to pipeline');
  loadTasksAndGoals();
  loadSidebarStats();
});

document.querySelectorAll('#taskFilter .seg').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#taskFilter .seg').forEach(s => s.classList.remove('active'));
    b.classList.add('active');
    taskFilter = b.dataset.filter;
    loadTasksAndGoals();
  });
});

let objectiveViewMode = 'short';
document.querySelectorAll('#objViewToggle .seg').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#objViewToggle .seg').forEach(s => s.classList.remove('active'));
    b.classList.add('active');
    objectiveViewMode = b.dataset.view;
    loadTasksAndGoals();
  });
});

async function populateGoalDropdown() {
  const goals = await api('/goals');
  const sel = document.getElementById('taskGoalId');
  sel.innerHTML = '<option value="">No linked objective</option>';
  goals.forEach(g => { sel.innerHTML += `<option value="${g.id}">${g.title}</option>`; });
}

async function loadTasksAndGoals() {
  const [goals, tasks] = await Promise.all([api('/goals'), api('/tasks')]);

  // Objective cards
  const oc = document.getElementById('objectiveCards');
  if (!goals.length) {
    oc.innerHTML = '<p class="obj-empty">No objectives yet. Click "+ New Initiative" to create one.</p>';
  } else {
    oc.innerHTML = goals.map(g => {
      const icons = { productivity: '📊', learning: '🎓', health: '❤️', other: '⚡' };
      const iconClass = { productivity: 'ico-prod', learning: 'ico-learn', health: 'ico-health', other: 'ico-other' };
      const tc = tasks.filter(t => t.goal_id === g.id);
      const activeStepId = (tc.find(t => t.status !== 'completed') || {}).id;
      const done = tc.filter(t => t.status === 'completed').length;
      const pct = tc.length ? Math.round((done / tc.length) * 100) : g.progress;
      return `<div class="obj-card" id="obj-card-${g.id}">
        <div class="obj-header" onclick="toggleRoadmap(${g.id})">
          <div class="obj-card-icon ${iconClass[g.type] || 'ico-other'}">${icons[g.type] || '⚡'}</div>
          <span class="obj-card-pct">${pct}%</span>
          <div class="obj-card-title">${esc(g.title)}</div>
          <div class="obj-card-desc">${tc.length ? `${done}/${tc.length} tasks complete` : (g.deadline ? relDate(g.deadline) : 'No roadmap yet')}</div>
          <div class="obj-bar-track"><div class="obj-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="obj-roadmap ${objectiveViewMode === 'long' ? '' : 'hidden'}" id="roadmap-${g.id}">
          <div class="roadmap-head">
            <span class="roadmap-kicker">Strategic Roadmap</span>
            <span class="roadmap-progress-chip">${pct}% complete</span>
          </div>
          ${tc.length ? tc.map((t, index) => {
            const state = t.status === 'completed' ? 'done' : (t.id === activeStepId ? 'active' : 'queued');
            const stateLabel = state === 'done' ? 'Done' : (state === 'active' ? 'Active' : 'Queued');
            const dueLabel = t.deadline ? relDate(t.deadline) : 'No deadline';
            const priorityLabel = (t.priority || 'medium').toUpperCase();
            return `<button class="roadmap-step ${state}" onclick="toggleTask(${t.id},'${t.status}')">
              <div class="step-node"></div>
              <div class="step-content">
                <div class="step-meta">
                  <span class="step-level">Stage ${String(index + 1).padStart(2, '0')}</span>
                  <span class="step-state ${state}">${stateLabel}</span>
                </div>
                <div class="step-title">${esc(t.title)}</div>
                <div class="step-sub">${dueLabel} | ${priorityLabel} PRIORITY</div>
              </div>
            </button>`;
          }).join('') : `<div class="roadmap-empty">No tasks yet. Add a task to generate this roadmap.</div>`}
          <button class="mark-obj-btn" onclick="toggleGoal(${g.id},'${g.status}')">${g.status === 'completed' ? 'Reopen Objective' : 'Claim Final Reward (Complete)'}</button>
          <button class="discard-obj-btn" onclick="discardGoal(${g.id}, event)">Discard Objective</button>
        </div>
      </div>`;
    }).join('');
  }

  latestGoalsCache = goals;
  latestTasksCache = tasks;
  renderTaskPipeline(tasks, goals);
}

function taskPriorityRank(priority) {
  const ranks = { high: 0, medium: 1, low: 2 };
  return ranks[String(priority || 'medium').toLowerCase()] ?? 1;
}

function taskDeadlineMs(task) {
  if (!task || !task.deadline) return Number.POSITIVE_INFINITY;
  const d = new Date(`${task.deadline}T00:00:00`);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function taskSortByDuePriority(a, b) {
  const dueDiff = taskDeadlineMs(a) - taskDeadlineMs(b);
  if (dueDiff !== 0) return dueDiff;
  const pDiff = taskPriorityRank(a.priority) - taskPriorityRank(b.priority);
  if (pDiff !== 0) return pDiff;
  return String(a.title || '').localeCompare(String(b.title || ''));
}

function isTaskInTodayBucket(task) {
  if (!task || task.status === 'completed') return false;
  if (!task.deadline) return false;
  const due = new Date(`${task.deadline}T00:00:00`);
  if (!Number.isFinite(due.getTime())) return false;
  const today = startOfDay(new Date());
  return due.getTime() <= today.getTime();
}

function renderTaskRow(task, goalMap, idx = 0) {
  const priority = String(task.priority || 'medium').toLowerCase();
  const status = task.status === 'completed' ? 'completed' : 'pending';
  const dueText = task.deadline ? relDate(task.deadline) : 'NO DEADLINE';
  const dueClass = dueText === 'OVERDUE' ? 'task-due-overdue' : dueText === 'DUE TODAY' ? 'task-due-today' : '';
  const goalTitle = goalMap.get(task.goal_id);
  const actionBtns = status === 'completed'
    ? `<button class="task-action danger" onclick="deleteTaskItem(${task.id}, event)">Delete</button>`
    : `
      <button class="task-action" onclick="startTaskTimer(${task.id}, event)">Start Timer</button>
      <button class="task-action" onclick="remindTask(${task.id}, event)">Remind</button>
      <button class="task-action danger" onclick="deleteTaskItem(${task.id}, event)">Delete</button>
    `;

  return `<div class="pipeline-item ${status}" style="animation-delay:${idx * .02}s">
    <button class="task-check ${status === 'completed' ? 'done' : ''}" onclick="toggleTask(${task.id},'${task.status}')">${status === 'completed' ? '✓' : ''}</button>
    <div class="task-body">
      <div class="task-name">${esc(task.title)}</div>
      <div class="task-meta-row">
        <span class="task-due ${dueClass}">${dueText}</span>
        ${goalTitle ? `<span class="task-goal-chip">${esc(goalTitle)}</span>` : ''}
      </div>
    </div>
    <div class="task-side">
      <span class="task-priority tp-${priority}">${priority.toUpperCase()}</span>
      <div class="task-row-actions">${actionBtns}</div>
    </div>
  </div>`;
}

function renderTaskSection(title, tasks, opts = {}) {
  const { collapsible = false, collapsed = false, emptyLabel = '' } = opts;
  const count = tasks.length;
  const countText = `<span class="pipeline-count">${count}</span>`;
  const toggleBtn = collapsible
    ? `<button class="pipeline-collapse-btn" onclick="togglePipelineCompleted(event)">${collapsed ? 'Show' : 'Hide'}</button>`
    : '';
  const sectionBodyClass = `pipeline-section-body ${collapsed ? 'hidden' : ''}`;
  const rows = count
    ? tasks.map((task, idx) => renderTaskRow(task, opts.goalMap, idx)).join('')
    : `<p class="pipeline-empty section-empty">${emptyLabel || 'No tasks here'}</p>`;

  return `<section class="pipeline-section">
    <header class="pipeline-section-head">
      <h4>${title} ${countText}</h4>
      ${toggleBtn}
    </header>
    <div class="${sectionBodyClass}">
      ${rows}
    </div>
  </section>`;
}

function renderTaskPipeline(tasks, goals) {
  const tl = document.getElementById('tasksList');
  if (!tl) return;

  const allTasks = Array.isArray(tasks) ? [...tasks] : [];
  const goalMap = new Map((Array.isArray(goals) ? goals : []).map(g => [g.id, g.title]));

  if (taskFilter === 'active') {
    const pending = allTasks.filter(t => t.status !== 'completed');
    const today = pending.filter(isTaskInTodayBucket).sort(taskSortByDuePriority);
    const upcoming = pending.filter(t => !isTaskInTodayBucket(t)).sort(taskSortByDuePriority);

    if (!pending.length) {
      tl.innerHTML = '<p class="pipeline-empty">No active tasks in pipeline</p>';
      return;
    }

    tl.innerHTML = [
      renderTaskSection('Today', today, { goalMap, emptyLabel: 'Nothing due today' }),
      renderTaskSection('Upcoming', upcoming, { goalMap, emptyLabel: 'No upcoming tasks' }),
    ].join('');
    return;
  }

  if (taskFilter === 'completed') {
    const completed = allTasks.filter(t => t.status === 'completed').sort(taskSortByDuePriority);
    const collapsed = isPipelineCompletedCollapsed();
    tl.innerHTML = renderTaskSection('Completed', completed, {
      goalMap,
      collapsible: true,
      collapsed,
      emptyLabel: 'No completed tasks yet',
    });
    return;
  }

  const pending = allTasks.filter(t => t.status !== 'completed');
  const today = pending.filter(isTaskInTodayBucket).sort(taskSortByDuePriority);
  const upcoming = pending.filter(t => !isTaskInTodayBucket(t)).sort(taskSortByDuePriority);
  const completed = allTasks.filter(t => t.status === 'completed').sort(taskSortByDuePriority);
  const collapsed = isPipelineCompletedCollapsed();

  if (!allTasks.length) {
    tl.innerHTML = '<p class="pipeline-empty">No tasks in pipeline</p>';
    return;
  }

  tl.innerHTML = [
    renderTaskSection('Today', today, { goalMap, emptyLabel: 'Nothing due today' }),
    renderTaskSection('Upcoming', upcoming, { goalMap, emptyLabel: 'No upcoming tasks' }),
    renderTaskSection('Completed', completed, {
      goalMap,
      collapsible: true,
      collapsed,
      emptyLabel: 'No completed tasks yet',
    }),
  ].join('');
}

window.togglePipelineCompleted = (e) => {
  if (e) e.stopPropagation();
  const next = !isPipelineCompletedCollapsed();
  setPipelineCompletedCollapsed(next);
  renderTaskPipeline(latestTasksCache, latestGoalsCache);
};

window.startTaskTimer = (taskId, e) => {
  if (e) e.stopPropagation();
  const task = latestTasksCache.find(t => Number(t.id) === Number(taskId));
  if (!task) return;
  resetTimer();
  startTimer();
  const taskSelect = document.getElementById('activityTask');
  if (taskSelect) {
    const options = Array.from(taskSelect.options);
    const existing = options.find(o => o.value === task.title);
    if (!existing) {
      const opt = document.createElement('option');
      opt.value = task.title;
      opt.textContent = task.title;
      taskSelect.appendChild(opt);
    }
    taskSelect.value = task.title;
  }
  notify(`Started 25m timer for "${task.title}"`);
};

window.remindTask = async (taskId, e) => {
  if (e) e.stopPropagation();
  const task = latestTasksCache.find(t => Number(t.id) === Number(taskId));
  if (!task) return;
  const when = prompt(`When should I remind you for "${task.title}"? (example: in 30 minutes)`);
  if (!when || !when.trim()) return;
  const raw = when.trim();
  const phrase = /^(in|after|at|on|today|tomorrow|next)\b/i.test(raw) ? raw : `in ${raw}`;
  const message = `Remind me to ${task.title} ${phrase}`;
  try {
    await api('/chat', { method: 'POST', body: { message, session_id: currentSessionId } });
    notify(`Reminder scheduled for "${task.title}"`);
  } catch {
    notify('Could not set reminder right now');
  }
};

window.deleteTaskItem = async (taskId, e) => {
  if (e) e.stopPropagation();
  const task = latestTasksCache.find(t => Number(t.id) === Number(taskId));
  if (!task) return;
  if (!confirm(`Delete task "${task.title}"?`)) return;
  await api(`/tasks/${task.id}`, { method: 'DELETE' });
  notify('Task deleted');
  loadTasksAndGoals();
  loadSidebarStats();
};

window.toggleRoadmap = (id) => {
  const el = document.getElementById('roadmap-' + id);
  if (el) el.classList.toggle('hidden');
};

window.toggleGoal = async (id, s) => {
  const ns = s === 'completed' ? 'active' : 'completed';
  await api(`/goals/${id}`, { method: 'PATCH', body: { status: ns, progress: ns === 'completed' ? 100 : 0 } });
  if (ns === 'completed') notify('🎯 Objective completed');
  loadTasksAndGoals(); loadSidebarStats();
};

window.discardGoal = async (id, e) => {
  if (e) e.stopPropagation();
  if (!confirm('Discard this objective? Linked tasks will remain but be unlinked from this objective.')) return;
  await api(`/goals/${id}`, { method: 'DELETE' });
  const card = document.getElementById(`obj-card-${id}`);
  if (card) card.remove();
  const oc = document.getElementById('objectiveCards');
  if (oc && !oc.querySelector('.obj-card')) {
    oc.innerHTML = '<p class="obj-empty">No objectives yet. Click "+ New Initiative" to create one.</p>';
  }
  notify('Objective discarded');
  loadTasksAndGoals();
  loadSidebarStats();
};
window.toggleTask = async (id, s) => {
  const ns = s === 'completed' ? 'pending' : 'completed';
  await api(`/tasks/${id}`, { method: 'PATCH', body: { status: ns } });
  if (ns === 'completed') notify('✓ Task completed');
  loadTasksAndGoals(); loadSidebarStats();
};

// ── Activity Logging ────────────────────────────────
document.getElementById('logActivityBtn').addEventListener('click', async () => {
  const action = document.getElementById('activityAction').value.trim();
  if (!action) return;
  const dur = parseInt(document.getElementById('activityDuration').value) || 25;
  const task = document.getElementById('activityTask').value;
  await api('/activity', { method: 'POST', body: { action, task, duration_min: dur } });
  document.getElementById('activityAction').value = '';
  notify('✦ Activity committed to record');
  loadSidebarStats();
});

// ── Focus Timer ─────────────────────────────────────
const timerText = document.getElementById('timerText');
const timerStartBtn = document.getElementById('timerStartBtn');
const timerResetBtn = document.getElementById('timerResetBtn');

timerStartBtn.addEventListener('click', () => timerRunning ? pauseTimer() : startTimer());
timerResetBtn.addEventListener('click', resetTimer);

function startTimer() {
  timerRunning = true;
  timerStartBtn.textContent = '❚❚ PAUSE';
  timerInterval = setInterval(() => {
    timerSeconds--;
    updateTimerUI();
    if (timerSeconds <= 0) completeTimer();
  }, 1000);
}

function pauseTimer() {
  timerRunning = false;
  clearInterval(timerInterval);
  timerStartBtn.textContent = '▶ RESUME';
}

function resetTimer() {
  timerRunning = false;
  clearInterval(timerInterval);
  timerSeconds = TIMER_TOTAL;
  updateTimerUI();
  timerStartBtn.textContent = '▶ START';
}

async function completeTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
  timerStartBtn.textContent = '▶ START';
  await api('/activity', { method: 'POST', body: { action: 'Focus Session', task: 'Deep Work', duration_min: 25 } });
  notify('✦ Focus session complete — 25 min committed');
  setTimeout(() => { timerSeconds = TIMER_TOTAL; updateTimerUI(); }, 3000);
  loadSidebarStats();
}

function updateTimerUI() {
  const m = Math.floor(timerSeconds / 60), s = timerSeconds % 60;
  timerText.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── Analytics / Velocity ────────────────────────────
document.querySelectorAll('#viewToggle .seg').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#viewToggle .seg').forEach(s => s.classList.remove('active'));
    b.classList.add('active');
    loadAnalytics(b.dataset.view);
  });
});

async function loadAnalytics(view = 'daily') {
  const today = new Date().toISOString().split('T')[0];
  const [daily, weekly, monthly, timeline, score, goals, tasks] = await Promise.all([
    api(`/analytics/daily?date=${today}`), api('/analytics/weekly'),
    api('/analytics/monthly'), api('/analytics/timeline?days=30'),
    api('/analytics/score'), api('/goals'), api('/tasks'),
  ]);

  // Pulse score
  animateScore(score.score);
  const consistencyPct = Math.max(0, Math.min(100, Math.round(monthly.consistencyScore || 0)));
  const focusPct = Math.round((score.breakdown.focus / 25) * 100);
  const timePct = Math.round((score.breakdown.time / 25) * 100);
  document.getElementById('bfTasks').style.width = consistencyPct + '%';
  document.getElementById('bfFocus').style.width = focusPct + '%';
  document.getElementById('bfTime').style.width = timePct + '%';
  document.getElementById('pctTasks').textContent = consistencyPct + '%';
  document.getElementById('pctFocus').textContent = focusPct + '%';
  document.getElementById('pctTime').textContent = timePct + '%';

  // KPIs (adapt based on view)
  if (view === 'daily') {
    document.getElementById('kpiHours').textContent = daily.productiveTime;
    document.getElementById('kpiConsistency').textContent = monthly.consistencyScore + '%';
    document.getElementById('kpiInitiatives').textContent = goals.length;
    document.getElementById('kpiBlocked').textContent = tasks.filter(t => t.deadline && new Date(t.deadline) < new Date() && t.status === 'pending').length;
  } else if (view === 'weekly') {
    document.getElementById('kpiHours').textContent = weekly.totalProductiveHours + 'h';
    document.getElementById('kpiConsistency').textContent = monthly.consistencyScore + '%';
    document.getElementById('kpiInitiatives').textContent = goals.length;
    document.getElementById('kpiBlocked').textContent = tasks.filter(t => t.deadline && new Date(t.deadline) < new Date() && t.status === 'pending').length;
  } else {
    document.getElementById('kpiHours').textContent = monthly.totalProductiveHours + 'h';
    document.getElementById('kpiConsistency').textContent = monthly.consistencyScore + '%';
    document.getElementById('kpiInitiatives').textContent = goals.length;
    document.getElementById('kpiBlocked').textContent = tasks.filter(t => t.deadline && new Date(t.deadline) < new Date() && t.status === 'pending').length;
  }

  // Charts update with the selected view.
  if (view === 'daily') {
    const hourLabels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
    const hourData = Array.from({ length: 24 }, (_, i) => daily.hourlyBreakdown[i] || 0);
    const daytimeLabels = hourLabels.filter((_, i) => i >= 6 && i <= 22);
    const daytimeData = hourData.filter((_, i) => i >= 6 && i <= 22);
    renderChart('velocityChart', 'line', daytimeLabels, daytimeData, '#7C5CFC');
    renderChart('deepStateChart', 'bar', daytimeLabels, daytimeData, '#2DD4A0');
  } else if (view === 'weekly') {
    const trendLabels = weekly.dailyBreakdown.map(d => new Date(d.date).toLocaleDateString('en', { weekday: 'short' }).toUpperCase());
    const trendData = weekly.dailyBreakdown.map(d => d.productiveMinutes);
    renderChart('velocityChart', 'line', trendLabels, trendData, '#7C5CFC');
    renderChart('deepStateChart', 'bar', trendLabels, trendData, '#2DD4A0');
  } else {
    const monthLabels = monthly.dailyBreakdown.map(d => String(new Date(d.date).getDate()));
    const monthData = monthly.dailyBreakdown.map(d => d.minutes);
    renderChart('velocityChart', 'line', monthLabels, monthData, '#7C5CFC');

    const weeklyBuckets = [0, 0, 0, 0, 0, 0];
    monthly.dailyBreakdown.forEach(d => {
      const day = new Date(d.date).getDate();
      const idx = Math.min(Math.floor((day - 1) / 7), 5);
      weeklyBuckets[idx] += d.minutes || 0;
    });
    const weekLabels = weeklyBuckets.map((_, i) => `W${i + 1}`).filter((_, i) => weeklyBuckets[i] > 0 || i < 4);
    const weekData = weeklyBuckets.filter((v, i) => v > 0 || i < 4);
    renderChart('deepStateChart', 'bar', weekLabels, weekData, '#2DD4A0');
  }
}

function animateScore(target) {
  const el = document.getElementById('pulseValue');
  const ring = document.getElementById('pulseRing');
  const circ = 2 * Math.PI * 52;
  let cur = 0;
  const step = Math.max(1, Math.floor(target / 25));
  (function go() {
    cur = Math.min(cur + step, target);
    el.textContent = cur;
    ring.setAttribute('stroke-dashoffset', circ - (cur / 100) * circ);
    if (cur < target) requestAnimationFrame(go);
  })();
}

function renderChart(id, type, labels, data, color) {
  if (charts[id]) charts[id].destroy();
  const ctx = document.getElementById(id).getContext('2d');
  let bg = color + '25';
  if (type === 'line') { const g = ctx.createLinearGradient(0, 0, 0, 200); g.addColorStop(0, color + '30'); g.addColorStop(1, 'transparent'); bg = g; }
  charts[id] = new Chart(ctx, {
    type,
    data: { labels, datasets: [{ data, backgroundColor: bg, borderColor: color, borderWidth: 2, fill: type === 'line', tension: .4, pointRadius: type === 'line' ? 2 : 0, pointBackgroundColor: color, borderRadius: type === 'bar' ? 4 : 0, maxBarThickness: 20 }] },
    options: {
      responsive: true, maintainAspectRatio: true,
      animation: { duration: 600, easing: 'easeOutQuart' },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1A1A22', titleColor: '#F0F0F5', bodyColor: '#A0A0B5', borderColor: '#2A2A35', borderWidth: 1, cornerRadius: 8, padding: 10 } },
      scales: { x: { grid: { display: false }, ticks: { color: '#6B6B80', font: { size: 9 } } }, y: { grid: { color: '#1A1A22' }, ticks: { color: '#6B6B80', font: { size: 9 } }, beginAtZero: true } }
    }
  });
}

// ── Export ───────────────────────────────────────────
document.getElementById('exportDataBtn').addEventListener('click', async () => {
  const [tasks, goals, acts] = await Promise.all([api('/tasks'), api('/goals'), api('/activity?limit=500')]);
  let csv = 'Type,Title,Status,Priority,Deadline,Duration,Timestamp\n';
  goals.forEach(g => csv += `Objective,${csvEsc(g.title)},${g.status},${g.type},${g.deadline || ''},,\n`);
  tasks.forEach(t => csv += `Task,${csvEsc(t.title)},${t.status},${t.priority},${t.deadline || ''},,\n`);
  acts.forEach(a => csv += `Activity,${csvEsc(a.action)},,,,${a.duration_min},${a.timestamp}\n`);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: `augment-export-${new Date().toISOString().split('T')[0]}.csv` }).click();
  URL.revokeObjectURL(url);
  notify('✦ Data exported');
});

// ── Habits / Rituals ────────────────────────────────
document.getElementById('analyzeHabitsBtn').addEventListener('click', async () => {
  await api('/habits/analyze', { method: 'POST' });
  notify('✦ System analysis complete');
  loadHabits();
});

async function loadHabits() {
  const habits = await api('/habits');
  const grid = document.getElementById('habitsList');
  const empty = document.getElementById('habitsEmpty');
  if (!habits.length) { grid.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  const icons = { night_worker: '🌙', morning_worker: '🌅', afternoon_worker: '☀️', weekend_skipper: '📅', late_focus_drop: '😴', streak_builder: '🔥' };
  const bgs = { night_worker: 'ri-purple', morning_worker: 'ri-amber', afternoon_worker: 'ri-teal', weekend_skipper: 'ri-red', late_focus_drop: 'ri-purple', streak_builder: 'ri-teal' };
  const colors = { night_worker: 'var(--purple)', morning_worker: 'var(--amber)', afternoon_worker: 'var(--teal)', weekend_skipper: 'var(--red)', late_focus_drop: 'var(--blue)', streak_builder: 'var(--teal)' };

  grid.innerHTML = habits.map(h => {
    const conf = Math.round(h.confidence * 100);
    const name = h.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    return `<div class="ritual-card">
      <div class="ritual-card-head">
        <div class="ritual-icon ${bgs[h.name] || 'ri-purple'}">${icons[h.name] || '📊'}</div>
        <div class="ritual-conf"><span>CONFIDENCE SCORE</span><span class="ritual-conf-val">${conf}%</span></div>
      </div>
      <div class="ritual-name">${name}</div>
      <div class="ritual-desc">${esc(h.description || '')}</div>
      <div class="ritual-tags">
        <span class="ritual-tag rt-active">ACTIVE PATTERN</span>
        ${conf >= 70 ? '<span class="ritual-tag rt-pattern">HIGH VELOCITY</span>' : ''}
      </div>
      <div class="ritual-bar-track"><div class="ritual-bar-fill" style="width:${conf}%;background:${colors[h.name] || 'var(--purple)'}"></div></div>
      <div class="ritual-bar-label"><span>IMPACT</span><span>${conf >= 70 ? 'Elevated' : 'Moderate'}</span></div>
    </div>`;
  }).join('');
}

// ── Sidebar Stats ───────────────────────────────────
async function loadSidebarStats() {
  // No sidebar stats in the Stitch design - data is in the right panel and KPIs
  loadRightPanel();
}

// ── Keyboard Shortcuts ──────────────────────────────
document.addEventListener('keydown', e => {
  const tabs = ['home', 'strategy', 'velocity', 'rituals', 'calendar'];
  if (e.ctrlKey && e.key >= '1' && e.key <= '5') { e.preventDefault(); switchTab(tabs[+e.key - 1]); }
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { e.preventDefault(); switchTab('home'); chatInput.focus(); }
  if (e.ctrlKey && e.key === 't') { e.preventDefault(); switchTab('strategy'); timerRunning ? pauseTimer() : startTimer(); }
});

// ── Push Notification Setup ─────────────────────────
async function setupPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[Push] Not supported in this browser');
    return;
  }

  try {
    // Register Service Worker
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('[Push] Service Worker registered');

    // Request notification permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.log('[Push] Permission denied');
      return;
    }

    // Get VAPID public key from server
    const { publicKey } = await api('/push/vapid-public-key');
    
    // Convert base64 to Uint8Array
    const urlBase64ToUint8Array = (base64String) => {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = window.atob(base64);
      return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
    };

    // Subscribe to push
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    // Send subscription to server
    await api('/push/subscribe', {
      method: 'POST',
      body: subscription.toJSON(),
    });

    console.log('[Push] Subscribed successfully');
  } catch (err) {
    console.warn('[Push] Setup error:', err);
  }
}

// ── Init ────────────────────────────────────────────
async function init() {
  applyHomeHistoryHidden(isHomeHistoryHidden());
  await loadSessions();
  if(!currentSessionId) {
    await loadChatHistory();
  }
  resumeTaskCompletionChecks();
  loadRightPanel();
  setInterval(() => loadRightPanel(), 60000);
  updateTimerUI();

  // Set briefing title by time of day
  const h = new Date().getHours();
  const titles = { morning: 'Morning Strategic Briefing', afternoon: 'Afternoon Performance Review', evening: 'Evening Debrief' };
  const period = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  document.getElementById('briefingTitle').textContent = titles[period];

  // Setup push notifications
  setupPushNotifications();

  setCalendarDateBadge();

  // Load Google widgets
  loadGoogleWidgets();

  const savedTab = getSavedTab();
  switchTab(savedTab);
}

function setCalendarDateBadge() {
  const el = document.getElementById('calendarDateBadge');
  if (!el) return;
  el.textContent = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function sameDay(a, b) {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function formatTimeRange(start, end, allDay = false) {
  if (allDay) return 'All day';
  const s = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!end) return s;
  const e = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${s} - ${e}`;
}

function setCalendarView(view = 'day') {
  calendarView = view;
  const titleEl = document.getElementById('calendarViewTitle');
  if (titleEl) {
    titleEl.textContent = view === 'week' ? 'Weekly Timeline' : view === 'month' ? 'Monthly Strategic Forecast' : "Today's Timeline";
  }
  const dayView = document.getElementById('calendarViewDay');
  const weekView = document.getElementById('calendarViewWeek');
  const monthView = document.getElementById('calendarViewMonth');
  if (dayView) dayView.classList.toggle('hidden', view !== 'day');
  if (weekView) weekView.classList.toggle('hidden', view !== 'week');
  if (monthView) monthView.classList.toggle('hidden', view !== 'month');
  updateCalendarRangeLabel();
}

function updateCalendarRangeLabel() {
  const rangeEl = document.getElementById('calendarRangeLabel');
  if (!rangeEl) return;
  const now = new Date();
  if (calendarView === 'day') {
    rangeEl.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase();
    return;
  }
  if (calendarView === 'week') {
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    rangeEl.textContent = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}`.toUpperCase();
    return;
  }
  rangeEl.textContent = now.toLocaleDateString([], { month: 'long', year: 'numeric' }).toUpperCase();
}

function buildDemoCalendarEvents() {
  const now = new Date();
  const mk = (dayOffset, hour, minute, durationMin, title) => {
    const start = new Date(now);
    start.setDate(now.getDate() + dayOffset);
    start.setHours(hour, minute, 0, 0);
    const end = new Date(start.getTime() + durationMin * 60000);
    return { title, startTime: start.toISOString(), endTime: end.toISOString() };
  };

  return [
    mk(0, 8, 30, 60, 'Morning Focus Sprint'),
    mk(0, 10, 0, 90, 'Leadership Sync'),
    mk(0, 13, 30, 90, 'Product Strategy Review'),
    mk(1, 9, 0, 60, 'Architecture Deep Work'),
    mk(2, 11, 30, 45, 'Stakeholder Update'),
    mk(3, 15, 0, 60, 'Execution Debrief'),
    mk(5, 12, 0, 90, 'Weekly Planning Block'),
    mk(10, 10, 0, 60, 'Launch Readiness'),
    mk(14, 14, 0, 90, 'Quarterly Objective Audit'),
  ];
}

function buildTaskGoalCalendarEvents(tasks = [], goals = []) {
  const appEvents = [];
  const activeGoals = (goals || []).filter(g => g.status !== 'completed');
  const goalMap = new Map(activeGoals.map(g => [Number(g.id), g]));

  (tasks || [])
    .filter(t => t.status !== 'completed' && t.deadline)
    .forEach((t) => {
      const linkedGoal = goalMap.get(Number(t.goal_id));
      appEvents.push({
        title: `Task due: ${t.title}`,
        startTime: t.deadline,
        endTime: addDays(t.deadline, 1),
        allDay: true,
        source: 'task',
        calendarName: linkedGoal ? linkedGoal.title : 'App Task',
      });
    });

  activeGoals
    .filter(g => g.deadline)
    .forEach((g) => {
      appEvents.push({
        title: `Goal deadline: ${g.title}`,
        startTime: g.deadline,
        endTime: addDays(g.deadline, 1),
        allDay: true,
        source: 'goal',
        calendarName: 'App Goal',
      });
    });

  return appEvents;
}

function mergeCalendarEventSets(...lists) {
  const out = [];
  const seen = new Set();

  lists
    .filter(Array.isArray)
    .flat()
    .forEach((e) => {
      const key = [
        String(e.source || 'google').toLowerCase(),
        String(e.title || '').trim().toLowerCase(),
        String(e.startTime || ''),
        String(e.endTime || ''),
      ].join('|');

      if (seen.has(key)) return;
      seen.add(key);
      out.push(e);
    });

  return out;
}

async function getTaskGoalCalendarEvents() {
  try {
    const [tasks, goals] = await Promise.all([api('/tasks'), api('/goals')]);
    return buildTaskGoalCalendarEvents(tasks, goals);
  } catch {
    return [];
  }
}

function calendarSourceTag(event, isDemo = false) {
  if (isDemo) return '<span class="calendar-demo-tag">DEMO</span>';
  if (event.source === 'task') return '<span class="calendar-source-tag task">TASK</span>';
  if (event.source === 'goal') return '<span class="calendar-source-tag goal">GOAL</span>';
  return '';
}

function normalizeCalendarEvents(events = []) {
  const parseCalendarStamp = (value, fallback, fallbackHour = 9) => {
    if (!value) return fallback;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      return new Date(y, (m || 1) - 1, d || 1, fallbackHour, 0, 0, 0);
    }
    const dt = new Date(value);
    return Number.isFinite(dt.getTime()) ? dt : fallback;
  };

  return events.map((e, i) => {
    const fallback = new Date();
    fallback.setHours(9 + i, 0, 0, 0);
    const allDay = !!e.allDay;
    const start = parseCalendarStamp(e.startTime, fallback, allDay ? 9 : 9);
    const end = e.endTime
      ? parseCalendarStamp(e.endTime, new Date(start.getTime() + 60 * 60000), allDay ? 17 : 10)
      : new Date(start.getTime() + 60 * 60000);
    const source = e.source || 'google';
    return { title: e.title || 'Untitled Event', start, end, allDay, calendarName: e.calendarName || '', source };
  }).sort((a, b) => a.start - b.start);
}

function renderCalendarDay(events = [], isDemo = false) {
  const list = document.getElementById('calendarDayList');
  if (!list) return;
  const today = new Date();
  const todays = events.filter(e => sameDay(e.start, today));

  if (!todays.length) {
    list.innerHTML = '<p class="empty-hint">No events today</p>';
    return;
  }

  list.innerHTML = todays.map(e => `
    <div class="calendar-day-item source-${e.source || 'google'}">
      <div class="calendar-day-time">${formatTimeRange(e.start, e.end, e.allDay)}</div>
      <div class="calendar-day-content">
        <div class="calendar-day-title">${esc(e.title)} ${calendarSourceTag(e, isDemo)}</div>
        <div class="calendar-day-meta">${e.start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}${e.calendarName ? ` | ${esc(e.calendarName)}` : ''}</div>
      </div>
    </div>
  `).join('');
}

function renderCalendarWeek(events = [], isDemo = false) {
  const grid = document.getElementById('calendarWeekGrid');
  if (!grid) return;
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay());
  start.setHours(0, 0, 0, 0);

  let html = '';
  for (let i = 0; i < 7; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const dayEvents = events.filter(e => sameDay(e.start, day));
    html += `
      <div class="calendar-week-col">
        <div class="calendar-week-head">
          <span>${day.toLocaleDateString([], { weekday: 'short' }).toUpperCase()}</span>
          <strong>${String(day.getDate()).padStart(2, '0')}</strong>
        </div>
        <div class="calendar-week-list">
          ${dayEvents.length ? dayEvents.map(e => `
            <div class="calendar-week-item source-${e.source || 'google'}">
              <div class="calendar-week-time">${e.allDay ? 'ALL DAY' : e.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              <div class="calendar-week-title">${esc(e.title)} ${calendarSourceTag(e, isDemo)}</div>
            </div>
          `).join('') : '<p class="calendar-week-empty">No events</p>'}
        </div>
      </div>
    `;
  }
  grid.innerHTML = html;
}

function renderCalendarMonth(events = [], isDemo = false) {
  const head = document.getElementById('calendarMonthHead');
  const grid = document.getElementById('calendarMonthGrid');
  if (!head || !grid) return;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startWeekDay = firstDay.getDay();
  const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  head.innerHTML = dayNames.map(d => `<span>${d}</span>`).join('');

  let html = '';
  for (let i = 0; i < startWeekDay; i++) html += '<div class="calendar-month-cell is-empty"></div>';
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
    const cellDate = new Date(year, month, dayNum);
    const cellEvents = events.filter(e => sameDay(e.start, cellDate));
    html += `
      <div class="calendar-month-cell ${sameDay(cellDate, new Date()) ? 'is-today' : ''}">
        <div class="calendar-month-date">${dayNum}</div>
        <div class="calendar-month-events">
          ${cellEvents.slice(0, 2).map(e => `<div class="calendar-month-event source-${e.source || 'google'}">${esc(e.title)} ${calendarSourceTag(e, isDemo)}</div>`).join('')}
          ${cellEvents.length > 2 ? `<div class="calendar-month-more">+${cellEvents.length - 2} more</div>` : ''}
        </div>
      </div>
    `;
  }
  grid.innerHTML = html;
}

function renderCalendarMetrics(events = []) {
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const todayCount = events.filter(e => sameDay(e.start, today)).length;
  const weekCount = events.filter(e => e.start >= weekStart && e.start <= weekEnd).length;
  const focusCount = events.filter(e => /focus|deep work|review|planning/i.test(e.title)).length;

  const todayEl = document.getElementById('calendarMetricToday');
  const weekEl = document.getElementById('calendarMetricWeek');
  const focusEl = document.getElementById('calendarMetricFocus');
  if (todayEl) todayEl.textContent = String(todayCount);
  if (weekEl) weekEl.textContent = String(weekCount);
  if (focusEl) focusEl.textContent = String(focusCount);
}

function renderCalendarViews(events = [], isDemo = false, mode = 'google') {
  calendarEventsCache = normalizeCalendarEvents(events);
  calendarIsDemo = isDemo;
  renderCalendarDay(calendarEventsCache, calendarIsDemo);
  renderCalendarWeek(calendarEventsCache, calendarIsDemo);
  renderCalendarMonth(calendarEventsCache, calendarIsDemo);
  renderCalendarMetrics(calendarEventsCache);

  const hint = document.getElementById('calendarDataHint');
  if (hint) {
    if (isDemo) {
      hint.textContent = 'Showing demo events for UI preview. Connect Google for live data.';
    } else if (mode === 'app') {
      hint.textContent = 'Showing app task and goal deadlines. Connect Google to push them to your Google Calendar app.';
    } else if (mode === 'google_app') {
      hint.textContent = 'Showing Google Calendar events plus app task and goal deadlines. Use "Sync Today Plan" to write app tasks/goals into Google Calendar.';
    } else {
      hint.textContent = 'Live Google Calendar data connected.';
    }
  }

  updateCalendarRangeLabel();
}

// ── Google Integration Widgets ──────────────────────
async function loadGoogleWidgets() {
  try {
    const status = await api('/google/status');
    const appEvents = await getTaskGoalCalendarEvents();
    const btn = document.getElementById('googleConnectBtn');
    const btnText = document.getElementById('googleConnectText');
    const syncBtn = document.getElementById('calendarSyncBtn');
    const syncText = document.getElementById('calendarSyncText');
    if (!btn || !btnText) return;

    const setSyncButton = (enabled, label, onClick) => {
      if (!syncBtn || !syncText) return;
      syncBtn.disabled = !enabled;
      syncText.textContent = label;
      syncBtn.onclick = enabled ? onClick : null;
    };

    if (status.connected) {
      btn.classList.add('connected');
      btnText.textContent = 'Google Connected';
      btn.onclick = async () => {
        if (confirm('Disconnect Google account?')) {
          await api('/google/disconnect');
          location.reload();
        }
      };

      setSyncButton(true, 'Sync Today Plan', async () => {
        if (!syncBtn || !syncText) return;
        const prev = syncText.textContent;
        syncBtn.disabled = true;
        syncText.textContent = 'Syncing...';
        try {
          const result = await api('/google/calendar/sync-today', { method: 'POST' });
          if (result?.error) throw new Error(result.error);
          notify(`Synced ${result.created || 0} item(s) to Google Calendar${result.skipped ? ` (${result.skipped} already existed)` : ''}.`);
          await loadGoogleWidgets();
        } catch (err) {
          notify(`Sync failed: ${err.message || err}`);
          syncBtn.disabled = false;
          syncText.textContent = prev || 'Sync Today Plan';
        }
      });

      // Load Calendar
      try {
        const eventsResp = await api('/google/calendar/today');
        if (Array.isArray(eventsResp)) {
          lastCalendarError = '';
          const merged = mergeCalendarEventSets(eventsResp, appEvents);
          renderCalendarViews(merged, false, appEvents.length ? 'google_app' : 'google');
        } else {
          const rawMsg = String(eventsResp?.error || 'Could not load Google Calendar events.');
          const userMsg = /disabled|enable.*calendar api|cloud project/i.test(rawMsg)
            ? 'Google Calendar API is disabled in Google Cloud. Enable it, wait 2-5 minutes, then reconnect Google.'
            : `Calendar sync error: ${rawMsg}`;
          notifyCalendarErrorOnce(userMsg);
          if (appEvents.length) renderCalendarViews(appEvents, false, 'app');
          else renderCalendarViews(buildDemoCalendarEvents(), true, 'demo');
        }
      } catch {
        notifyCalendarErrorOnce('Calendar network error. Please check connection and try again.');
        if (appEvents.length) renderCalendarViews(appEvents, false, 'app');
        else renderCalendarViews(buildDemoCalendarEvents(), true, 'demo');
      }
    } else if (status.hasCredentials) {
      // Credentials saved but not yet authorized
      btn.classList.remove('connected');
      btnText.textContent = 'Authorize Google';
      setSyncButton(false, 'Authorize First');
      if (appEvents.length) renderCalendarViews(appEvents, false, 'app');
      else renderCalendarViews(buildDemoCalendarEvents(), true, 'demo');
      btn.onclick = async () => {
        try {
          const data = await api('/google/auth-url');
          window.open(data.url, '_blank');
        } catch (err) {
          notify('Error: ' + err.message);
        }
      };
    } else {
      // No credentials at all - prompt user to enter them
      btn.classList.remove('connected');
      btnText.textContent = 'Connect Google';
      setSyncButton(false, 'Connect Google');
      if (appEvents.length) renderCalendarViews(appEvents, false, 'app');
      else renderCalendarViews(buildDemoCalendarEvents(), true, 'demo');
      btn.onclick = () => {
        const clientId = prompt('Enter your Google OAuth Client ID:\n\n(Get it from Google Cloud Console → Credentials)');
        if (!clientId) return;
        const clientSecret = prompt('Enter your Google OAuth Client Secret:');
        if (!clientSecret) return;

        api('/google/save-credentials', {
          method: 'POST',
          body: { client_id: clientId.trim(), client_secret: clientSecret.trim() }
        }).then(() => {
          notify('✓ Credentials saved! Now authorizing...');
          return api('/google/auth-url');
        }).then(data => {
          window.open(data.url, '_blank');
        }).catch(err => {
          notify('Error: ' + err.message);
        });
      };
    }
  } catch (err) {
    console.error('[Google] Widget load error:', err);
  }
}

init();




