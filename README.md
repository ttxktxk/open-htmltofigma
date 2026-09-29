# Open HTML to Figma

แปลงไฟล์ HTML ที่ export จาก **Claude Design** (bundled HTML ไฟล์เดียว) เป็น **layer ใน Figma ที่แก้ไขได้**
ขนาด Frame ตรงกับ Design size ของไฟล์ ข้อความไทยตัดบรรทัดตรงกับ Chrome และใช้ฟอนต์ตามที่หน้าเว็บใช้จริง

```
แบบปุ่มเดียว (แนะนำ):  Figma plugin ──HTML──► Local Helper (npm run helper, เครื่องนี้เท่านั้น) ──► Chrome + Playwright
                                    ◄──design data──                                      ──► editable layers

แบบคำสั่ง (fallback):   design.html ──► npm run capture ──► design.json ──► Figma plugin (Advanced) ──► editable layers
```

Chrome เป็นตัวจัด layout (รวม JavaScript/React ที่ render หน้า) แล้ว capture วัดผลที่ Chrome วาดจริง
Plugin ใน Figma สร้าง Frame / Text / Vector / Image ตามพิกัดนั้น ไม่มีการเดา layout ใหม่

---

## สิ่งที่ต้องมี

- **Windows** + **PowerShell**
- **Node.js 18 ขึ้นไป** — ตรวจด้วย `node -v`
- **Google Chrome** หรือ **Microsoft Edge** (ใช้ตัวที่ติดตั้งอยู่ ไม่ต้องดาวน์โหลด browser เพิ่ม)
- **Figma Desktop**
- **ฟอนต์ที่หน้าใช้ ติดตั้งในเครื่อง** (เช่น DB Ozone X 400/500/700, IBM Plex Sans Thai, Anuphan)
  Chrome อ่านฟอนต์ที่ฝังใน HTML ได้เอง แต่ **Figma ใช้ได้เฉพาะฟอนต์ที่ติดตั้งในเครื่อง**

## ติดตั้ง (ครั้งแรกครั้งเดียว)

```powershell
cd C:\path\to\open-htmltofigma
npm install
```

> ถ้า PowerShell ขึ้น `running scripts is disabled on this system` ให้ใช้ `npm.cmd` แทน `npm` ทุกคำสั่ง
> ถ้าหา Chrome/Edge ไม่เจอ: `$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"`

ติดตั้ง plugin ใน Figma Desktop: **Plugins → Development → Import plugin from manifest…** → เลือก `figma-plugin\manifest.json`
(ชื่อ plugin: **HTML to Figma (Playwright capture)**)

## ใช้งานแบบปุ่มเดียว: Figma Plugin + Local Helper

### 1. เปิด Local Helper (เปิดทิ้งไว้ระหว่างใช้งาน)

```powershell
cd C:\path\to\open-htmltofigma
npm run helper
```

หน้าต่างจะแสดง:

```
Open HTML to Figma — Local Helper 1.0.0
  listening on http://localhost:43127  (bound to 127.0.0.1 only — this computer)
  token:  <ข้อความสุ่ม>
```

**token** เปลี่ยนทุกครั้งที่เปิด Helper ใหม่ — plugin จะขอให้วางครั้งแรก แล้วจำไว้จนกว่า Helper จะเริ่มใหม่
ปิด Helper ด้วย **Ctrl+C**

### 2. ใน Figma Desktop

1. **Plugins → Development → HTML to Figma (Playwright capture)** — ด้านบนต้องขึ้น **Local Helper: Connected**
   (ครั้งแรก: วาง token จากหน้าต่าง Helper → **Connect**)
2. ลากไฟล์ HTML จาก Claude Design มาวางที่ **Drop Claude Design HTML here** หรือกด **Choose HTML**
3. (ถ้าต้องการ) **Design root**: Auto / All screens / Selector และ **Expand** สำหรับกล่องที่ scroll
4. กด **Convert & Import** — ดูความคืบหน้า Uploading → Rendering → Measuring → Building design data → Importing to Figma → Complete
5. หลัง import จะแสดง Design size, จำนวน layer, layer ที่หาย, ฟอนต์ที่ถูกแทน, feature ที่ไม่รองรับ

