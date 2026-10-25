function stopPlayback() {
    clearTimeout(tapTimer);
    destroyPlayer(); // 離開播放頁時直接銷毀播放器，停止所有背景音樂
    document.body.classList.remove('playing');
    if ($('tapPrompt')) $('tapPrompt').hidden = true;
    stopProgress();
    setBar(0);
    if ($('cur')) $('cur').textContent = '0:00';
    if ($('dur')) $('dur').textContent = '0:00';
  }

  function initYTPlayer() {
    if (isPlayHidden()) return; // 若已經不在播放頁面則不執行
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
