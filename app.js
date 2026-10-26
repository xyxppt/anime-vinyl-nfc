(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* ============ 注入 3D 翻面與 4 大氣氛主題樣式 ============ */
  (function injectStyles() {
    var style = document.createElement('style');
    style.textContent = `
      .plinth { perspective: 1000px; }
      .vinyl { transition: transform 0.6s cubic-bezier(0.4, 0.2, 0.2, 1); transform-style: preserve-3d; }
      .vinyl.flipped { transform: rotateY(180deg); }

      /* 氣氛主題樣式 */
      #viewPlay.vibe-rain { background: radial-gradient(circle at center, #0f172a 0%, #020617 100%); }
      #viewPlay.vibe-rain::before { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(56,189,248,0.03) 0%, rgba(2,6,23,0.8) 100%); pointer-events: none; }
      
      #viewPlay.vibe-sakura { background: radial-gradient(circle at center, #2e1065 0%, #0f051d 100%); }
      #viewPlay.vibe-sakura::before { content: ""; position: absolute; inset: 0; background: radial-gradient(circle, rgba(244,114,182,0.08) 0%, transparent 70%); pointer-events: none; }
      
      #viewPlay.vibe-cyber { background: radial-gradient(circle at center, #180529 0%, #05010a 100%); box-shadow: inset 0 0 100px rgba(236,72,153,0.15); }
      
      #viewPlay.vibe-crt { background: #050805; }
      #viewPlay.vibe-crt::after { content: " "; display: block; position: absolute; inset: 0; background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06)); z-index: 99; background-size: 100% 4px, 6px 100%; pointer-events: none; }
    `;
    document.head.appendChild(style);
  })();

  /* ============ Firebase 狀態 ============ */
  var currentUser = null;
  var authAPI = null;
  var dbAPI = null;
  var cloudReady = false;
  var seeking = false;
  var playHistory = [];
  var unsubscribeSnapshot = null; 

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3200);
  }

  function fmtTime(sec) {
    sec = Math.floor(sec || 0);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function parseVideoId(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    if (/^[\w-]{11}$/.test(s)) return s;
    var m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
    return m ? m[1] : '';
  }

  function thumbOf(song) {
    if (song && song.cover && /^https?:\/\//i.test(song.cover)) return song.cover;
    var vid = parseVideoId(song ? song.videoId : '');
    if (vid) return 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg';
    return '';
  }

  /* ============ 資料層 ============ */
  var LS_BASE = 'anime-vinyl:data';
  var LS_KEY = LS_BASE + ':guest';
  var previewFromId = null;
  var autoSaveTimer = null;
  var swipeBound = false;
  var state = { playlists: [] };
  var currentPlaylistId = null;
  var isDirty = false;

  function getCurrentPlaylist() {
    return state.playlists.find(function (p) { return p.id === currentPlaylistId; });
  }

  function newShareId() {
    return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 8);
  }

  function syncPublicUI(pl) {
    if ($('playlistIsPublic')) $('playlistIsPublic').checked = !!pl.isPublic;
    if ($('playlistNick')) $('playlistNick').value = pl.nick || '';
    if ($('publicNickWrap')) $('publicNickWrap').hidden = !pl.isPublic;
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function createEmptyPlaylist(name) {
    return {
      id: generateId(),
      name: name || '新歌單',
      isPublic: false,
      songs: [{ anime: '', title: '', artist: '', videoId: '', cover: '' }],
      vibe: 'default',
      updatedAt: new Date().toISOString()
    };
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && Array.isArray(d.playlists)) {
          state.playlists = d.playlists;
        } else if (d && Array.isArray(d.songs)) {
          var oldPl = createEmptyPlaylist(d.name);
          oldPl.songs = d.songs;
          state.playlists = [oldPl];
        }
      }
      if (!state.playlists.length) {
        state.playlists = [createEmptyPlaylist('我的第一張黑膠')];
      }
    } catch (e) {}
  }

  function saveDraft() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }

  async function saveDraftToCloud(silent) {
    if (!currentUser || !dbAPI) return;
    if (!cloudReady) { if (!silent) toast('雲端尚未連線，請稍後再試'); return; }
    try {
      var cp0 = getCurrentPlaylist();
      if (cp0 && cp0.isPublic) {
        if (!cp0.shareId) { cp0.shareId = newShareId(); cp0.linked = false; }
        cp0.explored = true;
        saveDraft();
      }
      var docRef = dbAPI.doc(dbAPI.db, 'playlists', currentUser.uid);
      await dbAPI.setDoc(docRef, {
        playlists: state.playlists,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      
      var cp = getCurrentPlaylist();
      if (cp) {
        if (cp.shareId && (cp.isPublic || cp.linked !== false)) publishShared(cp).catch(function (e) { console.error(e); });
        if (cp.isPublic) {
          publishExplorePlaylist(cp).catch(function (e) { console.error(e); toast('⚠️ 廣場更新失敗：' + (e.code || e.message), 5000); });
        } else if (cp.explored && cp.shareId) {
          dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'explore_playlists', cp.shareId))
            .then(function () {
              if (cp.linked === false) dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'shared', cp.shareId)).catch(function () {});
              cp.explored = false;
              saveDraft();
              saveDraftToCloud(true);
              toast('🌐 已從探索廣場下架');
            })
            .catch(function (e) { console.error('下架失敗', e); });
        }
      }
      if (!silent) toast('☁️ 已儲存至雲端');
    } catch (e) {
      console.error('雲端儲存失敗', e);
      toast('⚠️ 雲端同步失敗：' + (e.code || e.message), 5000);
    }
  }

  async function publishExplorePlaylist(pl) {
    if (!currentUser || !dbAPI || !pl) return;
    var validSongs = (pl.songs || []).filter(s => parseVideoId(s.videoId));
    if (!validSongs.length) return;

    if (!pl.shareId) {
      pl.shareId = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 8);
    }

    var exploreRef = dbAPI.doc(dbAPI.db, 'explore_playlists', pl.shareId);
    var docSnap = await dbAPI.getDoc(exploreRef).catch(function () { return { exists: function () { return false; } }; });
    var currentViews = (docSnap && docSnap.exists() && docSnap.data().views !== undefined) ? docSnap.data().views : 0;

    await dbAPI.setDoc(exploreRef, {
      id: pl.shareId,
      name: pl.name || '未命名歌單',
      ownerName: (pl.nick || '匿名動漫迷').slice(0, 20),
      ownerUid: currentUser.uid,
      songsCount: validSongs.length,
      coverUrl: thumbOf(validSongs[0]),
      songs: validSongs,
      vibe: pl.vibe || 'default',
      updatedAt: new Date().toISOString(),
      views: currentViews
    }, { merge: true });
  }

  function cleanupExplore() {
    if (!currentUser || !dbAPI || !dbAPI.where) return;
    var keep = {};
    state.playlists.forEach(function (p) { if (p.isPublic && p.shareId) keep[p.shareId] = 1; });
    dbAPI.getDocs(dbAPI.query(dbAPI.collection(dbAPI.db, 'explore_playlists'), dbAPI.where('ownerUid', '==', currentUser.uid)))
      .then(function (snap) {
        snap.forEach(function (d) {
          if (!keep[d.id]) dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'explore_playlists', d.id)).catch(function (e) { console.error(e); });
        });
      })
      .catch(function (e) { console.error('清理廣場失敗', e); });
  }

  function isBlankPlaylist(pl) {
    return !(pl.songs || []).some(function (s) { return s.title || s.videoId || s.anime || s.artist; });
  }

  function mergePlaylists(local, remote) {
    var map = {};
    remote.forEach(function (p) { map[p.id] = p; });
    local.forEach(function (p) {
      if (isBlankPlaylist(p)) return;
      var r = map[p.id];
      if (!r || new Date(p.updatedAt) > new Date(r.updatedAt)) map[p.id] = p;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function applyRemote(remote, wasDirty) {
    var localById = {};
    state.playlists.forEach(function (p) { localById[p.id] = p; });
    remote.forEach(function (p) {
      var l = localById[p.id];
      if (l && l.shareId && !p.shareId) p.shareId = l.shareId;
    });
    if (!wasDirty) { state.playlists = remote; return; }
    var cur = getCurrentPlaylist();
    state.playlists = remote.filter(function (p) { return !cur || p.id !== cur.id; }).concat(cur ? [cur] : []);
  }

  function mergeHistory(a, b) {
    var m = {};
    a.concat(b).forEach(function (h) { if (h && h.k && (!m[h.k] || h.at > m[h.k].at)) m[h.k] = h; });
    return Object.keys(m).map(function (k) { return m[k]; })
      .sort(function (x, y) { return y.at - x.at; }).slice(0, 30);
  }

  function refreshView(wasDirty) {
    var hash = location.hash || '';
    if (hash === '' || hash === '#home') {
      renderPlaylistGrid();
      renderHistory();
    } else if (hash.indexOf('#edit/') === 0 && !wasDirty) {
      var pl = getCurrentPlaylist();
      if (pl) {
        $('playlistName').value = pl.name;
        syncPublicUI(pl);
        renderEditor();
      }
    }
  }

  function listenDraftFromCloud() {
    if (!currentUser || !dbAPI) return;
    if (unsubscribeSnapshot) unsubscribeSnapshot();
    cloudReady = false;
    var docRef = dbAPI.doc(dbAPI.db, 'playlists', currentUser.uid);
    unsubscribeSnapshot = dbAPI.onSnapshot(docRef, function (snap) {
      if (!cloudReady && snap.metadata.fromCache && !snap.exists()) return;
      var data = snap.exists() ? snap.data() : {};
      var remotePl = Array.isArray(data.playlists) ? data.playlists : [];
      var remoteHist = Array.isArray(data.history) ? data.history : [];
      var wasDirty = isDirty;

      if (!cloudReady) {
        cloudReady = true;
        state.playlists = mergePlaylists(state.playlists, remotePl);
        playHistory = mergeHistory(playHistory, remoteHist);
        saveDraft(); saveHistoryLocal();
        if (JSON.stringify(state.playlists) !== JSON.stringify(remotePl)) saveDraftToCloud(true);
        if (JSON.stringify(playHistory) !== JSON.stringify(remoteHist)) saveHistoryToCloud();
        refreshView(wasDirty);
        cleanupExplore();
        return;
      }
      if (snap.metadata.hasPendingWrites) return;
      if (JSON.stringify(remotePl) !== JSON.stringify(state.playlists)) {
        applyRemote(remotePl, wasDirty);
        saveDraft();
      }
      if (JSON.stringify(remoteHist) !== JSON.stringify(playHistory)) {
        playHistory = remoteHist;
        saveHistoryLocal();
      }
      refreshView(wasDirty);
    }, function (error) {
      console.error('監聽失敗:', error);
      toast('⚠️ 無法連線雲端：' + (error.code || error.message), 5000);
    });
  }

  /* ============ 播放紀錄 ============ */
  function loadHistory() {
    try {
      var a = JSON.parse(localStorage.getItem(LS_KEY + ':history'));
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }

  function saveHistoryLocal() {
    try { localStorage.setItem(LS_KEY + ':history', JSON.stringify(playHistory)); } catch (e) {}
  }

  function saveHistoryToCloud() {
    if (!currentUser || !dbAPI || !cloudReady) return;
    var docRef = dbAPI.doc(dbAPI.db, 'playlists', currentUser.uid);
    dbAPI.setDoc(docRef, { history: playHistory }, { merge: true })
      .catch(function (e) { console.error('紀錄同步失敗', e); });
  }

  function hash32(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function recordHistory(code, sid) {
    var vids = playlist.songs.map(function (s) { return parseVideoId(s.videoId); }).join(',');
    var k = sid ? 's' + sid : hash32((playlist.name || '') + '|' + vids);
    var item = {
      k: k, code: code, sid: sid || '', n: playlist.name || '未命名歌單', c: playlist.songs.length,
      cv: thumbOf(playlist.songs[0]) || '', at: Date.now()
    };
    playHistory = [item].concat(playHistory.filter(function (h) { return h.k !== k; })).slice(0, 30);
    saveHistoryLocal();
    saveHistoryToCloud();
  }

  var statusCache = {};
  function checkHistoryStatus() {
    if (!dbAPI) return;
    playHistory.forEach(function (h) {
      if (!/^[a-z0-9]{6,12}$/.test(h.sid || '') || statusCache[h.sid] !== undefined) return;
      statusCache[h.sid] = null;
      dbAPI.getDoc(dbAPI.doc(dbAPI.db, 'shared', h.sid)).then(function (snap) {
        statusCache[h.sid] = snap.exists();
        if (!snap.exists() && (location.hash === '' || location.hash === '#home')) renderHistory();
      }).catch(function () { delete statusCache[h.sid]; });
    });
  }

  function renderHistory() {
    var sec = $('historySection'), list = $('historyList');
    if (!sec || !list) return;
    sec.hidden = !playHistory.length;
    list.innerHTML = '';
    playHistory.forEach(function (h) {
      var row = document.createElement('div');
      row.className = 'playlist-card';
      row.innerHTML =
        '<a class="pc-left"><span class="hist-cover"></span><span class="pc-info">' +
        '<span class="pc-title">' + esc(h.n) + '</span>' +
        '<span class="pc-meta">' + esc(h.c) + ' 首 · ' + esc(new Date(h.at).toLocaleDateString('zh-TW')) + '</span>' +
        '</span></a><button type="button" class="icon-btn danger" aria-label="移除紀錄">✕</button>';
      var link = row.querySelector('a');
      if (h.sid && statusCache[h.sid] === false) {
        link.style.opacity = '.5';
        row.querySelector('.pc-meta').textContent = '⚠️ 此歌單已被下架或刪除';
        link.addEventListener('click', function () { toast('此歌單已被下架或刪除'); });
      } else {
        link.setAttribute('href', /^[a-z0-9]{6,12}$/.test(h.sid || '') ? '#s/' + h.sid : '#play/' + h.code);
      }
      if (/^https?:\/\//i.test(h.cv || '')) {
        row.querySelector('.hist-cover').style.backgroundImage = 'url("' + h.cv.replace(/"/g, '%22') + '")';
      }
      row.querySelector('button').addEventListener('click', function () {
        playHistory = playHistory.filter(function (x) { return x.k !== h.k; });
        saveHistoryLocal(); saveHistoryToCloud(); renderHistory();
      });
      list.appendChild(row);
    });
  }

  /* ============ 路由與權限控制 ============ */
  function route() {
    var hash = location.hash || '';

    if (hash.indexOf('#edit/') !== 0 && isDirty) {
      clearTimeout(autoSaveTimer);
      if (currentUser) saveDraftToCloud(true);
      isDirty = false;
    }

    if (hash === '#explore') { showExploreView(); return; }
    if (hash === '#nfc') { showNfcView(); return; }
    if (hash.indexOf('#play/') === 0) { showPlayView(hash.slice(6), false); return; }
    if (hash.indexOf('#s/') === 0) { loadShared(hash.slice(3)); return; }
    if (hash.indexOf('#preview/') === 0) { showPlayView(hash.slice(9), true); return; }
    
    if (!currentUser && hash.startsWith('#edit/')) {
      toast('請先登入才能編輯歌單');
      location.replace(location.pathname + location.search + '#home');
      return;
    }

    if (hash.indexOf('#edit/') === 0 && currentUser) {
      showEditView(hash.slice(6));
      return;
    }

    stopPlayback();

    if (hash === '#play' || hash === '#preview' || hash === '#edit') {
      location.replace(location.pathname + location.search + '#home');
      return;
    }
    
    showHomeView();
  }

  function isPlayHidden() {
    var v = $('viewPlay');
    return !v || v.hidden;
  }

  function stopPlayback() {
    clearTimeout(tapTimer);
    destroyPlayer();
    document.body.classList.remove('playing');
    if ($('tapPrompt')) $('tapPrompt').hidden = true;
    stopProgress();
    setBar(0);
    if ($('cur')) $('cur').textContent = '0:00';
    if ($('dur')) $('dur').textContent = '0:00';
  }

  function show(id) {
    ['viewEdit', 'viewPlay', 'viewError', 'viewHome', 'viewNfc', 'viewExplore'].forEach(function (v) {
      var el = $(v);
      if (el) el.hidden = (v !== id);
    });
    window.scrollTo(0, 0);
    var lock = id === 'viewPlay';
    document.body.classList.toggle('play-mode', lock);
    if (!lock) { stopPlayback(); setSleep(0); }
    var vp = document.querySelector('meta[name="viewport"]');
    if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover' + (lock ? ', maximum-scale=1, user-scalable=no' : ''));
  }

  /* ============ 首頁視圖 ============ */
  function showHomeView() {
    if (currentUser) {
      if (!isDirty) loadDraft();
      renderPlaylistGrid();
      if ($('memberHome')) $('memberHome').hidden = false;
      if ($('guestHome')) $('guestHome').hidden = true;
    } else {
      if ($('memberHome')) $('memberHome').hidden = true;
      if ($('guestHome')) $('guestHome').hidden = false;
    }
    statusCache = {};
    renderHistory();
    checkHistoryStatus();
    renderTemplates();
    show('viewHome');
  }

  function renderPlaylistGrid() {
    var grid = $('playlistGrid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!state.playlists.length) {
      grid.innerHTML = '<p style="text-align:center; color: var(--text-muted); font-size:14px; margin-top:20px;">目前沒有歌單，點擊上方新增吧！</p>';
      return;
    }

    var sorted = [...state.playlists].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    sorted.forEach(function(pl) {
      var a = document.createElement('a');
      a.className = 'playlist-card';
      a.href = '#edit/' + pl.id;
      
      var count = (pl.songs || []).filter(s => parseVideoId(s.videoId)).length;
      
      a.innerHTML = 
        '<div class="pc-info">' +
          '<span class="pc-title">' + esc(pl.name || '未命名歌單') + '</span>' +
          '<span class="pc-meta">' + count + ' 首歌曲' + (pl.isPublic ? ' · 🌐 公開' : '') + '</span>' +
        '</div>' +
        '<div class="pc-arrow">❯</div>';
      grid.appendChild(a);
    });
  }

  /* ============ 探索廣場視圖邏輯 ============ */
  async function showExploreView() {
    show('viewExplore');
    var grid = $('exploreGrid');
    if (!grid) return;

    function msg(t, c) {
      grid.innerHTML = '';
      var p = document.createElement('p');
      p.style.cssText = 'text-align:center;font-size:14px;margin-top:20px;color:' + (c || 'var(--text-muted)');
      p.textContent = t;
      grid.appendChild(p);
    }

    msg('載入探索廣場歌單中...');
    if (!dbAPI) { msg('資料庫未連線'); return; }

    try {
      var fetchLimit = currentUser ? 30 : 3;
      var q = dbAPI.query(dbAPI.collection(dbAPI.db, 'explore_playlists'), dbAPI.orderBy('updatedAt', 'desc'), dbAPI.limit(fetchLimit));
      var snap = await dbAPI.getDocs(q);
      var list = [];
      snap.forEach(function (d) { var x = d.data(); x._id = d.id; list.push(x); });

      if (!list.length) { msg('廣場目前還沒有公開歌單，快成為第一個發布的人吧！'); return; }

      grid.innerHTML = '';
      list.forEach(function (item) {
        if (!/^[a-z0-9]{6,12}$/.test(item._id)) return;
        var row = document.createElement('div');
        row.className = 'playlist-card';
        row.innerHTML = '<a class="pc-left"><span class="hist-cover"></span><span class="pc-info"><span class="pc-title"></span><span class="pc-meta"></span></span></a>' +
          '<div style="display:flex;gap:6px;flex-shrink:0;"></div>';
        row.querySelector('a').setAttribute('href', '#s/' + item._id);
        row.querySelector('.pc-title').textContent = item.name || '未命名歌單';
        
        var viewsNum = (item.views !== undefined && item.views !== null) ? item.views : 0;
        row.querySelector('.pc-meta').textContent = '由 ' + (item.ownerName || '匿名動漫迷') + ' 分享 · ' + (item.songsCount || 0) + ' 首 · ' + viewsNum + '次瀏覽';
        
        if (/^https?:\/\//i.test(item.coverUrl || '')) {
          row.querySelector('.hist-cover').style.backgroundImage = 'url("' + item.coverUrl.replace(/"/g, '%22') + '")';
        }

        var box = row.lastChild;
        if (currentUser) {
          var add = document.createElement('button');
          add.type = 'button'; add.className = 'icon-btn'; add.textContent = '＋';
          add.title = '複製到我的歌單';
          add.addEventListener('click', function () { copyExplorePlaylistToMine(item); });
          box.appendChild(add);

          if (item.ownerUid === currentUser.uid) {
            var del = document.createElement('button');
            del.type = 'button'; del.className = 'icon-btn danger'; del.textContent = '🗑';
            del.title = '從廣場下架';
            del.addEventListener('click', function () { unpublishExplore(item, row); });
            box.appendChild(del);
          }
        }
        grid.appendChild(row);
      });
    } catch (e) {
      console.error('載入廣場失敗', e);
      msg('無法載入探索廣場，請稍後再試。', '#ff9e9e');
    }
  }

  function unpublishExplore(item, row) {
    if (!confirm('要把「' + (item.name || '這份歌單') + '」從探索廣場下架嗎？')) return;
    var jobs = [dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'explore_playlists', item._id))];
    Promise.all(jobs).then(function () {
      state.playlists.forEach(function (p) { if (p.shareId === item._id) { p.isPublic = false; p.explored = false; } });
      saveDraft(); saveDraftToCloud(true);
      if (row.parentNode) row.parentNode.removeChild(row);
      toast('已從探索廣場下架');
    }).catch(function (e) { toast('下架失敗：' + (e.code || e.message)); });
  }

  function copyExplorePlaylistToMine(item) {
    if (!currentUser) { toast('請先登入才能複製歌單'); return; }
    var newPl = createEmptyPlaylist(item.name ? item.name + ' (來自廣場)' : '複製的歌單');
    newPl.songs = (item.songs || []).map(function (x) {
      return { anime: x.anime || '', title: x.title || '', artist: x.artist || '', videoId: x.videoId || '', cover: x.cover || '' };
    });
    newPl.vibe = item.vibe || 'default';
    state.playlists.push(newPl);
    saveDraft(); saveDraftToCloud(true);
    toast('🎉 已成功複製到你的歌單');
    location.hash = '#edit/' + newPl.id;
  }

  function bindExploreControls() {
    if ($('goToExploreBtn')) $('goToExploreBtn').addEventListener('click', function () { location.hash = '#explore'; });
    if ($('guestExploreBtn')) $('guestExploreBtn').addEventListener('click', function () { location.hash = '#explore'; });
  }

  /* ============ NFC 寫入視圖邏輯 ============ */
  function showNfcView() {
    if (!currentUser) { location.hash = '#home'; return; }
    show('viewNfc');
    var isSupported = 'NDEFReader' in window;
    if (!isSupported) {
      if ($('nfcUnsupported')) $('nfcUnsupported').hidden = false;
      if ($('nfcSupported')) $('nfcSupported').hidden = true;
      return;
    }
    if ($('nfcUnsupported')) $('nfcUnsupported').hidden = true;
    if ($('nfcSupported')) $('nfcSupported').hidden = false;
    var select = $('nfcPlaylistSelect');
    if (!select) return;
    select.innerHTML = '';
    state.playlists.forEach(function (pl) {
      var opt = document.createElement('option');
      opt.value = pl.id;
      opt.textContent = pl.name || '未命名歌單';
      select.appendChild(opt);
    });
  }

  async function handleNfcWriteProcess() {
    var selectEl = $('nfcPlaylistSelect');
    if (!selectEl) return;
    var pl = state.playlists.find(function (p) { return p.id === selectEl.value; });
    if (!pl) { toast('請選擇有效的歌單'); return; }
    
    var base = location.origin + location.pathname + location.search;
    try {
      if (!pl.shareId) pl.shareId = newShareId();
      pl.linked = true; pl.updatedAt = new Date().toISOString();
      saveDraft();
      await publishShared(pl);
      saveDraftToCloud(true);
    } catch (e) {
      toast('短網址建立失敗：' + (e.code || e.message));
      return;
    }
    var targetUrl = base + '#s/' + pl.shareId;

    try {
      var ndef = new NDEFReader();
      if ($('nfcStatusText')) $('nfcStatusText').textContent = '📡 請將 NFC 標籤貼緊手機...';
      await ndef.write({ records: [{ recordType: "url", data: targetUrl }] });
      if ($('nfcStatusText')) $('nfcStatusText').textContent = '🎉 寫入成功！';
      toast('NFC 標籤寫入成功！');
    } catch (error) {
      if ($('nfcStatusText')) $('nfcStatusText').textContent = '❌ 寫入失敗';
      toast('寫入失敗：' + error.message);
    }
  }

  function bindNfcControls() {
    if ($('goToNfcBtn')) $('goToNfcBtn').addEventListener('click', function () { location.hash = '#nfc'; });
    if ($('executeNfcWriteBtn')) $('executeNfcWriteBtn').addEventListener('click', handleNfcWriteProcess);
  }

  /* ============ 編輯視圖 ============ */
  function showEditView(id) {
    if (!currentUser) { location.hash = '#home'; return; }
    var pl = state.playlists.find(p => p.id === id);
    if (!pl) { location.hash = '#home'; return; }
    currentPlaylistId = id;
    isDirty = false;
    if ($('playlistName')) $('playlistName').value = pl.name;
    syncPublicUI(pl);
    renderEditor();
    show('viewEdit');
  }

  function renderEditor() {
    var list = $('songEditorList');
    var pl = getCurrentPlaylist();
    if (!list || !pl) return;
    list.innerHTML = '';
    if (!pl.songs.length) pl.songs.push({ anime: '', title: '', artist: '', videoId: '', cover: '' });
    pl.songs.forEach(function (song, index) { list.appendChild(buildSongCard(song, index)); });
  }

  function markDirty() {
    isDirty = true;
    if ($('saveStatus')) $('saveStatus').textContent = '未儲存';
    var pl = getCurrentPlaylist();
    if (pl) pl.updatedAt = new Date().toISOString();
    saveDraft();
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(function () {
      if (!currentUser || !isDirty) return;
      isDirty = false;
      saveDraftToCloud(true);
      if ($('saveStatus')) $('saveStatus').textContent = '已自動儲存';
    }, 1500);
  }

  function buildSongCard(song, index) {
    var el = document.createElement('div');
    el.className = 'song-card';
    el.innerHTML =
      '<div class="song-card-head">' +
        '<span class="song-num">' + (index + 1) + '</span>' +
        '<div class="song-card-tools">' +
          '<button type="button" class="icon-btn" data-act="up"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="icon-btn" data-act="down"' + (index === getCurrentPlaylist().songs.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" class="icon-btn danger" data-act="del">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="song-body">' +
        '<div class="cover-preview" data-role="cover"></div>' +
        '<div class="song-fields">' +
          '<label class="field-sm"><span>動漫</span><input data-k="anime" value="' + esc(song.anime) + '"></label>' +
          '<label class="field-sm"><span>歌名</span><input data-k="title" value="' + esc(song.title) + '"></label>' +
          '<label class="field-sm"><span>演唱者</span><input data-k="artist" value="' + esc(song.artist) + '"></label>' +
          '<label class="field-sm full"><span>YouTube 連結 / 影片 ID</span><input data-k="videoId" value="' + esc(song.videoId) + '"></label>' +
          '<label class="field-sm full"><span>封面圖網址（選填）</span><input data-k="cover" value="' + esc(song.cover) + '"></label>' +
        '</div>' +
      '</div>';

    var coverEl = el.querySelector('[data-role="cover"]');
    function updateCover() {
      var url = thumbOf(song);
      if (!url) { coverEl.style.backgroundImage = ''; coverEl.textContent = '無圖'; return; }
      coverEl.style.backgroundImage = 'url("' + url + '")';
      coverEl.textContent = '';
    }
    updateCover();

    el.querySelectorAll('input[data-k]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        song[inp.dataset.k] = inp.value;
        if (inp.dataset.k === 'videoId' || inp.dataset.k === 'cover') updateCover();
        markDirty();
      });
    });

    el.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pl = getCurrentPlaylist();
        var i = pl.songs.indexOf(song);
        var act = btn.dataset.act;
        if (act === 'up' && i > 0) {
          var tmp = pl.songs[i - 1]; pl.songs[i - 1] = pl.songs[i]; pl.songs[i] = tmp;
        } else if (act === 'down' && i < pl.songs.length - 1) {
          var tmp2 = pl.songs[i + 1]; pl.songs[i + 1] = pl.songs[i]; pl.songs[i] = tmp2;
        } else if (act === 'del') {
          if (pl.songs.length <= 1) { toast('至少要保留一首歌'); return; }
          pl.songs.splice(i, 1);
        }
        markDirty();
        renderEditor();
      });
    });
    return el;
  }

  /* ============ 播放視圖與氣氛主題、翻面邏輯 ============ */
  var player = null;
  var playlist = null;
  var currentIndex = 0;
  var currentVinylSide = 'A';
  var progressTimer = null;
  var tapTimer = null;
  var lastSec = -1;
  var currentPlayCode = null;
  var ytApiReady = false;

  function packPayload(pl) {
    return {
      n: pl.name || '',
      vibe: pl.vibe || 'default',
      s: (pl.songs || []).map(function (s) {
        var o = {};
        if (s.anime) o.a = s.anime;
        if (s.title) o.t = s.title;
        if (s.artist) o.r = s.artist;
        var vid = parseVideoId(s.videoId);
        if (vid) o.v = vid;
        if (s.cover) o.c = s.cover;
        return o;
      })
    };
  }

  function unpackPayload(mini) {
    return {
      name: mini.n || '未命名歌單',
      vibe: mini.vibe || 'default',
      songs: (mini.s || []).map(function (o) {
        return { anime: o.a || '', title: o.t || '', artist: o.r || '', videoId: o.v || '', cover: o.c || '' };
      })
    };
  }

  function encodePlaylist(pl) {
    var json = JSON.stringify(packPayload(pl));
    if (window.LZString && LZString.compressToEncodedURIComponent) {
      return 'L' + LZString.compressToEncodedURIComponent(json).replace(/\+/g, '.');
    }
    return 'B' + b64urlEncode(json);
  }

  function decodePlaylist(code) {
    var type = code.charAt(0), body = code.slice(1), json;
    if (type === 'L') {
      json = LZString.decompressFromEncodedURIComponent(body.replace(/\./g, '+'));
    } else {
      var s = body.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      json = new TextDecoder().decode(new Uint8Array(atob(s).split('').map(c => c.charCodeAt(0))));
    }
    return unpackPayload(JSON.parse(json));
  }

  function b64urlEncode(str) {
    var bin = ''; new TextEncoder().encode(str).forEach(c => bin += String.fromCharCode(c));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function publishShared(pl) {
    var mini = packPayload(pl);
    return dbAPI.setDoc(dbAPI.doc(dbAPI.db, 'shared', pl.shareId), {
      owner: currentUser.uid, n: mini.n, vibe: mini.vibe, s: mini.s, u: new Date().toISOString()
    });
  }

  function loadShared(id) {
    if (!/^[a-z0-9]{6,12}$/.test(id)) return;
    dbAPI.getDoc(dbAPI.doc(dbAPI.db, 'shared', id)).then(async function (snap) {
      if (!snap.exists()) return;
      var d = snap.data();
      showPlayView(encodePlaylist(unpackPayload({ n: d.n, vibe: d.vibe, s: d.s })), false, id);
      try {
        var expRef = dbAPI.doc(dbAPI.db, 'explore_playlists', id);
        var expSnap = await dbAPI.getDoc(expRef);
        if (expSnap.exists()) {
          await dbAPI.setDoc(expRef, { views: (expSnap.data().views || 0) + 1 }, { merge: true });
        }
      } catch (err) {}
    });
  }

  function applyVibeTheme(vibe) {
    var viewPlay = $('viewPlay');
    if (!viewPlay) return;
    viewPlay.classList.remove('vibe-rain', 'vibe-sakura', 'vibe-cyber', 'vibe-crt');
    if (vibe && vibe !== 'default') {
      viewPlay.classList.add('vibe-' + vibe);
    }
  }

  function showPlayView(code, isPreview, sid) {
    if (!isPreview) previewFromId = null;
    var same = !!player && code === currentPlayCode && !$('viewPlay').hidden;
    try { playlist = decodePlaylist(code); currentPlayCode = code; } catch (e) { return; }

    playlist.songs = (playlist.songs || []).filter(s => parseVideoId(s.videoId));
    if (!playlist.songs.length) return;

    if (!isPreview && !same) recordHistory(code, sid);
    if ($('backLink')) {
      $('backLink').hidden = !currentUser;
      var toEdit = isPreview && previewFromId;
      $('backLink').href = toEdit ? '#edit/' + previewFromId : '#home';
    }

    if (!same) {
      currentIndex = 0;
      currentVinylSide = 'A';
      var vinyl = document.querySelector('.vinyl');
      if (vinyl) vinyl.classList.remove('flipped');
      if ($('sideBtn')) $('sideBtn').textContent = '盤面: A';
    }

    show('viewPlay');
    applyVibeTheme(playlist.vibe);
    renderPlayMeta();
    renderDrawer();
    if (!same) initYTPlayer();
    bindSwipeGestures();
  }

  function switchVinylSide() {
    if (!playlist || !playlist.songs.length) return;
    currentVinylSide = (currentVinylSide === 'A' ? 'B' : 'A');
    var vinyl = document.querySelector('.vinyl');
    if (vinyl) vinyl.classList.toggle('flipped', currentVinylSide === 'B');
    if ($('sideBtn')) $('sideBtn').textContent = '盤面: ' + currentVinylSide;

    var half = Math.ceil(playlist.songs.length / 2);
    if (currentVinylSide === 'B' && playlist.songs.length > 1) {
      toast('翻至 B 面');
      goToSong(half);
    } else {
      toast('翻至 A 面');
      goToSong(0);
    }
  }

  function renderPlayMeta() {
    var s = playlist.songs[currentIndex];
    if ($('anime')) $('anime').textContent = s.anime || '';
    if ($('title')) $('title').textContent = s.title || '未命名歌曲';
    if ($('artist')) $('artist').textContent = s.artist || '';
    var url = thumbOf(s);
    if ($('label')) $('label').style.backgroundImage = url ? 'url("' + url + '")' : '';
  }

  function initYTPlayer() {
    if (isPlayHidden()) return;
    var vid = parseVideoId(playlist.songs[currentIndex].videoId);
    if (player && player.loadVideoById) {
      try { player.loadVideoById(vid); } catch (e) { destroyPlayer(); createYTPlayer(vid); }
      return;
    }
    if (!ytApiReady) {
      if (!window._ytLoading) {
        window._ytLoading = true;
        var tag = document.createElement('script'); tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
      window.onYouTubeIframeAPIReady = function () {
        window._ytLoading = false; ytApiReady = true;
        if (!isPlayHidden()) createYTPlayer(parseVideoId(playlist.songs[currentIndex].videoId));
      };
      return;
    }
    createYTPlayer(vid);
  }

  function destroyPlayer() {
    if (player) { try { player.destroy(); } catch (e) {} player = null; }
  }

  function createYTPlayer(videoId) {
    player = new YT.Player('ytHost', {
      videoId: videoId,
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, fs: 0 },
      events: { onReady: () => { try { player.playVideo(); } catch (e) {} }, onStateChange: st => {
        if (st.data === 1) { document.body.classList.add('playing'); startProgress(); }
        else if (st.data === 2 || st.data === 0) { document.body.classList.remove('playing'); stopProgress(); if(st.data === 0) goToSong((currentIndex + 1) % playlist.songs.length); }
      }}
    });
  }

  function goToSong(i) {
    if (isPlayHidden() || i < 0 || i >= playlist.songs.length) return;
    currentIndex = i;
    renderPlayMeta();
    renderDrawer();
    initYTPlayer();
  }

  function startProgress() {
    stopProgress();
    progressTimer = setInterval(() => {
      if (seeking || !player || !player.getDuration) return;
      var d = player.getDuration(), c = player.getCurrentTime();
      if (d) setBar(c / d);
      if ($('cur')) $('cur').textContent = fmtTime(c);
      if ($('dur')) $('dur').textContent = fmtTime(d);
    }, 250);
  }

  function stopProgress() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }
  function setBar(r) {
    if ($('fill')) $('fill').style.transform = 'scaleX(' + r + ')';
    if ($('thumb')) $('thumb').style.left = 'calc(' + (r * 100) + '% - 6px)';
  }

  function renderDrawer() {
    var list = $('drawerList');
    if (!list) return;
    list.innerHTML = '';
    playlist.songs.forEach((s, i) => {
      var btn = document.createElement('button');
      btn.className = 'drawer-item' + (i === currentIndex ? ' active' : '');
      btn.innerHTML = '<span class="di-info"><span class="di-title">' + esc(s.title || '未命名') + '</span></span>';
      btn.addEventListener('click', () => { goToSong(i); $('playlistDrawer').hidden = true; });
      list.appendChild(btn);
    });
  }

  function bindPlayControls() {
    if ($('playBtn')) $('playBtn').addEventListener('click', () => {
      if (!player || !player.playVideo) return;
      if (player.getPlayerState() === 1) player.pauseVideo(); else player.playVideo();
    });
    if ($('sideBtn')) $('sideBtn').addEventListener('click', switchVinylSide);
    if ($('vinylPlinth')) $('vinylPlinth').addEventListener('click', (e) => {
      if (e.target.closest('.vinyl')) switchVinylSide();
    });
    if ($('listToggle')) $('listToggle').addEventListener('click', () => { $('playlistDrawer').hidden = !$('playlistDrawer').hidden; });
    if ($('drawerClose')) $('drawerClose').addEventListener('click', () => { $('playlistDrawer').hidden = true; });
  }

  function bindSwipeGestures() {}

  /* ============ 全站主題色與氣氛主題控制 ============ */
  var ACCENTS = [['青', '#00e5ff'], ['櫻', '#ff6fb5'], ['紫', '#a78bfa'], ['琥珀', '#ffb020'], ['薄荷', '#34d399'], ['紅蓮', '#ff4757']];
  var theme = { accent: '#00e5ff' };

  function applyTheme() {
    var c = [parseInt(theme.accent.slice(1, 3), 16), parseInt(theme.accent.slice(3, 5), 16), parseInt(theme.accent.slice(5, 7), 16)].join(',');
    document.documentElement.style.setProperty('--accent', theme.accent);
    document.documentElement.style.setProperty('--accent-rgb', c);
    document.documentElement.style.setProperty('--accent-dim', 'rgba(' + c + ',.2)');
  }

  function bindExtras() {
    try {
      var t = JSON.parse(localStorage.getItem('anime-vinyl:theme'));
      if (t && /^#[0-9a-f]{6}$/i.test(t.accent)) theme.accent = t.accent;
    } catch (e) {}
    applyTheme();

    var accentBox = $('accentSwatches');
    if (accentBox) {
      accentBox.innerHTML = '';
      ACCENTS.forEach(it => {
        var b = document.createElement('button');
        b.className = 'swatch'; b.style.background = it[1];
        b.addEventListener('click', () => { theme.accent = it[1]; applyTheme(); localStorage.setItem('anime-vinyl:theme', JSON.stringify(theme)); });
        accentBox.appendChild(b);
      });
    }

    if ($('themeBtn')) $('themeBtn').addEventListener('click', () => { $('themeModal').hidden = false; $('themeModal').classList.add('show'); });
    if ($('themeDone')) $('themeDone').addEventListener('click', () => { $('themeModal').classList.remove('show'); setTimeout(() => $('themeModal').hidden = true, 300); });

    var vibeModal = $('vibeModal');
    if ($('themeBtnPlay')) $('themeBtnPlay').addEventListener('click', () => { vibeModal.hidden = false; vibeModal.classList.add('show'); });
    if ($('vibeDone')) $('vibeDone').addEventListener('click', () => { vibeModal.classList.remove('show'); setTimeout(() => vibeModal.hidden = true, 300); });

    vibeModal.querySelectorAll('[data-vibe]').forEach(btn => {
      btn.addEventListener('click', () => {
        var v = btn.dataset.vibe;
        if (playlist) {
          playlist.vibe = v;
          applyVibeTheme(v);
          saveDraft();
          if (currentUser) saveDraftToCloud(true);
        }
        toast('已切換氣氛主題');
      });
    });
  }

  /* ============ 初始化 ============ */
  function init() {
    bindEditorControls();
    bindPlayControls();
    bindNfcControls();
    bindExploreControls();
    bindExtras();
    loadDraft();
    route();
    window.addEventListener('hashchange', route);
    if (window.firebaseAuth) {
      window.firebaseAuth.onAuthStateChanged(window.firebaseAuth.auth, user => {
        currentUser = user;
        if (user) loadDraft();
        route();
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

})();
