/**
 * Decorative SVG strips in the pleurat line-art style: thin 1px ink strokes,
 * geometric shapes, one accent color, aria-hidden (decoration only).
 * Modeled after pleurat's .sv-street-view / .sv-board-view horizon strips.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

/**
 * Pause a decorative strip's animations whenever it is scrolled off-screen or
 * the tab is hidden. Purely a resource optimisation — the visuals are identical
 * while on-screen; nothing animates against an audience that cannot see it.
 */
function useDecorPause() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let onScreen = true;
    const apply = () => {
      el.classList.toggle('is-paused', !onScreen || document.hidden);
    };
    const io = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? true;
        apply();
      },
      { rootMargin: '160px' },
    );
    io.observe(el);
    document.addEventListener('visibilitychange', apply);
    apply();
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', apply);
    };
  }, []);
  return ref;
}

/*
 * Skyline scene (Login + Overview), pleurat street-view style: hills, a dense
 * far city, a street of offices, towers, flats, shops, houses, a mosque and
 * RS PKU, with trees, lamps, benches and bikes in front.
 *
 * Geometry is generated once at module load from a fixed seed, so it is the
 * same on every render and every PC. Everything static lives in ONE SVG that
 * paints once; everything that moves (clouds, birds, stars, balloon,
 * vehicles, walkers) is its own small root SVG on a stage scaled to the same
 * fit, so its travel is a compositor-only transform. Nothing sits above y=0,
 * so no roof is ever clipped. Day (light) and night (dark) differ through CSS
 * tokens only — no second scene, no runtime cost on theme switch.
 */
const SV_W = 3200;
const SV_H = 176;
const SV_G = 144; // ground / road line
const SV_DASH = 160;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n1 = (v: number) => Math.round(v * 10) / 10;
const box = (x: number, y: number, w: number, h: number) => `M${n1(x)} ${n1(y)}h${n1(w)}v${n1(h)}h${n1(-w)}z`;

/** A centred grid of window rects as two paths: unlit and lit (lit = night glow / day reflection). */
function windowGrid(r: () => number, x: number, y: number, w: number, h: number, ww: number, wh: number, gx: number, gy: number, litRate: number) {
  const cols = Math.max(1, Math.floor((w + gx) / (ww + gx)));
  const rows = Math.max(1, Math.floor((h + gy) / (wh + gy)));
  const ox = x + (w - (cols * ww + (cols - 1) * gx)) / 2;
  let win = '';
  let lit = '';
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const d = box(ox + col * (ww + gx), y + row * (wh + gy), ww, wh);
      if (r() < litRate) lit += d; else win += d;
    }
  }
  return { win, lit };
}

type Kind = 'office' | 'tower' | 'flats' | 'shop' | 'house';
const KIND_WEIGHTS: ReadonlyArray<[Kind, number]> = [['office', 3], ['tower', 2], ['flats', 2], ['shop', 2], ['house', 2]];

function pickKind(r: () => number): Kind {
  const total = KIND_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  let roll = r() * total;
  for (const [kind, w] of KIND_WEIGHTS) { roll -= w; if (roll < 0) return kind; }
  return 'office';
}