ไฟล์ที่มีหลายหน้าจอ: plugin แสดงรายการให้เลือก **Import only this** หรือ **Import all screens**

**ความปลอดภัย:** plugin ติดต่อ Helper ที่ `http://localhost:43127` · Helper เปิดรับเฉพาะในเครื่องนี้ (bind `127.0.0.1` เครื่องอื่นในเครือข่ายเข้าไม่ได้) ต้องมี token ทุกคำขอ รับเฉพาะไฟล์ที่ผู้ใช้เลือก (≤ 100 MB, .html/.htm)
เก็บไว้ในโฟลเดอร์ temp แบบสุ่มระหว่าง capture และลบทันทีทั้งกรณีสำเร็จและผิดพลาด ไม่ส่งข้อมูลออกอินเทอร์เน็ต
log บันทึกเฉพาะชื่อไฟล์ ขนาด สถานะ และเวลา

| อาการ | วิธีแก้ |
| --- | --- |
| **Local Helper: Not running** | เปิด PowerShell ในโฟลเดอร์โปรเจกต์ → `npm run helper` → กด **Retry connection** |
| ขอ token ใหม่ | Helper ถูกเปิดใหม่ — คัดลอก token จากหน้าต่าง Helper มาวาง |
| `Port 43127 … already used` | ปิดโปรแกรมที่ใช้ port (หน้าต่าง Helper จะบอกคำสั่งหา process) หรือถ้าเป็น Helper อีกหน้าต่าง ให้ใช้หน้าต่างนั้น |
| `Chrome or Microsoft Edge was not found` | ติดตั้ง Chrome/Edge หรือ `$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"` ก่อน `npm run helper` |
| capture เกิน 5 นาที | `npm run helper -- --timeout 10` |
| ไฟล์ใหญ่กว่า 100 MB | `npm run helper -- --max-mb 200` |

ตัวเลือกของ Helper: `npm run helper -- --help` · ทดสอบจาก PowerShell โดยไม่ใช้ Figma:

```powershell
$token = "<token จากหน้าต่าง Helper>"
Invoke-RestMethod http://localhost:43127/health
$f = "C:\path\to\design.html"
$name = [uri]::EscapeDataString([IO.Path]::GetFileName($f))
Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://localhost:43127/capture?wait=1&name=$name" `
  -Headers @{ Authorization = "Bearer $token" } -ContentType "application/octet-stream" -InFile $f -OutFile result.json
```

## ใช้งานแบบคำสั่ง (fallback)

### 1. Capture

```powershell
npm run capture -- "C:\path\to\design.html"
```

ได้โฟลเดอร์ `out\<ชื่อไฟล์>\<กว้าง>x<สูง>\` เช่น `out\my-design\1920x992\`

| ไฟล์ | ใช้ทำอะไร |
| --- | --- |
| `design.json` | ไฟล์ที่ import เข้า Figma |
| `reference.png` | ภาพจาก Chrome ไว้เทียบ |
| `capture-report.json` | ขนาดที่ตรวจเจอ, ฟอนต์ที่ Chrome ใช้, element ที่เป็นภาพ, CSS ที่ยังไม่รองรับ |
| `design.normalized.json` | ไว้ตรวจว่า capture ซ้ำได้ผลเหมือนเดิม |

Console จะสรุป Design size, ฟอนต์ที่ Chrome ใช้จริง และ **เตือนเมื่อฟอนต์ตัวแรกใน CSS ไม่ถูกใช้**

**ขนาด Frame ตรวจหาเองจากไฟล์** ตามลำดับ:

1. element ที่มี `data-figma-frame` / `data-design-root` / `data-screen-label` (Claude Design ใส่ `data-screen-label` ให้)
2. `$preview` `{width, height}` ที่ Claude Design ฝังไว้ในไฟล์
3. `width`/`height` แบบ px บน root element ของหน้า
4. content box ของ `<body>` (สำรอง พร้อมคำเตือน)

browser viewport ตั้งเท่ากับ Design size ให้เอง หน้ายาว (เช่น 1920×2415) ได้ Frame ยาวเท่าดีไซน์ — ไม่มีการย่อ/ขยายดีไซน์

### 2. Import ใน Figma

1. เปิด **Plugins → Development → HTML to Figma (Playwright capture)** → เปิด **Advanced / Fallback**
2. เลือก `design.json` จากขั้นที่ 1
3. (ครั้งแรก) ในส่วน **Fonts** พิมพ์ `ozone` → **Find fonts** → ถ้าชื่อ style ไม่ใช่ `Regular / Medium / Bold` ให้แก้ใน font map
   เช่น `"DB Ozone X": { "400": "Regular", "500": "Med", "700": "Bold" }` — plugin จำค่าไว้ให้ (ใช้กับแบบปุ่มเดียวด้วย)
4. **Import design.json**

หลัง import (ทั้งสองแบบ) plugin แสดงสรุป: **Design size · จำนวน layer · layer ที่หาย · ฟอนต์ที่ถูกแทน · feature ที่ไม่รองรับ** · ภาพที่ใช้แทน · geometry / การตัดบรรทัด
ใน **Advanced / Fallback** กด **Download result JSON** แล้วตรวจอัตโนมัติได้ด้วย:

```powershell
npm run check:import -- "C:\Users\<you>\Downloads\import-result.json"
```

## ตัวเลือกของ capture

```powershell
# หลายไฟล์ / ทั้งโฟลเดอร์ และกำหนดโฟลเดอร์ผลลัพธ์
npm run capture -- "C:\mockups" --out "C:\mockups\h2f-out"

