'use strict';

/* ================================================================
   문제은행 암기 PWA
   - 간격 반복(라이트너 상자): 맞히면 다음 상자로, 틀리면 1번 상자로
   - 진도는 폰(localStorage)에 저장 + 백업 파일 내보내기/가져오기
   ================================================================ */

const STORE_KEY = 'quiz-progress-v1';
const SESSION_KEY = 'quiz-session-v1';
const DAY = 86400000;
// 상자 번호별 다음 복습까지 일수 (0 = 오늘 다시)
const INTERVALS = [0, 0, 1, 3, 7, 14, 30];
const MAX_BOX = INTERVALS.length - 1;
const MASTER_BOX = 4; // 이 상자 이상이면 '외움'
const BACKUP_REMIND_DAYS = 3;
const CIRCLED = ['①', '②', '③', '④', '⑤'];

/* ---------------- 저장소 ---------------- */

function defaultProgress() {
  return {
    v: 1,
    items: {},       // "영역:번호" -> { box, due, right, wrong, last }
    daily: {},       // "YYYY-MM-DD" -> 푼 문제 수
    settings: { shuffle: true, newPerSession: 20, examCount: 20, requeueWrong: true },
    lastBackup: 0,
    lastChange: 0,
  };
}

function safeGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function safeSet(key, val) {
  try { localStorage.setItem(key, val); return true; } catch (e) { return false; }
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch (e) { /* 무시 */ }
}

function loadProgress() {
  const raw = safeGet(STORE_KEY);
  if (!raw) return defaultProgress();
  try {
    const p = JSON.parse(raw);
    const d = defaultProgress();
    return { ...d, ...p, settings: { ...d.settings, ...(p.settings || {}) } };
  } catch (e) {
    return defaultProgress();
  }
}

let progress = loadProgress();
let storageOk = true;

function saveProgress() {
  progress.lastChange = Date.now();
  storageOk = safeSet(STORE_KEY, JSON.stringify(progress));
}

// 브라우저에 "이 앱의 저장 데이터는 지우지 말아 달라"고 요청
let persistState = 'unknown';
async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      persistState = already || (await navigator.storage.persist()) ? 'granted' : 'denied';
    } else {
      persistState = 'unsupported';
    }
  } catch (e) {
    persistState = 'unsupported';
  }
}

/* ---------------- 데이터 ---------------- */

let areas = []; // [{ id, name, category, questions: [...] }]
const qById = new Map();

async function loadData() {
  const idx = await (await fetch('data/index.json', { cache: 'no-cache' })).json();
  const loaded = await Promise.all(idx.areas.map(async (a) => {
    try {
      const res = await fetch(a.file, { cache: 'no-cache' });
      return await res.json();
    } catch (e) {
      return null;
    }
  }));
  areas = loaded.filter(Boolean);
  for (const area of areas) {
    for (const q of area.questions) {
      q.id = area.id + ':' + q.no;
      q.areaId = area.id;
      q.areaName = area.name;
      qById.set(q.id, q);
    }
  }
}

/* ---------------- 간격 반복 ---------------- */

function dayKey(t = Date.now()) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function startOfDay(t = Date.now()) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function itemOf(id) { return progress.items[id]; }
function isNew(id) { return !progress.items[id]; }
function isDue(id) {
  const it = progress.items[id];
  return !!it && it.due <= Date.now();
}
function isMastered(id) {
  const it = progress.items[id];
  return !!it && it.box >= MASTER_BOX;
}
function isWeak(id) {
  const it = progress.items[id];
  return !!it && it.wrong > 0 && it.box < MASTER_BOX;
}

function record(id, correct) {
  const it = progress.items[id] || { box: 0, due: 0, right: 0, wrong: 0, last: 0 };
  if (correct) {
    it.right++;
    it.box = Math.min(MAX_BOX, Math.max(1, it.box + 1));
  } else {
    it.wrong++;
    it.box = 1;
  }
  const days = INTERVALS[it.box];
  it.due = days === 0 ? Date.now() : startOfDay() + days * DAY;
  it.last = Date.now();
  progress.items[id] = it;
  const k = dayKey();
  progress.daily[k] = (progress.daily[k] || 0) + 1;
  saveProgress();
}

