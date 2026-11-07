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
  var currentCinemaId = null; // 用於影城詳細頁

  var ADMIN_UIDS = ['CHcuRjAB6eWdmIiV9QGH209mSa93'];

  // ==========================================
  // 全台影城預設資料
  // ==========================================
  var DEFAULT_CINEMAS = {
    "台北市": ["台北信義威秀影城","MUVIE CINEMAS 台北松仁","誠品電影院","台北大巨蛋秀泰影城","喜樂時代影城南港店","台北南港 LaLaport 威秀影城","台北京站威秀影城","總督影城","微風影城","哈拉影城","國賓大戲院","樂聲影城","台北獅子林新光影城","台北真善美劇院","台北西門威秀影城","喜樂時代影城今日店","百老匯數位影城","光點華山電影館","台北長春國賓影城","台北欣欣秀泰影城","光點台北電影館","美麗華大直影城","美麗新大直皇家影城","台北天母新光影城","景美佳佳戲院"],
    "新北市": ["中和環球威秀影城","喜樂時代影城永和店","鴻金寶麻吉影城","晶冠廣場國賓影城","國家電影及視聽文化中心","天台影城","林口昕境國賓影城","林口 MITSUI OUTLET PARK 威秀影城","淡水禮萊國賓影城","板橋大遠百威秀影城","府中15新北市紀錄片放映院","樹林秀泰影城","土城秀泰影城","新店裕隆城威秀影城"],
    "基隆市": ["基隆秀泰影城"],
    "宜蘭縣": ["新月豪華影城","日新戲院","日新戲院統一廳"],
    "桃園市": ["桃園統領威秀影城","桃園桃知道威秀影城","桃園站前 in89 統領影城","八德置地國賓影城","美麗新台茂影城","桃園青埔新光影城","星橋國際影城","威尼斯影城","中壢光影電影館","桃園光影文化館"],
    "新竹市": ["新竹大遠百威秀影城","新竹巨城威秀影城"],
    "新竹縣": ["百老匯數位影城（竹北店）"],
    "苗栗縣": ["尚順威秀影城"],
    "台中市": ["台中中港新光影城","台中大遠百威秀影城","MUVIE CINEMAS 台中 TIGER CITY","台中文心秀泰影城","台中站前秀泰影城","台中 iFG 遠雄廣場威秀影城","王牌映画影城","日日新影城","親親影城","台中豐原 in89 豪華影城","中山73影視藝文空間","時代數位3D影城","台中麗寶秀泰影城","全球影城"],
    "彰化縣": ["員林影城"],
    "南投縣": ["南投戲院","山明影城"],
    "雲林縣": ["環球中華影城","雲林北港秀泰影城"],
    "嘉義市": ["嘉年華影城","嘉義秀泰影城","嘉義影食滙 in89 豪華影城"],
    "台南市": ["台南大遠百威秀影城","台南 Focus 威秀影城","台南南紡威秀影城","台南西門新光影城","台南仁德秀泰影城","南台影城","全美戲院","麻豆戲院"],
    "高雄市": ["高雄大遠百威秀影城","高雄 SKM Park 國賓影城","高雄義大國賓影城","高雄大立 in89 豪華影城","高雄鹽埕 in89 駁二電影院","台鋁影城","喜樂時代影城高雄總圖店","環球影城","高雄岡山秀泰影城","高雄夢時代秀泰影城","內惟藝術中心","高雄市電影館"],
    "屏東縣": ["屏東環球國賓影城","屏東數位影城"],
    "花蓮縣": ["花蓮秀泰影城","花蓮鐵道電影院","花蓮新天堂威秀影城"],
    "台東縣": ["台東秀泰影城"],
    "澎湖縣": ["澎湖昇恆昌 in89 豪華數位影城"],
    "金門縣": ["金獅影城","國賓影城（金門昇恆昌金湖廣場）"]
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

  // 檢查冷卻時間 (3分鐘)
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

  /* ---------- 路由 (支援 #poster 與 #poster/cinema/xxx) ---------- */
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
        if (activeTab === 'cinema-detail') activeTab = 'cinemas'; // 返回上一頁
      }
      render();
    }
  }

  /* ---------- 資料載入 ---------- */
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
      movies = rows(snaps[0]); // 自動化：不再只抓 published
      bonuses = rows(snaps[1]);
      cinemas = rows(snaps[2]);
      branches = rows(snaps[3]);
      reports = rows(snaps[4]); // 自動化：全部抓，不再需要 approved
      
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

  /* ---------- Header ---------- */
  function header() {
    var adminNote = '';
    if (isAdmin()) {
      adminNote = '<div class="poster-notice" style="margin-bottom:12px">✅ 管理員模式</div>';
    }
    
    // 如果在影城詳細頁，顯示返回按鈕
    if (activeTab === 'cinema-detail') {
      return '<div style="margin-bottom:12px"><a href="#poster" style="color:var(--accent); text-decoration:none; font-size:14px;">← 返回影城列表</a></div>';
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

  /* ---------- 卡片渲染 ---------- */
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

  /* ---------- 頁面渲染 ---------- */
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
    filtered.forEach(function (b) {
      var c = b.city || '其他';
      if (!grouped[c]) grouped[c] = [];
      grouped[c].push(b);
    });

    var keys = Object.keys(grouped).sort();
    if (!keys.length) {
      html += '<p class="poster-empty">找不到影城分店。若為空，請管理員至「管理後台」點擊匯入。</p>';
      return html;
    }

    html += '<div style="display:flex;flex-direction:column;gap:20px;margin-top:10px">';
    keys.forEach(function (city) {
      html += '<div><h4 style="margin:0 0 10px 0;color:var(--accent);font-size:15px;">📍 ' + esc(city) + '</h4>';
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;">';
      grouped[city].sort(function(a,b){return a.name.localeCompare(b.name);}).forEach(function (br) {
        var cinema = cinemas.find(function (c) { return c.id === br.cinemaId; });
        var reportCount = reports.filter(function (r) { return r.branchId === br.id; }).length;
        
        // 改為點擊整張卡片進入詳細頁
        html += '<div style="padding:12px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:rgba(255,255,255,.02);cursor:pointer;" data-action="go-cinema" data-id="' + esc(br.id) + '">' +
          '<strong style="color:#fff;font-size:14px;display:block;margin-bottom:4px">' + esc(br.name) + '</strong>' +
          '<small style="color:var(--text-muted);display:block;margin-bottom:8px">' + esc(cinema ? cinema.name : '未知影城') + '</small>' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<span style="font-size:12px;color:var(--text-muted)">共 ' + reportCount + ' 筆回報</span>' +
            '<span style="color:var(--accent);font-size:12px;">查看特典 ❯</span>' +
          '</div>' +
        '</div>';
      });
      html += '</div></div>';
    });
    html += '</div>';
    return html;
  }

  /* ---------- 影城詳細頁 (新功能) ---------- */
  function renderCinemaDetail() {
    var br = branches.find(function(b){ return b.id === currentCinemaId; });
    if (!br) return '<p class="poster-empty">找不到該影城，可能已被刪除。</p>';
    var cinema = cinemas.find(function(c){ return c.id === br.cinemaId; });
    
    // 找出這間影城有的所有回報
    var myReports = reports.filter(function(r){ return r.branchId === br.id; });
    
    // 把回報轉換成特典資訊
    var relatedBonuses = myReports.map(function(r){
      var b = bonuses.find(function(x){ return x.id === r.bonusId; });
      return { report: r, bonus: b };
    }).filter(function(x){ return x.bonus; });

    var html = '<div class="poster-section-head">' +
      '<h3>' + esc(br.name) + '</h3>' +
      '<span style="color:var(--accent)">' + esc(cinema ? cinema.name : '') + ' · ' + esc(br.city) + '</span>' +
      '</div>';

    html += '<div class="poster-toolbar" style="margin-bottom:20px;">' +
      '<button class="poster-btn primary" style="width:100%;padding:14px;font-size:16px;" data-action="report-here">＋ 回報此影城特典</button>' +
      '</div>';

    html += '<div class="poster-section-head"><h3>目前特典狀態</h3><span>共 ' + relatedBonuses.length + ' 筆</span></div>';

    if (!relatedBonuses.length) {
      html += '<div style="padding:40px 20px; text-align:center; border:1px dashed rgba(255,255,255,.15); border-radius:16px; margin-top:10px;">' +
        '<p class="poster-muted" style="font-size:15px; margin-bottom:16px;">這間影城目前有 0 筆特典回報</p>' +
        '<button class="poster-btn primary" style="font-size:15px; padding:10px 24px;" data-action="report-here">成為第一個回報的人</button>' +
        '</div>';
      return html;
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
        '<div style="flex:1">' +
          '<strong style="color:#fff;font-size:15px;display:block;margin-bottom:4px">' + esc(m ? m.title : '未知電影') + ' - ' + esc(b.title) + '</strong>' +
          '<small style="color:var(--text-muted);display:block;margin-bottom:8px">回報時間：' + esc(dateText(r.createdAt)) + (r.note ? ' · ' + esc(r.note) : '') + '</small>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">' +
          '<span class="poster-status ' + statusCls + '">' + esc(statusTxt) + '</span>' +
          delBtn +
        '</div>' +
      '</article>';
    });
    html += '</div>';
    return html;
  }

  function renderReports() {
    var list = reports.slice().sort(function (a,b) { return new Date(b.createdAt) - new Date(a.createdAt); }).slice(0, 100);
    return '<div class="poster-section-head"><h3>最新庫存回報</h3><span>即時顯示</span></div><div class="poster-report-list">' +
      (list.length ? list.map(function (r) {
        var b = bonuses.find(function (x) { return x.id === r.bonusId; });
        var br = branches.find(function (x) { return x.id === r.branchId; });
        var m = b && movies.find(function (x) { return x.id === b.movieId; });
        var delBtn = canDelete(r, 'reporterUid')
          ? '<button type="button" class="poster-btn danger" data-del="stock_reports" data-id="' + esc(r.id) + '" title="刪除回報">🗑</button>'
          : '';
        return '<article style="display:flex;align-items:center;gap:10px"><div style="flex:1"><strong>' + esc(m ? m.title : '電影') + ' · ' + esc(b ? b.title : '特典') + '</strong><small>' + esc(br ? br.name : '分店') + ' · ' + esc(dateText(r.createdAt)) + '</small></div><span class="poster-status ' + (r.stockStatus === '尚有庫存' ? 'available' : 'soldout') + '">' + esc(r.stockStatus) + '</span>' + delBtn + '</article>';
      }).join('') : '<p class="poster-empty">目前還沒有任何回報。</p>') + '</div>';
  }

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

  function renderAdmin() {
    if (!isAdmin()) return '<p class="poster-empty">此頁面僅限管理員使用。</p>';
    var importBtn = '<div style="padding:16px; background:rgba(0,229,255,.05); border:1px solid var(--accent); border-radius:14px; margin-bottom:16px;">' +
      '<h4 style="color:var(--accent); margin:0 0 8px 0;">🚀 快速初始化</h4>' +
      '<p style="font-size:13px; color:var(--text-muted); margin-bottom:12px;">點擊下方按鈕，系統會自動將全台影城資料寫入資料庫。</p>' +
      '<button id="importCinemasBtn" class="poster-btn primary" style="width:100%; font-size:16px; padding:12px;">一鍵匯入全台影城</button>' +
      '</div>';
    return '<div class="poster-section-head"><h3>管理後台</h3><span>資料管理 (已啟用自動化防刷)</span></div>' +
      importBtn +
      '<div style="padding:16px; background:rgba(255,255,255,.02); border:1px solid rgba(255,255,255,.08); border-radius:14px; margin-bottom:16px;">' +
      '<h4 style="color:#fff; margin:0 0 8px 0;">🛡️ 黑名單管理</h4>' +
      '<p style="font-size:13px; color:var(--text-muted);">若發現惡意亂留資料的使用者，請至 Firebase Console 的 <code>users</code> 集合中，將該使用者的 <code>status</code> 設為 <code>banned</code>，即可永久封鎖其發文權限。</p>' +
      '</div>';
  }

  function render() {
    var app = $('posterApp'); if (!app) return;
    
    // 如果是詳細頁，不顯示原本的 Hero 區塊
    if (activeTab === 'cinema-detail') {
      app.innerHTML = header() + '<section class="poster-content">' + renderCinemaDetail() + '</section>';
    } else {
      var body;
      if (activeTab === 'movies') body = renderMovies();
      else if (activeTab === 'bonuses') body = renderBonuses();
      else if (activeTab === 'cinemas') body = renderCinemas();
      else if (activeTab === 'reports') body = renderReports();
      else if (activeTab === 'mine') body = renderMine();
      else body = renderAdmin();
      
      app.innerHTML = header() + '<section class="poster-content">' + body + '</section>';
    }

    // 綁定搜尋
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
    
    // 綁定縣市篩選
    var citySelect = $('cinemaCitySelect');
    if (citySelect) {
      citySelect.addEventListener('change', function () {
        cinemaCityFilter = this.value;
        render();
      });
    }

    // 綁定分頁切換
    app.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { 
        activeTab = b.dataset.tab; 
        history.replaceState(null, '', '#poster'); // 清除詳細頁路由
        render(); 
      });
    });
    
    // 綁定各種點擊動作
    app.querySelectorAll('[data-action]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.dataset.action;
        if (act === 'add-movie') showMovieForm();
        if (act === 'movie') showMovieDetail(b.dataset.id);
        if (act === 'report') showReportForm(b.dataset.id); // 帶入特典ID
        if (act === 'go-cinema') {
          location.hash = '#poster/cinema/' + b.dataset.id;
        }
        if (act === 'report-here') {
          // 如果在影城詳細頁按回報，直接開回報表單，並帶入 currentCinemaId
          showReportForm(null, currentCinemaId);
        }
      });
    });
    
    app.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        askDelete(b.dataset.del, b.dataset.id);
      });
    });
    
    var impBtn = $('importCinemasBtn');
    if (impBtn) impBtn.addEventListener('click', importDefaultCinemas);

    var cf = $('cinemaForm'); if (cf) cf.addEventListener('submit', saveCinema);
    var bf = $('branchForm'); if (bf) bf.addEventListener('submit', saveBranch);
  }

  /* ---------- 一鍵匯入腳本 ---------- */
  async function importDefaultCinemas() {
    if (!isAdmin()) return;
    if (!confirm('確定要匯入全台預設影城資料嗎？\n這會寫入幾百筆資料，需要幾秒鐘時間，請不要關閉視窗。')) return;
    
    var btn = $('importCinemasBtn');
    if (btn) { btn.disabled = true; btn.textContent = '匯入中，請稍候...'; }
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
        var branchList = DEFAULT_CINEMAS[cityName];
        for (var i = 0; i < branchList.length; i++) {
          await set('branches', uid(), {
            cinemaId: cid, name: branchList[i], city: cityName, address: '',
            status: 'published', createdAt: stamp(), createdBy: currentUser.uid
          });
          count++;
        }
      }
      notify('🎉 成功匯入 ' + count + ' 間分店！', 6000);
      await refreshData(true);
      activeTab = 'cinemas';
      render();
    } catch (e) {
      console.error('匯入失敗', e);
      notify('匯入失敗：' + (e.code || e.message), 6000);
      if (btn) { btn.disabled = false; btn.textContent = '一鍵匯入全台影城'; }
    }
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
    var el = modal('<h3>提交電影與特典資料</h3><p class="poster-muted">送出後將直接公開顯示。</p>' +
      '<form id="newMovieForm" class="poster-form">' +
        '<h4>電影資料</h4><label>電影名稱<input name="title" required></label><label>海報圖片網址<input name="posterUrl" type="url"></label>' +
        '<h4>第一項特典</h4><label>特典名稱<input name="bonusTitle"></label><label>類型<select name="type"><option>入場特典</option><option>海報</option><option>其他</option></select></label>' +
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
          status: 'published', createdBy: currentUser.uid, createdAt: stamp() // 直接發布
        });
        if (bonusTitle) {
          await set('bonuses', uid(), {
            movieId: movieId, title: bonusTitle, type: String(f.get('type') || '其他'),
            status: 'published', createdBy: currentUser.uid, createdAt: stamp()
          });
        }
        el.remove(); notify('✅ 已新增！', 4000); await refreshData(true);
      } catch (err) { notify('失敗：' + (err.code || err.message)); }
      finally { busy = false; }
    });
  }

  function showMovieDetail(movieId) {
    var m = movies.find(function (x) { return x.id === movieId; }); if (!m) return;
    var bs = bonuses.filter(function (b) { return b.movieId === movieId; });
    var html = '<div class="poster-detail">' +
      (m.posterUrl ? '<img src="' + esc(m.posterUrl) + '" alt="">' : '') +
      '<div><h3>' + esc(m.title) + '</h3><p>' + esc(m.description || '暫無介紹') + '</p></div></div>' +
      '<h4>相關特典</h4><div class="poster-bonus-grid">' + (bs.length ? bs.map(bonusCard).join('') : '<p class="poster-empty">無特典。</p>') + '</div>';
    var el = modal(html);
    el.querySelectorAll('[data-action="report"]').forEach(function (b) {
      b.addEventListener('click', function () { el.remove(); showReportForm(b.dataset.id); });
    });
  }

  /* ---------- 回報表單 (支援預設影城) ---------- */
  function showReportForm(bonusId, presetBranchId) {
    if (!currentUser) { notify('請先登入'); return; }
    if (!checkCooldown()) return; // 防刷檢查

    if (!bonuses.length) { notify('目前沒有特典可供回報'); return; }
    if (!branches.length) { notify('目前沒有影城分店'); return; }

    var bonusOpts = bonuses.map(function (b) { return '<option value="' + esc(b.id) + '" ' + (b.id === bonusId ? 'selected' : '') + '>' + esc(b.title) + '</option>'; }).join('');
    var branchOpts = branches.map(function (br) { 
      var c = cinemas.find(function(x){return x.id===br.cinemaId;});
      return '<option value="' + esc(br.id) + '" ' + (br.id === presetBranchId ? 'selected' : '') + '>' + esc(br.city + ' · ' + (c?c.name:'') + br.name) + '</option>'; 
    }).join('');

    var el = modal('<h3>回報特典庫存</h3>' +
      '<form id="stockForm" class="poster-form">' +
        '<label>選擇特典<select name="bonusId" required>' + bonusOpts + '</select></label>' +
        '<label>影城分店<select name="branchId" required>' + branchOpts + '</select></label>' +
        '<label>目前狀態<select name="stockStatus"><option>尚有庫存</option><option>已兌換完畢</option></select></label>' +
        '<label>備註 (選填)<textarea name="note" maxlength="100" placeholder="例如：需要買全票"></textarea></label>' +
        '<button class="poster-btn primary" type="submit">送出回報</button>' +
      '</form>');
      
    el.querySelector('form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      try {
        await set('stock_reports', uid(), {
          bonusId: String(f.get('bonusId')), branchId: String(f.get('branchId')),
          stockStatus: String(f.get('stockStatus')),
          note: String(f.get('note') || '').trim(),
          status: 'approved', // 自動化：送出即通過
          reporterUid: currentUser.uid, createdAt: stamp()
        });
        setCooldown(); // 鎖定 3 分鐘
        el.remove();
        notify('✅ 回報成功！已自動公開。', 5000);
        await refreshData(true);
      } catch (err) { notify('回報失敗：' + (err.code || err.message), 6000); }
    });
  }

  /* ---------- 啟動 ---------- */
  function start() {
    authAPI = window.firebaseAuth; dbAPI = window.firebaseDB;
    if (authAPI && authAPI.onAuthStateChanged) {
      authAPI.onAuthStateChanged(authAPI.auth, function (user) {
        currentUser = user || null;
        if (location.hash.indexOf('#poster') === 0) refreshData(true);
      });
    }
    window.addEventListener('hashchange', showPosterRoute);
    showPosterRoute();
    if (window.firebaseAuth && window.firebaseDB) refreshData(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
