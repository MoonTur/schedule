/*
 * 서비스 워커: 앱 화면 파일을 저장해 두어 인터넷이 끊겨도 앱이 열리게 합니다.
 * - 화면 파일: 인터넷에서 새로 받되, 3초 안에 안 오면(약한 신호) 저장해 둔 것을 먼저 보여 줌.
 *   늦게 도착한 새 파일은 다음에 쓰도록 계속 저장합니다.
 * - index.html은 css·js를 버전(?v=지문)을 붙여 부릅니다(dev/stamp.mjs). 약한 신호일 때는 '같은 버전'의
 *   저장본만 쓰고, 없으면 새 파일을 기다립니다 → 새 버전과 옛 버전 파일이 섞여 화면이 깨지지 않습니다.
 *   인터넷이 아예 끊겼을 때만 버전이 달라도 저장본을 씁니다 (아무것도 없는 것보다 나음).
 * - 새 index.html을 저장하면 그 버전의 파일을 미리 받아 두고 옛 버전은 지웁니다.
 * - 구글 API 요청과 로그인은 건드리지 않음 (저장하지 않음)
 */
const CACHE = 'ws-shell-v3';
const NET_TIMEOUT = self.WS_NET_TIMEOUT || 3000; // 시험에서만 바꿈
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './auth.js',
  './logic.js',
  './api.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** 화면(index.html)이 부르는 버전의 파일을 미리 받아 두고, 같은 파일의 다른 버전은 지움 */
function keepShell(cache, pageUrl, page) {
  return page.text().then((html) => {
    const want = {}; // 경로 → 이 화면이 쓰는 주소(버전 포함)
    (html.match(/(?:src|href)="[^"]+\?v=\w+"/g) || []).forEach((m) => {
      const u = new URL(m.slice(m.indexOf('"') + 1, -1), pageUrl);
      want[u.pathname] = u.href;
    });
    const urls = Object.keys(want).map((p) => want[p]);
    return Promise.all(urls.map((u) => cache.match(u).then((hit) => hit || cache.add(u))))
      .then(() => cache.keys()) // 다 받았을 때만 옛 버전을 지움 (끊기면 옛 버전이라도 남김)
      .then((keys) => Promise.all(keys.filter((k) => {
        const u = new URL(k.url);
        return want[u.pathname] && want[u.pathname] !== u.href;
      }).map((k) => cache.delete(k))));
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // 구글 API·로그인은 그대로 통과

  let saving = null;
  const network = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      const page = /text\/html/.test(res.headers.get('content-type') || '') ? res.clone() : null;
      saving = caches.open(CACHE).then((c) => c.put(req, copy).then(() => page && keepShell(c, req.url, page)));
    }
    return res;
  });
  event.waitUntil(network.then(() => saving, () => {}).catch(() => {})); // 늦게 와도 저장은 끝까지

  const sameVersion = () => caches.match(req);
  const anyVersion = () => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./'));

  event.respondWith(new Promise((resolve) => {
    let done = false;
    const finish = (res) => { if (!done && res) { done = true; resolve(res); } };
    // 약한 신호: 같은 버전의 저장본이 있으면 먼저 보여 줌. 없으면 새 파일을 계속 기다림
    const timer = setTimeout(() => { sameVersion().then(finish); }, NET_TIMEOUT);
    network.then(
      (res) => { clearTimeout(timer); finish(res); },
      // 끊김: 같은 버전 → 다른 버전 → 첫 화면 순서로 저장본
      () => { clearTimeout(timer); sameVersion().then((hit) => hit || anyVersion()).then((hit) => finish(hit || Response.error())); }
    );
  }));
});
