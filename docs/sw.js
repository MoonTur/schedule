/*
 * 서비스 워커: 앱 화면 파일을 저장해 두어 인터넷이 끊겨도 앱이 열리게 합니다.
 * - 화면 파일: 인터넷에서 새로 받되, 3초 안에 안 오면(약한 신호) 저장해 둔 것을 먼저 보여 줌.
 *   늦게 도착한 새 파일은 다음에 쓰도록 계속 저장합니다. 저장해 둔 것이 없으면 기다립니다.
 * - 구글 API 요청과 로그인은 건드리지 않음 (저장하지 않음)
 */
const CACHE = 'ws-shell-v2';
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // 구글 API·로그인은 그대로 통과

  const network = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      return caches.open(CACHE).then((c) => c.put(req, copy)).then(() => res, () => res);
    }
    return res;
  });
  event.waitUntil(network.catch(() => {})); // 늦게 와도 저장은 끝까지

  const saved = () => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./'));

  event.respondWith(new Promise((resolve) => {
    let done = false;
    const finish = (res) => { if (!done && res) { done = true; resolve(res); } };
    const timer = setTimeout(() => { saved().then(finish); }, NET_TIMEOUT); // 저장해 둔 것이 없으면 네트워크를 계속 기다림
    network.then(
      (res) => { clearTimeout(timer); finish(res); },
      () => { clearTimeout(timer); saved().then((hit) => finish(hit || Response.error())); }
    );
  }));
});