function areaStats(area) {
  let mastered = 0, learning = 0, fresh = 0, due = 0, weak = 0;
  for (const q of area.questions) {
    if (isNew(q.id)) fresh++;
    else if (isMastered(q.id)) mastered++;
    else learning++;
    if (isDue(q.id)) due++;
    if (isWeak(q.id)) weak++;
  }
  return { total: area.questions.length, mastered, learning, fresh, due, weak };
}

/* ---------------- 유틸 ---------------- */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 문제의 "옳지 않은 것" 같은 부정 표현에 강조 표시
function markNegative(text) {
  return esc(text).replace(/(옳지 않은|옳지 않는|해당되지 않는|해당하지 않는|아닌 것|틀린 것|않은 것|않는 것)/g, '<span class="neg">$1</span>');
}

// 숫자(금액, 일수, 개수 등)에 색 강조
const NUM_RE = /(\d[\d,.:~]*\s?(?:만|억|천|백)?\s?(?:원|USD|불|영업일|일|개월|년|세|개국|개|종|국|매|인|시간|분|%)?)/g;
function markNumbers(text) {
  return esc(text).replace(NUM_RE, '<span class="num">$1</span>');
}

function expText(q) {
  return q.explanation ? markNumbers(q.explanation) : '<span class="muted">(원본에 해설이 없어요)</span>';
}

