// 자동 테스트: node --test dev/test.mjs  (npm test)
// - docs/logic.js의 순수 함수 (날짜, 메모 형식, 할 일 묶기)
// - docs/api.js를 가짜 구글 REST API(dev/fake-fetch.js)에 연결해 저장 흐름 확인
// - docs/auth.js(로그인), docs/sw.js(서비스 워커)
process.env.TZ = 'Asia/Seoul';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stampHtml, readDoc } from './stamp.mjs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const plain = (o) => JSON.parse(JSON.stringify(o));
const eq = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
const TODAY = '2026-11-17'; // 화요일

function loadLogic() {
  const ctx = vm.createContext({ console });
  vm.runInContext(read('docs/logic.js'), ctx, { filename: 'logic.js' });
  return ctx.Logic;
}

/** docs/auth.js + 가짜 브라우저 (주소창, 기록, 저장소) */
function loadAuth(opts) {
  opts = opts || {};
  const store = new Map(opts.storage || []);
  const listeners = {};
  const nav = [];
  const loc = {
    origin: 'https://moontur.github.io', pathname: '/schedule/', search: '', hash: opts.hash || '',
    assign: (u) => nav.push(['assign', new URL(u)]), replace: (u) => nav.push(['replace', new URL(u)]),
  };
  const ctx = vm.createContext({
    console, URL, URLSearchParams, crypto: globalThis.crypto,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    location: loc,
    history: { state: null, replaceState: () => { loc.hash = ''; } },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    fetch: async () => ({}),
    APP_CONFIG: { clientId: 'cid.apps.googleusercontent.com' },
  });
  ctx.window = ctx;
  vm.runInContext(read('docs/auth.js'), ctx, { filename: 'auth.js' });
  return { Auth: ctx.Auth, store, nav, loc, fire: (type, ev) => (listeners[type] || []).forEach((f) => f(ev)) };
}
const SC = {
  ro: 'https://www.googleapis.com/auth/calendar.readonly',
  ev: 'https://www.googleapis.com/auth/calendar.events',
  tasks: 'https://www.googleapis.com/auth/tasks',
  calFull: 'https://www.googleapis.com/auth/calendar',
};

/** docs/sw.js + 가짜 서비스 워커 환경 (저장소는 주소 전체 → 내용) */
function loadSw(fetchImpl) {
  const handlers = {};
  const cache = new Map();
  const href = (req) => new URL(typeof req === 'string' ? req : req.url, 'https://moontur.github.io/schedule/').href;
  const path = (h) => { const u = new URL(h); return u.origin + u.pathname; };
  const match = async (req, o) => {
    const h = href(req);
    const k = o && o.ignoreSearch ? [...cache.keys()].find((x) => path(x) === path(h)) : (cache.has(h) ? h : undefined);
    return k === undefined ? undefined : new Response(cache.get(k));
  };
  const store = {
    put: async (req, res) => { cache.set(href(req), await res.text()); },
    match,
    add: async (u) => { const res = await fetchImpl(u); if (!res.ok) throw new TypeError('bad'); cache.set(href(u), await res.text()); },
    addAll: async () => {},
    keys: async () => [...cache.keys()].map((url) => ({ url })),
    delete: async (req) => cache.delete(href(req)),
  };
  const caches = { open: async () => store, match, keys: async () => [], delete: async () => true };
  const self = {
    location: { origin: 'https://moontur.github.io' }, WS_NET_TIMEOUT: 60,
    addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting: () => {}, clients: { claim: async () => {} },
  };
  const ctx = vm.createContext({ self, caches, fetch: fetchImpl, Response, Request, URL, setTimeout, clearTimeout, console });
  vm.runInContext(read('docs/sw.js'), ctx, { filename: 'sw.js' });
  return {
    cache,
    async get(url) {
      let responded = null;
      const waits = [];
      handlers.fetch({ request: new Request(url), respondWith: (p) => { responded = p; }, waitUntil: (p) => waits.push(p) });
      const started = Date.now();
      const res = responded ? await responded : null;
      return { res, body: res && res.type !== 'error' ? await res.text() : null, ms: Date.now() - started, settle: () => Promise.all(waits) };
    },
  };
}
const later = (ms, value, fail) => new Promise((ok, bad) => setTimeout(() => (fail ? bad(new TypeError('network')) : ok(value)), ms));

/** docs/api.js + 가짜 구글 REST API */
function loadApi(opts) {
  opts = opts || {};
  const ctx = vm.createContext({ console, URL, URLSearchParams, Response, setTimeout });
  vm.runInContext(read('dev/fake-google.js'), ctx, { filename: 'fake-google.js' });
  vm.runInContext(read('dev/fake-fetch.js'), ctx, { filename: 'fake-fetch.js' });
  const g = ctx.makeFakeGoogle({ sample: true, today: TODAY });
  const net = ctx.installFakeFetch(ctx, g, { delay: 0, validToken: 'tok' });
  vm.runInContext(read('docs/api.js'), ctx, { filename: 'api.js' });
  const api = ctx.GoogleApi;
  let token = opts.token === undefined ? 'tok' : opts.token;
  const unauthorized = [];
  const scopeMissing = [];
  api.config.getToken = () => token;
  api.config.onUnauthorized = (e) => unauthorized.push(e.status);
  api.config.onScopeMissing = (e) => scopeMissing.push(e.code);
  return { api, g, net, unauthorized, scopeMissing, setToken: (t) => { token = t; } };
}

