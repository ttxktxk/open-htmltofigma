# H2F spikes — HTML จาก Claude Design → Figma (prototype, ไม่ใช่ production code)

```
mockup.html ──► node capture.js ──► out\<ชื่อไฟล์>\<กว้าง>x<สูง>\design.json ──► Figma plugin "H2F Spike" ──► layers ที่แก้ไขได้
                                     reference.png, capture-report.json
```

ต้องมี: **Node.js 18+**, **Chrome หรือ Edge**, **Figma Desktop**, ฟอนต์ **DB Ozone X** 400/500/700 ติดตั้งในเครื่อง
ใช้ใน Windows PowerShell ได้ (ตัวอย่างด้านล่างเป็น PowerShell)

---

## ติดตั้ง (ครั้งแรกครั้งเดียว)

```powershell
cd C:\path\to\open-htmltofigma\spikes
npm install
```

> ถ้า PowerShell ขึ้น `running scripts is disabled on this system` ให้ใช้ `npm.cmd install` แทน
> Script ใช้ Chrome/Edge ที่ติดตั้งอยู่ ไม่ต้องดาวน์โหลด browser เพิ่ม — ถ้าหาไม่เจอ:
> `$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"`

## 1. Capture HTML จริง

```powershell
node capture.js "C:\path\to\mockup.html"
```

ได้ไฟล์ใน `out\mockup\<กว้าง>x<สูง>\` เช่น `out\Login-Change-Organization\375x812\`:
`design.json` · `reference.png` (ภาพจาก Chrome) · `capture-report.json`

**ขนาด Frame ตรวจหาเองจากไฟล์** (`--design-area auto` เป็นค่าเริ่มต้น) — Root Frame ใน Figma = Design size ของไฟล์นั้น
ไม่ใช่ขนาดจอหรือ browser โดยหาตามลำดับ:

1. element ที่มี `data-figma-frame` / `data-design-root` / `data-screen-label` (Claude Design ใส่ `data-screen-label` ให้)
2. `$preview` `{width, height}` ที่ Claude Design ฝังไว้ในไฟล์
3. `width`/`height` แบบ px ที่กำหนดไว้บน root element ของหน้า
4. content box ของ `<body>` (สำรอง — ขึ้นคำเตือน)

browser viewport ถูกตั้งเท่ากับ Design size ให้เอง (หน้ายาว 1920×2351 → viewport 1920×2351) ไม่มีการย่อ/ขยายดีไซน์
ถ้าเจอหลาย design root (เช่นหลายหน้าจอในไฟล์เดียว) capture จะ **หยุดและแสดงรายการ** ให้เลือก:

```powershell
node capture.js "C:\path\to\mockup.html" --design-root all          # ทุกหน้าจอ -> out\mockup\<ชื่อหน้าจอ>\<กxส>\
node capture.js "C:\path\to\mockup.html" --design-root 1            # หน้าจอที่ 1 ในรายการ
node capture.js "C:\path\to\mockup.html" --design-root "[data-screen-label='Detail']"
```

ตัวเลือกที่ใช้บ่อย:

```powershell
# โฟลเดอร์ผลลัพธ์ (--width/--height = บังคับขนาด browser viewport เอง ปกติไม่ต้องใส่)
node capture.js --input "C:\path\to\mockup.html" --out "C:\path\to\h2f-out"

# ทุกไฟล์ .html ในโฟลเดอร์ (ผลแยกโฟลเดอร์ตามชื่อไฟล์)
node capture.js --input "C:\mockups"

# ขยายกล่องที่ scroll ให้เห็นเนื้อหาครบ เฉพาะ selector ที่ระบุ (ค่าเริ่มต้น = เท่าจอ)
node capture.js "C:\path\to\mockup.html" --expand ".panel"

# บังคับ element ให้เป็นภาพ (แผนที่ ArcGIS/Leaflet/OpenLayers/MapLibre และ <canvas> ตรวจเจอเองอยู่แล้ว)
node capture.js "C:\path\to\mockup.html" --raster ".chart,.my-map"

