# Open HTML to Figma

แปลงไฟล์ HTML ที่ export จาก **Claude Design** (bundled HTML ไฟล์เดียว) เป็น **layer ใน Figma ที่แก้ไขได้**
ขนาด Frame ตรงกับ Design size ของไฟล์ ข้อความไทยตัดบรรทัดตรงกับ Chrome และใช้ฟอนต์ตามที่หน้าเว็บใช้จริง

```
design.html ──► npm run capture ──► out\<ชื่อไฟล์>\<กว้าง>x<สูง>\design.json ──► Figma plugin ──► editable layers
                (Chrome + Playwright)          reference.png, capture-report.json
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

## ใช้งาน

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

1. เปิด **Plugins → Development → HTML to Figma (Playwright capture)**
2. **Choose File** → `design.json` จากขั้นที่ 1
3. (ครั้งแรก) เปิด **Fonts** → พิมพ์ `ozone` → **Find fonts** → ถ้าชื่อ style ไม่ใช่ `Regular / Medium / Bold` ให้แก้ใน font map
   เช่น `"DB Ozone X": { "400": "Regular", "500": "Med", "700": "Bold" }` — plugin จำค่าไว้ให้
4. **Import to Figma**

หลัง import plugin แสดงสรุป: **Design size · จำนวน layer · layer ที่หาย · ฟอนต์ที่ถูกแทน · feature ที่ไม่รองรับ** · ภาพที่ใช้แทน · geometry / การตัดบรรทัด
กด **Download result JSON** แล้วตรวจอัตโนมัติได้ด้วย:

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
| bundled HTML ไฟล์เดียว, หน้าที่ render ด้วย JavaScript/React | z-index / stacking context (ใช้ลำดับ DOM) |
| Design size อัตโนมัติ, หลายขนาด, หน้ายาว, หลายหน้าจอในไฟล์เดียว | `backdrop-filter`, `filter`, `mask` |
| Frame ตามโครง DOM, พิกัดตายตัวจาก Chrome (ไม่มี Auto Layout) | `clip-path` (วงกลม/รูปร่าง) |
| สีพื้น, border 4 ด้าน (dashed/dotted), radius 4 มุม, overflow clip, `box-shadow` (ring = stroke) | `transform` บน element ที่มีลูก (วางลูกตามกรอบบนจอ) |
| Text แก้ไขได้ ฟอนต์ต่อช่วง (ไทย/อังกฤษ) ตัดบรรทัดตาม Chrome, ค่าใน input/textarea | `position: fixed/sticky` (วางตามตำแหน่งตอน capture) |
| inline SVG เป็น vector (gradient, กลับด้าน/หมุนด้วย CSS transform) | `::before` `::after`, shadow DOM |
| `<img>`, gradient/ภาพพื้นหลัง, `<canvas>`, แผนที่, `blob:` image, native control → ภาพ | glyph baseline ของ Figma ต่างจาก Chrome ได้ไม่เกิน 1px |
| รายงานฟอนต์ที่ถูกแทน, fallback ของ Chrome และ CSS ที่ไม่รองรับ | |

## ตรวจคุณภาพ (สำหรับผู้พัฒนา)

```powershell
npm test                    # fixture ขนาดต่าง ๆ: schema, Root Frame, mock import, determinism, exit code
npm run test:regression     # หน้าจริง 2 หน้า (ต้องวางไฟล์ใน regression\inputs\ — ดู regression\README.md)
npm run preview -- "out\<ไฟล์>\<กxส>\design.json"   # วาด design.json กลับเป็นภาพโดยไม่ใช้ Figma (rerender.png)
```

ถ้า `rerender.png` ตรงกับ `reference.png` แต่ Figma เพี้ยน แปลว่าปัญหาอยู่ฝั่ง plugin/Figma

## โครงสร้าง

```
capture\          cli.js (npm run capture), page.js (เดิน DOM ใน browser), browser.js, iso.js
schema\           design.schema.json (schemaVersion 1.0.0)
figma-plugin\     manifest.json, code.js, ui.html — plugin สำหรับ design.json (plain JS ไม่ต้อง build)
test\             smoke.js, regression.js, check-import.js, mock-figma.js, render-design.js
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