function fmtDate(t) {
  if (!t) return '없음';
  const d = new Date(t);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------------- 화면 공통 ---------------- */

const $app = document.getElementById('app');
const $title = document.getElementById('title');
const $back = document.getElementById('backBtn');

function setHeader(title, showBack) {
  $title.textContent = title;
  $back.hidden = !showBack;
}

// 풀던 세션은 저장돼 있어서 뒤로 가도 홈에서 이어서 할 수 있다
$back.addEventListener('click', () => {
  if (location.hash.startsWith('#/quiz') && session && session.finished) clearSession();
  go('#/');
});
document.getElementById('settingsBtn').addEventListener('click', () => go('#/settings'));

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener('hashchange', render);

function render() {
  const h = location.hash || '#/';
  window.scrollTo(0, 0);
  if (h.startsWith('#/quiz')) return renderQuiz();
  if (h.startsWith('#/settings')) return renderSettings();
  if (h.startsWith('#/list/')) return renderList(decodeURIComponent(h.slice(7)));
  if (h.startsWith('#/area/')) return renderArea(decodeURIComponent(h.slice(7)));
  return renderHome();
}

/* ---------------- 홈 ---------------- */

function backupBanner() {
  const answered = Object.keys(progress.items).length;
  if (answered === 0) return '';
  const changedSinceBackup = progress.lastChange > progress.lastBackup;
  const days = progress.lastBackup ? Math.floor((Date.now() - progress.lastBackup) / DAY) : null;
  if (!changedSinceBackup) return '';
  if (days !== null && days < BACKUP_REMIND_DAYS) return '';
  const msg = days === null ? '아직 백업한 적이 없어요.' : `마지막 백업이 ${days}일 전이에요.`;
  return `<div class="banner warn">${msg} 진도를 잃지 않도록 백업 파일을 iCloud Drive에 저장해 두세요.
    <button class="btn" data-act="backup">지금 백업하기</button></div>`;
}

function renderHome() {
  setHeader('문제은행 암기', false);
  const saved = loadSession();
  let html = '';
  if (!storageOk) {
    html += `<div class="banner warn">이 브라우저에서 진도를 저장할 수 없어요. 개인정보 보호 브라우징을 끄고 열어주세요.</div>`;
  }
  html += backupBanner();

  if (saved && !saved.finished) {
    html += `<div class="banner info">풀던 문제가 있어요: <b>${esc(saved.title)}</b> (${saved.idx}/${saved.queue.length})
      <button class="btn primary" data-act="resume">이어서 하기</button></div>`;
  }

  let total = 0, mastered = 0, due = 0, fresh = 0, weak = 0;
  for (const a of areas) {
    const s = areaStats(a);
    total += s.total; mastered += s.mastered; due += s.due; fresh += s.fresh; weak += s.weak;
  }
  const today = progress.daily[dayKey()] || 0;

  html += `<div class="card">
    <div class="stats">
      <div><b>${today}</b><span class="muted">오늘 푼 문제</span></div>
      <div><b>${due}</b><span class="muted">복습할 문제</span></div>
      <div><b>${total ? Math.round(mastered / total * 100) : 0}%</b><span class="muted">외운 비율</span></div>
    </div>
    <div class="btn-grid">
      <button class="btn primary" data-act="study-all">오늘의 학습<small>복습 ${due} + 새 문제</small></button>
      <button class="btn" data-act="exam-all">모의고사<small>전 영역 ${Math.min(progress.settings.examCount, total)}문항</small></button>
      <button class="btn" data-act="weak-all" ${weak ? '' : 'disabled'}>오답노트<small>${weak}문항</small></button>
      <button class="btn" data-act="random-all">전체 랜덤<small>${total}문항</small></button>
    </div>
  </div>`;

  html += `<h2 class="muted" style="margin:20px 4px 8px;font-size:14px">영역 (${areas.length})</h2>`;
  for (const a of areas) {
    const s = areaStats(a);
    const pm = s.total ? (s.mastered / s.total) * 100 : 0;
    const pl = s.total ? (s.learning / s.total) * 100 : 0;
    html += `<div class="card" data-area="${esc(a.id)}" style="cursor:pointer">
      <div class="row"><h2 style="margin:0">${esc(a.name)}</h2><span class="spacer"></span>
        ${s.due ? `<span class="badge w">복습 ${s.due}</span>` : ''}</div>
      <div class="progress"><span class="p-master" style="width:${pm}%"></span><span class="p-learn" style="width:${pl}%"></span></div>
      <div class="muted">외움 ${s.mastered} · 학습 중 ${s.learning} · 안 푼 문제 ${s.fresh} / 총 ${s.total}</div>
    </div>`;
  }
  if (!areas.length) html += `<div class="card muted">문제 데이터를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.</div>`;

  $app.innerHTML = html;
  $app.querySelectorAll('[data-area]').forEach((el) => el.addEventListener('click', () => go('#/area/' + encodeURIComponent(el.dataset.area))));
  bindActs({
    backup: exportBackup,
    resume: () => { session = saved; go('#/quiz'); },
    'study-all': () => startStudy(areas),
    'exam-all': () => startExam(areas),
    'weak-all': () => startWeak(areas),
    'random-all': () => startRandom(areas),
  });
}

function bindActs(map) {
  $app.querySelectorAll('[data-act]').forEach((el) => {
    const fn = map[el.dataset.act];
    if (fn) el.addEventListener('click', fn);
  });
}

/* ---------------- 영역 ---------------- */

function renderArea(id) {
  const a = areas.find((x) => x.id === id);
  if (!a) return go('#/');
  setHeader(a.name, true);
  const s = areaStats(a);
  $app.innerHTML = `
    <div class="card">
      <div class="muted">${esc(a.category || '')}</div>
      <div class="progress"><span class="p-master" style="width:${s.mastered / s.total * 100}%"></span><span class="p-learn" style="width:${s.learning / s.total * 100}%"></span></div>
      <div class="muted">외움 ${s.mastered} · 학습 중 ${s.learning} · 안 푼 문제 ${s.fresh} / 총 ${s.total}</div>
      <div class="btn-grid">
        <button class="btn primary" data-act="study">오늘의 학습<small>복습 ${s.due} + 새 문제</small></button>
        <button class="btn" data-act="weak" ${s.weak ? '' : 'disabled'}>오답노트<small>${s.weak}문항</small></button>
        <button class="btn" data-act="seq">순서대로 풀기<small>1번부터 ${s.total}번</small></button>
        <button class="btn" data-act="random">랜덤 풀기<small>${s.total}문항</small></button>
        <button class="btn" data-act="exam">모의고사<small>${Math.min(progress.settings.examCount, s.total)}문항</small></button>
        <button class="btn" data-act="list">정답 훑어보기<small>문제 + 정답 목록</small></button>
      </div>
    </div>`;
  bindActs({
    study: () => startStudy([a]),
    weak: () => startWeak([a]),
    seq: () => startSession('순서대로 · ' + a.name, a.questions.map((q) => q.id), 'practice'),
    random: () => startRandom([a]),
    exam: () => startExam([a]),
    list: () => go('#/list/' + encodeURIComponent(a.id)),
  });
}

/* ---------------- 정답 훑어보기 ---------------- */

function renderList(id) {
  const a = areas.find((x) => x.id === id);
  if (!a) return go('#/');
  setHeader('정답 훑어보기', true);
  let html = `<div class="card"><div class="row wrap">
      <label class="toggle" style="padding:0"><span>안 외운 것만</span><input type="checkbox" id="onlyWeak"></label>
    </div></div><div class="card"><ul class="qlist" id="qlist">`;
  for (const q of a.questions) {
    const it = itemOf(q.id);
    const badge = isMastered(q.id) ? '<span class="badge m">외움</span>' : isWeak(q.id) ? '<span class="badge w">오답</span>' : '';
    html += `<li data-id="${esc(q.id)}" data-m="${isMastered(q.id) ? 1 : 0}">
      <div style="white-space:pre-line"><b>${q.no}.</b> ${markNegative(q.q)} ${badge}</div>
      <div class="ans">${CIRCLED[q.answer - 1]} ${markNumbers(q.choices[q.answer - 1])}</div>
      <div class="muted" style="white-space:pre-line">${expText(q)}</div>
      ${q.answerNote ? `<div class="note">${esc(q.answerNote)}</div>` : ''}
      ${it ? `<div class="muted">맞힘 ${it.right} · 틀림 ${it.wrong}</div>` : ''}
    </li>`;
  }
  html += '</ul></div>';
  $app.innerHTML = html;
  document.getElementById('onlyWeak').addEventListener('change', (e) => {
    $app.querySelectorAll('#qlist li').forEach((li) => {
      li.hidden = e.target.checked && li.dataset.m === '1';
    });
  });
}

/* ---------------- 세션 ---------------- */

let session = null;

function saveSession() {
  if (session) safeSet(SESSION_KEY, JSON.stringify(session));
}
function loadSession() {
  const raw = safeGet(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    // 데이터가 바뀌어 사라진 문제는 빼고 이어서
    s.queue = s.queue.filter((x) => qById.has(x.id));
    if (s.idx > s.queue.length) s.idx = s.queue.length;
    return s;
  } catch (e) {
    return null;
  }
}
function clearSession() {
  session = null;
  safeRemove(SESSION_KEY);
}

function makeOrder() {
  const base = [0, 1, 2, 3];
  return progress.settings.shuffle ? shuffle(base) : base;
}

// mode: 'practice' (바로 채점) | 'exam' (끝나고 채점)
function startSession(title, ids, mode) {
  if (!ids.length) {
    alert('풀 문제가 없어요.');
    return;
  }
  session = {
    title,
    mode,
    queue: ids.map((id) => ({ id, order: makeOrder(), retry: false })),
    idx: 0,
    picked: null,         // 현재 문제에서 고른 보기(원래 번호 0~3)
    answers: [],          // { id, picked, correct, retry }
    startedAt: Date.now(),
    finished: false,
  };
  saveSession();
  go('#/quiz');
}

function questionsOf(areaList) {
  return areaList.flatMap((a) => a.questions.map((q) => q.id));
}

function startStudy(areaList) {
  const all = questionsOf(areaList);
  const due = shuffle(all.filter(isDue)).sort((x, y) => itemOf(x).due - itemOf(y).due);
  const fresh = all.filter(isNew).slice(0, progress.settings.newPerSession);
  const ids = due.concat(shuffle(fresh));
  if (!ids.length) {
    alert('오늘 복습할 문제와 새 문제를 모두 끝냈어요. 랜덤 풀기나 모의고사로 연습해 보세요.');
    return;
  }
  startSession('오늘의 학습', ids, 'practice');
}
function startWeak(areaList) {
  startSession('오답노트', shuffle(questionsOf(areaList).filter(isWeak)), 'practice');
}
function startRandom(areaList) {
  startSession('랜덤 풀기', shuffle(questionsOf(areaList)), 'practice');
}
function startExam(areaList) {
  const ids = shuffle(questionsOf(areaList)).slice(0, progress.settings.examCount);
  startSession('모의고사', ids, 'exam');
}

/* ---------------- 문제 풀이 화면 ---------------- */

function renderQuiz() {
  if (!session) session = loadSession();
  if (!session) return go('#/');
  if (session.finished || session.idx >= session.queue.length) return renderSummary();

  setHeader(session.title, true);
  const cur = session.queue[session.idx];
  const q = qById.get(cur.id);
  if (!q) { session.idx++; saveSession(); return renderQuiz(); }

  const answered = session.picked !== null;
  const showResult = answered && session.mode === 'practice';
  const correctIdx = q.answer - 1;

  let html = `<div class="card">
    <div class="qmeta"><span>${esc(q.areaName)} · ${q.no}번${cur.retry ? ' · 다시 풀기' : ''}</span><span>${session.idx + 1} / ${session.queue.length}</span></div>
    <p class="qtext">${markNegative(q.q)}</p>
    <div class="choices">`;
  cur.order.forEach((orig, pos) => {
    let cls = 'choice';
    if (showResult) {
      if (orig === correctIdx) cls += ' correct';
      else if (orig === session.picked) cls += ' wrong';
      else cls += ' dim';
    }
    const label = CIRCLED[pos];
    const origLabel = showResult && progress.settings.shuffle && orig !== pos ? ` <span class="badge">원래 ${CIRCLED[orig]}</span>` : '';
    const text = showResult ? markNumbers(q.choices[orig]) : esc(q.choices[orig]);
    html += `<button class="${cls}" data-orig="${orig}" ${answered ? 'disabled' : ''}>
      <span class="mark">${label}</span><span>${text}${origLabel}</span></button>`;
  });
  html += '</div>';

  if (showResult) {
    const ok = session.picked === correctIdx;
    html += `<div class="result ${ok ? 'ok' : 'bad'}">
      <h3>${ok ? '정답이에요' : '틀렸어요'} · 정답 ${CIRCLED[correctIdx]}${progress.settings.shuffle ? ' (원본 번호)' : ''}</h3>
      <div class="exp">${expText(q)}</div>
      <div class="src">[출처: ${esc(q.source)}]</div>
      ${q.answerNote ? `<div class="note">${esc(q.answerNote)}</div>` : ''}
    </div>`;
  }
  html += '</div>';

  if (showResult) {
    html += `<div style="margin-top:12px"><button class="btn primary" id="nextBtn">다음 문제</button></div>`;
  }
  html += `<button class="btn" id="quitBtn" style="margin-top:12px">${session.mode === 'exam' ? '그만두고 채점하기' : '여기까지 하기'}</button>`;

  $app.innerHTML = html;

  if (!answered) {
    $app.querySelectorAll('.choice').forEach((el) => el.addEventListener('click', () => pick(Number(el.dataset.orig))));
  }
  const next = document.getElementById('nextBtn');
  if (next) next.addEventListener('click', nextQuestion);
  document.getElementById('quitBtn').addEventListener('click', () => {
    if (session.mode === 'exam' || confirm('지금까지 푼 기록은 저장돼요. 끝낼까요?')) finish();
  });
}

function pick(orig) {
  const cur = session.queue[session.idx];
  const q = qById.get(cur.id);
  const correct = orig === q.answer - 1;
  session.picked = orig;
  session.answers.push({ id: cur.id, picked: orig, correct, retry: cur.retry });

  // 같은 세션에서 다시 푼 문제는 기록(상자)을 바꾸지 않는다
  if (!cur.retry) record(cur.id, correct);

  // 틀린 문제는 몇 문제 뒤에 한 번 더 낸다 (연습 모드)
  if (!correct && session.mode === 'practice' && progress.settings.requeueWrong) {
    const at = Math.min(session.queue.length, session.idx + 4);
    session.queue.splice(at, 0, { id: cur.id, order: makeOrder(), retry: true });
  }
  saveSession();

  if (session.mode === 'exam') nextQuestion();
  else renderQuiz();
}

function nextQuestion() {
  session.idx++;
  session.picked = null;
  if (session.idx >= session.queue.length) session.finished = true;
  saveSession();
  renderQuiz();
}

function finish() {
  session.finished = true;
  saveSession();
  renderSummary();
}

function renderSummary() {
  setHeader('결과', true);
  const first = session.answers.filter((a) => !a.retry);
  const right = first.filter((a) => a.correct).length;
  const wrong = first.filter((a) => !a.correct);
  const mins = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
  let html = `<div class="card">
    <div class="stats">
      <div><b>${first.length}</b><span class="muted">푼 문제</span></div>
      <div><b>${right}</b><span class="muted">맞힘</span></div>
      <div><b>${first.length ? Math.round(right / first.length * 100) : 0}%</b><span class="muted">정답률</span></div>
    </div>
    <div class="muted" style="text-align:center;margin-top:8px">약 ${mins}분</div>
  </div>`;
  if (wrong.length) {
    html += `<div class="card"><h2>틀린 문제 (${wrong.length})</h2><ul class="qlist">`;
    for (const w of wrong) {
      const q = qById.get(w.id);
      if (!q) continue;
      html += `<li><div style="white-space:pre-line"><b>${esc(q.areaName)} ${q.no}.</b> ${markNegative(q.q)}</div>
        <div class="muted">내가 고른 답: ${CIRCLED[w.picked]} ${esc(q.choices[w.picked])}</div>
        <div class="ans">정답 ${CIRCLED[q.answer - 1]} ${markNumbers(q.choices[q.answer - 1])}</div>
        <div class="muted" style="white-space:pre-line">${expText(q)}</div></li>`;
    }
    html += '</ul></div>';
  }
  html += `<div class="btn-grid">
    ${wrong.length ? '<button class="btn primary" data-act="redo">틀린 것만 다시</button>' : ''}
    <button class="btn" data-act="home">홈으로</button></div>`;
  $app.innerHTML = html;
  const wrongIds = [...new Set(wrong.map((w) => w.id))];
  bindActs({
    redo: () => startSession('틀린 문제 다시', shuffle(wrongIds), 'practice'),
    home: () => { clearSession(); go('#/'); },
  });
}

/* ---------------- 백업 ---------------- */

async function exportBackup() {
  const payload = {
    app: 'exam-quiz',
    v: 1,
    exportedAt: new Date().toISOString(),
    progress,
  };
  const name = `문제은행-백업-${dayKey()}.json`;
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });

  let done = false;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      // 아이폰: 공유 시트 → "파일에 저장" → iCloud Drive
      await navigator.share({ files: [file], title: name });
      done = true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 사용자가 취소
  }
  if (!done) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  progress.lastBackup = Date.now();
  // lastChange는 건드리지 않도록 직접 저장
  storageOk = safeSet(STORE_KEY, JSON.stringify(progress));
  render();
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      alert('백업 파일을 읽을 수 없어요.');
      return;
    }
    if (!data || data.app !== 'exam-quiz' || !data.progress || typeof data.progress.items !== 'object') {
      alert('이 앱의 백업 파일이 아니에요.');
      return;
    }
    const n = Object.keys(data.progress.items).length;
    if (!confirm(`${data.exportedAt ? fmtDate(Date.parse(data.exportedAt)) + '에 만든 ' : ''}백업(${n}문항 기록)으로 지금 진도를 바꿀까요?`)) return;
    const d = defaultProgress();
    progress = { ...d, ...data.progress, settings: { ...d.settings, ...(data.progress.settings || {}) } };
    progress.lastBackup = Date.now();
    storageOk = safeSet(STORE_KEY, JSON.stringify(progress));
    clearSession();
    alert('복원했어요.');
    go('#/');
  };
  reader.readAsText(file);
}

