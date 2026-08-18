'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN = 'https://vidlink.pro';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';
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

let wasmReady = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(resolve => setTimeout(resolve, 500));
    if (typeof globalThis.getAdv !== 'function') {
      throw new Error('WASM boot failed: getAdv not found');
    }
    wasmReady = true;
  })();
  return bootPromise;
}

async function getStream(id, season, episode) {
  if (!id) throw new Error('Missing content ID');
  await bootWasm();

  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('Stream token generation failed');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const response = await fetch(apiUrl, {
    headers: {
      Referer: REFERER,
      Origin: ORIGIN,
      'User-Agent': UA,
      Accept: 'application/json,text/plain,*/*',
    },
  });

  if (!response.ok) {
    throw new Error(`Stream provider returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const playlist = data?.stream?.playlist || data?.playlist || data?.stream?.url || data?.url;
  if (!playlist || typeof playlist !== 'string') {
    throw new Error('Stream provider returned no playable playlist');
  }

  return playlist;
}

function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many upstream redirects'));
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid stream URL')); }

    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(url, {
      headers: {
        Referer: REFERER,
        Origin: ORIGIN,
        'User-Agent': UA,
        Accept: '*/*',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return resolve(fetchUpstream(next, redirects + 1));
      }
      resolve(res);
    });
    request.on('error', reject);
    request.setTimeout(20000, () => request.destroy(new Error('Upstream request timed out')));
  });
}

function absoluteUrl(value, baseUrl) {
  try { return new URL(value, baseUrl).href; } catch { return null; }
}

function rewriteM3u8(body, url) {
  return body.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#EXT-X-KEY:') || trimmed.startsWith('#EXT-X-MAP:')) {
      return line.replace(/URI="([^"]+)"/i, (_, uri) => {
        const absolute = absoluteUrl(uri, url);
        return absolute ? `URI="/api/proxy?url=${encodeURIComponent(absolute)}"` : `URI="${uri}"`;
      });
    }

    if (trimmed.startsWith('#')) return line;
    const absolute = absoluteUrl(trimmed, url);
    return absolute ? '/api/proxy?url=' + encodeURIComponent(absolute) : line;
  }).join('\n');
}

async function tmdb(endpoint, apiKey, params = {}) {
  const qs = new URLSearchParams({ api_key: apiKey, ...params }).toString();
  const response = await fetch(`${TMDB_BASE}${endpoint}?${qs}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`TMDB returned HTTP ${response.status}`);
  analytics.tmdbHits++;
  return response.json();
}

function ok(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ success: true, data }));
}

function err(res, message, status = 400) {
  analytics.errors++;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ success: false, error: message }));
}