# ไฟล์ที่มีหลายหน้าจอ: capture หยุดและแสดงรายการ (exit code 3) ให้เลือก
npm run capture -- "C:\path\to\design.html" --design-root all          # ทุกหน้าจอ -> out\<ไฟล์>\<ชื่อหน้าจอ>\<กxส>\
npm run capture -- "C:\path\to\design.html" --design-root 1            # หน้าจอลำดับที่ 1
npm run capture -- "C:\path\to\design.html" --design-root "[data-screen-label='Detail']"

# ฟอนต์ชั่วคราวสำหรับรอบ capture นี้ (ไม่แก้ไฟล์ HTML) — ถ้าโหลดไม่สำเร็จจะหยุดและรายงาน
npm run capture -- "C:\path\to\design.html" `
  --font "DB Ozone X|400|C:\fonts\DB Ozone X v3.2.ttf" `
  --font "DB Ozone X|500|C:\fonts\DB Ozone X Med v3.2.ttf" `
  --font "DB Ozone X|700|C:\fonts\DB Ozone X Bd v3.2.ttf"

# บังคับ element ให้เป็นภาพ (แผนที่ ArcGIS/Leaflet/OpenLayers/MapLibre และ <canvas> ตรวจเจอเอง)
npm run capture -- "C:\path\to\design.html" --raster ".chart,.my-map"

# กล่องที่ scroll: ขยายให้เห็นเนื้อหาครบ เฉพาะ selector ที่ระบุ
npm run capture -- "C:\path\to\design.html" --expand ".panel"

# หน้าที่ render ช้า / กำหนดพื้นที่ดีไซน์เอง / บังคับขนาด viewport
npm run capture -- "C:\path\to\design.html" --wait 3000
npm run capture -- "C:\path\to\design.html" --design-area 8,8,1920,992     # หรือ body | document
npm run capture -- "C:\path\to\design.html" --width 1440 --height 900
```

Exit code: `0` สำเร็จ · `1` capture ล้มเหลว · `2` ใช้คำสั่งผิด · `3` เจอหลาย design root ต้องเลือกด้วย `--design-root`

## รองรับ / ข้อจำกัดของ MVP-A

