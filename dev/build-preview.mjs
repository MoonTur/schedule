// 미리보기 만들기: node dev/build-preview.mjs
// docs/index.html(실제 앱)을 바탕으로 dev/preview.html 을 만듭니다.
// 가짜 구글 API(dev/fake-google.js + dev/fake-fetch.js)를 붙여, 구글 계정 없이 앱을 눌러 볼 수 있습니다.
//   dev/preview.html               → 연결된 상태로 시작
//   dev/preview.html?noauth        → 처음 쓰는 사람(연결 화면)으로 시작
//   dev/preview.html?partial       → 구글 권한 화면에서 Tasks를 빼고 허용한 상태로 시작
//   dev/preview.html?fail=500      → 첫 구글 요청이 서버 오류로 실패
//   dev/preview.html?expired       → 예전에 연결했지만 토큰이 끝난 상태로 시작 (조용한 재연결을 시도함)
//   dev/preview.html?unreachable   → 구글에 닿지 않음 (와이파이는 잡혔지만 인터넷이 안 되는 상황)
// 실제 앱과 같은 보안 정책(CSP)을 쓰되, 미리보기 장치(아래 스크립트)와 file: 주소만 더 허용합니다.
// 정책에 막힌 것이 있으면 콘솔 오류로 남겨 dev/shoot.mjs가 알려 줍니다.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
let html = readFileSync(new URL('docs/index.html', root), 'utf8');

// 앱 파일은 docs/ 에 있으므로 상대 주소를 ../docs/ 로
html = html.replace(/(src|href)="(?!https?:|#|data:|\.\.\/)([^"]+)"/g, '$1="../docs/$2"');

const harnessJs = `
(function () {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    window.__csp.push(e.violatedDirective + ' ' + e.blockedURI);
    console.error('보안 정책(CSP)에 막힘: ' + e.violatedDirective + ' ' + e.blockedURI);
  });
  var g = makeFakeGoogle({ sample: true });
  window.__fake = g;
  window.__fakeFetch = installFakeFetch(window, g, { delay: 120 });
  var fail = /[?&]fail=(\\d+)/.exec(location.search);
  if (fail) window.__fakeFetch.failNext = { status: +fail[1], message: 'Backend Error' };
  if (/[?&]unreachable/.test(location.search)) window.__fakeFetch.unreachable = true;
  var A = 'https://www.googleapis.com/auth/';
  var scope = [A + 'calendar.readonly', A + 'calendar.events'].concat(/[?&]partial/.test(location.search) ? [] : [A + 'tasks']).join(' ');
  var expiresAt = /[?&]expired/.test(location.search) ? Date.now() - 1000 : Date.now() + 3600e3;
  try {
    if (/[?&]noauth/.test(location.search)) localStorage.removeItem('ws.auth');
    else localStorage.setItem('ws.auth', JSON.stringify({ token: 'preview-token', expiresAt: expiresAt, granted: true, hint: 'me@example.com', scope: scope }));
  } catch (e) {}
})();
`;
const harness = `
<script src="fake-google.js"></script>
<script src="fake-fetch.js"></script>
<script>${harnessJs}</script>`;

const configTag = /<script src="\.\.\/docs\/config\.js(\?v=\w+)?"><\/script>/;
if (!configTag.test(html)) throw new Error('미리보기 장치를 넣을 자리(config.js)를 찾지 못했습니다.');
html = html.replace(configTag, (tag) => harness + '\n' + tag);

// 보안 정책: 미리보기 장치 스크립트(지문으로 허용)와 file: 주소만 더함
const hash = createHash('sha256').update(harnessJs).digest('base64');
const cspTag = /(<meta http-equiv="Content-Security-Policy" content=")([^"]+)(")/;
if (!cspTag.test(html)) throw new Error('보안 정책(CSP) 태그를 찾지 못했습니다.');
html = html.replace(cspTag, (m, a, csp, b) => a + csp
  .replace("default-src 'self'", "default-src 'self' file:")
  .replace("script-src 'self'", `script-src 'self' file: 'sha256-${hash}'`)
  .replace("style-src 'self'", "style-src 'self' file:")
  .replace("img-src 'self'", "img-src 'self' file:") + b);

writeFileSync(new URL('dev/preview.html', root), html);
console.log('dev/preview.html 을 만들었습니다.');
