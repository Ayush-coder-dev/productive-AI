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

// ── Navigation ──────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tab}`));

  // Update topbar context
  const labels = { home: 'PRODUCTIVITY COACHING', strategy: 'STRATEGIC EXECUTION', velocity: 'THE PULSE', rituals: 'SUBCONSCIOUS ARCHITECTURE' };
  document.getElementById('topbarContext').textContent = labels[tab] || '';

  if (tab === 'strategy') loadTasksAndGoals();
  if (tab === 'velocity') loadAnalytics();
  if (tab === 'rituals') loadHabits();
}

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
    appendMsg('assistant', data.reply || 'Apologies — I couldn\'t process that directive.');
  } catch {
    typing.remove();
    appendMsg('assistant', 'Connection error — is Ollama running?');
  }
  loadSidebarStats();
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
        if (layout) layout.classList.toggle('hide-history');
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
            } else {
                displayTime = '<span class="tm-urgent">TRIGGERING NOW</span>';
            }
        } else {
            // It's a cron
            displayTime = `<span class="tm-cron">CRON: ${r.time_rule}</span>`;
        }
        
        return `
        <div class="timer-item">
            <div class="timer-pulse"></div>
            <div class="timer-details">
                <div class="timer-title">${esc(r.title)}</div>
                <div class="timer-countdown">${displayTime}</div>
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
          ${tc.map((t, index) => `<div class="roadmap-step ${t.status==='completed'?'done':''}" onclick="toggleTask(${t.id},'${t.status}')">
            <div class="step-node"></div>
            <div class="step-content">
              <div class="step-level">Level ${index + 1}</div>
              <div class="step-title">${esc(t.title)}</div>
            </div>
          </div>`).join('')}
          <button class="mark-obj-btn" onclick="toggleGoal(${g.id},'${g.status}')">${g.status === 'completed' ? 'Reopen Objective' : 'Claim Final Reward (Complete)'}</button>
        </div>
      </div>`;
    }).join('');
  }

  // Task pipeline
  let ft = tasks;
  if (taskFilter === 'active') ft = tasks.filter(t => t.status === 'pending');
  if (taskFilter === 'completed') ft = tasks.filter(t => t.status === 'completed');

  const tl = document.getElementById('tasksList');
  if (!ft.length) {
    tl.innerHTML = `<p class="pipeline-empty">${taskFilter === 'all' ? 'No tasks in pipeline' : 'No ' + taskFilter + ' tasks'}</p>`;
  } else {
    tl.innerHTML = ft.map((t, i) => `<div class="pipeline-item ${t.status==='completed'?'completed':''}" style="animation-delay:${i*.03}s">
      <button class="task-check ${t.status==='completed'?'done':''}" onclick="toggleTask(${t.id},'${t.status}')">${t.status==='completed'?'✓':''}</button>
      <div class="task-body">
        <div class="task-name">${esc(t.title)}</div>
        <div class="task-due">${t.deadline ? relDate(t.deadline) : ''}</div>
      </div>
      <span class="task-priority tp-${t.priority}">${t.priority.toUpperCase()}</span>
    </div>`).join('');
  }
}

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
  const taskPct = Math.round((score.breakdown.tasks / 30) * 100);
  const focusPct = Math.round((score.breakdown.focus / 25) * 100);
  const timePct = Math.round((score.breakdown.time / 25) * 100);
  document.getElementById('bfTasks').style.width = taskPct + '%';
  document.getElementById('bfFocus').style.width = focusPct + '%';
  document.getElementById('bfTime').style.width = timePct + '%';
  document.getElementById('pctTasks').textContent = taskPct + '%';
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

  // Velocity Trend chart (weekly or timeline)
  const trendLabels = weekly.dailyBreakdown.map(d => new Date(d.date).toLocaleDateString('en', { weekday: 'short' }).toUpperCase());
  const trendData = weekly.dailyBreakdown.map(d => d.productiveMinutes);
  renderChart('velocityChart', 'line', trendLabels, trendData, '#7C5CFC');

  // Deep State ratio (hourly)
  const hourLabels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
  const hourData = Array.from({ length: 24 }, (_, i) => daily.hourlyBreakdown[i] || 0);
  renderChart('deepStateChart', 'bar', hourLabels.filter((_, i) => i >= 6 && i <= 22), hourData.filter((_, i) => i >= 6 && i <= 22), '#2DD4A0');
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
  const tabs = ['home', 'strategy', 'velocity', 'rituals'];
  if (e.ctrlKey && e.key >= '1' && e.key <= '4') { e.preventDefault(); switchTab(tabs[+e.key - 1]); }
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
  await loadSessions();
  if(!currentSessionId) {
    await loadChatHistory();
  }
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

  // Load Google widgets
  loadGoogleWidgets();
}

// ── Google Integration Widgets ──────────────────────
async function loadGoogleWidgets() {
  try {
    const status = await api('/google/status');
    const btn = document.getElementById('googleConnectBtn');
    const btnText = document.getElementById('googleConnectText');

    if (status.connected) {
      btn.classList.add('connected');
      btnText.textContent = '✓ Google Connected';
      btn.onclick = async () => {
        if (confirm('Disconnect Google account?')) {
          await api('/google/disconnect');
          location.reload();
        }
      };

      // Load Calendar
      try {
        const events = await api('/google/calendar/today');
        const widget = document.getElementById('calendarWidget');
        if (events.length > 0) {
          widget.innerHTML = events.map(e => {
            const time = e.startTime ? new Date(e.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'All day';
            return `<div class="g-event-item">
              <span class="g-event-time">${time}</span>
              <span class="g-event-title">${esc(e.title)}</span>
            </div>`;
          }).join('');
        } else {
          widget.innerHTML = '<p class="empty-hint">No events today</p>';
        }
      } catch {}

      // Load Gmail
      try {
        const emails = await api('/google/gmail/unread');
        const widget = document.getElementById('gmailWidget');
        if (emails.length > 0) {
          widget.innerHTML = emails.map(e => `<div class="g-email-item">
            <div>
              <div class="g-email-from">${esc(e.from)}</div>
              <div class="g-email-subject">${esc(e.subject)}</div>
            </div>
          </div>`).join('');
        } else {
          widget.innerHTML = '<p class="empty-hint">Inbox zero! 🎉</p>';
        }
      } catch {}

    } else if (status.hasCredentials) {
      // Credentials saved but not yet authorized
      btnText.textContent = 'Authorize Google';
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
      btnText.textContent = 'Connect Google';
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
