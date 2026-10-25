(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

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
    if (song.cover && /^https?:\/\//i.test(song.cover)) return song.cover;
    var vid = parseVideoId(song.videoId);
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
    await dbAPI.setDoc(exploreRef, {
      id: pl.shareId,
      name: pl.name || '未命名歌單',
      ownerName: (pl.nick || '匿名動漫迷').slice(0, 20),
      ownerUid: currentUser.uid,
      songsCount: validSongs.length,
      coverUrl: thumbOf(validSongs[0]),
      songs: validSongs,
      updatedAt: new Date().toISOString()
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

    if (hash === '#explore') {
      showExploreView();
      return;
    }

    if (hash === '#nfc') {
      showNfcView();
      return;
    }

    if (hash.indexOf('#play/') === 0) {
      showPlayView(hash.slice(6), false);
      return;
    }
    if (hash.indexOf('#s/') === 0) {
      loadShared(hash.slice(3));
      return;
    }
    if (hash.indexOf('#preview/') === 0) {
      showPlayView(hash.slice(9), true);
      return;
    }
    
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

  /* ============ 探索廣場視圖邏輯 (未登入時前3筆並加上漸層) ============ */
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

      var parent = grid.parentNode;
      if (parent.classList.contains('explore-guest-wrapper')) {
        var oldOverlay = parent.querySelector('.explore-login-overlay');
        if (oldOverlay) oldOverlay.remove();
        parent.classList.remove('blurred');
      }

      grid.innerHTML = '';

      list.forEach(function (item) {
        if (!/^[a-z0-9]{6,12}$/.test(item._id)) return;
        var row = document.createElement('div');
        row.className = 'playlist-card';
        row.innerHTML = '<a class="pc-left"><span class="hist-cover"></span><span class="pc-info"><span class="pc-title"></span><span class="pc-meta"></span></span></a>' +
          '<div style="display:flex;gap:6px;flex-shrink:0;"></div>';
        row.querySelector('a').setAttribute('href', '#s/' + item._id);
        row.querySelector('.pc-title').textContent = item.name || '未命名歌單';
        row.querySelector('.pc-meta').textContent = '由 ' + (item.ownerName || '匿名動漫迷') + ' 分享 · ' + (item.songsCount || 0) + ' 首';
        
        if (/^https?:\/\//i.test(item.coverUrl || '')) {
          row.querySelector('.hist-cover').style.backgroundImage = 'url("' + item.coverUrl.replace(/"/g, '%22') + '")';
        }

        var box = row.lastChild;
        if (currentUser) {
          var add = document.createElement('button');
          add.type = 'button'; add.className = 'icon-btn'; add.textContent = '＋';
          add.title = '複製到我的歌單'; add.setAttribute('aria-label', '複製到我的歌單');
          add.addEventListener('click', function () { copyExplorePlaylistToMine(item); });
          box.appendChild(add);

          if (item.ownerUid === currentUser.uid) {
            var del = document.createElement('button');
            del.type = 'button'; del.className = 'icon-btn danger'; del.textContent = '🗑';
            del.title = '從廣場下架'; del.setAttribute('aria-label', '從探索廣場下架');
            del.addEventListener('click', function () { unpublishExplore(item, row); });
            box.appendChild(del);
          } else {
            var rep = document.createElement('button');
            rep.type = 'button'; rep.className = 'icon-btn'; rep.textContent = '🚩';
            rep.title = '檢舉'; rep.setAttribute('aria-label', '檢舉這份歌單');
            rep.addEventListener('click', function () { reportExplore(item); });
            box.appendChild(rep);
          }
        }
        grid.appendChild(row);
      });

      if (!currentUser) {
        var wrapper = grid.parentNode;
        if (!wrapper.classList.contains('explore-guest-wrapper')) {
          wrapper = document.createElement('div');
          wrapper.className = 'explore-guest-wrapper';
          grid.parentNode.insertBefore(wrapper, grid);
          wrapper.appendChild(grid);
        }

        wrapper.classList.add('blurred');

        var overlay = document.createElement('div');
        overlay.className = 'explore-login-overlay';
        overlay.innerHTML = 
          '<p>🔒 想要探索更多動漫黑膠歌單嗎？<br>立即登入解鎖完整內容！</p>' +
          '<button class="btn-block primary" type="button">🔑 立即登入</button>';

        overlay.querySelector('button').addEventListener('click', function () {
          triggerLogin();
        });

        wrapper.appendChild(overlay);
      }

    } catch (e) {
      console.error('載入廣場失敗', e);
      msg('無法載入探索廣場，請稍後再試。', '#ff9e9e');
    }
  }

  function unpublishExplore(item, row) {
    if (!confirm('要把「' + (item.name || '這份歌單') + '」從探索廣場下架嗎？\n（你自己的歌單不會被刪除）')) return;
    var inUse = state.playlists.some(function (p) { return p.shareId === item._id && p.linked !== false; });
    var jobs = [dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'explore_playlists', item._id))];
    if (!inUse) jobs.push(dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'shared', item._id)).catch(function () {}));
    Promise.all(jobs).then(function () {
      state.playlists.forEach(function (p) { if (p.shareId === item._id) { p.isPublic = false; p.explored = false; } });
      saveDraft();
      saveDraftToCloud(true);
      if (row.parentNode) row.parentNode.removeChild(row);
      toast('已從探索廣場下架');
    }).catch(function (e) { toast('下架失敗：' + (e.code || e.message)); });
  }

  function reportExplore(item) {
    if (!currentUser) { toast('請先登入才能檢舉'); return; }
    var reason = prompt('請簡述檢舉原因（例如：侵權、不當內容、垃圾訊息）：');
    if (!reason || !reason.trim()) return;
    dbAPI.setDoc(dbAPI.doc(dbAPI.collection(dbAPI.db, 'reports')), {
      target: item._id,
      name: String(item.name || '').slice(0, 80),
      reason: reason.trim().slice(0, 200),
      reporter: currentUser.uid,
      at: Date.now()
    }).then(function () { toast('已送出檢舉，謝謝你的回報'); })
      .catch(function (e) { toast('檢舉失敗：' + (e.code || e.message)); });
  }

  function copyExplorePlaylistToMine(item) {
    if (!currentUser) {
      toast('請先登入才能複製歌單');
      return;
    }
    var newPl = createEmptyPlaylist(item.name ? item.name + ' (來自廣場)' : '複製的歌單');
    newPl.songs = (item.songs || []).map(function (x) {
      return {
        anime: x.anime || '',
        title: x.title || '',
        artist: x.artist || '',
        videoId: x.videoId || '',
        cover: x.cover || ''
      };
    });
    state.playlists.push(newPl);
    saveDraft();
    saveDraftToCloud(true);
    toast('🎉 已成功複製到你的歌單');
    location.hash = '#edit/' + newPl.id;
  }

  function bindExploreControls() {
    if ($('goToExploreBtn')) $('goToExploreBtn').addEventListener('click', function () { location.hash = '#explore'; });
    if ($('guestExploreBtn')) $('guestExploreBtn').addEventListener('click', function () { location.hash = '#explore'; });
  }

  /* ============ NFC 專屬視圖邏輯 ============ */
  function showNfcView() {
    if (!currentUser) {
      toast('請先登入才能使用 NFC 寫入工具');
      location.hash = '#home';
      return;
    }
    show('viewNfc');
    
    var isSupported = 'NDEFReader' in window;
    
    if (!isSupported) {
      if ($('nfcUnsupported')) $('nfcUnsupported').hidden = false;
      if ($('nfcSupported')) $('nfcSupported').hidden = true;
      return;
    }
    
    if ($('nfcUnsupported')) $('nfcUnsupported').hidden = true;
    if ($('nfcSupported')) $('nfcSupported').hidden = false;
    if ($('nfcStatusText')) $('nfcStatusText').textContent = '請選擇要寫入的歌單，並準備好 NFC 標籤';
    
    var select = $('nfcPlaylistSelect');
    if (!select) return;
    select.innerHTML = '';
    
    if (!state.playlists || state.playlists.length === 0) {
      select.innerHTML = '<option value="">目前沒有可用歌單</option>';
      if ($('executeNfcWriteBtn')) $('executeNfcWriteBtn').disabled = true;
      return;
    }
    
    if ($('executeNfcWriteBtn')) $('executeNfcWriteBtn').disabled = false;
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
    var selectId = selectEl.value;
    var pl = state.playlists.find(function (p) { return p.id === selectId; });
    if (!pl) {
      toast('請選擇有效的歌單');
      return;
    }
    
    var base = location.origin + location.pathname + location.search;
    var targetUrl = '';
    if (!currentUser || !dbAPI || !cloudReady) { toast('請先登入並等待雲端連線，才能寫入短網址'); return; }
    if (!pl.songs.some(function (x) { return parseVideoId(x.videoId); })) { toast('這份歌單還沒有有效的歌曲'); return; }
    try {
      if (!pl.shareId) pl.shareId = newShareId();
      if (pl.linked !== true) { pl.linked = true; pl.updatedAt = new Date().toISOString(); saveDraft(); }
      await publishShared(pl);
      saveDraftToCloud(true);
    } catch (e) {
      toast('短網址建立失敗：' + (e.code || e.message), 5000);
      return;
    }
    targetUrl = base + '#s/' + pl.shareId;

    try {
      var ndef = new NDEFReader();
      var statusText = $('nfcStatusText');
      
      if (statusText) statusText.textContent = '🔍 請將 NFC 標籤靠近手機感應處以檢查標籤...';
      toast('請將手機靠近 NFC 標籤');

      var hasExistingData = await new Promise(function (resolve) {
        var timeout = setTimeout(function () {
          resolve(false);
        }, 4000);

        try {
          ndef.scan().then(function() {
            ndef.onreading = function (event) {
              clearTimeout(timeout);
              var records = event.message.records;
              resolve(records && records.length > 0);
            };
          }).catch(function() {
            clearTimeout(timeout);
            resolve(false);
          });
        } catch (e) {
          clearTimeout(timeout);
          resolve(false);
        }
      });

      if (hasExistingData) {
        var confirmOverwrite = confirm('偵測到此 NFC 標籤內已有其他資料！\n是否要清除並覆蓋寫入目前的歌單？\n（按下「取消」將會退出）');
        if (!confirmOverwrite) {
          if (statusText) statusText.textContent = '已取消寫入操作';
          toast('已取消寫入');
          return;
        }
      }

      if (statusText) statusText.textContent = '📡 偵測到 NFC 標籤！請保持貼緊，正在寫入...';
      
      await ndef.write({
        records: [{ recordType: "url", data: targetUrl }]
      });

      if (statusText) statusText.textContent = '🎉 寫入成功！您可以將標籤移開了。';
      toast('NFC 標籤寫入成功！');

    } catch (error) {
      console.error('NFC 寫入失敗:', error);
      if ($('nfcStatusText')) $('nfcStatusText').textContent = '❌ 寫入失敗，請重試';
      
      if (error.name === 'NotAllowedError') {
        toast('權限被拒絕，請允許 NFC 權限');
      } else if (error.name === 'NotSupportedError' || (error.message && error.message.includes('full'))) {
        toast('寫入失敗：NFC 標籤容量不足，無法容納此歌單');
      } else {
        toast('寫入失敗：' + error.message);
      }
    }
  }

  function bindNfcControls() {
    if ($('goToNfcBtn')) {
      $('goToNfcBtn').addEventListener('click', function () {
        location.hash = '#nfc';
      });
    }

    if ($('executeNfcWriteBtn')) {
      $('executeNfcWriteBtn').addEventListener('click', function () {
        handleNfcWriteProcess();
      });
    }
  }

  /* ============ 編輯視圖 ============ */
  function showEditView(id) {
    if (!currentUser) {
      location.hash = '#home';
      return;
    }
    var pl = state.playlists.find(p => p.id === id);
    if (!pl) {
      toast('找不到該歌單，可能已被刪除');
      location.hash = '#home';
      return;
    }
    currentPlaylistId = id;
    isDirty = false;
    
    if ($('playlistName')) $('playlistName').value = pl.name;
    syncPublicUI(pl);
    if ($('saveStatus')) $('saveStatus').textContent = '';
    renderEditor();
    show('viewEdit');
  }

  function renderEditor() {
    var list = $('songEditorList');
    var pl = getCurrentPlaylist();
    if (!list || !pl) return;
    
    list.innerHTML = '';
    if (!pl.songs.length) {
      pl.songs.push({ anime: '', title: '', artist: '', videoId: '', cover: '' });
    }
    pl.songs.forEach(function (song, index) {
      list.appendChild(buildSongCard(song, index));
    });
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
          '<label class="field-sm"><span>動漫</span><input data-k="anime" value="' + esc(song.anime) + '" placeholder="進擊的巨人"></label>' +
          '<label class="field-sm"><span>歌名</span><input data-k="title" value="' + esc(song.title) + '" placeholder="紅蓮の弓矢"></label>' +
          '<label class="field-sm"><span>演唱者</span><input data-k="artist" value="' + esc(song.artist) + '" placeholder="Linked Horizon"></label>' +
          '<label class="field-sm full"><span>YouTube 連結 / 影片 ID</span><input data-k="videoId" value="' + esc(song.videoId) + '" placeholder="https://youtu.be/... 或 11 位影片 ID"></label>' +
          '<label class="field-sm full"><span>封面圖網址（選填）</span><input data-k="cover" value="' + esc(song.cover) + '" placeholder="留空自動使用 YouTube 縮圖"></label>' +
        '</div>' +
      '</div>';

    var coverEl = el.querySelector('[data-role="cover"]');
    var coverTimer = null;

    function updateCover() {
      var url = thumbOf(song);
      if (!url) {
        coverEl.style.backgroundImage = '';
        coverEl.textContent = '無圖';
        return;
      }
      var img = new Image();
      img.onload = function () {
        coverEl.style.backgroundImage = 'url("' + url + '")';
        coverEl.textContent = '';
      };
      img.onerror = function () {
        coverEl.style.backgroundImage = '';
        coverEl.textContent = '無圖';
      };
      img.src = url;
    }
    updateCover();

    el.querySelectorAll('input[data-k]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var k = inp.dataset.k;
        song[k] = inp.value;
        if (k === 'videoId' || k === 'cover') { clearTimeout(coverTimer); coverTimer = setTimeout(updateCover, 300); }
        markDirty();
      });
      inp.addEventListener('blur', function () {
        if (inp.dataset.k === 'videoId') {
          var id = parseVideoId(inp.value);
          if (id && id !== inp.value) {
            inp.value = id;
            song.videoId = id;
            markDirty();
          }
          updateCover();
        }
      });
    });

    el.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pl = getCurrentPlaylist();
        if (!pl) return;
        var act = btn.dataset.act;
        var i = pl.songs.indexOf(song);
        
        if (act === 'up' && i > 0) {
          var tmp = pl.songs[i - 1];
          pl.songs[i - 1] = pl.songs[i];
          pl.songs[i] = tmp;
        } else if (act === 'down' && i < pl.songs.length - 1) {
          var tmp2 = pl.songs[i + 1];
          pl.songs[i + 1] = pl.songs[i];
          pl.songs[i] = tmp2;
        } else if (act === 'del') {
          if (pl.songs.length <= 1) {
            toast('至少要保留一首歌');
            return;
          }
          pl.songs.splice(i, 1);
        }
        markDirty();
        renderEditor();
      });
    });

    return el;
  }

  /* ============ 播放視圖 ============ */
  var player = null;
  var playlist = null;
  var currentIndex = 0;
  var progressTimer = null;
  var tapTimer = null;
  var lastSec = -1;
  var currentPlayCode = null;
  var ytApiReady = false;

  function packPayload(pl) {
    var mini = {
      n: pl.name || '',
      s: (pl.songs || []).map(function (s) {
        var o = {};
        if (s.anime)  o.a = s.anime;
        if (s.title)  o.t = s.title;
        if (s.artist) o.r = s.artist;
        var vid = parseVideoId(s.videoId);
        if (vid) o.v = vid;
        if (s.cover)  o.c = s.cover;
        return o;
      })
    };
    return mini;
  }

  function unpackPayload(mini) {
    var out = { name: mini.n || '未命名歌單', songs: [] };
    (mini.s || []).forEach(function (o) {
      out.songs.push({
        anime:  o.a || '',
        title:  o.t || '',
        artist: o.r || '',
        videoId: o.v || '',
        cover:  o.c || ''
      });
    });
    return out;
  }

  function b64urlEncode(str) {
    var bin = '';
    new TextEncoder().encode(str).forEach(function (c) { bin += String.fromCharCode(c); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(u);
  }

  function encodePlaylist(pl) {
    var mini = packPayload(pl);
    var json = JSON.stringify(mini);
    if (window.LZString && LZString.compressToEncodedURIComponent) {
      var compressed = LZString.compressToEncodedURIComponent(json);
      return 'L' + compressed.replace(/\+/g, '.');
    }
    return 'B' + b64urlEncode(json);
  }

  function decodePlaylist(code) {
    if (!code) throw new Error('歌單資料是空的');
    var type = code.charAt(0);
    var body = code.slice(1);
    var json;

    if (type === 'L') {
      if (!window.LZString || !LZString.decompressFromEncodedURIComponent) {
        throw new Error('缺少解壓縮元件');
      }
      json = LZString.decompressFromEncodedURIComponent(body.replace(/\./g, '+'));
    } else if (type === 'B') {
      json = b64urlDecode(body);
    } else {
      throw new Error('未知的歌單格式');
    }

    if (!json) throw new Error('歌單資料毀損');
    return unpackPayload(JSON.parse(json));
  }

  function publishShared(pl) {
    var mini = packPayload(pl);
    return dbAPI.setDoc(dbAPI.doc(dbAPI.db, 'shared', pl.shareId), {
      owner: currentUser.uid, n: mini.n, s: mini.s, u: new Date().toISOString()
    });
  }

  function removeShared(pl) {
    if (pl && pl.shareId && currentUser && dbAPI) {
      dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'shared', pl.shareId)).catch(function (e) { console.error(e); });
      dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'explore_playlists', pl.shareId)).catch(function (e) { console.error(e); });
    }
  }

  function loadShared(id) {
    if (!/^[a-z0-9]{6,12}$/.test(id)) { showError('無效的分享連結'); return; }
    if (!dbAPI) return;
    dbAPI.getDoc(dbAPI.doc(dbAPI.db, 'shared', id)).then(function (snap) {
      if (location.hash !== '#s/' + id) return;
      if (!snap.exists()) { showError('此歌單已被下架或刪除。'); return; }
      var d = snap.data();
      showPlayView(encodePlaylist(unpackPayload({ n: d.n, s: d.s })), false, id);
    }).catch(function (e) { showError('無法讀取歌單：' + (e.code || e.message)); });
  }

  function showPlayView(code, isPreview, sid) {
    if (!isPreview) previewFromId = null;
    var same = !!player && code === currentPlayCode && !$('viewPlay').hidden;
    try {
      playlist = decodePlaylist(code);
      currentPlayCode = code;
    } catch (e) {
      showError('無法讀取歌單：' + e.message);
      return;
    }

    playlist.songs = (playlist.songs || []).filter(function (s) {
      return parseVideoId(s.videoId);
    });

    if (!playlist.songs.length) {
      showError('這個歌單裡沒有有效的歌曲。\n請回到編輯頁，至少加入一首有 YouTube 影片 ID 的歌。');
      return;
    }

    document.title = (playlist.name || 'Anime Vinyl') + ' — Anime Vinyl';
    if (!isPreview && !same) recordHistory(code, sid);
    
    if ($('backLink')) {
      $('backLink').hidden = !currentUser;
      var toEdit = isPreview && previewFromId;
      $('backLink').href = toEdit ? '#edit/' + previewFromId : '#home';
      $('backLink').textContent = toEdit ? '← 返回編輯' : '← 首頁';
    }
    
    if ($('deletePlayBtn')) {
      $('deletePlayBtn').style.display = (isPreview && currentUser && previewFromId) ? 'grid' : 'none';
    }

    if (!same) currentIndex = 0;
    show('viewPlay');
    renderPlayMeta();
    renderDrawer();
    if (!same) initYTPlayer();
    bindSwipeGestures();
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata || !playlist) return;
    var s = playlist.songs[currentIndex];
    var u = thumbOf(s);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title || '未命名歌曲', artist: s.artist || '', album: s.anime || '',
      artwork: u ? [{ src: u }] : []
    });
  }

  function bindMediaKeys() {
    if (!('mediaSession' in navigator)) return;
    var h = {
      play: function () { if (player && player.playVideo) player.playVideo(); },
      pause: function () { if (player && player.pauseVideo) player.pauseVideo(); },
      previoustrack: function () { goToSong(pickPrev()); },
      nexttrack: function () { goToSong(pickNext(false)); }
    };
    Object.keys(h).forEach(function (k) { try { navigator.mediaSession.setActionHandler(k, h[k]); } catch (e) {} });
  }

  function renderPlayMeta() {
    var s = playlist.songs[currentIndex];
    if ($('anime')) $('anime').textContent = s.anime || '';
    if ($('title')) $('title').textContent = s.title || '未命名歌曲';
    if ($('artist')) $('artist').textContent = s.artist || '';
    var url = thumbOf(s);
    if ($('label')) $('label').style.backgroundImage = url ? 'url("' + url + '")' : '';
    
    updateMediaSession();
    if ($('prevArrow')) $('prevArrow').classList.toggle('disabled', playMode === 'off' && currentIndex === 0);
    if ($('nextArrow')) $('nextArrow').classList.toggle('disabled', playMode === 'off' && currentIndex >= playlist.songs.length - 1);
    if ($('prevBtn')) $('prevBtn').disabled = playMode === 'off' && currentIndex === 0;
    if ($('nextBtn')) $('nextBtn').disabled = playMode === 'off' && currentIndex >= playlist.songs.length - 1;
  }

  function initYTPlayer() {
    if (isPlayHidden()) return;
    var s = playlist.songs[currentIndex];
    if (!s) return;
    var vid = parseVideoId(s.videoId);

    if (player && player.loadVideoById) {
      try {
        player.loadVideoById(vid);
      } catch (e) {
        console.warn('Load video failed, recreating player', e);
        destroyPlayer();
        createYTPlayer(vid);
      }
      return;
    }

    if (!ytApiReady) {
      if (!window._ytLoading) {
        window._ytLoading = true;
        var tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
      window.onYouTubeIframeAPIReady = function () {
        window._ytLoading = false;
        ytApiReady = true;
        if (isPlayHidden()) return;
        createYTPlayer(parseVideoId(playlist.songs[currentIndex].videoId));
      };
      return;
    }

    createYTPlayer(vid);
  }

  function destroyPlayer() {
    if (player) {
      try { player.destroy(); } catch (e) {}
      player = null;
    }
  }

  function createYTPlayer(videoId) {
    var host = $('ytHost');
    if (!host) return;

    var vars = {
      autoplay: 0, controls: 0, disablekb: 1,
      modestbranding: 1, rel: 0, playsinline: 1, fs: 0
    };
    if (location.protocol.indexOf('http') === 0) vars.origin = location.origin;

    try {
      player = new YT.Player('ytHost', {
        videoId: videoId,
        playerVars: vars,
        events: {
          onReady: onYTReady,
          onStateChange: onYTStateChange,
          onError: onYTError
        }
      });
    } catch (e) {
      console.error('Failed to create YT Player', e);
      toast('播放器初始化失敗');
    }
  }

  function onYTReady() {
    if (isPlayHidden()) { 
      destroyPlayer();
      if ($('tapPrompt')) $('tapPrompt').hidden = true;
      return; 
    }
    if ($('dur')) $('dur').textContent = fmtTime(player.getDuration());
    try { player.playVideo(); } catch (e) {}

    clearTimeout(tapTimer);
    tapTimer = setTimeout(function () {
      if (!player || !player.getPlayerState || isPlayHidden()) {
        if ($('tapPrompt')) $('tapPrompt').hidden = true;
        return;
      }
      if (player.getPlayerState() !== 1) {
        if ($('tapPrompt')) $('tapPrompt').hidden = false;
      }
    }, 1500);
  }

  function onYTStateChange(e) {
    var st = e.data;
    if (isPlayHidden()) { 
      destroyPlayer();
      if ($('tapPrompt')) $('tapPrompt').hidden = true;
      return; 
    }
    if (st === 1) {
      document.body.classList.add('playing');
      if ($('playBtn')) $('playBtn').textContent = '❚❚';
      if ($('tapPrompt')) $('tapPrompt').hidden = true;
      startProgress();
    } else if (st === 2) {
      document.body.classList.remove('playing');
      if ($('playBtn')) $('playBtn').textContent = '▶';
      stopProgress();
    } else if (st === 0) {
      document.body.classList.remove('playing');
      if ($('playBtn')) $('playBtn').textContent = '▶';
      stopProgress();
      var ni = pickNext(true);
      if (ni >= 0) goToSong(ni); else setBar(1);
    }
  }

  function onYTError(e) {
    if ($('tapPrompt')) $('tapPrompt').hidden = true;
    var msgs = {
      2: 'YouTube 影片 ID 無效。', 5: '這個影片無法在網頁中播放。',
      100: '影片不存在或已設為私人。', 101: '影片擁有者不允許嵌入播放。', 150: '影片擁有者不允許嵌入播放。'
    };
    toast(msgs[e.data] || '影片載入失敗。');
    if (playlist && currentIndex < playlist.songs.length - 1) {
      setTimeout(function () { goToSong(pickNext(false)); }, 1500);
    }
  }

  function goToSong(i) {
    if (isPlayHidden() || i < 0 || i >= playlist.songs.length) return;
    currentIndex = i;
    var s = playlist.songs[i];
    renderPlayMeta();
    renderDrawer();
    setBar(0);
    if ($('cur')) $('cur').textContent = '0:00';
    if ($('dur')) $('dur').textContent = '0:00';
    lastSec = -1;
    var vid = parseVideoId(s.videoId);
    
    if (player && player.loadVideoById) {
      try {
        player.loadVideoById(vid);
      } catch (err) {
        destroyPlayer();
        initYTPlayer();
      }
    } else {
      initYTPlayer();
    }
  }

  function startProgress() {
    stopProgress();
    lastSec = -1;
    var fillEl = $('fill'), curEl = $('cur'), durEl = $('dur');
    progressTimer = setInterval(function () {
      if (seeking) return;
      if (!player || !player.getDuration) return;
      var d = player.getDuration();
      var c = player.getCurrentTime();
      if (!d) return;
      
      setBar(c / d);
      
      var sec = Math.floor(c);
      if (sec !== lastSec) {
        lastSec = sec;
        curEl.textContent = fmtTime(c);
        durEl.textContent = fmtTime(d);
      }
    }, 250);
  }

  function stopProgress() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function renderDrawer() {
    if ($('drawerTitle')) $('drawerTitle').textContent = playlist.name || '歌單';
    var list = $('drawerList');
    if (!list) return;
    list.innerHTML = '';
    playlist.songs.forEach(function (s, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'drawer-item' + (i === currentIndex ? ' active' : '');
      var url = thumbOf(s);
      btn.innerHTML =
        '<span class="di-cover"></span>' +
        '<span class="di-info"><span class="di-title">' + esc(s.title || '未命名') + '</span>' +
        '<span class="di-artist">' + esc(s.artist || s.anime || '') + '</span></span>';
      if (url) btn.querySelector('.di-cover').style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
      btn.addEventListener('click', function () {
        goToSong(i);
        if ($('playlistDrawer')) $('playlistDrawer').hidden = true;
      });
      list.appendChild(btn);
    });
  }

  function showError(msg) {
    if ($('errorMsg')) $('errorMsg').textContent = msg;
    show('viewError');
  }

  /* ============ 手勢與控制 ============ */
  function bindSwipeGestures() {
    var vinylPlinth = $('vinylPlinth');
    var vinyl = document.querySelector('.vinyl-swing');
    if (swipeBound || !vinylPlinth || !vinyl) return;
    swipeBound = true;

    var startX = 0, startY = 0, isSwiping = false;

    vinylPlinth.addEventListener('touchstart', function (e) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isSwiping = false;
      vinyl.style.transition = 'none';
    }, { passive: true });

    vinylPlinth.addEventListener('touchmove', function (e) {
      if (!startX || !startY) return;
      var diffX = e.touches[0].clientX - startX;
      var diffY = e.touches[0].clientY - startY;

      if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 20) {
        isSwiping = true;
        var move = diffX > 0 ? Math.min(diffX * 0.4, 30) : Math.max(diffX * 0.4, -30);
        vinyl.style.transform = 'translateX(' + move + 'px) rotate(' + (move * 0.5) + 'deg) translateZ(0)';
      }
    }, { passive: true });

    vinylPlinth.addEventListener('touchend', function (e) {
      if (!startX || !startY) return;
      var diffX = e.changedTouches[0].clientX - startX;
      var diffY = e.changedTouches[0].clientY - startY;

      vinyl.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
      vinyl.style.transform = 'translateX(0) rotate(0) translateZ(0)';

      if (isSwiping && Math.abs(diffX) > 50 && Math.abs(diffY) < 80) {
        if (diffX > 0) {
          goToSong(pickPrev());
        } else if (diffX < 0) {
          goToSong(pickNext(false));
        }
      }
      startX = 0; startY = 0; isSwiping = false;
    }, { passive: true });
  }

  function bindPlayControls() {
    var playBtn = $('playBtn');
    if (playBtn) playBtn.addEventListener('click', function () {
      if (!player || !player.playVideo) return;
      var st = player.getPlayerState();
      if (st === 1) player.pauseVideo();
      else player.playVideo();
    });

    if ($('prevArrow')) $('prevArrow').addEventListener('click', function () { goToSong(pickPrev()); });
    if ($('nextArrow')) $('nextArrow').addEventListener('click', function () { goToSong(pickNext(false)); });
    bindMediaKeys();
    if ($('vinylPlinth')) $('vinylPlinth').addEventListener('click', function () { if ($('playBtn')) $('playBtn').click(); });

    if ($('prevBtn')) $('prevBtn').addEventListener('click', function () { goToSong(pickPrev()); });
    if ($('nextBtn')) $('nextBtn').addEventListener('click', function () { goToSong(pickNext(false)); });

    if ($('tapPrompt')) $('tapPrompt').addEventListener('click', function () {
      $('tapPrompt').hidden = true;
      if (isPlayHidden()) return;
      if (player && player.playVideo) player.playVideo();
    });

    if ($('listToggle')) $('listToggle').addEventListener('click', function () {
      if ($('playlistDrawer')) $('playlistDrawer').hidden = !$('playlistDrawer').hidden;
    });

    if ($('drawerClose')) $('drawerClose').addEventListener('click', function () { if ($('playlistDrawer')) $('playlistDrawer').hidden = true; });
    if ($('playlistDrawer')) $('playlistDrawer').addEventListener('click', function (e) {
      if (e.target === $('playlistDrawer')) $('playlistDrawer').hidden = true;
    });
  }

  function setBar(r) {
    r = Math.min(1, Math.max(0, r || 0));
    var f = $('fill'), t = $('thumb');
    if (f) f.style.transform = 'scaleX(' + r + ')';
    if (t) t.style.left = 'calc(' + (r * 100) + '% - 6px)';
  }

  function bindSeek() {
    var seek = $('seek');
    if (!seek) return;
    var last = 0;
    function ratio(e) {
      var r = seek.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    }
    function dur() { return (player && player.getDuration) ? player.getDuration() : 0; }
    
    seek.addEventListener('pointerdown', function (e) {
      if (!dur()) return;
      seeking = true;
      seek.setPointerCapture(e.pointerId);
      seek.classList.add('dragging');
      last = ratio(e); setBar(last);
      $('cur').textContent = fmtTime(last * dur());
    });
    
    seek.addEventListener('pointermove', function (e) {
      if (!seeking) return;
      last = ratio(e); setBar(last);
      $('cur').textContent = fmtTime(last * dur());
    });
    
    function end(e) {
      if (!seeking) return;
      seeking = false;
      seek.classList.remove('dragging');
      if (e.type === 'pointerup') last = ratio(e);
      if (dur()) player.seekTo(last * dur(), true);
    }
    
    seek.addEventListener('pointerup', end);
    seek.addEventListener('pointercancel', end);
  }

  function buildEq() {
    var eq = $('eq');
    if (!eq) return;
    for (var i = 0; i < 28; i++) {
      var b = document.createElement('i');
      b.style.setProperty('--d', (0.45 + Math.random() * 0.7).toFixed(2) + 's');
      b.style.setProperty('--dl', (-Math.random()).toFixed(2) + 's');
      b.style.setProperty('--h', (0.35 + Math.random() * 0.65).toFixed(2));
      eq.appendChild(b);
    }
  }

  function bindZoomLock() {
    document.addEventListener('gesturestart', function (e) {
      if (document.body.classList.contains('play-mode')) e.preventDefault();
    });
    document.addEventListener('touchmove', function (e) {
      if (document.body.classList.contains('play-mode') && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
  }

  function bindFx() {
    var sel = '.btn,.btn-block,.icon-btn,.btn-save,.btn-google,.drawer-toggle,.drawer-close,.drawer-item,.playlist-card,.nav-arrow,.dropdown-item,.pill,.swatch,.seg button';
    document.addEventListener('pointerdown', function (e) {
      var el = e.target.closest && e.target.closest(sel);
      if (!el || el.disabled) return;
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (x) {} }
      var r = el.getBoundingClientRect();
      var size = Math.max(r.width, r.height) * 2;
      var d = document.createElement('span');
      d.className = 'ripple';
      d.style.cssText = 'width:' + size + 'px;height:' + size + 'px;left:' + (e.clientX - r.left - size / 2) + 'px;top:' + (e.clientY - r.top - size / 2) + 'px';
      el.appendChild(d);
      setTimeout(function () { d.remove(); }, 650);
    });
  }

  function bindFullscreen() {
    var btn = $('fsBtn'), de = document.documentElement;
    var req = de.requestFullscreen || de.webkitRequestFullscreen;
    var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
    if (!btn || !req || standalone) return;
    btn.hidden = false;
    btn.style.marginRight = '8px';
    btn.addEventListener('click', function () {
      var on = document.fullscreenElement || document.webkitFullscreenElement;
      var p = on ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
                 : req.call(de);
      if (p && p.catch) p.catch(function () { toast('此瀏覽器不支援全螢幕'); });
    });
    function sync() { btn.textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? '✕' : '⛶'; }
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
  }

  /* ============ 範本歌單 ============ */
  var TEMPLATES = [
    { name: '熱門動漫 OP 精選', songs: [
      { anime: '鬼滅之刃', title: '紅蓮華', artist: 'LiSA', videoId: '' },
      { anime: '咒術迴戰', title: '廻廻奇譚', artist: 'Eve', videoId: '' },
      { anime: '孤獨搖滾', title: '青春コンプレックス', artist: '結束バンド', videoId: '' },
      { anime: '葬送的芙莉蓮', title: '勇者', artist: 'YOASOBI', videoId: '' }
    ] },
    { name: '深夜放鬆 動漫歌', songs: [
      { anime: '你的名字', title: '前前前世', artist: 'RADWIMPS', videoId: '' },
      { anime: '天気の子', title: '愛にできることはまだあるかい', artist: 'RADWIMPS', videoId: '' },
      { anime: '輝夜姬想讓人告白', title: 'Love Dramatic', artist: '鈴木雅之', videoId: '' }
    ] }
  ];

  function renderTemplates() {
    var sec = $('templateSection'), list = $('templateList');
    if (!sec || !list) return;
    list.innerHTML = '';
    var shown = 0;
    TEMPLATES.forEach(function (t) {
      var songs = t.songs.filter(function (x) { return parseVideoId(x.videoId); });
      if (!songs.length) return;
      shown++;
      var row = document.createElement('div');
      row.className = 'playlist-card';
      row.innerHTML = '<a class="pc-left"><span class="hist-cover"></span><span class="pc-info"><span class="pc-title">' + esc(t.name) +
        '</span><span class="pc-meta">' + songs.length + ' 首 · 點擊試聽</span></span></a>' +
        (currentUser ? '<button type="button" class="icon-btn" aria-label="複製到我的歌單" title="複製到我的歌單">＋</button>' : '');
      row.querySelector('a').setAttribute('href', '#play/' + encodePlaylist({ name: t.name, songs: songs }));
      var u = thumbOf(songs[0]);
      if (u) row.querySelector('.hist-cover').style.backgroundImage = 'url("' + u.replace(/"/g, '%22') + '")';
      var btn = row.querySelector('button');
      if (btn) btn.addEventListener('click', function () {
        var pl = createEmptyPlaylist(t.name);
        pl.songs = songs.map(function (x) { return { anime: x.anime || '', title: x.title || '', artist: x.artist || '', videoId: x.videoId, cover: x.cover || '' }; });
        state.playlists.push(pl);
        saveDraft(); saveDraftToCloud(true);
        toast('已複製到我的歌單');
        location.hash = '#edit/' + pl.id;
      });
      list.appendChild(row);
    });
    sec.hidden = !shown;
  }

  /* ============ 播放模式 / 睡眠定時 / 外觀 ============ */
  var MODES = [['off', '➡️ 順序'], ['all', '🔁 循環'], ['one', '🔂 單曲'], ['shuffle', '🔀 隨機']];
  var playMode = 'off';
  var SLEEP_OPTS = [0, 15, 30, 60], sleepIdx = 0, sleepAt = 0, sleepTick = null;
  var ACCENTS = [['青', '#00e5ff'], ['櫻', '#ff6fb5'], ['紫', '#a78bfa'], ['琥珀', '#ffb020'], ['薄荷', '#34d399'], ['紅蓮', '#ff4757']];
  var VINYLS = [['經典黑', '#16161a'], ['血紅', '#7a1220'], ['冰藍', '#1c5f8a'], ['粉紅', '#a8326f'], ['金', '#8a6a1c'], ['紫', '#4b2a8a']];
  var LABELS = [['cover', '封面圖'], ['solid', '純色'], ['gradient', '漸層']];
  var THEME_DEFAULT = { accent: '#00e5ff', vinyl: '#16161a', groove: 16, label: 'cover' };
  var theme = Object.assign({}, THEME_DEFAULT);

  function pickNext(auto) {
    var n = playlist.songs.length;
    if (auto && playMode === 'one') return currentIndex;
    if (playMode === 'shuffle' && n > 1) {
      var i;
      do { i = Math.floor(Math.random() * n); } while (i === currentIndex);
      return i;
    }
    if (currentIndex < n - 1) return currentIndex + 1;
    return playMode === 'off' ? -1 : 0;
  }

  function pickPrev() {
    if (currentIndex > 0) return currentIndex - 1;
    return playMode === 'off' ? -1 : playlist.songs.length - 1;
  }

  function setSleep(min) {
    clearInterval(sleepTick);
    sleepAt = min ? Date.now() + min * 60000 : 0;
    var b = $('sleepBtn');
    if (!min) {
      if (b) { b.textContent = '😴 定時'; b.classList.remove('on'); }
      sleepIdx = 0;
      return;
    }
    if (b) b.classList.add('on');
    tickSleep();
    sleepTick = setInterval(tickSleep, 1000);
  }

  function tickSleep() {
    if (!sleepAt) return;
    var left = sleepAt - Date.now();
    var b = $('sleepBtn');
    if (left <= 0) {
      if (player && player.pauseVideo) { player.pauseVideo(); if (player.setVolume) player.setVolume(100); }
      setSleep(0);
      toast('睡眠定時已到，晚安 🌙');
      return;
    }
    if (left < 10000 && player && player.setVolume) player.setVolume(Math.max(5, Math.round(left / 100)));
    if (b) b.textContent = '😴 ' + Math.ceil(left / 60000) + ' 分';
  }

  function hexRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function applyTheme() {
    var th = currentUser ? theme : THEME_DEFAULT;
    var c = hexRgb(th.accent).join(','), st = document.documentElement.style;
    st.setProperty('--accent', th.accent);
    st.setProperty('--accent-rgb', c);
    st.setProperty('--accent-dim', 'rgba(' + c + ',.2)');
    st.setProperty('--vinyl-a', th.vinyl);
    st.setProperty('--groove', (th.groove / 100).toFixed(2));
    document.body.setAttribute('data-label', th.label);
  }

  function saveTheme() {
    try { localStorage.setItem('anime-vinyl:theme', JSON.stringify(theme)); } catch (e) {}
  }

  function bindExtras() {
    try {
      var m = localStorage.getItem('anime-vinyl:mode');
      if (MODES.some(function (x) { return x[0] === m; })) playMode = m;
      var t = JSON.parse(localStorage.getItem('anime-vinyl:theme'));
      if (t) {
        var hex = /^#[0-9a-f]{6}$/i;
        if (hex.test(t.accent)) theme.accent = t.accent;
        if (hex.test(t.vinyl)) theme.vinyl = t.vinyl;
        if (t.groove >= 0 && t.groove <= 50) theme.groove = +t.groove;
        if (LABELS.some(function (x) { return x[0] === t.label; })) theme.label = t.label;
      }
    } catch (e) {}
    applyTheme();

    var modeBtn = $('modeBtn');
    function showMode() {
      var cur = MODES.filter(function (x) { return x[0] === playMode; })[0];
      modeBtn.textContent = cur[1];
      modeBtn.classList.toggle('on', playMode !== 'off');
    }
    showMode();
    modeBtn.addEventListener('click', function () {
      var i = MODES.findIndex(function (x) { return x[0] === playMode; });
      playMode = MODES[(i + 1) % MODES.length][0];
      try { localStorage.setItem('anime-vinyl:mode', playMode); } catch (e) {}
      showMode();
      if (playlist) renderPlayMeta();
    });

    $('sleepBtn').addEventListener('click', function () {
      sleepIdx = (sleepIdx + 1) % SLEEP_OPTS.length;
      var min = SLEEP_OPTS[sleepIdx];
      setSleep(min);
      sleepIdx = SLEEP_OPTS.indexOf(min);
      if (min) toast('將在 ' + min + ' 分鐘後停止播放'); else toast('已取消睡眠定時');
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tickSleep(); });

    var accentBox = $('accentSwatches'), vinylBox = $('vinylSwatches'), seg = $('labelSeg');
    var accentPick = $('accentPicker'), vinylPick = $('vinylPicker'), grooveRange = $('grooveRange');

    function refreshUI() {
      Array.prototype.forEach.call(accentBox.children, function (b) { b.classList.toggle('active', b.dataset.c === theme.accent); });
      Array.prototype.forEach.call(vinylBox.children, function (b) { b.classList.toggle('active', b.dataset.c === theme.vinyl); });
      Array.prototype.forEach.call(seg.children, function (b) { b.classList.toggle('active', b.dataset.k === theme.label); });
      if (accentPick.value !== theme.accent) accentPick.value = theme.accent;
      if (vinylPick.value !== theme.vinyl) vinylPick.value = theme.vinyl;
      grooveRange.value = theme.groove;
    }
    function change() { applyTheme(); saveTheme(); refreshUI(); }

    function addSwatches(box, items, key) {
      box.innerHTML = '';
      items.forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.dataset.c = it[1];
        b.setAttribute('aria-label', it[0]);
        b.style.background = it[1];
        b.addEventListener('click', function () { theme[key] = it[1]; change(); });
        box.appendChild(b);
      });
    }
    addSwatches(accentBox, ACCENTS, 'accent');
    addSwatches(vinylBox, VINYLS, 'vinyl');
    seg.innerHTML = '';
    LABELS.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = it[1];
      b.dataset.k = it[0];
      b.addEventListener('click', function () { theme.label = it[0]; change(); });
      seg.appendChild(b);
    });
    accentPick.addEventListener('input', function () { theme.accent = accentPick.value; change(); });
    vinylPick.addEventListener('input', function () { theme.vinyl = vinylPick.value; change(); });
    grooveRange.addEventListener('input', function () { theme.groove = +grooveRange.value; change(); });
    $('themeReset').addEventListener('click', function () { theme = Object.assign({}, THEME_DEFAULT); change(); });
    refreshUI();

    var modal = $('themeModal');
    
    function openThemeModal() {
      refreshUI();
      if (modal) {
        modal.hidden = false;
        requestAnimationFrame(() => modal.classList.add('show'));
      }
    }

    function closeThemeModal() {
      if (modal) {
        modal.classList.remove('show');
        setTimeout(() => { modal.hidden = true; }, 300);
      }
    }

    $('themeBtn').addEventListener('click', openThemeModal);
    $('themeDone').addEventListener('click', closeThemeModal);
    modal.addEventListener('click', function (e) { 
      if (e.target === modal) closeThemeModal(); 
    });
  }

  function bindEditorControls() {
    if ($('playlistNick')) $('playlistNick').addEventListener('input', function (e) {
      var pl = getCurrentPlaylist();
      if (pl) { pl.nick = e.target.value.slice(0, 20); markDirty(); }
    });
    if ($('createPlaylistBtn')) $('createPlaylistBtn').addEventListener('click', function () {
      if (!currentUser) return;
      var newPl = createEmptyPlaylist('新歌單 ' + (state.playlists.length + 1));
      state.playlists.push(newPl);
      saveDraft();
      saveDraftToCloud(true);
      location.hash = '#edit/' + newPl.id;
    });

    if ($('playlistName')) $('playlistName').addEventListener('input', function (e) {
      var pl = getCurrentPlaylist();
      if (pl) {
        pl.name = e.target.value;
        markDirty();
      }
    });

    if ($('playlistIsPublic')) $('playlistIsPublic').addEventListener('change', function (e) {
      var pl = getCurrentPlaylist();
      if (pl) {
        pl.isPublic = e.target.checked;
        syncPublicUI(pl);
        markDirty();
      }
    });

    if ($('saveBtn')) $('saveBtn').addEventListener('click', function () {
      if (!currentUser) {
        toast('請先登入才能儲存至雲端');
        return;
      }
      var pl = getCurrentPlaylist();
      if (pl) pl.updatedAt = new Date().toISOString();
      saveDraft();
      clearTimeout(autoSaveTimer);
      saveDraftToCloud(false);
      if ($('saveStatus')) $('saveStatus').textContent = '已儲存';
      isDirty = false;
    });

    if ($('addSongBtn')) $('addSongBtn').addEventListener('click', function () {
      var pl = getCurrentPlaylist();
      if (!pl) return;
      pl.songs.push({ anime: '', title: '', artist: '', videoId: '', cover: '' });
      markDirty();
      renderEditor();
      var cards = $('songEditorList').querySelectorAll('.song-card');
      if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    if ($('previewBtn')) $('previewBtn').addEventListener('click', function () {
      var pl = getCurrentPlaylist();
      if (!pl) return;
      var valid = pl.songs.filter(function (s) { return parseVideoId(s.videoId); });
      if (!valid.length) { toast('請先新增至少一首有 YouTube 影片 ID 的歌曲'); return; }
      previewFromId = currentPlaylistId;
      location.hash = 'preview/' + encodePlaylist(pl);
    });

    if ($('shareBtn')) $('shareBtn').addEventListener('click', async function () {
      var pl = getCurrentPlaylist();
      if (!pl) return;
      var valid = pl.songs.filter(function (s) { return parseVideoId(s.videoId); });
      if (!valid.length) { toast('請先新增至少一首有 YouTube 影片 ID 的歌曲'); return; }
      var base = location.origin + location.pathname + location.search;
      var url, tip;
      if (currentUser && dbAPI && cloudReady) {
        try {
          if (!pl.shareId) pl.shareId = newShareId();
          if (pl.linked !== true) { pl.linked = true; markDirty(); }
          await publishShared(pl);
          saveDraftToCloud(true);
          url = base + '#s/' + pl.shareId;
          tip = '這是短網址：之後修改並儲存歌單，連結內容會自動更新，NFC 標籤不用重寫。';
        } catch (e) {
          toast('短網址建立失敗：' + (e.code || e.message), 5000);
          return;
        }
      } else {
        url = base + '#play/' + encodePlaylist(pl);
        tip = '（雲端尚未連線，已產生完整長連結，內容不會隨編輯更新。）';
      }
      if ($('shareUrl')) $('shareUrl').value = url;
      if ($('shareBox')) $('shareBox').hidden = false;
      if ($('shareInfo')) $('shareInfo').textContent = '連結長度：' + url.length + ' 字元。' + tip;
      if ($('shareBox')) $('shareBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    if ($('copyBtn')) $('copyBtn').addEventListener('click', function () {
      var url = $('shareUrl').value;
      if (!url) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { toast('已複製連結'); })
        .catch(function () {
          $('shareUrl').select();
          document.execCommand('copy');
          toast('已複製連結');
        });
      } else {
        $('shareUrl').select();
        document.execCommand('copy');
        toast('已複製連結');
      }
    });
  }

  /* ============ 刪除功能與動畫 ============ */
  var deleteTargetId = null;
  var deleteSource = null;

  function openDeleteModal(id, source) {
    deleteTargetId = id;
    deleteSource = source;
    var modal = $('deleteModal');
    if (modal) {
      modal.hidden = false;
      requestAnimationFrame(() => modal.classList.add('show'));
    }
  }

  function closeDeleteModal() {
    var modal = $('deleteModal');
    if (modal) {
      modal.classList.remove('show');
      setTimeout(() => { modal.hidden = true; }, 300);
    }
    deleteTargetId = null;
    deleteSource = null;
  }

  function executeDelete() {
    if (!deleteTargetId) return;
    
    var targetId = deleteTargetId;
    var source = deleteSource;
    closeDeleteModal();

    var overlay = $('eatOverlay');
    var monster = $('monster');
    var targetEl = source === 'edit' ? $('editWrap') : $('playWrap');

    if (overlay && targetEl && monster) {
      overlay.hidden = false;
      requestAnimationFrame(() => overlay.classList.add('show'));

      setTimeout(() => {
        monster.classList.add('open-mouth');
      }, 300);

      setTimeout(() => {
        targetEl.classList.add('being-eaten');
        stopPlayback();
      }, 600);

      setTimeout(() => {
        monster.classList.remove('open-mouth');
        
        var idx = state.playlists.findIndex(p => p.id === targetId);
        if (idx !== -1) {
          removeShared(state.playlists[idx]);
          state.playlists.splice(idx, 1);
          saveDraft();
          if (currentUser) saveDraftToCloud(true);
        }

        setTimeout(() => {
          overlay.classList.remove('show');
          setTimeout(() => { 
            overlay.hidden = true; 
            if (targetEl) targetEl.classList.remove('being-eaten');
          }, 300);
          
          location.hash = '#home';
        }, 800);

      }, 1400);
    } else {
      var idx = state.playlists.findIndex(p => p.id === targetId);
      if (idx !== -1) {
        removeShared(state.playlists[idx]);
          state.playlists.splice(idx, 1);
        saveDraft();
        if (currentUser) saveDraftToCloud(true);
      }
      location.hash = '#home';
    }
  }

  function bindDeleteControls() {
    if ($('deleteEditBtn')) {
      $('deleteEditBtn').addEventListener('click', function() {
        if (currentPlaylistId) openDeleteModal(currentPlaylistId, 'edit');
      });
    }

    if ($('deletePlayBtn')) {
      $('deletePlayBtn').addEventListener('click', function() {
        if (currentUser && state.playlists.length > 0) {
          var matchedPl = state.playlists.find(p => p.id === previewFromId);
          if (matchedPl) {
            openDeleteModal(matchedPl.id, 'play');
          } else {
            toast('找不到此歌單，可能不是你的歌單');
          }
        }
      });
    }

    if ($('cancelDeleteBtn')) $('cancelDeleteBtn').addEventListener('click', closeDeleteModal);
    if ($('confirmDeleteBtn')) $('confirmDeleteBtn').addEventListener('click', executeDelete);
  }

  /* ============ 登入與 UI 切換 ============ */
  function triggerLogin() {
    if (!window.firebaseAuth) {
      toast('登入模組載入中，請稍候再試...');
      return;
    }
    var ua = navigator.userAgent || navigator.vendor || window.opera;
    if (ua.indexOf("FBAN") > -1 || ua.indexOf("FBAV") > -1 || ua.indexOf("Line") > -1 || ua.indexOf("Instagram") > -1) {
      toast('請點擊右上角選單，選擇「使用外部瀏覽器」開啟本頁面進行登入。', 5000);
      return;
    }
    var authAPI = window.firebaseAuth;
    authAPI.signInWithPopup(authAPI.auth, authAPI.provider).catch(function(error) {
      if (error.code === 'auth/popup-blocked') {
        authAPI.signInWithRedirect(authAPI.auth, authAPI.provider);
      } else if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
        toast('登入失敗：' + error.message);
      }
    });
  }

  function triggerLogout() {
    if (!window.firebaseAuth) return;
    clearTimeout(autoSaveTimer);
    var pending = (isDirty && currentUser) ? saveDraftToCloud(true) : Promise.resolve();
    pending.then(function () { window.firebaseAuth.signOut(window.firebaseAuth.auth); });
    toast('已登出');
    location.hash = '#home';
  }

  function updateAuthUI(user) {
    currentUser = user;
    ['sleepBtn', 'themeBtn'].forEach(function (id) { if ($(id)) $(id).hidden = !user; });
    if (!user) {
      setSleep(0);
      if ($('themeModal')) {
        $('themeModal').classList.remove('show');
        $('themeModal').hidden = true;
      }
    }
    applyTheme();
    
    var loginBtns = [$('loginBtnPlay'), $('guestLoginBtn')];
    var profiles = [$('userProfile'), $('userProfilePlay')];
    var dropdowns = [$('userDropdown'), $('userDropdownPlay')];
    var homeUserArea = $('homeUserArea');
    
    if (user) {
      loginBtns.forEach(btn => { if (btn) btn.hidden = true; });
      profiles.forEach(prof => { if (prof) prof.hidden = false; });
      if (homeUserArea) homeUserArea.hidden = false;
      
      var avatarUrl = user.photoURL || 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y';
      var nameStr = user.displayName || '使用者';
      
      if ($('userAvatar')) $('userAvatar').src = avatarUrl;
      if ($('userAvatarPlay')) $('userAvatarPlay').src = avatarUrl;
      
      if ($('userName')) $('userName').textContent = nameStr;
      if ($('userEmail')) $('userEmail').textContent = user.email || '';
      if ($('userNamePlay')) $('userNamePlay').textContent = nameStr;
      
      if ($('backLink')) $('backLink').hidden = false;
      
      LS_KEY = LS_BASE + ':' + user.uid;
      state = { playlists: [] };
      isDirty = false;
      loadDraft();
      playHistory = loadHistory();
      listenDraftFromCloud();
    } else {
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }

      loginBtns.forEach(btn => { if (btn) btn.hidden = false; });
      profiles.forEach(prof => { if (prof) prof.hidden = true; });
      dropdowns.forEach(dd => { if (dd) dd.hidden = true; });
      if (homeUserArea) homeUserArea.hidden = true;
      
      var hash = location.hash || '';
      if ((hash.startsWith('#play/') || hash.startsWith('#s/')) && $('backLink')) {
        $('backLink').hidden = true;
      }
      
      if (LS_KEY !== LS_BASE + ':guest') {
        try { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_KEY + ':history'); } catch (e) {}
      }
      LS_KEY = LS_BASE + ':guest';
      cloudReady = false;
      playHistory = loadHistory();
      isDirty = false;
      state = { playlists: [] };
      renderPlaylistGrid();
    }
  }

  function bindAuthControls() {
    if ($('guestLoginBtn')) $('guestLoginBtn').addEventListener('click', triggerLogin);
    if ($('loginBtnPlay')) $('loginBtnPlay').addEventListener('click', triggerLogin);

    var profiles = [$('userProfile'), $('userProfilePlay')];
    profiles.forEach(prof => {
      if (prof) {
        prof.addEventListener('click', function(e) {
          e.stopPropagation();
          var dd = prof.querySelector('.user-dropdown');
          if (dd) dd.hidden = !dd.hidden;
        });
      }
    });

    document.addEventListener('click', function() {
      document.querySelectorAll('.user-dropdown').forEach(dd => dd.hidden = true);
    });

    var logoutBtns = [$('logoutBtn'), ...document.querySelectorAll('.play-logout-btn')];
    logoutBtns.forEach(btn => {
      if (btn) btn.addEventListener('click', function(e) {
        e.stopPropagation();
        triggerLogout();
      });
    });

    if ($('deleteAccountBtn')) $('deleteAccountBtn').addEventListener('click', function(e) {
      e.stopPropagation();
      if ($('userDropdown')) $('userDropdown').hidden = true;
      if (!confirm('確定要刪除帳號嗎？這會永久刪除你的所有雲端歌單，且無法復原！')) return;
      
      if (currentUser && window.firebaseAuth && window.firebaseDB) {
        var authAPI = window.firebaseAuth;
        var dbAPI = window.firebaseDB;
        var uid = currentUser.uid;
        
        if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
        clearTimeout(autoSaveTimer);
        var docRef = dbAPI.doc(dbAPI.db, 'playlists', uid);
        authAPI.reauthenticateWithPopup(currentUser, authAPI.provider)
          .then(function () {
            return Promise.all(state.playlists.filter(function (p) { return p.shareId; }).map(function (p) {
              return Promise.all(['shared', 'explore_playlists'].map(function (col) {
                return dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, col, p.shareId)).catch(function () {});
              }));
            }));
          })
          .then(function () { return dbAPI.deleteDoc(docRef); })
          .then(function () { return authAPI.deleteUser(currentUser); })
          .then(function () {
            toast('帳號已刪除');
            try { localStorage.removeItem(LS_KEY); } catch (e) {}
            location.hash = '#home';
          })
          .catch(function (error) {
            listenDraftFromCloud();
            if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
              toast('刪除失敗：' + error.message);
            }
          });
      }
    });
  }

  function setupAuthListener() {
    if (!window.firebaseAuth) return;
    authAPI = window.firebaseAuth;
    dbAPI = window.firebaseDB;
    authAPI.onAuthStateChanged(authAPI.auth, function(user) {
      updateAuthUI(user);
      route();
    });
  }

  /* ============ 初始化 ============ */
  function init() {
    bindEditorControls();
    bindPlayControls();
    bindAuthControls();
    bindDeleteControls();
    bindNfcControls();
    bindExploreControls();
    bindSeek();
    buildEq();
    bindZoomLock();
    bindFx();
    bindFullscreen();
    bindExtras();
    
    loadDraft();
    
    playHistory = loadHistory();
    route();
    window.addEventListener('hashchange', route);

    if (window.firebaseAuth) {
      setupAuthListener();
    } else {
      window.addEventListener('firebaseReady', setupAuthListener);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

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
    if (song.cover && /^https?:\/\//i.test(song.cover)) return song.cover;
    var vid = parseVideoId(song.videoId);
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
    await dbAPI.setDoc(exploreRef, {
      id: pl.shareId,
      name: pl.name || '未命名歌單',
      ownerName: (pl.nick || '匿名動漫迷').slice(0, 20),
      ownerUid: currentUser.uid,
      songsCount: validSongs.length,
      coverUrl: thumbOf(validSongs[0]),
      songs: validSongs,
      updatedAt: new Date().toISOString()
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

    if (hash === '#explore') {
      showExploreView();
      return;
    }

    if (hash === '#nfc') {
      showNfcView();
      return;
    }

    if (hash.indexOf('#play/') === 0) {
      showPlayView(hash.slice(6), false);
      return;
    }
    if (hash.indexOf('#s/') === 0) {
      loadShared(hash.slice(3));
      return;
    }
    if (hash.indexOf('#preview/') === 0) {
      showPlayView(hash.slice(9), true);
      return;
    }
    
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
    destroyPlayer(); // 離開播放頁時直接銷毀播放器，停止所有背景音樂與初始化動作
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
      // 未登入時只抓取前 3 筆，已登入抓取前 30 筆
      var fetchLimit = currentUser ? 30 : 3;
      var q = dbAPI.query(dbAPI.collection(dbAPI.db, 'explore_playlists'), dbAPI.orderBy('updatedAt', 'desc'), dbAPI.limit(fetchLimit));
      var snap = await dbAPI.getDocs(q);
      var list = [];
      snap.forEach(function (d) { var x = d.data(); x._id = d.id; list.push(x); });

      if (!list.length) { msg('廣場目前還沒有公開歌單，快成為第一個發布的人吧！'); return; }

      // 重置包裹容器（如果之前有被包過）
      var parent = grid.parentNode;
      if (parent.classList.contains('explore-guest-wrapper')) {
        var oldOverlay = parent.querySelector('.explore-login-overlay');
        if (oldOverlay) oldOverlay.remove();
        parent.classList.remove('blurred');
      }

      grid.innerHTML = '';

      list.forEach(function (item) {
        if (!/^[a-z0-9]{6,12}$/.test(item._id)) return;
        var row = document.createElement('div');
        row.className = 'playlist-card';
        row.innerHTML = '<a class="pc-left"><span class="hist-cover"></span><span class="pc-info"><span class="pc-title"></span><span class="pc-meta"></span></span></a>' +
          '<div style="display:flex;gap:6px;flex-shrink:0;"></div>';
        row.querySelector('a').setAttribute('href', '#s/' + item._id);
        row.querySelector('.pc-title').textContent = item.name || '未命名歌單';
        row.querySelector('.pc-meta').textContent = '由 ' + (item.ownerName || '匿名動漫迷') + ' 分享 · ' + (item.songsCount || 0) + ' 首';
        
        if (/^https?:\/\//i.test(item.coverUrl || '')) {
          row.querySelector('.hist-cover').style.backgroundImage = 'url("' + item.coverUrl.replace(/"/g, '%22') + '")';
        }

        var box = row.lastChild;
        if (currentUser) {
          var add = document.createElement('button');
          add.type = 'button'; add.className = 'icon-btn'; add.textContent = '＋';
          add.title = '複製到我的歌單'; add.setAttribute('aria-label', '複製到我的歌單');
          add.addEventListener('click', function () { copyExplorePlaylistToMine(item); });
          box.appendChild(add);

          if (item.ownerUid === currentUser.uid) {
            var del = document.createElement('button');
            del.type = 'button'; del.className = 'icon-btn danger'; del.textContent = '🗑';
            del.title = '從廣場下架'; del.setAttribute('aria-label', '從探索廣場下架');
            del.addEventListener('click', function () { unpublishExplore(item, row); });
            box.appendChild(del);
          } else {
            var rep = document.createElement('button');
            rep.type = 'button'; rep.className = 'icon-btn'; rep.textContent = '🚩';
            rep.title = '檢舉'; rep.setAttribute('aria-label', '檢舉這份歌單');
            rep.addEventListener('click', function () { reportExplore(item); });
            box.appendChild(rep);
          }
        }
        grid.appendChild(row);
      });

      // 未登入時：外層加上漸層遮罩，並顯示登入提示按鈕
      if (!currentUser) {
        var wrapper = grid.parentNode;
        if (!wrapper.classList.contains('explore-guest-wrapper')) {
          wrapper = document.createElement('div');
          wrapper.className = 'explore-guest-wrapper';
          grid.parentNode.insertBefore(wrapper, grid);
          wrapper.appendChild(grid);
        }

        wrapper.classList.add('blurred');

        var overlay = document.createElement('div');
        overlay.className = 'explore-login-overlay';
        overlay.innerHTML = 
          '<p>🔒 想要探索更多動漫黑膠歌單嗎？<br>立即登入解鎖完整內容！</p>' +
          '<button class="btn-block primary" type="button">🔑 立即登入</button>';

        overlay.querySelector('button').addEventListener('click', function () {
          triggerLogin();
        });

        wrapper.appendChild(overlay);
      }

    } catch (e) {
      console.error('載入廣場失敗', e);
      msg('無法載入探索廣場，請稍後再試。', '#ff9e9e');
    }
  }

  function unpublishExplore(item, row) {
    if (!confirm('要把「' + (item.name || '這份歌單') + '」從探索廣場下架嗎？\n（你自己的歌單不會被刪除）')) return;
    var inUse = state.playlists.some(function (p) { return p.shareId === item._id && p.linked !== false; });
    var jobs = [dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'explore_playlists', item._id))];
    if (!inUse) jobs.push(dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'shared', item._id)).catch(function () {}));
    Promise.all(jobs).then(function () {
      state.playlists.forEach(function (p) { if (p.shareId === item._id) { p.isPublic = false; p.explored = false; } });
      saveDraft();
      saveDraftToCloud(true);
      if (row.parentNode) row.parentNode.removeChild(row);
      toast('已從探索廣場下架');
    }).catch(function (e) { toast('下架失敗：' + (e.code || e.message)); });
  }

  function reportExplore(item) {
    if (!currentUser) { toast('請先登入才能檢舉'); return; }
    var reason = prompt('請簡述檢舉原因（例如：侵權、不當內容、垃圾訊息）：');
    if (!reason || !reason.trim()) return;
    dbAPI.setDoc(dbAPI.doc(dbAPI.collection(dbAPI.db, 'reports')), {
      target: item._id,
      name: String(item.name || '').slice(0, 80),
      reason: reason.trim().slice(0, 200),
      reporter: currentUser.uid,
      at: Date.now()
    }).then(function () { toast('已送出檢舉，謝謝你的回報'); })
      .catch(function (e) { toast('檢舉失敗：' + (e.code || e.message)); });
  }

  function copyExplorePlaylistToMine(item) {
    if (!currentUser) {
      toast('請先登入才能複製歌單');
      return;
    }
    var newPl = createEmptyPlaylist(item.name ? item.name + ' (來自廣場)' : '複製的歌單');
    newPl.songs = (item.songs || []).map(function (x) {
      return {
        anime: x.anime || '',
        title: x.title || '',
        artist: x.artist || '',
        videoId: x.videoId || '',
        cover: x.cover || ''
      };
    });
    state.playlists.push(newPl);
    saveDraft();
    saveDraftToCloud(true);
    toast('🎉 已成功複製到你的歌單');
    location.hash = '#edit/' + newPl.id;
  }

  function bindExploreControls() {
    if ($('goToExploreBtn')) $('goToExploreBtn').addEventListener('click', function () { location.hash = '#explore'; });
    if ($('guestExploreBtn')) $('guestExploreBtn').addEventListener('click', function () { location.hash = '#explore'; });
  }

  /* ============ NFC 專屬視圖邏輯 ============ */
  function showNfcView() {
    if (!currentUser) {
      toast('請先登入才能使用 NFC 寫入工具');
      location.hash = '#home';
      return;
    }
    show('viewNfc');
    
    var isSupported = 'NDEFReader' in window;
    
    if (!isSupported) {
      if ($('nfcUnsupported')) $('nfcUnsupported').hidden = false;
      if ($('nfcSupported')) $('nfcSupported').hidden = true;
      return;
    }
    
    if ($('nfcUnsupported')) $('nfcUnsupported').hidden = true;
    if ($('nfcSupported')) $('nfcSupported').hidden = false;
    if ($('nfcStatusText')) $('nfcStatusText').textContent = '請選擇要寫入的歌單，並準備好 NFC 標籤';
    
    var select = $('nfcPlaylistSelect');
    if (!select) return;
    select.innerHTML = '';
    
    if (!state.playlists || state.playlists.length === 0) {
      select.innerHTML = '<option value="">目前沒有可用歌單</option>';
      if ($('executeNfcWriteBtn')) $('executeNfcWriteBtn').disabled = true;
      return;
    }
    
    if ($('executeNfcWriteBtn')) $('executeNfcWriteBtn').disabled = false;
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
    var selectId = selectEl.value;
    var pl = state.playlists.find(function (p) { return p.id === selectId; });
    if (!pl) {
      toast('請選擇有效的歌單');
      return;
    }
    
    var base = location.origin + location.pathname + location.search;
    var targetUrl = '';
    if (!currentUser || !dbAPI || !cloudReady) { toast('請先登入並等待雲端連線，才能寫入短網址'); return; }
    if (!pl.songs.some(function (x) { return parseVideoId(x.videoId); })) { toast('這份歌單還沒有有效的歌曲'); return; }
    try {
      if (!pl.shareId) pl.shareId = newShareId();
      if (pl.linked !== true) { pl.linked = true; pl.updatedAt = new Date().toISOString(); saveDraft(); }
      await publishShared(pl);
      saveDraftToCloud(true);
    } catch (e) {
      toast('短網址建立失敗：' + (e.code || e.message), 5000);
      return;
    }
    targetUrl = base + '#s/' + pl.shareId;

    try {
      var ndef = new NDEFReader();
      var statusText = $('nfcStatusText');
      
      if (statusText) statusText.textContent = '🔍 請將 NFC 標籤靠近手機感應處以檢查標籤...';
      toast('請將手機靠近 NFC 標籤');

      var hasExistingData = await new Promise(function (resolve) {
        var timeout = setTimeout(function () {
          resolve(false);
        }, 4000);

        try {
          ndef.scan().then(function() {
            ndef.onreading = function (event) {
              clearTimeout(timeout);
              var records = event.message.records;
              resolve(records && records.length > 0);
            };
          }).catch(function() {
            clearTimeout(timeout);
            resolve(false);
          });
        } catch (e) {
          clearTimeout(timeout);
          resolve(false);
        }
      });

      if (hasExistingData) {
        var confirmOverwrite = confirm('偵測到此 NFC 標籤內已有其他資料！\n是否要清除並覆蓋寫入目前的歌單？\n（按下「取消」將會退出）');
        if (!confirmOverwrite) {
          if (statusText) statusText.textContent = '已取消寫入操作';
          toast('已取消寫入');
          return;
        }
      }

      if (statusText) statusText.textContent = '📡 偵測到 NFC 標籤！請保持貼緊，正在寫入...';
      
      await ndef.write({
        records: [{ recordType: "url", data: targetUrl }]
      });

      if (statusText) statusText.textContent = '🎉 寫入成功！您可以將標籤移開了。';
      toast('NFC 標籤寫入成功！');

    } catch (error) {
      console.error('NFC 寫入失敗:', error);
      if ($('nfcStatusText')) $('nfcStatusText').textContent = '❌ 寫入失敗，請重試';
      
      if (error.name === 'NotAllowedError') {
        toast('權限被拒絕，請允許 NFC 權限');
      } else if (error.name === 'NotSupportedError' || (error.message && error.message.includes('full'))) {
        toast('寫入失敗：NFC 標籤容量不足，無法容納此歌單');
      } else {
        toast('寫入失敗：' + error.message);
      }
    }
  }

  function bindNfcControls() {
    if ($('goToNfcBtn')) {
      $('goToNfcBtn').addEventListener('click', function () {
        location.hash = '#nfc';
      });
    }

    if ($('executeNfcWriteBtn')) {
      $('executeNfcWriteBtn').addEventListener('click', function () {
        handleNfcWriteProcess();
      });
    }
  }

  /* ============ 編輯視圖 ============ */
  function showEditView(id) {
    if (!currentUser) {
      location.hash = '#home';
      return;
    }
    var pl = state.playlists.find(p => p.id === id);
    if (!pl) {
      toast('找不到該歌單，可能已被刪除');
      location.hash = '#home';
      return;
    }
    currentPlaylistId = id;
    isDirty = false;
    
    if ($('playlistName')) $('playlistName').value = pl.name;
    syncPublicUI(pl);
    if ($('saveStatus')) $('saveStatus').textContent = '';
    renderEditor();
    show('viewEdit');
  }

  function renderEditor() {
    var list = $('songEditorList');
    var pl = getCurrentPlaylist();
    if (!list || !pl) return;
    
    list.innerHTML = '';
    if (!pl.songs.length) {
      pl.songs.push({ anime: '', title: '', artist: '', videoId: '', cover: '' });
    }
    pl.songs.forEach(function (song, index) {
      list.appendChild(buildSongCard(song, index));
    });
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
          '<label class="field-sm"><span>動漫</span><input data-k="anime" value="' + esc(song.anime) + '" placeholder="進擊的巨人"></label>' +
          '<label class="field-sm"><span>歌名</span><input data-k="title" value="' + esc(song.title) + '" placeholder="紅蓮の弓矢"></label>' +
          '<label class="field-sm"><span>演唱者</span><input data-k="artist" value="' + esc(song.artist) + '" placeholder="Linked Horizon"></label>' +
          '<label class="field-sm full"><span>YouTube 連結 / 影片 ID</span><input data-k="videoId" value="' + esc(song.videoId) + '" placeholder="https://youtu.be/... 或 11 位影片 ID"></label>' +
          '<label class="field-sm full"><span>封面圖網址（選填）</span><input data-k="cover" value="' + esc(song.cover) + '" placeholder="留空自動使用 YouTube 縮圖"></label>' +
        '</div>' +
      '</div>';

    var coverEl = el.querySelector('[data-role="cover"]');
    var coverTimer = null;

    function updateCover() {
      var url = thumbOf(song);
      if (!url) {
        coverEl.style.backgroundImage = '';
        coverEl.textContent = '無圖';
        return;
      }
      var img = new Image();
      img.onload = function () {
        coverEl.style.backgroundImage = 'url("' + url + '")';
        coverEl.textContent = '';
      };
      img.onerror = function () {
        coverEl.style.backgroundImage = '';
        coverEl.textContent = '無圖';
      };
      img.src = url;
    }
    updateCover();

    el.querySelectorAll('input[data-k]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var k = inp.dataset.k;
        song[k] = inp.value;
        if (k === 'videoId' || k === 'cover') { clearTimeout(coverTimer); coverTimer = setTimeout(updateCover, 300); }
        markDirty();
      });
      inp.addEventListener('blur', function () {
        if (inp.dataset.k === 'videoId') {
          var id = parseVideoId(inp.value);
          if (id && id !== inp.value) {
            inp.value = id;
            song.videoId = id;
            markDirty();
          }
          updateCover();
        }
      });
    });

    el.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pl = getCurrentPlaylist();
        if (!pl) return;
        var act = btn.dataset.act;
        var i = pl.songs.indexOf(song);
        
        if (act === 'up' && i > 0) {
          var tmp = pl.songs[i - 1];
          pl.songs[i - 1] = pl.songs[i];
          pl.songs[i] = tmp;
        } else if (act === 'down' && i < pl.songs.length - 1) {
          var tmp2 = pl.songs[i + 1];
          pl.songs[i + 1] = pl.songs[i];
          pl.songs[i] = tmp2;
        } else if (act === 'del') {
          if (pl.songs.length <= 1) {
            toast('至少要保留一首歌');
            return;
          }
          pl.songs.splice(i, 1);
        }
        markDirty();
        renderEditor();
      });
    });

    return el;
  }

  /* ============ 播放視圖 ============ */
  var player = null;
  var playlist = null;
  var currentIndex = 0;
  var progressTimer = null;
  var tapTimer = null;
  var lastSec = -1;
  var currentPlayCode = null;
  var ytApiReady = false;

  function packPayload(pl) {
    var mini = {
      n: pl.name || '',
      s: (pl.songs || []).map(function (s) {
        var o = {};
        if (s.anime)  o.a = s.anime;
        if (s.title)  o.t = s.title;
        if (s.artist) o.r = s.artist;
        var vid = parseVideoId(s.videoId);
        if (vid) o.v = vid;
        if (s.cover)  o.c = s.cover;
        return o;
      })
    };
    return mini;
  }

  function unpackPayload(mini) {
    var out = { name: mini.n || '未命名歌單', songs: [] };
    (mini.s || []).forEach(function (o) {
      out.songs.push({
        anime:  o.a || '',
        title:  o.t || '',
        artist: o.r || '',
        videoId: o.v || '',
        cover:  o.c || ''
      });
    });
    return out;
  }

  function b64urlEncode(str) {
    var bin = '';
    new TextEncoder().encode(str).forEach(function (c) { bin += String.fromCharCode(c); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(u);
  }

  function encodePlaylist(pl) {
    var mini = packPayload(pl);
    var json = JSON.stringify(mini);
    if (window.LZString && LZString.compressToEncodedURIComponent) {
      var compressed = LZString.compressToEncodedURIComponent(json);
      return 'L' + compressed.replace(/\+/g, '.');
    }
    return 'B' + b64urlEncode(json);
  }

  function decodePlaylist(code) {
    if (!code) throw new Error('歌單資料是空的');
    var type = code.charAt(0);
    var body = code.slice(1);
    var json;

    if (type === 'L') {
      if (!window.LZString || !LZString.decompressFromEncodedURIComponent) {
        throw new Error('缺少解壓縮元件');
      }
      json = LZString.decompressFromEncodedURIComponent(body.replace(/\./g, '+'));
    } else if (type === 'B') {
      json = b64urlDecode(body);
    } else {
      throw new Error('未知的歌單格式');
    }

    if (!json) throw new Error('歌單資料毀損');
    return unpackPayload(JSON.parse(json));
  }

  function publishShared(pl) {
    var mini = packPayload(pl);
    return dbAPI.setDoc(dbAPI.doc(dbAPI.db, 'shared', pl.shareId), {
      owner: currentUser.uid, n: mini.n, s: mini.s, u: new Date().toISOString()
    });
  }

  function removeShared(pl) {
    if (pl && pl.shareId && currentUser && dbAPI) {
      dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'shared', pl.shareId)).catch(function (e) { console.error(e); });
      dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'explore_playlists', pl.shareId)).catch(function (e) { console.error(e); });
    }
  }

  function loadShared(id) {
    if (!/^[a-z0-9]{6,12}$/.test(id)) { showError('無效的分享連結'); return; }
    if (!dbAPI) return;
    dbAPI.getDoc(dbAPI.doc(dbAPI.db, 'shared', id)).then(function (snap) {
      if (location.hash !== '#s/' + id) return;
      if (!snap.exists()) { showError('此歌單已被下架或刪除。'); return; }
      var d = snap.data();
      showPlayView(encodePlaylist(unpackPayload({ n: d.n, s: d.s })), false, id);
    }).catch(function (e) { showError('無法讀取歌單：' + (e.code || e.message)); });
  }

  function showPlayView(code, isPreview, sid) {
    if (!isPreview) previewFromId = null;
    var same = !!player && code === currentPlayCode && !$('viewPlay').hidden;
    try {
      playlist = decodePlaylist(code);
      currentPlayCode = code;
    } catch (e) {
      showError('無法讀取歌單：' + e.message);
      return;
    }

    playlist.songs = (playlist.songs || []).filter(function (s) {
      return parseVideoId(s.videoId);
    });

    if (!playlist.songs.length) {
      showError('這個歌單裡沒有有效的歌曲。\n請回到編輯頁，至少加入一首有 YouTube 影片 ID 的歌。');
      return;
    }

    document.title = (playlist.name || 'Anime Vinyl') + ' — Anime Vinyl';
    if (!isPreview && !same) recordHistory(code, sid);
    
    if ($('backLink')) {
      $('backLink').hidden = !currentUser;
      var toEdit = isPreview && previewFromId;
      $('backLink').href = toEdit ? '#edit/' + previewFromId : '#home';
      $('backLink').textContent = toEdit ? '← 返回編輯' : '← 首頁';
    }
    
    if ($('deletePlayBtn')) {
      $('deletePlayBtn').style.display = (isPreview && currentUser && previewFromId) ? 'grid' : 'none';
    }

    if (!same) currentIndex = 0;
    show('viewPlay');
    renderPlayMeta();
    renderDrawer();
    if (!same) initYTPlayer();
    bindSwipeGestures();
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata || !playlist) return;
    var s = playlist.songs[currentIndex];
    var u = thumbOf(s);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title || '未命名歌曲', artist: s.artist || '', album: s.anime || '',
      artwork: u ? [{ src: u }] : []
    });
  }

  function bindMediaKeys() {
    if (!('mediaSession' in navigator)) return;
    var h = {
      play: function () { if (player && player.playVideo) player.playVideo(); },
      pause: function () { if (player && player.pauseVideo) player.pauseVideo(); },
      previoustrack: function () { goToSong(pickPrev()); },
      nexttrack: function () { goToSong(pickNext(false)); }
    };
    Object.keys(h).forEach(function (k) { try { navigator.mediaSession.setActionHandler(k, h[k]); } catch (e) {} });
  }

  function renderPlayMeta() {
    var s = playlist.songs[currentIndex];
    if ($('anime')) $('anime').textContent = s.anime || '';
    if ($('title')) $('title').textContent = s.title || '未命名歌曲';
    if ($('artist')) $('artist').textContent = s.artist || '';
    var url = thumbOf(s);
    if ($('label')) $('label').style.backgroundImage = url ? 'url("' + url + '")' : '';
    
    updateMediaSession();
    if ($('prevArrow')) $('prevArrow').classList.toggle('disabled', playMode === 'off' && currentIndex === 0);
    if ($('nextArrow')) $('nextArrow').classList.toggle('disabled', playMode === 'off' && currentIndex >= playlist.songs.length - 1);
    if ($('prevBtn')) $('prevBtn').disabled = playMode === 'off' && currentIndex === 0;
    if ($('nextBtn')) $('nextBtn').disabled = playMode === 'off' && currentIndex >= playlist.songs.length - 1;
  }

  function initYTPlayer() {
    if (isPlayHidden()) return; // 若已經不在播放頁面則不執行初始化
    var s = playlist.songs[currentIndex];
    if (!s) return;
    var vid = parseVideoId(s.videoId);

    if (player && player.loadVideoById) {
      try {
        player.loadVideoById(vid);
      } catch (e) {
        console.warn('Load video failed, recreating player', e);
        destroyPlayer();
        createYTPlayer(vid);
      }
      return;
    }

    if (!ytApiReady) {
      if (!window._ytLoading) {
        window._ytLoading = true;
        var tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
      window.onYouTubeIframeAPIReady = function () {
        window._ytLoading = false;
        ytApiReady = true;
        if (isPlayHidden()) return;
        createYTPlayer(parseVideoId(playlist.songs[currentIndex].videoId));
      };
      return;
    }

    createYTPlayer(vid);
  }

  function destroyPlayer() {
    if (player) {
      try { player.destroy(); } catch (e) {}
      player = null;
    }
  }

  function createYTPlayer(videoId) {
    var host = $('ytHost');
    if (!host) return;

    var vars = {
      autoplay: 0, controls: 0, disablekb: 1,
      modestbranding: 1, rel: 0, playsinline: 1, fs: 0
    };
    if (location.protocol.indexOf('http') === 0) vars.origin = location.origin;

    try {
      player = new YT.Player('ytHost', {
        videoId: videoId,
        playerVars: vars,
        events: {
          onReady: onYTReady,
          onStateChange: onYTStateChange,
          onError: onYTError
        }
      });
    } catch (e) {
      console.error('Failed to create YT Player', e);
      toast('播放器初始化失敗');
    }
  }

  function onYTReady() {
    if (isPlayHidden()) { 
      destroyPlayer();
      if ($('tapPrompt')) $('tapPrompt').hidden = true;
      return; 
    }
    if ($('dur')) $('dur').textContent = fmtTime(player.getDuration());
    try { player.playVideo(); } catch (e) {}

    clearTimeout(tapTimer);
    tapTimer = setTimeout(function () {
      if (!player || !player.getPlayerState || isPlayHidden()) {
        if ($('tapPrompt')) $('tapPrompt').hidden = true;
        return;
      }
      if (player.getPlayerState() !== 1) {
        if ($('tapPrompt')) $('tapPrompt').hidden = false;
      }
    }, 1500);
  }

  function onYTStateChange(e) {
    var st = e.data;
    if (isPlayHidden()) { 
      destroyPlayer();
      if ($('tapPrompt')) $('tapPrompt').hidden = true;
      return; 
    }
    if (st === 1) {
      document.body.classList.add('playing');
      if ($('playBtn')) $('playBtn').textContent = '❚❚';
      if ($('tapPrompt')) $('tapPrompt').hidden = true;
      startProgress();
    } else if (st === 2) {
      document.body.classList.remove('playing');
      if ($('playBtn')) $('playBtn').textContent = '▶';
      stopProgress();
    } else if (st === 0) {
      document.body.classList.remove('playing');
      if ($('playBtn')) $('playBtn').textContent = '▶';
      stopProgress();
      var ni = pickNext(true);
      if (ni >= 0) goToSong(ni); else setBar(1);
    }
  }

  function onYTError(e) {
    if ($('tapPrompt')) $('tapPrompt').hidden = true;
    var msgs = {
      2: 'YouTube 影片 ID 無效。', 5: '這個影片無法在網頁中播放。',
      100: '影片不存在或已設為私人。', 101: '影片擁有者不允許嵌入播放。', 150: '影片擁有者不允許嵌入播放。'
    };
    toast(msgs[e.data] || '影片載入失敗。');
    if (playlist && currentIndex < playlist.songs.length - 1) {
      setTimeout(function () { goToSong(pickNext(false)); }, 1500);
    }
  }

  function goToSong(i) {
    if (isPlayHidden() || i < 0 || i >= playlist.songs.length) return;
    currentIndex = i;
    var s = playlist.songs[i];
    renderPlayMeta();
    renderDrawer();
    setBar(0);
    if ($('cur')) $('cur').textContent = '0:00';
    if ($('dur')) $('dur').textContent = '0:00';
    lastSec = -1;
    var vid = parseVideoId(s.videoId);
    
    if (player && player.loadVideoById) {
      try {
        player.loadVideoById(vid);
      } catch (err) {
        destroyPlayer();
        initYTPlayer();
      }
    } else {
      initYTPlayer();
    }
  }

  function startProgress() {
    stopProgress();
    lastSec = -1;
    var fillEl = $('fill'), curEl = $('cur'), durEl = $('dur');
    progressTimer = setInterval(function () {
      if (seeking) return;
      if (!player || !player.getDuration) return;
      var d = player.getDuration();
      var c = player.getCurrentTime();
      if (!d) return;
      
      setBar(c / d);
      
      var sec = Math.floor(c);
      if (sec !== lastSec) {
        lastSec = sec;
        curEl.textContent = fmtTime(c);
        durEl.textContent = fmtTime(d);
      }
    }, 250);
  }

  function stopProgress() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function renderDrawer() {
    if ($('drawerTitle')) $('drawerTitle').textContent = playlist.name || '歌單';
    var list = $('drawerList');
    if (!list) return;
    list.innerHTML = '';
    playlist.songs.forEach(function (s, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'drawer-item' + (i === currentIndex ? ' active' : '');
      var url = thumbOf(s);
      btn.innerHTML =
        '<span class="di-cover"></span>' +
        '<span class="di-info"><span class="di-title">' + esc(s.title || '未命名') + '</span>' +
        '<span class="di-artist">' + esc(s.artist || s.anime || '') + '</span></span>';
      if (url) btn.querySelector('.di-cover').style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
      btn.addEventListener('click', function () {
        goToSong(i);
        if ($('playlistDrawer')) $('playlistDrawer').hidden = true;
      });
      list.appendChild(btn);
    });
  }

  function showError(msg) {
    if ($('errorMsg')) $('errorMsg').textContent = msg;
    show('viewError');
  }

  /* ============ 手勢與控制 ============ */
  function bindSwipeGestures() {
    var vinylPlinth = $('vinylPlinth');
    var vinyl = document.querySelector('.vinyl-swing');
    if (swipeBound || !vinylPlinth || !vinyl) return;
    swipeBound = true;

    var startX = 0, startY = 0, isSwiping = false;

    vinylPlinth.addEventListener('touchstart', function (e) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isSwiping = false;
      vinyl.style.transition = 'none';
    }, { passive: true });

    vinylPlinth.addEventListener('touchmove', function (e) {
      if (!startX || !startY) return;
      var diffX = e.touches[0].clientX - startX;
      var diffY = e.touches[0].clientY - startY;

      if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 20) {
        isSwiping = true;
        var move = diffX > 0 ? Math.min(diffX * 0.4, 30) : Math.max(diffX * 0.4, -30);
        vinyl.style.transform = 'translateX(' + move + 'px) rotate(' + (move * 0.5) + 'deg) translateZ(0)';
      }
    }, { passive: true });

    vinylPlinth.addEventListener('touchend', function (e) {
      if (!startX || !startY) return;
      var diffX = e.changedTouches[0].clientX - startX;
      var diffY = e.changedTouches[0].clientY - startY;

      vinyl.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
      vinyl.style.transform = 'translateX(0) rotate(0) translateZ(0)';

      if (isSwiping && Math.abs(diffX) > 50 && Math.abs(diffY) < 80) {
        if (diffX > 0) {
          goToSong(pickPrev());
        } else if (diffX < 0) {
          goToSong(pickNext(false));
        }
      }
      startX = 0; startY = 0; isSwiping = false;
    }, { passive: true });
  }

  function bindPlayControls() {
    var playBtn = $('playBtn');
    if (playBtn) playBtn.addEventListener('click', function () {
      if (!player || !player.playVideo) return;
      var st = player.getPlayerState();
      if (st === 1) player.pauseVideo();
      else player.playVideo();
    });

    if ($('prevArrow')) $('prevArrow').addEventListener('click', function () { goToSong(pickPrev()); });
    if ($('nextArrow')) $('nextArrow').addEventListener('click', function () { goToSong(pickNext(false)); });
    bindMediaKeys();
    if ($('vinylPlinth')) $('vinylPlinth').addEventListener('click', function () { if ($('playBtn')) $('playBtn').click(); });

    if ($('prevBtn')) $('prevBtn').addEventListener('click', function () { goToSong(pickPrev()); });
    if ($('nextBtn')) $('nextBtn').addEventListener('click', function () { goToSong(pickNext(false)); });

    if ($('tapPrompt')) $('tapPrompt').addEventListener('click', function () {
      $('tapPrompt').hidden = true;
      if (isPlayHidden()) return;
      if (player && player.playVideo) player.playVideo();
    });

    if ($('listToggle')) $('listToggle').addEventListener('click', function () {
      if ($('playlistDrawer')) $('playlistDrawer').hidden = !$('playlistDrawer').hidden;
    });

    if ($('drawerClose')) $('drawerClose').addEventListener('click', function () { if ($('playlistDrawer')) $('playlistDrawer').hidden = true; });
    if ($('playlistDrawer')) $('playlistDrawer').addEventListener('click', function (e) {
      if (e.target === $('playlistDrawer')) $('playlistDrawer').hidden = true;
    });
  }

  function setBar(r) {
    r = Math.min(1, Math.max(0, r || 0));
    var f = $('fill'), t = $('thumb');
    if (f) f.style.transform = 'scaleX(' + r + ')';
    if (t) t.style.left = 'calc(' + (r * 100) + '% - 6px)';
  }

  function bindSeek() {
    var seek = $('seek');
    if (!seek) return;
    var last = 0;
    function ratio(e) {
      var r = seek.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    }
    function dur() { return (player && player.getDuration) ? player.getDuration() : 0; }
    
    seek.addEventListener('pointerdown', function (e) {
      if (!dur()) return;
      seeking = true;
      seek.setPointerCapture(e.pointerId);
      seek.classList.add('dragging');
      last = ratio(e); setBar(last);
      $('cur').textContent = fmtTime(last * dur());
    });
    
    seek.addEventListener('pointermove', function (e) {
      if (!seeking) return;
      last = ratio(e); setBar(last);
      $('cur').textContent = fmtTime(last * dur());
    });
    
    function end(e) {
      if (!seeking) return;
      seeking = false;
      seek.classList.remove('dragging');
      if (e.type === 'pointerup') last = ratio(e);
      if (dur()) player.seekTo(last * dur(), true);
    }
    
    seek.addEventListener('pointerup', end);
    seek.addEventListener('pointercancel', end);
  }

  function buildEq() {
    var eq = $('eq');
    if (!eq) return;
    for (var i = 0; i < 28; i++) {
      var b = document.createElement('i');
      b.style.setProperty('--d', (0.45 + Math.random() * 0.7).toFixed(2) + 's');
      b.style.setProperty('--dl', (-Math.random()).toFixed(2) + 's');
      b.style.setProperty('--h', (0.35 + Math.random() * 0.65).toFixed(2));
      eq.appendChild(b);
    }
  }

  function bindZoomLock() {
    document.addEventListener('gesturestart', function (e) {
      if (document.body.classList.contains('play-mode')) e.preventDefault();
    });
    document.addEventListener('touchmove', function (e) {
      if (document.body.classList.contains('play-mode') && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
  }

  function bindFx() {
    var sel = '.btn,.btn-block,.icon-btn,.btn-save,.btn-google,.drawer-toggle,.drawer-close,.drawer-item,.playlist-card,.nav-arrow,.dropdown-item,.pill,.swatch,.seg button';
    document.addEventListener('pointerdown', function (e) {
      var el = e.target.closest && e.target.closest(sel);
      if (!el || el.disabled) return;
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (x) {} }
      var r = el.getBoundingClientRect();
      var size = Math.max(r.width, r.height) * 2;
      var d = document.createElement('span');
      d.className = 'ripple';
      d.style.cssText = 'width:' + size + 'px;height:' + size + 'px;left:' + (e.clientX - r.left - size / 2) + 'px;top:' + (e.clientY - r.top - size / 2) + 'px';
      el.appendChild(d);
      setTimeout(function () { d.remove(); }, 650);
    });
  }

  function bindFullscreen() {
    var btn = $('fsBtn'), de = document.documentElement;
    var req = de.requestFullscreen || de.webkitRequestFullscreen;
    var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
    if (!btn || !req || standalone) return;
    btn.hidden = false;
    btn.style.marginRight = '8px';
    btn.addEventListener('click', function () {
      var on = document.fullscreenElement || document.webkitFullscreenElement;
      var p = on ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
                 : req.call(de);
      if (p && p.catch) p.catch(function () { toast('此瀏覽器不支援全螢幕'); });
    });
    function sync() { btn.textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? '✕' : '⛶'; }
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
  }

  /* ============ 範本歌單 ============ */
  var TEMPLATES = [
    { name: '熱門動漫 OP 精選', songs: [
      { anime: '鬼滅之刃', title: '紅蓮華', artist: 'LiSA', videoId: '' },
      { anime: '咒術迴戰', title: '廻廻奇譚', artist: 'Eve', videoId: '' },
      { anime: '孤獨搖滾', title: '青春コンプレックス', artist: '結束バンド', videoId: '' },
      { anime: '葬送的芙莉蓮', title: '勇者', artist: 'YOASOBI', videoId: '' }
    ] },
    { name: '深夜放鬆 動漫歌', songs: [
      { anime: '你的名字', title: '前前前世', artist: 'RADWIMPS', videoId: '' },
      { anime: '天気の子', title: '愛にできることはまだあるかい', artist: 'RADWIMPS', videoId: '' },
      { anime: '輝夜姬想讓人告白', title: 'Love Dramatic', artist: '鈴木雅之', videoId: '' }
    ] }
  ];

  function renderTemplates() {
    var sec = $('templateSection'), list = $('templateList');
    if (!sec || !list) return;
    list.innerHTML = '';
    var shown = 0;
    TEMPLATES.forEach(function (t) {
      var songs = t.songs.filter(function (x) { return parseVideoId(x.videoId); });
      if (!songs.length) return;
      shown++;
      var row = document.createElement('div');
      row.className = 'playlist-card';
      row.innerHTML = '<a class="pc-left"><span class="hist-cover"></span><span class="pc-info"><span class="pc-title">' + esc(t.name) +
        '</span><span class="pc-meta">' + songs.length + ' 首 · 點擊試聽</span></span></a>' +
        (currentUser ? '<button type="button" class="icon-btn" aria-label="複製到我的歌單" title="複製到我的歌單">＋</button>' : '');
      row.querySelector('a').setAttribute('href', '#play/' + encodePlaylist({ name: t.name, songs: songs }));
      var u = thumbOf(songs[0]);
      if (u) row.querySelector('.hist-cover').style.backgroundImage = 'url("' + u.replace(/"/g, '%22') + '")';
      var btn = row.querySelector('button');
      if (btn) btn.addEventListener('click', function () {
        var pl = createEmptyPlaylist(t.name);
        pl.songs = songs.map(function (x) { return { anime: x.anime || '', title: x.title || '', artist: x.artist || '', videoId: x.videoId, cover: x.cover || '' }; });
        state.playlists.push(pl);
        saveDraft(); saveDraftToCloud(true);
        toast('已複製到我的歌單');
        location.hash = '#edit/' + pl.id;
      });
      list.appendChild(row);
    });
    sec.hidden = !shown;
  }

  /* ============ 播放模式 / 睡眠定時 / 外觀 ============ */
  var MODES = [['off', '➡️ 順序'], ['all', '🔁 循環'], ['one', '🔂 單曲'], ['shuffle', '🔀 隨機']];
  var playMode = 'off';
  var SLEEP_OPTS = [0, 15, 30, 60], sleepIdx = 0, sleepAt = 0, sleepTick = null;
  var ACCENTS = [['青', '#00e5ff'], ['櫻', '#ff6fb5'], ['紫', '#a78bfa'], ['琥珀', '#ffb020'], ['薄荷', '#34d399'], ['紅蓮', '#ff4757']];
  var VINYLS = [['經典黑', '#16161a'], ['血紅', '#7a1220'], ['冰藍', '#1c5f8a'], ['粉紅', '#a8326f'], ['金', '#8a6a1c'], ['紫', '#4b2a8a']];
  var LABELS = [['cover', '封面圖'], ['solid', '純色'], ['gradient', '漸層']];
  var THEME_DEFAULT = { accent: '#00e5ff', vinyl: '#16161a', groove: 16, label: 'cover' };
  var theme = Object.assign({}, THEME_DEFAULT);

  function pickNext(auto) {
    var n = playlist.songs.length;
    if (auto && playMode === 'one') return currentIndex;
    if (playMode === 'shuffle' && n > 1) {
      var i;
      do { i = Math.floor(Math.random() * n); } while (i === currentIndex);
      return i;
    }
    if (currentIndex < n - 1) return currentIndex + 1;
    return playMode === 'off' ? -1 : 0;
  }

  function pickPrev() {
    if (currentIndex > 0) return currentIndex - 1;
    return playMode === 'off' ? -1 : playlist.songs.length - 1;
  }

  function setSleep(min) {
    clearInterval(sleepTick);
    sleepAt = min ? Date.now() + min * 60000 : 0;
    var b = $('sleepBtn');
    if (!min) {
      if (b) { b.textContent = '😴 定時'; b.classList.remove('on'); }
      sleepIdx = 0;
      return;
    }
    if (b) b.classList.add('on');
    tickSleep();
    sleepTick = setInterval(tickSleep, 1000);
  }

  function tickSleep() {
    if (!sleepAt) return;
    var left = sleepAt - Date.now();
    var b = $('sleepBtn');
    if (left <= 0) {
      if (player && player.pauseVideo) { player.pauseVideo(); if (player.setVolume) player.setVolume(100); }
      setSleep(0);
      toast('睡眠定時已到，晚安 🌙');
      return;
    }
    if (left < 10000 && player && player.setVolume) player.setVolume(Math.max(5, Math.round(left / 100)));
    if (b) b.textContent = '😴 ' + Math.ceil(left / 60000) + ' 分';
  }

  function hexRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function applyTheme() {
    var th = currentUser ? theme : THEME_DEFAULT;
    var c = hexRgb(th.accent).join(','), st = document.documentElement.style;
    st.setProperty('--accent', th.accent);
    st.setProperty('--accent-rgb', c);
    st.setProperty('--accent-dim', 'rgba(' + c + ',.2)');
    st.setProperty('--vinyl-a', th.vinyl);
    st.setProperty('--groove', (th.groove / 100).toFixed(2));
    document.body.setAttribute('data-label', th.label);
  }

  function saveTheme() {
    try { localStorage.setItem('anime-vinyl:theme', JSON.stringify(theme)); } catch (e) {}
  }

  function bindExtras() {
    try {
      var m = localStorage.getItem('anime-vinyl:mode');
      if (MODES.some(function (x) { return x[0] === m; })) playMode = m;
      var t = JSON.parse(localStorage.getItem('anime-vinyl:theme'));
      if (t) {
        var hex = /^#[0-9a-f]{6}$/i;
        if (hex.test(t.accent)) theme.accent = t.accent;
        if (hex.test(t.vinyl)) theme.vinyl = t.vinyl;
        if (t.groove >= 0 && t.groove <= 50) theme.groove = +t.groove;
        if (LABELS.some(function (x) { return x[0] === t.label; })) theme.label = t.label;
      }
    } catch (e) {}
    applyTheme();

    var modeBtn = $('modeBtn');
    function showMode() {
      var cur = MODES.filter(function (x) { return x[0] === playMode; })[0];
      modeBtn.textContent = cur[1];
      modeBtn.classList.toggle('on', playMode !== 'off');
    }
    showMode();
    modeBtn.addEventListener('click', function () {
      var i = MODES.findIndex(function (x) { return x[0] === playMode; });
      playMode = MODES[(i + 1) % MODES.length][0];
      try { localStorage.setItem('anime-vinyl:mode', playMode); } catch (e) {}
      showMode();
      if (playlist) renderPlayMeta();
    });

    $('sleepBtn').addEventListener('click', function () {
      sleepIdx = (sleepIdx + 1) % SLEEP_OPTS.length;
      var min = SLEEP_OPTS[sleepIdx];
      setSleep(min);
      sleepIdx = SLEEP_OPTS.indexOf(min);
      if (min) toast('將在 ' + min + ' 分鐘後停止播放'); else toast('已取消睡眠定時');
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tickSleep(); });

    var accentBox = $('accentSwatches'), vinylBox = $('vinylSwatches'), seg = $('labelSeg');
    var accentPick = $('accentPicker'), vinylPick = $('vinylPicker'), grooveRange = $('grooveRange');

    function refreshUI() {
      Array.prototype.forEach.call(accentBox.children, function (b) { b.classList.toggle('active', b.dataset.c === theme.accent); });
      Array.prototype.forEach.call(vinylBox.children, function (b) { b.classList.toggle('active', b.dataset.c === theme.vinyl); });
      Array.prototype.forEach.call(seg.children, function (b) { b.classList.toggle('active', b.dataset.k === theme.label); });
      if (accentPick.value !== theme.accent) accentPick.value = theme.accent;
      if (vinylPick.value !== theme.vinyl) vinylPick.value = theme.vinyl;
      grooveRange.value = theme.groove;
    }
    function change() { applyTheme(); saveTheme(); refreshUI(); }

    function addSwatches(box, items, key) {
      box.innerHTML = '';
      items.forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.dataset.c = it[1];
        b.setAttribute('aria-label', it[0]);
        b.style.background = it[1];
        b.addEventListener('click', function () { theme[key] = it[1]; change(); });
        box.appendChild(b);
      });
    }
    addSwatches(accentBox, ACCENTS, 'accent');
    addSwatches(vinylBox, VINYLS, 'vinyl');
    seg.innerHTML = '';
    LABELS.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = it[1];
      b.dataset.k = it[0];
      b.addEventListener('click', function () { theme.label = it[0]; change(); });
      seg.appendChild(b);
    });
    accentPick.addEventListener('input', function () { theme.accent = accentPick.value; change(); });
    vinylPick.addEventListener('input', function () { theme.vinyl = vinylPick.value; change(); });
    grooveRange.addEventListener('input', function () { theme.groove = +grooveRange.value; change(); });
    $('themeReset').addEventListener('click', function () { theme = Object.assign({}, THEME_DEFAULT); change(); });
    refreshUI();

    var modal = $('themeModal');
    
    function openThemeModal() {
      refreshUI();
      if (modal) {
        modal.hidden = false;
        requestAnimationFrame(() => modal.classList.add('show'));
      }
    }

    function closeThemeModal() {
      if (modal) {
        modal.classList.remove('show');
        setTimeout(() => { modal.hidden = true; }, 300);
      }
    }

    $('themeBtn').addEventListener('click', openThemeModal);
    $('themeDone').addEventListener('click', closeThemeModal);
    modal.addEventListener('click', function (e) { 
      if (e.target === modal) closeThemeModal(); 
    });
  }

  function bindEditorControls() {
    if ($('playlistNick')) $('playlistNick').addEventListener('input', function (e) {
      var pl = getCurrentPlaylist();
      if (pl) { pl.nick = e.target.value.slice(0, 20); markDirty(); }
    });
    if ($('createPlaylistBtn')) $('createPlaylistBtn').addEventListener('click', function () {
      if (!currentUser) return;
      var newPl = createEmptyPlaylist('新歌單 ' + (state.playlists.length + 1));
      state.playlists.push(newPl);
      saveDraft();
      saveDraftToCloud(true);
      location.hash = '#edit/' + newPl.id;
    });

    if ($('playlistName')) $('playlistName').addEventListener('input', function (e) {
      var pl = getCurrentPlaylist();
      if (pl) {
        pl.name = e.target.value;
        markDirty();
      }
    });

    if ($('playlistIsPublic')) $('playlistIsPublic').addEventListener('change', function (e) {
      var pl = getCurrentPlaylist();
      if (pl) {
        pl.isPublic = e.target.checked;
        syncPublicUI(pl);
        markDirty();
      }
    });

    if ($('saveBtn')) $('saveBtn').addEventListener('click', function () {
      if (!currentUser) {
        toast('請先登入才能儲存至雲端');
        return;
      }
      var pl = getCurrentPlaylist();
      if (pl) pl.updatedAt = new Date().toISOString();
      saveDraft();
      clearTimeout(autoSaveTimer);
      saveDraftToCloud(false);
      if ($('saveStatus')) $('saveStatus').textContent = '已儲存';
      isDirty = false;
    });

    if ($('addSongBtn')) $('addSongBtn').addEventListener('click', function () {
      var pl = getCurrentPlaylist();
      if (!pl) return;
      pl.songs.push({ anime: '', title: '', artist: '', videoId: '', cover: '' });
      markDirty();
      renderEditor();
      var cards = $('songEditorList').querySelectorAll('.song-card');
      if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    if ($('previewBtn')) $('previewBtn').addEventListener('click', function () {
      var pl = getCurrentPlaylist();
      if (!pl) return;
      var valid = pl.songs.filter(function (s) { return parseVideoId(s.videoId); });
      if (!valid.length) { toast('請先新增至少一首有 YouTube 影片 ID 的歌曲'); return; }
      previewFromId = currentPlaylistId;
      location.hash = 'preview/' + encodePlaylist(pl);
    });

    if ($('shareBtn')) $('shareBtn').addEventListener('click', async function () {
      var pl = getCurrentPlaylist();
      if (!pl) return;
      var valid = pl.songs.filter(function (s) { return parseVideoId(s.videoId); });
      if (!valid.length) { toast('請先新增至少一首有 YouTube 影片 ID 的歌曲'); return; }
      var base = location.origin + location.pathname + location.search;
      var url, tip;
      if (currentUser && dbAPI && cloudReady) {
        try {
          if (!pl.shareId) pl.shareId = newShareId();
          if (pl.linked !== true) { pl.linked = true; markDirty(); }
          await publishShared(pl);
          saveDraftToCloud(true);
          url = base + '#s/' + pl.shareId;
          tip = '這是短網址：之後修改並儲存歌單，連結內容會自動更新，NFC 標籤不用重寫。';
        } catch (e) {
          toast('短網址建立失敗：' + (e.code || e.message), 5000);
          return;
        }
      } else {
        url = base + '#play/' + encodePlaylist(pl);
        tip = '（雲端尚未連線，已產生完整長連結，內容不會隨編輯更新。）';
      }
      if ($('shareUrl')) $('shareUrl').value = url;
      if ($('shareBox')) $('shareBox').hidden = false;
      if ($('shareInfo')) $('shareInfo').textContent = '連結長度：' + url.length + ' 字元。' + tip;
      if ($('shareBox')) $('shareBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    if ($('copyBtn')) $('copyBtn').addEventListener('click', function () {
      var url = $('shareUrl').value;
      if (!url) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { toast('已複製連結'); })
        .catch(function () {
          $('shareUrl').select();
          document.execCommand('copy');
          toast('已複製連結');
        });
      } else {
        $('shareUrl').select();
        document.execCommand('copy');
        toast('已複製連結');
      }
    });
  }

  /* ============ 刪除功能與動畫 ============ */
  var deleteTargetId = null;
  var deleteSource = null;

  function openDeleteModal(id, source) {
    deleteTargetId = id;
    deleteSource = source;
    var modal = $('deleteModal');
    if (modal) {
      modal.hidden = false;
      requestAnimationFrame(() => modal.classList.add('show'));
    }
  }

  function closeDeleteModal() {
    var modal = $('deleteModal');
    if (modal) {
      modal.classList.remove('show');
      setTimeout(() => { modal.hidden = true; }, 300);
    }
    deleteTargetId = null;
    deleteSource = null;
  }

  function executeDelete() {
    if (!deleteTargetId) return;
    
    var targetId = deleteTargetId;
    var source = deleteSource;
    closeDeleteModal();

    var overlay = $('eatOverlay');
    var monster = $('monster');
    var targetEl = source === 'edit' ? $('editWrap') : $('playWrap');

    if (overlay && targetEl && monster) {
      overlay.hidden = false;
      requestAnimationFrame(() => overlay.classList.add('show'));

      setTimeout(() => {
        monster.classList.add('open-mouth');
      }, 300);

      setTimeout(() => {
        targetEl.classList.add('being-eaten');
        stopPlayback();
      }, 600);

      setTimeout(() => {
        monster.classList.remove('open-mouth');
        
        var idx = state.playlists.findIndex(p => p.id === targetId);
        if (idx !== -1) {
          removeShared(state.playlists[idx]);
          state.playlists.splice(idx, 1);
          saveDraft();
          if (currentUser) saveDraftToCloud(true);
        }

        setTimeout(() => {
          overlay.classList.remove('show');
          setTimeout(() => { 
            overlay.hidden = true; 
            if (targetEl) targetEl.classList.remove('being-eaten');
          }, 300);
          
          location.hash = '#home';
        }, 800);

      }, 1400);
    } else {
      var idx = state.playlists.findIndex(p => p.id === targetId);
      if (idx !== -1) {
        removeShared(state.playlists[idx]);
          state.playlists.splice(idx, 1);
        saveDraft();
        if (currentUser) saveDraftToCloud(true);
      }
      location.hash = '#home';
    }
  }

  function bindDeleteControls() {
    if ($('deleteEditBtn')) {
      $('deleteEditBtn').addEventListener('click', function() {
        if (currentPlaylistId) openDeleteModal(currentPlaylistId, 'edit');
      });
    }

    if ($('deletePlayBtn')) {
      $('deletePlayBtn').addEventListener('click', function() {
        if (currentUser && state.playlists.length > 0) {
          var matchedPl = state.playlists.find(p => p.id === previewFromId);
          if (matchedPl) {
            openDeleteModal(matchedPl.id, 'play');
          } else {
            toast('找不到此歌單，可能不是你的歌單');
          }
        }
      });
    }

    if ($('cancelDeleteBtn')) $('cancelDeleteBtn').addEventListener('click', closeDeleteModal);
    if ($('confirmDeleteBtn')) $('confirmDeleteBtn').addEventListener('click', executeDelete);
  }

  /* ============ 登入與 UI 切換 ============ */
  function triggerLogin() {
    if (!window.firebaseAuth) {
      toast('登入模組載入中，請稍候再試...');
      return;
    }
    var ua = navigator.userAgent || navigator.vendor || window.opera;
    if (ua.indexOf("FBAN") > -1 || ua.indexOf("FBAV") > -1 || ua.indexOf("Line") > -1 || ua.indexOf("Instagram") > -1) {
      toast('請點擊右上角選單，選擇「使用外部瀏覽器」開啟本頁面進行登入。', 5000);
      return;
    }
    var authAPI = window.firebaseAuth;
    authAPI.signInWithPopup(authAPI.auth, authAPI.provider).catch(function(error) {
      if (error.code === 'auth/popup-blocked') {
        authAPI.signInWithRedirect(authAPI.auth, authAPI.provider);
      } else if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
        toast('登入失敗：' + error.message);
      }
    });
  }

  function triggerLogout() {
    if (!window.firebaseAuth) return;
    clearTimeout(autoSaveTimer);
    var pending = (isDirty && currentUser) ? saveDraftToCloud(true) : Promise.resolve();
    pending.then(function () { window.firebaseAuth.signOut(window.firebaseAuth.auth); });
    toast('已登出');
    location.hash = '#home';
  }

  function updateAuthUI(user) {
    currentUser = user;
    ['sleepBtn', 'themeBtn'].forEach(function (id) { if ($(id)) $(id).hidden = !user; });
    if (!user) {
      setSleep(0);
      if ($('themeModal')) {
        $('themeModal').classList.remove('show');
        $('themeModal').hidden = true;
      }
    }
    applyTheme();
    
    var loginBtns = [$('loginBtnPlay'), $('guestLoginBtn')];
    var profiles = [$('userProfile'), $('userProfilePlay')];
    var dropdowns = [$('userDropdown'), $('userDropdownPlay')];
    var homeUserArea = $('homeUserArea');
    
    if (user) {
      loginBtns.forEach(btn => { if (btn) btn.hidden = true; });
      profiles.forEach(prof => { if (prof) prof.hidden = false; });
      if (homeUserArea) homeUserArea.hidden = false;
      
      var avatarUrl = user.photoURL || 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y';
      var nameStr = user.displayName || '使用者';
      
      if ($('userAvatar')) $('userAvatar').src = avatarUrl;
      if ($('userAvatarPlay')) $('userAvatarPlay').src = avatarUrl;
      
      if ($('userName')) $('userName').textContent = nameStr;
      if ($('userEmail')) $('userEmail').textContent = user.email || '';
      if ($('userNamePlay')) $('userNamePlay').textContent = nameStr;
      
      if ($('backLink')) $('backLink').hidden = false;
      
      LS_KEY = LS_BASE + ':' + user.uid;
      state = { playlists: [] };
      isDirty = false;
      loadDraft();
      playHistory = loadHistory();
      listenDraftFromCloud();
    } else {
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }

      loginBtns.forEach(btn => { if (btn) btn.hidden = false; });
      profiles.forEach(prof => { if (prof) prof.hidden = true; });
      dropdowns.forEach(dd => { if (dd) dd.hidden = true; });
      if (homeUserArea) homeUserArea.hidden = true;
      
      var hash = location.hash || '';
      if ((hash.startsWith('#play/') || hash.startsWith('#s/')) && $('backLink')) {
        $('backLink').hidden = true;
      }
      
      if (LS_KEY !== LS_BASE + ':guest') {
        try { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_KEY + ':history'); } catch (e) {}
      }
      LS_KEY = LS_BASE + ':guest';
      cloudReady = false;
      playHistory = loadHistory();
      isDirty = false;
      state = { playlists: [] };
      renderPlaylistGrid();
    }
  }

  function bindAuthControls() {
    if ($('guestLoginBtn')) $('guestLoginBtn').addEventListener('click', triggerLogin);
    if ($('loginBtnPlay')) $('loginBtnPlay').addEventListener('click', triggerLogin);

    var profiles = [$('userProfile'), $('userProfilePlay')];
    profiles.forEach(prof => {
      if (prof) {
        prof.addEventListener('click', function(e) {
          e.stopPropagation();
          var dd = prof.querySelector('.user-dropdown');
          if (dd) dd.hidden = !dd.hidden;
        });
      }
    });

    document.addEventListener('click', function() {
      document.querySelectorAll('.user-dropdown').forEach(dd => dd.hidden = true);
    });

    var logoutBtns = [$('logoutBtn'), ...document.querySelectorAll('.play-logout-btn')];
    logoutBtns.forEach(btn => {
      if (btn) btn.addEventListener('click', function(e) {
        e.stopPropagation();
        triggerLogout();
      });
    });

    if ($('deleteAccountBtn')) $('deleteAccountBtn').addEventListener('click', function(e) {
      e.stopPropagation();
      if ($('userDropdown')) $('userDropdown').hidden = true;
      if (!confirm('確定要刪除帳號嗎？這會永久刪除你的所有雲端歌單，且無法復原！')) return;
      
      if (currentUser && window.firebaseAuth && window.firebaseDB) {
        var authAPI = window.firebaseAuth;
        var dbAPI = window.firebaseDB;
        var uid = currentUser.uid;
        
        if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
        clearTimeout(autoSaveTimer);
        var docRef = dbAPI.doc(dbAPI.db, 'playlists', uid);
        authAPI.reauthenticateWithPopup(currentUser, authAPI.provider)
          .then(function () {
            return Promise.all(state.playlists.filter(function (p) { return p.shareId; }).map(function (p) {
              return Promise.all(['shared', 'explore_playlists'].map(function (col) {
                return dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, col, p.shareId)).catch(function () {});
              }));
            }));
          })
          .then(function () { return dbAPI.deleteDoc(docRef); })
          .then(function () { return authAPI.deleteUser(currentUser); })
          .then(function () {
            toast('帳號已刪除');
            try { localStorage.removeItem(LS_KEY); } catch (e) {}
            location.hash = '#home';
          })
          .catch(function (error) {
            listenDraftFromCloud();
            if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
              toast('刪除失敗：' + error.message);
            }
          });
      }
    });
  }

  function setupAuthListener() {
    if (!window.firebaseAuth) return;
    authAPI = window.firebaseAuth;
    dbAPI = window.firebaseDB;
    authAPI.onAuthStateChanged(authAPI.auth, function(user) {
      updateAuthUI(user);
      route();
    });
  }

  /* ============ 初始化 ============ */
  function init() {
    bindEditorControls();
    bindPlayControls();
    bindAuthControls();
    bindDeleteControls();
    bindNfcControls();
    bindExploreControls();
    bindSeek();
    buildEq();
    bindZoomLock();
    bindFx();
    bindFullscreen();
    bindExtras();
    
    loadDraft();
    
    playHistory = loadHistory();
    route();
    window.addEventListener('hashchange', route);

    if (window.firebaseAuth) {
      setupAuthListener();
    } else {
      window.addEventListener('firebaseReady', setupAuthListener);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
