/* Anime Vinyl - Anime Poster / 電影特典情報模組
 * 獨立於 app.js；路由 #poster。
 * 集合：movies / bonuses / cinemas / branches / stock_reports / favorites
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var authAPI = null, dbAPI = null, currentUser = null;
  var movies = [], bonuses = [], cinemas = [], branches = [], reports = [], favorites = [];
  var mySubs = { movies: [], bonuses: [], stock_reports: [] };
  var activeTab = 'movies', searchText = '', busy = false, lastRefresh = 0;
  var cinemaCityFilter = ''; // 影城分頁的縣市篩選

  var ADMIN_UIDS = ['CHcuRjAB6eWdmIiV9QGH209mSa93'];

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

  // 是否能刪除：管理員，或本人
  function canDelete(item, ownerField) {
    if (!currentUser || !item) return false;
    if (isAdmin()) return true;
    var owner = item[ownerField || 'createdBy'];
    return owner === currentUser.uid;
  }

  /* ---------- 路由 ---------- */
  function showPosterRoute() {
    var isPoster = location.hash === '#poster' || location.hash.indexOf('#poster/') === 0;
    var view = $('viewPoster');
    if (!view) return;
    view.hidden = !isPoster;
    if (isPoster) {
      ['viewEdit','viewPlay','viewError','viewHome','viewNfc','viewExplore'].forEach(function (x) { var el = $(x); if (el) el.hidden = true; });
      document.body.classList.remove('play-mode');
      render();
    }
  }

  /* ---------- 資料載入（防抖） ---------- */
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
        dbAPI.getDocs(dbAPI.query(col('branches'), dbAPI.limit(500))),
        dbAPI.getDocs(dbAPI.query(col('stock_reports'), dbAPI.limit(800)))
      ]);
      movies = rows(snaps[0]).filter(function (x) { return x.status === 'published'; });
      bonuses = rows(snaps[1]).filter(function (x) { return x.status === 'published'; });
      cinemas = rows(snaps[2]);
      branches = rows(snaps[3]);
      reports = rows(snaps[4]).filter(function (x) { return x.status === 'approved'; });
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

  /* ---------- 狀態徽章 ---------- */
  function statusBadge(s) {
    if (s === 'pending') return '<span class="poster-status unknown">待審核</span>';
    if (s === 'published' || s === 'approved') return '<span class="poster-status available">已公開</span>';
    if (s === 'rejected') return '<span class="poster-status soldout">已拒絕</span>';
    return '<span class="poster-status">' + esc(s || '未知') + '</span>';
  }

  /* ---------- Header（不再顯示 UID 給一般使用者） ---------- */
  function header() {
    var adminNote = '';
    if (isAdmin()) {
      adminNote = '<div class="poster-notice" style="margin-bottom:12px">✅ 管理員模式</div>';
    }
    return '<section class="poster-hero"><div><span class="poster-kicker">ANIME VINYL · COLLECTOR COMMUNITY</span><h2>電影特典情報</h2><p>查詢電影特典、影城分店回報與最新收藏情報。</p></div><div class="poster-hero-mark">🎬</div></section>' +
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

  /* ---------- 電影卡（管理員/本人可刪） ---------- */
  function movieCard(m) {
    var count = bonuses.filter(function (b) { return b.movieId === m.id; }).length;
    var delBtn = canDelete(m, 'createdBy')
      ? '<button type="button" class="poster-btn danger" data-del="movies" data-id="' + esc(m.id) + '" title="刪除電影" onclick="event.stopPropagation()">🗑</button>'
      : '';
    return '<div class="poster-card-wrap" style="position:relative">' +
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

  /* ---------- 特典卡（管理員/本人可刪） ---------- */
  function bonusCard(b) {
    var m = movies.find(function (x) { return x.id === b.movieId; });
    var delBtn = canDelete(b, 'createdBy')
      ? '<button type="button" class="poster-btn danger" data-del="bonuses" data-id="' + esc(b.id) + '" title="刪除特典">🗑</button>'
      : '';
    return '<article class="poster-bonus" style="position:relative">' +
      (delBtn ? '<div style="position:absolute;top:10px;right:10px;z-index:2">' + delBtn + '</div>' : '') +
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

  /* ---------- 影城分店（新功能：模仿開眼電影網的縣市選單） ---------- */
  function renderCinemas() {
    // 取得所有不重複的縣市
    var cities = branches.map(function (b) { return b.city; }).filter(Boolean);
    var uniqueCities = Array.from(new Set(cities)).sort();

    var html = '<div class="poster-section-head" style="flex-wrap:wrap"><h3>全台影城分店</h3>' +
      '<select id="cinemaCitySelect" class="poster-btn" style="padding:6px 12px; border-radius:8px; font-weight:normal; background:#171d29; color:#fff;">' +
        '<option value="">所有縣市</option>' +
        uniqueCities.map(function (c) { return '<option value="' + esc(c) + '" ' + (cinemaCityFilter === c ? 'selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
      '</select></div>';

    var filtered = branches;
    if (cinemaCityFilter) {
      filtered = branches.filter(function (b) { return b.city === cinemaCityFilter; });
    }

    // 如果搜尋框有字，也一併過濾影城名稱
    if (searchText) {
      var q = searchText.toLowerCase();
      filtered = filtered.filter(function (b) { return (b.name + ' ' + (b.city||'')).toLowerCase().indexOf(q) !== -1; });
    }

    // 依照縣市分組
    var grouped = {};
    filtered.forEach(function (b) {
      var c = b.city || '其他';
      if (!grouped[c]) grouped[c] = [];
      grouped[c].push(b);
    });

    var keys = Object.keys(grouped).sort();

    if (!keys.length) {
      html += '<p class="poster-empty">找不到符合條件的影城分店。</p>';
      return html;
    }

    html += '<div style="display:flex;flex-direction:column;gap:20px;margin-top:10px">';
    keys.forEach(function (city) {
      html += '<div><h4 style="margin:0 0 10px 0;color:var(--accent);font-size:15px;">📍 ' + esc(city) + '</h4>';
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;">';
      grouped[city].sort(function(a,b){return a.name.localeCompare(b.name);}).forEach(function (br) {
        var cinema = cinemas.find(function (c) { return c.id === br.cinemaId; });
        // 計算這間分店有幾筆特典回報（去重複的電影）
        var reportCount = reports.filter(function (r) { return r.branchId === br.id; }).length;
        
        html += '<div style="padding:12px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.02);">' +
          '<strong style="color:#fff;font-size:14px;display:block;margin-bottom:4px">' + esc(br.name) + '</strong>' +
          '<small style="color:var(--text-muted);display:block;margin-bottom:8px">' + esc(cinema ? cinema.name : '未知影城') + (br.address ? ' · ' + esc(br.address) : '') + '</small>' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<span style="font-size:12px;color:var(--text-muted)">共 ' + reportCount + ' 筆特典回報</span>' +
            '<button class="poster-btn" style="font-size:11px;padding:4px 8px" data-action="city-report" data-id="' + esc(br.id) + '">查詢特典</button>' +
          '</div>' +
        '</div>';
      });
      html += '</div></div>';
    });
    html += '</div>';
    return html;
  }

  /* ---------- 最新回報（管理員/本人可刪） ---------- */
  function renderReports() {
    var list = reports.slice().sort(function (a,b) { return new Date(b.createdAt) - new Date(a.createdAt); }).slice(0, 100);
    return '<div class="poster-section-head"><h3>最新庫存回報</h3><span>僅顯示已審核回報</span></div><div class="poster-report-list">' +
      (list.length ? list.map(function (r) {
        var b = bonuses.find(function (x) { return x.id === r.bonusId; });
        var br = branches.find(function (x) { return x.id === r.branchId; });
        var m = b && movies.find(function (x) { return x.id === b.movieId; });
        var delBtn = canDelete(r, 'reporterUid')
          ? '<button type="button" class="poster-btn danger" data-del="stock_reports" data-id="' + esc(r.id) + '" title="刪除回報">🗑</button>'
          : '';
        return '<article style="display:flex;align-items:center;gap:10px"><div style="flex:1"><strong>' + esc(m ? m.title : '電影') + ' · ' + esc(b ? b.title : '特典') + '</strong><small>' + esc(br ? br.name : '分店') + ' · ' + esc(dateText(r.createdAt)) + '</small></div><span class="poster-status ' + (r.stockStatus === '尚有庫存' ? 'available' : 'soldout') + '">' + esc(r.stockStatus) + '</span>' + delBtn + '</article>';
      }).join('') : '<p class="poster-empty">目前還沒有已審核的回報。</p>') + '</div>';
  }

  /* ---------- 我的提交（可刪） ---------- */
  function renderMine() {
    if (!currentUser) return '<p class="poster-empty">請先登入。</p>';
    var all = [];
    mySubs.movies.forEach(function (m) { all.push({ type: '電影', title: m.title, status: m.status, at: m.createdAt, id: m.id, collection: 'movies', owner: 'createdBy', raw: m }); });
    mySubs.bonuses.forEach(function (b) { all.push({ type: '特典', title: b.title, status: b.status, at: b.createdAt, id: b.id, collection: 'bonuses', owner: 'createdBy', raw: b }); });
    mySubs.stock_reports.forEach(function (r) { all.push({ type: '庫存回報', title: r.stockStatus + (r.note ? '（' + r.note + '）' : ''), status: r.status, at: r.createdAt, id: r.id, collection: 'stock_reports', owner: 'reporterUid', raw: r }); });
    all.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    return '<div class="poster-section-head"><h3>我的提交</h3><span>' + all.length + ' 筆</span></div>' +
      '<div class="poster-report-list">' +
      (all.length ? all.map(function (x) {
        var delBtn = canDelete(x.raw, x.owner)
          ? '<button type="button" class="poster-btn danger" data-del="' + x.collection + '" data-id="' + esc(x.id) + '" title="刪除">🗑</button>'
          : '';
        return '<article style="display:flex;align-items:center;gap:10px"><div style="flex:1"><strong>' + esc(x.type) + '：' + esc(x.title) + '</strong><small>' + esc(dateText(x.at)) + '</small></div>' + statusBadge(x.status) + delBtn + '</article>';
      }).join('') : '<p class="poster-empty">你還沒有送出任何資料。</p>') + '</div>';
  }

  /* ---------- 管理後台 ---------- */
  function renderAdmin() {
    if (!isAdmin()) return '<p class="poster-empty">此頁面僅限管理員使用。</p>';
    return '<div class="poster-section-head"><h3>管理後台</h3><span>審核與影城資料管理</span></div>' +
      '<div id="posterPending"><p class="poster-muted">正在讀取待審核資料…</p></div>' +
      '<div class="poster-admin-grid">' +
        '<form id="cinemaForm" class="poster-form"><h4>新增影城品牌</h4><label>品牌名稱<input name="name" required maxlength="60" placeholder="例如：威秀影城"></label><button class="poster-btn primary">新增影城</button></form>' +
        '<form id="branchForm" class="poster-form"><h4>新增影城分店</h4><label>影城品牌<select name="cinemaId" required>' + cinemas.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('') + '</select></label><label>分店名稱<input name="name" required maxlength="80" placeholder="例如：台中大遠百威秀"></label><label>縣市<input name="city" required maxlength="20" placeholder="台中市"></label><label>地址<input name="address" maxlength="150"></label><button class="poster-btn primary">新增分店</button></form>' +
      '</div>';
  }

  function render() {
    var app = $('posterApp'); if (!app || location.hash.indexOf('#poster') !== 0) return;
    var body;
    if (activeTab === 'movies') body = renderMovies();
    else if (activeTab === 'bonuses') body = renderBonuses();
    else if (activeTab === 'cinemas') body = renderCinemas();
    else if (activeTab === 'reports') body = renderReports();
    else if (activeTab === 'mine') body = renderMine();
    else body = renderAdmin();
    
    app.innerHTML = header() + '<section class="poster-content">' + body + '</section>';

    var input = $('posterSearch');
    if (input) {
      input.addEventListener('input', function () {
        searchText = input.value;
        var pos = input.selectionStart;
        render();
        var next = $('posterSearch');
        if (next) { next.focus(); try { next.setSelectionRange(pos, pos); } catch (e) {} }
      });
    }
    
    // 縣市篩選器事件綁定
    var citySelect = $('cinemaCitySelect');
    if (citySelect) {
      citySelect.addEventListener('change', function () {
        cinemaCityFilter = this.value;
        render();
      });
    }

    app.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { activeTab = b.dataset.tab; render(); if (activeTab === 'admin') loadPending(); });
    });
    
    app.querySelectorAll('[data-action]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.dataset.action;
        if (act === 'add-movie') showMovieForm();
        if (act === 'movie') showMovieDetail(b.dataset.id);
        if (act === 'report') showReportForm(b.dataset.id);
        // 新增：從影城分店頁面點擊「查詢特典」，會直接帶入該分店
        if (act === 'city-report') {
          var brId = b.dataset.id;
          var relatedBonuses = bonuses.filter(function (bn) { return reports.some(function (r) { return r.bonusId === bn.id && r.branchId === brId; }); });
          if (relatedBonuses.length) {
            var bnames = relatedBonuses.map(function(bn){ return bn.title; }).join('、');
            notify('該分店有回報的特典：' + bnames, 5000);
          } else {
            notify('該分店目前沒有特典回報紀錄', 5000);
          }
        }
      });
    });
    
    app.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        askDelete(b.dataset.del, b.dataset.id);
      });
    });
    var cf = $('cinemaForm'); if (cf) cf.addEventListener('submit', saveCinema);
    var bf = $('branchForm'); if (bf) bf.addEventListener('submit', saveBranch);
    if (activeTab === 'admin') loadPending();
  }

  /* ---------- 刪除 ---------- */
  function askDelete(collection, id) {
    if (!currentUser) { notify('請先登入'); return; }
    if (!confirm('確定要刪除這筆資料嗎？此操作無法復原。')) return;
    dbAPI.deleteDoc(doc(collection, id)).then(function () {
      notify('✅ 已刪除');
      refreshData(true);
    }).catch(function (e) {
      notify('刪除失敗：' + (e.code || e.message), 6000);
    });
  }

  /* ---------- Modal 工具 ---------- */
  function modal(content) {
    var old = $('posterModal'); if (old) old.remove();
    var el = document.createElement('div'); el.id = 'posterModal'; el.className = 'poster-modal';
    el.innerHTML = '<div class="poster-modal-box"><button type="button" class="poster-modal-close" aria-label="關閉">✕</button>' + content + '</div>';
    document.body.appendChild(el);
    el.querySelector('.poster-modal-close').addEventListener('click', function () { el.remove(); });
    el.addEventListener('click', function (e) { if (e.target === el) el.remove(); });
    return el;
  }

  /* ---------- 新增電影／特典 ---------- */
  function showMovieForm() {
    if (!currentUser) { notify('請先登入才能提交電影與特典資料'); return; }
    var el = modal('<h3>提交電影與特典資料</h3><p class="poster-muted">提交後會進入待審核區，審核通過才會公開。</p>' +
      '<form id="newMovieForm" class="poster-form">' +
        '<h4>電影資料</h4>' +
        '<label>電影名稱<input name="title" required maxlength="100"></label>' +
        '<label>別名／原文名稱<input name="alias" maxlength="120"></label>' +
        '<label>上映日期<input name="releaseDate" type="date"></label>' +
        '<label>海報圖片網址<input name="posterUrl" type="url" placeholder="https://..."></label>' +
        '<label>電影介紹<textarea name="description" maxlength="500"></textarea></label>' +
        '<h4>第一項特典（可稍後再新增）</h4>' +
        '<label>特典名稱<input name="bonusTitle" maxlength="100" placeholder="例如：首週入場特典"></label>' +
        '<label>特典類型<select name="type"><option>入場特典</option><option>海報</option><option>明信片</option><option>角色卡</option><option>小冊子</option><option>其他</option></select></label>' +
        '<label>特典圖片網址<input name="imageUrl" type="url" placeholder="https://..."></label>' +
        '<label>發放開始<input name="startDate" type="date"></label>' +
        '<label>發放結束<input name="endDate" type="date"></label>' +
        '<label>兌換條件<textarea name="conditions" maxlength="500" placeholder="例如：購買當日電影票，每張票兌換一份"></textarea></label>' +
        '<button class="poster-btn primary" type="submit">送出審核</button>' +
      '</form>');
    el.querySelector('form').addEventListener('submit', async function (e) {
      e.preventDefault();
      if (busy) return;
      busy = true;
      var f = new FormData(e.target);
      var movieId = uid();
      var bonusTitle = String(f.get('bonusTitle') || '').trim();
      try {
        await set('movies', movieId, {
          title: String(f.get('title')).trim(),
          alias: String(f.get('alias') || '').trim(),
          releaseDate: f.get('releaseDate') || '',
          posterUrl: String(f.get('posterUrl') || '').trim(),
          description: String(f.get('description') || '').trim(),
          status: 'pending', createdBy: currentUser.uid, createdAt: stamp(), updatedAt: stamp()
        });
        if (bonusTitle) {
          await set('bonuses', uid(), {
            movieId: movieId, title: bonusTitle,
            type: String(f.get('type') || '其他'),
            imageUrl: String(f.get('imageUrl') || '').trim(),
            startDate: f.get('startDate') || '', endDate: f.get('endDate') || '',
            conditions: String(f.get('conditions') || '').trim(),
            status: 'pending', createdBy: currentUser.uid, createdAt: stamp()
          });
        }
        el.remove();
        notify('✅ 已送出，等待管理員審核。已切換到「我的提交」讓你看狀態。', 6000);
        activeTab = 'mine';
        await refreshData(true);
      } catch (err) {
        notify('送出失敗：' + (err.code || err.message), 6000);
      }
      finally { busy = false; }
    });
  }

  /* ---------- 電影詳情 ---------- */
  function showMovieDetail(movieId) {
    var m = movies.find(function (x) { return x.id === movieId; }); if (!m) return;
    var bs = bonuses.filter(function (b) { return b.movieId === movieId; });
    var fav = favorites.some(function (f) { return f.targetId === movieId && f.targetType === 'movie'; });
    var delMovie = canDelete(m, 'createdBy')
      ? '<button class="poster-btn danger" data-del-detail="movies" data-id="' + esc(movieId) + '">🗑 刪除電影</button>'
      : '';
    var html = '<div class="poster-detail">' +
      (m.posterUrl ? '<img src="' + esc(m.posterUrl) + '" alt="電影海報">' : '') +
      '<div><span class="poster-kicker">MOVIE INFORMATION</span><h3>' + esc(m.title) + '</h3><p>' + esc(m.alias || '') + '</p><p>上映日期：' + esc(dateText(m.releaseDate)) + '</p><p>' + esc(m.description || '暫無介紹') + '</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="poster-btn" data-fav="' + (fav ? 'remove' : 'add') + '" data-id="' + esc(movieId) + '">' + (fav ? '★ 已收藏' : '☆ 收藏電影') + '</button>' +
        delMovie +
      '</div></div></div>' +
      '<h4>相關特典</h4><div class="poster-bonus-grid">' + (bs.length ? bs.map(bonusCard).join('') : '<p class="poster-empty">目前沒有已公開的特典。</p>') + '</div>';
    var el = modal(html);
    var favBtn = el.querySelector('[data-fav]');
    if (favBtn) favBtn.addEventListener('click', function () { toggleFavorite('movie', movieId); el.remove(); });
    el.querySelectorAll('[data-action="report"]').forEach(function (b) {
      b.addEventListener('click', function () { el.remove(); showReportForm(b.dataset.id); });
    });
    el.querySelectorAll('[data-del-detail]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('確定要刪除這部電影嗎？相關特典不會自動刪除，請自行確認。')) return;
        dbAPI.deleteDoc(doc(b.dataset.delDetail, b.dataset.id)).then(function () {
          notify('✅ 已刪除電影'); el.remove(); refreshData(true);
        }).catch(function (e) { notify('刪除失敗：' + (e.code || e.message), 6000); });
      });
    });
  }

  /* ---------- 回報庫存（走 stock_reports） ---------- */
  function showReportForm(bonusId) {
    if (!currentUser) { notify('請先登入才能回報庫存'); return; }
    if (!branches.length) { notify('目前尚無可選分店，請洽管理員新增影城分店'); return; }
    var bonus = bonuses.find(function (b) { return b.id === bonusId; });
    var el = modal('<h3>回報特典庫存</h3><p class="poster-muted">' + esc(bonus ? bonus.title : '特典') + '</p>' +
      '<form id="stockForm" class="poster-form">' +
        '<label>影城分店<select name="branchId" required>' +
          branches.slice().sort(function (a,b) { return (a.city || '').localeCompare(b.city || '') || a.name.localeCompare(b.name); }).map(function (br) {
            var c = cinemas.find(function (x) { return x.id === br.cinemaId; });
            return '<option value="' + esc(br.id) + '">' + esc((br.city || '') + ' · ' + (c ? c.name + ' ' : '') + br.name) + '</option>';
          }).join('') +
        '</select></label>' +
        '<label>目前狀態<select name="stockStatus"><option>尚有庫存</option><option>已兌換完畢</option><option>尚未確認</option></select></label>' +
        '<label>補充說明<textarea name="note" maxlength="300" placeholder="例如：今日下午仍可兌換"></textarea></label>' +
        '<button class="poster-btn primary">送出回報</button>' +
      '</form>');
    el.querySelector('form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      try {
        await set('stock_reports', uid(), {
          bonusId: bonusId, branchId: String(f.get('branchId')),
          stockStatus: String(f.get('stockStatus')),
          note: String(f.get('note') || '').trim(),
          status: 'pending', reporterUid: currentUser.uid, createdAt: stamp()
        });
        el.remove();
        notify('✅ 回報已送出，等待審核。已切換到「我的提交」。', 6000);
        activeTab = 'mine';
        await refreshData(true);
      } catch (err) { notify('回報失敗：' + (err.code || err.message), 6000); }
    });
  }

  /* ---------- 收藏 ---------- */
  async function toggleFavorite(type, targetId) {
    if (!currentUser) { notify('請先登入才能收藏'); return; }
    var existing = favorites.find(function (f) { return f.targetType === type && f.targetId === targetId; });
    try {
      if (existing) await dbAPI.deleteDoc(doc('favorites', existing.id));
      else await set('favorites', uid(), { uid: currentUser.uid, targetType: type, targetId: targetId, createdAt: stamp() });
      await refreshData(true);
      notify(existing ? '已取消收藏' : '已加入收藏');
    } catch (e) { notify('收藏失敗：' + (e.code || e.message)); }
  }

  /* ---------- 待審核 ---------- */
  async function loadPending() {
    var box = $('posterPending'); if (!box || !isAdmin()) return;
    try {
      var names = ['movies','bonuses','stock_reports'];
      var snaps = await Promise.all(names.map(function (n) { return dbAPI.getDocs(dbAPI.query(col(n), dbAPI.where('status', '==', 'pending'), dbAPI.limit(100))); }));
      var pending = [];
      snaps.forEach(function (s, i) { s.forEach(function (d) { pending.push({ collection: names[i], id: d.id, data: d.data() }); }); });
      box.innerHTML = '<h4>待審核項目（' + pending.length + '）</h4>' +
        (pending.length ? pending.map(function (p) {
          var d = p.data;
          var label = p.collection === 'movies' ? '電影：' + (d.title || '') :
                      p.collection === 'bonuses' ? '特典：' + (d.title || '') :
                      '庫存回報：' + (d.stockStatus || '');
          return '<article class="poster-pending"><div><b>' + esc(label) + '</b><small>' + esc(p.collection) + ' · ' + esc(dateText(d.createdAt)) + '</small></div>' +
            '<div><button class="poster-btn primary" data-review="approve" data-col="' + p.collection + '" data-id="' + p.id + '">通過</button>' +
            '<button class="poster-btn danger" data-review="reject" data-col="' + p.collection + '" data-id="' + p.id + '">拒絕</button>' +
            '<button class="poster-btn danger" data-del="' + p.collection + '" data-id="' + p.id + '" title="直接刪除">🗑</button></div></article>';
        }).join('') : '<p class="poster-empty">目前沒有待審核項目。</p>');
      box.querySelectorAll('[data-review]').forEach(function (b) {
        b.addEventListener('click', async function () {
          var status = b.dataset.review === 'approve' ? (b.dataset.col === 'stock_reports' ? 'approved' : 'published') : 'rejected';
          try {
            var ref = doc(b.dataset.col, b.dataset.id);
            var snap = await dbAPI.getDoc(ref);
            var old = snap.data() || {};
            await dbAPI.setDoc(ref, Object.assign({}, old, { status: status, reviewedBy: currentUser.uid, reviewedAt: stamp() }));
            notify('審核完成');
            await refreshData(true);
            if (activeTab === 'admin') loadPending();
          } catch (e) { notify('審核失敗：' + (e.code || e.message), 6000); }
        });
      });
      box.querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          askDelete(b.dataset.del, b.dataset.id);
        });
      });
    } catch (e) {
      box.innerHTML = '<p class="poster-notice error">無法讀取待審核資料：' + esc(e.code || e.message) + '</p>';
    }
  }

  /* ---------- 影城／分店 ---------- */
  async function saveCinema(e) {
    e.preventDefault(); if (!isAdmin()) return;
    var f = new FormData(e.target);
    try {
      await set('cinemas', uid(), { name: String(f.get('name')).trim(), status: 'published', createdAt: stamp(), createdBy: currentUser.uid });
      notify('影城品牌已新增'); await refreshData(true);
    } catch (err) { notify('新增失敗：' + (err.code || err.message)); }
  }
  async function saveBranch(e) {
    e.preventDefault(); if (!isAdmin()) return;
    var f = new FormData(e.target);
    try {
      await set('branches', uid(), {
        cinemaId: String(f.get('cinemaId')), name: String(f.get('name')).trim(),
        city: String(f.get('city')).trim(), address: String(f.get('address') || '').trim(),
        status: 'published', createdAt: stamp(), createdBy: currentUser.uid
      });
      notify('分店已新增'); await refreshData(true);
    } catch (err) { notify('新增失敗：' + (err.code || err.message)); }
  }

  /* ---------- 啟動 ---------- */
  function start() {
    authAPI = window.firebaseAuth; dbAPI = window.firebaseDB;
    if (authAPI && authAPI.onAuthStateChanged) {
      authAPI.onAuthStateChanged(authAPI.auth, function (user) {
        currentUser = user || null;
        if (location.hash.indexOf('#poster') === 0) refreshData(true);
        else render();
      });
    }
    window.addEventListener('hashchange', showPosterRoute);
    showPosterRoute();
    if (window.firebaseAuth && window.firebaseDB) refreshData(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  window.addEventListener('firebaseReady', function () {
    if (!authAPI) { authAPI = window.firebaseAuth; dbAPI = window.firebaseDB; }
    if (location.hash.indexOf('#poster') === 0) refreshData(true);
  });
})();
