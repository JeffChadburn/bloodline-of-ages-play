var live = false;
self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});
self.addEventListener("message", function (e) {
  var d = e.data || {};
  if (d.t === "skip") self.skipWaiting();
  if (d.t === "unlock") {
    live = true;
    if (e.ports && e.ports[0]) e.ports[0].postMessage({ ok: 1 });
  }
  if (d.t === "lock") {
    live = false;
    caches.delete(LIVE_CACHE).catch(function () {});
    if (e.ports && e.ports[0]) e.ports[0].postMessage({ ok: 1 });
  }
});

// The browser stops an idle worker at any time (about 30 s on Chrome, sooner on iOS) and the
// in-memory "live" flag is lost. Remember which page clients were served the unlocked game so their
// later image / audio / module requests keep working after a restart. Client ids die with the tab.
var LIVE_CACHE = "sw-live";
var seenClients = {};
function liveKey(id) { return new URL("__live/" + encodeURIComponent(id), self.registration.scope); }
async function rememberClient(id) {
  if (!id) return;
  try { var c = await caches.open(LIVE_CACHE); await c.put(liveKey(id), new Response("1")); } catch (e) {}
}
async function isLiveClient(id) {
  if (!id) return false;
  try { var c = await caches.open(LIVE_CACHE); return !!(await c.match(liveKey(id))); } catch (e) { return false; }
}

function scopePath() {
  return new URL(self.registration.scope).pathname;
}
function relPath(url) {
  var s = scopePath();
  var p = new URL(url).pathname;
  if (!p.startsWith(s)) return null;
  return p.slice(s.length);
}

function isReserved(rel) {
  if (!rel) return false;
  if (rel === "sw.js" || rel === "m.json" || rel === "robots.txt") return true;
  if (rel.indexOf("c/") === 0) return true;
  return false;
}

function rangeResponse(req, res) {
  var hdr = req.headers.get("Range");
  if (!hdr || !res || !res.ok) return res;
  return res.arrayBuffer().then(function (buf) {
    var m = /^bytes=(\d*)-(\d*)$/.exec(hdr);
    if (!m) return new Response(buf, { status: res.status, headers: res.headers });
    var size = buf.byteLength;
    var start = m[1] ? parseInt(m[1], 10) : 0;
    var end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (isNaN(start) || isNaN(end) || start < 0 || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
    }
    end = Math.min(end, size - 1);
    var slice = buf.slice(start, end + 1);
    var headers = new Headers(res.headers);
    headers.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
    headers.set("Content-Length", String(slice.byteLength));
    headers.set("Accept-Ranges", "bytes");
    return new Response(slice, { status: 206, headers: headers });
  });
}

async function fromVault(req, rel, ok) {
  if (!live && !ok) return null;
  var names = await caches.keys();
  var latest = names.filter(function (n) { return n.indexOf("v-") === 0; }).sort().reverse();
  for (var i = 0; i < latest.length; i++) {
    var cache = await caches.open(latest[i]);
    var url = new URL(rel, self.registration.scope);
    var hit = await cache.match(url, { ignoreSearch: true });
    if (!hit && (rel === "" || rel.endsWith("/"))) {
      hit = await cache.match(new URL("index.html", self.registration.scope), { ignoreSearch: true });
    }
    if (hit) {
      if (req.headers.has("Range")) return rangeResponse(req, hit);
      var headers = new Headers(hit.headers);
      headers.set("Accept-Ranges", "bytes");
      return new Response(hit.body, { status: hit.status, headers: headers });
    }
  }
  return null;
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var rel = relPath(req.url);
  if (rel == null) return;
  if (isReserved(rel)) return;
  event.respondWith((async function () {
    var ok = live || (req.mode !== "navigate" && await isLiveClient(event.clientId));
    if (live && event.clientId && !seenClients[event.clientId]) { seenClients[event.clientId] = 1; await rememberClient(event.clientId); } // no resultingClientId (older Safari)
    var hit = await fromVault(req, rel, ok);
    if (hit) { if (req.mode === "navigate") await rememberClient(event.resultingClientId); return hit; }
    if (req.mode === "navigate") {
      var page = await fromVault(req, "index.html", ok);
      if (page) { await rememberClient(event.resultingClientId); return page; }
    }
    return fetch(req);
  })());
});
