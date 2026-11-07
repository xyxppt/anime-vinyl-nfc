/* Anime Vinyl - Anime Poster / 電影特典情報模組
 * 獨立於 app.js；路由 #poster, #poster/cinema/{id}
 * 集合：movies / bonuses / cinemas / branches / stock_reports / favorites
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var authAPI = null, dbAPI = null, currentUser = null;
  var movies = [], bonuses = [], cinemas = [], branches = [], reports = [], favorites = [];
  var mySubs = { movies: [], bonuses: [], stock_reports: [] };
  var activeTab = 'movies', searchText = '', busy = false, lastRefresh = 0;
  var cinemaCityFilter = ''; 
  var currentCinemaId = null; 

  var ADMIN_UIDS = ['CHcuRjAB6eWdmIiV9QGH209mSa93'];

  var DEFAULT_CINEMAS = {
    // ... (保留你原本的全台影城清單陣列，為節省篇幅這裡不重複貼，請直接沿用上一版的 DEFAULT_CINEMAS 內容)
    "台北市": ["台北信義威秀影城","MUVIE CINEMAS 台北松仁","誠品電影院","台北大巨蛋秀泰影城"],
    "台中市": ["台中中港新光影城","台中大遠百威秀影城","MUVIE CINEMAS 台中 TIGER CITY"],
    // 請自行把上一版的完整清單貼回來
  };

  function isAdmin() { return !!currentUser && ADMIN_UIDS.indexOf(currentUser.uid) !== -1; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }
  function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function stamp() { return new Date().toISOString(); }
  function dateText(v) { if (!v) return '未提供'; var d = new Date(v); return isNaN(d) ? '未提供' : d.toLocaleDateString('zh-TW'); }
  function notify(message, ms) {
    var t = $('toast');
    if (t) { t.textContent = message; t.hidden = false; clearTimeout(notify.timer); notify.timer = setTimeout(function () { t.hidden = true; }, ms || 3500); }
    else window.alert(message);
  }
  function db() { return dbAPI && dbAPI.db; }
  function col(name) { return dbAPI.collection(db(), name); }
  function doc(name, key) { return dbAPI.doc(db(), name, key); }
  function set(name, key, data) { return dbAPI.setDoc(doc(name, key), data); }
  function rows(snap) { var out = []; snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); }); return out; }

  function canDelete(item, ownerField) {
    if (!currentUser || !item) return false;
    if (isAdmin()) return true;
    var owner = item[ownerField || 'createdBy'];
    return owner === currentUser.uid;
  }

  function checkCooldown() {
    var last = localStorage.getItem('anime-vinyl:report-cooldown');
    if (last) {
      var diff = Date.now() - parseInt(last, 10);
      if (diff < 180000) {
        var left = Math.ceil((180000 - diff) / 1000);
        notify('為了防止洗版，請等待 ' + left + ' 秒後再回報。', 5000);
        return false;
      }
    }
    return true;
  }
  function setCooldown() {
    localStorage.setItem('anime-vinyl:report-cooldown', Date.now().toString());
  }

  function showPosterRoute() {
    var isPoster = location.hash === '#poster' || location.hash.indexOf('#poster/') === 0;
    var view = $('viewPoster');
    if (!view) return;
    view.hidden = !isPoster;
    
    if (isPoster) {
      ['viewEdit','viewPlay','viewError','viewHome','viewNfc','viewExplore'].forEach(function (x) { var el = $(x); if (el) el.hidden = true; });
      document.body.classList.remove('play-mode');
      
      var match = location.hash.match(/^#poster\/cinema\/(.+)$/);
      if (match) {
        currentCinemaId = match[1];
        activeTab = 'cinema-detail';
      } else {
        currentCinemaId = null;
        if (activeTab === 'cinema-detail') activeTab = 'cinemas';
      }
      render();
    }
  }

  async function refreshData(force) {
    if (!dbAPI || !db()) return;
    if (busy && !force) return;
    if (!force && Date.now() - lastRefresh < 1500) return;
    busy = true;
    try {
      var snaps = await Promise.all([
        dbAPI.getDocs(dbAPI.query(col('movies'), dbAPI.limit(300))),
        dbAPI.getDocs(dbAPI.query(col('bonuses'), dbAPI.limit(500))),
        dbAPI.getDocs(dbAPI.query(col('cinemas'), dbAPI.limit(200))),
        dbAPI.getDocs(dbAPI.query(col('branches'), dbAPI.limit(800))),
        dbAPI.getDocs(dbAPI.query(col('stock_reports'), dbAPI.limit(800)))
      ]);
      
      // 只顯示已發布的電影，或是自己建立的電影
      movies = rows(snaps[0]).filter(function(m) { return m.status === 'published' || m.createdBy === (currentUser ? currentUser.uid : null); });
      bonuses = rows(snaps[1]);
      cinemas = rows(snaps[2]);
      branches = rows(snaps[3]);
      reports = rows(snaps[4]);
      
      if (currentUser) {
        var fs = await dbAPI.getDocs(dbAPI.query(col('favorites'), dbAPI.where('uid', '==', currentUser.uid), dbAPI.limit(300)));
        favorites = rows(fs);
        await loadMySubs();
      } else {
        favorites = [];
        mySubs = { movies: [], bonuses: [], stock_reports: [] };
      }
      lastRefresh = Date.now();
      render();
    } catch (e) {
      console.error('電影特典資料載入失敗', e);
      posterMessage('讀取資料失敗：' + (e.code || e.message), true);
    } finally { busy = false; }
  }

  async function loadMySubs() {
    if (!currentUser) return;
    try {
      var ms = await dbAPI.getDocs(dbAPI.query(col('movies'), dbAPI.where('createdBy', '==', currentUser.uid), dbAPI.limit(100)));
      var bs = await dbAPI.getDocs(dbAPI.query(col('bonuses'), dbAPI.where('createdBy', '==', currentUser.uid), dbAPI.limit(200)));
      var rs = await dbAPI.getDocs(dbAPI.query(col('stock_reports'), dbAPI.where('reporterUid', '==', currentUser.uid), dbAPI.limit(200)));
      mySubs.movies = rows(ms);
      mySubs.bonuses = rows(bs);
      mySubs.stock_reports = rows(rs);
    } catch (e) {
      console.warn('讀取我的提交失敗', e);
    }
  }

  function posterMessage(text, error) {
    var app = $('posterApp'); if (!app) return;
    app.innerHTML = '<div class="poster-notice ' + (error ? 'error' : '') + '">' + esc(text) + '</div>';
  }

  function header() {
    var adminNote = isAdmin() ? '<div class="poster-notice" style="margin-bottom:12px">✅ 管理員模式</div>' : '';
    if (activeTab === 'cinema-detail') {
      return '<div style="margin-bottom:12px"><a href="#poster" style="color:var(--accent); text-decoration:none; font-size:14px;">← 返回影城列表</a></div>';
    }
    return '<section class="poster-hero"><div><span class="poster-kicker">ANIME VINYL</span><h2>電影特典情報</h2><p>查詢電影特典、影城分店回報與最新收藏情報。</p></div><div class="poster-hero-mark">🎬</div></section>' +
      adminNote +
      '<div class="poster-toolbar"><input id="posterSearch" type="search" placeholder="搜尋電影、作品或特典…" value="' + esc(searchText) + '"><button class="poster-btn primary" data-action="add-movie">＋ 新增電影／特典</button></div>' +
      '<nav class="poster-tabs">' +
        '<button data-tab="movies" class="' + (activeTab === 'movies' ? 'active' : '') + '">電影情報</button>' +
        '<button data-tab="bonuses" class="' + (activeTab === 'bonuses' ? 'active' : '') + '">特典列表</button>' +
        '<button data-tab="cinemas" class="' + (activeTab === 'cinemas' ? 'active' : '') + '">影城分店</button>' +
        '<button data-tab="reports" class="' + (activeTab === 'reports' ? 'active' : '') + '">最新回報</button>' +
        (currentUser ? '<button data-tab="mine" class="' + (activeTab === 'mine' ? 'active' : '') + '">我的提交</button>' : '') +
        (isAdmin() ? '<button data-tab="admin" class="' + (activeTab === 'admin' ? 'active' : '') + '">管理後台</button>' : '') +
      '</nav>';
  }

  function movieCard(m) {
    var count = bonuses.filter(function (b) { return b.movieId === m.id; }).length;
    var delBtn = canDelete(m, 'createdBy') ? '<button type="button" class="poster-btn danger" data-del="movies" data-id="' + esc(m.id) + '" title="刪除電影" onclick="event.stopPropagation()">🗑</button>' : '';
    var pendingTag = m.status === 'pending' ? '<span class="poster-status unknown" style="position:absolute;top:8px;left:8px">待確認</span>' : '';
    return '<div class="poster-card-wrap" style="position:relative">' + pendingTag +
      '<button class="poster-card" data-action="movie" data-id="' + esc(m.id) + '">' +
        (m.posterUrl ? '<img src="' + esc(m.posterUrl) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '<span class="poster-placeholder">🎞️</span>') +
        '<span class="poster-card-copy"><strong>' + esc(m.title) + '</strong><small>' + esc(m.releaseDate ? dateText(m.releaseDate) + ' 上映' : '上映日期未提供') + '</small><small>' + count + ' 項特典情報</small></span>' +
      '</button>' +
      (delBtn ? '<div style="position:absolute;top:8px;right:8px;z-index:2">' + delBtn + '</div>' : '') +
    '</div>';
  }

  function statusFor(bonusId, branchId) {
    var found = reports.filter(function (r) { return r.bonusId === bonusId && r.branchId === branchId; }).sort(function (a,b) { return new Date(b.createdAt) - new Date(a.createdAt); })[0];
    if (!found) return { label: '尚未確認', cls: 'unknown' };
    var age = Date.now() - new Date(found.createdAt).getTime();
    var expired = !isFinite(age) || age > 24 * 60 * 60 * 1000;
    return {
      label: expired ? '資訊已過期' : found.stockStatus,
      cls: expired ? 'unknown' : (found.stockStatus === '尚有庫存' ? 'available' : found.stockStatus === '已兌換完畢' ? 'soldout' : 'unknown')
    };
  }

  function bonusCard(b) {
    var m = movies.find(function (x) { return x.id === b.movieId; });
    var delBtn = canDelete(b, 'createdBy') ? '<button type="button" class="poster-btn danger" data-del="bonuses" data-id="' + esc(b.id) + '" title="刪除特典">🗑</button>' : '';
    return '<article class="poster-bonus" style="position:relative">' + (delBtn ? '<div style="position:absolute;top:10px;right:10px;z-index:2">' + delBtn + '</div>' : '') +
      '<div class="poster-bonus-top">' +
        (b.imageUrl ? '<img src="' + esc(b.imageUrl) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '<span class="poster-placeholder small">🎁</span>') +
        '<div><strong>' + esc(b.title) + '</strong><small>' + esc(m ? m.title : '電影資料') + ' · ' + esc(b.type || '其他特典') + '</small><small>' + esc(dateText(b.startDate)) + ' ～ ' + esc(dateText(b.endDate)) + '</small></div>' +
      '</div>' +
      '<p>' + esc(b.conditions || '兌換條件未提供') + '</p>' +
      '<div class="poster-bonus-foot"><span>' + branches.length + ' 間分店</span><button class="poster-btn" data-action="report" data-id="' + esc(b.id) + '">回報庫存</button></div>' +
      '<div class="poster-branch-status">' + branches.slice(0, 4).map(function (br) { var s = statusFor(b.id, br.id); return '<span><b>' + esc(br.name) + '</b><i class="poster-status ' + s.cls + '">' + esc(s.label) + '</i></span>'; }).join('') + '</div>' +
    '</article>';
  }

  function renderMovies() {
    var q = searchText.toLowerCase();
    var list = movies.filter(function (m) { return (m.title + ' ' + (m.alias || '') + ' ' + (m.description || '')).toLowerCase().indexOf(q) !== -1; });
    return '<div class="poster-section-head"><h3>最新電影</h3><span>' + list.length + ' 部</span></div><div class="poster-movie-grid">' +
      (list.length ? list.map(movieCard).join('') : '<p class="poster-empty">目前沒有符合條件的電影。</p>') + '</div>';
  }

  function renderBonuses() {
    var q = searchText.toLowerCase();
    var list = bonuses.filter(function (b) { var m = movies.find(function (x) { return x.id === b.movieId; }); return (b.title + ' ' + (m ? m.title : '') + ' ' + (b.type || '')).toLowerCase().indexOf(q) !== -1; });
    return '<div class="poster-section-head"><h3>電影特典</h3><span>' + list.length + ' 項</span></div><div class="poster-bonus-grid">' +
      (list.length ? list.map(bonusCard).join('') : '<p class="poster-empty">目前沒有符合條件的特典。</p>') + '</div>';
  }

  function renderCinemas() {
    var cities = branches.map(function (b) { return b.city; }).filter(Boolean);
    var uniqueCities = Array.from(new Set(cities)).sort();
    var html = '<div class="poster-section-head" style="flex-wrap:wrap"><h3>全台影城分店</h3>' +
      '<select id="cinemaCitySelect" class="poster-btn" style="padding:6px 12px; border-radius:8px; font-weight:normal; background:#171d29; color:#fff;">' +
        '<option value="">所有縣市</option>' +
        uniqueCities.map(function (c) { return '<option value="' + esc(c) + '" ' + (cinemaCityFilter === c ? 'selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
      '</select></div>';

    var filtered = branches;
    if (cinemaCityFilter) filtered = branches.filter(function (b) { return b.city === cinemaCityFilter; });
    if (searchText) {
      var q = searchText.toLowerCase();
      filtered = filtered.filter(function (b) { return (b.name + ' ' + (b.city||'')).toLowerCase().indexOf(q) !== -1; });
    }
    var grouped = {};
    filtered.forEach(function (b) { var c = b.city || '其他'; if (!grouped[c]) grouped[c] = []; grouped[c].push(b); });

    var keys = Object.keys(grouped).sort();
    if (!keys.length) return html + '<p class="poster-empty">找不到影城分店。</p>';

    html += '<div style="display:flex;flex-direction:column;gap:20px;margin-top:10px">';
    keys.forEach(function (city) {
      html += '<div><h4 style="margin:0 0 10px 0;color:var(--accent);font-size:15px;">📍 ' + esc(city) + '</h4>';
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;">';
      grouped[city].sort(function(a,b){return a.name.localeCompare(b.name);}).forEach(function (br) {
        var cinema = cinemas.find(function (c) { return c.id === br.cinemaId; });
        var reportCount = reports.filter(function (r) { return r.branchId === br.id; }).length;
        html += '<div style="padding:12px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.02);cursor:pointer;" data-action="go-cinema" data-id="' + esc(br.id) + '">' +
          '<strong style="color:#fff;font-size:14px;display:block;margin-bottom:4px">' + esc(br.name) + '</strong>' +
          '<small style="color:var(--text-muted);display:block;margin-bottom:8px">' + esc(cinema ? cinema.name : '未知影城') + '</small>' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<span style="font-size:12px;color:var(--text-muted)">共 ' + reportCount + ' 筆回報</span>' +
            '<span style="color:var(--accent);font-size:12px;">查看特典 ❯</span>' +
          '</div></div>';
      });
      html += '</div></div>';
    });
    return html + '</div>';
  }

  function renderCinemaDetail() {
    var br = branches.find(function(b){ return b.id === currentCinemaId; });
    if (!br) return '<p class="poster-empty">找不到該影城。</p>';
    var cinema = cinemas.find(function(c){ return c.id === br.cinemaId; });
    var myReports = reports.filter(function(r){ return r.branchId === br.id; });
    var relatedBonuses = myReports.map(function(r){ return { report: r, bonus: bonuses.find(function(x){ return x.id === r.bonusId; }) }; }).filter(function(x){ return x.bonus; });

    var html = '<div class="poster-section-head"><h3>' + esc(br.name) + '</h3><span style="color:var(--accent)">' + esc(cinema ? cinema.name : '') + ' · ' + esc(br.city) + '</span></div>';
    html += '<div class="poster-toolbar" style="margin-bottom:20px;"><button class="poster-btn primary" style="width:100%;padding:14px;font-size:16px;" data-action="report-here">＋ 回報此影城特典</button></div>';
    html += '<div class="poster-section-head"><h3>目前特典狀態</h3><span>共 ' + relatedBonuses.length + ' 筆</span></div>';

    if (!relatedBonuses.length) {
      return html + '<div style="padding:40px 20px; text-align:center; border:1px dashed rgba(255,255,255,.15); border-radius:16px; margin-top:10px;">' +
        '<p class="poster-muted" style="font-size:15px; margin-bottom:16px;">這間影城目前有 0 筆特典回報</p>' +
        '<button class="poster-btn primary" style="font-size:15px; padding:10px 24px;" data-action="report-here">成為第一個回報的人</button></div>';
    }

    html += '<div class="poster-report-list">';
    relatedBonuses.sort(function(a,b){ return new Date(b.report.createdAt) - new Date(a.report.createdAt); }).forEach(function(item){
      var b = item.bonus, r = item.report;
      var m = movies.find(function(x){ return x.id === b.movieId; });
      var isExpired = (Date.now() - new Date(r.createdAt).getTime()) > 24*60*60*1000;
      var statusCls = isExpired ? 'unknown' : (r.stockStatus === '尚有庫存' ? 'available' : r.stockStatus === '已兌換完畢' ? 'soldout' : 'unknown');
      var statusTxt = isExpired ? '資訊已過期' : r.stockStatus;
      var delBtn = canDelete(r, 'reporterUid') ? '<button type="button" class="poster-btn danger" data-del="stock_reports" data-id="' + esc(r.id) + '" title="刪除">🗑</button>' : '';
      html += '<article style="display:flex;align-items:flex-start;gap:12px; padding:16px; margin-bottom:10px; background:rgba(255,255,255,.02); border:1px solid rgba(255,255,255,.08); border-radius:12px;">' +
        '<div style="flex:1"><strong style="color:#fff;font-size:15px;display:block;margin-bottom:4px">' + esc(m ? m.title : '未知電影') + ' - ' + esc(b.title) + '</strong>' +
        '<small style="color:var(--text-muted);display:block;margin-bottom:8px">回報時間：' + esc(dateText(r.createdAt)) + (r.note ? ' · ' + esc(r.note) : '') + '</small></div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;"><span class="poster-status ' + statusCls + '">' + esc(statusTxt) + '</span>' + delBtn + '</div></article>';
    });
    return html + '</div>';
  }

  function renderReports() {
    var list = reports.slice().sort(function (a,b) { return new Date(b.createdAt) - new Date(a.createdAt); }).slice(0, 100);
    return '<div class="poster-section-head"><h3>最新庫存回報</h3><span>即時顯示</span></div><div class="poster-report-list">' +
      (list.length ? list.map(function (r) {
        var b = bonuses.find(function (x) { return x.id === r.bonusId; });
        var br = branches.find(function (x) { return x.id === r.branchId; });
        var m = b && movies.find(function (x) { return x.id === b.movieId; });
        var delBtn = canDelete(r, 'reporterUid') ? '<button type="button" class="poster-btn danger" data-del="stock_reports" data-id="' + esc(r.id) + '" title="刪除回報">🗑</button>' : '';
        return '<article style="display:flex;align-items:center;gap:10px"><div style="flex:1"><strong>' + esc(m ? m.title : '電影') + ' · ' + esc(b ? b.title : '特典') + '</strong><small>' + esc(br ? br.name : '分店') + ' · ' + esc(dateText(r.createdAt)) + '</small></div><span class="poster-status ' + (r.stockStatus === '尚有庫存' ? 'available' : 'soldout') + '">' + esc(r.stockStatus) + '</span>' + delBtn + '</article>';
      }).join('') : '<p class="poster-empty">目前還沒有任何回報。</p>') + '</div>';
  }

  function renderMine() {
    if (!currentUser) return '<p class="poster-empty">請先登入。</p>';
    var all = [];
    mySubs.movies.forEach(function (m) { all.push({ type: '電影', title: m.title + (m.status==='pending'?' (待確認)':''), status: m.status, at: m.createdAt, id: m.id, collection: 'movies', owner: 'createdBy', raw: m }); });
    mySubs.bonuses.forEach(function (b) { all.push({ type: '特典', title: b.title, status: b.status, at: b.createdAt, id: b.id, collection: 'bonuses', owner: 'createdBy', raw: b }); });
    mySubs.stock_reports.forEach(function (r) { all.push({ type: '庫存回報', title: r.stockStatus + (r.note ? '（' + r.note + '）' : ''), status: r.status, at: r.createdAt, id: r.id, collection: 'stock_reports', owner: 'reporterUid', raw: r }); });
    all.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    return '<div class="poster-section-head"><h3>我的提交</h3><span>' + all.length + ' 筆</span></div><div class="poster-report-list">' +
      (all.length ? all.map(function (x) {
        var delBtn = canDelete(x.raw, x.owner) ? '<button type="button" class="poster-btn danger" data-del="' + x.collection + '" data-id="' + esc(x.id) + '" title="刪除">🗑</button>' : '';
        return '<article style="display:flex;align-items:center;gap:10px"><div style="flex:1"><strong>' + esc(x.type) + '：' + esc(x.title) + '</strong><small>' + esc(dateText(x.at)) + '</small></div>' + (x.status === 'pending' ? '<span class="poster-status unknown">待審核</span>' : '') + delBtn + '</article>';
      }).join('') : '<p class="poster-empty">你還沒有送出任何資料。</p>') + '</div>';
  }

  function renderAdmin() {
    if (!isAdmin()) return '<p class="poster-empty">此頁面僅限管理員使用。</p>';
    var importBtn = '<div style="padding:16px; background:rgba(0,229,255,.05); border:1px solid var(--accent); border-radius:14px; margin-bottom:16px;">' +
      '<h4 style="color:var(--accent); margin:0 0 8px 0;">🚀 快速初始化</h4>' +
      '<button id="importCinemasBtn" class="poster-btn primary" style="width:100%; font-size:16px; padding:12px; margin-top:8px;">一鍵匯入全台影城</button></div>';
    return '<div class="poster-section-head"><h3>管理後台</h3></div>' + importBtn +
      '<div style="padding:16px; background:rgba(255,255,255,.02); border:1px solid rgba(255,255,255,.08); border-radius:14px;">' +
      '<h4 style="color:#fff; margin:0 0 8px 0;">🛡️ 黑名單管理</h4>' +
      '<p style="font-size:13px; color:var(--text-muted);">若發現惡意使用者，請至 Firebase Console 的 <code>users</code> 集合，將 <code>status</code> 設為 <code>banned</code>。</p></div>';
  }

  function render() {
    var app = $('posterApp'); if (!app) return;
    if (activeTab === 'cinema-detail') app.innerHTML = header() + '<section class="poster-content">' + renderCinemaDetail() + '</section>';
    else {
      var body = activeTab === 'movies' ? renderMovies() : activeTab === 'bonuses' ? renderBonuses() : activeTab === 'cinemas' ? renderCinemas() : activeTab === 'reports' ? renderReports() : activeTab === 'mine' ? renderMine() : renderAdmin();
      app.innerHTML = header() + '<section class="poster-content">' + body + '</section>';
    }

    var input = $('posterSearch');
    if (input) input.addEventListener('input', function () { searchText = input.value; var pos = input.selectionStart; render(); var next = $('posterSearch'); if (next) { next.focus(); try { next.setSelectionRange(pos, pos); } catch (e) {} } });
    var citySelect = $('cinemaCitySelect');
    if (citySelect) citySelect.addEventListener('change', function () { cinemaCityFilter = this.value; render(); });

    app.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { activeTab = b.dataset.tab; history.replaceState(null, '', '#poster'); render(); });
    });
    
    app.querySelectorAll('[data-action]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        var act = b.dataset.action;
        if (act === 'add-movie') showMovieForm();
        else if (act === 'movie') showMovieDetail(b.dataset.id);
        else if (act === 'report') showReportForm(b.dataset.id);
        else if (act === 'go-cinema') { e.preventDefault(); e.stopPropagation(); window.location.hash = '#poster/cinema/' + b.dataset.id; }
        else if (act === 'report-here') showReportForm(null, currentCinemaId);
      });
    });
    
    app.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); askDelete(b.dataset.del, b.dataset.id); });
    });
    
    var impBtn = $('importCinemasBtn');
    if (impBtn) impBtn.addEventListener('click', importDefaultCinemas);
  }

  // 一鍵匯入 (維持不變)
  async function importDefaultCinemas() {
    if (!isAdmin()) return;
    if (!confirm('確定要匯入全台預設影城資料嗎？')) return;
    var btn = $('importCinemasBtn'); if (btn) { btn.disabled = true; btn.textContent = '匯入中...'; }
    notify('開始匯入影城資料...', 5000);
    try {
      var cinemaMap = {}; 
      for (var city in DEFAULT_CINEMAS) {
        var cid = uid();
        await set('cinemas', cid, { name: city + '在地影城', status: 'published', createdAt: stamp(), createdBy: currentUser.uid });
        cinemaMap[city] = cid;
      }
      var count = 0;
      for (var cityName in DEFAULT_CINEMAS) {
        var cid = cinemaMap[cityName];
        for (var i = 0; i < DEFAULT_CINEMAS[cityName].length; i++) {
          await set('branches', uid(), { cinemaId: cid, name: DEFAULT_CINEMAS[cityName][i], city: cityName, address: '', status: 'published', createdAt: stamp(), createdBy: currentUser.uid });
          count++;
        }
      }
      notify('🎉 成功匯入 ' + count + ' 間分店！', 6000);
      await refreshData(true); activeTab = 'cinemas'; render();
    } catch (e) {
      notify('匯入失敗：' + (e.code || e.message), 6000);
      if (btn) { btn.disabled = false; btn.textContent = '一鍵匯入全台影城'; }
    }
  }

  /* =========================================
     級聯刪除：解決孤兒資料
     ========================================= */
  async function askDelete(collection, id) {
    if (!currentUser) { notify('請先登入'); return; }
    
    var warning = '確定要刪除這筆資料嗎？此操作無法復原。';
    if (collection === 'movies') warning = '⚠️ 刪除電影將會「一併刪除」底下所有相關的特典與回報紀錄！確定要刪除嗎？';
    if (collection === 'bonuses') warning = '⚠️ 刪除特典將會「一併刪除」該特典的所有回報紀錄！確定要刪除嗎？';
    
    if (!confirm(warning)) return;

    try {
      // 如果是刪除電影，先找出底下所有特典，再刪除特典底下的回報
      if (collection === 'movies') {
        var bSnap = await dbAPI.getDocs(dbAPI.query(col('bonuses'), dbAPI.where('movieId', '==', id)));
        for (var bDoc of bSnap.docs) {
          var rSnap = await dbAPI.getDocs(dbAPI.query(col('stock_reports'), dbAPI.where('bonusId', '==', bDoc.id)));
          for (var rDoc of rSnap.docs) await dbAPI.deleteDoc(doc('stock_reports', rDoc.id));
          await dbAPI.deleteDoc(doc('bonuses', bDoc.id));
        }
      }
      // 如果是刪除特典，先刪除底下的回報
      if (collection === 'bonuses') {
        var rSnap2 = await dbAPI.getDocs(dbAPI.query(col('stock_reports'), dbAPI.where('bonusId', '==', id)));
        for (var rDoc2 of rSnap2.docs) await dbAPI.deleteDoc(doc('stock_reports', rDoc2.id));
      }
      
      await dbAPI.deleteDoc(doc(collection, id));
      notify('✅ 已刪除相關資料');
      refreshData(true);
    } catch (e) {
      notify('刪除失敗：' + (e.code || e.message), 6000);
    }
  }

  function modal(content) {
    var old = $('posterModal'); if (old) old.remove();
    var el = document.createElement('div'); el.id = 'posterModal'; el.className = 'poster-modal';
    el.innerHTML = '<div class="poster-modal-box"><button type="button" class="poster-modal-close" aria-label="關閉">✕</button>' + content + '</div>';
    document.body.appendChild(el);
    el.querySelector('.poster-modal-close').addEventListener('click', function () { el.remove(); });
    el.addEventListener('click', function (e) { if (e.target === el) el.remove(); });
    return el;
  }

  function showMovieForm() {
    if (!currentUser) { notify('請先登入'); return; }
    var el = modal('<h3>提交電影與特典資料</h3><p class="poster-muted" style="color:#ffb020">🛡️ 為了防止垃圾廣告，新電影會先進入「待確認」狀態，直到有人回報該電影的特典後才會自動公開。</p>' +
      '<form id="newMovieForm" class="poster-form">' +
        '<h4>電影資料</h4><label>電影名稱<input name="title" required maxlength="100"></label><label>海報圖片網址<input name="posterUrl" type="url"></label>' +
        '<h4>第一項特典 (選填)</h4><label>特典名稱<input name="bonusTitle" maxlength="50"></label><label>類型<select name="type"><option>入場特典</option><option>海報</option><option>其他</option></select></label>' +
        '<button class="poster-btn primary" type="submit">送出</button></form>');
    el.querySelector('form').addEventListener('submit', async function (e) {
      e.preventDefault();
      if (busy) return; busy = true;
      var f = new FormData(e.target);
      var movieId = uid();
      var bonusTitle = String(f.get('bonusTitle') || '').trim();
      try {
        await set('movies', movieId, {
          title: String(f.get('title')).trim(), posterUrl: String(f.get('posterUrl') || '').trim(),
          status: 'pending', createdBy: currentUser.uid, createdAt: stamp() 
        });
        if (bonusTitle) {
          await set('bonuses', uid(), { movieId: movieId, title: bonusTitle, type: String(f.get('type') || '其他'), status: 'published', createdBy: currentUser.uid, createdAt: stamp() });
          // 如果有附帶特典，直接把電影轉為公開
          await dbAPI.updateDoc(doc('movies', movieId), { status: 'published' });
        }
        el.remove(); notify('✅ 已新增！', 4000); await refreshData(true);
      } catch (err) { notify('失敗：' + (err.code || err.message)); }
      finally { busy = false; }
    });
  }

  function showMovieDetail(movieId) {
    var m = movies.find(function (x) { return x.id === movieId; }); if (!m) return;
    var bs = bonuses.filter(function (b) { return b.movieId === movieId; });
    var html = '<div class="poster-detail">' + (m.posterUrl ? '<img src="' + esc(m.posterUrl) + '" alt="">' : '') + '<div><h3>' + esc(m.title) + '</h3><p>' + esc(m.description || '暫無介紹') + '</p></div></div>' +
      '<h4>相關特典</h4><div class="poster-bonus-grid">' + (bs.length ? bs.map(bonusCard).join('') : '<p class="poster-empty">無特典。</p>') + '</div>';
    var el = modal(html);
    el.querySelectorAll('[data-action="report"]').forEach(function (b) { b.addEventListener('click', function () { el.remove(); showReportForm(b.dataset.id); }); });
  }

  /* =========================================
     回報表單：加入「模糊比對防重複」與「自動建檔」
     ========================================= */
  function showReportForm(bonusId, presetBranchId) {
    if (!currentUser) { notify('請先登入'); return; }
    if (!checkCooldown()) return;
    if (!movies.length) { notify('目前沒有電影資料可供回報'); return; }
    if (!branches.length) { notify('目前沒有影城分店'); return; }

    // 只顯示已公開的電影供選擇
    var pubMovies = movies.filter(function(m){ return m.status === 'published'; });
    if (pubMovies.length === 0) { notify('目前沒有已公開的電影'); return; }

    var movieOpts = pubMovies.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.title) + '</option>'; }).join('');
    var branchOpts = branches.map(function (br) { 
      var c = cinemas.find(function(x){return x.id===br.cinemaId;});
      return '<option value="' + esc(br.id) + '" ' + (br.id === presetBranchId ? 'selected' : '') + '>' + esc(br.city + ' · ' + (c?c.name:'') + br.name) + '</option>'; 
    }).join('');

    var el = modal('<h3>回報特典庫存</h3><form id="stockForm" class="poster-form">' +
        '<label>1. 選擇電影<select id="formMovieSelect" name="movieId" required>' + movieOpts + '</select></label>' +
        '<label>2. 選擇特典<select id="formBonusSelect" name="bonusId" required></select></label>' +
        '<div id="newBonusWrap" style="display:none; padding-left:10px; border-left:2px solid var(--accent); margin-top:8px;">' +
          '<label>輸入新特典名稱<input id="newBonusTitle" name="newBonusTitle" maxlength="50" placeholder="例如：首週入場特典海報"></label></div>' +
        '<label>3. 影城分店<select name="branchId" required>' + branchOpts + '</select></label>' +
        '<label>4. 目前狀態<select name="stockStatus"><option>尚有庫存</option><option>已兌換完畢</option></select></label>' +
        '<label>備註 (選填)<textarea name="note" maxlength="200" placeholder="例如：需要買全票"></textarea></label>' +
        '<button class="poster-btn primary" type="submit">送出回報</button></form>');

    var movieSelect = el.querySelector('#formMovieSelect');
    var bonusSelect = el.querySelector('#formBonusSelect');
    var newBonusWrap = el.querySelector('#newBonusWrap');
    var newBonusTitle = el.querySelector('#newBonusTitle');

    function updateBonusOptions() {
      var selectedMovieId = movieSelect.value;
      var relatedBonuses = bonuses.filter(function(b) { return b.movieId === selectedMovieId; });
      var opts = relatedBonuses.map(function(b) { return '<option value="' + esc(b.id) + '">' + esc(b.title) + '</option>'; }).join('');
      opts += '<option value="NEW">＋ 手動輸入新特典...</option>';
      bonusSelect.innerHTML = opts;
      
      if (bonusId && relatedBonuses.some(function(b){return b.id === bonusId;})) {
        bonusSelect.value = bonusId; newBonusWrap.style.display = 'none'; newBonusTitle.required = false;
      } else if (relatedBonuses.length === 0) {
        bonusSelect.value = 'NEW'; newBonusWrap.style.display = 'block'; newBonusTitle.required = true;
      } else {
        newBonusWrap.style.display = 'none'; newBonusTitle.required = false;
      }
    }

    movieSelect.addEventListener('change', updateBonusOptions);
    bonusSelect.addEventListener('change', function() {
      if (this.value === 'NEW') { newBonusWrap.style.display = 'block'; newBonusTitle.required = true; setTimeout(function(){ newBonusTitle.focus(); }, 100); }
      else { newBonusWrap.style.display = 'none'; newBonusTitle.required = false; }
    });

    if (bonusId) {
      var targetBonus = bonuses.find(function(b){return b.id === bonusId;});
      if (targetBonus) movieSelect.value = targetBonus.movieId;
    }
    updateBonusOptions();

    el.querySelector('form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      var finalBonusId = f.get('bonusId');
      var isNew = (finalBonusId === 'NEW');
      var movieId = f.get('movieId');
      var newName = String(f.get('newBonusTitle')).trim();

      if (isNew && !newName) { notify('請輸入新特典的名稱！'); return; }

      // 🌟 智慧防重複演算法 🌟
      if (isNew) {
        var related = bonuses.filter(function(b){ return b.movieId === movieId; });
        var similar = related.find(function(b){
          // 簡單正則：如果字串包含彼此，或者完全一樣，就視為重複
          return b.title === newName || b.title.indexOf(newName) !== -1 || newName.indexOf(b.title) !== -1;
        });
        if (similar) {
          if (!confirm('系統發現已有相似的特典「' + similar.title + '」，您確定要建立一個全新的「' + newName + '」嗎？')) {
            return;
          }
        }
      }

      var submitBtn = el.querySelector('button[type="submit"]');
      submitBtn.disabled = true; submitBtn.textContent = '送出中...';

      try {
        if (isNew) {
          finalBonusId = uid();
          await set('bonuses', finalBonusId, { movieId: movieId, title: newName, type: '其他', status: 'published', createdBy: currentUser.uid, createdAt: stamp() });
        }
        await set('stock_reports', uid(), {
          bonusId: finalBonusId, branchId: String(f.get('branchId')),
          stockStatus: String(f.get('stockStatus')), note: String(f.get('note') || '').trim(),
          status: 'approved', reporterUid: currentUser.uid, createdAt: stamp()
        });
        setCooldown(); el.remove(); notify('✅ 回報成功！已自動公開。', 5000);
        await refreshData(true);
      } catch (err) {
        notify('回報失敗：' + (err.code || err.message), 6000);
        submitBtn.disabled = false; submitBtn.textContent = '送出回報';
      }
    });
  }

  function start() {
    authAPI = window.firebaseAuth; dbAPI = window.firebaseDB;
    if (authAPI && authAPI.onAuthStateChanged) {
      authAPI.onAuthStateChanged(authAPI.auth, function (user) { currentUser = user || null; if (location.hash.indexOf('#poster') === 0) refreshData(true); });
    }
    window.addEventListener('hashchange', showPosterRoute);
    showPosterRoute();
    if (window.firebaseAuth && window.firebaseDB) refreshData(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
