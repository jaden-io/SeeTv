'use strict';

const http = require('http');

const BASE    = process.env.TEST_BASE || 'http://localhost:3000';
const TMDB_KEY = process.env.TMDB_KEY || '3a73619bbb8fc6d47742d1b5b2b707b5';

var passed = 0;
var failed = 0;
var total  = 0;

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          resolve({ status: res.statusCode, body: null, raw: Buffer.concat(chunks).toString() });
        }
      });
    }).on('error', reject);
  });
}

async function test(label, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log('\x1b[32m  ✓\x1b[0m', label);
  } catch (e) {
    failed++;
    console.log('\x1b[31m  ✗\x1b[0m', label);
    console.log('    \x1b[31m→\x1b[0m', e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertShape(body, msg) {
  assert(typeof body === 'object' && body !== null, msg + ': body is not an object');
  assert('success' in body, msg + ': missing success field');
}

async function run() {
  console.log('\n\x1b[1m StreamVault API Test Suite\x1b[0m');
  console.log(' Base URL:', BASE);
  console.log(' ─────────────────────────────────────────\n');

  // ── Health ────────────────────────────────────────────────────────────────
  console.log('\x1b[2m Health\x1b[0m');

  await test('GET /api/health → 200', async () => {
    const r = await get('/api/health');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assertShape(r.body, 'health');
    assert(r.body.success === true, 'success should be true');
    assert(r.body.data.status === 'ok', 'status should be ok');
    assert(typeof r.body.data.version === 'string', 'version should be a string');
    assert(typeof r.body.data.uptime_seconds === 'number', 'uptime_seconds should be a number');
  });

  await test('GET /api/health returns wasm_ready field', async () => {
    const r = await get('/api/health');
    assert('wasm_ready' in r.body.data, 'wasm_ready missing from health response');
  });

  // ── Analytics ─────────────────────────────────────────────────────────────
  console.log('\n\x1b[2m Analytics\x1b[0m');

  await test('GET /api/analytics → 200 with expected fields', async () => {
    const r = await get('/api/analytics');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.success === true);
    const d = r.body.data;
    assert(typeof d.requests       === 'number', 'requests missing');
    assert(typeof d.streams        === 'number', 'streams missing');
    assert(typeof d.errors         === 'number', 'errors missing');
    assert(typeof d.tmdbHits       === 'number', 'tmdbHits missing');
    assert(typeof d.proxied        === 'number', 'proxied missing');
    assert(typeof d.success_rate   === 'string', 'success_rate missing');
    assert(typeof d.uptime_seconds === 'number', 'uptime_seconds missing');
    assert(typeof d.endpoints      === 'object', 'endpoints missing');
  });

  // ── Stream ────────────────────────────────────────────────────────────────
  console.log('\n\x1b[2m Stream\x1b[0m');

  await test('GET /api/stream with no id → 400', async () => {
    const r = await get('/api/stream');
    assert(r.status === 400, 'Expected 400, got ' + r.status);
    assertShape(r.body, 'no-id');
    assert(r.body.success === false, 'success should be false');
    assert(typeof r.body.error === 'string', 'error message missing');
  });

  await test('GET /api/stream?id=550 → 200 with stream_url and proxied_url', async () => {
    const r = await get('/api/stream?id=550');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.success === true);
    assert(typeof r.body.data.stream_url   === 'string', 'stream_url missing');
    assert(typeof r.body.data.proxied_url  === 'string', 'proxied_url missing');
    assert(r.body.data.proxied_url.startsWith('/api/proxy'), 'proxied_url should start with /api/proxy');
  });

  await test('GET /api/stream?id=456&s=1&e=1 (TV) → 200', async () => {
    const r = await get('/api/stream?id=456&s=1&e=1');
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.success === true);
    assert(typeof r.body.data.stream_url === 'string', 'stream_url missing');
  });

  // ── Proxy ─────────────────────────────────────────────────────────────────
  console.log('\n\x1b[2m Proxy\x1b[0m');

  await test('GET /api/proxy with no url → 400', async () => {
    const r = await get('/api/proxy');
    assert(r.status === 400, 'Expected 400, got ' + r.status);
    assert(r.body.success === false);
  });

  // ── Movies ────────────────────────────────────────────────────────────────
  console.log('\n\x1b[2m Movies\x1b[0m');

  await test('GET /api/movie/550 → 200 with full detail', async () => {
    const r = await get('/api/movie/550?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.success === true);
    const d = r.body.data;
    assert(d.id === 550,             'Wrong ID');
    assert(typeof d.title === 'string', 'title missing');
    assert(Array.isArray(d.genres),     'genres should be array');
    assert(d.credits,                   'credits missing (append_to_response)');
    assert(Array.isArray(d.credits.cast), 'cast should be array');
  });

  await test('GET /api/movie/popular → paginated list', async () => {
    const r = await get('/api/movie/popular?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200, 'Expected 200');
    assert(r.body.success === true);
    assert(Array.isArray(r.body.data.results), 'results should be array');
    assert(r.body.data.results.length > 0,     'results should be non-empty');
    assert(typeof r.body.data.total_pages === 'number', 'total_pages missing');
  });

  await test('GET /api/movie/trending → non-empty results', async () => {
    const r = await get('/api/movie/trending?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
  });

  await test('GET /api/movie/top_rated → non-empty results', async () => {
    const r = await get('/api/movie/top_rated?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
  });

  await test('GET /api/movie/now_playing → non-empty results', async () => {
    const r = await get('/api/movie/now_playing?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
  });

  await test('GET /api/movie/upcoming → non-empty results', async () => {
    const r = await get('/api/movie/upcoming?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
  });

  await test('GET /api/movie/genres → genre list', async () => {
    const r = await get('/api/movie/genres?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(Array.isArray(r.body.data.genres), 'genres should be array');
    assert(r.body.data.genres.length > 0,     'genres should be non-empty');
    assert(typeof r.body.data.genres[0].id   === 'number', 'genre id should be number');
    assert(typeof r.body.data.genres[0].name === 'string', 'genre name should be string');
  });

  await test('GET /api/movie/discover with sort_by=popularity.desc', async () => {
    const r = await get('/api/movie/discover?sort_by=popularity.desc&tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(Array.isArray(r.body.data.results));
  });

  await test('GET /api/movie/550/stream-info → movie + stream_url', async () => {
    const r = await get('/api/movie/550/stream-info?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.success === true);
    assert(r.body.data.movie,            'movie field missing');
    assert(r.body.data.movie.id === 550, 'Wrong movie ID');
  });

  // ── TV ────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[2m TV Shows\x1b[0m');

  await test('GET /api/tv/456 → TV detail with credits', async () => {
    const r = await get('/api/tv/456?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.success === true);
    const d = r.body.data;
    assert(typeof d.name === 'string',   'name missing');
    assert(Array.isArray(d.seasons),     'seasons should be array');
    assert(d.credits,                    'credits missing');
  });

  await test('GET /api/tv/456/season/1 → season detail with episodes', async () => {
    const r = await get('/api/tv/456/season/1?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200, 'Expected 200');
    assert(r.body.success === true);
    assert(Array.isArray(r.body.data.episodes), 'episodes should be array');
    assert(r.body.data.episodes.length > 0,     'episodes should be non-empty');
  });

  await test('GET /api/tv/popular → non-empty', async () => {
    const r = await get('/api/tv/popular?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
  });

  await test('GET /api/tv/trending → non-empty', async () => {
    const r = await get('/api/tv/trending?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
  });

  await test('GET /api/tv/top_rated → non-empty', async () => {
    const r = await get('/api/tv/top_rated?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
  });

  await test('GET /api/tv/on_the_air → non-empty', async () => {
    const r = await get('/api/tv/on_the_air?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
  });

  await test('GET /api/tv/genres → genre list', async () => {
    const r = await get('/api/tv/genres?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(Array.isArray(r.body.data.genres));
    assert(r.body.data.genres.length > 0);
  });

  await test('GET /api/tv/456/season/1/episode/1/stream → episode + stream_url', async () => {
    const r = await get('/api/tv/456/season/1/episode/1/stream?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.success === true);
    assert(r.body.data.episode,              'episode field missing');
    assert(typeof r.body.data.stream_url === 'string', 'stream_url missing');
  });

  // ── People ────────────────────────────────────────────────────────────────
  console.log('\n\x1b[2m People\x1b[0m');

  await test('GET /api/person/6193 → person detail with credits', async () => {
    const r = await get('/api/person/6193?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.success === true);
    const d = r.body.data;
    assert(typeof d.name === 'string',         'name missing');
    assert(d.movie_credits,                    'movie_credits missing');
    assert(Array.isArray(d.movie_credits.cast), 'movie cast should be array');
    assert(d.tv_credits,                       'tv_credits missing');
    assert(d.images,                           'images missing');
  });

  await test('GET /api/person/popular → paginated list', async () => {
    const r = await get('/api/person/popular?tmdb_key=' + TMDB_KEY);
    assert(r.status === 200, 'Expected 200');
    assert(Array.isArray(r.body.data.results), 'results should be array');
    assert(r.body.data.results.length > 0,     'results should be non-empty');
  });

  // ── Search ────────────────────────────────────────────────────────────────
  console.log('\n\x1b[2m Search\x1b[0m');

  await test('GET /api/search/multi?q=Inception → results', async () => {
    const r = await get('/api/search/multi?q=Inception&tmdb_key=' + TMDB_KEY);
    assert(r.status === 200, 'Expected 200, got ' + r.status);
    assert(r.body.success === true);
    assert(Array.isArray(r.body.data.results), 'results should be array');
    assert(r.body.data.results.length > 0,     'should return results');
  });

  await test('GET /api/search/multi with no q → 400', async () => {
    const r = await get('/api/search/multi?tmdb_key=' + TMDB_KEY);
    assert(r.status === 400, 'Expected 400, got ' + r.status);
    assert(r.body.success === false);
  });

  await test('GET /api/search/movie?q=Matrix → movie results', async () => {
    const r = await get('/api/search/movie?q=Matrix&tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
    assert(r.body.data.results[0].title, 'results should have title');
  });

  await test('GET /api/search/tv?q=Breaking Bad → TV results', async () => {
    const r = await get('/api/search/tv?q=Breaking%20Bad&tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
    assert(r.body.data.results[0].name, 'results should have name');
  });

  await test('GET /api/search/person?q=Tom Hardy → person results', async () => {
    const r = await get('/api/search/person?q=Tom%20Hardy&tmdb_key=' + TMDB_KEY);
    assert(r.status === 200);
    assert(r.body.data.results.length > 0);
    assert(r.body.data.results[0].name, 'results should have name');
  });

  // ── Error handling ────────────────────────────────────────────────────────
  console.log('\n\x1b[2m Error Handling\x1b[0m');

  await test('Unknown route → 404 with JSON error', async () => {
    const r = await get('/api/notarealendpoint');
    assert(r.status === 404, 'Expected 404, got ' + r.status);
    assert(r.body !== null, 'Response should be JSON');
    assert(r.body.success === false, 'success should be false');
  });

  await test('TMDB endpoint without key → 400 with helpful error', async () => {
    const r = await get('/api/movie/popular');
    assert(r.status === 400, 'Expected 400, got ' + r.status);
    assert(r.body.success === false);
    assert(typeof r.body.error === 'string', 'error message should be string');
    assert(r.body.error.toLowerCase().includes('tmdb'), 'error should mention TMDB');
  });

  await test('CORS headers present on all responses', async () => {
    const r = await new Promise((resolve, reject) => {
      http.get(BASE + '/api/health', res => {
        resolve(res.headers);
      }).on('error', reject);
    });
    assert(r['access-control-allow-origin'] === '*', 'CORS header missing');
  });

  await test('Response envelope always has success field', async () => {
    const routes = ['/api/health', '/api/analytics', '/api/stream'];
    for (const route of routes) {
      const r = await get(route);
      assert('success' in r.body, route + ': missing success field');
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n \x1b[1m─────────────────────────────────────────\x1b[0m');
  var colour = failed === 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(
    ' ' + colour + passed + ' passed\x1b[0m,',
    failed > 0 ? '\x1b[31m' + failed + ' failed\x1b[0m,' : '',
    total + ' total\n'
  );

  if (failed > 0) process.exit(1);
}

run().catch(function (e) {
  console.error('\x1b[31mTest runner crashed:\x1b[0m', e.message);
  process.exit(1);
});
