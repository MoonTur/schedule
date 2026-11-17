/*
 * 개발용 가짜 구글 캘린더·Google Tasks — 실제 계정 없이 앱을 시험하기 위한 것입니다.
 * 구글 REST API의 동작(목록·쪽 나누기·만들기·고치기·지우기·옮기기)을 메모리에서 흉내 내고,
 * 시안과 같은 예시 데이터를 오늘 날짜 기준으로 채웁니다.
 * dev/fake-fetch.js가 실제 구글 주소로 가는 요청을 여기로 보냅니다. (배포되는 파일이 아닙니다.)
 */
(function (root) {
  'use strict';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function localOffset(dateStr) {
    const off = -parseYmd(dateStr).getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
  }
  function at(day, hm) { return day + 'T' + hm + ':00' + localOffset(day); }
  function toMs(t) {
    if (t.date) return new Date(t.date + 'T00:00:00' + localOffset(t.date)).getTime();
    const s = t.dateTime;
    if (/[zZ]|[+-]\d\d:\d\d$/.test(s)) return new Date(s).getTime();
    return new Date(s + localOffset(s.slice(0, 10))).getTime();
  }
  function page(items, opts) {
    const size = (opts && opts.maxResults) || 100;
    const start = opts && opts.pageToken ? +opts.pageToken : 0;
    const res = { items: items.slice(start, start + size) };
    if (start + size < items.length) res.nextPageToken = String(start + size);
    return res;
  }
  function notFound(what) { const e = new Error('Not Found: ' + what); e.code = 404; return e; }

  function makeFakeGoogle(opts) {
    opts = opts || {};
    const T = opts.today || ymd(new Date());
    let seq = 1000;
    const nowIso = () => new Date().toISOString();
    const calls = [];

    /* ---------- 캘린더 ---------- */
    const calendars = [
      { id: 'me@example.com', summary: 'me@example.com', summaryOverride: '내 캘린더', backgroundColor: '#039BE5', primary: true, accessRole: 'owner', selected: true },
      { id: 'personal@group.calendar.google.com', summary: '개인', backgroundColor: '#33B679', accessRole: 'owner', selected: true },
      { id: 'ko.south_korea#holiday@group.v.calendar.google.com', summary: '대한민국의 휴일', backgroundColor: '#0B8043', accessRole: 'reader', selected: true },
      { id: 'team@group.calendar.google.com', summary: '팀 공유', backgroundColor: '#8E24AA', accessRole: 'writer', selected: false },
    ];
    const events = {};
    calendars.forEach((c) => { events[c.id] = []; });

    function addEvent(calId, ev) {
      ev.id = ev.id || 'e' + (++seq);
      ev.status = ev.status || 'confirmed';
      ev.htmlLink = 'https://www.google.com/calendar/event?eid=' + ev.id;
      events[calId].push(ev);
      return ev;
    }

    /* ---------- 할 일 ---------- */
    const lists = [{ id: 'L1', title: '내 할 일' }, { id: 'L2', title: '개인' }];
    const tasks = { L1: [], L2: [] };
    function addTask(listId, t) {
      t.id = t.id || 't' + (++seq);
      t.status = t.status || 'needsAction';
      t.updated = nowIso();
      t.webViewLink = 'https://tasks.google.com/task/' + t.id;
      tasks[listId].push(t);
      renumber(listId);
      return t;
    }
    function renumber(listId) {
      const counters = {};
      tasks[listId].forEach((t) => {
        const k = t.parent || '';
        counters[k] = (counters[k] || 0) + 1;
        t.position = String(counters[k]).padStart(20, '0');
      });
    }
    const due = (d) => d + 'T00:00:00.000Z';

    if (opts.sample !== false) {
      // 일정 (시안과 같은 예시)
      const dow = parseYmd(T).getDay();
      for (let w = -6; w <= 6; w++) {
        const d = addDays(T, w * 7);
        addEvent('me@example.com', {
          id: 'weekly_' + d.replace(/-/g, ''), recurringEventId: 'weekly', summary: '주간 회의', location: '3층 회의실',
          start: { dateTime: at(d, '10:00') }, end: { dateTime: at(d, '11:00') },
        });
      }
      addEvent('me@example.com', { id: 'e-advice', summary: '자문회의', location: '온라인', description: '<p>자문위원 3명 참석</p><br>자료: 3장 초안', start: { dateTime: at(T, '14:00') }, end: { dateTime: at(T, '15:30') } });
      addEvent('me@example.com', { id: 'e-work', summary: '보고서 3장 작성', colorId: '6', start: { dateTime: at(T, '16:00') }, end: { dateTime: at(T, '18:00') } });
      addEvent('personal@group.calendar.google.com', { id: 'e-dinner', summary: '저녁 약속', start: { dateTime: at(T, '19:00') }, end: { dateTime: at(T, '20:30') } });
      addEvent('me@example.com', { id: 'e-seminar', summary: '세미나 발표', start: { dateTime: at(addDays(T, 3), '15:00') }, end: { dateTime: at(addDays(T, 3), '16:00') } });
      addEvent('me@example.com', { id: 'e-trip', summary: '출장', start: { date: addDays(T, -12) }, end: { date: addDays(T, -10) } });
      addEvent('me@example.com', { id: 'e-workshop', summary: '워크숍', start: { date: addDays(T, 9) }, end: { date: addDays(T, 10) } });
      addEvent('me@example.com', { id: 'e-night', summary: '야간 점검', start: { dateTime: at(addDays(T, 5), '23:00') }, end: { dateTime: at(addDays(T, 6), '01:00') } });
      addEvent('me@example.com', { id: 'e-cancel', summary: '취소된 일정', status: 'cancelled', start: { dateTime: at(T, '08:00') }, end: { dateTime: at(T, '09:00') } });
      addEvent('team@group.calendar.google.com', { id: 'e-hidden', summary: '숨긴 캘린더 일정', start: { dateTime: at(T, '12:00') }, end: { dateTime: at(T, '13:00') } });

      // 할 일 (Google Tasks '내 할 일')
      addTask('L1', { id: 't-receipt', title: '출장비 영수증 제출', due: due(addDays(T, -1)) });
      addTask('L1', { id: 't-reply', title: '자문위원 회신 메일 보내기', due: due(T) });
      addTask('L1', {
        id: 't-seminar', title: '세미나 발표자료', due: due(addDays(T, 3)),
        notes: '[' + addDays(T, -1) + '] 발표 20분 + 질의 10분으로 확정.\n[' + addDays(T, -3) + '] 슬라이드 15장 이내.',
      });
      ['자료 조사', '목차', '슬라이드 초안', '리허설', '최종본 공유'].forEach((title, i) => {
        addTask('L1', { id: 's-sem-' + (i + 1), title: title, parent: 't-seminar', status: i < 2 ? 'completed' : 'needsAction', completed: i < 2 ? nowIso() : undefined });
      });
      addTask('L1', {
        id: 't-report', title: '연구용역 보고서 초안', due: due(addDays(T, 10)),
        notes: '목표 분량: 30쪽 내외\n' +
          '[' + addDays(T, -4) + '] 자문위원 의견: 3장에 해외 사례(EU·일본) 비교표 추가. 분량은 5쪽 이내.\n' +
          '[' + addDays(T, -6) + '] 2장 통계를 2025년 확정치로 교체.\n담당자에게 자료 요청함.\n' +
          '[' + addDays(T, -7) + '] 착수. 목차 초안 공유.',
      });
      [['목차 확정', true], ['1장 서론', true], ['2장 현황 분석', true], ['3장 정책 대안 · 해외 사례 비교표', false, addDays(T, 2)], ['4장 결론 · 내부 검토 요청', false]].forEach((s, i) => {
        addTask('L1', { id: 's-rep-' + (i + 1), title: s[0], parent: 't-report', status: s[1] ? 'completed' : 'needsAction', completed: s[1] ? nowIso() : undefined, due: s[2] ? due(s[2]) : undefined });
      });
      addTask('L1', { id: 't-budget', title: '예산 정산 서류', due: due(addDays(T, 13)) });
      addTask('L1', { id: 't-card', title: '명함 주문' });
      addTask('L1', { id: 't-abstract', title: '학회 초록 제출', due: due(addDays(T, -11)), status: 'completed', completed: addDays(T, -11) + 'T09:00:00.000Z', hidden: true });
      addTask('L2', { id: 't-gym', title: '운동 등록', due: due(addDays(T, 2)) });
    }

    function findCal(id) { const c = calendars.find((x) => x.id === id); if (!c) throw notFound('calendar ' + id); return c; }
    function findEv(calId, id) { findCal(calId); const ev = events[calId].find((e) => e.id === id); if (!ev) throw notFound('event ' + id); return ev; }
    function canWrite(calId) { const c = findCal(calId); if (c.accessRole !== 'owner' && c.accessRole !== 'writer') { const e = new Error('Forbidden'); e.code = 403; throw e; } }

    const Calendar = {
      CalendarList: {
        list(o) { calls.push('CalendarList.list'); return page(clone(calendars), o); },
      },
      Events: {
        list(calId, o) {
          calls.push('Events.list ' + calId);
          findCal(calId);
          const min = new Date(o.timeMin).getTime();
          const max = new Date(o.timeMax).getTime();
          const items = events[calId]
            .filter((ev) => toMs(ev.start) < max && toMs(ev.end) > min)
            .sort((a, b) => toMs(a.start) - toMs(b.start));
          return page(clone(items), o);
        },
        get(calId, id) { calls.push('Events.get'); return clone(findEv(calId, id)); },
        insert(res, calId) {
          calls.push('Events.insert');
          canWrite(calId);
          if (!res.start || !res.end) throw new Error('Missing start/end');
          return clone(addEvent(calId, clone(res)));
        },
        update(res, calId, id) {
          calls.push('Events.update');
          canWrite(calId);
          const list = events[calId];
          const i = list.findIndex((e) => e.id === id);
          if (i < 0) throw notFound('event ' + id);
          const next = clone(res);
          if (next.start && next.start.date && next.start.dateTime) throw new Error('Invalid start: both date and dateTime');
          next.id = id;
          list[i] = next;
          return clone(next);
        },
        remove(calId, id) {
          calls.push('Events.remove');
          canWrite(calId);
          const list = events[calId];
          const i = list.findIndex((e) => e.id === id);
          if (i < 0) throw notFound('event ' + id);
          list.splice(i, 1);
        },
        move(calId, id, dest) {
          calls.push('Events.move');
          canWrite(calId); canWrite(dest);
          const ev = findEv(calId, id);
          events[calId] = events[calId].filter((e) => e !== ev);
          events[dest].push(ev);
          return clone(ev);
        },
      },
      Colors: {
        get() {
          calls.push('Colors.get');
          const bg = ['#a4bdfc', '#7ae7bf', '#dbadff', '#ff887c', '#fbd75b', '#ffb878', '#46d6db', '#e1e1e1', '#5484ed', '#51b749', '#dc2127'];
          const event = {};
          bg.forEach((c, i) => { event[String(i + 1)] = { background: c, foreground: '#1d1d1d' }; });
          return { event: event };
        },
      },
    };

    function listOf(id) {
      const key = id === '@default' ? lists[0].id : id;
      if (!tasks[key]) throw notFound('tasklist ' + id);
      return key;
    }
    function findTask(listId, id) {
      const t = tasks[listOf(listId)].find((x) => x.id === id);
      if (!t) throw notFound('task ' + id);
      return t;
    }
    function applyStatus(t) {
      if (t.status === 'completed' && !t.completed) t.completed = nowIso();
      if (t.status !== 'completed') { delete t.completed; delete t.hidden; }
      t.updated = nowIso();
      if (t.notes != null && t.notes.length > 8192) throw new Error('Invalid Value: notes too long');
      return t;
    }
    const READ_ONLY = ['id', 'kind', 'etag', 'selfLink', 'webViewLink', 'parent', 'position', 'hidden', 'links', 'updated'];

    const Tasks = {
      Tasklists: {
        list(o) { calls.push('Tasklists.list'); return page(clone(lists), o); },
      },
      Tasks: {
        list(listId, o) {
          calls.push('Tasks.list ' + listId);
          o = o || {};
          // completedMin을 주면 그 뒤에 완료한 할 일만 (완료하지 않은 할 일은 빠짐 — 앱은 따로 받아야 함)
          const items = tasks[listOf(listId)].filter((t) => (o.showHidden || !t.hidden) && (o.showCompleted !== false || t.status !== 'completed') &&
            (!o.completedMin || (t.status === 'completed' && (t.completed || '') >= o.completedMin)));
          return page(clone(items), o);
        },
        get(listId, id) { calls.push('Tasks.get'); return clone(findTask(listId, id)); },
        insert(res, listId, o) {
          calls.push('Tasks.insert');
          const key = listOf(listId);
          o = o || {};
          const t = clone(res);
          READ_ONLY.forEach((k) => { delete t[k]; });
          t.id = 't' + (++seq);
          t.status = t.status || 'needsAction';
          t.webViewLink = 'https://tasks.google.com/task/' + t.id;
          if (o.parent) { findTask(key, o.parent); t.parent = o.parent; }
          applyStatus(t);
          const arr = tasks[key];
          let idx;
          if (o.previous) {
            idx = arr.findIndex((x) => x.id === o.previous);
            if (idx < 0) throw notFound('task ' + o.previous);
            idx += 1;
          } else {
            idx = arr.findIndex((x) => (x.parent || '') === (t.parent || ''));
            if (idx < 0) idx = arr.length;
          }
          arr.splice(idx, 0, t);
          renumber(key);
          return clone(t);
        },
        update(res, listId, id) {
          calls.push('Tasks.update');
          const key = listOf(listId);
          const old = findTask(key, id);
          const next = clone(res);
          READ_ONLY.forEach((k) => { delete next[k]; if (old[k] !== undefined) next[k] = old[k]; });
          next.id = id;
          applyStatus(next);
          const arr = tasks[key];
          arr[arr.indexOf(old)] = next;
          return clone(next);
        },
        patch(res, listId, id) {
          calls.push('Tasks.patch');
          const key = listOf(listId);
          const t = findTask(key, id);
          Object.keys(res).forEach((k) => {
            if (READ_ONLY.indexOf(k) >= 0) return;
            if (res[k] === null) delete t[k]; else t[k] = clone(res[k]);
          });
          applyStatus(t);
          return clone(t);
        },
        remove(listId, id) {
          calls.push('Tasks.remove');
          const key = listOf(listId);
          const t = findTask(key, id);
          tasks[key] = tasks[key].filter((x) => x !== t);
        },
      },
    };

    return { Calendar, Tasks, data: { calendars, events, lists, tasks }, calls, today: T };
  }

  root.makeFakeGoogle = makeFakeGoogle;
})(typeof window !== 'undefined' ? window : globalThis);