# กำหนดพื้นที่ดีไซน์เอง (แทนการตรวจหาอัตโนมัติ)
node capture.js "C:\path\to\mockup.html" --design-area body        # content box ของ <body>, ขนาด = viewport
node capture.js "C:\path\to\mockup.html" --design-area document    # ทั้ง document
node capture.js "C:\path\to\mockup.html" --design-area 8,8,1920,992

# หน้าที่ render ช้า
node capture.js "C:\path\to\mockup.html" --wait 3000

# ฟอนต์ชั่วคราวสำหรับรอบ capture นี้ (ไม่แก้ไฟล์ HTML) — ถ้าโหลดไม่สำเร็จจะหยุดและรายงาน
node capture.js "C:\path\to\mockup.html" `
  --font "DB Ozone X|400|C:\fonts\DB Ozone X v3.2.ttf" `
  --font "DB Ozone X|500|C:\fonts\DB Ozone X Med v3.2.ttf" `
  --font "DB Ozone X|700|C:\fonts\DB Ozone X Bd v3.2.ttf"
```

> ไฟล์ export จาก Claude Design แบบ standalone **ฝังฟอนต์ไว้ในไฟล์แล้ว** (รวม DB Ozone X ถ้าอยู่ใน design system)
> จึงไม่จำเป็นต้องใช้ `--font` — แต่ **Figma ต้องมีฟอนต์ติดตั้งในเครื่อง** เพราะ Figma ไม่อ่านฟอนต์จาก HTML
> console จะเตือนเมื่อ Chrome ไม่ได้ใช้ฟอนต์ตัวแรกใน CSS (เช่นขอ DB Ozone X แต่ได้ Anuphan)

Console จะสรุป: จำนวน layer, ฟอนต์ที่ Chrome ใช้จริง, **คำเตือนถ้า Chrome ไม่เจอ DB Ozone X** (แปลว่าฟอนต์ไม่ได้ติดตั้ง), element ที่กลายเป็นภาพ และ CSS ที่ยังไม่รองรับ

## 2. Import plugin ใน Figma (ครั้งแรกครั้งเดียว)

Figma Desktop → เมนู **Plugins → Development → Import plugin from manifest…** → เลือก `spikes\figma-plugin\manifest.json`

## 3. เลือก design.json แล้ว Import

1. Plugins → Development → **H2F Spike**
2. ช่อง Find fonts พิมพ์ `ozone` → **Find fonts** → ถ้าชื่อ style ไม่ใช่ `Regular / Medium / Bold` ให้แก้ใน Font map
   (เช่น `"500": "Med"`) — plugin จำค่าไว้ให้รอบหน้า
3. **Choose file** → `out\mockup\<กxส>\design.json`
4. เลือก `lines: U+2028` → **Import**
5. กด **Download result JSON** และ **Download Figma PNG**

## 4. ส่งผลกลับมาตรวจ

