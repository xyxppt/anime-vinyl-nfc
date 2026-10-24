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
  var unsubscribeSnapshot = null; // 用來取消監聽

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

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function createEmptyPlaylist(name) {
    return {
      id: generateId(),
      name: name || '新歌單',
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
      var docRef = dbAPI.doc(dbAPI.db, 'playlists', currentUser.uid);
      await dbAPI.setDoc(docRef, {
        playlists: state.playlists,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      
      var cp = getCurrentPlaylist();
      if (cp && cp.shareId) publishShared(cp).catch(function (e) { console.error(e); });
      if (!silent) toast('☁️ 已儲存至雲端');
    } catch (e) {
      console.error('雲端儲存失敗', e);
      toast('⚠️ 雲端同步失敗：' + (e.code || e.message), 5000);
    }
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
      if (pl) { $('playlistName').value = pl.name; renderEditor(); }
    }
  }

  // 即時監聽雲端資料(首次與本機合併,之後以雲端為準)
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

  /* ============ 播放紀錄(分享連結 / NFC) ============ */
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
      row.querySelector('a').setAttribute('href', /^[a-z0-9]{6,12}$/.test(h.sid || '') ? '#s/' + h.sid : '#play/' + h.code);
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

  function stopPlayback() {
    if (player && player.stopVideo) {
      try { player.stopVideo(); } catch (e) {}
    }
    document.body.classList.remove('playing');
    if ($('tapPrompt')) $('tapPrompt').hidden = true;
    stopProgress();
    setBar(0);
    if ($('cur')) $('cur').textContent = '0:00';
    if ($('dur')) $('dur').textContent = '0:00';
  }

  function show(id) {
    ['viewEdit', 'viewPlay', 'viewError', 'viewHome'].forEach(function (v) {
      var el = $(v);
      if (el) el.hidden = (v !== id);
    });
    window.scrollTo(0, 0);
    var lock = id === 'viewPlay';
    document.body.classList.toggle('play-mode', lock);
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
    renderHistory();
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
          '<span class="pc-meta">' + count + ' 首歌曲</span>' +
        '</div>' +
        '<div class="pc-arrow">❯</div>';
      grid.appendChild(a);
    });
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
    }
  }

  function loadShared(id) {
    if (!/^[a-z0-9]{6,12}$/.test(id)) { showError('無效的分享連結'); return; }
    if (!dbAPI) return;
    dbAPI.getDoc(dbAPI.doc(dbAPI.db, 'shared', id)).then(function (snap) {
      if (location.hash !== '#s/' + id) return;
      if (!snap.exists()) { showError('找不到這份歌單，連結可能已失效。'); return; }
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
      previoustrack: function () { goToSong(currentIndex - 1); },
      nexttrack: function () { goToSong(currentIndex + 1); }
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
    if ($('prevArrow')) $('prevArrow').classList.toggle('disabled', currentIndex === 0);
    if ($('nextArrow')) $('nextArrow').classList.toggle('disabled', currentIndex >= playlist.songs.length - 1);
    if ($('prevBtn')) $('prevBtn').disabled = currentIndex === 0;
    if ($('nextBtn')) $('nextBtn').disabled = currentIndex >= playlist.songs.length - 1;
  }

  function initYTPlayer() {
    var s = playlist.songs[currentIndex];
    if (!s) return;
    var vid = parseVideoId(s.videoId);

    if (player && player.loadVideoById) {
      player.loadVideoById(vid);
      return;
    }

    if (window.YT && YT.Player) {
      createYTPlayer(vid);
      return;
    }

    if (!window._ytLoading) {
      window._ytLoading = true;
      var tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
    window.onYouTubeIframeAPIReady = function () {
      window._ytLoading = false;
      createYTPlayer(parseVideoId(playlist.songs[currentIndex].videoId));
    };
  }

  function createYTPlayer(videoId) {
    var vars = {
      autoplay: 0, controls: 0, disablekb: 1,
      modestbranding: 1, rel: 0, playsinline: 1, fs: 0
    };
    if (location.protocol.indexOf('http') === 0) vars.origin = location.origin;

    player = new YT.Player('ytHost', {
      videoId: videoId,
      playerVars: vars,
      events: {
        onReady: onYTReady,
        onStateChange: onYTStateChange,
        onError: onYTError
      }
    });
  }

  function onYTReady() {
    if ($('dur')) $('dur').textContent = fmtTime(player.getDuration());
    try { player.playVideo(); } catch (e) {}

    clearTimeout(tapTimer);
    tapTimer = setTimeout(function () {
      if (!player || !player.getPlayerState) return;
      if (player.getPlayerState() !== 1) {
        if ($('tapPrompt')) $('tapPrompt').hidden = false;
      }
    }, 1500);
  }

  function onYTStateChange(e) {
    var st = e.data;
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
      if (currentIndex < playlist.songs.length - 1) {
        goToSong(currentIndex + 1);
      } else {
        setBar(1);
      }
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
      setTimeout(function () { goToSong(currentIndex + 1); }, 1500);
    }
  }

  function goToSong(i) {
    if (i < 0 || i >= playlist.songs.length) return;
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
      player.loadVideoById(vid);
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
        if (diffX > 0 && currentIndex > 0) {
          goToSong(currentIndex - 1);
        } else if (diffX < 0 && currentIndex < playlist.songs.length - 1) {
          goToSong(currentIndex + 1);
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

    if ($('prevArrow')) $('prevArrow').addEventListener('click', function () { goToSong(currentIndex - 1); });
    if ($('nextArrow')) $('nextArrow').addEventListener('click', function () { goToSong(currentIndex + 1); });
    bindMediaKeys();

    if ($('prevBtn')) $('prevBtn').addEventListener('click', function () { goToSong(currentIndex - 1); });
    if ($('nextBtn')) $('nextBtn').addEventListener('click', function () { goToSong(currentIndex + 1); });

    if ($('tapPrompt')) $('tapPrompt').addEventListener('click', function () {
      $('tapPrompt').hidden = true;
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

  function bindEditorControls() {
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
          if (!pl.shareId) {
            pl.shareId = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 8);
            markDirty();
          }
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
            targetEl.classList.remove('being-eaten');
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
      // 登出時取消監聽
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
              return dbAPI.deleteDoc(dbAPI.doc(dbAPI.db, 'shared', p.shareId));
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
    bindSeek();
    buildEq();
    bindZoomLock();
    
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
