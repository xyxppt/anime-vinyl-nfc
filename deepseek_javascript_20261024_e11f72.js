(function () {
  'use strict';

  /* ============ 工具 ============ */
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
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

  /* ============ YouTube 影片 ID 解析 ============ */
  function parseVideoId(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    if (/^[\w-]{11}$/.test(s)) return s;
    var m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
    return m ? m[1] : '';
  }

  function thumbOf(song) {
    if (song.cover) return song.cover;
    var vid = parseVideoId(song.videoId);
    if (vid) return 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg';
    return '';
  }

  /* ============ 資料層 ============ */
  var LS_KEY = 'anime-vinyl:draft';
  var state = { name: '我的黑膠歌單', songs: [] };

  function newSong() {
    return { anime: '', title: '', artist: '', videoId: '', cover: '' };
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && Array.isArray(d.songs)) {
          state.name = d.name || '我的黑膠歌單';
          state.songs = d.songs;
        }
      }
    } catch (e) {}
  }

  function saveDraft() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* ============ 歌單編碼 / 解碼 ============ */
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
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return decodeURIComponent(escape(atob(s)));
  }

  function encodePlaylist(pl) {
    var mini = packPayload(pl);
    var json = JSON.stringify(mini);
    if (window.LZString && LZString.compressToEncodedURIComponent) {
      var compressed = LZString.compressToEncodedURIComponent(json);
      // 把 + 換成 .，避免某些應用程式轉義成空白
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
        throw new Error('缺少解壓縮元件，請確認網路連線後重新整理');
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

  /* ============ 路由 ============ */
  function route() {
    var hash = location.hash || '';

    if (hash.indexOf('#play/') === 0) {
      showPlayView(hash.slice(6), false);
      return;
    }
    if (hash.indexOf('#preview/') === 0) {
      showPlayView(hash.slice(9), true);
      return;
    }
    if (hash === '#play' || hash === '#preview') {
      location.replace(location.pathname + location.search + '#edit');
      return;
    }
    showEditView();
  }

  function show(id) {
    ['viewEdit', 'viewPlay', 'viewError'].forEach(function (v) {
      $(v).hidden = (v !== id);
    });
    window.scrollTo(0, 0);
  }

  /* ============ 編輯視圖 ============ */
  function showEditView() {
    loadDraft();
    if (!state.songs.length) state.songs.push(newSong());
    $('playlistName').value = state.name;
    renderEditor();
    show('viewEdit');
  }

  function renderEditor() {
    var list = $('songEditorList');
    list.innerHTML = '';
    state.songs.forEach(function (song, index) {
      list.appendChild(buildSongCard(song, index));
    });
  }

  function buildSongCard(song, index) {
    var el = document.createElement('div');
    el.className = 'song-card';

    el.innerHTML =
      '<div class="song-card-head">' +
        '<span class="song-num">' + (index + 1) + '</span>' +
        '<div class="song-card-tools">' +
          '<button type="button" class="icon-btn" data-act="up"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="icon-btn" data-act="down"' + (index === state.songs.length - 1 ? ' disabled' : '') + '>↓</button>' +
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

    // 輸入
    el.querySelectorAll('input[data-k]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var k = inp.dataset.k;
        song[k] = inp.value;
        if (k === 'videoId' || k === 'cover') updateCover();
        saveDraft();
      });
      inp.addEventListener('blur', function () {
        if (inp.dataset.k === 'videoId') {
          var id = parseVideoId(inp.value);
          if (id && id !== inp.value) {
            inp.value = id;
            song.videoId = id;
            saveDraft();
          }
          updateCover();
        }
      });
    });

    // 排序 / 刪除
    el.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.dataset.act;
        var i = state.songs.indexOf(song);
        if (act === 'up' && i > 0) {
          var tmp = state.songs[i - 1];
          state.songs[i - 1] = state.songs[i];
          state.songs[i] = tmp;
        } else if (act === 'down' && i < state.songs.length - 1) {
          var tmp2 = state.songs[i + 1];
          state.songs[i + 1] = state.songs[i];
          state.songs[i] = tmp2;
        } else if (act === 'del') {
          if (state.songs.length <= 1) {
            toast('至少要保留一首歌');
            return;
          }
          state.songs.splice(i, 1);
        }
        saveDraft();
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

  function showPlayView(code, isPreview) {
    try {
      playlist = decodePlaylist(code);
    } catch (e) {
      showError('無法讀取歌單：' + e.message);
      return;
    }

    // 過濾掉無效歌曲
    playlist.songs = (playlist.songs || []).filter(function (s) {
      return parseVideoId(s.videoId);
    });

    if (!playlist.songs.length) {
      showError('這個歌單裡沒有有效的歌曲。\n請回到編輯頁，至少加入一首有 YouTube 影片 ID 的歌。');
      return;
    }

    document.title = (playlist.name || 'Anime Vinyl') + ' — Anime Vinyl';
    $('backLink').hidden = !isPreview;

    currentIndex = 0;
    show('viewPlay');
    renderPlayMeta();
    renderDrawer();
    initYTPlayer();
  }

  function renderPlayMeta() {
    var s = playlist.songs[currentIndex];
    $('anime').textContent = s.anime || '';
    $('title').textContent = s.title || '未命名歌曲';
    $('artist').textContent = s.artist || '';
    var url = thumbOf(s);
    $('label').style.backgroundImage = url ? 'url("' + url + '")' : '';
    $('prevBtn').disabled = currentIndex === 0;
    $('nextBtn').disabled = currentIndex >= playlist.songs.length - 1;
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
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      fs: 0
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
    $('dur').textContent = fmtTime(player.getDuration());
    try { player.playVideo(); } catch (e) {}

    clearTimeout(tapTimer);
    tapTimer = setTimeout(function () {
      if (!player || !player.getPlayerState) return;
      if (player.getPlayerState() !== 1) $('tapPrompt').hidden = false;
    }, 1500);
  }

  function onYTStateChange(e) {
    var st = e.data;
    if (st === 1) {
      document.body.classList.add('playing');
      $('playBtn').textContent = '❚❚';
      $('tapPrompt').hidden = true;
      startProgress();
    } else if (st === 2) {
      document.body.classList.remove('playing');
      $('playBtn').textContent = '▶';
      stopProgress();
    } else if (st === 0) {
      document.body.classList.remove('playing');
      $('playBtn').textContent = '▶';
      stopProgress();
      if (currentIndex < playlist.songs.length - 1) {
        setTimeout(function () { goToSong(currentIndex + 1); }, 700);
      } else {
        $('fill').style.width = '100%';
      }
    }
  }

  function onYTError(e) {
    $('tapPrompt').hidden = true;
    var msgs = {
      2:   'YouTube 影片 ID 無效。',
      5:   '這個影片無法在網頁中播放。',
      100: '影片不存在或已設為私人。',
      101: '影片擁有者不允許嵌入播放。',
      150: '影片擁有者不允許嵌入播放。'
    };
    toast(msgs[e.data] || '影片載入失敗。');
  }

  function goToSong(i) {
    if (i < 0 || i >= playlist.songs.length) return;
    currentIndex = i;
    var s = playlist.songs[i];
    renderPlayMeta();
    renderDrawer();
    $('fill').style.width = '0%';
    $('cur').textContent = '0:00';
    $('dur').textContent = '0:00';
    var vid = parseVideoId(s.videoId);
    if (player && player.loadVideoById) {
      player.loadVideoById(vid);
    } else {
      initYTPlayer();
    }
  }

  function startProgress() {
    stopProgress();
    progressTimer = setInterval(function () {
      if (!player || !player.getDuration) return;
      var d = player.getDuration();
      var c = player.getCurrentTime();
      if (!d) return;
      $('fill').style.width = (c / d * 100) + '%';
      $('cur').textContent = fmtTime(c);
      $('dur').textContent = fmtTime(d);
    }, 250);
  }

  function stopProgress() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function renderDrawer() {
    $('drawerTitle').textContent = playlist.name || '歌單';
    var list = $('drawerList');
    list.innerHTML = '';
    playlist.songs.forEach(function (s, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'drawer-item' + (i === currentIndex ? ' active' : '');
      var url = thumbOf(s);
      btn.innerHTML =
        '<span class="di-cover"' + (url ? ' style="background-image:url(\'' + url + '\')"' : '') + '></span>' +
        '<span class="di-info">' +
          '<span class="di-title">' + esc(s.title || '未命名') + '</span>' +
          '<span class="di-artist">' + esc(s.artist || s.anime || '') + '</span>' +
        '</span>';
      btn.addEventListener('click', function () {
        goToSong(i);
        $('playlistDrawer').hidden = true;
      });
      list.appendChild(btn);
    });
  }

  /* ============ 錯誤視圖 ============ */
  function showError(msg) {
    $('errorMsg').textContent = msg;
    show('viewError');
  }

  /* ============ 播放控制綁定 ============ */
  function bindPlayControls() {
    $('playBtn').addEventListener('click', function () {
      if (!player || !player.playVideo) return;
      var st = player.getPlayerState();
      if (st === 1) player.pauseVideo();
      else player.playVideo();
    });

    $('prevBtn').addEventListener('click', function () {
      goToSong(currentIndex - 1);
    });

    $('nextBtn').addEventListener('click', function () {
      goToSong(currentIndex + 1);
    });

    $('tapPrompt').addEventListener('click', function () {
      $('tapPrompt').hidden = true;
      if (player && player.playVideo) player.playVideo();
    });

    $('listToggle').addEventListener('click', function () {
      $('playlistDrawer').hidden = !$('playlistDrawer').hidden;
    });

    $('drawerClose').addEventListener('click', function () {
      $('playlistDrawer').hidden = true;
    });

    $('playlistDrawer').addEventListener('click', function (e) {
      if (e.target === $('playlistDrawer')) $('playlistDrawer').hidden = true;
    });
  }

  /* ============ 編輯控制綁定 ============ */
  function bindEditorControls() {
    $('playlistName').addEventListener('input', function (e) {
      state.name = e.target.value;
      saveDraft();
    });

    $('addSongBtn').addEventListener('click', function () {
      state.songs.push(newSong());
      saveDraft();
      renderEditor();
      var cards = $('songEditorList').querySelectorAll('.song-card');
      if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    $('previewBtn').addEventListener('click', function () {
      var valid = state.songs.filter(function (s) { return parseVideoId(s.videoId); });
      if (!valid.length) {
        toast('請先新增至少一首有 YouTube 影片 ID 的歌曲');
        return;
      }
      var code = encodePlaylist(state);
      location.hash = 'preview/' + code;
    });

    $('shareBtn').addEventListener('click', function () {
      var valid = state.songs.filter(function (s) { return parseVideoId(s.videoId); });
      if (!valid.length) {
        toast('請先新增至少一首有 YouTube 影片 ID 的歌曲');
        return;
      }
      var code = encodePlaylist(state);
      var base = location.origin + location.pathname + location.search;
      var url = base + '#play/' + code;
      $('shareUrl').value = url;
      $('shareBox').hidden = false;

      var len = url.length;
      var tip;
      if (len <= 400) tip = '此連結可直接寫入 NTAG215（504 bytes）標籤。';
      else if (len <= 800) tip = '建議使用 NTAG216（888 bytes）標籤，或減少歌曲數量。';
      else tip = '連結較長，建議減少歌曲數量，或改用 NTAG216 標籤。';
      $('shareInfo').textContent = '連結長度：' + len + ' 字元。' + tip;

      $('shareBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    $('copyBtn').addEventListener('click', function () {
      var url = $('shareUrl').value;
      if (!url) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          toast('已複製連結');
        }).catch(function () {
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

  /* ============ 初始化 ============ */
  function init() {
    bindEditorControls();
    bindPlayControls();
    route();
    window.addEventListener('hashchange', route);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();