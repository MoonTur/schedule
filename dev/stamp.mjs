// 화면 파일 버전 붙이기: node dev/stamp.mjs  (npm run stamp)
// docs/index.html이 부르는 css·js 주소 뒤에 파일 내용의 지문(?v=...)을 붙입니다.
// docs/의 css·js를 고친 뒤 올리기 전에 실행하세요. 빠뜨리면 npm test가 알려 줍니다.
// 서비스 워커는 같은 지문의 저장본만 쓰므로, 새 버전과 옛 버전 파일이 섞여 화면이 깨지지 않습니다.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = new URL('../docs/', import.meta.url);

/** 파일 내용의 짧은 지문 (윈도 줄바꿈이어도 같은 값) */
export function fingerprint(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex').slice(0, 10);
}

/** index.html의 로컬 css·js 주소에 ?v=지문을 붙이거나 새 지문으로 바꾼 결과 */
export function stampHtml(html, readDoc) {
  return html.replace(/(<(?:script|link)\b[^>]*\s(?:src|href)=")([\w./-]+\.(?:js|css))(?:\?v=\w+)?(")/g,
    (m, before, file, after) => before + file + '?v=' + fingerprint(readDoc(file)) + after);
}

export const readDoc = (file) => readFileSync(new URL(file, DOCS), 'utf8');

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const path = new URL('index.html', DOCS);
  const html = readFileSync(path, 'utf8');
  const next = stampHtml(html, readDoc);
  if (next === html) console.log('docs/index.html: 이미 최신입니다.');
  else { writeFileSync(path, next); console.log('docs/index.html: 파일 버전을 새로 붙였습니다.'); }
}
