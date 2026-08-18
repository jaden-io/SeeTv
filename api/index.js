'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';
const TMDB_BASE = 'https://api.themoviedb.org/3';

const analytics = {
  requests: 0,
  streams: 0,
  errors: 0,
  tmdbHits: 0,
  proxied: 0,
  startTime: Date.now(),
  endpoints: {},
};

function trackEndpoint(name) {
  analytics.requests++;
  analytics.endpoints[name] = (analytics.endpoints[name] || 0) + 1;
}

// ── WASM singleton ────────────────────────────────────────────────────────────
let wasmReady   = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window   = globalThis;
    globalThis.self     = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('WASM boot failed: getAdv not found');
    wasmReady = true;
  })();
  return bootPromise;
}

// ── Stream resolver ───────────────────────────────────────────────────────────
async function getStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('Token generation failed');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`Upstream returned ${res.status}`);
  const data = await res.json();
  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error('No playlist in upstream response');
  return playlist;
}

// ── HLS proxy ────────────────────────────────────────────────────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(
          loc.startsWith('http') ? loc : new URL(loc, url).href,
          redirects + 1
        ));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function rewriteM3u8(body, url) {
  const base    = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin  = new URL(url).origin;
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseDir + t;
    return '/api/proxy?url=' + encodeURIComponent(abs);
  }).join('\n');
}

