/**
 * 업무·일정 — 구글 캘린더와 Google Tasks를 한 화면에서 보고 고치는 웹앱 (서버 쪽)
 *
 * - 일정: Calendar API v3 고급 서비스 (전역 이름 Calendar)
 * - 할 일: Tasks API v1 고급 서비스 (전역 이름 Tasks)
 * - 모든 기록은 구글에 바로 저장됩니다. 이 앱은 따로 데이터를 보관하지 않습니다.
 * - 이름이 _ 로 끝나는 함수는 내부용이라 브라우저(google.script.run)에서 부를 수 없습니다.
 */

const NOTES_LIMIT = 8192;
const MEMO_HEADER = /^\[\d{4}-\d{2}-\d{2}\][ \t]?/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ================= 웹앱 진입점 ================= */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('업무·일정')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ================= 처음 불러오기 ================= */

/**
 * 첫 화면에 필요한 것을 한 번에 돌려줍니다.
 * @param {string} startIso 일정 기간 시작 (ISO)
 * @param {string} endIso   일정 기간 끝 (ISO, 포함 안 함)
 * @param {string} listId   보고 있던 할 일 목록 ID (없으면 기본 목록 '내 할 일')
 */
function getBootstrap(startIso, endIso, listId) {
  const calendars = listCalendars_();
  const tasklists = listTasklists_();
  const list = tasklists.filter((l) => l.id === listId)[0] || tasklists[0] || null;
  return {
    calendars: calendars,
    tasklists: tasklists,
    listId: list ? list.id : '',
    tasks: list ? listTasks_(list.id) : [],
    events: listEvents_(calendars, startIso, endIso),
  };
}

/* ================= 구글 캘린더 ================= */

function getEvents(startIso, endIso) {
  return listEvents_(listCalendars_(), startIso, endIso);
}

/**
 * 일정을 만들거나 고칩니다.
 * input: { id?, calendarId, originalCalendarId?, title, date, endDate?, allDay,
 *          startTime?, endTime?, location?, description?, timeZone? }
 * description은 바꿨을 때만 보냅니다 (구글 캘린더의 서식 있는 설명을 지키기 위해).
 */
function saveEvent(input) {
  input = input || {};
  const title = String(input.title || '').trim();
  if (!title) throw new Error('제목을 입력해 주세요.');
  const calendarId = String(input.calendarId || '');
  if (!calendarId) throw new Error('캘린더를 골라 주세요.');
  const date = checkYmd_(input.date);
  const endDate = input.endDate ? checkYmd_(input.endDate) : date;
  if (endDate < date) throw new Error('끝나는 날이 시작하는 날보다 앞설 수 없습니다.');
  const tz = String(input.timeZone || Session.getScriptTimeZone());

  let start;
  let end;
  if (input.allDay) {
    start = { date: date };
    end = { date: addDaysYmd_(endDate, 1) };
  } else {
    if (!HM.test(input.startTime || '') || !HM.test(input.endTime || '')) {
      throw new Error('시작 시간과 끝 시간을 입력해 주세요.');
    }
    start = { dateTime: date + 'T' + input.startTime + ':00', timeZone: tz };
    end = { dateTime: endDate + 'T' + input.endTime + ':00', timeZone: tz };
    if (end.dateTime <= start.dateTime) throw new Error('끝나는 시간이 시작 시간보다 늦어야 합니다.');
  }

  let ev;
  if (input.id) {
    const eventId = String(input.id);
    const fromCal = String(input.originalCalendarId || calendarId);
    if (fromCal !== calendarId) Calendar.Events.move(fromCal, eventId, calendarId);
    ev = Calendar.Events.get(calendarId, eventId);
    ev.summary = title;
    ev.location = String(input.location || '');
    if (typeof input.description === 'string') ev.description = input.description;
    ev.start = start;
    ev.end = end;
    ev = Calendar.Events.update(ev, calendarId, eventId);
  } else {
    const resource = { summary: title, start: start, end: end };
    if (input.location) resource.location = String(input.location);
    if (input.description) resource.description = String(input.description);
    ev = Calendar.Events.insert(resource, calendarId);
  }
  return { id: ev.id, calendarId: calendarId };
}

/** 반복 일정이면 그 날짜의 일정 하나만 지워집니다. */
function deleteEvent(calendarId, eventId) {
  Calendar.Events.remove(checkId_(calendarId), checkId_(eventId));
  return true;
}