function building(r: () => number, kind: Kind, x: number, key: string): { el: JSX.Element; w: number } {
  const tint = r() < 0.22 ? ' tint-a' : r() < 0.2 ? ' tint-b' : '';
  const G = SV_G;
  switch (kind) {
    case 'office': {
      const w = 58 + Math.round(r() * 40);
      const h = 64 + Math.round(r() * 40);
      const g = windowGrid(r, x + 6, G - h + 12, w - 12, h - 34, 9, 6, 6, 7, 0.28);
      return { w, el: (
        <g key={key} className="bldg">
          <path className={`face${tint}`} d={box(x, G - h, w, h)} />
          <path className="roof" d={box(x - 3, G - h - 4, w + 6, 4)} />
          {r() < 0.5 ? <path className="roof" d={box(x + w * 0.62, G - h - 11, 10, 7)} /> : null}
          <path className="win" d={g.win} /><path className="win-lit" d={g.lit} />
          <path className="door" d={box(x + w / 2 - 7, G - 18, 14, 18)} />
        </g>
      ) };
    }
    case 'tower': {
      const w = 40 + Math.round(r() * 18);
      const h = 82 + Math.round(r() * 16);
      const g = windowGrid(r, x + 6, G - h + 10, w - 12, h - 30, 7, 6, 5, 6, 0.24);
      return { w, el: (
        <g key={key} className="bldg">
          <path className={`face${tint}`} d={box(x, G - h, w, h)} />
          <path className="roof" d={`M${x - 3} ${G - h}L${x + w / 2} ${G - h - 12}L${x + w + 3} ${G - h}z`} />
          <path className="mast" d={`M${x + w / 2} ${G - h - 12}v-7`} />
          <path className="win" d={g.win} /><path className="win-lit" d={g.lit} />
          <path className="door" d={box(x + w / 2 - 6, G - 16, 12, 16)} />
        </g>
      ) };
    }
    case 'flats': {
      const w = 70 + Math.round(r() * 30);
      const h = 54 + Math.round(r() * 30);
      const floors = Math.floor((h - 14) / 12);
      let rails = '';
      for (let i = 1; i <= floors; i++) rails += `M${x + 4} ${G - i * 12}h${w - 8}`;
      const g = windowGrid(r, x + 8, G - floors * 12 + 3, w - 16, floors * 12 - 6, 8, 5, 8, 7, 0.3);
      return { w, el: (
        <g key={key} className="bldg">
          <path className={`face${tint}`} d={box(x, G - h, w, h)} />
          <path className="roof" d={box(x - 2, G - h - 3, w + 4, 3)} />
          <path className="roof" d={`${box(x + 10, G - h - 12, 12, 9)}M${x + 12} ${G - h - 3}v-1M${x + 20} ${G - h - 3}v-1`} />
          <path className="rail" d={rails} />
          <path className="win" d={g.win} /><path className="win-lit" d={g.lit} />
        </g>
      ) };
    }
    case 'shop': {
      const w = 56 + Math.round(r() * 26);
      const h = 34 + Math.round(r() * 12);
      const scallops = Math.max(3, Math.round((w - 4) / 10));
      const sw = (w + 4) / scallops;
      let awning = `M${x - 2} ${G - h + 10}h${w + 4}v6`;
      for (let i = 0; i < scallops; i++) awning += `a${n1(sw / 2)} ${n1(sw / 2.6)} 0 0 1 ${n1(-sw)} 0`;
      awning += 'z';
      return { w, el: (
        <g key={key} className="bldg">
          <path className={`face${tint}`} d={box(x, G - h, w, h)} />
          <path className="roof" d={box(x - 2, G - h - 3, w + 4, 3)} />
          <path className="sign" d={box(x + 8, G - h + 3, w - 16, 5)} />
          <path className="awning" d={awning} />
          <path className="win-lit" d={box(x + 6, G - h + 22, w * 0.5 - 8, h - 26)} />
          <path className="door" d={box(x + w * 0.62, G - h + 22, 12, h - 22)} />
        </g>
      ) };
    }
    case 'house': {
      const w = 40 + Math.round(r() * 16);
      const h = 24 + Math.round(r() * 8);
      return { w, el: (
        <g key={key} className="bldg">
          <path className={`face home${tint}`} d={box(x, G - h, w, h)} />
          <path className="roof" d={`M${x - 4} ${G - h}L${x + w / 2} ${G - h - 14}L${x + w + 4} ${G - h}z`} />
          <path className="roof" d={box(x + w * 0.7, G - h - 13, 5, 8)} />
          <path className={r() < 0.5 ? 'win-lit' : 'win'} d={box(x + 6, G - h + 7, 10, 8)} />
          <path className="door" d={box(x + w - 18, G - 15, 10, 15)} />
        </g>
      ) };
    }
  }
}

function mosque(x: number): JSX.Element {
  const G = SV_G;
  return (
    <g key="mosque" className="bldg mosque">
      <path className="face tint-a" d={box(x, G - 40, 76, 40)} />
      <path className="dome" d={`M${x + 14} ${G - 40}a24 22 0 0 1 48 0z`} />
      <path className="mast" d={`M${x + 38} ${G - 62}v-8`} />
      <path className="crescent" d={`M${x + 41} ${G - 76}a4 4 0 1 1 -3 -4a3.2 3.2 0 1 0 3 4z`} />
      <path className="win" d={`M${x + 12} ${G - 12}v-10a5 5 0 0 1 10 0v10zM${x + 54} ${G - 12}v-10a5 5 0 0 1 10 0v10z`} />
      <path className="door" d={`M${x + 31} ${G}v-16a7 7 0 0 1 14 0v16z`} />
      {/* minaret */}
      <path className="face" d={box(x + 86, G - 92, 12, 92)} />
      <path className="roof" d={`${box(x + 83, G - 66, 18, 3)}${box(x + 84, G - 96, 16, 4)}`} />
      <path className="dome" d={`M${x + 86} ${G - 96}a6 7 0 0 1 12 0z`} />
      <path className="win" d={`${box(x + 90, G - 84, 4, 9)}${box(x + 90, G - 54, 4, 9)}${box(x + 90, G - 34, 4, 9)}`} />
    </g>
  );
}

