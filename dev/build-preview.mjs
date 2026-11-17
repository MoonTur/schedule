// 미리보기 만들기: node dev/build-preview.mjs
// docs/index.html(실제 앱)을 바탕으로 dev/preview.html 을 만듭니다.
// 가짜 구글 API(dev/fake-google.js + dev/fake-fetch.js)를 붙여, 구글 계정 없이 앱을 눌러 볼 수 있습니다.
//   dev/preview.html            → 연결된 상태로 시작
//   dev/preview.html?noauth     → 처음 쓰는 사람(연결 화면)으로 시작
//   dev/preview.html?partial    → 구글 권한 화면에서 Tasks를 빼고 허용한 상태로 시작
//   dev/preview.html?fail=500   → 첫 구글 요청이 서버 오류로 실패
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
let html = readFileSync(new URL('docs/index.html', root), 'utf8');

// 앱 파일은 docs/ 에 있으므로 상대 주소를 ../docs/ 로
html = html.replace(/(src|href)="(?!https?:|#|data:|\.\.\/)([^"]+)"/g, '$1="../docs/$2"');

const harness = `
<script src="fake-google.js"></script>
<script src="fake-fetch.js"></script>
<script>
(function () {
  var g = makeFakeGoogle({ sample: true });
  window.__fake = g;
  window.__fakeFetch = installFakeFetch(window, g, { delay: 120 });
  var fail = /[?&]fail=(\\d+)/.exec(location.search);
  if (fail) window.__fakeFetch.failNext = { status: +fail[1], message: 'Backend Error' };
  var A = 'https://www.googleapis.com/auth/';
  var scope = [A + 'calendar.readonly', A + 'calendar.events'].concat(/[?&]partial/.test(location.search) ? [] : [A + 'tasks']).join(' ');
  try {
    if (/[?&]noauth/.test(location.search)) localStorage.removeItem('ws.auth');
    else localStorage.setItem('ws.auth', JSON.stringify({ token: 'preview-token', expiresAt: Date.now() + 3600e3, granted: true, hint: 'me@example.com', scope: scope }));
  } catch (e) {}
})();
</script>`;

html = html.replace('<script src="../docs/config.js"></script>', harness + '\n<script src="../docs/config.js"></script>');
if (!html.includes('installFakeFetch(window')) throw new Error('미리보기 장치를 넣지 못했습니다.');
writeFileSync(new URL('dev/preview.html', root), html);
console.log('dev/preview.html 을 만들었습니다.');