const L = loadLogic();

/* ================= Logic: 날짜 ================= */

test('달력: 2026년 11월은 일요일 11/1에 시작해 5주', () => {
  const w = L.monthWeeks('2026-11');
  assert.equal(w.length, 5);
  assert.equal(w[0][0], '2026-11-01');
  assert.equal(w[4][6], '2026-12-05');
});

test('달력: 2026년 8월은 6주 (1일이 토요일)', () => {
  const w = L.monthWeeks('2026-08');
  assert.equal(w.length, 6);
  assert.equal(w[0][0], '2026-07-26');
  assert.equal(w[0][6], '2026-08-01');
});

test('달력: 서버에 요청할 기간은 한국 시간 0시 기준', () => {
  const r = L.monthRange('2026-11');
  assert.equal(r.start, '2026-11-01');
  assert.equal(r.end, '2026-12-06');
  assert.equal(r.startIso, '2026-10-31T15:00:00.000Z');
});

test('달 이동: 연도가 바뀌어도 맞음', () => {
  assert.equal(L.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(L.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(L.monthLabel('2026-03'), '2026년 3월');
});

test('날짜 글자', () => {
  assert.equal(L.fmtMD('2026-11-17'), '11/17 (화)');
  assert.equal(L.fmtMD('2026-11-17', 2025), '2026/11/17 (화)');
  assert.equal(L.fmtLong('2026-11-17'), '11월 17일 화요일');
  assert.equal(L.addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(L.diffDays('2026-11-17', '2026-11-27'), 10);
});

test('마감일 표시: 지남 / 오늘 / D-3(임박) / D-10', () => {
  eq(plain(L.dueInfo('2026-11-16', TODAY)), { text: '1일 지남', tone: 'danger', days: -1 });
  assert.equal(L.dueInfo('2026-11-17', TODAY).text, '오늘 마감');
  eq(plain(L.dueInfo('2026-11-20', TODAY)), { text: 'D-3', tone: 'soon', days: 3 });
  assert.equal(L.dueInfo('2026-11-27', TODAY).tone, '');
  assert.equal(L.dueInfo('', TODAY).text, '');
});

/* ================= Logic: 일정 ================= */

test('일정: 여러 날 종일 일정은 끝 날짜(포함 안 함) 전날까지', () => {
  const ev = { id: 'a', calendarId: 'c', title: '출장', allDay: true, start: '2026-11-05', end: '2026-11-07' };
  assert.equal(L.eventsOn([ev], '2026-11-05').length, 1);
  assert.equal(L.eventsOn([ev], '2026-11-06').length, 1);
  assert.equal(L.eventsOn([ev], '2026-11-07').length, 0);
  assert.equal(L.eventStartLabel(ev, '2026-11-06'), '종일');
});

test('일정: 자정을 넘기는 일정은 이틀에 모두 보임', () => {
  const ev = { id: 'n', calendarId: 'c', title: '야간', allDay: false, start: '2026-11-20T23:00:00+09:00', end: '2026-11-21T01:00:00+09:00' };
  assert.equal(L.eventsOn([ev], '2026-11-20').length, 1);
  assert.equal(L.eventsOn([ev], '2026-11-21').length, 1);
  assert.equal(L.eventStartLabel(ev, '2026-11-21'), '계속');
  assert.equal(L.eventTimeRange(ev, '2026-11-21'), '00:00–01:00');
});

test('일정: 밤 12시에 끝나는 일정은 다음 날에 안 보임', () => {
  const ev = { id: 'm', calendarId: 'c', title: '저녁', allDay: false, start: '2026-11-20T22:00:00+09:00', end: '2026-11-21T00:00:00+09:00' };
  assert.equal(L.eventsOn([ev], '2026-11-21').length, 0);
});

test('일정: 종일 일정 먼저, 그다음 시작 시간 순', () => {
  const a = { id: '1', calendarId: 'c', title: '회의', allDay: false, start: '2026-11-17T14:00:00+09:00', end: '2026-11-17T15:00:00+09:00' };
  const b = { id: '2', calendarId: 'c', title: '아침', allDay: false, start: '2026-11-17T09:00:00+09:00', end: '2026-11-17T10:00:00+09:00' };
  const c = { id: '3', calendarId: 'c', title: '휴가', allDay: true, start: '2026-11-17', end: '2026-11-18' };
  eq(L.eventsOn([a, b, c], '2026-11-17').map((e) => e.id), ['3', '2', '1']);
});

test('일정: 여러 달 캐시에서 같은 일정은 한 번만', () => {
  const ev = { id: 'x', calendarId: 'c' };
  assert.equal(L.mergeEvents([[ev], [ev, { id: 'x', calendarId: 'd' }]]).length, 2);
});

/* ================= Logic: 메모 ================= */

const NOTES = '목표 분량: 30쪽\n[2026-11-13] 자문 의견: 비교표 추가\n[2026-11-11] 통계 교체\n담당자에게 요청함\n[2026-11-10] 착수';

test('메모 읽기: 날짜 없는 글, 날짜 메모, 여러 줄 메모', () => {
  const m = L.parseMemo(NOTES);
  assert.equal(m.loose, '목표 분량: 30쪽');
  eq(m.entries.map((e) => e.date), ['2026-11-13', '2026-11-11', '2026-11-10']);
  assert.equal(m.entries[1].text, '통계 교체\n담당자에게 요청함');
});

test('메모 넣기: 빈 메모 칸', () => {
  assert.equal(L.insertMemoEntry('', TODAY, '  첫 메모 '), '[2026-11-17] 첫 메모');
});

test('메모 넣기: 날짜 없는 글만 있으면 그 아래에', () => {
  const out = L.insertMemoEntry('Tasks 앱에서 쓴 글', TODAY, '새 메모');
  assert.equal(out, 'Tasks 앱에서 쓴 글\n[2026-11-17] 새 메모');
  const m = L.parseMemo(out);
  assert.equal(m.loose, 'Tasks 앱에서 쓴 글');
  assert.equal(m.entries[0].text, '새 메모');
});

test('메모 넣기: 날짜 메모들 맨 위(최신이 위)에 들어가고 날짜 없는 글은 그대로', () => {
  const out = L.insertMemoEntry(NOTES, TODAY, '오늘 메모\n둘째 줄');
  const m = L.parseMemo(out);
  assert.equal(m.loose, '목표 분량: 30쪽');
  eq(m.entries.map((e) => e.date), ['2026-11-17', '2026-11-13', '2026-11-11', '2026-11-10']);
  assert.equal(m.entries[0].text, '오늘 메모\n둘째 줄');
});

test('메모 지우기: 여러 줄 메모도 통째로 지워짐', () => {
  const out = L.removeMemoEntry(NOTES, 1);
  assert.equal(out, '목표 분량: 30쪽\n[2026-11-13] 자문 의견: 비교표 추가\n[2026-11-10] 착수');
  assert.equal(L.removeMemoEntry(NOTES, 9), NOTES);
});

test('메모: 윈도 줄바꿈(\\r\\n)도 똑같이 읽음', () => {
  assert.equal(L.parseMemo('[2026-11-10] a\r\nb').entries[0].text, 'a\nb');
});

/* ================= Logic: 할 일 묶기 ================= */

const TASKS = [
  { id: 'o', title: '지난', due: '2026-11-16', done: false, parent: '' },
  { id: 't', title: '오늘', due: '2026-11-17', done: false, parent: '' },
  { id: 'w', title: '이번 주', due: '2026-11-21', done: false, parent: '' },
  { id: 'l', title: '다음 주', due: '2026-11-22', done: false, parent: '' },
  { id: 'n', title: '날짜 없음', due: '', done: false, parent: '' },
  { id: 'd', title: '완료', due: '2026-11-10', done: true, completed: '2026-11-10T01:00:00.000Z', parent: '' },
  { id: 's', title: '하위', due: '2026-11-16', done: false, parent: 't', position: '1' },
  { id: 'u', title: '하위2', due: '', done: true, parent: 't', position: '0' },
];

test('할 일 목록: 지난 기한 / 오늘 / 이번 주(토요일까지) / 다음 주 이후 / 날짜 없음', () => {
  const g = L.groupTasks(TASKS, TODAY);
  eq(g.map((x) => x.key), ['overdue', 'today', 'week', 'later', 'nodate']);
  eq(g.map((x) => x.items.map((t) => t.id)), [['o'], ['t'], ['w'], ['l'], ['n']]);
  eq(L.doneTasks(TASKS).map((t) => t.id), ['d']);
});

// 마감이 먼 할 일(2주 넘게), 완료한 날짜 없는 할 일, 날짜 없는 하위 할 일, 먼 하위 할 일
const MORE = TASKS.concat([
  { id: 'f', title: '먼 마감', due: '2027-01-10', done: false, parent: '' },
  { id: 'n2', title: '날짜 없음 완료', due: '', done: true, parent: '' },
  { id: 'n3', title: '날짜 없는 하위', due: '', done: false, parent: 't' },
  { id: 'sf', title: '먼 하위', due: '2026-12-01', done: false, parent: 'l' },
]);

test('오늘 화면 할 일: 지난 기한(하위 포함) / 오늘 / 앞으로 할 일 — 마감이 멀어도 모두, 날짜 없는 것은 맨 아래', () => {
  const s = L.taskSections(MORE, TODAY, TODAY);
  eq(s.overdue.map((t) => t.id), ['o', 's']);
  eq(s.due.map((t) => t.id), ['t']);
  eq(s.ahead.map((t) => t.id), ['w', 'l', 'f', 'n'], '2주 넘은 할 일도, 날짜 없는 할 일은 맨 아래, 하위·완료는 뺌');
});

test('캘린더 그날 칸 할 일: 그날 마감(완료 포함) 먼저, 나머지 전체는 오늘 기준으로', () => {
  // 앞으로의 날을 고르면: 그날 마감 → 지난 기한(오늘 기준) → 나머지(오늘 마감 포함)
  let s = L.taskSections(MORE, '2026-11-21', TODAY, { includeDone: true });
  eq(s.due.map((t) => t.id), ['w']);
  eq(s.overdue.map((t) => t.id), ['o', 's']);
  eq(s.ahead.map((t) => t.id), ['t', 'l', 'f', 'n']);
  // 지난 날을 고르면: 그날 완료한 것도 보이고, 같은 할 일이 두 번 나오지 않음
  s = L.taskSections(MORE, '2026-11-16', TODAY, { includeDone: true });
  eq(s.due.map((t) => t.id), ['o', 's']);
  eq(s.overdue.map((t) => t.id), [], '그날 묶음에 이미 나옴');
  s = L.taskSections(MORE, '2026-11-10', TODAY, { includeDone: true });
  eq(s.due.map((t) => t.id), ['d']);
  const ids = [].concat(s.due, s.overdue, s.ahead).map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, '겹치지 않음');
});

test('하위 할 일은 순서(position)대로', () => {
  eq(L.subtasksOf(TASKS, 't').map((t) => t.id), ['u', 's']);
});

/* ================= Logic: 화면 안전 ================= */

test('글자 이스케이프, 색, 주소 확인', () => {
  assert.equal(L.esc('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  assert.equal(L.safeColor('#039BE5'), '#039BE5');
  assert.equal(L.safeColor('red;background:url(x)'), '#2563EB');
  assert.equal(L.safeUrl('javascript:alert(1)'), '');
  assert.equal(L.safeUrl('https://tasks.google.com/task/1'), 'https://tasks.google.com/task/1');
  assert.equal(L.stripHtml('<p>자문위원 3명</p><br>자료: &amp; 초안'), '자문위원 3명\n\n자료: & 초안');
});

/* ================= 설치형 앱: docs/api.js + 가짜 구글 REST ================= */

const RANGE = L.monthRange('2026-11');

test('API 처음 불러오기: 기본 목록, 보이는 캘린더만, 취소 일정 제외, 숨겨진 완료 할 일 포함', async () => {
  const { api, net } = loadApi();
  const data = plain(await api.getBootstrap(RANGE.startIso, RANGE.endIso, ''));
  assert.equal(data.listId, 'L1');
  assert.equal(data.calendars[0].name, '내 캘린더');
  const ids = data.events.map((e) => e.id);
  assert.ok(!ids.includes('e-hidden') && !ids.includes('e-cancel'));
  assert.ok(ids.includes('e-advice') && ids.includes('e-dinner'));
  assert.equal(data.events.find((e) => e.id === 'e-work').color, '#ffb878');
  assert.equal(data.tasks.length, 17);
  assert.ok(data.tasks.find((t) => t.id === 't-abstract').done);
  // 실제 구글 주소로 요청했는지 (캘린더 ID의 # @ 는 인코딩)
  assert.ok(net.calls.includes('GET /calendar/v3/users/me/calendarList'));
  assert.ok(net.calls.includes('GET /calendar/v3/calendars/ko.south_korea%23holiday%40group.v.calendar.google.com/events'));
  assert.ok(net.calls.includes('GET /tasks/v1/lists/L1/tasks'));
});

test('API 처음 불러오기: 보고 있던 목록을 기억함', async () => {
  const { api } = loadApi();
  const data = plain(await api.getBootstrap(RANGE.startIso, RANGE.endIso, 'L2'));
  assert.equal(data.listId, 'L2');
  assert.deepEqual(data.tasks.map((t) => t.title), ['운동 등록']);
  const fallback = plain(await api.getBootstrap(RANGE.startIso, RANGE.endIso, '없는-목록'));
  assert.equal(fallback.listId, 'L1', '없는 목록이면 기본 목록');
});

test('API 잘못된 요청은 구글에 보내기 전에 막음', async () => {
  const { api, net } = loadApi();
  const before = net.calls.length;
  await assert.rejects(api.getEvents('어제', '내일'), /기간 형식/);
  await assert.rejects(api.updateTask('', 't-reply', {}), /잘못된 요청/);
  await assert.rejects(api.saveEvent({ title: ' ', calendarId: 'me@example.com', date: TODAY, allDay: true }), /제목/);
  await assert.rejects(api.appendMemo('L1', 't-report', TODAY, '   '), /메모 내용/);
  // getEvents는 캘린더 목록을 먼저 받으므로 그 한 번만 허용, 잘못된 기간으로 일정 요청은 안 보냄
  assert.ok(!net.calls.slice(before).some((c) => c.includes('/events')));
});

test('API 할 일 100개 넘어도 다 읽음 (여러 쪽)', async () => {
  const { api } = loadApi();
  for (let i = 0; i < 130; i++) await api.createTask('L2', { title: '할 일 ' + i });
  assert.equal((await api.getTasks('L2')).length, 131);
});

test('API 할 일: 만들기, 하위 할 일 순서, 완료↔미완료, 마감일 지우기 (바꾼 칸만 보냄)', async () => {
  const { api, g, net } = loadApi();
  const t = plain(await api.createTask('L1', { title: ' 새 할 일 ', due: '2026-11-20' }));
  assert.equal(t.title, '새 할 일');
  assert.equal(t.due, '2026-11-20');
  await api.createTask('L1', { title: '마지막 하위', parent: 't-report', previous: 's-rep-5' });
  const kids = L.subtasksOf(plain(await api.getTasks('L1')), 't-report').map((x) => x.title);
  assert.equal(kids[kids.length - 1], '마지막 하위');

  g.data.tasks.L1.find((x) => x.id === 't-reply').notes = 'Tasks 앱에서 쓴 메모';
  let r = plain(await api.updateTask('L1', 't-reply', { done: true }));
  assert.equal(r.done, true);
  assert.equal(r.notes, 'Tasks 앱에서 쓴 메모', '다른 앱에서 쓴 메모는 그대로');
  r = plain(await api.updateTask('L1', 't-reply', { done: false }));
  assert.equal(r.done, false);
  assert.equal(r.completed, '');
  r = plain(await api.updateTask('L1', 't-reply', { due: '' }));
  assert.equal(r.due, '');
  assert.ok(net.calls.filter((c) => c.startsWith('PATCH /tasks/v1/lists/L1/tasks/t-reply')).length === 3);
  await assert.rejects(api.updateTask('L1', 't-reply', { title: ' ' }), /비워 둘 수 없습니다/);
  await assert.rejects(api.createTask('L1', { title: 'x', due: '11/20' }), /날짜 형식/);
});

test('API 메모: 추가 규칙이 화면과 같음, 8,192자 제한, 동시에 바뀌면 덮어쓰지 않음', async () => {
  const { api, g } = loadApi();
  const t = plain(await api.appendMemo('L1', 't-report', TODAY, '오늘 회의 결과'));
  const m = L.parseMemo(t.notes);
  assert.equal(m.loose, '목표 분량: 30쪽 내외');
  assert.equal(m.entries[0].text, '오늘 회의 결과');
  ['', '글만', NOTES, '[2026-01-01] a\n\n'].forEach((s) => assert.equal(api._insertMemoEntry(s, TODAY, '새'), L.insertMemoEntry(s, TODAY, '새')));
  await assert.rejects(api.appendMemo('L1', 't-card', TODAY, 'ㄱ'.repeat(8200)), /8,192자/);

  const cur = g.data.tasks.L1.find((x) => x.id === 't-seminar').notes;
  const r = plain(await api.replaceNotes('L1', 't-seminar', cur, L.removeMemoEntry(cur, 0)));
  assert.equal(L.parseMemo(r.notes).entries.length, 1);
  await assert.rejects(api.replaceNotes('L1', 't-seminar', cur, ''), (e) => e.status === 409 && /다른 곳에서/.test(e.message));
  const cleared = plain(await api.replaceNotes('L1', 't-seminar', r.notes, ''));
  assert.equal(cleared.notes, '');
});

test('API 할 일 지우기: 하위 할 일도 함께', async () => {
  const { api } = loadApi();
  const kids = L.subtasksOf(plain(await api.getTasks('L1')), 't-seminar').map((k) => k.id);
  await api.deleteTask('L1', 't-seminar', kids);
  assert.ok(!plain(await api.getTasks('L1')).some((t) => t.id === 't-seminar' || t.parent === 't-seminar'));
});

test('API 일정: 만들기(시간·종일), 고치기(종일로·캘린더 옮기기·설명 보존), 지우기', async () => {
  const { api, g } = loadApi();
  const a = await api.saveEvent({ title: '회의', calendarId: 'me@example.com', date: TODAY, startTime: '09:00', endTime: '10:30', timeZone: 'Asia/Seoul' });
  eq(g.data.events['me@example.com'].find((e) => e.id === a.id).start, { dateTime: '2026-11-17T09:00:00', timeZone: 'Asia/Seoul' });
  const b = await api.saveEvent({ title: '휴가', calendarId: 'me@example.com', date: '2026-11-19', endDate: '2026-11-20', allDay: true });
  eq(g.data.events['me@example.com'].find((e) => e.id === b.id).end, { date: '2026-11-21' });
  await assert.rejects(api.saveEvent({ title: 'x', calendarId: 'me@example.com', date: TODAY, startTime: '10:00', endTime: '09:00' }), /늦어야/);
  await assert.rejects(api.saveEvent({ title: 'x', calendarId: 'ko.south_korea#holiday@group.v.calendar.google.com', date: TODAY, allDay: true }), (e) => e.status === 403);

  await api.saveEvent({ id: 'e-advice', originalCalendarId: 'me@example.com', calendarId: 'personal@group.calendar.google.com', title: '자문회의(변경)', date: TODAY, allDay: true });
  const ev = g.data.events['personal@group.calendar.google.com'].find((e) => e.id === 'e-advice');
  assert.equal(ev.summary, '자문회의(변경)');
  eq(ev.start, { date: TODAY });
  assert.equal(ev.description, '<p>자문위원 3명 참석</p><br>자료: 3장 초안');

  await api.deleteEvent('personal@group.calendar.google.com', 'e-dinner');
  assert.ok(!g.data.events['personal@group.calendar.google.com'].some((e) => e.id === 'e-dinner'));
});

test('API 연결 만료: 401이면 다시 연결을 요청하고 오류를 돌려줌, 토큰이 없으면 요청 안 보냄', async () => {
  const { api, net, unauthorized, setToken } = loadApi();
  setToken('expired');
  await assert.rejects(api.getTasks('L1'), (e) => e.status === 401);
  // 할 일은 두 요청(남은 것 + 최근 완료)을 함께 보내므로 여러 번 알릴 수 있음 (앱은 다시 연결을 한 번만 함)
  assert.ok(unauthorized.length >= 1 && unauthorized.every((s) => s === 401), String(unauthorized));
  const before = net.calls.length;
  setToken('');
  await assert.rejects(api.getTasks('L1'), (e) => e.status === 401);
  assert.equal(net.calls.length, before, '토큰이 없으면 구글에 요청하지 않음');
});

test('API 한 캘린더가 실패해도 나머지 일정은 보임, 서버 오류 메시지는 그대로 전달', async () => {
  const { api, g, net } = loadApi();
  g.data.calendars.push({ id: 'broken@group.calendar.google.com', summary: '깨진 캘린더', backgroundColor: '#000', accessRole: 'reader', selected: true });
  const data = plain(await api.getBootstrap(RANGE.startIso, RANGE.endIso, ''));
  assert.ok(data.events.length > 0);
  net.failNext = { status: 500, message: 'Backend Error' };
  await assert.rejects(api.getTasks('L1'), (e) => e.status === 500 && e.message === 'Backend Error');
});

/* ================= 검토 1~3번 수정: 로그인·권한·서비스 워커 ================= */

test('권한 부족(403): 한국어 안내 오류, 다시 허용 요청, 캘린더 하나의 문제로 삼키지 않음', async () => {
  const { api, net, scopeMissing } = loadApi();
  net.failNext = { status: 403, message: 'Request had insufficient authentication scopes.' };
  await assert.rejects(api.getTasks('L1'), (e) => e.status === 403 && e.code === 'scope' && /권한이 일부 빠져/.test(e.message));
  assert.deepEqual(plain(scopeMissing), ['scope']);
  // 첫 요청(캘린더 목록 또는 할 일 목록)이 권한 부족이면 처음 불러오기 전체가 실패해야 함 (빈 화면이 아니라 안내)
  net.failNext = { status: 403, message: 'Request had insufficient authentication scopes.' };
  await assert.rejects(api.getBootstrap(RANGE.startIso, RANGE.endIso, ''), (e) => e.code === 'scope');
  // 권한 부족이 아닌 403(쓰기 금지 캘린더 등)은 그대로
  await assert.rejects(api.saveEvent({ title: 'x', calendarId: 'ko.south_korea#holiday@group.v.calendar.google.com', date: TODAY, allDay: true }), (e) => e.status === 403 && e.code !== 'scope');
});

test('로그인: 조용한 재연결은 기록을 바꿔치기(replace), 연결 버튼은 기록을 남김(assign)', () => {
  const { Auth, nav, store } = loadAuth({ storage: [['ws.auth', JSON.stringify({ granted: true, hint: 'me@example.com' })]] });
  Auth.signIn({ silent: true });
  assert.equal(nav[0][0], 'replace');
  assert.equal(nav[0][1].searchParams.get('prompt'), 'none');
  assert.equal(nav[0][1].searchParams.get('login_hint'), 'me@example.com');
  assert.equal(nav[0][1].searchParams.get('redirect_uri'), 'https://moontur.github.io/schedule/');
  assert.equal(nav[0][1].searchParams.get('scope'), [SC.ro, SC.ev, SC.tasks].join(' '));
  assert.ok(JSON.parse(store.get('ws.authState')).silent);

  const b = loadAuth();
  b.Auth.signIn({});
  assert.equal(b.nav[0][0], 'assign');
  assert.equal(b.nav[0][1].searchParams.get('prompt'), 'select_account', '처음엔 계정 고르기');
  const c = loadAuth({ storage: [['ws.auth', JSON.stringify({ granted: true, hint: 'me@example.com' })]] });
  c.Auth.signIn({ consent: true });
  assert.equal(c.nav[0][1].searchParams.get('prompt'), 'consent', '빠진 권한: 권한 화면을 다시');
});

test('로그인: 구글 화면에서 뒤로 돌아와 페이지가 되살아나면 연결 버튼이 다시 동작', () => {
  const { Auth, nav, fire } = loadAuth();
  Auth.signIn({});
  Auth.signIn({});
  assert.equal(nav.length, 1, '이동 중에는 거듭 보내지 않음');
  fire('pageshow', { persisted: false });
  Auth.signIn({});
  assert.equal(nav.length, 1, '보통 페이지 표시로는 풀리지 않음');
  fire('pageshow', { persisted: true });
  Auth.signIn({});
  assert.equal(nav.length, 2, '메모리째 되살아나면 다시 연결 가능');
});

test('로그인: 돌아온 결과 처리 — 토큰 저장, 빠진 권한 알림, 위조 방지 값 확인', () => {
  // 정상: 세 권한 모두
  let env = loadAuth();
  env.Auth.signIn({});
  let state = JSON.parse(env.store.get('ws.authState')).state;
  env.loc.hash = '#' + new URLSearchParams({ access_token: 'tok1', expires_in: '3599', state, scope: [SC.tasks, SC.ev, SC.ro].join(' ') });
  let r = plain(env.Auth.handleRedirect());
  assert.deepEqual(r, { ok: true, silent: false, missing: [] });
  assert.equal(env.Auth.token(), 'tok1');
  assert.equal(env.loc.hash, '', '토큰이 든 주소는 바로 지움');

  // Tasks를 빼고 허용
  env = loadAuth();
  env.Auth.signIn({});
  state = JSON.parse(env.store.get('ws.authState')).state;
  env.loc.hash = '#' + new URLSearchParams({ access_token: 'tok2', expires_in: '3599', state, scope: [SC.ev, SC.ro].join(' ') });
  r = plain(env.Auth.handleRedirect());
  assert.deepEqual(r.missing, [SC.tasks]);
  assert.deepEqual(plain(env.Auth.missingScopes()), [SC.tasks]);

  // 예전에 캘린더 전체 권한을 받았던 경우(상위 권한)는 빠진 것으로 보지 않음
  env = loadAuth();
  env.Auth.signIn({});
  state = JSON.parse(env.store.get('ws.authState')).state;
  env.loc.hash = '#' + new URLSearchParams({ access_token: 'tok3', expires_in: '3599', state, scope: [SC.calFull, SC.tasks].join(' ') });
  assert.deepEqual(plain(env.Auth.handleRedirect()).missing, []);

  // 위조 방지 값이 다르면 토큰을 받지 않음
  env = loadAuth();
  env.Auth.signIn({});
  env.loc.hash = '#' + new URLSearchParams({ access_token: 'evil', expires_in: '3599', state: 'other' });
  assert.equal(plain(env.Auth.handleRedirect()).error, 'state_mismatch');
  assert.equal(env.Auth.token(), '');

  // 조용한 재연결 실패
  env = loadAuth({ storage: [['ws.auth', JSON.stringify({ granted: true, hint: 'me@example.com' })]] });
  env.Auth.signIn({ silent: true });
  state = JSON.parse(env.store.get('ws.authState')).state;
  env.loc.hash = '#' + new URLSearchParams({ error: 'interaction_required', state });
  eq(env.Auth.handleRedirect(), { error: 'interaction_required', silent: true });
});

test('서비스 워커: 빠르면 새 파일, 느리면(제한 시간 넘김) 저장해 둔 파일, 끊기면 저장해 둔 파일', async () => {
  const APP = 'https://moontur.github.io/schedule/app.js';
  // 빠른 네트워크 → 새 파일, 그리고 저장됨
  let sw = loadSw(() => later(5, new Response('new')));
  let r = await sw.get(APP);
  assert.equal(r.body, 'new');
  await r.settle();
  assert.equal(sw.cache.get('https://moontur.github.io/schedule/app.js'), 'new');

  // 약한 신호(400ms) + 저장해 둔 것 있음 → 제한 시간(60ms) 뒤 저장해 둔 것, 늦게 온 새 파일은 저장
  sw = loadSw(() => later(400, new Response('fresh')));
  sw.cache.set('https://moontur.github.io/schedule/app.js', 'old');
  r = await sw.get(APP);
  assert.equal(r.body, 'old');
  assert.ok(r.ms < 300, '제한 시간 안에 응답: ' + r.ms + 'ms');
  await r.settle();
  assert.equal(sw.cache.get('https://moontur.github.io/schedule/app.js'), 'fresh');

  // 약한 신호 + 저장해 둔 것 없음(처음 설치) → 새 파일을 기다림
  sw = loadSw(() => later(200, new Response('first')));
  r = await sw.get(APP);
  assert.equal(r.body, 'first');

  // 인터넷 끊김 → 저장해 둔 것
  sw = loadSw(() => later(5, null, true));
  sw.cache.set('https://moontur.github.io/schedule/app.js', 'old');
  r = await sw.get(APP + '?v=2');
  assert.equal(r.body, 'old');

  // 구글 API(다른 주소)는 건드리지 않음
  sw = loadSw(() => { throw new Error('호출되면 안 됨'); });
  r = await sw.get('https://tasks.googleapis.com/tasks/v1/users/@me/lists');
  assert.equal(r.res, null);
});

/* ================= 전체 검토 수정 (2026-11-17) ================= */

test('검토 5번 서비스 워커: 약한 신호에서 다른 버전 저장본은 쓰지 않고 새 파일을 기다림 (파일이 섞이지 않게)', async () => {
  const BASE = 'https://moontur.github.io/schedule/';
  // 저장본은 옛 버전(v=1)뿐, 화면은 새 버전(v=2)을 부름 → 제한 시간이 지나도 옛 파일을 주지 않음
  let sw = loadSw(() => later(200, new Response('js2')));
  sw.cache.set(BASE + 'app.js?v=1', 'js1');
  let r = await sw.get(BASE + 'app.js?v=2');
  assert.equal(r.body, 'js2');

  // 같은 버전 저장본이 있으면 약한 신호에서 바로 그것
  sw = loadSw(() => later(400, new Response('js2-new')));
  sw.cache.set(BASE + 'app.js?v=2', 'js2');
  r = await sw.get(BASE + 'app.js?v=2');
  assert.equal(r.body, 'js2');
  assert.ok(r.ms < 300, '제한 시간 안에 응답: ' + r.ms + 'ms');

  // 아예 끊겼으면 버전이 달라도 저장본 (아무것도 없는 것보다 나음)
  sw = loadSw(() => later(5, null, true));
  sw.cache.set(BASE + 'app.js?v=1', 'js1');
  r = await sw.get(BASE + 'app.js?v=2');
  assert.equal(r.body, 'js1');
});

test('검토 5번 서비스 워커: 새 화면(index.html)을 받으면 그 버전 파일을 미리 받고 옛 버전은 지움', async () => {
  const BASE = 'https://moontur.github.io/schedule/';
  const page = '<link rel="stylesheet" href="styles.css?v=c2"><script src="app.js?v=a2"></script><link rel="manifest" href="manifest.webmanifest">';
  const files = { [BASE]: page, [BASE + 'app.js?v=a2']: 'js2', [BASE + 'styles.css?v=c2']: 'css2' };
  const sw = loadSw((req) => {
    const u = typeof req === 'string' ? req : req.url;
    const type = u === BASE ? 'text/html; charset=utf-8' : 'text/plain';
    return later(5, new Response(files[u], { headers: { 'content-type': type } }));
  });
  sw.cache.set(BASE + 'app.js?v=a1', 'js1');
  sw.cache.set(BASE + 'logic.js?v=l1', 'logic1');
  const r = await sw.get(BASE);
  assert.equal(r.body, page);
  await r.settle();
  assert.equal(sw.cache.get(BASE + 'app.js?v=a2'), 'js2');
  assert.equal(sw.cache.get(BASE + 'styles.css?v=c2'), 'css2');
  assert.ok(!sw.cache.has(BASE + 'app.js?v=a1'), '옛 버전 app.js는 지움');
  assert.equal(sw.cache.get(BASE + 'logic.js?v=l1'), 'logic1', '새 화면이 부르지 않는 파일은 그대로');
});

test('검토 5번: index.html의 파일 버전(?v=)이 지금 파일 내용과 맞음 — 틀리면 npm run stamp', () => {
  const html = read('docs/index.html');
  assert.equal((html.match(/\?v=\w+/g) || []).length, 6, 'css 1개 + js 5개');
  assert.equal(stampHtml(html, readDoc), html, 'docs/의 css·js를 고쳤으면 npm run stamp 을 실행하세요');
});

test('검토 2번: 고치면 잃는 것이 있는 일정 설명은 잠금 (서식, 글자와 다른 링크, 4,000자 넘음)', () => {
  const { api } = loadApi();
  const lock = (s) => api._descLocked(s);
  assert.equal(lock(''), false);
  assert.equal(lock('그냥 글\n두 번째 줄'), false);
  assert.equal(lock('첫 줄<br>둘째 줄<br/>셋째'), false, '줄바꿈만 있으면 글로 고쳐도 잃는 것 없음');
  assert.equal(lock('자료: <a href="https://example.com/a?x=1&amp;y=2">https://example.com/a?x=1&amp;y=2</a>'), false, '주소가 그대로 보이는 링크');
  assert.equal(lock('<a href="https://teams.microsoft.com/l/meetup-join/1">회의 참가</a>'), true, '글자와 주소가 다른 링크');
  assert.equal(lock('<p>자문위원 3명 참석</p><br>자료'), true);
  assert.equal(lock('<b>중요</b>'), true);
  assert.equal(lock('<ul><li>하나</li></ul>'), true);
  assert.equal(lock('가'.repeat(4001)), true, '화면에는 앞 4,000자만 실림');
  assert.equal(lock('a < b 이고 c > d'), false, '부등호 글자는 서식이 아님');
});

test('검토 2번: 잠긴 설명의 일정은 가져올 때 표시됨', async () => {
  const { api } = loadApi();
  const data = plain(await api.getBootstrap(RANGE.startIso, RANGE.endIso, ''));
  assert.equal(data.events.find((e) => e.id === 'e-advice').descLocked, true);
  assert.equal(data.events.find((e) => e.id === 'e-dinner').descLocked, false);
});

test('검토 4번: 남은 할 일은 오래돼도 모두, 완료한 할 일은 최근 1년만 (겹치지 않게 합침)', async () => {
  const { api, g, net } = loadApi();
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  g.data.tasks.L1.push({ id: 't-old-done', title: '2년 전 완료', status: 'completed', completed: daysAgo(400), hidden: true, position: '00000000000000000500' });
  g.data.tasks.L1.push({ id: 't-recent-done', title: '한 달 전 완료', status: 'completed', completed: daysAgo(30), hidden: true, position: '00000000000000000501' });
  g.data.tasks.L1.push({ id: 't-old-open', title: '오래된 남은 할 일', status: 'needsAction', due: '2024-01-05T00:00:00.000Z', position: '00000000000000000502' });
  const before = net.calls.length;
  const ids = plain(await api.getTasks('L1')).map((t) => t.id);
  assert.ok(!ids.includes('t-old-done'), '1년 넘은 완료 할 일은 받지 않음');
  assert.ok(ids.includes('t-recent-done') && ids.includes('t-abstract'), '최근 완료(휴대폰에서 완료해 숨겨진 것 포함)');
  assert.ok(ids.includes('t-old-open'), '남은 할 일은 오래돼도 모두');
  assert.equal(new Set(ids).size, ids.length, '같은 할 일이 두 번 들어가지 않음');
  assert.equal(net.calls.slice(before).filter((c) => c === 'GET /tasks/v1/lists/L1/tasks').length, 2, '남은 것 + 최근 완료, 두 번');
});
