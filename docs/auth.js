/*
 * 구글 로그인 (OAuth 2.0 — 브라우저 앱용 리다이렉트 방식).
 * - 처음 한 번: 구글 화면에서 계정을 고르고 권한을 허용합니다.
 * - 그 뒤: 1시간짜리 토큰이 끝나면 화면 없이 조용히 새로 받습니다(prompt=none).
 * 비밀번호는 이 앱이 보거나 저장하지 않습니다. 구글이 준 토큰만 이 기기에 보관합니다.
 */
(function (root) {
  'use strict';

  const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
  // 일정: 읽기 + 일정 쓰기(캘린더 자체 설정·공유는 못 바꿈), 할 일: 읽기·쓰기
  const SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
  ];
  const KEY = 'ws.auth';
  const STATE_KEY = 'ws.authState';
  const SILENT_RETRY_MS = 10 * 60 * 1000;

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function write(a) {
    try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) { /* 저장 공간 없음 */ }
  }

  function randomString() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** 구글에 등록한 주소와 똑같아야 함: https://moontur.github.io/schedule/ */
  function redirectUri() {
    return location.origin + location.pathname.replace(/[^/]*$/, '');
  }

  /**
   * 시작할 때 한 번: 구글에서 돌아온 결과(#access_token=... 또는 #error=...)를 읽고 주소를 정리합니다.
   * 돌아온 것이 아니면 null.
   */
  function handleRedirect() {
    const h = location.hash;
    if (!h || h.length < 2) return null;
    const p = new URLSearchParams(h.slice(1));
    if (!p.has('access_token') && !p.has('error')) return null;
    history.replaceState(history.state, '', location.pathname + location.search);

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) { saved = null; }
    try { localStorage.removeItem(STATE_KEY); } catch (e) { /* 무시 */ }
    if (!saved || saved.state !== p.get('state')) return { error: 'state_mismatch', silent: false };
    if (p.has('error')) return { error: p.get('error'), silent: !!saved.silent };

    const a = read();
    a.token = p.get('access_token');
    a.expiresAt = Date.now() + Math.max(60, Number(p.get('expires_in') || 3600) - 120) * 1000;
    a.scope = p.get('scope') || '';
    a.granted = true;
    a.silentFailedAt = 0;
    write(a);
    return { ok: true, silent: !!saved.silent };
  }

  /** 쓸 수 있는 토큰 (없거나 만료면 '') */
  function token() {
    const a = read();
    return a.token && a.expiresAt > Date.now() ? a.token : '';
  }

  function msLeft() {
    const a = read();
    return a.token ? a.expiresAt - Date.now() : 0;
  }

  function clearToken() {
    const a = read();
    delete a.token;
    delete a.expiresAt;
    write(a);
  }

  /** 예전에 허용한 적이 있고, 최근 조용한 연결이 실패하지 않았으면 화면 없이 다시 받을 수 있음 */
  function canTrySilent() {
    const a = read();
    return !!a.granted && (!a.silentFailedAt || Date.now() - a.silentFailedAt > SILENT_RETRY_MS);
  }

  function markSilentFailed() {
    const a = read();
    a.silentFailedAt = Date.now();
    write(a);
  }

  function hint() { return read().hint || ''; }
  function setHint(email) {
    const a = read();
    if (email && a.hint !== email) { a.hint = email; write(a); }
  }

  let leaving = false;
  /**
   * 구글 로그인 화면으로 이동합니다.
   * opts.silent: 이미 허용했으면 화면 없이 바로 돌아옴 / opts.switchAccount: 다른 계정 고르기
   */
  function signIn(opts) {
    opts = opts || {};
    if (leaving) return;
    const cfg = root.APP_CONFIG || {};
    if (!cfg.clientId || /^YOUR_/.test(cfg.clientId)) {
      throw new Error('config.js에 구글 OAuth 클라이언트 ID가 없습니다.');
    }
    const state = randomString();
    try { localStorage.setItem(STATE_KEY, JSON.stringify({ state: state, silent: !!opts.silent, at: Date.now() })); } catch (e) { /* 무시 */ }
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPES.join(' '),
      include_granted_scopes: 'true',
      state: state,
    });
    const h = hint();
    if (opts.silent) params.set('prompt', 'none');
    else if (opts.switchAccount || !h) params.set('prompt', 'select_account');
    if (h && !opts.switchAccount) params.set('login_hint', h);
    leaving = true;
    location.assign(AUTH_URL + '?' + params.toString());
  }

  /** 연결 끊기: 구글에 토큰 취소를 알리고 이 기기의 연결 정보를 지웁니다. */
  function signOut() {
    const t = read().token;
    if (t) {
      // 응답은 읽을 수 없지만(no-cors) 요청은 전달됩니다.
      fetch(REVOKE_URL + '?token=' + encodeURIComponent(t), { method: 'POST', mode: 'no-cors' }).catch(() => {});
    }
    try { localStorage.removeItem(KEY); } catch (e) { /* 무시 */ }
  }

  root.Auth = {
    SCOPES: SCOPES,
    handleRedirect: handleRedirect,
    token: token,
    msLeft: msLeft,
    clearToken: clearToken,
    canTrySilent: canTrySilent,
    markSilentFailed: markSilentFailed,
    hint: hint,
    setHint: setHint,
    signIn: signIn,
    signOut: signOut,
    redirectUri: redirectUri,
  };
})(typeof window !== 'undefined' ? window : globalThis);
