var UI = (function () {
  var IMG = CONFIG.TMDB_IMAGE_BASE;

  function stars(rating) {
    if (!rating) return '';
    return '<svg width="11" height="11" fill="currentColor" viewBox="0 0 24 24" style="margin-right:3px"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>' + parseFloat(rating).toFixed(1);
  }

  function year(dateStr) {
    return dateStr ? dateStr.slice(0, 4) : '';
  }

  function cardHtml(item, type, withModal) {
    var isTv    = type === 'tv';
    var title   = item.title || item.name || '';
    var poster  = item.poster_path ? IMG + 'w342' + item.poster_path : '';
    var yr      = year(item.release_date || item.first_air_date);
    var rating  = item.vote_average;
    var watchUrl = '/watch?id=' + item.id + (isTv ? '&s=1&e=1' : '');
    var clickHandler = withModal
      ? 'openModal(' + item.id + ',"' + type + '")'
      : 'window.location="' + watchUrl + '"';

    return '<div class="card" onclick="' + clickHandler + '">'
      + (poster
          ? '<img class="card-poster" src="' + poster + '" alt="' + title.replace(/"/g, '&quot;') + '" loading="lazy">'
          : '<div class="card-poster skeleton"></div>')
      + '<div class="card-hover-overlay">'
      + '<div class="play-btn-sm">'
      + '<svg width="14" height="14" fill="#000" viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>'
      + '</div>'
      + '<div style="font-size:.75rem;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + title + '</div>'
      + '</div>'
      + '<div class="card-info">'
      + '<div class="card-title">' + title + '</div>'
      + '<div class="card-meta">'
      + (yr ? '<span>' + yr + '</span>' : '')
      + (rating ? '<span class="rating">' + stars(rating) + '</span>' : '')
      + '</div>'
      + '</div>'
      + '</div>';
  }

  function showToast(msg, type) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;border-radius:8px;font-size:.875rem;font-weight:600;color:#fff;'
      + (type === 'error' ? 'background:#e85454' : 'background:#4bce97')
      + ';box-shadow:0 8px 24px rgba(0,0,0,.4);transform:translateY(20px);opacity:0;transition:all .25s';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () {
      t.style.transform = 'translateY(0)';
      t.style.opacity   = '1';
    });
    setTimeout(function () {
      t.style.transform = 'translateY(20px)';
      t.style.opacity   = '0';
      setTimeout(function () { t.remove(); }, 300);
    }, 3000);
  }

  return { cardHtml: cardHtml, stars: stars, year: year, showToast: showToast };
})();