function requireKey(res, key) {
  if (!key) {
    err(res, 'TMDB API key required', 401);
    return false;
  }
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TMDB-Key');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const parsed = new URL(req.url, 'http://localhost');
  const route = parsed.pathname.replace(/\/+$/, '') || '/';
  const q = Object.fromEntries(parsed.searchParams);
  const tmdbKey = req.headers['x-tmdb-key'] || q.tmdb_key;

  try {
    // Direct stream resolver. This is the same contract used by the supplied
    // working movie-scraper: { url: "https://...m3u8" }.
    if (route === '/api' || route === '/api/stream') {
      trackEndpoint('stream');
      if (!q.id) return err(res, 'Missing required param: id');
      const url = await getStream(q.id, q.s || q.season, q.e || q.episode);
      analytics.streams++;
      return ok(res, {
        url,
        stream_url: url,
        proxied_url: `/api/proxy?url=${encodeURIComponent(url)}`,
      });
    }

    if (route === '/api/proxy') {
      trackEndpoint('proxy');
      if (!q.url) return err(res, 'Missing required param: url');
      const upstream = await fetchUpstream(q.url);
      const status = upstream.statusCode || 502;
      const contentType = String(upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = contentType.includes('mpegurl') || contentType.includes('m3u8') || /\.m3u8?(\?|$)/i.test(q.url);

      if (status >= 400) {
        res.statusCode = status;
        res.setHeader('Content-Type', contentType || 'text/plain');
        return upstream.pipe(res);
      }

      analytics.proxied++;
      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.end(rewriteM3u8(body, q.url));
      }

      res.statusCode = status;
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      return upstream.pipe(res);
    }

    if (route === '/api/health') {
      trackEndpoint('health');
      return ok(res, {
        status: 'ok',
        wasm_ready: wasmReady,
        uptime_seconds: Math.floor((Date.now() - analytics.startTime) / 1000),
        version: '3.0.0',
      });
    }

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

    if (!requireKey(res, tmdbKey)) return;

    // Movie endpoints
    let m = route.match(/^\/api\/movie\/(\d+)$/);
    if (m) {
      trackEndpoint('movie_detail');
      return ok(res, await tmdb(`/movie/${m[1]}`, tmdbKey, { append_to_response: 'credits,videos,images,recommendations,similar,release_dates' }));
    }

    m = route.match(/^\/api\/movie\/(\d+)\/stream-info$/);
    if (m) {
      trackEndpoint('movie_stream_info');
      const id = m[1];
      const detailPromise = tmdb(`/movie/${id}`, tmdbKey, { append_to_response: 'credits,videos,images,recommendations,similar,release_dates' });
      const streamPromise = getStream(id).catch(e => ({ error: e.message }));
      const [detail, streamResult] = await Promise.all([detailPromise, streamPromise]);
      const streamUrl = typeof streamResult === 'string' ? streamResult : null;
      if (streamUrl) analytics.streams++;
      return ok(res, {
        movie: detail,
        stream_url: streamUrl,
        url: streamUrl,
        proxied_url: streamUrl ? `/api/proxy?url=${encodeURIComponent(streamUrl)}` : null,
        stream_error: streamUrl ? null : streamResult.error,
      });
    }

    const movieList = {
      '/popular': '/movie/popular',
      '/trending': '/trending/movie/week',
      '/top_rated': '/movie/top_rated',
      '/now_playing': '/movie/now_playing',
      '/upcoming': '/movie/upcoming',
    };
    if (route.startsWith('/api/movie/')) {
      const suffix = route.slice('/api/movie'.length);
      if (movieList[suffix]) {
        trackEndpoint('movie_' + suffix.slice(1));
        return ok(res, await tmdb(movieList[suffix], tmdbKey, { page: q.page || 1, region: q.region || '' }));
      }
      if (suffix === '/genres') {
        trackEndpoint('movie_genres');
        return ok(res, await tmdb('/genre/movie/list', tmdbKey, { language: q.language || 'en' }));
      }
      if (suffix === '/discover') {
        trackEndpoint('movie_discover');
        return ok(res, await tmdb('/discover/movie', tmdbKey, {
          page: q.page || 1,
          sort_by: q.sort_by || 'popularity.desc',
          with_genres: q.genres || '',
          'vote_average.gte': q.min_rating || '',
          primary_release_year: q.year || '',
          with_original_language: q.language || '',
        }));
      }
    }

    // TV endpoints
    m = route.match(/^\/api\/tv\/(\d+)$/);
    if (m) {
      trackEndpoint('tv_detail');
      return ok(res, await tmdb(`/tv/${m[1]}`, tmdbKey, { append_to_response: 'credits,videos,images,recommendations,similar' }));
    }

    m = route.match(/^\/api\/tv\/(\d+)\/season\/(\d+)$/);
    if (m) {
      trackEndpoint('tv_season');
      return ok(res, await tmdb(`/tv/${m[1]}/season/${m[2]}`, tmdbKey));
    }

    m = route.match(/^\/api\/tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)\/stream$/);
    if (m) {
      trackEndpoint('tv_episode_stream');
      const [episodeInfo, streamResult] = await Promise.all([
        tmdb(`/tv/${m[1]}/season/${m[2]}/episode/${m[3]}`, tmdbKey),
        getStream(m[1], m[2], m[3]).catch(e => ({ error: e.message })),
      ]);
      const streamUrl = typeof streamResult === 'string' ? streamResult : null;
      if (streamUrl) analytics.streams++;
      return ok(res, {
        episode: episodeInfo,
        stream_url: streamUrl,
        url: streamUrl,
        proxied_url: streamUrl ? `/api/proxy?url=${encodeURIComponent(streamUrl)}` : null,
        stream_error: streamUrl ? null : streamResult.error,
      });
    }

    const tvList = {
      '/popular': '/tv/popular',
      '/top_rated': '/tv/top_rated',
      '/trending': '/trending/tv/week',
      '/on_the_air': '/tv/on_the_air',
    };
    if (route.startsWith('/api/tv/')) {
      const suffix = route.slice('/api/tv'.length);
      if (tvList[suffix]) {
        trackEndpoint('tv_' + suffix.slice(1));
        return ok(res, await tmdb(tvList[suffix], tmdbKey, { page: q.page || 1 }));
      }
      if (suffix === '/genres') {
        trackEndpoint('tv_genres');
        return ok(res, await tmdb('/genre/tv/list', tmdbKey, { language: q.language || 'en' }));
      }
      if (suffix === '/discover') {
        trackEndpoint('tv_discover');
        return ok(res, await tmdb('/discover/tv', tmdbKey, {
          page: q.page || 1,
          sort_by: q.sort_by || 'popularity.desc',
          with_genres: q.genres || '',
          'vote_average.gte': q.min_rating || '',
          first_air_date_year: q.year || '',
          with_original_language: q.language || '',
        }));
      }
    }

    // People and search
    m = route.match(/^\/api\/person\/(\d+)$/);
    if (m) {
      trackEndpoint('person_detail');
      return ok(res, await tmdb(`/person/${m[1]}`, tmdbKey, { append_to_response: 'combined_credits,images' }));
    }
    if (route === '/api/person/popular') {
      trackEndpoint('person_popular');
      return ok(res, await tmdb('/person/popular', tmdbKey, { page: q.page || 1 }));
    }

    const searches = {
      '/api/search/multi': '/search/multi',
      '/api/search/movie': '/search/movie',
      '/api/search/tv': '/search/tv',
      '/api/search/person': '/search/person',
    };
    if (searches[route]) {
      trackEndpoint(route.slice('/api/search/'.length));
      if (!q.q) return err(res, 'Missing required param: q');
      return ok(res, await tmdb(searches[route], tmdbKey, { query: q.q, page: q.page || 1, include_adult: 'false' }));
    }

    return err(res, 'Route not found', 404);
  } catch (e) {
    console.error('[SeeTv API]', e);
    return err(res, e?.message || 'Internal server error', 500);
  }
};
