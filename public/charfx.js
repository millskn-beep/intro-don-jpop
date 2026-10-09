// キャラクターの演出（自分の画面だけ）
// ・常駐：画面の左下にキャラが立っていて、場面ごとに絵（ポーズ）と吹き出しのセリフが変わる
//   出題中・答え合わせ中は、2人組のキャラ（双子）を左右に分けて立たせる（characters.js の split）
// ・カットイン：最終問題・連続正解・全問正解・優勝で、キャラが画面を横切る
// ・カウントダウン：ゲームの最初の問題の「3・2・1・START!」
// キャラを消す設定（body.mascot-off）では、絵と吹き出しは出さない（カウントダウンの数字だけ出す）

export function initCharFx({ $, mascotUrl, assetUrl, charDef, getVars }) {
  const main = document.querySelector('main');
  const makeDock = side => {
    const d = document.createElement('div');
    d.className = `char-dock ${side}`;
    d.innerHTML = '<div class="char-bubble" hidden></div><img class="char-img" alt="">';
    main.appendChild(d);
    return { el: d, img: d.querySelector('.char-img'), bubble: d.querySelector('.char-bubble'), cur: null };
  };
  const left = makeDock('left'), right = makeDock('right');
  // カットイン・カウントダウン
  const cut = document.createElement('div');
  cut.className = 'cutin'; cut.hidden = true;
  cut.innerHTML = '<div class="cutin-band"></div><img class="cutin-art" alt=""><div class="cutin-text"><b></b><small></small></div>';
  document.body.appendChild(cut);
  const count = document.createElement('div');
  count.className = 'countdown'; count.hidden = true;
  document.body.appendChild(count);

  // 左右に分けるか：2人組のキャラで、出題中か答え合わせ中（パソコン）
  const wide = matchMedia('(min-width: 900px)');
  const split = () => {
    const b = document.body.classList;
    // game-started：ゲームの1問目の曲が流れ始めてから終わるまで。問題の間の「読み込み中」も左右のままにする
    // （読み込み中だけ真ん中に戻すと、真ん中の画面の幅が変わって、自分の配置の画面が拡大・縮小してしまう）
    return !!charDef().split && wide.matches && !b.contains('mascot-off') && (b.contains('playing') || b.contains('revealing') || b.contains('game-started'));
  };
  let lastPose = 'idle';
  const setImg = (d, url) => {
    if (d.cur === url) return;
    d.cur = url; d.img.src = url;
    d.img.classList.remove('hop'); void d.img.offsetWidth; d.img.classList.add('hop');
  };
  function pose(p) {
    lastPose = p;
    const s = charDef().split;
    if (split()) {
      setImg(left, assetUrl(s.left[p] || s.left.listen));
      setImg(right, assetUrl(s.right[p] || s.right.listen));
    } else setImg(left, mascotUrl(p));
  }
  // 場面が切り替わったら（出題⇔待機）、左右の分け方を付け直す
  new MutationObserver(() => {
    const on = split();
    if (on !== document.body.classList.contains('char-split')) {
      document.body.classList.toggle('char-split', on);
      left.cur = right.cur = null; pose(lastPose);
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  const pick = a => a[Math.floor(Math.random() * a.length)];
  const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? '');
  // セリフ：場面のセリフからランダムに選ぶ。{…} は名前や数字に置きかえる。
  // 左右に分けているときは、2人が同時に別々のセリフをしゃべる
  const show = (d, text) => {
    d.bubble.textContent = text;
    d.bubble.hidden = false;
    d.bubble.classList.remove('pop'); void d.bubble.offsetWidth; d.bubble.classList.add('pop');
  };
  function say(scene, vars = {}) {
    const lines = charDef().lines[scene];
    if (!lines?.length) return;
    const v = { ...getVars(), ...vars };
    // 埋める値が足りないセリフは使わない
    const ok = lines.filter(l => [...l.matchAll(/\{(\w+)\}/g)].every(m => v[m[1]] !== undefined && v[m[1]] !== ''));
    if (!ok.length) return;
    const first = pick(ok);
    show(left, fill(first, v));
    if (split()) {
      const rest = ok.filter(l => l !== first);
      show(right, fill(rest.length ? pick(rest) : first, v));
    } else right.bubble.hidden = true;
    clearTimeout(say.t); say.t = setTimeout(() => { left.bubble.hidden = true; right.bubble.hidden = true; }, 3200);
  }
  // カットイン：帯が走って、キャラの決めポーズと大きな文字が横切る
  function cutin(title, sub = '', art = 'cutin') {
    cut.querySelector('.cutin-art').src = mascotUrl(art);
    cut.querySelector('.cutin-text b').textContent = title;
    cut.querySelector('.cutin-text small').textContent = sub;
    cut.classList.remove('show'); cut.hidden = false; void cut.offsetWidth; cut.classList.add('show');
    clearTimeout(cutin.t); cutin.t = setTimeout(() => { cut.hidden = true; }, 2100);
  }
  // 3・2・1・START!（最後の START! はカットインで）
  function countdown(sec) {
    clearInterval(countdown.t);
    let n = sec;
    const tick = () => {
      if (n <= 0) { clearInterval(countdown.t); count.hidden = true; cutin('START!', '', 'cutin'); say('start'); return; }
      count.textContent = n;
      count.classList.remove('show'); count.hidden = false; void count.offsetWidth; count.classList.add('show');
      n--;
    };
    tick();
    countdown.t = setInterval(tick, 1000);
  }
  // キャラを変えたとき：いまの場面の絵を描き直す
  function refresh() { left.cur = right.cur = null; left.bubble.hidden = right.bubble.hidden = true; pose(lastPose); }
  return { pose, say, cutin, countdown, refresh };
}