// ── TMDB fetch helper ─────────────────────────────────────────────────────────
async function tmdb(endpoint, apiKey, params = {}) {
  const qs  = new URLSearchParams({ api_key: apiKey, ...params }).toString();
  const url = `${TMDB_BASE}${endpoint}?${qs}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`TMDB ${endpoint} returned ${res.status}`);
  analytics.tmdbHits++;
  return res.json();
}

// ── JSON helpers ──────────────────────────────────────────────────────────────
function ok(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: true, data }));
}

function err(res, message, status = 400) {
  analytics.errors++;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: false, error: message }));
}

// ── Router ────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TMDB-Key');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const parsed = new URL(req.url, 'http://localhost');
  const route  = parsed.pathname.replace(/\/+$/, '');
  const q      = Object.fromEntries(parsed.searchParams);

  const tmdbKey = req.headers['x-tmdb-key'] || q.tmdb_key;

  try {
    // ── GET /api/stream ──────────────────────────────────────────────────────
    if (route === '/api/stream' || route === '/api') {
      trackEndpoint('stream');
      if (!q.id) return err(res, 'Missing required param: id');
      const url = await getStream(q.id, q.s || q.season, q.e || q.episode);
      analytics.streams++;
      return ok(res, { stream_url: url, proxied_url: `/api/proxy?url=${encodeURIComponent(url)}` });
    }

    // ── GET /api/proxy ───────────────────────────────────────────────────────
    if (route === '/api/proxy') {
      trackEndpoint('proxy');
      if (!q.url) return err(res, 'Missing required param: url');
      const url      = decodeURIComponent(q.url);
      const upstream = await fetchUpstream(url);
      const ct       = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8   = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);
      analytics.proxied++;

      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url));
      }

      res.setHeader('Content-Type', ct || 'application/octet-stream');
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      res.statusCode = upstream.statusCode;
      return upstream.pipe(res);
    }

    // ── GET /api/health ──────────────────────────────────────────────────────
    if (route === '/api/health') {
      trackEndpoint('health');
      return ok(res, {
        status: 'ok',
        wasm_ready: wasmReady,
        uptime_seconds: Math.floor((Date.now() - analytics.startTime) / 1000),
        version: '2.0.0',
      });
    }

    // ── GET /api/analytics ───────────────────────────────────────────────────
    if (route === '/api/analytics') {
      trackEndpoint('analytics');
      return ok(res, {
        ...analytics,
        uptime_seconds: Math.floor((Date.now() - analytics.startTime) / 1000),
        success_rate: analytics.requests
          ? (((analytics.requests - analytics.errors) / analytics.requests) * 100).toFixed(2) + '%'
          : '100%',
      });
    }

    // ── TMDB routes (all require tmdb_key or X-TMDB-Key header) ─────────────
    if (route.startsWith('/api/tmdb') || route.startsWith('/api/movie') || route.startsWith('/api/tv') || route.startsWith('/api/person') || route.startsWith('/api/search')) {
      if (!tmdbKey) return err(res, 'TMDB API key required. Pass X-TMDB-Key header or ?tmdb_key=');

      // GET /api/movie/:id
      if (route.match(/^\/api\/movie\/\d+$/)) {
        trackEndpoint('movie_detail');
        const id   = route.split('/').pop();
        const data = await tmdb(`/movie/${id}`, tmdbKey, { append_to_response: 'credits,videos,images,recommendations,similar,release_dates' });
        return ok(res, data);
      }

      // GET /api/movie/:id/stream-info
      if (route.match(/^\/api\/movie\/\d+\/stream-info$/)) {
        trackEndpoint('movie_stream_info');
        const id   = route.split('/')[3];
        const [detail, stream] = await Promise.all([
          tmdb(`/movie/${id}`, tmdbKey),
          getStream(id).catch(() => null),
        ]);
        analytics.streams++;
        return ok(res, {
          movie: detail,
          stream_url: stream,
          proxied_url: stream ? `/api/proxy?url=${encodeURIComponent(stream)}` : null,
        });
      }

      // GET /api/movie/popular
      if (route === '/api/movie/popular') {
        trackEndpoint('movie_popular');
        const data = await tmdb('/movie/popular', tmdbKey, { page: q.page || 1, region: q.region || '' });
        return ok(res, data);
      }

      // GET /api/movie/top_rated
      if (route === '/api/movie/top_rated') {
        trackEndpoint('movie_top_rated');
        const data = await tmdb('/movie/top_rated', tmdbKey, { page: q.page || 1 });
        return ok(res, data);
      }

      // GET /api/movie/trending
      if (route === '/api/movie/trending') {
        trackEndpoint('movie_trending');
        const data = await tmdb('/trending/movie/week', tmdbKey, { page: q.page || 1 });
        return ok(res, data);
      }

      // GET /api/movie/upcoming
      if (route === '/api/movie/upcoming') {
        trackEndpoint('movie_upcoming');
        const data = await tmdb('/movie/upcoming', tmdbKey, { page: q.page || 1, region: q.region || '' });
        return ok(res, data);
      }

      // GET /api/movie/now_playing
      if (route === '/api/movie/now_playing') {
        trackEndpoint('movie_now_playing');
        const data = await tmdb('/movie/now_playing', tmdbKey, { page: q.page || 1, region: q.region || '' });
        return ok(res, data);
      }

      // GET /api/movie/genres
      if (route === '/api/movie/genres') {
        trackEndpoint('movie_genres');
        const data = await tmdb('/genre/movie/list', tmdbKey, { language: q.language || 'en' });
        return ok(res, data);
      }

      // GET /api/movie/discover
      if (route === '/api/movie/discover') {
        trackEndpoint('movie_discover');
        const params = {
          page: q.page || 1,
          sort_by: q.sort_by || 'popularity.desc',
          with_genres: q.genres || '',
          'vote_average.gte': q.min_rating || '',
          'primary_release_year': q.year || '',
          with_original_language: q.language || '',
        };
        const data = await tmdb('/discover/movie', tmdbKey, params);
        return ok(res, data);
      }

      // GET /api/tv/:id
      if (route.match(/^\/api\/tv\/\d+$/)) {
        trackEndpoint('tv_detail');
        const id   = route.split('/').pop();
        const data = await tmdb(`/tv/${id}`, tmdbKey, { append_to_response: 'credits,videos,images,recommendations,similar' });
        return ok(res, data);
      }

      // GET /api/tv/:id/season/:season
      if (route.match(/^\/api\/tv\/\d+\/season\/\d+$/)) {
        trackEndpoint('tv_season');
        const parts    = route.split('/');
        const tvId     = parts[3];
        const seasonNo = parts[5];
        const data     = await tmdb(`/tv/${tvId}/season/${seasonNo}`, tmdbKey);
        return ok(res, data);
      }

      // GET /api/tv/:id/season/:season/episode/:episode/stream
      if (route.match(/^\/api\/tv\/\d+\/season\/\d+\/episode\/\d+\/stream$/)) {
        trackEndpoint('tv_episode_stream');
        const parts   = route.split('/');
        const tvId    = parts[3];
        const season  = parts[5];
        const episode = parts[7];
        const [detail, stream] = await Promise.all([
          tmdb(`/tv/${tvId}/season/${season}/episode/${episode}`, tmdbKey),
          getStream(tvId, season, episode),
        ]);
        analytics.streams++;
        return ok(res, {
          episode: detail,
          stream_url: stream,
          proxied_url: `/api/proxy?url=${encodeURIComponent(stream)}`,
        });
      }

      // GET /api/tv/popular
      if (route === '/api/tv/popular') {
        trackEndpoint('tv_popular');
        const data = await tmdb('/tv/popular', tmdbKey, { page: q.page || 1 });
        return ok(res, data);
      }

      // GET /api/tv/top_rated
      if (route === '/api/tv/top_rated') {
        trackEndpoint('tv_top_rated');
        const data = await tmdb('/tv/top_rated', tmdbKey, { page: q.page || 1 });
        return ok(res, data);
      }

      // GET /api/tv/trending
      if (route === '/api/tv/trending') {
        trackEndpoint('tv_trending');
        const data = await tmdb('/trending/tv/week', tmdbKey, { page: q.page || 1 });
        return ok(res, data);
      }

      // GET /api/tv/on_the_air
      if (route === '/api/tv/on_the_air') {
        trackEndpoint('tv_on_the_air');
        const data = await tmdb('/tv/on_the_air', tmdbKey, { page: q.page || 1 });
        return ok(res, data);
      }

      // GET /api/tv/genres
      if (route === '/api/tv/genres') {
        trackEndpoint('tv_genres');
        const data = await tmdb('/genre/tv/list', tmdbKey, { language: q.language || 'en' });
        return ok(res, data);
      }

      // GET /api/tv/discover
      if (route === '/api/tv/discover') {
        trackEndpoint('tv_discover');
        const data = await tmdb('/discover/tv', tmdbKey, {
          page: q.page || 1,
          sort_by: q.sort_by || 'popularity.desc',
          with_genres: q.genres || '',
          'vote_average.gte': q.min_rating || '',
          first_air_date_year: q.year || '',
        });
        return ok(res, data);
      }

      // GET /api/person/:id
      if (route.match(/^\/api\/person\/\d+$/)) {
        trackEndpoint('person_detail');
        const id   = route.split('/').pop();
        const data = await tmdb(`/person/${id}`, tmdbKey, { append_to_response: 'movie_credits,tv_credits,images,external_ids' });
        return ok(res, data);
      }

      // GET /api/person/popular
      if (route === '/api/person/popular') {
        trackEndpoint('person_popular');
        const data = await tmdb('/person/popular', tmdbKey, { page: q.page || 1 });
        return ok(res, data);
      }

      // GET /api/search/multi
      if (route === '/api/search/multi') {
        trackEndpoint('search_multi');
        if (!q.q && !q.query) return err(res, 'Missing param: q');
        const data = await tmdb('/search/multi', tmdbKey, { query: q.q || q.query, page: q.page || 1, include_adult: false });
        return ok(res, data);
      }

      // GET /api/search/movie
      if (route === '/api/search/movie') {
        trackEndpoint('search_movie');
        if (!q.q && !q.query) return err(res, 'Missing param: q');
        const data = await tmdb('/search/movie', tmdbKey, { query: q.q || q.query, page: q.page || 1, year: q.year || '' });
        return ok(res, data);
      }

      // GET /api/search/tv
      if (route === '/api/search/tv') {
        trackEndpoint('search_tv');
        if (!q.q && !q.query) return err(res, 'Missing param: q');
        const data = await tmdb('/search/tv', tmdbKey, { query: q.q || q.query, page: q.page || 1 });
        return ok(res, data);
      }

      // GET /api/search/person
      if (route === '/api/search/person') {
        trackEndpoint('search_person');
        if (!q.q && !q.query) return err(res, 'Missing param: q');
        const data = await tmdb('/search/person', tmdbKey, { query: q.q || q.query, page: q.page || 1 });
        return ok(res, data);
      }

      // GET /api/tmdb/collection/:id
      if (route.match(/^\/api\/tmdb\/collection\/\d+$/)) {
        trackEndpoint('collection');
        const id   = route.split('/').pop();
        const data = await tmdb(`/collection/${id}`, tmdbKey);
        return ok(res, data);
      }
    }

    // ── GET /api (no route match) ────────────────────────────────────────────
    return err(res, `Unknown route: ${route}. See /api/docs`, 404);

  } catch (e) {
    return err(res, e.message, 500);
  }
};
