// 화면 캡처 + 동작 확인: node dev/shoot.mjs [저장 폴더]
// 크롬을 화면 없이 띄워 dev/preview.html 을 폴드 5 접은/펼친 화면 크기로 열고,
// 화면마다 캡처하고, 버튼을 눌러 저장 흐름이 동작하는지 확인합니다. (추가 설치 없음)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const OUT = resolve(process.argv[2] || 'dev/shots');
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9300 + Math.floor(Math.random() * 600);
const PROFILE = join(os.tmpdir(), 'ws-shoot-' + Date.now());
const URL_ = pathToFileURL(resolve('dev/preview.html')).href;
const FOLDED = [344, 882];   // 폴드 5 접은 화면 (대략)
const UNFOLDED = [690, 829]; // 폴드 5 펼친 화면 (대략)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--lang=ko-KR', 'about:blank'], { stdio: 'ignore' });

let ws;
let seq = 0;
const pending = new Map();
const problems = [];
const results = [];

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
        ws.onmessage = onMessage;
        return;
      }
    } catch (e) { /* 아직 안 뜸 */ }
    await sleep(100);
  }
  throw new Error('크롬을 띄우지 못했습니다.');
}

function onMessage(m) {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    problems.push('예외: ' + ((d.exception && d.exception.description) || d.text));
  } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(msg.params.type)) {
    problems.push('콘솔 ' + msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
}

function send(method, params = {}) {
  return new Promise((resolve_, reject) => {
    const id = ++seq;
    pending.set(id, { resolve: resolve_, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}

async function size(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
}

async function open(w, h, query) {
  await size(w, h);
  await send('Page.navigate', { url: URL_ + (query || '') });
  await sleep(400);
  await evaluate('localStorage.clear(), true');
  await send('Page.reload', {});
  await sleep(1300);
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  console.log('캡처: ' + name + '.png');
}

const q = (sel) => JSON.stringify(sel);
const click = (sel) => evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) throw new Error('없음: ' + ${q(sel)}); el.click(); return true; })()`);
const scrollMain = (top) => evaluate(`(() => { const m = document.getElementById('main'); m.scrollTop = ${top}; const p = m.querySelector('[data-scroll]'); return true; })()`);
const text = () => evaluate('document.body.innerText');

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  통과 ' : '  실패 ') + name + (detail && !ok ? ' — ' + detail : ''));
}

async function fill(sel, value) {
  await evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) throw new Error('없음: ' + ${q(sel)}); el.focus(); el.value = ${q(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
}
async function submit(sel) {
  await evaluate(`(() => { const f = document.querySelector(${q(sel)}); if (!f) throw new Error('없음: ' + ${q(sel)}); f.requestSubmit(); return true; })()`);
}

/** 사람처럼 누르고(포커스 이동) 잠시 뒤 떼는 실제 마우스 클릭 */
async function realClick(sel) {
  const box = await evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) throw new Error('없음: ' + ${q(sel)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}

/** 포커스를 유지한 채 글자 입력 */
async function typeInto(sel, text) {
  await evaluate(`(() => { const el = document.querySelector(${q(sel)}); el.focus(); el.setSelectionRange(el.value.length, el.value.length); return true; })()`);
  await send('Input.insertText', { text });
}

/** 포커스를 옮기지 않고 동기화 시작 (자동 동기화 흉내) */
const backgroundSync = () => evaluate(`document.querySelector('[data-act="refresh"]').click(), true`);

/**
 * 구글 응답 시간을 바꿈. 요청은 부르는 즉시 처리(그 순간의 구글 상태)하고, 응답만 늦게 전달 →
 * "동기화 요청을 보낸 뒤 사용자가 바꿨는데 옛 응답이 나중에 도착"하는 상황을 만듦.
 */
async function slowServer(delays) {
  await evaluate(`(() => {
    const delays = ${JSON.stringify(delays)};
    window.__fakeFetch.delay = 0; // 요청은 바로 처리
    Object.keys(delays).forEach((name) => {
      const orig = window.GoogleApi[name];
      window.GoogleApi[name] = async (...args) => {
        const out = await orig(...args);
        await new Promise((r) => setTimeout(r, delays[name]));
        return out;
      };
    });
    return true;
  })()`);
}

async function run() {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');

  /* ---------- 접은 화면 ---------- */
  console.log('[접은 화면 ' + FOLDED.join('×') + ']');
  await open(...FOLDED);
  await shot('01-folded-today');
  check('오늘: 일정 4개 (숨긴 캘린더·취소 일정 제외)', (await evaluate('document.querySelectorAll(".today .ev-row").length')) === 4);
  check('오늘: 지난 기한에 출장비 영수증', (await text()).includes('출장비 영수증 제출'));

  // 날짜 없음 묶음: 처음엔 접힘 → 누르면 펼침 → 다시 열어도 펼친 상태 기억
  check('오늘: 날짜 없음 묶음은 처음에 접혀 있음', !(await text()).includes('명함 주문') &&
    (await evaluate('document.querySelector("[data-act=toggle-nodate]").textContent.trim()')) === '날짜 없음 1');
  await click('[data-act="toggle-nodate"]'); await sleep(200);
  check('오늘: 누르면 날짜 없는 할 일이 보임', (await text()).includes('명함 주문'));
  await evaluate('document.getElementById("main").scrollTop = 99999, true'); await sleep(150);
  await shot('01b-folded-today-nodate');
  await send('Page.reload', {}); await sleep(1300);
  check('오늘: 다시 열어도 펼친 상태 기억', (await text()).includes('명함 주문'));
  await click('input[data-act="toggle"][data-id="t-card"]'); await sleep(700);
  check('오늘: 날짜 없는 할 일도 체크하면 구글에 완료', (await evaluate('__fake.data.tasks.L1.find(t => t.id === "t-card").status')) === 'completed');
  check('오늘: 완료하면 날짜 없음 묶음이 사라짐', !(await evaluate('!!document.querySelector("[data-act=toggle-nodate]")')));
  await click('.toast-btn'); await sleep(700);
  check('오늘: 되돌리면 날짜 없음 묶음에 다시 보임', (await text()).includes('명함 주문'));

  await click('.bn[data-view="tasks"]'); await sleep(250);
  await shot('02-folded-tasks');
  check('할 일: 묶음 순서', (await evaluate('[...document.querySelectorAll(".list-pane .g-label")].map(e => e.textContent.trim().split(" ")[0]).join(",")')) === '지난,오늘,이번,다음,날짜');

  await click('[data-act="open-task"][data-id="t-report"]'); await sleep(250);
  await shot('03-folded-detail');
  check('상세: 하위 할 일 5개', (await evaluate('document.querySelectorAll(".sub-row").length')) === 5);
  check('상세: 날짜 없는 글 + 날짜 메모 3개', (await evaluate('document.querySelectorAll(".memo-entry").length')) === 4);
  await scrollMain(99999); await sleep(150);
  await shot('04-folded-detail-bottom');

  await click('[data-act="back"]'); await sleep(300);
  check('뒤로: 목록으로 돌아옴', (await evaluate('!!document.querySelector(".list-pane")')));

  // 폰의 뒤로 가기(브라우저 기록)로도 상세가 닫힘
  await click('[data-act="open-task"][data-id="t-seminar"]'); await sleep(250);
  await evaluate('history.back(), true'); await sleep(400);
  check('폰 뒤로 가기: 상세 → 목록', (await evaluate('!!document.querySelector(".list-pane") && !document.querySelector(".detail")')));
  await click('[data-act="open-task"][data-id="t-report"]'); await sleep(250);
  check('다시 열기: 상세가 열림', (await evaluate('!!document.querySelector(".detail")')));
  await evaluate('history.back(), true'); await sleep(400);
  check('폰 뒤로 가기: 두 번째도 목록으로', (await evaluate('!!document.querySelector(".list-pane") && !document.querySelector(".detail")')));

  await click('.bn[data-view="calendar"]'); await sleep(300);
  await shot('05-folded-calendar');
  await scrollMain(99999); await sleep(150);
  await shot('06-folded-calendar-day');

  /* ---------- 펼친 화면 ---------- */
  console.log('[펼친 화면 ' + UNFOLDED.join('×') + ']');
  await open(...UNFOLDED);
  await shot('11-unfolded-today');
  await click('.tab[data-view="tasks"]'); await sleep(250);
  await click('[data-act="open-task"][data-id="t-report"]'); await sleep(250);
  await shot('12-unfolded-tasks');
  check('펼친 화면: 목록과 상세가 함께', (await evaluate('!!document.querySelector(".main.split .list-pane") && !!document.querySelector(".detail")')));

  // 메모 추가
  await fill('[data-form="memo-add"] textarea', '오늘 회의: 비교표는 본문에 넣기로 함');
  await submit('[data-form="memo-add"]'); await sleep(700);
  check('메모 추가: 맨 위에 오늘 날짜로', (await evaluate('document.querySelector(".memo-list .memo-entry:nth-child(2) .m-text").textContent')).startsWith('오늘 회의'));
  check('메모 추가: 가짜 구글에도 저장', (await evaluate('__fake.data.tasks.L1.find(t => t.id === "t-report").notes')).includes('] 오늘 회의: 비교표는 본문에 넣기로 함'));
  await shot('13-unfolded-memo-added');

  // 하위 할 일 추가 + 체크
  await fill('[data-form="sub-add"] input', '참고문헌 정리');
  await submit('[data-form="sub-add"]'); await sleep(700);
  check('하위 할 일 추가: 맨 아래에', (await evaluate('[...document.querySelectorAll(".sub-row .sub-title")].pop().textContent')) === '참고문헌 정리');
  await click('input[data-act="toggle"][data-id="s-rep-4"]'); await sleep(700);
  check('하위 할 일 체크: 4/6', (await evaluate('document.querySelector(".d-sec .d-sec-head span").textContent')) === '4/6');

  // 마감일 바꾸기
  await evaluate(`(() => { const el = document.querySelector('.due-input'); el.value = '2026-12-31'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(700);
  check('마감일 바꾸기: 구글에 저장', (await evaluate('__fake.data.tasks.L1.find(t => t.id === "t-report").due')) === '2026-12-31T00:00:00.000Z');

  // 메모 지우기 (확인 창)
  const before = await evaluate('document.querySelectorAll(".memo-entry").length');
  await click('[data-act="memo-del"][data-index="0"]'); await sleep(250);
  await shot('14-unfolded-confirm');
  await click('#confirmDlg button[value="yes"]'); await sleep(700);
  check('메모 지우기: 하나 줄어듦', (await evaluate('document.querySelectorAll(".memo-entry").length')) === before - 1);

  // 할 일 완료 + 되돌리기
  await click('.tab[data-view="today"]'); await sleep(250);
  await click('input[data-act="toggle"][data-id="t-reply"]'); await sleep(700);
  check('완료 체크: 구글에 완료로 저장', (await evaluate('__fake.data.tasks.L1.find(t => t.id === "t-reply").status')) === 'completed');
  check('완료 체크: 되돌리기 버튼', (await evaluate('!!document.querySelector(".toast.show .toast-btn")')));
  await shot('15-unfolded-done-toast');
  await click('.toast-btn'); await sleep(700);
  check('되돌리기: 다시 미완료', (await evaluate('__fake.data.tasks.L1.find(t => t.id === "t-reply").status')) === 'needsAction');

  // 빠른 추가
  await fill('[data-form="quick-add"] input', '회의록 공유');
  await submit('[data-form="quick-add"]'); await sleep(700);
  check('빠른 추가: 오늘 마감으로 저장', (await evaluate('__fake.data.tasks.L1.some(t => t.title === "회의록 공유" && t.due && t.due.startsWith(__fake.today))')));

  // 캘린더: 일정 보기 → 수정 창 → 새 일정
  await click('.tab[data-view="calendar"]'); await sleep(300);
  await shot('16-unfolded-calendar');
  await click('[data-act="open-event"][data-id="e-advice"]'); await sleep(250);
  await shot('17-unfolded-event-view');
  await click('[data-act="edit-event"]'); await sleep(250);
  await shot('18-unfolded-event-form');
  await click('#sheet [data-act="close-sheet"]'); await sleep(250);

  await click('[data-act="new-event"]'); await sleep(250);
  await fill('#sheet input[name="title"]', '팀 점심');
  await fill('#sheet input[name="startTime"]', '12:00');
  await fill('#sheet input[name="endTime"]', '13:00');
  await submit('#sheet form'); await sleep(1200);
  check('새 일정: 구글 캘린더에 저장', (await evaluate('__fake.data.events["me@example.com"].some(e => e.summary === "팀 점심")')));
  check('새 일정: 그날 칸에 보임', (await evaluate('document.querySelector(".day-panel").innerText')).includes('팀 점심'));

  await click('[data-act="new-task"][data-date]'); await sleep(250);
  await fill('#sheet input[name="title"]', '발표 자료 인쇄');
  await submit('#sheet form'); await sleep(800);
  check('새 할 일(그날 마감): 저장', (await evaluate('__fake.data.tasks.L1.some(t => t.title === "발표 자료 인쇄" && t.due)')));

  // 다음 달
  await click('[data-act="month"][data-delta="1"]'); await sleep(900);
  check('다음 달: 일정 다시 불러옴', !(await evaluate('!!document.querySelector(".cal-loading")')));

  /* ---------- 접기·펴기 ---------- */
  await click('.tab[data-view="tasks"]'); await sleep(200);
  await click('[data-act="open-task"][data-id="t-seminar"]'); await sleep(200);
  await size(...FOLDED); await sleep(400);
  check('접으면 한 칸 화면으로', (await evaluate('!document.getElementById("main").classList.contains("split")')));
  await shot('21-fold-switch');
  await size(...UNFOLDED); await sleep(400);
  check('다시 펴면 두 칸 화면으로', (await evaluate('document.getElementById("main").classList.contains("split")')));

  /* ---------- 회귀: 자동 동기화와 겹칠 때 (코드 검토 1~3번) ---------- */
  console.log('[동기화와 겹치는 상황]');

  // 1번: 메모 전체 편집 중 동기화가 끝난 뒤 저장 버튼 클릭
  await open(...UNFOLDED);
  await click('.tab[data-view="tasks"]'); await sleep(200);
  await click('[data-act="open-task"][data-id="t-report"]'); await sleep(200);
  await click('[data-act="memo-edit"]'); await sleep(200);
  await typeInto('#memoInput', '\n[2026-11-17] 편집 중에 새로 쓴 줄');
  await backgroundSync(); await sleep(700);
  check('3번: 입력 중에도 동기화 표시가 갱신됨', (await evaluate('document.getElementById("syncText").textContent')).startsWith('구글과 동기화됨'));
  await realClick('[data-form="memo-raw"] button[type="submit"]'); await sleep(1000);
  check('1번: 동기화 뒤 저장해도 쓴 줄이 구글에 저장됨', (await evaluate('__fake.data.tasks.L1.find(t => t.id === "t-report").notes')).includes('편집 중에 새로 쓴 줄'));
  check('1번: 저장 후 편집 창이 닫힘', !(await evaluate('!!document.querySelector("[data-form=memo-raw]")')));

  // 1번: 메모 전체 편집 중 동기화 → 다른 곳을 눌러 화면이 다시 그려져도 쓴 글이 남음
  await open(...UNFOLDED);
  await click('.tab[data-view="tasks"]'); await sleep(200);
  await click('[data-act="open-task"][data-id="t-report"]'); await sleep(200);
  await click('[data-act="memo-edit"]'); await sleep(200);
  await typeInto('#memoInput', '\n[2026-11-18] 아직 저장 안 한 줄');
  await backgroundSync(); await sleep(700);
  await realClick('.src-chip'); await sleep(800);
  check('1번: 다시 그려진 편집 칸에 쓰던 글이 남음', (await evaluate('document.getElementById("memoInput").value')).includes('아직 저장 안 한 줄'));
  await click('[data-act="memo-cancel"]'); await sleep(200);

  // 1번: 빠른 추가 칸에 쓰던 글이 동기화 뒤 화면을 다시 그려도 남음
  await open(...UNFOLDED);
  await typeInto('[data-form="quick-add"] input', '쓰다 만 할 일');
  await backgroundSync(); await sleep(600);
  await realClick('.today-date'); await sleep(700);
  check('1번: 빠른 추가 칸의 쓰던 글이 남음', (await evaluate('document.querySelector("[data-form=quick-add] input").value')) === '쓰다 만 할 일');

  // 2번: 동기화 요청 중에 할 일 추가
  await open(...UNFOLDED);
  await slowServer({ getBootstrap: 900 });
  await backgroundSync(); await sleep(50);
  await fill('[data-form="quick-add"] input', '동기화 중 추가한 할 일');
  await submit('[data-form="quick-add"]'); await sleep(1300);
  await realClick('.today-date'); await sleep(900);
  check('2번: 동기화 중 추가한 할 일이 화면에 남음', (await text()).includes('동기화 중 추가한 할 일'));
  check('2번: 구글에는 한 번만 저장됨', (await evaluate('__fake.data.tasks.L1.filter(t => t.title === "동기화 중 추가한 할 일").length')) === 1);

  // 2번: 동기화 요청 중에 완료 체크
  await open(...UNFOLDED);
  await slowServer({ getBootstrap: 900 });
  await backgroundSync(); await sleep(50);
  await click('input[data-act="toggle"][data-id="t-receipt"]'); await sleep(1300);
  await realClick('.today-date'); await sleep(900);
  check('2번: 동기화 중 완료한 할 일이 다시 미완료로 돌아가지 않음',
    !(await evaluate('!!document.querySelector("input[data-act=toggle][data-id=t-receipt]:not(:checked)")')) &&
    (await evaluate('__fake.data.tasks.L1.find(t => t.id === "t-receipt").status')) === 'completed');

  // 2번: 다음 달로 넘긴 직후 그 달에 일정 저장
  await open(...UNFOLDED);
  await click('.tab[data-view="calendar"]'); await sleep(300);
  await slowServer({ getEvents: 900 });
  await click('[data-act="month"][data-delta="1"]'); await sleep(50);
  await click('[data-act="new-event"]'); await sleep(200);
  // 그 달 15일: 이번 달 화면 범위(다음 달 초 며칠 포함) 밖이어야 옛 응답 문제를 잡을 수 있음
  await evaluate(`(() => { const d = document.querySelector('#sheet input[name="date"]'); d.value = d.value.slice(0, 8) + '15'; d.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await fill('#sheet input[name="title"]', '달 넘긴 직후 일정');
  await fill('#sheet input[name="startTime"]', '09:00');
  await fill('#sheet input[name="endTime"]', '10:00');
  await submit('#sheet form'); await sleep(1800);
  check('2번: 달 넘긴 직후 저장한 일정이 보임', (await evaluate('document.querySelector(".day-panel").innerText')).includes('달 넘긴 직후 일정'));

  /* ---------- 구글 연결 ---------- */
  console.log('[구글 연결]');
  await open(...FOLDED, '?noauth');
  await shot('41-folded-connect');
  check('처음 쓸 때: 구글 계정 연결 화면', (await text()).includes('구글 계정을 연결해 주세요') && (await evaluate('!!document.querySelector("[data-act=connect]")')));
  check('처음 쓸 때: 구글에 요청을 보내지 않음', (await evaluate('window.__fakeFetch.calls.length')) === 0);
  await open(...UNFOLDED);
  await click('[data-act="account"]'); await sleep(250);
  await shot('42-unfolded-account');
  check('계정 창: 연결된 계정과 연결 끊기 버튼', (await evaluate('document.getElementById("sheet").innerText')).includes('me@example.com') && (await evaluate('!!document.querySelector("#sheet [data-act=sign-out]")')));
  await click('#sheet [data-act="close-sheet"]'); await sleep(200);
  // 연결이 만료되면(401) 안내 띠를 띄움 (미리보기라 실제 구글로 이동은 안 함)
  await evaluate(`(() => { const a = JSON.parse(localStorage.getItem('ws.auth')); a.granted = false; localStorage.setItem('ws.auth', JSON.stringify(a)); window.__fakeFetch.validToken = 'other'; return true; })()`);
  await backgroundSync(); await sleep(900);
  check('연결 만료: 데이터는 그대로 보이고 다시 연결 안내가 뜸', (await evaluate('!document.getElementById("authBanner").hidden')) && (await text()).includes('출장비 영수증 제출'));
  await shot('43-unfolded-auth-expired');

  /* ---------- 큰 펼친 화면 ---------- */
  await open(884, 1104);
  await click('.tab[data-view="calendar"]'); await sleep(300);
  await shot('31-wide-884-calendar');
}

try {
  await run();
} catch (e) {
  problems.push('스크립트 오류: ' + e.message);
} finally {
  try { ws && ws.close(); } catch (e) { /* 무시 */ }
  chrome.kill();
  await sleep(300);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 무시 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n확인 ${results.length}개 중 ${results.length - failed.length}개 통과`);
if (problems.length) { console.log('브라우저 문제:'); problems.forEach((p) => console.log('  - ' + p)); }
process.exit(failed.length || problems.length ? 1 : 0);