/* ---------------- 설정 ---------------- */

function renderSettings() {
  setHeader('설정', true);
  const s = progress.settings;
  const persistText = {
    granted: '삭제 방지 켜짐',
    denied: '삭제 방지 요청 거절됨 (홈 화면에 추가하면 7일 자동 삭제 대상에서 빠져요)',
    unsupported: '이 브라우저는 삭제 방지 요청을 지원하지 않아요',
    unknown: '확인 중',
  }[persistState];
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  $app.innerHTML = `
    ${standalone ? '' : `<div class="banner info">Safari 공유 버튼 → <b>홈 화면에 추가</b>로 설치해서 쓰세요. 홈 화면 앱은 진도가 더 안전하게 보관돼요.</div>`}
    <div class="card">
      <h2>풀이 설정</h2>
      <label class="toggle"><span>보기 순서 섞기<br><span class="muted">번호가 아니라 내용으로 외우게 해줘요</span></span><input type="checkbox" id="optShuffle" ${s.shuffle ? 'checked' : ''}></label>
      <label class="toggle"><span>틀린 문제 몇 문제 뒤 다시 내기</span><input type="checkbox" id="optRequeue" ${s.requeueWrong ? 'checked' : ''}></label>
      <label class="toggle"><span>한 번에 새 문제 수</span><input type="number" id="optNew" min="5" max="200" step="5" value="${s.newPerSession}" style="width:80px"></label>
      <label class="toggle"><span>모의고사 문항 수</span><input type="number" id="optExam" min="5" max="200" step="5" value="${s.examCount}" style="width:80px"></label>
    </div>
    <div class="card">
      <h2>진도 백업</h2>
      <div class="muted">마지막 백업: ${fmtDate(progress.lastBackup)}<br>저장 상태: ${esc(persistText)}</div>
      <div class="btn-grid">
        <button class="btn primary" data-act="backup">백업 파일 저장</button>
        <button class="btn" data-act="restore">백업에서 복원</button>
      </div>
      <input type="file" id="restoreFile" accept="application/json,.json" hidden>
      <p class="muted">공유 창에서 <b>"파일에 저장" → iCloud Drive</b>를 고르면 폰을 바꾸거나 앱을 지워도 복원할 수 있어요.</p>
    </div>
    <div class="card">
      <h2>초기화</h2>
      <p class="muted">초기화하기 전에 백업부터 해두세요. 되돌릴 수 없어요.</p>
      <select id="resetArea" style="width:100%;margin-bottom:8px">
        <option value="">전체 영역</option>
        ${areas.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}
      </select>
      <button class="btn danger" data-act="reset">진도 초기화</button>
    </div>
    <p class="muted" style="text-align:center">학습 원리: 인출 연습(Roediger & Karpicke, 2006), 간격 반복(Cepeda 외, 2006)</p>`;

  const num = (el, min, max) => Math.min(max, Math.max(min, parseInt(el.value, 10) || min));
  document.getElementById('optShuffle').addEventListener('change', (e) => { s.shuffle = e.target.checked; saveProgress(); });
  document.getElementById('optRequeue').addEventListener('change', (e) => { s.requeueWrong = e.target.checked; saveProgress(); });
  document.getElementById('optNew').addEventListener('change', (e) => { s.newPerSession = num(e.target, 5, 200); saveProgress(); });
  document.getElementById('optExam').addEventListener('change', (e) => { s.examCount = num(e.target, 5, 200); saveProgress(); });
  const fileInput = document.getElementById('restoreFile');
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) importBackup(fileInput.files[0]); fileInput.value = ''; });
  bindActs({
    backup: exportBackup,
    restore: () => fileInput.click(),
    reset: () => {
      const areaId = document.getElementById('resetArea').value;
      const label = areaId ? areas.find((a) => a.id === areaId).name : '전체 영역';
      if (!confirm(`${label}의 진도를 모두 지울까요? 되돌릴 수 없어요.`)) return;
      if (!confirm('정말 지울까요?')) return;
      if (areaId) {
        for (const k of Object.keys(progress.items)) if (k.startsWith(areaId + ':')) delete progress.items[k];
      } else {
        progress.items = {};
        progress.daily = {};
      }
      saveProgress();
      clearSession();
      alert('초기화했어요.');
      go('#/');
    },
  });
}

/* ---------------- 시작 ---------------- */

(async function init() {
  $app.innerHTML = '<div class="card muted">불러오는 중…</div>';
  requestPersist();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    await loadData();
  } catch (e) {
    areas = [];
  }
  render();
})();
