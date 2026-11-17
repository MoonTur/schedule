/*
 * 개발용 가짜 구글 REST API — fetch를 바꿔 끼워 www.googleapis.com / tasks.googleapis.com 요청을
 * dev/fake-google.js의 가짜 서비스로 보냅니다. 브라우저 미리보기와 Node 테스트에서 함께 씁니다.
 * (구글에 올리는 파일이 아닙니다.)
 */
(function (root) {
  'use strict';

  const HOSTS = ['www.googleapis.com', 'tasks.googleapis.com'];
  const d = decodeURIComponent;

  function installFakeFetch(target, g, opts) {
    opts = opts || {};
    const state = {
      delay: opts.delay == null ? 60 : opts.delay,
      validToken: opts.validToken || null, // 정해 두면 그 토큰만 통과 (401 시험용)
      calls: [],
      failNext: null,                       // { status, message } 다음 요청 하나를 실패시킴
      unreachable: false,                   // true면 구글에 닿지 않음 (와이파이는 잡혔지만 인터넷이 안 되는 상황)
    };
    const realFetch = target.fetch ? target.fetch.bind(target) : null;

    const EV = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/;
    const TK = /^\/tasks\/v1\/lists\/([^/]+)\/tasks\/([^/]+)$/;
    const num = (v) => (v == null || v === '' ? undefined : Number(v));
    const routes = [
      ['GET', /^\/calendar\/v3\/users\/me\/calendarList$/, (m, q) => g.Calendar.CalendarList.list({ maxResults: num(q.maxResults), pageToken: q.pageToken })],
      ['GET', /^\/calendar\/v3\/colors$/, () => g.Calendar.Colors.get()],
      ['GET', /^\/calendar\/v3\/calendars\/([^/]+)\/events$/, (m, q) => g.Calendar.Events.list(d(m[1]), {
        timeMin: q.timeMin, timeMax: q.timeMax, maxResults: num(q.maxResults), pageToken: q.pageToken,
      })],
      ['POST', /^\/calendar\/v3\/calendars\/([^/]+)\/events$/, (m, q, b) => g.Calendar.Events.insert(b, d(m[1]))],
      ['POST', /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)\/move$/, (m, q) => g.Calendar.Events.move(d(m[1]), d(m[2]), q.destination)],
      ['GET', EV, (m) => g.Calendar.Events.get(d(m[1]), d(m[2]))],
      ['PUT', EV, (m, q, b) => g.Calendar.Events.update(b, d(m[1]), d(m[2]))],
      ['DELETE', EV, (m) => { g.Calendar.Events.remove(d(m[1]), d(m[2])); }],
      ['GET', /^\/tasks\/v1\/users\/@me\/lists$/, (m, q) => g.Tasks.Tasklists.list({ maxResults: num(q.maxResults), pageToken: q.pageToken })],
      ['GET', /^\/tasks\/v1\/lists\/([^/]+)\/tasks$/, (m, q) => g.Tasks.Tasks.list(d(m[1]), {
        showCompleted: q.showCompleted !== 'false', showHidden: q.showHidden === 'true', completedMin: q.completedMin, maxResults: num(q.maxResults), pageToken: q.pageToken,
      })],
      ['POST', /^\/tasks\/v1\/lists\/([^/]+)\/tasks$/, (m, q, b) => g.Tasks.Tasks.insert(b, d(m[1]), { parent: q.parent, previous: q.previous })],
      ['GET', TK, (m) => g.Tasks.Tasks.get(d(m[1]), d(m[2]))],
      ['PUT', TK, (m, q, b) => g.Tasks.Tasks.update(b, d(m[1]), d(m[2]))],
      ['PATCH', TK, (m, q, b) => g.Tasks.Tasks.patch(b, d(m[1]), d(m[2]))],
      ['DELETE', TK, (m) => { g.Tasks.Tasks.remove(d(m[1]), d(m[2])); }],
    ];

    const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
      status: status, headers: { 'Content-Type': 'application/json' },
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function fakeFetch(input, init) {
      init = init || {};
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (HOSTS.indexOf(url.hostname) < 0) {
        if (realFetch) return realFetch(input, init);
        throw new TypeError('network');
      }
      const method = (init.method || 'GET').toUpperCase();
      const q = Object.fromEntries(url.searchParams.entries());
      state.calls.push(method + ' ' + url.pathname);
      if (state.unreachable) { await sleep(state.delay || 0); throw new TypeError('Failed to fetch'); }

      let res;
      const headers = init.headers || {};
      const auth = headers.Authorization || headers.authorization || '';
      if (!/^Bearer \S+/.test(auth) || (state.validToken && auth !== 'Bearer ' + state.validToken)) {
        res = json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
      } else if (state.failNext) {
        const f = state.failNext;
        state.failNext = null;
        res = json(f.status, { error: { code: f.status, message: f.message || 'error' } });
      } else {
        const route = routes.find((r) => r[0] === method && r[1].test(url.pathname));
        if (!route) {
          res = json(404, { error: { code: 404, message: 'No route: ' + method + ' ' + url.pathname } });
        } else {
          try {
            const body = init.body ? JSON.parse(init.body) : undefined;
            // 요청을 받은 순간의 구글 상태로 처리하고, 응답만 늦게 돌려줌
            const out = route[2](url.pathname.match(route[1]), q, body);
            res = out === undefined ? new Response(null, { status: 204 }) : json(200, out);
          } catch (e) {
            const code = e.code || 400;
            res = json(code, { error: { code: code, message: e.message } });
          }
        }
      }
      if (state.delay) await sleep(state.delay);
      return res;
    }

    target.fetch = fakeFetch;
    return state;
  }

  root.installFakeFetch = installFakeFetch;
})(typeof window !== 'undefined' ? window : globalThis);
