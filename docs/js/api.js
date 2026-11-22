/*
 * Talk to the Apps Script JSON API.
 * POST with a text/plain body => a "simple" CORS request (no preflight), which Apps Script supports.
 */
var SolarAPI = (function () {
  'use strict';

  function ApiError(code, message) {
    var e = new Error(message);
    e.code = code; // AUTH | FORBIDDEN | NOTFOUND | BAD | SERVER | NETWORK
    return e;
  }

  var session = null;

  function setSession(t) {
    session = t || null;
    try { if (t) localStorage.setItem('solar.session', t); else localStorage.removeItem('solar.session'); } catch (e) { /* ignore */ }
    return SolarDB.set('session', session);
  }

  function loadSession() {
    var ls = null;
    try { ls = localStorage.getItem('solar.session'); } catch (e) { /* ignore */ }
    if (ls) { session = ls; return Promise.resolve(ls); }
    return SolarDB.get('session').then(function (t) { session = t || null; return session; });
  }

  function call(action, params, timeoutMs) {
    var url = window.SOLAR_CONFIG.API_URL;
    if (!session) return Promise.reject(ApiError('AUTH', 'Sila log masuk.'));
    var body = JSON.stringify(Object.assign({ action: action, token: session }, params || {}));
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 60000);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw ApiError('NETWORK', 'Pelayan tidak menjawab (' + res.status + ').');
      return res.text();
    }, function () {
      throw ApiError('NETWORK', 'Tiada sambungan internet.');
    }).then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { throw ApiError('NETWORK', 'Jawapan pelayan tidak sah.'); }
      if (!data.ok) throw ApiError(data.code || 'SERVER', data.error || 'Ralat.');
      return data;
    }).then(function (d) { clearTimeout(timer); return d; }, function (e) { clearTimeout(timer); throw e; });
  }

  return {
    call: call,
    setSession: setSession,
    loadSession: loadSession,
    hasSession: function () { return !!session; },
    ApiError: ApiError
  };
})();
