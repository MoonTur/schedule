/*
 * 화면 동작. 구글 캘린더·Tasks는 api.js(GoogleApi)로 직접 부르고, 로그인은 auth.js(Auth)가 맡습니다.
 * - 접은 화면(폭 600px 미만): 한 칸 + 아래 탭
 * - 펼친 화면(600px 이상): 위 탭 + 두 칸 (할 일 목록|상세, 달력|그날)
 * - 바꾼 내용은 화면에 먼저 반영하고 구글에 저장합니다. 실패하면 되돌리고 알려 줍니다.
 */
(function () {
  'use strict';

  const L = window.Logic;
  const esc = L.esc;
  const main = document.getElementById('main');
  const sheet = document.getElementById('sheet');
  const confirmDlg = document.getElementById('confirmDlg');
  const toastEl = document.getElementById('toast');
  const wideMq = window.matchMedia('(min-width: 600px)');
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul'; } catch (e) { return 'Asia/Seoul'; } })();
  const VIEWS = ['today', 'tasks', 'calendar'];

  /* ---------- 아이콘 ---------- */
  const svg = (size, body) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    plus: svg(16, '<path d="M12 5v14M5 12h14"/>'),
    chevL: svg(20, '<path d="M15 5l-7 7 7 7"/>'),
    chevR: svg(16, '<path d="M9 6l6 6-6 6"/>'),
    chevD: svg(18, '<path d="M6 9l6 6 6-6"/>'),
    x: svg(18, '<path d="M6 6l12 12M18 6L6 18"/>'),
    trash: svg(16, '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    cal: svg(16, '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
    clock: svg(16, '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    pin: svg(16, '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
    ext: svg(16, '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    checkSm: svg(12, '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>'),
  };

  /* ---------- 이 기기에 남기는 것 (화면 설정, 마지막으로 받은 데이터) ---------- */
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('ws.' + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('ws.' + key, JSON.stringify(value)); } catch (e) { /* 저장 공간이 없으면 넘어감 */ }
    },
  };

  /* ---------- 구글 호출 ---------- */
  const Auth = window.Auth;
  /** GoogleApi의 함수를 부릅니다 (부를 때마다 찾으므로 테스트에서 바꿔 끼울 수 있음). */
  function call(fn, ...args) {
    return Promise.resolve().then(() => window.GoogleApi[fn](...args));
  }
  /** 401(연결 만료)은 다시 연결로 처리하므로 오류 알림을 띄우지 않습니다. */
  const isAuthError = (e) => !!e && e.status === 401;

  /* ---------- 상태 ---------- */
  const todayNow = () => L.ymd(new Date());
  const savedView = store.get('view', 'today');
  const state = {
    view: VIEWS.indexOf(savedView) >= 0 ? savedView : 'today',
    today: todayNow(),
    calendars: [],
    tasklists: [],
    listId: store.get('listId', ''),
    tasks: [],
    events: {},          // 'YYYY-MM' → 그 달 화면이 덮는 기간의 일정
    loadingMonths: {},
    month: '',
    selDate: '',
    selTaskId: '',
    showDone: false,
    showNoDate: store.get('showNoDate', false) === true,
    memoEdit: false,
    memoEditBase: '',
    // 입력칸에 쓰던 글. 화면을 다시 그려도 되살립니다.
    // 키: 'quick' | 'sub:<부모ID>' | 'memo:<ID>' | 'raw:<ID>'
    drafts: {},
    loaded: false,
    syncing: false,
    syncedAt: 0,
    error: '',
    needAuth: false,  // 구글 연결이 필요함 (처음이거나 만료 후 조용한 연결 실패)
    scopeMissing: false, // 구글 권한 화면에서 일부 항목을 빼고 허용함 → 권한 화면을 다시 띄워야 함
    renderPending: false,
    pointerDown: false,
    sheetCtx: null,
    toastAction: null,
    // 늦게 도착한 옛 응답이 새 변경을 덮지 않도록 세는 번호
    taskGen: 0,      // 할 일을 바꾸기 시작할 때마다 +1
    inflight: 0,     // 구글에 저장 중인 할 일 변경 수
    tasksStale: false,
    eventGen: 0,     // 일정을 바꾼 뒤 다시 불러올 때마다 +1
  };
  state.month = state.today.slice(0, 7);
  state.selDate = state.today;

  const isWide = () => wideMq.matches;
  const isTmp = (id) => String(id).indexOf('tmp-') === 0;
  const yearOf = (d) => +String(d).slice(0, 4);
  const findTask = (id) => state.tasks.find((t) => t.id === id);
  const calById = (id) => state.calendars.find((c) => c.id === id);
  const allEvents = () => L.mergeEvents(Object.keys(state.events).map((k) => state.events[k]));
  const findEvent = (calId, id) => allEvents().find((ev) => ev.calendarId === calId && ev.id === id);
  const listTitle = () => (state.tasklists.find((l) => l.id === state.listId) || {}).title || '내 할 일';

  /* ================= 그리기 ================= */

  function render() {
    state.renderPending = false;
    const keep = saveScroll();
    document.querySelectorAll('[data-act="view"]').forEach((b) => {
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    document.getElementById('topTitle').textContent = { today: '오늘', tasks: '할 일', calendar: '캘린더' }[state.view];

    let html;
    let split = false;
    if (!state.loaded && state.scopeMissing) html = scopeScreen();
    else if (!state.loaded && state.needAuth) html = connectScreen();
    else if (!state.loaded) html = state.error ? errorScreen() : '<p class="skeleton">구글 캘린더와 Tasks에서 불러오는 중…</p>';
    else if (state.view === 'today') html = renderToday();
    else if (state.view === 'tasks') { split = isWide(); html = renderTasks(); }
    else { split = isWide(); html = renderCalendar(); }
    main.classList.toggle('split', split);
    main.innerHTML = html;
    const showBanner = state.loaded && (state.needAuth || state.scopeMissing);
    document.getElementById('authBanner').hidden = !showBanner;
    if (showBanner) {
      document.getElementById('authBannerText').textContent = state.scopeMissing
        ? '구글 권한이 일부 빠져 있어 저장할 수 없습니다. 다시 연결해 세 항목을 모두 허용해 주세요.'
        : '구글 연결이 끊겼습니다. 저장하려면 다시 연결해 주세요.';
    }
    restoreScroll(keep);
    renderSync();
  }

  /**
   * 자동 새로고침 등 사용자가 직접 하지 않은 그리기.
   * - 글자를 입력 중이면 미룹니다 (한글 조합이 끊기지 않도록).
   * - 화면을 누르고 있는 동안에도 미룹니다 (누른 버튼이 다시 그려져 클릭이 사라지지 않도록).
   * 미루는 동안에도 동기화 표시는 갱신합니다.
   */
  function safeRender() {
    const a = document.activeElement;
    const typing = a && main.contains(a) &&
      (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && ['checkbox', 'date'].indexOf(a.type) < 0));
    if (typing || state.pointerDown) {
      state.renderPending = true;
      renderSync();
      return;
    }
    render();
  }

  /** 입력칸 값: 쓰던 글이 있으면 그것, 없으면 기본값 */
  function draftValue(key, fallback) {
    return Object.prototype.hasOwnProperty.call(state.drafts, key) ? state.drafts[key] : (fallback || '');
  }

  function saveScroll() {
    const keep = { main: main.scrollTop };
    main.querySelectorAll('[data-scroll]').forEach((el) => { keep[el.dataset.scroll] = el.scrollTop; });
    return keep;
  }
  function restoreScroll(keep) {
    main.scrollTop = keep.main || 0;
    main.querySelectorAll('[data-scroll]').forEach((el) => {
      if (keep[el.dataset.scroll] != null) el.scrollTop = keep[el.dataset.scroll];
    });
  }

  function renderSync() {
    const dot = document.getElementById('syncDot');
    const txt = document.getElementById('syncText');
    const btn = document.querySelector('[data-act="refresh"]');
    btn.classList.toggle('spin', state.syncing);
    if (state.syncing) { dot.className = 'sync-dot'; txt.textContent = '동기화 중…'; }
    else if (state.scopeMissing) { dot.className = 'sync-dot err'; txt.textContent = '권한 부족'; }
    else if (state.needAuth) { dot.className = 'sync-dot err'; txt.textContent = '구글 연결 필요'; }
    else if (state.error) { dot.className = 'sync-dot err'; txt.textContent = '연결 안 됨'; }
    else if (state.syncedAt) { dot.className = 'sync-dot ok'; txt.textContent = '구글과 동기화됨 · ' + L.fmtTime(new Date(state.syncedAt).toISOString()); }
    else { dot.className = 'sync-dot'; txt.textContent = '불러오는 중…'; }
  }

  function errorScreen() {
    return `<div class="skeleton"><p>구글에서 불러오지 못했습니다.</p><p class="hint" style="margin:8px 0 16px">${esc(state.error)}</p>
      <div style="display:flex;gap:8px;justify-content:center">
        <button type="button" class="btn" data-act="connect">다시 연결</button>
        <button type="button" class="btn primary" data-act="retry">다시 시도</button>
      </div></div>`;
  }

  /** 구글 권한 화면에서 일부 항목이 빠진 경우 */
  function scopeScreen() {
    return `<div class="connect">
      <h2>권한을 모두 허용해 주세요</h2>
      <p>구글 권한 화면에서 일부 항목이 빠졌습니다. 이 앱은 아래 세 가지가 모두 있어야 일정과 할 일을 보여 주고 저장할 수 있습니다.</p>
      <ul>
        <li>모든 캘린더의 일정 보기 및 수정</li>
        <li>캘린더 확인 (목록·일정 보기)</li>
        <li>할 일 생성, 수정, 정리, 삭제</li>
      </ul>
      <button type="button" class="btn primary connect-btn" data-act="connect">다시 연결하기</button>
      <p class="hint">권한 화면에서 <strong>모두 선택</strong>을 체크한 뒤 <strong>계속</strong>을 눌러 주세요.</p>
    </div>`;
  }

  /** 처음 쓸 때: 구글 계정 연결 */
  function connectScreen() {
    return `<div class="connect">
      <h2>구글 계정을 연결해 주세요</h2>
      <p>구글 캘린더 일정과 Google Tasks 할 일을 이 앱에서 보고 고치려면 한 번 연결이 필요합니다.
      비밀번호는 구글 화면에서만 입력하며, 이 앱은 보거나 저장하지 않습니다.</p>
      <ul>
        <li>캘린더: 일정 보기·만들기·고치기</li>
        <li>Tasks: 할 일 보기·만들기·고치기</li>
      </ul>
      <button type="button" class="btn primary connect-btn" data-act="connect">구글 계정 연결</button>
      <p class="hint">처음에는 ‘Google에서 확인하지 않은 앱’ 안내가 나옵니다. 직접 만든 앱이라 그렇습니다. ‘고급 → 이동’을 누르고, 권한 화면에서 <strong>모두 선택</strong>을 체크한 뒤 계속을 눌러 주세요.</p>
    </div>`;
  }

  /** 계정·연결 정보 창 */
  function openAccountSheet() {
    const email = Auth.hint();
    openSheet(`<div class="sh">
      <div class="sh-head"><h2>구글 연결</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="닫기">${ICON.x}</button></div>
      <div class="sh-meta">
        <div class="row"><span>계정</span><strong>${esc(email || '(아직 모름)')}</strong></div>
        <div class="row"><span>마지막 동기화</span><strong>${state.syncedAt ? esc(L.fmtTime(new Date(state.syncedAt).toISOString())) : '-'}</strong></div>
      </div>
      <p class="hint">일정은 구글 캘린더에, 할 일과 메모는 Google Tasks에 바로 저장됩니다. 이 기기에는 화면을 빨리 띄우기 위한 마지막 데이터만 남겨 둡니다.</p>
      <div class="sh-actions">
        <button type="button" class="btn danger" data-act="sign-out">연결 끊기</button>
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="switch-account">다른 계정</button>
        <button type="button" class="btn primary" data-act="connect">다시 연결</button>
      </div>
    </div>`, { type: 'account' });
  }

  /* ---------- 공통 줄 ---------- */

  function eventRow(ev, day) {
    let sub;
    if (ev.allDay) {
      const sp = L.eventSpan(ev);
      sub = sp.from === sp.to ? '' : L.fmtMD(sp.from) + ' – ' + L.fmtMD(sp.to);
    } else {
      sub = L.eventTimeRange(ev, day);
    }
    sub = [sub, ev.location].filter(Boolean).join(' · ');
    return `<button type="button" class="ev-row" data-act="open-event" data-cal="${esc(ev.calendarId)}" data-id="${esc(ev.id)}" style="--c:${L.safeColor(ev.color)}">
      <span class="ev-time">${esc(L.eventStartLabel(ev, day))}</span><span class="ev-dot"></span>
      <span class="ev-body"><span class="ev-title">${esc(ev.title)}</span>${sub ? `<span class="ev-sub">${esc(sub)}</span>` : ''}</span>
    </button>`;
  }

  function taskMeta(t) {
    const parts = [];
    if (t.parent) { const p = findTask(t.parent); if (p) parts.push('↳ ' + esc(p.title)); }
    if (t.due) {
      const di = L.dueInfo(t.due, state.today);
      if (t.done) parts.push(esc(L.fmtMD(t.due, yearOf(state.today))));
      else if (di.days === 0) parts.push('오늘 마감');
      else {
        parts.push(esc(L.fmtMD(t.due, yearOf(state.today))));
        parts.push(di.tone === 'danger' || di.tone === 'soon' ? `<strong class="soon-text">${esc(di.text)}</strong>` : esc(di.text));
      }
    }
    const subs = L.subtasksOf(state.tasks, t.id);
    if (subs.length) parts.push(`하위 할 일 ${subs.filter((s) => s.done).length}/${subs.length}`);
    if (t.notes && t.notes.trim()) parts.push('메모 있음');
    return parts.join(' · ');
  }

  function checkbox(t, extraClass) {
    const pending = isTmp(t.id);
    return `<input type="checkbox" class="cb${extraClass || ''}" data-act="toggle" data-id="${esc(t.id)}"${t.done ? ' checked' : ''}${pending ? ' disabled' : ''} aria-label="${esc(t.title || '할 일')} 완료">`;
  }

  function taskRow(t) {
    const pending = isTmp(t.id);
    const meta = taskMeta(t);
    return `<div class="task-row${t.done ? ' done' : ''}${pending ? ' pending' : ''}">
      ${checkbox(t)}
      <button type="button" class="task-open" data-act="open-task" data-id="${esc(t.id)}"${pending ? ' disabled' : ''}>
        <span class="t-title">${esc(t.title || '(제목 없음)')}</span>${meta ? `<span class="t-meta">${meta}</span>` : ''}
      </button>
    </div>`;
  }

  function taskGroup(label, items, tone) {
    if (!items.length) return '';
    return `<h3 class="g-label ${tone || ''}">${esc(label)}</h3>` + items.map(taskRow).join('');
  }

  /* ---------- 오늘 ---------- */

  function renderToday() {
    const day = state.today;
    const evs = L.eventsOn(allEvents(), day);
    const g = L.todayTasks(state.tasks, day, 14);
    const hasTasks = g.overdue.length + g.today.length + g.upcoming.length > 0;
    return `<div class="today">
      <p class="today-date">${esc(L.fmtLong(day))}</p>
      <div class="today-cols">
        <section aria-label="오늘 일정">
          <div class="block-head"><h2>일정</h2><span class="src src-ev">구글 캘린더 · ${evs.length}</span></div>
          ${evs.length ? evs.map((ev) => eventRow(ev, day)).join('') : '<p class="empty">오늘 일정이 없습니다.</p>'}
        </section>
        <section aria-label="할 일">
          <div class="block-head"><h2>할 일</h2><span class="src src-task">Google Tasks · ${esc(listTitle())}</span></div>
          ${taskGroup('지난 기한', g.overdue, 'danger')}
          ${taskGroup('오늘', g.today)}
          ${taskGroup('다가오는 마감 · 2주', g.upcoming)}
          ${hasTasks ? '' : '<p class="empty">마감이 다가오는 할 일이 없습니다.</p>'}
          ${noDateGroup(g.nodate)}
          <form class="quick-add" data-form="quick-add">${ICON.plus}<input name="title" data-draft="quick" value="${esc(draftValue('quick'))}" placeholder="오늘 할 일 추가" aria-label="오늘 마감인 할 일 추가" autocomplete="off" enterkeyhint="done"></form>
        </section>
      </div>
    </div>`;
  }

  /** 오늘 화면 맨 아래: 마감일 없는 할 일 (접었다 폈다, 상태 기억) */
  function noDateGroup(items) {
    if (!items.length) return '';
    const open = state.showNoDate;
    return `<button type="button" class="done-toggle" data-act="toggle-nodate" aria-expanded="${open}">날짜 없음 ${items.length}${ICON.chevR}</button>` +
      (open ? items.map(taskRow).join('') : '');
  }

  /* ---------- 할 일 ---------- */

  function renderTasks() {
    const sel = state.selTaskId ? findTask(state.selTaskId) : null;
    if (!isWide()) return sel ? `<div class="detail-pane">${renderDetail(sel)}</div>` : renderList();
    return renderList() + `<div class="detail-pane" data-scroll="detail">${sel ? renderDetail(sel)
      : '<div class="placeholder">왼쪽에서 할 일을 고르면<br>하위 할 일과 메모가 여기에 보입니다.</div>'}</div>`;
  }

  function renderList() {
    const groups = L.groupTasks(state.tasks, state.today);
    const done = L.doneTasks(state.tasks);
    const openCount = state.tasks.filter((t) => !t.parent && !t.done).length;
    const opts = state.tasklists.map((l) => `<option value="${esc(l.id)}"${l.id === state.listId ? ' selected' : ''}>${esc(l.title)}</option>`).join('');
    return `<div class="list-pane" data-scroll="list">
      <div class="list-head">
        <label class="list-select-wrap"><span class="sr">할 일 목록 고르기</span><select class="list-select" data-act="list">${opts}</select>${ICON.chevD}</label>
        <button type="button" class="btn sm" data-act="new-task">${ICON.plus}할 일</button>
      </div>
      <p class="list-sub">Google Tasks · 남은 할 일 ${openCount}개</p>
      ${groups.map((g) => `<h3 class="g-label ${g.tone}">${esc(g.label)} ${g.items.length}</h3>` + g.items.map(listItem).join('')).join('')}
      ${groups.length ? '' : '<p class="empty" style="padding:14px 8px">남은 할 일이 없습니다. ‘+ 할 일’로 추가해 보세요.</p>'}
      ${done.length ? `<button type="button" class="done-toggle" data-act="toggle-done" aria-expanded="${state.showDone}">완료됨 ${done.length}${ICON.chevR}</button>` : ''}
      ${state.showDone ? done.map(listItem).join('') : ''}
    </div>`;
  }

  function listItem(t) {
    const pending = isTmp(t.id);
    const sel = isWide() && t.id === state.selTaskId;
    const meta = taskMeta(t);
    return `<div class="t-item${sel ? ' sel' : ''}${t.done ? ' done' : ''}${pending ? ' pending' : ''}">
      ${checkbox(t)}
      <button type="button" class="task-open" data-act="open-task" data-id="${esc(t.id)}"${pending ? ' disabled' : ''}${sel ? ' aria-current="true"' : ''}>
        <span class="t-title">${esc(t.title || '(제목 없음)')}</span>${meta ? `<span class="t-meta">${meta}</span>` : ''}
      </button>
    </div>`;
  }

  function renderDetail(t) {
    const subs = L.subtasksOf(state.tasks, t.id);
    const di = L.dueInfo(t.due, state.today);
    const len = (t.notes || '').length;
    const year = yearOf(state.today);
    const id = esc(t.id);
    const link = L.safeUrl(t.link);
    return `<article class="detail${t.done ? ' done' : ''}">
      ${isWide() ? '' : `<button type="button" class="back" data-act="back">${ICON.chevL}할 일 목록</button>`}
      <span class="src-chip">${ICON.checkSm}Google Tasks · ${esc(listTitle())}</span>
      <div class="d-title-row">
        ${checkbox(t, ' cb-lg')}
        <input class="d-title" data-act="title" data-id="${id}" value="${esc(t.title)}" aria-label="할 일 제목" enterkeyhint="done" autocomplete="off">
      </div>
      <div>
        <div class="due-box">
          ${ICON.cal}<span class="hint due-label">마감일</span>
          <input type="date" class="due-input" data-act="due" data-id="${id}" value="${esc(t.due)}" aria-label="마감일">
          ${!t.done && di.text ? `<span class="due-d ${di.tone}">${esc(di.text)}</span>` : ''}
          ${t.due ? `<button type="button" class="icon-btn sm due-clear" data-act="clear-due" data-id="${id}" aria-label="마감일 지우기">${ICON.x}</button>` : ''}
        </div>
        <p class="hint" style="padding:6px 4px 0">${t.due ? `구글 캘린더의 ${esc(L.fmtMD(t.due, year))} 칸에도 할 일로 표시됩니다.` : '마감일을 정하면 구글 캘린더에도 표시됩니다.'}</p>
      </div>
      <section class="d-sec" aria-label="하위 할 일">
        <div class="d-sec-head"><h3>하위 할 일</h3><span>${subs.filter((s) => s.done).length}/${subs.length}</span></div>
        ${subs.map(subRow).join('')}
        <form class="sub-add" data-form="sub-add" data-parent="${id}">${ICON.plus}<input name="title" data-draft="sub:${id}" value="${esc(draftValue('sub:' + t.id))}" placeholder="하위 할 일 추가" aria-label="하위 할 일 추가" autocomplete="off" enterkeyhint="done"></form>
      </section>
      <section class="d-sec" aria-label="메모">
        <div class="d-sec-head"><label for="memoInput">메모</label><span class="${len > L.NOTES_LIMIT * 0.9 ? 'danger-text' : ''}">Tasks 메모 칸 · ${len.toLocaleString()} / 8,192자</span></div>
        ${state.memoEdit ? memoRaw(t) : memoView(t, year)}
      </section>
      <footer class="d-foot">
        ${link ? `<a class="btn ghost sm" href="${esc(link)}" target="_blank" rel="noopener">${ICON.ext}Google Tasks에서 열기</a>` : '<span></span>'}
        <button type="button" class="btn danger sm" data-act="delete-task" data-id="${id}">${ICON.trash}삭제</button>
      </footer>
    </article>`;
  }

  function subRow(s) {
    const pending = isTmp(s.id);
    return `<div class="sub-row${s.done ? ' done' : ''}${pending ? ' pending' : ''}">
      ${checkbox(s)}
      <span class="sub-title">${esc(s.title)}</span>
      ${s.due ? `<span class="sub-due">${esc(L.fmtMD(s.due))}</span>` : ''}
      <button type="button" class="icon-btn sm" data-act="delete-sub" data-id="${esc(s.id)}" aria-label="${esc(s.title)} 삭제"${pending ? ' disabled' : ''}>${ICON.x}</button>
    </div>`;
  }

  function memoView(t, year) {
    const memo = L.parseMemo(t.notes);
    const items = [];
    if (memo.loose) {
      items.push(`<div class="memo-entry"><span class="m-date">날짜 없음</span><p class="m-text">${esc(memo.loose)}</p></div>`);
    }
    memo.entries.forEach((e, i) => {
      items.push(`<div class="memo-entry"><span class="m-date">${esc(L.fmtMD(e.date, year))}</span><p class="m-text">${esc(e.text)}</p>
        <button type="button" class="icon-btn sm" data-act="memo-del" data-id="${esc(t.id)}" data-index="${i}" aria-label="${esc(L.fmtMD(e.date))} 메모 지우기">${ICON.x}</button></div>`);
    });
    return `<form class="memo-add" data-form="memo-add" data-id="${esc(t.id)}">
        <textarea id="memoInput" name="text" data-draft="memo:${esc(t.id)}" rows="2" placeholder="${esc(L.fmtMD(state.today))} 메모 추가… 날짜는 자동으로 붙어요">${esc(draftValue('memo:' + t.id))}</textarea>
        <div class="row"><button type="submit" class="btn primary sm">메모 추가</button></div>
      </form>
      ${items.length ? `<div class="memo-list">${items.join('')}</div>` : '<p class="empty">아직 메모가 없습니다.</p>'}
      ${t.notes ? '<div class="memo-tools"><button type="button" class="link-btn" data-act="memo-edit">메모 전체 편집</button></div>' : ''}`;
  }

  function memoRaw(t) {
    return `<form class="memo-raw" data-form="memo-raw" data-id="${esc(t.id)}">
      <textarea id="memoInput" name="notes" data-draft="raw:${esc(t.id)}" rows="12">${esc(draftValue('raw:' + t.id, t.notes))}</textarea>
      <p class="hint" style="margin:6px 0">[${esc(state.today)}] 처럼 날짜로 시작하는 줄이 메모 하나의 시작입니다.</p>
      <div class="row"><button type="button" class="btn sm" data-act="memo-cancel">취소</button><button type="submit" class="btn primary sm">저장</button></div>
    </form>`;
  }

  /* ---------- 캘린더 ---------- */

  function renderCalendar() {
    const weeks = L.monthWeeks(state.month);
    const evs = allEvents();
    const max = isWide() ? 3 : 2;
    const loading = !state.events[state.month];
    const cells = weeks.map((w) => `<div class="wk">${w.map((day) => dayCell(day, evs, max)).join('')}</div>`).join('');
    return `<div class="cal-split">
      <div class="cal-main" data-scroll="cal">
        <div class="cal-head">
          <button type="button" class="icon-btn" data-act="month" data-delta="-1" aria-label="이전 달">${ICON.chevL}</button>
          <h2 class="cal-title">${esc(L.monthLabel(state.month))}</h2>
          <button type="button" class="icon-btn" data-act="month" data-delta="1" aria-label="다음 달">${svg(20, '<path d="M9 5l7 7-7 7"/>')}</button>
          ${loading ? '<span class="cal-loading">불러오는 중…</span>' : ''}
          <button type="button" class="btn sm" data-act="month-today">오늘</button>
        </div>
        <div class="cal-wd" aria-hidden="true">${L.WEEK.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-legend"><span><span class="lg-ev"></span>일정 (구글 캘린더)</span><span><span class="lg-task"></span>할 일 (마감일에 표시)</span><span><span class="lg-over"></span>기한 지남</span></div>
      </div>
      <aside class="day-panel" data-scroll="day" aria-label="고른 날짜">${renderDayPanel(state.selDate, evs)}</aside>
    </div>`;
  }

  function dayCell(day, evs, max) {
    const dow = L.weekdayIndex(day);
    const dayEvs = L.eventsOn(evs, day);
    const dayTasks = L.tasksDueOn(state.tasks, day);
    const chips = dayEvs.map((ev) => `<span class="chip ev" style="--c:${L.safeColor(ev.color)}"><span>${esc(ev.title)}</span></span>`)
      .concat(dayTasks.map((t) => {
        const over = !t.done && day < state.today;
        return `<span class="chip task${t.done ? ' done' : ''}${over ? ' over' : ''}"><span class="box"></span><span>${esc(t.title)}</span></span>`;
      }));
    const more = chips.length - max;
    const cls = ['day',
      day.slice(0, 7) !== state.month ? 'other' : '',
      day === state.today ? 'today' : '',
      day === state.selDate ? 'sel' : '',
      dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''].filter(Boolean).join(' ');
    const label = `${L.fmtLong(day)}, 일정 ${dayEvs.length}개, 할 일 ${dayTasks.length}개`;
    return `<button type="button" class="${cls}" data-act="pick-day" data-date="${day}" aria-label="${esc(label)}" aria-pressed="${day === state.selDate}">
      <span class="dn">${+day.slice(8)}</span>${chips.slice(0, max).join('')}${more > 0 ? `<span class="more">+${more}</span>` : ''}
    </button>`;
  }

  function renderDayPanel(day, evs) {
    const dayEvs = L.eventsOn(evs, day);
    const dayTasks = L.tasksDueOn(state.tasks, day);
    const overdue = day === state.today ? L.todayTasks(state.tasks, day).overdue : [];
    return `<div class="dp-head"><h2>${esc(L.fmtLong(day))}</h2>${day === state.today ? '<span class="badge">오늘</span>' : ''}</div>
      <section>
        <div class="block-head"><h3>일정</h3><span class="src src-ev">구글 캘린더</span></div>
        ${dayEvs.length ? dayEvs.map((ev) => eventRow(ev, day)).join('') : '<p class="empty">일정이 없습니다.</p>'}
      </section>
      <section>
        <div class="block-head"><h3>할 일</h3><span class="src src-task">Google Tasks</span></div>
        ${dayTasks.length ? dayTasks.map(taskRow).join('') : '<p class="empty">이 날 마감인 할 일이 없습니다.</p>'}
        ${taskGroup('지난 기한', overdue, 'danger')}
      </section>
      <div class="dp-actions">
        <button type="button" class="add-ev" data-act="new-event" data-date="${day}">+ 일정<small>구글 캘린더에 저장</small></button>
        <button type="button" class="add-task" data-act="new-task" data-date="${day}">+ 할 일<small>Google Tasks에 저장</small></button>
      </div>`;
  }

  /* ================= 입력 창 ================= */

  function openSheet(html, ctx) {
    state.sheetCtx = ctx || null;
    sheet.innerHTML = html;
    if (!sheet.open) sheet.showModal();
    const f = sheet.querySelector('[autofocus]');
    if (f) f.focus();
  }
  function closeSheet() { if (sheet.open) sheet.close(); }

  function confirmBox(message, yesLabel) {
    return new Promise((resolve) => {
      confirmDlg.innerHTML = `<form method="dialog" class="sh">
        <p style="font-size:15px;line-height:1.55">${esc(message)}</p>
        <div class="sh-actions"><button value="no" class="btn">취소</button><button value="yes" class="btn danger">${esc(yesLabel || '지우기')}</button></div>
      </form>`;
      confirmDlg.returnValue = '';
      confirmDlg.addEventListener('close', () => resolve(confirmDlg.returnValue === 'yes'), { once: true });
      confirmDlg.showModal();
    });
  }

  function openEventView(ev) {
    const cal = calById(ev.calendarId);
    const desc = L.stripHtml(ev.description);
    const link = L.safeUrl(ev.link);
    openSheet(`<div class="sh">
      <div class="sh-head"><span class="ev-dot" style="--c:${L.safeColor(ev.color)};margin:0"></span><h2>${esc(ev.title)}</h2>
        <button type="button" class="icon-btn" data-act="close-sheet" aria-label="닫기">${ICON.x}</button></div>
      <div class="sh-meta">
        <div class="row">${ICON.clock}<span>${esc(L.eventWhen(ev, yearOf(state.today)))}</span></div>
        ${ev.location ? `<div class="row">${ICON.pin}<span>${esc(ev.location)}</span></div>` : ''}
        <div class="row">${ICON.cal}<span>${esc(cal ? cal.name : '캘린더')}${ev.recurring ? ' · 반복 일정' : ''}</span></div>
      </div>
      ${desc ? `<p class="sh-desc">${esc(desc)}</p>` : ''}
      <div class="sh-actions">
        ${link ? `<a class="btn ghost" href="${esc(link)}" target="_blank" rel="noopener">${ICON.ext}구글 캘린더에서 열기</a>` : ''}
        <span class="spacer"></span>
        ${ev.editable ? '<button type="button" class="btn primary" data-act="edit-event">수정</button>' : ''}
      </div>
    </div>`, { type: 'event', ev: ev });
  }

  function defaultStart(day) {
    if (day !== state.today) return '09:00';
    const h = Math.min(new Date().getHours() + 1, 23);
    return L.pad(h) + ':00';
  }
  function addHour(hm) {
    const p = String(hm || '09:00').split(':').map(Number);
    return p[0] >= 23 ? '23:59' : L.pad(p[0] + 1) + ':' + L.pad(p[1] || 0);
  }

  function openEventForm(ev, date) {
    const writable = state.calendars.filter((c) => c.writable);
    if (!writable.length) { toast('일정을 추가할 수 있는 캘린더가 없습니다.', true); return; }
    const sp = ev ? L.eventSpan(ev) : null;
    const d = ev ? sp.from : (date || state.today);
    const endD = ev ? sp.to : d;
    const st = ev && !ev.allDay ? L.fmtTime(ev.start) : defaultStart(d);
    const en = ev && !ev.allDay ? L.fmtTime(ev.end) : addHour(st);
    const calId = ev ? ev.calendarId : (writable.find((c) => c.primary) || writable[0]).id;
    const desc = ev ? L.stripHtml(ev.description) : '';
    const lockCal = ev && ev.recurring;
    openSheet(`<form class="sh" data-form="event">
      <div class="sh-head"><h2>${ev ? '일정 수정' : '새 일정'}</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="닫기">${ICON.x}</button></div>
      ${lockCal ? '<p class="hint">반복 일정입니다. 이 날짜의 일정 하나만 바뀝니다.</p>' : ''}
      <label class="field"><span>제목</span><input name="title" required value="${esc(ev ? ev.title : '')}" autocomplete="off"${ev ? '' : ' autofocus'}></label>
      <label class="field"><span>캘린더</span><select name="calendarId"${lockCal ? ' disabled' : ''}>${writable.map((c) => `<option value="${esc(c.id)}"${c.id === calId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="allDay"${ev && ev.allDay ? ' checked' : ''}>종일</label>
      <div class="field-row">
        <label class="field"><span>날짜</span><input type="date" name="date" required value="${d}"></label>
        <label class="field"><span>끝나는 날</span><input type="date" name="endDate" value="${endD}"></label>
      </div>
      <div class="field-row time-row">
        <label class="field"><span>시작</span><input type="time" name="startTime" value="${st}"></label>
        <label class="field"><span>끝</span><input type="time" name="endTime" value="${en}"></label>
      </div>
      <label class="field"><span>장소</span><input name="location" value="${esc(ev ? ev.location : '')}" autocomplete="off"></label>
      <label class="field"><span>설명</span><textarea name="description" rows="3">${esc(desc)}</textarea></label>
      <div class="sh-actions">
        ${ev ? `<button type="button" class="btn danger" data-act="delete-event">${ICON.trash}삭제</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="close-sheet">취소</button>
        <button type="submit" class="btn primary">저장</button>
      </div>
    </form>`, { type: 'event-form', ev: ev || null, descBase: desc });
  }

  function eventFormChange(form, el) {
    const f = form.elements;
    if (el.name === 'date' && (!f.endDate.value || f.endDate.value < f.date.value)) f.endDate.value = f.date.value;
    if (el.name === 'startTime' && f.date.value === f.endDate.value && f.endTime.value <= f.startTime.value) {
      f.endTime.value = addHour(f.startTime.value);
    }
  }

  function openTaskForm(date) {
    openSheet(`<form class="sh" data-form="task-new">
      <div class="sh-head"><h2>새 할 일</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="닫기">${ICON.x}</button></div>
      <label class="field"><span>제목</span><input name="title" required autocomplete="off" autofocus></label>
      <label class="field"><span>마감일</span><input type="date" name="due" value="${esc(date || '')}"></label>
      <label class="field"><span>메모</span><textarea name="notes" rows="3" placeholder="오늘 날짜가 붙어 저장됩니다"></textarea></label>
      <p class="hint">Google Tasks ‘${esc(listTitle())}’ 목록에 저장됩니다.</p>
      <div class="sh-actions"><span class="spacer"></span>
        <button type="button" class="btn" data-act="close-sheet">취소</button>
        <button type="submit" class="btn primary">저장</button>
      </div>
    </form>`, { type: 'task-new' });
  }

  function setBusy(form, busy) {
    form.querySelectorAll('button').forEach((b) => { b.disabled = busy; });
  }

  /* ================= 알림 ================= */

  let toastTimer = null;
  function toast(msg, isErr, action) {
    toastEl.innerHTML = esc(msg) + (action ? ` <button type="button" class="toast-btn" data-act="toast-action">${esc(action.label)}</button>` : '');
    toastEl.className = 'toast show' + (isErr ? ' err' : '') + (action ? ' has-action' : '');
    state.toastAction = action ? action.fn : null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; state.toastAction = null; }, action ? 5000 : 3200);
  }

  /* ================= 구글에서 불러오기 ================= */

  function cacheSave() {
    const key = state.today.slice(0, 7);
    store.set('cache', {
      v: 1,
      calendars: state.calendars,
      tasklists: state.tasklists,
      listId: state.listId,
      tasks: state.tasks.filter((t) => !isTmp(t.id)),
      eventsKey: key,
      events: state.events[key] || [],
    });
  }

  function cacheLoad() {
    const c = store.get('cache', null);
    if (!c || c.v !== 1) return false;
    state.calendars = c.calendars || [];
    state.tasklists = c.tasklists || [];
    state.listId = c.listId || state.listId;
    state.tasks = c.tasks || [];
    if (c.eventsKey) state.events[c.eventsKey] = c.events || [];
    state.loaded = true;
    return true;
  }

  async function loadAll() {
    if (state.syncing) return;
    if (!Auth.token()) { needAuth(); return; }
    if (Auth.missingScopes().length) { // 권한이 빠진 토큰으로는 부르지 않음
      state.scopeMissing = true;
      safeRender();
      return;
    }
    state.syncing = true;
    renderSync();
    const prevToday = state.today;
    state.today = todayNow();
    if (state.selDate === prevToday) state.selDate = state.today;
    const key = state.today.slice(0, 7);
    const taskGen = state.taskGen;
    const eventGen = state.eventGen;
    const listAtStart = state.listId;
    try {
      const r = L.monthRange(key);
      const data = await call('getBootstrap', r.startIso, r.endIso, listAtStart || '');
      state.calendars = data.calendars || [];
      state.tasklists = data.tasklists || [];
      if (state.listId === listAtStart) { // 그 사이 다른 목록으로 바꿨으면 그쪽 결과를 따름
        state.listId = data.listId || '';
        store.set('listId', state.listId);
        // 요청을 보낸 뒤 할 일을 바꿨다면 이 응답은 옛 상태일 수 있으므로 덮지 않고 다시 받음
        if (taskGen === state.taskGen && state.inflight === 0) state.tasks = data.tasks || [];
        else markTasksStale();
      }
      if (eventGen === state.eventGen) { // 그 사이 일정을 저장했다면 reloadEvents가 새로 받는 중
        state.events = {};
        state.events[key] = data.events || [];
      }
      state.loaded = true;
      state.error = '';
      state.needAuth = false;
      state.scopeMissing = false;
      state.syncedAt = Date.now();
      if (state.selTaskId && !findTask(state.selTaskId)) state.selTaskId = '';
      const primary = state.calendars.find((c) => c.primary);
      if (primary) Auth.setHint(primary.id); // 기본 캘린더 ID = 계정 이메일 → 다음 연결 때 계정 자동 선택
      cacheSave();
      if (state.month !== key) loadMonth(state.month);
    } catch (e) {
      if (!isAuthError(e) && e.code !== 'scope') { // 연결 만료·권한 부족은 각자의 안내 화면으로 처리
        state.error = e.message || String(e);
        toast('구글에서 불러오지 못했습니다: ' + state.error, true);
      }
    } finally {
      state.syncing = false;
      safeRender();
    }
  }

  function loadMonth(key) {
    if (state.loadingMonths[key]) return state.loadingMonths[key];
    const gen = state.eventGen;
    const r = L.monthRange(key);
    const p = call('getEvents', r.startIso, r.endIso)
      .then((evs) => { if (gen === state.eventGen) state.events[key] = evs || []; }) // 옛 요청의 응답은 버림
      .catch((e) => { if (gen === state.eventGen) toast('일정을 불러오지 못했습니다: ' + e.message, true); })
      .then(() => {
        if (state.loadingMonths[key] === p) delete state.loadingMonths[key];
        safeRender();
      });
    state.loadingMonths[key] = p;
    return p;
  }

  function ensureMonth() {
    if (!state.events[state.month] && state.loaded) loadMonth(state.month);
  }

  async function reloadEvents(extraKeys) {
    const keys = [state.today.slice(0, 7), state.month].concat(extraKeys || [])
      .filter((k, i, arr) => arr.indexOf(k) === i);
    state.eventGen++;          // 진행 중이던 옛 요청(저장 전 내용)의 응답은 버림
    state.loadingMonths = {};
    state.events = {};
    safeRender();
    await Promise.all(keys.map(loadMonth));
    cacheSave();
  }

  async function reloadTasks() {
    const gen = state.taskGen;
    const listId = state.listId;
    state.tasksStale = false;
    try {
      const tasks = await call('getTasks', listId);
      if (listId !== state.listId) return; // 그 사이 다른 목록으로 바꿈
      if (gen !== state.taskGen || state.inflight > 0) { markTasksStale(); return; }
      state.tasks = tasks;
      if (state.selTaskId && !findTask(state.selTaskId)) state.selTaskId = '';
      cacheSave();
    } catch (e) {
      toast('할 일을 불러오지 못했습니다: ' + e.message, true);
    }
    safeRender();
  }

  /** 받은 할 일 목록이 옛 상태일 수 있음: 저장이 다 끝난 뒤 다시 받음 */
  function markTasksStale() {
    if (state.inflight > 0) state.tasksStale = true;
    else reloadTasks();
  }

  /* ================= 할 일 바꾸기 ================= */

  /** 할 일을 구글에 저장하는 동안 표시해, 그 사이 도착한 동기화 응답이 새 변경을 덮지 않게 합니다. */
  async function mutate(fn) {
    state.taskGen++;
    state.inflight++;
    try {
      return await fn();
    } finally {
      state.inflight--;
      if (state.inflight === 0 && state.tasksStale) reloadTasks();
    }
  }

  function replaceTask(id, t) {
    const i = state.tasks.findIndex((x) => x.id === id);
    if (i >= 0) state.tasks[i] = t; // 없으면(그 사이 목록을 바꿨거나 지움) 넣지 않음
  }

  /** draftKey: 어느 입력칸에서 왔는지. 저장에 실패하면 그 칸에 제목을 되돌려 놓습니다. */
  async function addTask(input, draftKey) {
    const tmp = {
      id: 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      title: input.title, notes: input.notes || '', due: input.due || '', done: false, completed: '',
      parent: input.parent || '', position: input.parent ? '~' : '', link: '',
    };
    state.tasks.push(tmp);
    render();
    try {
      const t = await mutate(() => call('createTask', state.listId, input));
      replaceTask(tmp.id, t);
      if (state.selTaskId === tmp.id) state.selTaskId = t.id;
      cacheSave();
    } catch (e) {
      state.tasks = state.tasks.filter((x) => x.id !== tmp.id);
      if (draftKey && !state.drafts[draftKey]) state.drafts[draftKey] = input.title;
      toast('할 일을 저장하지 못했습니다: ' + e.message, true);
    }
    safeRender();
  }

  async function patchTask(id, patch, optimistic, okMsg) {
    const t = findTask(id);
    if (!t || isTmp(id)) return;
    const before = Object.assign({}, t);
    Object.assign(t, optimistic);
    render();
    try {
      replaceTask(id, await mutate(() => call('updateTask', state.listId, id, patch)));
      cacheSave();
      if (okMsg) toast(okMsg.text, false, okMsg.action);
    } catch (e) {
      replaceTask(id, before);
      toast('구글에 저장하지 못했습니다: ' + e.message, true);
    }
    safeRender();
  }

  function toggleTask(id, done) {
    const t = findTask(id);
    if (!t) return;
    patchTask(id, { done: done }, { done: done, completed: done ? new Date().toISOString() : '' },
      done ? { text: `‘${t.title}’ 완료`, action: { label: '되돌리기', fn: () => toggleTask(id, false) } } : null);
  }

  function updateTitle(id, title) {
    const t = findTask(id);
    const v = String(title || '').trim();
    if (!t || v === t.title) return;
    if (!v) { toast('제목은 비워 둘 수 없습니다.', true); render(); return; }
    patchTask(id, { title: v }, { title: v });
  }

  function updateDue(id, due) {
    const t = findTask(id);
    if (!t || (t.due || '') === (due || '')) return;
    patchTask(id, { due: due || '' }, { due: due || '' });
  }

  async function addMemo(id, text) {
    const t = findTask(id);
    const body = String(text || '').trim();
    if (!t || !body) return;
    const before = t.notes;
    const next = L.insertMemoEntry(t.notes, state.today, body);
    if (next.length > L.NOTES_LIMIT) { toast('메모 칸(8,192자)이 가득 찹니다. 오래된 메모를 정리해 주세요.', true); return; }
    t.notes = next;
    delete state.drafts['memo:' + id];
    render();
    try {
      replaceTask(id, await mutate(() => call('appendMemo', state.listId, id, state.today, body)));
      cacheSave();
    } catch (e) {
      const cur = findTask(id);
      if (cur) cur.notes = before;
      state.drafts['memo:' + id] = body;
      toast('메모를 저장하지 못했습니다: ' + e.message, true);
    }
    safeRender();
  }

  async function replaceNotesAction(id, expected, next, okMsg) {
    const t = findTask(id);
    if (!t) return false;
    const before = t.notes;
    t.notes = next;
    render();
    try {
      replaceTask(id, await mutate(() => call('replaceNotes', state.listId, id, expected, next)));
      cacheSave();
      if (okMsg) toast(okMsg);
      safeRender();
      return true;
    } catch (e) {
      const cur = findTask(id);
      if (cur) cur.notes = before;
      toast(e.message, true);
      safeRender();
      return false;
    }
  }

  async function deleteMemoAction(id, index) {
    const t = findTask(id);
    if (!t) return;
    const entry = L.parseMemo(t.notes).entries[index];
    if (!entry) return;
    if (!(await confirmBox(`${L.fmtMD(entry.date)} 메모를 지울까요?\n“${entry.text.slice(0, 60)}${entry.text.length > 60 ? '…' : ''}”`))) return;
    replaceNotesAction(id, t.notes, L.removeMemoEntry(t.notes, index), '메모를 지웠습니다.');
  }

  async function deleteTaskAction(id) {
    const t = findTask(id);
    if (!t) return;
    const kids = L.subtasksOf(state.tasks, id).filter((s) => !isTmp(s.id));
    const msg = `‘${t.title}’을(를) 지울까요?` + (kids.length ? ` 하위 할 일 ${kids.length}개도 함께 지워집니다.` : '') + ' Google Tasks에서도 지워집니다.';
    if (!(await confirmBox(msg))) return;
    const before = state.tasks.slice();
    state.tasks = state.tasks.filter((x) => x.id !== id && x.parent !== id);
    if (state.selTaskId === id) { state.selTaskId = ''; state.memoEdit = false; }
    render();
    try {
      await mutate(() => call('deleteTask', state.listId, id, kids.map((k) => k.id)));
      cacheSave();
      toast('할 일을 지웠습니다.');
    } catch (e) {
      state.tasks = before;
      toast('지우지 못했습니다: ' + e.message, true);
      reloadTasks();
    }
    safeRender();
  }

  async function deleteSubAction(id) {
    const s = findTask(id);
    if (!s) return;
    if (!(await confirmBox(`하위 할 일 ‘${s.title}’을(를) 지울까요?`))) return;
    const before = state.tasks.slice();
    state.tasks = state.tasks.filter((x) => x.id !== id);
    render();
    try {
      await mutate(() => call('deleteTask', state.listId, id, []));
      cacheSave();
    } catch (e) {
      state.tasks = before;
      toast('지우지 못했습니다: ' + e.message, true);
    }
    safeRender();
  }

  function addSubtask(parentId, title) {
    const kids = L.subtasksOf(state.tasks, parentId).filter((s) => !isTmp(s.id));
    const input = { title: title, parent: parentId };
    if (kids.length) input.previous = kids[kids.length - 1].id;
    return addTask(input, 'sub:' + parentId);
  }

  async function switchList(listId) {
    if (listId === state.listId) return;
    state.listId = listId;
    store.set('listId', listId);
    state.selTaskId = '';
    state.tasks = [];
    render();
    await reloadTasks();
  }

  /* ================= 일정 바꾸기 ================= */

  async function submitEventForm(form) {
    const ctx = state.sheetCtx || {};
    const ev = ctx.ev;
    const f = form.elements;
    const input = {
      title: f.title.value.trim(),
      calendarId: f.calendarId.value,
      allDay: f.allDay.checked,
      date: f.date.value,
      endDate: f.endDate.value || f.date.value,
      startTime: f.startTime.value,
      endTime: f.endTime.value,
      location: f.location.value.trim(),
      timeZone: TZ,
    };
    const desc = f.description.value;
    if (!ev || desc !== ctx.descBase) input.description = desc;
    if (ev) { input.id = ev.id; input.originalCalendarId = ev.calendarId; }
    if (!input.title) { toast('제목을 입력해 주세요.', true); return; }
    if (!input.date) { toast('날짜를 골라 주세요.', true); return; }
    if (input.endDate < input.date) { toast('끝나는 날이 시작하는 날보다 앞설 수 없습니다.', true); return; }
    if (!input.allDay && (!input.startTime || !input.endTime)) { toast('시작·끝 시간을 입력해 주세요.', true); return; }
    if (!input.allDay && input.endDate === input.date && input.endTime <= input.startTime) { toast('끝나는 시간이 시작 시간보다 늦어야 합니다.', true); return; }
    setBusy(form, true);
    try {
      await call('saveEvent', input);
      closeSheet();
      toast(ev ? '일정을 고쳤습니다.' : '구글 캘린더에 일정을 추가했습니다.');
      state.selDate = input.date;
      await reloadEvents([input.date.slice(0, 7)]);
    } catch (e) {
      toast(e.message, true);
      setBusy(form, false);
    }
  }

  async function deleteEventAction() {
    const ev = state.sheetCtx && state.sheetCtx.ev;
    if (!ev) return;
    const msg = ev.recurring ? `반복 일정 ‘${ev.title}’ 중 이 날짜 하나만 지울까요?` : `‘${ev.title}’ 일정을 지울까요? 구글 캘린더에서도 지워집니다.`;
    if (!(await confirmBox(msg))) return;
    try {
      await call('deleteEvent', ev.calendarId, ev.id);
      closeSheet();
      toast('일정을 지웠습니다.');
      await reloadEvents();
    } catch (e) {
      toast('지우지 못했습니다: ' + e.message, true);
    }
  }

  /* ================= 화면 이동 ================= */

  function setView(v) {
    if (VIEWS.indexOf(v) < 0) return;
    if (v !== state.view && !isWide()) state.selTaskId = '';
    state.view = v;
    store.set('view', v);
    if (v === 'calendar') ensureMonth();
    render();
    main.scrollTop = 0;
  }

  function openTask(id) {
    let t = findTask(id);
    if (!t) return;
    if (t.parent) t = findTask(t.parent) || t;
    state.selTaskId = t.id;
    state.memoEdit = false;
    if (state.view !== 'tasks') { state.view = 'tasks'; store.set('view', 'tasks'); }
    render();
    if (!isWide()) {
      main.scrollTop = 0;
      // 폰의 뒤로 가기로 목록에 돌아올 수 있게 기록을 하나 남김
      if (!(history.state && history.state.task)) history.pushState({ task: t.id }, '');
      else history.replaceState({ task: t.id }, '');
    }
  }

  function closeTask() {
    state.selTaskId = '';
    state.memoEdit = false;
    render();
  }

  /** 화면의 '할 일 목록' 버튼: 남겨 둔 기록이 있으면 뒤로 가기와 똑같이 처리 */
  function backToList() {
    if (history.state && history.state.task) history.back(); // popstate에서 닫음
    else closeTask();
  }

  function pickDay(day) {
    state.selDate = day;
    if (day.slice(0, 7) !== state.month) { state.month = day.slice(0, 7); ensureMonth(); }
    render();
    if (!isWide()) {
      const panel = main.querySelector('.day-panel');
      if (panel) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function changeMonth(delta) {
    state.month = L.shiftMonth(state.month, delta);
    state.selDate = state.today.slice(0, 7) === state.month ? state.today : state.month + '-01';
    ensureMonth();
    render();
  }

  /* ================= 이벤트 연결 ================= */

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    const d = el.dataset;
    switch (d.act) {
      case 'view': setView(d.view); break;
      case 'refresh': loadAll(); break;
      case 'retry': loadAll(); break;
      case 'open-task': openTask(d.id); break;
      case 'back': backToList(); break;
      case 'connect': connect(false); break;
      case 'switch-account': connect(true); break;
      case 'account': openAccountSheet(); break;
      case 'sign-out': signOutAction(); break;
      case 'toggle-done': state.showDone = !state.showDone; render(); break;
      case 'toggle-nodate':
        state.showNoDate = !state.showNoDate;
        store.set('showNoDate', state.showNoDate);
        render();
        break;
      case 'new-task': openTaskForm(d.date || ''); break;
      case 'clear-due': updateDue(d.id, ''); break;
      case 'delete-task': deleteTaskAction(d.id); break;
      case 'delete-sub': deleteSubAction(d.id); break;
      case 'memo-del': deleteMemoAction(d.id, +d.index); break;
      case 'memo-edit': {
        const t = findTask(state.selTaskId);
        state.memoEdit = true;
        state.memoEditBase = t ? t.notes : '';
        delete state.drafts['raw:' + state.selTaskId]; // 지금 구글에 있는 메모로 시작
        render();
        const ta = document.getElementById('memoInput');
        if (ta) ta.focus();
        break;
      }
      case 'memo-cancel':
        state.memoEdit = false;
        delete state.drafts['raw:' + state.selTaskId];
        render();
        break;
      case 'open-event': { const ev = findEvent(d.cal, d.id); if (ev) openEventView(ev); break; }
      case 'edit-event': if (state.sheetCtx && state.sheetCtx.ev) openEventForm(state.sheetCtx.ev); break;
      case 'delete-event': deleteEventAction(); break;
      case 'new-event': openEventForm(null, d.date); break;
      case 'close-sheet': closeSheet(); break;
      case 'pick-day': pickDay(d.date); break;
      case 'month': changeMonth(+d.delta); break;
      case 'month-today':
        state.month = state.today.slice(0, 7);
        state.selDate = state.today;
        ensureMonth();
        render();
        break;
      case 'toast-action': {
        const fn = state.toastAction;
        toastEl.className = 'toast';
        state.toastAction = null;
        if (fn) fn();
        break;
      }
      default: break;
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    const act = el.dataset ? el.dataset.act : '';
    if (act === 'toggle') toggleTask(el.dataset.id, el.checked);
    else if (act === 'title') updateTitle(el.dataset.id, el.value);
    else if (act === 'due') updateDue(el.dataset.id, el.value);
    else if (act === 'list') switchList(el.value);
    else if (el.form && el.form.dataset.form === 'event') eventFormChange(el.form, el);
  });

  document.addEventListener('submit', (e) => {
    const form = e.target;
    const kind = form.dataset ? form.dataset.form : '';
    if (!kind) return; // method="dialog" 확인 창은 그대로 닫히게 둠
    e.preventDefault();
    if (kind === 'quick-add') {
      const v = form.elements.title.value.trim();
      if (!v) return;
      form.elements.title.value = '';
      delete state.drafts.quick;
      addTask({ title: v, due: state.today }, 'quick');
      const again = main.querySelector('[data-form="quick-add"] input');
      if (again) again.focus();
    } else if (kind === 'sub-add') {
      const v = form.elements.title.value.trim();
      if (!v) return;
      const parent = form.dataset.parent;
      form.elements.title.value = '';
      delete state.drafts['sub:' + parent];
      addSubtask(parent, v);
      const again = main.querySelector('[data-form="sub-add"] input');
      if (again) again.focus();
    } else if (kind === 'memo-add') {
      addMemo(form.dataset.id, form.elements.text.value);
    } else if (kind === 'memo-raw') {
      const id = form.dataset.id;
      const text = form.elements.notes.value;
      state.drafts['raw:' + id] = text; // 실패해도 쓴 글이 남도록
      replaceNotesAction(id, state.memoEditBase, text, '메모를 저장했습니다.').then((ok) => {
        if (ok) {
          state.memoEdit = false;
          delete state.drafts['raw:' + id];
          render();
        }
      });
    } else if (kind === 'task-new') {
      const f = form.elements;
      const title = f.title.value.trim();
      if (!title) { toast('제목을 입력해 주세요.', true); return; }
      const notes = f.notes.value.trim();
      closeSheet();
      addTask({ title: title, due: f.due.value || '', notes: notes ? L.insertMemoEntry('', state.today, notes) : '' });
    } else if (kind === 'event') {
      submitEventForm(form);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.act === 'title') {
      e.preventDefault();
      e.target.blur();
    }
  });

  // 입력칸에 쓰는 글을 상태에 보관 (화면을 다시 그려도 되살림)
  document.addEventListener('input', (e) => {
    const key = e.target.dataset ? e.target.dataset.draft : '';
    if (key) state.drafts[key] = e.target.value;
  });

  main.addEventListener('focusout', () => {
    if (state.renderPending) setTimeout(() => { if (state.renderPending) safeRender(); }, 0);
  });

  // 화면을 누르는 동안에는 자동 그리기를 미루고, 손을 뗀 뒤 클릭이 처리될 시간을 두고 그립니다.
  let pointerTimer = null;
  function pointerReleased(delay) {
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(() => {
      state.pointerDown = false;
      if (state.renderPending) safeRender();
    }, delay);
  }
  document.addEventListener('pointerdown', () => {
    state.pointerDown = true;
    pointerReleased(5000); // 손 뗀 신호를 못 받는 경우를 대비한 안전장치
  }, true);
  document.addEventListener('pointerup', () => pointerReleased(350), true);
  document.addEventListener('pointercancel', () => pointerReleased(350), true);

  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
  sheet.addEventListener('close', () => {
    state.sheetCtx = null;
    sheet.innerHTML = '';
    if (state.renderPending) safeRender();
  });

  // 폴드를 접고 펼 때 한 칸 ↔ 두 칸 화면을 바꿉니다.
  wideMq.addEventListener('change', () => render());

  // 다시 화면에 돌아오면 구글에서 새로 불러옵니다 (다른 앱에서 고친 내용 반영).
  // 토큰이 곧 끝나면 입력 중이 아닐 때 미리 새로 받습니다.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (refreshTokenIfNeeded(10 * 60 * 1000)) return;
    if (todayNow() !== state.today || Date.now() - state.syncedAt > 60 * 1000) loadAll();
  });
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (refreshTokenIfNeeded(3 * 60 * 1000)) return;
    if (Date.now() - state.syncedAt > 5 * 60 * 1000) loadAll();
  }, 60 * 1000);

  // 폰의 뒤로 가기: 남겨 둔 기록에 맞춰 할 일 상세를 열고 닫음
  window.addEventListener('popstate', (e) => {
    const id = (e.state && e.state.task) || '';
    if (isWide()) return;
    state.selTaskId = id && findTask(id) ? id : '';
    state.memoEdit = false;
    render();
  });

  /* ================= 구글 연결 ================= */

  /** 입력 중이거나 창이 열려 있으면 화면을 떠나지 않음 */
  function safeToLeave() {
    const a = document.activeElement;
    const typing = a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && ['checkbox', 'date'].indexOf(a.type) < 0));
    return !typing && !sheet.open && !confirmDlg.open && state.inflight === 0;
  }

  /** 구글에 다녀오는 동안 화면 상태를 기억 (돌아오면 그대로 이어서) */
  function saveResume() {
    try {
      localStorage.setItem('ws.resume', JSON.stringify({
        at: Date.now(), view: state.view, selTaskId: state.selTaskId, selDate: state.selDate, month: state.month,
        drafts: state.drafts, memoEdit: state.memoEdit, memoEditBase: state.memoEditBase, showDone: state.showDone,
      }));
    } catch (e) { /* 무시 */ }
  }
  function restoreResume() {
    let r = null;
    try { r = JSON.parse(localStorage.getItem('ws.resume') || 'null'); localStorage.removeItem('ws.resume'); } catch (e) { r = null; }
    if (!r || Date.now() - r.at > 15 * 60 * 1000) return;
    if (VIEWS.indexOf(r.view) >= 0) state.view = r.view;
    state.selTaskId = r.selTaskId || '';
    if (r.selDate) state.selDate = r.selDate;
    if (r.month) state.month = r.month;
    state.drafts = r.drafts || {};
    state.memoEdit = !!r.memoEdit;
    state.memoEditBase = r.memoEditBase || '';
    state.showDone = !!r.showDone;
  }

  /** 연결 버튼: 구글 화면으로 이동 (switchAccount: 다른 계정 고르기, 권한이 빠졌으면 권한 화면을 다시 띄움) */
  function connect(switchAccount) {
    closeSheet();
    saveResume();
    try {
      Auth.signIn({ switchAccount: switchAccount, consent: state.scopeMissing });
    } catch (e) {
      toast(e.message, true);
    }
  }

  /** 토큰이 없거나 만료됨: 가능하면 화면 없이 조용히 새로 받고, 아니면 연결 버튼을 보여 줌 */
  function needAuth() {
    Auth.clearToken();
    if (Auth.canTrySilent() && safeToLeave()) {
      saveResume();
      try { Auth.signIn({ silent: true }); return; } catch (e) { /* 아래로 */ }
    }
    if (!state.needAuth) {
      state.needAuth = true;
      safeRender();
    }
  }

  /** 토큰이 within(ms) 안에 끝나면 미리 새로 받음. 화면을 떠났으면 true */
  function refreshTokenIfNeeded(within) {
    if (!Auth.token() || Auth.msLeft() > within || !Auth.canTrySilent() || !safeToLeave()) return false;
    saveResume();
    try { Auth.signIn({ silent: true }); return true; } catch (e) { return false; }
  }

  async function signOutAction() {
    if (!(await confirmBox('이 기기에서 구글 연결을 끊을까요? 구글 캘린더와 Tasks의 기록은 그대로 남습니다.', '연결 끊기'))) return;
    closeSheet();
    Auth.signOut();
    try { ['ws.cache', 'ws.resume', 'ws.listId'].forEach((k) => localStorage.removeItem(k)); } catch (e) { /* 무시 */ }
    state.loaded = false;
    state.tasks = [];
    state.events = {};
    state.calendars = [];
    state.tasklists = [];
    state.drafts = {};
    state.needAuth = true;
    render();
  }

  window.GoogleApi.config.getToken = () => Auth.token();
  window.GoogleApi.config.onUnauthorized = () => needAuth();
  window.GoogleApi.config.onScopeMissing = () => {
    if (!state.scopeMissing) { state.scopeMissing = true; safeRender(); }
  };

  // 구글 화면에서 뒤로 가기로 돌아오면 크롬이 떠나기 전 화면을 메모리째 되살림 → 지금 상태에 맞춤
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    state.scopeMissing = Auth.missingScopes().length > 0;
    if (Auth.token() && !state.scopeMissing) {
      state.needAuth = false;
      render();
      loadAll();
    } else {
      if (!Auth.token()) state.needAuth = true;
      render();
    }
  });

  /* ---------- 시작 ---------- */
  const back = Auth.handleRedirect();
  restoreResume();
  if (back && back.error) {
    if (back.silent) Auth.markSilentFailed();
    else if (back.error !== 'access_denied') toast('구글 연결에 실패했습니다 (' + back.error + ')', true);
  }
  if (Auth.missingScopes().length) state.scopeMissing = true;
  cacheLoad();
  if (state.scopeMissing) {
    render(); // 권한 화면부터 다시 받아야 함 (빠진 권한으로는 부르지 않음)
  } else if (Auth.token()) {
    render();
    loadAll();
  } else if (Auth.canTrySilent()) {
    render();
    saveResume();
    try { Auth.signIn({ silent: true }); } catch (e) { state.needAuth = true; render(); }
  } else {
    state.needAuth = true;
    render();
  }

  // 설치형 앱: 화면 파일을 저장해 두어 인터넷이 끊겨도 열림 (https에서만)
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('서비스 워커 등록 실패', e));
  }
})();
