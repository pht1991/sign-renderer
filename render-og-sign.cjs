// 生成 sign.phtbyte.com 的 OG 社交图（1200x630 PNG），深色技术风品牌模板。
// 依赖：@resvg/resvg-js（managed node workspace）
const { Resvg } = require('C:/Users/shendushuke/.workbuddy/binaries/node/workspace/node_modules/@resvg/resvg-js');
const { writeFileSync, mkdirSync } = require('node:fs');

const OUT = 'D:/Projects/demos/front_end/sign-renderer/public';
const W = 1200, H = 630;

const BG_TOP = '#0e1117', BG_BOT = '#161b24';
const INK = '#f4f7fb', SUB = '#9aa6b8', ACCENT = '#38bdf8', ACCENT2 = '#fbbf24';

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BG_TOP}"/><stop offset="1" stop-color="${BG_BOT}"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${ACCENT}"/><stop offset="1" stop-color="${ACCENT2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.18" cy="0.2" r="0.55">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.20"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <circle cx="92" cy="96" r="9" fill="${ACCENT}"/>
  <text x="116" y="103" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="700" letter-spacing="3" fill="${ACCENT}">SIGN RENDERER</text>
  <text x="80" y="252" font-family="Segoe UI, Arial, sans-serif" font-size="62" font-weight="700" fill="${INK}">3D Storefront Sign</text>
  <text x="80" y="328" font-family="Segoe UI, Arial, sans-serif" font-size="62" font-weight="700" fill="${INK}">Preview Tool</text>
  <text x="80" y="386" font-family="Segoe UI, Arial, sans-serif" font-size="30" fill="${SUB}">See your sign on a real facade before you fabricate it — free in the browser.</text>
  <rect x="80" y="560" width="220" height="6" rx="3" fill="url(#bar)"/>
  <text x="80" y="600" font-family="Segoe UI, Arial, sans-serif" font-size="20" letter-spacing="2" fill="#5b6573">phtbyte.com</text>
  <g opacity="0.55" stroke="${ACCENT}" stroke-width="2" fill="none">
    <rect x="900" y="300" width="220" height="120" rx="10" stroke-opacity="0.6"/>
    <line x1="900" y1="410" x2="1120" y2="410" stroke-opacity="0.35"/>
    <line x1="1010" y1="300" x2="1010" y2="420" stroke-opacity="0.35"/>
    <text x="980" y="372" font-family="Segoe UI, Arial, sans-serif" font-size="20" fill="${ACCENT}" stroke="none">SIGN</text>
    <line x1="900" y1="300" x2="870" y2="250" stroke-opacity="0.4"/>
    <line x1="1120" y1="300" x2="1150" y2="250" stroke-opacity="0.4"/>
  </g>
</svg>`;

mkdirSync(OUT, { recursive: true });
const r = new Resvg(svg, { fitTo: { mode: 'width', value: W } });
const png = r.render().asPng();
writeFileSync(`${OUT}/og-sign.png`, png);
console.log('rendered og-sign.png', png.length, 'bytes');
