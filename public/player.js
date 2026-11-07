// YouTube プレーヤーの操作（試作ページで確認したフェード・シーク処理をまとめたもの）
// サーバーからの合図（question / go / stopIntro / hint / reveal）に合わせて呼び出す。

const VOL_DEFAULT = 80, FADE_OUT = 800, FADE_IN = 1000, FADE_CUT = 100;
const HINT_WAIT = 1500; // イントロ→サビの間の待ち
const CHORUS_LEAD = 0.3; // サビは少し前から流す（頭が切れないように）
const PRELOAD_SEC = 8, PRELOAD_MAX = 5000; // 開始の前に、イントロから PRELOAD_SEC 秒先まで読み込んでおく（待つのは最大 PRELOAD_MAX ミリ秒）
const CHORUS_PRELOAD = 4; // サビの先読み：サビの位置から何秒先まで読み込めたら「準備できた」
const SYNC_MAX = 0.8; // 再生位置のずれがこの秒数より大きいときは飛ばし直す（小さいずれで飛ぶと出だしがプツプツ途切れる）
const SYNC_MIN = 0.3, SYNC_RATE = 1.25, SYNC_OK = 0.08, SYNC_CATCH_MS = 6000; // 0.3〜0.8秒のずれは、少し速く（先に進んでいたら少し遅く）流して追いつく。0.08秒以内になったら元の速さへ