function listCalendars_() {
  const out = [];
  let pageToken;
  do {
    const res = Calendar.CalendarList.list({ maxResults: 250, pageToken: pageToken });
    (res.items || []).forEach((c) => {
      if (c.hidden || c.deleted) return;
      out.push({
        id: c.id,
        name: c.summaryOverride || c.summary || c.id,
        color: c.backgroundColor || '#2563EB',
        primary: c.primary === true,
        // 구글 캘린더에서 체크해 둔(보이는) 캘린더만 화면에 씁니다.
        selected: c.selected === true || c.primary === true,
        writable: c.accessRole === 'owner' || c.accessRole === 'writer',
      });
    });
    pageToken = res.nextPageToken;
  } while (pageToken);
  out.sort((a, b) => (Number(b.primary) - Number(a.primary)) || a.name.localeCompare(b.name));
  return out;
}

function listEvents_(calendars, startIso, endIso) {
  checkIso_(startIso);
  checkIso_(endIso);
  const palette = eventColors_();
  const out = [];
  calendars.filter((c) => c.selected).forEach((cal) => {
    let pageToken;
    do {
      let res;
      try {
        res = Calendar.Events.list(cal.id, {
          timeMin: startIso,
          timeMax: endIso,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 2500,
          pageToken: pageToken,
        });
      } catch (err) {
        console.warn('일정을 읽지 못한 캘린더: ' + cal.id + ' — ' + err.message);
        return;
      }
      (res.items || []).forEach((ev) => {
        if (ev.status !== 'cancelled') out.push(toEvent_(ev, cal, palette));
      });
      pageToken = res.nextPageToken;
    } while (pageToken);
  });
  return out;
}

function toEvent_(ev, cal, palette) {
  const allDay = !!(ev.start && ev.start.date);
  return {
    id: ev.id,
    calendarId: cal.id,
    title: ev.summary || '(제목 없음)',
    allDay: allDay,
    start: allDay ? ev.start.date : ev.start.dateTime,
    end: allDay ? ev.end.date : ev.end.dateTime,
    location: ev.location || '',
    description: String(ev.description || '').slice(0, 4000),
    recurring: !!ev.recurringEventId,
    link: ev.htmlLink || '',
    color: (ev.colorId && palette[ev.colorId]) || cal.color,
    editable: cal.writable,
  };
}

/** 일정마다 따로 고른 색 (6시간 캐시) */
function eventColors_() {
  const cache = CacheService.getUserCache();
  const hit = cache.get('eventColors');
  if (hit) return JSON.parse(hit);
  const map = {};
  try {
    const res = Calendar.Colors.get();
    Object.keys(res.event || {}).forEach((k) => { map[k] = res.event[k].background; });
    cache.put('eventColors', JSON.stringify(map), 21600);
  } catch (err) {
    console.warn('색상표를 읽지 못함: ' + err.message);
  }
  return map;
}

/* ================= Google Tasks ================= */

function getTasks(listId) {
  return listTasks_(checkId_(listId));
}

/**
 * 할 일 만들기. input: { title, due?, notes?, parent?, previous? }
 * parent를 주면 하위 할 일, previous를 주면 그 바로 뒤에 들어갑니다.
 */
function createTask(listId, input) {
  listId = checkId_(listId);
  input = input || {};
  const title = String(input.title || '').trim();
  if (!title) throw new Error('할 일 제목을 입력해 주세요.');
  const resource = { title: title };
  if (input.due) resource.due = dueIso_(input.due);
  if (input.notes) resource.notes = checkNotes_(normNl_(input.notes));
  const opts = {};
  if (input.parent) opts.parent = checkId_(input.parent);
  if (input.previous) opts.previous = checkId_(input.previous);
  return toTask_(Tasks.Tasks.insert(resource, listId, opts));
}

/**
 * 제목·마감일·완료 여부 바꾸기. patch: { title?, due? ('' 또는 null이면 마감일 지움), done? }
 * 구글에 있는 최신 상태를 읽은 뒤 바꾸므로, 다른 앱에서 고친 메모는 그대로 남습니다.
 */
function updateTask(listId, taskId, patch) {
  listId = checkId_(listId);
  taskId = checkId_(taskId);
  patch = patch || {};
  const t = Tasks.Tasks.get(listId, taskId);
  if (patch.title !== undefined) {
    const title = String(patch.title || '').trim();
    if (!title) throw new Error('제목은 비워 둘 수 없습니다.');
    t.title = title;
  }
  const clearDue = patch.due !== undefined && !patch.due;
  if (patch.due !== undefined) {
    if (patch.due) t.due = dueIso_(patch.due);
    else delete t.due;
  }
  if (patch.done !== undefined) {
    if (patch.done) {
      t.status = 'completed';
    } else {
      t.status = 'needsAction';
      delete t.completed;
    }
  }
  let res = Tasks.Tasks.update(t, listId, taskId);
  // 마감일이 남아 있으면 한 번 더 지워 봅니다.
  if (clearDue && res.due) res = Tasks.Tasks.patch({ due: null }, listId, taskId);
  return toTask_(res);
}

