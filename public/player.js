// YouTube プレーヤーの操作（試作ページで確認したフェード・シーク処理をまとめたもの）
// サーバーからの合図（question / go / stopIntro / hint / reveal）に合わせて呼び出す。

const VOL_DEFAULT = 80, FADE_OUT = 800, FADE_IN = 1000;

export function createPlayer(elementId, { onReadyToPlay, onError } = {}) {
  let yt = null, apiReady = false, pending = [];
  let volume = VOL_DEFAULT, fadeTimer = null, timers = [], waitTimer = null;

  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
  window.onYouTubeIframeAPIReady = () => {
    yt = new YT.Player(elementId, {
      width: 320, height: 180,
      playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, fs: 0, modestbranding: 1, origin: location.origin },
      events: {
        onReady: () => { apiReady = true; const list = pending; pending = []; list.forEach(fn => fn()); },
        onError: e => onError && onError(e.data),
      },
    });
  };

  const run = fn => { if (apiReady) fn(); else pending.push(fn); };
  const clear = () => { timers.forEach(clearTimeout); timers = []; clearInterval(fadeTimer); clearInterval(waitTimer); };
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));

  function fade(from, to, ms, done) {
    clearInterval(fadeTimer);
    const steps = Math.max(1, Math.round(ms / 50)); let i = 0;
    yt.setVolume(from);
    fadeTimer = setInterval(() => {
      i++; yt.setVolume(from + (to - from) * i / steps);
      if (i >= steps) { clearInterval(fadeTimer); done && done(); }
    }, 50);
  }

  return {
    // 無音で読み込み、再生できる状態になったらサーバーに知らせる
    load(videoId, intro) {
      clear();
      run(() => {
        // 前の曲が鳴っていたら、ぷつっと切らずに短くフェードアウトしてから次の曲を読み込む
        const playing = yt.getPlayerState() === YT.PlayerState.PLAYING && !yt.isMuted() && yt.getVolume() > 0;
        if (playing) { fade(yt.getVolume(), 0, 400, () => this.load(videoId, intro)); return; }
        yt.mute();
        yt.loadVideoById({ videoId, startSeconds: intro });
        let notified = false;
        waitTimer = setInterval(() => {
          if (!notified && yt.getPlayerState() === YT.PlayerState.PLAYING) {
            notified = true; clearInterval(waitTimer);
            yt.pauseVideo();
            onReadyToPlay && onReadyToPlay();
          }
        }, 50);
      });
    },
    // 全員そろったらイントロを頭から鳴らす
    start(intro) {
      clear();
      run(() => { yt.seekTo(intro, true); yt.unMute(); yt.setVolume(volume); yt.playVideo(); });
    },
    stopIntro() {
      run(() => fade(volume, 0, FADE_OUT, () => yt.pauseVideo()));
    },
    // サビへ（ヒント）
    hint(chorus) {
      run(() => {
        const go = () => { yt.seekTo(chorus, true); yt.unMute(); yt.playVideo(); fade(0, volume, FADE_IN); };
        if (yt.getPlayerState() === YT.PlayerState.PLAYING) fade(volume, 0, FADE_OUT, go); else go();
      });
    },
    // 答え合わせ：頭出しせず、流れている映像をそのまま流し続ける（ノンストップ）。
    // イントロで止まっていたらその位置から再開し、終わっていた・まだ読み込みだけの場合はサビ（推定・仮の位置）から
    reveal(intro, chorus) {
      clear();
      run(() => {
        const st = yt.getPlayerState();
        yt.unMute();
        if (st === YT.PlayerState.PLAYING) { fade(yt.getVolume(), volume, 300); return; }
        if (st !== YT.PlayerState.PAUSED) yt.seekTo(chorus, true);
        yt.playVideo(); fade(0, volume, FADE_IN);
      });
    },
    // もう一度聴く：イントロを introLen 秒だけ流し、終わったら元の位置・状態に戻す
    replay(intro, introLen) {
      run(() => {
        const wasPlaying = yt.getPlayerState() === YT.PlayerState.PLAYING;
        const back = yt.getCurrentTime() + introLen; // 戻るころには元の流れもその分進んでいる
        clearInterval(fadeTimer);
        yt.seekTo(intro, true); yt.unMute(); yt.setVolume(volume); yt.playVideo();
        later(() => fade(volume, 0, FADE_OUT, () => {
          if (wasPlaying) { yt.seekTo(back, true); yt.playVideo(); fade(0, volume, FADE_IN); }
          else yt.pauseVideo();
        }), introLen * 1000);
      });
    },
    stop() { clear(); run(() => yt.stopVideo()); },
    // 一時停止（ホストが設定を変えている間）／再開
    pause() { run(() => { this.wasPlaying = yt.getPlayerState() === YT.PlayerState.PLAYING; yt.pauseVideo(); }); },
    resume() { run(() => { if (this.wasPlaying) yt.playVideo(); }); },
    // 答え合わせの終わりに、サビをフェードアウトする／延長されたら戻す
    fadeOut(ms = 1500) { run(() => fade(yt.getVolume(), 0, ms)); },
    fadeBack() { run(() => fade(yt.getVolume(), volume, 500)); },
    duration() { return apiReady && yt.getDuration ? yt.getDuration() : 0; },
    setVolume(v) { volume = v; run(() => yt.setVolume(v)); },
    // スマホ（特にiPhone）は、タップの処理の中で一度再生しておかないと、後から音が出ないことがある。
    // ボタンのクリック処理から同期的に呼ぶこと。
    prime(videoId) {
      if (!apiReady) return; // API がまだなら、出題時のタップ（回答ボタン）で鳴ることに期待する
      clear();
      yt.mute();
      yt.loadVideoById({ videoId, startSeconds: 0 });
      yt.playVideo();
      waitTimer = setInterval(() => {
        if (yt.getPlayerState() === YT.PlayerState.PLAYING) { clearInterval(waitTimer); yt.stopVideo(); }
      }, 50);
    },
  };
}