| รองรับ | ยังไม่รองรับ (ข้าม + ขึ้นรายงาน) |
| --- | --- |
| bundled HTML ไฟล์เดียว, หน้าที่ render ด้วย JavaScript/React | z-index / stacking context ของ element ทั่วไป (ใช้ลำดับ DOM; เฉพาะ pseudo-element ที่จัดตาม z-index) |
| Design size อัตโนมัติ, หลายขนาด, หน้ายาว, หลายหน้าจอในไฟล์เดียว | `backdrop-filter`, `filter`, `mask` |
| Frame ตามโครง DOM, พิกัดตายตัวจาก Chrome (ไม่มี Auto Layout) | `clip-path` (วงกลม/รูปร่าง) |
| สีพื้น, border 4 ด้าน (dashed/dotted), radius 4 มุม, overflow clip, `box-shadow` (ring = stroke) | `transform` บน element ที่มีลูก (วางลูกตามกรอบบนจอ) |
| Text แก้ไขได้ ฟอนต์ต่อช่วง (ไทย/อังกฤษ) ตัดบรรทัดตาม Chrome, ค่าใน input/textarea | `position: fixed/sticky` (วางตามตำแหน่งตอน capture) |
| inline SVG เป็น vector (gradient, กลับด้าน/หมุนด้วย CSS transform) | shadow DOM |
| `::before` / `::after` แบบภาพง่าย ๆ เป็น layer แก้ไขได้ ชื่อ `<parent>::before` / `<parent>::after` (สีพื้น, border, radius, opacity, shadow, หมุน/ย่อขยาย, ข้อความบรรทัดเดียว, เส้นบางกว่า 1px) ลำดับชั้นตาม z-index ของ Chrome | `::before` / `::after` ที่ซับซ้อน (gradient/ภาพพื้นหลัง, `content: url()/counter()`, ไอคอนฟอนต์, ข้อความหลายบรรทัด, skew/3D) → เป็นภาพ + ขึ้นรายงาน |
| `<img>`, gradient/ภาพพื้นหลัง, `<canvas>`, แผนที่, `blob:` image, native control → ภาพ | glyph baseline ของ Figma ต่างจาก Chrome ได้ไม่เกิน 1px |
| รายงานฟอนต์ที่ถูกแทน, fallback ของ Chrome และ CSS ที่ไม่รองรับ | |

## ตรวจคุณภาพ (สำหรับผู้พัฒนา)

```powershell
npm test                    # fixture ขนาดต่าง ๆ: schema, Root Frame, mock import, determinism, exit code, ::before/::after (test\fixtures)
npm run test:regression     # หน้าจริง 2 หน้า (ต้องวางไฟล์ใน regression\inputs\ — ดู regression\README.md)
npm run test:helper         # Local Helper: token, CORS, ขนาด/ชนิดไฟล์, ชื่อไฟล์ไทย, temp cleanup, timeout, Ctrl+C, หน้าจริงเทียบ CLI
npm run test:plugin         # plugin UI ใน sandboxed iframe + Helper จริง + code.js บน Figma mock (Convert & Import ปุ่มเดียว)
npm run preview -- "out\<ไฟล์>\<กxส>\design.json"   # วาด design.json กลับเป็นภาพโดยไม่ใช้ Figma (rerender.png)
```

ถ้า `rerender.png` ตรงกับ `reference.png` แต่ Figma เพี้ยน แปลว่าปัญหาอยู่ฝั่ง plugin/Figma

## โครงสร้าง

```
capture\          cli.js (npm run capture), page.js (เดิน DOM ใน browser), browser.js, iso.js
schema\           design.schema.json (schemaVersion 1.0.0)
local-helper\     server.js (npm run helper), capture-service.js (เรียก capture\cli.js), temp-files.js
figma-plugin\     manifest.json, code.js, ui.html — plugin (plain JS ไม่ต้อง build)
test\             smoke.js, regression.js, helper.js, plugin-ui.js, check-import.js, mock-figma.js, render-design.js
regression\       baselines.json (ค่าที่คาดไว้ของหน้าจริงที่ผ่านแล้ว), inputs\ (ไฟล์จริง — ไม่ขึ้น git)
spikes\           prototype ที่ผ่านการทดสอบ ใช้เป็น regression reference (ห้ามลบ)
manifest.json, code.ts, ui.html   plugin เดิม (import HTML ภายใน Figma โดยตรง) — ยังใช้ได้ตามเดิม
```

รายละเอียดการออกแบบ: [ARCHITECTURE.md](ARCHITECTURE.md)

## Plugin เดิม (import HTML ภายใน Figma)

plugin ต้นฉบับยังอยู่ที่ root: `npm run build` แล้ว import `manifest.json` → **Open HTML to Figma**
ใช้ iframe ภายใน Figma จัด layout (ไม่ต้องใช้ Node/Chrome) แต่ความแม่นยำต่ำกว่าเส้นทาง Playwright capture

## License

MIT — see [LICENSE](LICENSE).
