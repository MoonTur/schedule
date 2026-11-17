/*
 * 구글 캘린더·Google Tasks REST API 호출 (브라우저에서 직접).
 * 화면(app.js)은 이 함수들만 부르고, 돌려받는 모양(일정·할 일 객체)도 여기서 정합니다.
 * 모든 기록은 구글에 바로 저장되며, 이 앱은 따로 데이터를 보관하지 않습니다.
 */
(function (root) {
  'use strict';

  const CAL = 'https://www.googleapis.com/calendar/v3';
  const TASKS = 'https://tasks.googleapis.com/tasks/v1';
  const NOTES_LIMIT = 8192;
  const DESC_MAX = 4000;        // 화면에 싣는 일정 설명 길이
  const DONE_DAYS = 365;        // 완료한 할 일은 최근 1년만 받음
  const MEMO_HEADER = /^\[\d{4}-\d{2}-\d{2}\][ \t]?/;
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

  /** 구글 API 오류 (status: HTTP 상태) */
  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  const config = {
    getToken: () => '',
    onUnauthorized: () => {},
    onScopeMissing: () => {},   // 구글 권한 화면에서 일부 항목을 빼고 허용한 경우
  };

  /** 403 중 '권한 범위 부족' (사용자가 권한 일부를 허용하지 않음) */
  function isScopeError(status, data) {
    if (status !== 403 || !data || !data.error) return false;
    const reasons = [];
    (data.error.errors || []).forEach((x) => { if (x && x.reason) reasons.push(x.reason); });
    (data.error.details || []).forEach((x) => { if (x && x.reason) reasons.push(x.reason); });
    return /insufficient authentication scopes/i.test(data.error.message || '') ||
      reasons.some((r) => /insufficientPermissions|SCOPE_INSUFFICIENT/i.test(r));
  }
  /** 이 오류는 캘린더 하나만의 문제가 아니므로 삼키지 말고 위로 올림 */
  const mustRaise = (e) => e && (e.status === 401 || e.code === 'scope');

  /* ================= HTTP ================= */

  async function req(method, url, opts) {
    opts = opts || {};
    const u = new URL(url);
    const q = opts.query || {};
    Object.keys(q).forEach((k) => {
      const v = q[k];
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    });
    const token = config.getToken();
    if (!token) {
      const err = new ApiError(401, '구글 계정 연결이 필요합니다.');
      config.onUnauthorized(err);
      throw err;
    }
    const headers = { Authorization: 'Bearer ' + token };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(u.toString(), { method: method, headers: headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    } catch (e) {
      throw new ApiError(0, '인터넷에 연결되어 있지 않습니다.');
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
    }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || res.statusText || ('HTTP ' + res.status);
      const scope = isScopeError(res.status, data);
      const err = new ApiError(res.status,
        res.status === 401 ? '구글 연결이 만료되었습니다.'
          : scope ? '구글 권한이 일부 빠져 있습니다. 다시 연결해 세 항목을 모두 허용해 주세요.'
            : msg);
      if (scope) err.code = 'scope';
      if (res.status === 401) config.onUnauthorized(err);
      if (scope) config.onScopeMissing(err);
      throw err;
    }
    return data;
  }

  /** 여러 쪽으로 나뉜 목록을 모두 받음 */
  async function listAll(url, query) {
    const out = [];
    let pageToken;
    do {
      const res = await req('GET', url, { query: Object.assign({}, query, { pageToken: pageToken }) });
      (res && res.items ? res.items : []).forEach((x) => out.push(x));
      pageToken = res && res.nextPageToken;
    } while (pageToken);
    return out;
  }

  const enc = encodeURIComponent;

  /* ================= 처음 불러오기 ================= */

  async function getBootstrap(startIso, endIso, listId) {
    const [calendars, tasklists] = await Promise.all([listCalendars(), listTasklists()]);
    const list = tasklists.filter((l) => l.id === listId)[0] || tasklists[0] || null;
    const [tasks, events] = await Promise.all([
      list ? listTasks(list.id) : Promise.resolve([]),
      listEvents(calendars, startIso, endIso),
    ]);
    return { calendars: calendars, tasklists: tasklists, listId: list ? list.id : '', tasks: tasks, events: events };
  }

  /* ================= 구글 캘린더 ================= */

  async function getEvents(startIso, endIso) {
    return listEvents(await listCalendars(), startIso, endIso);
  }

  async function listCalendars() {
    const items = await listAll(CAL + '/users/me/calendarList', { maxResults: 250 });
    const out = items.filter((c) => !c.hidden && !c.deleted).map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      color: c.backgroundColor || '#2563EB',
      primary: c.primary === true,
      // 구글 캘린더에서 체크해 둔(보이는) 캘린더만 화면에 씁니다.
      selected: c.selected === true || c.primary === true,
      writable: c.accessRole === 'owner' || c.accessRole === 'writer',
    }));
    out.sort((a, b) => (Number(b.primary) - Number(a.primary)) || a.name.localeCompare(b.name));
    return out;
  }

  let colorCache = null;
  async function eventColors() {
    if (colorCache) return colorCache;
    try {
      const res = await req('GET', CAL + '/colors');
      const map = {};
      Object.keys((res && res.event) || {}).forEach((k) => { map[k] = res.event[k].background; });
      colorCache = map;
    } catch (e) {
      if (mustRaise(e)) throw e;
      colorCache = {};
    }
    return colorCache;
  }

  async function listEvents(calendars, startIso, endIso) {
    checkIso(startIso);
    checkIso(endIso);
    const palette = await eventColors();
    const lists = await Promise.all(calendars.filter((c) => c.selected).map(async (cal) => {
      try {
        const items = await listAll(CAL + '/calendars/' + enc(cal.id) + '/events', {
          timeMin: startIso, timeMax: endIso, singleEvents: 'true', orderBy: 'startTime', maxResults: 2500,
        });
        return items.filter((ev) => ev.status !== 'cancelled').map((ev) => toEvent(ev, cal, palette));
      } catch (e) {
        if (mustRaise(e)) throw e;
        console.warn('일정을 읽지 못한 캘린더: ' + cal.id + ' — ' + e.message);
        return [];
      }
    }));
    return [].concat.apply([], lists);
  }

  /**
   * 이 앱에서 고치면 잃는 것이 있는 설명인가: 너무 길거나(화면에는 앞부분만 실음),
   * 줄바꿈과 '주소가 그대로 보이는 링크' 말고 다른 서식(굵게, 목록, 글자와 주소가 다른 링크 등)이 있음.
   * 이런 설명은 수정 창에서 고칠 수 없게 하고 구글 캘린더에서 고치도록 안내합니다.
   */
  function descLocked(desc) {
    const s = String(desc || '');
    if (s.length > DESC_MAX) return true;
    const unesc = (x) => x.replace(/&amp;/g, '&').trim();
    const rest = s.replace(/<br\s*\/?>/gi, '')
      .replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, (m, href, text) => (unesc(href) === unesc(text) ? '' : m));
    return /<\/?[a-z][^>]*>/i.test(rest);
  }

  function toEvent(ev, cal, palette) {
    const allDay = !!(ev.start && ev.start.date);
    return {
      id: ev.id,
      calendarId: cal.id,
      title: ev.summary || '(제목 없음)',
      allDay: allDay,
      start: allDay ? ev.start.date : ev.start.dateTime,
      end: allDay ? ev.end.date : ev.end.dateTime,
      location: ev.location || '',
      description: String(ev.description || '').slice(0, DESC_MAX),
      descLocked: descLocked(ev.description),
      recurring: !!ev.recurringEventId,
      link: ev.htmlLink || '',
      color: (ev.colorId && palette[ev.colorId]) || cal.color,
      editable: cal.writable,
    };
  }

  /**
   * 일정을 만들거나 고칩니다.
   * input: { id?, calendarId, originalCalendarId?, title, date, endDate?, allDay,
   *          startTime?, endTime?, location?, description?, timeZone? }
   * description은 바꿨을 때만 보냅니다 (구글 캘린더의 서식 있는 설명을 지키기 위해).
   */
  async function saveEvent(input) {
    input = input || {};
    const title = String(input.title || '').trim();
    if (!title) throw new ApiError(400, '제목을 입력해 주세요.');
    const calendarId = String(input.calendarId || '');
    if (!calendarId) throw new ApiError(400, '캘린더를 골라 주세요.');
    const date = checkYmd(input.date);
    const endDate = input.endDate ? checkYmd(input.endDate) : date;
    if (endDate < date) throw new ApiError(400, '끝나는 날이 시작하는 날보다 앞설 수 없습니다.');
    const tz = String(input.timeZone || 'Asia/Seoul');

    let start;
    let end;
    if (input.allDay) {
      start = { date: date };
      end = { date: addDaysYmd(endDate, 1) };
    } else {
      if (!HM.test(input.startTime || '') || !HM.test(input.endTime || '')) {
        throw new ApiError(400, '시작 시간과 끝 시간을 입력해 주세요.');
      }
      start = { dateTime: date + 'T' + input.startTime + ':00', timeZone: tz };
      end = { dateTime: endDate + 'T' + input.endTime + ':00', timeZone: tz };
      if (end.dateTime <= start.dateTime) throw new ApiError(400, '끝나는 시간이 시작 시간보다 늦어야 합니다.');
    }

    let ev;
    if (input.id) {
      const eventId = String(input.id);
      const fromCal = String(input.originalCalendarId || calendarId);
      if (fromCal !== calendarId) {
        await req('POST', CAL + '/calendars/' + enc(fromCal) + '/events/' + enc(eventId) + '/move', { query: { destination: calendarId } });
      }
      ev = await req('GET', CAL + '/calendars/' + enc(calendarId) + '/events/' + enc(eventId));
      ev.summary = title;
      ev.location = String(input.location || '');
      if (typeof input.description === 'string') ev.description = input.description;
      ev.start = start;
      ev.end = end;
      ev = await req('PUT', CAL + '/calendars/' + enc(calendarId) + '/events/' + enc(eventId), { body: ev });
    } else {
      const resource = { summary: title, start: start, end: end };
      if (input.location) resource.location = String(input.location);
      if (input.description) resource.description = String(input.description);
      ev = await req('POST', CAL + '/calendars/' + enc(calendarId) + '/events', { body: resource });
    }
    return { id: ev.id, calendarId: calendarId };
  }

  /** 반복 일정이면 그 날짜의 일정 하나만 지워집니다. */
  async function deleteEvent(calendarId, eventId) {
    await req('DELETE', CAL + '/calendars/' + enc(checkId(calendarId)) + '/events/' + enc(checkId(eventId)));
    return true;
  }

  /* ================= Google Tasks ================= */

  async function listTasklists() {
    const items = await listAll(TASKS + '/users/@me/lists', { maxResults: 100 });
    return items.map((l) => ({ id: l.id, title: l.title || '(이름 없음)' }));
  }

  async function getTasks(listId) {
    return listTasks(checkId(listId));
  }

  /**
   * 남은 할 일은 모두, 완료한 할 일은 최근 1년만 받습니다 (완료한 것이 쌓여도 동기화가 느려지지 않게).
   * 휴대폰 Tasks 앱에서 완료한 할 일은 hidden으로 표시되므로 showHidden도 켭니다.
   * 두 요청에 같은 할 일이 겹쳐 와도 한 번만 씁니다.
   */
  async function listTasks(listId) {
    const url = TASKS + '/lists/' + enc(listId) + '/tasks';
    const since = new Date(Date.now() - DONE_DAYS * 86400000).toISOString();
    const lists = await Promise.all([
      listAll(url, { showCompleted: 'false', maxResults: 100 }),
      listAll(url, { showCompleted: 'true', showHidden: 'true', completedMin: since, maxResults: 100 }),
    ]);
    const seen = {};
    return lists[0].concat(lists[1]).filter((t) => {
      if (t.deleted || seen[t.id]) return false;
      seen[t.id] = true;
      return true;
    }).map(toTask);
  }

  function toTask(t) {
    return {
      id: t.id,
      title: t.title || '',
      notes: t.notes || '',
      due: t.due ? String(t.due).slice(0, 10) : '',
      done: t.status === 'completed',
      completed: t.completed || '',
      parent: t.parent || '',
      position: t.position || '',
      link: t.webViewLink || '',
    };
  }

  const taskUrl = (listId, taskId) => TASKS + '/lists/' + enc(listId) + '/tasks/' + enc(taskId);

  /** 할 일 만들기. input: { title, due?, notes?, parent?, previous? } */
  async function createTask(listId, input) {
    listId = checkId(listId);
    input = input || {};
    const title = String(input.title || '').trim();
    if (!title) throw new ApiError(400, '할 일 제목을 입력해 주세요.');
    const body = { title: title };
    if (input.due) body.due = dueIso(input.due);
    if (input.notes) body.notes = checkNotes(normNl(input.notes));
    const query = {};
    if (input.parent) query.parent = checkId(input.parent);
    if (input.previous) query.previous = checkId(input.previous);
    return toTask(await req('POST', TASKS + '/lists/' + enc(listId) + '/tasks', { query: query, body: body }));
  }

  /**
   * 제목·마감일·완료 여부 바꾸기. patch: { title?, due? ('' 또는 null이면 마감일 지움), done? }
   * 바꾸는 칸만 보내므로(PATCH), 다른 앱에서 고친 메모 등은 그대로 남습니다.
   */
  async function updateTask(listId, taskId, patch) {
    listId = checkId(listId);
    taskId = checkId(taskId);
    patch = patch || {};
    const body = {};
    if (patch.title !== undefined) {
      const title = String(patch.title || '').trim();
      if (!title) throw new ApiError(400, '제목은 비워 둘 수 없습니다.');
      body.title = title;
    }
    if (patch.due !== undefined) body.due = patch.due ? dueIso(patch.due) : null;
    if (patch.done !== undefined) {
      if (patch.done) body.status = 'completed';
      else { body.status = 'needsAction'; body.completed = null; }
    }
    return toTask(await req('PATCH', taskUrl(listId, taskId), { body: body }));
  }

  /** 오늘 날짜를 붙여 메모 한 줄을 넣습니다. 구글에 있는 최신 메모에 더합니다. */
  async function appendMemo(listId, taskId, date, text) {
    listId = checkId(listId);
    taskId = checkId(taskId);
    const body = normNl(text).trim();
    if (!body) throw new ApiError(400, '메모 내용을 입력해 주세요.');
    const t = await req('GET', taskUrl(listId, taskId));
    const notes = checkNotes(insertMemoEntry(t.notes || '', checkYmd(date), body));
    return toTask(await req('PATCH', taskUrl(listId, taskId), { body: { notes: notes } }));
  }

  /**
   * 메모 칸 전체를 바꿉니다 (메모 지우기, 전체 편집).
   * expected: 화면이 알고 있던 메모. 그 사이 다른 곳에서 바뀌었으면 덮어쓰지 않고 오류를 냅니다.
   */
  async function replaceNotes(listId, taskId, expected, notes) {
    listId = checkId(listId);
    taskId = checkId(taskId);
    const t = await req('GET', taskUrl(listId, taskId));
    if (normNl(t.notes).replace(/\s+$/, '') !== normNl(expected).replace(/\s+$/, '')) {
      throw new ApiError(409, '다른 곳에서 메모가 바뀌었습니다. 새로고침한 뒤 다시 해 주세요.');
    }
    const next = normNl(notes).replace(/\s+$/, '');
    return toTask(await req('PATCH', taskUrl(listId, taskId), { body: { notes: next ? checkNotes(next) : null } }));
  }

  /** 할 일 지우기. childIds를 주면 하위 할 일부터 지웁니다. */
  async function deleteTask(listId, taskId, childIds) {
    listId = checkId(listId);
    await Promise.all((childIds || []).map((id) => req('DELETE', taskUrl(listId, checkId(id))).catch((e) => {
      if (mustRaise(e)) throw e;
      console.warn('하위 할 일 삭제 실패: ' + id + ' — ' + e.message);
    })));
    await req('DELETE', taskUrl(listId, checkId(taskId)));
    return true;
  }

  /* ================= 메모 형식 (logic.js의 insertMemoEntry와 같은 규칙) ================= */

  function insertMemoEntry(notes, date, text) {
    const entry = '[' + date + '] ' + text;
    const current = normNl(notes);
    if (!current.trim()) return entry;
    const lines = current.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (MEMO_HEADER.test(lines[i])) {
        lines.splice.apply(lines, [i, 0].concat(entry.split('\n')));
        return lines.join('\n');
      }
    }
    return current.replace(/\s+$/, '') + '\n' + entry;
  }

  /* ================= 입력 확인 ================= */

  function checkId(id) {
    const s = String(id || '');
    if (!s || s.length > 1024) throw new ApiError(400, '잘못된 요청입니다.');
    return s;
  }
  function checkYmd(s) {
    const v = String(s || '');
    if (!YMD.test(v)) throw new ApiError(400, '날짜 형식이 올바르지 않습니다.');
    return v;
  }
  function checkIso(s) {
    if (typeof s !== 'string' || isNaN(new Date(s).getTime())) throw new ApiError(400, '기간 형식이 올바르지 않습니다.');
    return s;
  }
  function checkNotes(s) {
    if (s.length > NOTES_LIMIT) {
      throw new ApiError(400, '메모가 8,192자를 넘습니다(지금 ' + s.length + '자). 오래된 메모를 정리해 주세요.');
    }
    return s;
  }
  function dueIso(ymd) { return checkYmd(ymd) + 'T00:00:00.000Z'; }
  function normNl(s) { return String(s || '').replace(/\r\n?/g, '\n'); }
  function addDaysYmd(ymd, n) {
    const p = ymd.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }

  root.GoogleApi = {
    config: config,
    ApiError: ApiError,
    getBootstrap: getBootstrap,
    getEvents: getEvents,
    saveEvent: saveEvent,
    deleteEvent: deleteEvent,
    getTasks: getTasks,
    createTask: createTask,
    updateTask: updateTask,
    appendMemo: appendMemo,
    replaceNotes: replaceNotes,
    deleteTask: deleteTask,
    _insertMemoEntry: insertMemoEntry,
    _descLocked: descLocked,
  };
})(typeof window !== 'undefined' ? window : globalThis);
