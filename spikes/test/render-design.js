// Troubleshooting: design.json -> absolutely-positioned HTML -> screenshot (rerender.png), WITHOUT Figma.
// If rerender.png matches reference.png, the capture is fine and any difference in Figma comes from the plugin/Figma.
//   node test/render-design.js "out\mockup\design.json"
const fs = require('fs'), path = require('path');
const { launch } = require('../lib/browser');
const dj = process.argv[2];
const outPng = process.argv[3] || path.join(path.dirname(dj), 'rerender.png');   // "" = default
const fontsDir = process.argv[4] || path.join(__dirname, '..', 'fonts');   // a folder of the spike woff2 files, or a .css file with @font-face rules
const d = JSON.parse(fs.readFileSync(dj, 'utf8'));
const col = c => c ? `rgba(${c.r * 255},${c.g * 255},${c.b * 255},${c.a})` : 'transparent';
const asset = id => id && d.assets[id] ? `data:${d.assets[id].mime};base64,${d.assets[id].storage.base64}` : '';
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function node(n) {
  const b = n.box, idAttr = ` data-id="${n.id}"`, st = [`left:${b.x}px`, `top:${b.y}px`, `width:${b.width}px`, `height:${b.height}px`, `opacity:${n.opacity}`];
  if (n.visible === false) st.push('visibility:hidden');
  const rad = n.radius && n.radius.ellipse ? 'border-radius:50%;' : n.radius ? `border-radius:${n.radius.topLeft}px ${n.radius.topRight}px ${n.radius.bottomRight}px ${n.radius.bottomLeft}px;` : '';
  if (n.type === 'frame') {
    const bg = (n.fills || []).map(f => f.type === 'solid' ? `linear-gradient(${col(f.color)},${col(f.color)})` : `url(${asset(f.assetId)}) 0 0/100% 100%`).reverse().join(',');
    const sh = (n.effects || []).filter(e => /shadow/.test(e.type)).map(e => `${e.type === 'inner-shadow' ? 'inset ' : ''}${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${col(e.color)}`).join(',');
    const bd = n.border ? ['top', 'right', 'bottom', 'left'].map(s => `border-${s}:${n.border[s].width}px ${/dashed|dotted/.test(n.border[s].style) ? n.border[s].style : 'solid'} ${col(n.border[s].color)}`).join(';') : '';
    if (n.transform) { const t = n.transform; st.splice(0, 4, 'left:0', 'top:0', `width:${t.width}px`, `height:${t.height}px`); st.push(`transform-origin:0 0;transform:matrix(${t.a},${t.b},${t.c},${t.d},${t.tx},${t.ty})`); }
    return `<div${idAttr} style="${st.join(';')};${rad}${bg ? 'background:' + bg + ';' : ''}${bd};${sh ? 'box-shadow:' + sh + ';' : ''}box-sizing:border-box;${n.clip ? 'overflow:hidden;' : ''}">` +
      `<div style="position:absolute;left:${-(n.border ? n.border.left.width : 0)}px;top:${-(n.border ? n.border.top.width : 0)}px;width:0;height:0">` +
      (n.children || []).map(c => node(c)).join('') + '</div></div>';
  }
  if (n.type === 'text') {
    const s = n.style;
    const lines = n.visualLines.map(l => esc(n.originalText.slice(l.start, l.end).replace(/\s+$/, ''))).join('<br>');
    return `<div${idAttr} style="${st.join(';')};width:auto;height:auto;white-space:nowrap;font-family:${s.cssFamilies.map(f => "'" + f + "'").join(',')};font-size:${s.size}px;font-weight:${s.weight};line-height:${s.lineHeight}px;color:${col(s.color)};letter-spacing:${s.letterSpacing}px">${lines}</div>`;
  }
  if (n.type === 'vector') return `<div${idAttr} style="${st.join(';')};${n.clip === false ? 'overflow:visible' : 'overflow:hidden'}">${n.svg.replace('<svg', '<svg style="overflow:visible"')}</div>`;
  return `<img${idAttr} src="${asset(n.assetId)}" style="${st.join(';')};${rad}object-fit:cover">`;
}
const fontCss = /\.css$/i.test(fontsDir) ? fs.readFileSync(fontsDir, 'utf8') : fs.readdirSync(fontsDir).map(f => { const [, fam, , w] = f.match(/^(inter|noto-sans-thai)-(latin|thai)-(\d+)/); return `@font-face{font-family:"${fam === 'inter' ? 'Inter' : 'Noto Sans Thai'}";font-weight:${w};src:url('${require('url').pathToFileURL(path.join(fontsDir, f)).href}')}`; }).join('');
const html = `<!doctype html><meta charset=utf-8><style>${fontCss} div,img{position:absolute;box-sizing:border-box} body{margin:0}</style>${node(d.root)}`;
fs.writeFileSync(outPng.replace(/\.png$/, '.html'), html);
(async () => {
  const { browser: b } = await launch();
  const p = await b.newPage({ viewport: { width: Math.ceil(d.root.box.width), height: Math.ceil(d.root.box.height) }, deviceScaleFactor: d.capture.deviceScaleFactor || 1 });
  await p.goto(require('url').pathToFileURL(path.resolve(outPng.replace(/\.png$/, '.html'))).href); await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: outPng, fullPage: true }); await b.close(); console.log('wrote', outPng);
})();