export function createPlayer(elementId, { onReadyToPlay, onError, onBuffer } = {}) {
  let yt = null, apiReady = false, pending = [];
  let volume = VOL_DEFAULT, fadeTimer = null, timers = [], waitTimer = null;
  let rate = 1; // 部屋の再生速度（setRate）。追いつくために速さを変えたあとは、この速さへ戻す
  let wantPlay = false; // いま曲が流れているはずか（一時停止からの再開に使う。止めた瞬間の状態だと、読み込み待ち・切り替え中の人だけ再開されず無音になる）

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
        onStateChange: e => onBuffer && onBuffer(e.data === YT.PlayerState.BUFFERING), // 読み込み待ちで止まっている・流れ出した
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
      clear(); this.endCatch?.();
      run(() => {
        // 前の曲が鳴っていたら、ぷつっと切らずに短くフェードアウトしてから次の曲を読み込む
        const playing = yt.getPlayerState() === YT.PlayerState.PLAYING && !yt.isMuted() && yt.getVolume() > 0;
        wantPlay = false;
        if (playing) { fade(yt.getVolume(), 0, 400, () => this.load(videoId, intro)); return; }
        yt.mute();
        yt.loadVideoById({ videoId, startSeconds: intro });
        let notified = false;
        waitTimer = setInterval(() => {
          if (!notified && yt.getPlayerState() === YT.PlayerState.PLAYING) {
            notified = true; clearInterval(waitTimer);
            yt.pauseVideo();
            // 先読み：止めたまま少し先まで読み込めてから「準備できた」（回線が遅い人が、始まってすぐ止まらないように）
            const t0 = Date.now();
            waitTimer = setInterval(() => {
              const end = (yt.getVideoLoadedFraction?.() || 0) * (yt.getDuration?.() || 0);
              if (end >= (intro || 0) + PRELOAD_SEC || Date.now() - t0 > PRELOAD_MAX) { clearInterval(waitTimer); onReadyToPlay && onReadyToPlay(); }
            }, 100);
          }
        }, 50);
      });
    },
    // 全員そろったらイントロを頭から鳴らす。読み込みでもうイントロの位置にいれば飛ばさない（飛ぶと読み込んだ分を捨てて、出だしが途切れる）
    start(intro) {
      clear();
      run(() => { wantPlay = true; if (Math.abs(yt.getCurrentTime() - intro) > 0.5) yt.seekTo(intro, true); yt.unMute(); yt.setVolume(volume); yt.playVideo(); });
    },
    stopIntro(cut = false, then = null) {
      this.endCatch?.(); // cut：隠した歌詞が聞こえないよう、すぐ止める。then：止めたあと（サビの先読み）
      run(() => fade(volume, 0, cut ? FADE_CUT : FADE_OUT, () => { wantPlay = false; yt.pauseVideo(); then && then(); }));
    },
    // サビの先読み：止めたまま音なしでサビの位置へ飛び、少し先まで本当に読み込めたときだけ done（時間では知らせない。待つ上限はサーバーが決める）
    prebuffer(t, done) {
      run(() => {
        clearInterval(waitTimer); wantPlay = false;
        yt.mute(); yt.seekTo(Math.max(0, t), true); yt.pauseVideo();
        const t0 = Date.now();
        waitTimer = setInterval(() => {
          const end = (yt.getVideoLoadedFraction?.() || 0) * (yt.getDuration?.() || 0);
          if (end >= t + CHORUS_PRELOAD && yt.getPlayerState() !== YT.PlayerState.BUFFERING) { clearInterval(waitTimer); done && done(); }
          else if (Date.now() - t0 > 20000) clearInterval(waitTimer); // あきらめる（サーバーは最大 CHORUS_WAIT で先へ進む）
        }, 100);
      });
    },
    // サビへ（ヒント）
    hint(chorus) {
      this.endCatch?.();
      run(() => {
        const go = () => { wantPlay = true; yt.seekTo(Math.max(0, chorus - CHORUS_LEAD), true); yt.unMute(); yt.playVideo(); fade(0, volume, FADE_IN); };
        // イントロが鳴っていたら、フェードアウトして HINT_WAIT ミリ秒待ってからサビへ（いきなり切り替わらないように）
        if (yt.getPlayerState() === YT.PlayerState.PLAYING) fade(volume, 0, FADE_OUT, () => later(go, HINT_WAIT)); else go();
      });
    },
    // 答え合わせ：頭出しせず、流れている映像をそのまま流し続ける（ノンストップ）。
    // イントロで止まっていたらその位置から再開し、終わっていた・まだ読み込みだけの場合はサビ（推定・仮の位置）から
    // jump: まだサビを流していない（イントロのうちに全員が答えた）ときは、サビへ移動する
    // at: この秒から流す（歌詞クイズで問題に出した歌詞のところ）
    reveal(intro, chorus, jump = false, at = null) {
      clear(); this.endCatch?.();
      run(() => {
        const st = yt.getPlayerState();
        yt.unMute(); wantPlay = true;
        if (jump || at != null) {
          const go = () => { yt.seekTo(at != null ? at : Math.max(0, chorus - CHORUS_LEAD), true); yt.playVideo(); fade(0, volume, FADE_IN); };
          if (st === YT.PlayerState.PLAYING) fade(yt.getVolume(), 0, FADE_OUT / 2, go); else go();
          return;
        }
        if (st === YT.PlayerState.PLAYING) { fade(yt.getVolume(), volume, 300); return; }
        if (st !== YT.PlayerState.PAUSED) yt.seekTo(Math.max(0, chorus - CHORUS_LEAD), true);
        yt.playVideo(); fade(0, volume, FADE_IN);
      });
    },
    // もう一度聴く：イントロを introLen 秒だけ流し、終わったら元の位置・状態に戻す
    replay(intro, introLen) {
      run(() => {
        const wasPlaying = wantPlay || yt.getPlayerState() === YT.PlayerState.PLAYING;
        const back = yt.getCurrentTime() + introLen; // 戻るころには元の流れもその分進んでいる
        clearInterval(fadeTimer); wantPlay = true;
        yt.seekTo(intro, true); yt.unMute(); yt.setVolume(volume); yt.playVideo();
        later(() => fade(volume, 0, FADE_OUT, () => {
          if (wasPlaying) { yt.seekTo(back, true); yt.playVideo(); fade(0, volume, FADE_IN); }
          else { wantPlay = false; yt.pauseVideo(); }
        }), introLen * 1000);
      });
    },
    // 再生位置を合わせる：流れ始めたら本来の位置（expected() 秒）と比べ、SYNC_MAX 秒以上ずれていたら飛ばし直す（2回まで）。
    // 最初に測ったずれ（秒・実時間）を onLag に1回だけ渡す（遅れて聞こえ始めた分を、早押しの判定で差し引く）
    sync(expected, onLag, speed = 1) {
      this.endCatch?.();
      let tries = 0, fixes = 0, reported = false, catchAt = 0;
      const base = speed || 1;
      const done = () => { clearInterval(this.syncTimer); this.syncTimer = null; this.endCatch = null; if (catchAt && apiReady && yt.setPlaybackRate) yt.setPlaybackRate(rate); };
      this.endCatch = done;
      this.syncTimer = setInterval(() => {
        if (!catchAt && ++tries > 40) return done();
        if (!apiReady || yt.getPlayerState() !== YT.PlayerState.PLAYING) return;
        const exp = expected();
        if (exp == null) return done();
        const diff = exp - yt.getCurrentTime(); // ＋なら遅れている
        if (!reported) { reported = true; onLag && onLag(diff / base); }
        if (Math.abs(diff) > SYNC_MAX && fixes < 2) { fixes++; if (catchAt) { catchAt = 0; yt.setPlaybackRate?.(rate); } yt.seekTo(exp, true); return; } // 大きいずれは飛ばす
        if (catchAt) { // 追いついている途中
          if (Math.abs(diff) <= SYNC_OK || (diff > 0) !== (catchAt > 0) || Date.now() - Math.abs(catchAt) > SYNC_CATCH_MS) return done();
          return;
        }
        if (Math.abs(diff) > SYNC_MIN && yt.setPlaybackRate) { // 小さいずれ：飛ばさずに速さで合わせる（音が切れない）
          catchAt = diff > 0 ? Date.now() : -Date.now();
          yt.setPlaybackRate(base * (diff > 0 ? SYNC_RATE : 1 / SYNC_RATE));
          return;
        }
        done();
      }, 100);
    },
    stop() { clear(); this.endCatch?.(); clearInterval(this.syncTimer); run(() => { wantPlay = false; yt.stopVideo(); }); },
    // 一時停止（ホストが設定を変えている間）／再開
    pause() { run(() => yt.pauseVideo()); },
    resume() { run(() => { if (wantPlay) yt.playVideo(); }); }, // 止めている間に流れるはずだったなら再開（止めた瞬間に読み込み待ちでも）
    // MVフラッシュ：無音のままその秒へ飛ぶ／映っている（飛び終わって流れている）か／音を出す・消す
    lowQuality(low) { run(() => { if (yt.setPlaybackQuality) yt.setPlaybackQuality(low ? 'small' : 'default'); }); }, // 出題中の低画質（音声は別に届くので、ほぼ変わらない）
    flashQuality(low) { run(() => { if (yt.setPlaybackQuality) yt.setPlaybackQuality(low ? 'small' : 'default'); }); },
    flashSeek(t, low = true) { clear(); this.endCatch?.(); clearInterval(this.syncTimer); run(() => { clearInterval(fadeTimer); wantPlay = true; yt.mute(); if (yt.setPlaybackQuality) yt.setPlaybackQuality(low ? 'small' : 'default'); yt.seekTo(t, true); yt.playVideo(); }); },
    flashReady(t) { return apiReady && yt.getPlayerState() === YT.PlayerState.PLAYING && Math.abs(yt.getCurrentTime() - t) < 1.2; },
    flashSound(on) { run(() => { if (on) { yt.unMute(); yt.setVolume(volume); } else yt.mute(); }); },
    // 3つ埋めバトル：イントロ中に誰かが押したら、サビへ飛ばずにそのまま流し続ける（止まっていたらその位置から再開）
    flow() {
      clear(); this.endCatch?.();
      run(() => { clearInterval(fadeTimer); wantPlay = true; yt.unMute(); if (yt.getPlayerState() !== YT.PlayerState.PLAYING) yt.playVideo(); fade(yt.getVolume(), volume, 400); });
    },
    // 答え合わせの終わりに、サビをフェードアウトする／延長されたら戻す
    fadeOut(ms = 1500) { run(() => fade(yt.getVolume(), 0, ms)); },
    fadeBack() { run(() => fade(yt.getVolume(), volume, 500)); },
    duration() { return apiReady && yt.getDuration ? yt.getDuration() : 0; },
    // 答え合わせで位置を直すとき用：いまの再生位置／その位置から流す（自分の画面だけ）
    time() { return apiReady && yt.getCurrentTime ? yt.getCurrentTime() : 0; },
    playFrom(t) { clear(); run(() => { wantPlay = true; yt.seekTo(t, true); yt.unMute(); yt.setVolume(volume); yt.playVideo(); }); },
    // いま読み込んでいる動画／別の動画をその位置から流す（修正を依頼の試し聴き用。サーバーには知らせない）
    currentId() { return apiReady && yt.getVideoData ? yt.getVideoData()?.video_id || '' : ''; },
    playVideoFrom(videoId, t) { clear(); run(() => { wantPlay = true; yt.loadVideoById({ videoId, startSeconds: t }); yt.unMute(); yt.setVolume(volume); }); },
    setVolume(v) { volume = v; run(() => yt.setVolume(v)); },
    // 再生速度（倍速・スロー）。YouTube は 0.25〜2 倍
    setRate(r) { rate = r || 1; run(() => { if (yt.setPlaybackRate) yt.setPlaybackRate(r || 1); }); },
    // スマホ（特にiPhone）は、タップの処理の中で一度再生しておかないと、後から音が出ないことがある。
    // ボタンのクリック処理から同期的に呼ぶこと。
    // タップの中で音ありにする（iPhone のホーム画面から開いたとき用。音なしの準備だけでは、あとで音を出させてもらえないことがある）
    unlockSound() {
      if (!apiReady) return;
      yt.unMute(); yt.setVolume(volume);
      if (yt.getPlayerState() !== YT.PlayerState.PLAYING && yt.getPlayerState() !== YT.PlayerState.BUFFERING) { yt.playVideo(); setTimeout(() => { try { if (yt.getPlayerState() === YT.PlayerState.PLAYING && !wantPlay) yt.pauseVideo(); } catch (e) { /* なにもしない */ } }, 400); }
    },
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
