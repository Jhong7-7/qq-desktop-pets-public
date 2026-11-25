/**
 * 友利奈绪 · Q版 v0.2 — Coopanion figure API 2
 *
 * v0.2 的原则：保留 Seedream 原脸，不抹脸、不画眼嘴。
 * 身体就是一张整身贴图（tex/body.png）；走路/坐下由 kit 移动整组，
 * 这里只做一点坐下下沉。眼嘴动画暂停。
 */

const SVGNS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

const BOX = { x: 49.6, y: 0, w: 156.8, h: 256 };

export async function createNaoBody(base, opts) {
  const { kit, host, asset } = opts;
  let mounted = null;
  let img = null;

  function mount(petG) {
    petG.textContent = '';
    img = document.createElementNS(SVGNS, 'image');
    img.setAttribute('href', String(asset('tex/body.png')));
    img.setAttributeNS(XLINK, 'xlink:href', String(asset('tex/body.png')));
    img.setAttribute('x', BOX.x);
    img.setAttribute('y', BOX.y);
    img.setAttribute('width', BOX.w);
    img.setAttribute('height', BOX.h);
    petG.appendChild(img);
    mounted = petG;
  }

  const figure = {
    extent: [0, 0, 256, 256],
    hits: [[128, 150, 112]],
    anchors: {
      gaze: [128, 80],
      tear: [96, 92],
      tears: [[96, 92], [138, 92]],
      z: [196, 34],
      hearts: [96, 176, 56],
      bubble: [128, 18],
    },
    colors: { z: '#C7575B' },
    setScheme() { return Promise.resolve(); },
    draw(petG, fc, frame) {
      if (mounted !== petG) mount(petG);
      // 坐下时整张图下沉一点；不画面部，表情保持原脸
      const low = Math.max(0, Number(frame.low) || 0);
      const y = BOX.y + low * 0.4;
      if (img.getAttribute('y') !== String(y)) img.setAttribute('y', y);
    },
    dispose() {
      mounted = null;
      img = null;
    },
  };

  return kit.createBody(host, { figure });
}