function hospitalPku(x: number): JSX.Element {
  const G = SV_G;
  const g = windowGrid(mulberry32(7), x + 10, G - 92, 152, 26, 12, 7, 8, 8, 0.4);
  return (
    <g key="pku" className="bldg hospital-pku">
      <path className="face" d={box(x, G - 104, 172, 104)} />
      <path className="roof" d={box(x - 4, G - 110, 180, 6)} />
      <path className="face tint-b" d={box(x + 62, G - 120, 48, 16)} />
      <path className="cross-red" d={`M${x + 86} ${G - 64}v20M${x + 76} ${G - 54}h20`} />
      <text className="pku-text" x={x + 86} y={G - 22} textAnchor="middle">RS PKU</text>
      <path className="win" d={g.win} /><path className="win-lit" d={g.lit} />
      <path className="door" d={box(x + 76, G - 14, 20, 14)} />
      <path className="awning" d={`M${x + 68} ${G - 18}h36l-4 5h-28z`} />
    </g>
  );
}

function tree(r: () => number, x: number, key: string, scale = 1): JSX.Element {
  const G = SV_G;
  const s = scale;
  const kind = r();
  if (kind < 0.42) {
    return <g key={key} className="tree-g"><path className="tree" d={`M${x} ${G}v${-14 * s}`} /><circle className="leaf" cx={x} cy={G - 23 * s} r={10 * s} /></g>;
  }
  if (kind < 0.66) {
    return <g key={key} className="tree-g"><path className="tree" d={`M${x} ${G}v${-12 * s}`} /><ellipse className="leaf" cx={x} cy={G - 27 * s} rx={7.5 * s} ry={15 * s} /></g>;
  }
  if (kind < 0.84) {
    return (
      <g key={key} className="tree-g">
        <path className="tree" d={`M${x} ${G}v${-8 * s}`} />
        <path className="leaf" d={`M${x} ${G - 40 * s}l${9 * s} ${14 * s}h${-4 * s}l${7 * s} ${11 * s}h${-5 * s}l${7 * s} ${9 * s}h${-28 * s}l${7 * s} ${-9 * s}h${-5 * s}l${7 * s} ${-11 * s}h${-4 * s}z`} />
      </g>
    );
  }
  // coconut palm
  const top = G - 38 * s;
  const tx = x + 4 * s;
  return (
    <g key={key} className="tree-g">
      <path className="tree" d={`M${x} ${G}q${-2 * s} ${-20 * s} ${4 * s} ${-38 * s}`} />
      <path className="leaf palm" d={`M${tx} ${top}q${-9 * s} ${-5 * s} ${-16 * s} ${3 * s}M${tx} ${top}q${9 * s} ${-6 * s} ${17 * s} ${2 * s}M${tx} ${top}q${-4 * s} ${-9 * s} ${-12 * s} ${-9 * s}M${tx} ${top}q${5 * s} ${-9 * s} ${13 * s} ${-8 * s}M${tx} ${top}q${-7 * s} ${2 * s} ${-10 * s} ${10 * s}M${tx} ${top}q${7 * s} ${1 * s} ${11 * s} ${9 * s}`} />
    </g>
  );
}