/** 오늘 날짜를 붙여 메모 한 줄을 넣습니다. 구글에 있는 최신 메모에 더하므로 다른 곳에서 쓴 메모가 지워지지 않습니다. */
function appendMemo(listId, taskId, date, text) {
  listId = checkId_(listId);
  taskId = checkId_(taskId);
  const body = normNl_(text).trim();
  if (!body) throw new Error('메모 내용을 입력해 주세요.');
  const t = Tasks.Tasks.get(listId, taskId);
  t.notes = checkNotes_(insertMemoEntry_(t.notes || '', checkYmd_(date), body));
  return toTask_(Tasks.Tasks.update(t, listId, taskId));
}

/**
 * 메모 칸 전체를 바꿉니다 (메모 지우기, 전체 편집).
 * expected: 화면이 알고 있던 메모. 그 사이 다른 곳에서 바뀌었으면 덮어쓰지 않고 오류를 냅니다.
 */
function replaceNotes(listId, taskId, expected, notes) {
  listId = checkId_(listId);
  taskId = checkId_(taskId);
  const t = Tasks.Tasks.get(listId, taskId);
  if (normNl_(t.notes).replace(/\s+$/, '') !== normNl_(expected).replace(/\s+$/, '')) {
    throw new Error('다른 곳에서 메모가 바뀌었습니다. 새로고침한 뒤 다시 해 주세요.');
  }
  const next = normNl_(notes).replace(/\s+$/, '');
  if (next) t.notes = checkNotes_(next);
  else delete t.notes;
  let res = Tasks.Tasks.update(t, listId, taskId);
  if (!next && res.notes) res = Tasks.Tasks.patch({ notes: '' }, listId, taskId);
  return toTask_(res);
}

/** 할 일 지우기. childIds를 주면 하위 할 일부터 지웁니다. */
function deleteTask(listId, taskId, childIds) {
  listId = checkId_(listId);
  (childIds || []).forEach((id) => {
    try {
      Tasks.Tasks.remove(listId, checkId_(id));
    } catch (err) {
      console.warn('하위 할 일 삭제 실패: ' + id + ' — ' + err.message);
    }
  });
  Tasks.Tasks.remove(listId, checkId_(taskId));
  return true;
}

function listTasklists_() {
  const out = [];
  let pageToken;
  do {
    const res = Tasks.Tasklists.list({ maxResults: 100, pageToken: pageToken });
    (res.items || []).forEach((l) => out.push({ id: l.id, title: l.title || '(이름 없음)' }));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

function listTasks_(listId) {
  const out = [];
  let pageToken;
  do {
    // 휴대폰 Tasks 앱에서 완료한 할 일은 hidden으로 표시되므로 showHidden도 켭니다.
    const res = Tasks.Tasks.list(listId, {
      showCompleted: true,
      showHidden: true,
      maxResults: 100,
      pageToken: pageToken,
    });
    (res.items || []).forEach((t) => { if (!t.deleted) out.push(toTask_(t)); });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

function toTask_(t) {
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

/* ================= 메모 형식 (Logic.html의 insertMemoEntry와 같은 규칙) ================= */

function insertMemoEntry_(notes, date, text) {
  const entry = '[' + date + '] ' + text;
  const current = normNl_(notes);
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

function checkId_(id) {
  const s = String(id || '');
  if (!s || s.length > 1024) throw new Error('잘못된 요청입니다.');
  return s;
}

function checkYmd_(s) {
  const v = String(s || '');
  if (!YMD.test(v)) throw new Error('날짜 형식이 올바르지 않습니다.');
  return v;
}

function checkIso_(s) {
  if (typeof s !== 'string' || isNaN(new Date(s).getTime())) throw new Error('기간 형식이 올바르지 않습니다.');
  return s;
}

function checkNotes_(s) {
  if (s.length > NOTES_LIMIT) {
    throw new Error('메모가 8,192자를 넘습니다(지금 ' + s.length + '자). 오래된 메모를 정리해 주세요.');
  }
  return s;
}

function dueIso_(ymd) {
  return checkYmd_(ymd) + 'T00:00:00.000Z';
}

function normNl_(s) {
  return String(s || '').replace(/\r\n?/g, '\n');
}

function addDaysYmd_(ymd, n) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}
