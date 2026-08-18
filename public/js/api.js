var API = (function () {
  var key = function () { return CONFIG.TMDB_KEY; };

  function get(path, params) {
    var qs = new URLSearchParams(Object.assign({ tmdb_key: key() }, params || {})).toString();
    return fetch(path + '?' + qs).then(function (r) { return r.json(); }).then(function (j) { return j.data; });
  }

  return {
    stream: {
      resolve: function (id, season, episode) {
        var p = { id: id };
        if (season)  p.s = season;
        if (episode) p.e = episode;
        return get('/api/stream', p);
      },
    },

    movie: {
      detail:     function (id)     { return get('/api/movie/' + id); },
      streamInfo: function (id)     { return get('/api/movie/' + id + '/stream-info'); },
      popular:    function (page)   { return get('/api/movie/popular',    { page: page || 1 }); },
      trending:   function (page)   { return get('/api/movie/trending',   { page: page || 1 }); },
      topRated:   function (page)   { return get('/api/movie/top_rated',  { page: page || 1 }); },
      nowPlaying: function (page)   { return get('/api/movie/now_playing',{ page: page || 1 }); },
      upcoming:   function (page)   { return get('/api/movie/upcoming',   { page: page || 1 }); },
      genres:     function ()       { return get('/api/movie/genres'); },
      discover:   function (opts)   { return get('/api/movie/discover',   opts || {}); },
    },

    tv: {
      detail:    function (id)             { return get('/api/tv/' + id); },
      season:    function (id, s)          { return get('/api/tv/' + id + '/season/' + s); },
      epStream:  function (id, s, e)       { return get('/api/tv/' + id + '/season/' + s + '/episode/' + e + '/stream'); },
      popular:   function (page)           { return get('/api/tv/popular',    { page: page || 1 }); },
      trending:  function (page)           { return get('/api/tv/trending',   { page: page || 1 }); },
      topRated:  function (page)           { return get('/api/tv/top_rated',  { page: page || 1 }); },
      onTheAir:  function (page)           { return get('/api/tv/on_the_air', { page: page || 1 }); },
      genres:    function ()               { return get('/api/tv/genres'); },
      discover:  function (opts)           { return get('/api/tv/discover',   opts || {}); },
    },

    person: {
      detail:  function (id)   { return get('/api/person/' + id); },
      popular: function (page) { return get('/api/person/popular', { page: page || 1 }); },
    },

    search: {
      multi:  function (q, page) { return get('/api/search/multi',  { q: q, page: page || 1 }); },
      movie:  function (q, page) { return get('/api/search/movie',  { q: q, page: page || 1 }); },
      tv:     function (q, page) { return get('/api/search/tv',     { q: q, page: page || 1 }); },
      person: function (q, page) { return get('/api/search/person', { q: q, page: page || 1 }); },
    },

    system: {
      health:    function () { return fetch('/api/health').then(function (r) { return r.json(); }).then(function (j) { return j.data; }); },
      analytics: function () { return fetch('/api/analytics').then(function (r) { return r.json(); }).then(function (j) { return j.data; }); },
    },
  };
})();