function prop(r: () => number, x: number, key: string): JSX.Element {
  const G = SV_G;
  const roll = r();
  if (roll < 0.22) {
    return (
      <g key={key} className="lamp">
        <path className="pole" d={`M${x} ${G}V${G - 46}q0 -7 9 -7`} />
        <circle className="bulb" cx={x + 10} cy={G - 53} r="3" />
        <path className="cone" d={`M${x + 6} ${G - 50}h8l13 ${50}h-34z`} />
        <ellipse className="pool" cx={x + 10} cy={G} rx="17" ry="2.6" />
      </g>
    );
  }
  if (roll < 0.36) return <path key={key} className="prop" d={`M${x - 12} ${G}v-6M${x + 12} ${G}v-6M${x - 15} ${G - 6}h30M${x - 15} ${G - 11}h30`} />;
  if (roll < 0.5) {
    return (
      <g key={key} className="prop bike">
        <circle cx={x - 7} cy={G - 4.5} r="4.5" /><circle cx={x + 7} cy={G - 4.5} r="4.5" />
        <path d={`M${x - 7} ${G - 4.5}l4 -7h7l3 7M${x - 3} ${G - 11.5}l-1 -2h3M${x + 4} ${G - 11.5}l1 -3h3`} />
      </g>
    );
  }
  if (roll < 0.62) return <path key={key} className="prop" d={`M${x - 5} ${G - 12}h10l-1.5 12h-7zM${x - 6.5} ${G - 12}h13`} />;
  if (roll < 0.74) {
    return (
      <g key={key} className="prop">
        <path d={`M${x - 6} ${G - 9}h12l-2 9h-8z`} />
        <path className="leaf" d={`M${x} ${G - 9}q-7 -4 -6 -11q5 2 6 9q1 -9 6 -10q2 7 -6 12`} />
      </g>
    );
  }
  if (roll < 0.86) {
    return (
      <g key={key} className="traffic">
        <path className="pole" d={`M${x} ${G}V${G - 40}`} />
        <rect className="tl-box" x={x - 4.5} y={G - 58} width="9" height="19" rx="2.5" />
        <circle className="tl-r" cx={x} cy={G - 53} r="2" />
        <circle className="tl-a" cx={x} cy={G - 48.4} r="2" />
        <circle className="tl-g" cx={x} cy={G - 43.8} r="2" />
      </g>
    );
  }
  return <path key={key} className="bush" d={`M${x - 13} ${G}a7 7 0 0 1 8 -8a8 8 0 0 1 14 1a6 6 0 0 1 5 7z`} />;
}

