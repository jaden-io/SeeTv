var API=(function(){
  var key=function(){return CONFIG.TMDB_KEY};
  function request(path,params){
    var qs=new URLSearchParams(Object.assign({tmdb_key:key()},params||{})).toString();
    return fetch(path+(qs?'?'+qs:''),{headers:{Accept:'application/json'}}).then(function(r){return r.json().catch(function(){return {success:false,error:'Invalid server response'}}).then(function(body){if(!r.ok||body.success===false)throw new Error(body.error||('Request failed ('+r.status+')'));return body.data})});
  }
  return {
    stream:{resolve:function(id,season,episode){var p={id:id};if(season)p.s=season;if(episode)p.e=episode;return request('/api/stream',p)}},
    movie:{detail:function(id){return request('/api/movie/'+id)},streamInfo:function(id){return request('/api/movie/'+id+'/stream-info')},popular:function(page){return request('/api/movie/popular',{page:page||1})},trending:function(page){return request('/api/movie/trending',{page:page||1})},topRated:function(page){return request('/api/movie/top_rated',{page:page||1})},nowPlaying:function(page){return request('/api/movie/now_playing',{page:page||1})},upcoming:function(page){return request('/api/movie/upcoming',{page:page||1})},genres:function(){return request('/api/movie/genres')},discover:function(opts){return request('/api/movie/discover',opts||{})}},
    tv:{detail:function(id){return request('/api/tv/'+id)},season:function(id,s){return request('/api/tv/'+id+'/season/'+s)},epStream:function(id,s,e){return request('/api/tv/'+id+'/season/'+s+'/episode/'+e+'/stream')},popular:function(page){return request('/api/tv/popular',{page:page||1})},trending:function(page){return request('/api/tv/trending',{page:page||1})},topRated:function(page){return request('/api/tv/top_rated',{page:page||1})},onTheAir:function(page){return request('/api/tv/on_the_air',{page:page||1})},genres:function(){return request('/api/tv/genres')},discover:function(opts){return request('/api/tv/discover',opts||{})}},
    person:{detail:function(id){return request('/api/person/'+id)},popular:function(page){return request('/api/person/popular',{page:page||1})}},
    search:{multi:function(q,page){return request('/api/search/multi',{q:q,page:page||1})},movie:function(q,page){return request('/api/search/movie',{q:q,page:page||1})},tv:function(q,page){return request('/api/search/tv',{q:q,page:page||1})},person:function(q,page){return request('/api/search/person',{q:q,page:page||1})}},
    system:{health:function(){return request('/api/health',{})},analytics:function(){return request('/api/analytics',{})}}
  };
})();