| ส่ง | อยู่ที่ |
| --- | --- |
| ข้อความสรุปใน console ของ `node capture.js` | PowerShell |
| `reference.png`, `capture-report.json` | `out\<ชื่อไฟล์>\<กxส>\` |
| `import-result.json`, `figma-e2e.png` | ไฟล์ที่ plugin ดาวน์โหลด |
| screenshot หน้าต่าง Figma (ถ้ามีจุดเพี้ยนให้วงไว้) | — |
| ผล Find fonts ของ `ozone` | plugin |

ถ้าเป็นไปได้ ขอไฟล์ HTML ต้นฉบับด้วย (ไม่มีข้อมูลจริง/ข้อมูลลับ)

---

## เพิ่มเติม (ไม่บังคับ)

**ตรวจว่าปัญหาอยู่ที่ capture หรือ Figma** — วาด design.json กลับเป็นภาพโดยไม่ใช้ Figma:

```powershell
node test\render-design.js "out\mockup\1920x992\design.json"                        # ฟอนต์ใน spikes\fonts
node test\render-design.js "out\mockup\1920x992\design.json" "" "C:\path\fonts.css" # หรือ CSS @font-face ของหน้านั้น
```

ถ้า `rerender.png` ตรงกับ `reference.png` แต่ใน Figma เพี้ยน = ปัญหาอยู่ฝั่ง plugin/Figma

**Text / font spike** (ทดสอบวิธีรักษาบรรทัดไทยใน Figma):

```powershell
node font-spike.js      # -> out\font-spike.json, out\text-lines.json, out\text-chrome.png
```
แล้วใน plugin เลือก `out\text-lines.json` → **Text spike** → Download JSON + PNG

## สิ่งที่ prototype รองรับ / ยังไม่รองรับ

| รองรับ | ยังไม่รองรับ (ข้าม + ขึ้นรายงาน) |
| --- | --- |
| Frame ตามโครง DOM, สีพื้น, border 4 ด้าน (สีเดียว, dashed/dotted), radius 4 มุม, overflow clip | Auto Layout, Components, Design System |
| `box-shadow` เป็น effect · ring (`0 0 0 1px`) เป็น **stroke** (Figma ใช้ spread ได้เฉพาะ frame ที่ clip) | z-index / stacking context (ใช้ลำดับ DOM) |
| `border-radius: 50%` บนกล่องไม่จัตุรัส = **Ellipse** | `transform` บน element ที่มีลูก (วางลูกตามกรอบบนจอ) |
| `transform` 2D บน element ที่ไม่มีลูก = rotation จริงใน Figma (`relativeTransform`) | `backdrop-filter`, `filter`, `mask`, `clip-path` (วงกลม/รูปร่าง) |
| Text แก้ไขได้ พร้อมฟอนต์ต่อ run (ไทย/อังกฤษ), ล็อกบรรทัดตาม Chrome | `position: fixed/sticky` (วางตามตำแหน่งตอน capture) |
| ค่าใน input / placeholder / textarea | `::before` `::after`, shadow DOM, border คนละสีต่อด้าน (ใช้สีแรก) |
| `<img>` (png/jpg/gif; webp และ >4096px เป็นภาพจาก Chrome) | icon font (เป็นภาพ) |
| inline SVG เป็น vector พร้อม gradient และ clip ตามขอบ `<svg>` (SVG ที่มี text/filter/mask เป็นภาพ) | |
| gradient / background-image เป็นภาพพื้นหลังของ frame, canvas / แผนที่ / select เป็นภาพ | |

## โครงสร้าง

```
spikes\
├─ capture.js            HTML -> design.json + reference.png + capture-report.json
├─ e2e-capture.js        = capture.js (ค่าเริ่มต้นเป็น fixture)
├─ font-spike.js         spike 2 + ข้อมูลสำหรับ Text spike
├─ lib\
│  ├─ browser.js         เปิด Chrome/Edge, รอหน้า render เสร็จ (fonts, images, DOM นิ่ง)
│  ├─ iso.js             รันโค้ดใน isolated world (กันโค้ดของหน้าเว็บ เช่น component ชื่อ Map ทับ window.Map)
│  ├─ page.js            เดิน DOM, วัดบรรทัดข้อความ, serialize SVG (รันในหน้าเว็บ)
│  ├─ measure.js, fontruns.js   ใช้โดย font-spike.js
├─ schema\design-spike.schema.json
├─ figma-plugin\         manifest.json, code.js, ui.html (plain JS ไม่ต้อง build)
├─ fixtures\, fonts\     ไฟล์ทดสอบภายใน (fixtures\design-size\ = ทดสอบการตรวจหาขนาด 375x812, 1440x900, 1920x2351, หลายหน้าจอ)
├─ test\                 render-design.js (preview), mock-figma.js (smoke test)
└─ results-cloud\        ผลที่รันใน cloud ไว้เทียบ (มีข้อมูลหน้าจริง — อยู่ใน .gitignore ไม่ขึ้น git)
```