function buildScene() {
  const r = mulberry32(20261020);
  const G = SV_G;

  // Hills: a far ridge and a nearer roll, smooth quadratic chains.
  const ridge = (base: number, amp: number, step: number) => {
    const pts: Array<[number, number]> = [];
    for (let x = 0; x <= SV_W + step * 2; x += step) pts.push([x, n1(base - r() * amp)]);
    // Through the midpoints, each point a control: a smooth roll with no overshoot.
    let d = `M0 ${G}V${pts[0]![1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x, y] = pts[i]!;
      const [nx, ny] = pts[i + 1]!;
      d += `Q${x} ${y} ${n1((x + nx) / 2)} ${n1((y + ny) / 2)}`;
    }
    return `${d}V${G}z`;
  };
  const hills = [ridge(G - 54, 34, 210), ridge(G - 26, 22, 150)];

  // Far city: tight faint blocks.
  const far: JSX.Element[] = [];
  for (let x = -6; x < SV_W;) {
    const w = 26 + r() * 36;
    const h = 40 + r() * 52;
    far.push(<path key={`f${far.length}`} d={box(x, G - h, w, h)} />);
    x += w + 3 + r() * 10;
  }

  // Street: buildings packed with small gaps; landmarks at fixed spots so RS PKU stays near the centre.
  const landmarks: Array<{ at: number; w: number; el: (x: number) => JSX.Element }> = [
    { at: 1170, w: 104, el: mosque },
    { at: 1514, w: 172, el: hospitalPku },
  ];
  const mid: JSX.Element[] = [];
  const front: JSX.Element[] = [];
  for (let x = 10; x < SV_W - 30;) {
    const landmark = landmarks.find((l) => x + 110 > l.at && x < l.at + l.w);
    if (landmark) {
      if (x < landmark.at) front.push(tree(r, (x + landmark.at) / 2, `lt${x}`, 0.9));
      mid.push(landmark.el(landmark.at));
      x = landmark.at + landmark.w + 14;
      continue;
    }
    const kind = pickKind(r);
    const b = building(r, kind, x, `b${mid.length}`);
    mid.push(b.el);
    const gap = 8 + Math.round(r() * 26);
    if (gap >= 18) front.push(r() < 0.55 ? tree(r, x + b.w + gap / 2, `t${x}`, 0.8 + r() * 0.35) : prop(r, x + b.w + gap / 2, `p${x}`));
    x += b.w + gap;
  }
  // A second, sparser row on the pavement in front of the facades.
  // Keeps the RS PKU sign and the mosque door clear.
  const clear = landmarks.map((l) => [l.at + 18, l.at + l.w - 18] as const);
  for (let x = 40 + r() * 60; x < SV_W - 20; x += 70 + r() * 90) {
    if (clear.some(([from, to]) => x > from && x < to)) continue;
    front.push(r() < 0.5 ? tree(r, x, `ft${Math.round(x)}`, 0.85 + r() * 0.4) : prop(r, x, `fp${Math.round(x)}`));
  }

  let dashes = '';
  for (let x = 0; x < SV_W; x += 120) dashes += `M${x} ${SV_DASH}h44`;
  return { hills, far, mid, front, dashes };
}

const SCENE = buildScene();

/** Stars: two sprites that cross-fade (opacity on the sprite = composited). */
const STARS: ReadonlyArray<ReadonlyArray<[number, number, number]>> = (() => {
  const r = mulberry32(99);
  const sets: Array<Array<[number, number, number]>> = [[], []];
  for (let i = 0; i < 70; i++) sets[i % 2]!.push([Math.round(r() * SV_W), Math.round(6 + r() * 60), r() < 0.2 ? 1.4 : 0.9]);
  return sets;
})();

/** Skyline strip: hills, a dense street and its life; see the scene notes above. */
export function SkylineStrip({ className = '' }: { className?: string }) {
  const ref = useDecorPause();
  return (
    <div ref={ref} className={`decor-strip skyline ${className}`} aria-hidden="true">
      <svg className="skyline-static" viewBox={`0 0 ${SV_W} ${SV_H}`} preserveAspectRatio="xMidYMax slice">
        <g className="sky">
          <circle className="sun-halo" cx="1960" cy="26" r="20" />
          <circle className="sun" cx="1960" cy="26" r="10" />
          <path className="moon" d="M1966 14a12 12 0 1 0 6 20a9.6 9.6 0 1 1 -6 -20z" />
        </g>
        <g className="hills">
          <path className="hill-far" d={SCENE.hills[0]} />
          <path className="hill-near" d={SCENE.hills[1]} />
        </g>
        <g className="far">{SCENE.far}</g>
        <g className="mid">{SCENE.mid}</g>
        <g className="front">{SCENE.front}</g>
        <path className="road" d={`M0 ${SV_G}H${SV_W}`} />
        <path className="kerb" d={`M0 ${SV_G + 4}H${SV_W}`} />
        <g className="dashes"><path d={SCENE.dashes} /></g>
      </svg>
      <SkylineSprites />
    </div>
  );
}

/** A sprite: its own small root <svg> so its motion is a composited transform. */
function Sprite({ className, box: [x, y, w, h], style, children }: { className: string; box: [number, number, number, number]; style?: CSSProperties; children: ReactNode }) {
  return (
    <svg className={`sprite ${className}`} viewBox={`${x} ${y} ${w} ${h}`} style={{ left: x, top: y, width: w, height: h, ...style }}>
      {children}
    </svg>
  );
}

/** Travels from just off the left edge to just off the right edge of the scene. */
const travel = (x: number, w: number, seconds: number, phase: number): CSSProperties => ({
  '--from': `${-(x + w + 40)}px`, '--to': `${SV_W - x + 40}px`,
  animationDuration: `${seconds}s`, animationDelay: `${-seconds * phase}s`,
} as CSSProperties);

function Walker() {
  return (
    <g className="walker">
      <circle className="w-dot" cx="0" cy="-18" r="2.4" />
      <rect className="w-torso" x="-0.7" y="-15.5" width="1.4" height="10" rx="0.7" />
      <rect className="w-arm" x="-0.6" y="-14" width="1.2" height="8" rx="0.6" />
      <rect className="w-leg-a" x="-0.7" y="-6" width="1.4" height="10" rx="0.7" />
      <rect className="w-leg-b" x="-0.7" y="-6" width="1.4" height="10" rx="0.7" />
    </g>
  );
}

const CLOUD = 'a9 9 0 0 1 9 -9a13 13 0 0 1 24 -4a10 10 0 0 1 17 6a7 7 0 0 1 4 7z';
const CLOUDS: ReadonlyArray<{ x: number; y: number; s: number; t: number; p: number }> = [
  { x: 200, y: 14, s: 1.25, t: 150, p: 0.1 },
  { x: 900, y: 34, s: 0.85, t: 120, p: 0.55 },
  { x: 1600, y: 8, s: 1.5, t: 180, p: 0.3 },
  { x: 2300, y: 26, s: 1, t: 135, p: 0.8 },
  { x: 2900, y: 46, s: 0.7, t: 110, p: 0.42 },
];

/**
 * The moving parts. As separate root SVGs on a stage that reproduces the
 * strip's `xMidYMax slice` scaling, their travel is a GPU-composited
 * transform and the big strip never repaints for them.
 */
function SkylineSprites() {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stage.current;
    const strip = el?.parentElement;
    if (!el || !strip) return;
    const fit = () => el.style.setProperty('--s', String(Math.max(strip.clientWidth / SV_W, strip.clientHeight / SV_H)));
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(strip);
    return () => ro.disconnect();
  }, []);
  const G = SV_G;
  return (
    <div ref={stage} className="skyline-sprites">
      {STARS.map((set, i) => (
        <Sprite key={`stars${i}`} className={`stars stars-${i}`} box={[0, 0, SV_W, 70]}>
          {set.map(([cx, cy, rr]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={rr} />)}
        </Sprite>
      ))}
      {CLOUDS.map((c, i) => (
        <Sprite key={`cloud${i}`} className="cloud" box={[c.x, c.y, 64 * c.s, 24 * c.s]} style={travel(c.x, 64 * c.s, c.t, c.p)}>
          <path transform={`translate(${c.x} ${c.y}) scale(${c.s})`} d={`M4 22${CLOUD}`} />
        </Sprite>
      ))}
      <Sprite className="birds" box={[400, 20, 40, 16]} style={travel(400, 40, 46, 0.25)}>
        <path d="M402 30q4 -4 8 0q4 -4 8 0M420 24q3 -3 6 0q3 -3 6 0M428 34q3 -3 6 0q3 -3 6 0" />
      </Sprite>
      <Sprite className="balloon" box={[2240, 24, 30, 41]}>
        <circle cx="2255" cy="39" r="13" />
        <path d="M2242 40 a13 13 0 0 0 26 0 z" />
        <path d="M2249.5 51 l1.4 6 M2260.5 51 l-1.4 6" />
        <rect x="2250.6" y="57" width="8.8" height="5.6" rx="1.4" />
      </Sprite>
      <Sprite className="car" box={[69, G - 16, 46, 18]} style={travel(69, 46, 26, 0.1)}>
        <path className="car-body" d={`M82 ${G - 8} l3.5 -6 h13 l3.5 6 z`} />
        <rect className="car-body" x="71" y={G - 9} width="42" height="7.6" rx="3" />
        <circle className="wheel" cx="80.5" cy={G - 2.8} r="3.3" />
        <circle className="wheel" cx="104.5" cy={G - 2.8} r="3.3" />
      </Sprite>
      <Sprite className="car car-b" box={[729, G - 16, 46, 18]} style={travel(729, 46, 26, 0.55)}>
        <path className="car-body" d={`M742 ${G - 8} l3.5 -6 h13 l3.5 6 z`} />
        <rect className="car-body" x="731" y={G - 9} width="42" height="7.6" rx="3" />
        <circle className="wheel" cx="740.5" cy={G - 2.8} r="3.3" />
        <circle className="wheel" cx="764.5" cy={G - 2.8} r="3.3" />
      </Sprite>
      <Sprite className="ambulance" box={[56, G - 19, 53, 23]} style={travel(56, 53, 22, 0.75)}>
        <rect className="amb-body" x="58" y={G - 14} width="40" height="13" rx="2" />
        <rect className="amb-cab" x="96" y={G - 10} width="11" height="9" rx="1.5" />
        <path className="amb-cross" d={`M74 ${G - 11} v7 M70.5 ${G - 7.5} h7`} />
        <circle className="amb-beacon" cx="78" cy={G - 15.5} r="1.9" />
        <circle className="wheel" cx="70" cy={G - 1} r="3.1" />
        <circle className="wheel" cx="99" cy={G - 1} r="3.1" />
      </Sprite>
      {/* Walkers are drawn around their feet (0,0); the track places them on the pavement. */}
      <div className="walker-track" style={{ left: 0, top: G }}>
        <Sprite className="walker-sprite" box={[-6, -22, 12, 28]}><Walker /></Sprite>
      </div>
      <div className="walker-track slow" style={{ left: 0, top: G }}>
        <Sprite className="walker-sprite" box={[-6, -22, 12, 28]}><Walker /></Sprite>
      </div>
    </div>
  );
}

/** Patient-path strip: a conveyor of workflow stations with rolling pads, in
 * the spirit of pleurat's .sv-board-view assembly line. */
export function PatientPathStrip({ className = '' }: { className?: string }) {
  return (
    <div className={`decor-strip ${className}`} aria-hidden="true">
      <svg viewBox="0 0 1560 96" preserveAspectRatio="xMidYMid meet">
        {/* conveyor line */}
        <line className="dl" x1="40" y1="64" x2="1520" y2="64" />
        {/* rollers */}
        <g className="dl-faint">
          <circle cx="120" cy="72" r="3" />
          <circle cx="200" cy="72" r="3" />
          <circle cx="280" cy="72" r="3" />
          <circle cx="360" cy="72" r="3" />
          <circle cx="440" cy="72" r="3" />
          <circle cx="520" cy="72" r="3" />
          <circle cx="600" cy="72" r="3" />
          <circle cx="680" cy="72" r="3" />
          <circle cx="760" cy="72" r="3" />
          <circle cx="840" cy="72" r="3" />
          <circle cx="920" cy="72" r="3" />
          <circle cx="1000" cy="72" r="3" />
          <circle cx="1080" cy="72" r="3" />
          <circle cx="1160" cy="72" r="3" />
          <circle cx="1240" cy="72" r="3" />
          <circle cx="1320" cy="72" r="3" />
          <circle cx="1400" cy="72" r="3" />
        </g>

        {/* stations on the line: daftar -> triase -> poli -> apotek -> kasir */}
        <g className="dl-group">
          {/* stasiun: pendaftaran */}
          <rect x="140" y="24" width="72" height="40" />
          <path d="M156 38 h40 M156 50 h28" />
          {/* stasiun: triase */}
          <rect x="380" y="24" width="72" height="40" />
          <path d="M416 38 a10 10 0 1 1 -.1 0" className="dl-accent" />
          {/* stasiun: poli */}
          <rect x="640" y="24" width="72" height="40" />
          <path d="M660 44 h32 M676 36 v16" />
          {/* stasiun: apotek */}
          <rect x="900" y="24" width="72" height="40" />
          <path d="M916 52 l12 -16 l12 16 M940 36 v16" />
          {/* stasiun: kasir */}
          <rect x="1160" y="24" width="72" height="40" />
          <path d="M1178 52 h36 M1196 36 v16" className="dl-accent" />
        </g>

        {/* flow arrows between stations */}
        <g className="dl-accent">
          <path d="M228 44 h130 m-8 -5 l8 5 l-8 5" />
          <path d="M468 44 h150 m-8 -5 l8 5 l-8 5" />
          <path d="M728 44 h150 m-8 -5 l8 5 l-8 5" />
          <path d="M988 44 h150 m-8 -5 l8 5 l-8 5" />
        </g>
      </svg>
    </div>
  );
}

/** Half-dial gauge marker (pleurat .sv-dial-mk) — tiny status ornament. */
export function DialMarker({ className = '' }: { className?: string }) {
  return (
    <svg className={`decor-dial ${className}`} viewBox="0 0 20 20" aria-hidden="true">
      <circle className="dd-rim" cx="10" cy="10" r="6.6" />
      <path className="dd-half" d="M10 3.4a6.6 6.6 0 0 0 0 13.2z" />
    </svg>
  );
}

/** Compact pipeline pane (pleurat .pane.pipe): keyword steps with a vertical
 * connector line through circular markers. */
export interface PipeStep {
  k: string;
  em: string;
}

export function PipePane({
  label,
  steps,
  activeIndex,
  className = '',
}: {
  label: string;
  steps: readonly PipeStep[];
  activeIndex?: number;
  className?: string;
}) {
  return (
    <aside className={`pipe-pane ${className}`} aria-label={label}>
      <span className="pipe-pane-label">{label}</span>
      <ul className="pipe-steps">
        {steps.map((step, index) => (
          <li
            key={step.k}
            className={index === activeIndex ? 'is-active' : undefined}
            aria-current={index === activeIndex ? 'step' : undefined}
          >
            <i aria-hidden="true" />
            <strong>{step.k}</strong>
            <em>{step.em}</em>
          </li>
        ))}
      </ul>
    </aside>
  );
}
