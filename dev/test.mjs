// 자동 테스트: node --test dev/test.mjs  (npm test)
// - docs/logic.js의 순수 함수 (날짜, 메모 형식, 할 일 묶기)
// - docs/api.js를 가짜 구글 REST API(dev/fake-fetch.js)에 연결해 저장 흐름 확인
// - docs/auth.js(로그인), docs/sw.js(서비스 워커)
process.env.TZ = 'Asia/Seoul';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

/** docs/sw.js + 가짜 서비스 워커 환경 */
function loadSw(fetchImpl) {
  const handlers = {};
  const cache = new Map();
  const keyOf = (req, ignoreSearch) => {
    const u = new URL(typeof req === 'string' ? req : req.url, 'https://moontur.github.io/schedule/');
    return ignoreSearch ? u.origin + u.pathname : u.href;
  };
  const caches = {
    open: async () => ({ put: async (req, res) => { cache.set(keyOf(req, true), await res.text()); }, addAll: async () => {} }),
    match: async (req, o) => { const k = keyOf(req, o && o.ignoreSearch); return cache.has(k) ? new Response(cache.get(k)) : undefined; },
    keys: async () => [], delete: async () => true,
  };
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

test('오늘 화면: 마감일 있는 하위 할 일도 지난 기한에 보임, 다가오는 마감은 2주까지', () => {
  const g = L.todayTasks(TASKS, TODAY, 14);
  eq(g.overdue.map((t) => t.id), ['o', 's']);
  eq(g.today.map((t) => t.id), ['t']);
  eq(g.upcoming.map((t) => t.id), ['w', 'l']);
});

test('오늘 화면: 날짜 없음 묶음은 미완료 상위 할 일만', () => {
  const g = L.todayTasks(TASKS.concat([
    { id: 'n2', title: '날짜 없음 완료', due: '', done: true, parent: '' },
    { id: 'n3', title: '날짜 없는 하위', due: '', done: false, parent: 't' },
  ]), TODAY, 14);
  eq(g.nodate.map((t) => t.id), ['n']);
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
  assert.deepEqual(plain(unauthorized), [401]);
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
