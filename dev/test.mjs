// 자동 테스트: node --test dev/test.mjs  (npm test)
// - docs/logic.js의 순수 함수 (날짜, 메모 형식, 할 일 묶기)
// - docs/api.js를 가짜 구글 REST API(dev/fake-fetch.js)에 연결해 저장 흐름 확인
// - apps-script/Code.gs(예비용 Apps Script 버전)도 같은 가짜 서비스로 확인
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
  api.config.getToken = () => token;
  api.config.onUnauthorized = (e) => unauthorized.push(e.status);
  return { api, g, net, unauthorized, setToken: (t) => { token = t; } };
}

function loadServer(opts) {
  const ctx = vm.createContext({ console });
  vm.runInContext(read('dev/fake-google.js'), ctx, { filename: 'fake-google.js' });
  const g = ctx.makeFakeGoogle(Object.assign({ sample: true, today: TODAY }, opts));
  ctx.Calendar = g.Calendar;
  ctx.Tasks = g.Tasks;
  ctx.Session = g.Session;
  ctx.CacheService = g.CacheService;
  ctx.HtmlService = {};
  vm.runInContext(read('apps-script/Code.gs'), ctx, { filename: 'Code.gs' });
  return { ctx, g };
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

/* ================= 서버 (Code.gs + 가짜 구글) ================= */

test('처음 불러오기: 기본 목록, 보이는 캘린더만, 취소된 일정 제외, 숨겨진 완료 할 일 포함', () => {
  const { ctx } = loadServer();
  const r = L.monthRange('2026-11');
  const data = plain(ctx.getBootstrap(r.startIso, r.endIso, ''));
  assert.equal(data.listId, 'L1');
  eq(data.tasklists.map((l) => l.title), ['내 할 일', '개인']);
  assert.equal(data.calendars[0].name, '내 캘린더');
  const ids = data.events.map((e) => e.id);
  assert.ok(!ids.includes('e-hidden'), '체크 안 한 캘린더 일정은 빼야 함');
  assert.ok(!ids.includes('e-cancel'), '취소된 일정은 빼야 함');
  assert.ok(ids.includes('e-advice') && ids.includes('e-dinner'));
  assert.equal(data.events.find((e) => e.id === 'e-work').color, '#ffb878', '일정마다 고른 색 반영');
  assert.equal(data.events.find((e) => e.id === 'e-dinner').color, '#33B679', '캘린더 색 반영');
  assert.equal(data.events.find((e) => e.id === 'weekly_20261117').recurring, true);
  assert.equal(data.tasks.length, 17);
  assert.ok(data.tasks.find((t) => t.id === 't-abstract').done, '휴대폰에서 완료해 숨겨진 할 일도 읽음');
  assert.equal(data.tasks.find((t) => t.id === 't-report').due, '2026-11-27');
});

test('처음 불러오기: 보고 있던 목록을 기억함', () => {
  const { ctx } = loadServer();
  const r = L.monthRange('2026-11');
  const data = plain(ctx.getBootstrap(r.startIso, r.endIso, 'L2'));
  assert.equal(data.listId, 'L2');
  eq(data.tasks.map((t) => t.title), ['운동 등록']);
});

test('할 일이 100개를 넘어도 다 읽음 (여러 쪽)', () => {
  const { ctx } = loadServer();
  for (let i = 0; i < 130; i++) ctx.createTask('L2', { title: '할 일 ' + i });
  assert.equal(ctx.getTasks('L2').length, 131);
});

test('할 일 만들기: 마감일, 하위 할 일, 순서', () => {
  const { ctx } = loadServer();
  const t = plain(ctx.createTask('L1', { title: '  새 할 일 ', due: '2026-11-20' }));
  assert.equal(t.title, '새 할 일');
  assert.equal(t.due, '2026-11-20');
  const s = plain(ctx.createTask('L1', { title: '마지막 하위', parent: 't-report', previous: 's-rep-5' }));
  assert.equal(s.parent, 't-report');
  const kids = L.subtasksOf(plain(ctx.getTasks('L1')), 't-report').map((x) => x.title);
  assert.equal(kids[kids.length - 1], '마지막 하위');
  assert.throws(() => ctx.createTask('L1', { title: '   ' }), /제목/);
  assert.throws(() => ctx.createTask('L1', { title: 'x', due: '11/20' }), /날짜 형식/);
});

test('할 일 고치기: 완료 ↔ 미완료, 마감일 지우기, 제목', () => {
  const { ctx } = loadServer();
  let t = plain(ctx.updateTask('L1', 't-reply', { done: true }));
  assert.equal(t.done, true);
  assert.ok(t.completed);
  t = plain(ctx.updateTask('L1', 't-reply', { done: false }));
  assert.equal(t.done, false);
  assert.equal(t.completed, '');
  t = plain(ctx.updateTask('L1', 't-reply', { due: '' }));
  assert.equal(t.due, '');
  t = plain(ctx.updateTask('L1', 't-reply', { title: '회신 메일' }));
  assert.equal(t.title, '회신 메일');
  assert.throws(() => ctx.updateTask('L1', 't-reply', { title: ' ' }), /비워 둘 수 없습니다/);
});

test('할 일 고치기: 다른 앱에서 바꾼 메모는 지워지지 않음', () => {
  const { ctx, g } = loadServer();
  g.data.tasks.L1.find((t) => t.id === 't-reply').notes = 'Tasks 앱에서 쓴 메모';
  const t = plain(ctx.updateTask('L1', 't-reply', { done: true }));
  assert.equal(t.notes, 'Tasks 앱에서 쓴 메모');
});

test('메모 추가: 날짜 없는 글 아래, 최신이 위 — 화면 쪽 규칙과 같음', () => {
  const { ctx } = loadServer();
  const t = plain(ctx.appendMemo('L1', 't-report', TODAY, '오늘 회의 결과'));
  const m = L.parseMemo(t.notes);
  assert.equal(m.loose, '목표 분량: 30쪽 내외');
  assert.equal(m.entries[0].date, TODAY);
  assert.equal(m.entries[0].text, '오늘 회의 결과');
  assert.equal(m.entries.length, 4);
  const samples = ['', '글만', NOTES, '[2026-01-01] a\n\n'];
  samples.forEach((s) => assert.equal(ctx.insertMemoEntry_(s, TODAY, '새'), L.insertMemoEntry(s, TODAY, '새')));
  assert.throws(() => ctx.appendMemo('L1', 't-report', TODAY, '   '), /메모 내용/);
});

test('메모 추가: 8,192자를 넘으면 저장하지 않음', () => {
  const { ctx } = loadServer();
  assert.throws(() => ctx.appendMemo('L1', 't-card', TODAY, 'ㄱ'.repeat(8200)), /8,192자/);
});

test('메모 전체 바꾸기: 그 사이 다른 곳에서 바뀌었으면 덮어쓰지 않음', () => {
  const { ctx, g } = loadServer();
  const cur = g.data.tasks.L1.find((t) => t.id === 't-seminar').notes;
  const next = L.removeMemoEntry(cur, 0);
  const t = plain(ctx.replaceNotes('L1', 't-seminar', cur, next));
  assert.equal(L.parseMemo(t.notes).entries.length, 1);
  assert.throws(() => ctx.replaceNotes('L1', 't-seminar', cur, ''), /다른 곳에서 메모가 바뀌었습니다/);
  const cleared = plain(ctx.replaceNotes('L1', 't-seminar', t.notes, ''));
  assert.equal(cleared.notes, '');
});

test('할 일 지우기: 하위 할 일도 함께', () => {
  const { ctx } = loadServer();
  const kids = L.subtasksOf(plain(ctx.getTasks('L1')), 't-seminar').map((k) => k.id);
  ctx.deleteTask('L1', 't-seminar', kids);
  const left = plain(ctx.getTasks('L1'));
  assert.ok(!left.some((t) => t.id === 't-seminar' || t.parent === 't-seminar'));
});

test('일정 만들기: 시간 일정, 여러 날 종일 일정(끝 날짜 +1)', () => {
  const { ctx, g } = loadServer();
  const a = plain(ctx.saveEvent({ title: '회의', calendarId: 'me@example.com', date: TODAY, startTime: '09:00', endTime: '10:30', timeZone: 'Asia/Seoul' }));
  const evA = g.data.events['me@example.com'].find((e) => e.id === a.id);
  eq(plain(evA.start), { dateTime: '2026-11-17T09:00:00', timeZone: 'Asia/Seoul' });
  const b = plain(ctx.saveEvent({ title: '휴가', calendarId: 'me@example.com', date: '2026-11-19', endDate: '2026-11-20', allDay: true }));
  const evB = g.data.events['me@example.com'].find((e) => e.id === b.id);
  eq(plain(evB.end), { date: '2026-11-21' });
  assert.throws(() => ctx.saveEvent({ title: 'x', calendarId: 'me@example.com', date: TODAY, startTime: '10:00', endTime: '09:00' }), /늦어야/);
  assert.throws(() => ctx.saveEvent({ title: 'x', calendarId: 'ko.south_korea#holiday@group.v.calendar.google.com', date: TODAY, allDay: true }), /Forbidden/);
});

test('일정 고치기: 시간 일정 → 종일, 캘린더 옮기기, 서식 있는 설명은 안 바꾸면 그대로', () => {
  const { ctx, g } = loadServer();
  ctx.saveEvent({
    id: 'e-advice', originalCalendarId: 'me@example.com', calendarId: 'personal@group.calendar.google.com',
    title: '자문회의(변경)', date: TODAY, allDay: true, location: '',
  });
  assert.ok(!g.data.events['me@example.com'].some((e) => e.id === 'e-advice'));
  const ev = g.data.events['personal@group.calendar.google.com'].find((e) => e.id === 'e-advice');
  assert.equal(ev.summary, '자문회의(변경)');
  eq(plain(ev.start), { date: TODAY });
  assert.equal(ev.description, '<p>자문위원 3명 참석</p><br>자료: 3장 초안');
});

test('일정 지우기', () => {
  const { ctx, g } = loadServer();
  ctx.deleteEvent('personal@group.calendar.google.com', 'e-dinner');
  assert.ok(!g.data.events['personal@group.calendar.google.com'].some((e) => e.id === 'e-dinner'));
});

test('잘못된 요청은 막음', () => {
  const { ctx } = loadServer();
  assert.throws(() => ctx.getEvents('어제', '내일'), /기간 형식/);
  assert.throws(() => ctx.updateTask('', 't-reply', {}), /잘못된 요청/);
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
