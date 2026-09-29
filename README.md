# Open HTML to Figma

แปลงไฟล์ HTML ที่ export จาก **Claude Design** ให้เป็น **Figma layers ที่แก้ไขได้** โดยใช้ Chrome วาดหน้าเว็บจริงก่อน แล้วให้ Figma Plugin สร้าง Frame, Text, Vector และ Image ตามผลที่ Chrome แสดง

จุดเด่น:

- ใช้ได้กับ HTML ที่สร้างด้วย JavaScript หรือ React
- ตรวจขนาดดีไซน์ให้อัตโนมัติ รวมถึงหน้าจอยาวและไฟล์ที่มีหลายหน้าจอ
- ข้อความไทยและจุดตัดบรรทัดใกล้เคียง Chrome
- ไม่แปลงทั้งหน้าเป็น SVG จึงลดปัญหา layout และฟอนต์เพี้ยนใน Figma
- ทำงานในเครื่อง ไม่ส่งไฟล์ออกอินเทอร์เน็ต

## สิ่งที่ต้องมี

- Windows และ PowerShell
- Node.js 18 ขึ้นไป
- Google Chrome หรือ Microsoft Edge
- Figma Desktop
- ฟอนต์ที่หน้าเว็บใช้ ติดตั้งใน Windows แล้ว

> HTML อาจฝังฟอนต์ไว้และแสดงใน Chrome ได้ แต่ Figma ใช้ฟอนต์ที่ติดตั้งอยู่ในเครื่องเท่านั้น

## ติดตั้งครั้งแรก

เปิด PowerShell ในโฟลเดอร์โปรเจกต์ แล้วรัน:

```powershell
npm install
```

จากนั้นติดตั้ง Plugin ใน Figma Desktop:

1. ไปที่ **Plugins → Development → Import plugin from manifest…**
2. เลือก `figma-plugin/manifest.json`
3. Plugin จะแสดงชื่อ **HTML to Figma (Playwright capture)**

## วิธีใช้งาน

### 1. เปิด Local Helper

```powershell
npm run helper
```

หน้าต่างจะแสดง URL และ token เช่น:

```text
listening on http://localhost:43127
token: <ข้อความสุ่ม>
```

เปิดหน้าต่างนี้ทิ้งไว้ระหว่างใช้งาน ปิดได้ด้วย `Ctrl+C`

### 2. เชื่อม Plugin

1. เปิด **Plugins → Development → HTML to Figma (Playwright capture)**
2. วาง token จากหน้าต่าง Local Helper แล้วกด **Connect**
3. รอจนสถานะแสดง **Local Helper: Connected**

Token ใช้ยืนยันว่า request มาจาก Plugin บนเครื่องเดียวกัน และจะเปลี่ยนทุกครั้งที่เปิด Helper ใหม่

### 3. เลือก HTML และ Import

1. ลากไฟล์ HTML ลงใน Plugin หรือกด **Choose HTML**
2. กด **Convert & Import**
3. รอจนสถานะเป็น **Complete**

กระบวนการทำงาน:

```text
HTML → Local Helper → Chrome + Playwright → design data → Figma Plugin → Editable layers
```

หลัง Import Plugin จะแสดงขนาด Design, จำนวน Layer, Layer ที่สร้างไม่สำเร็จ, ฟอนต์ที่ถูกแทน และ feature ที่ยังไม่รองรับ

หากไฟล์มีหลายหน้าจอ Plugin จะให้เลือก Import หน้าจอเดียวหรือทุกหน้าจอ

## การทำงานโดยย่อ

1. Plugin ส่งไฟล์ HTML ไปที่ Local Helper ผ่าน `http://localhost:43127`
2. Local Helper เปิดไฟล์ด้วย Chrome ผ่าน Playwright
3. Chrome รัน JavaScript และจัด layout จนหน้าแสดงเสร็จ
4. ระบบอ่านตำแหน่ง ขนาด สี ฟอนต์ รูป และ Vector ที่ Chrome คำนวณแล้ว
5. ข้อมูลถูกส่งกลับ Plugin ในรูปแบบ JSON
6. Plugin สร้าง Layer ใน Figma ตามข้อมูลนั้น
7. ไฟล์ชั่วคราวถูกลบเมื่อทำงานเสร็จหรือเกิดข้อผิดพลาด

`localhost` หมายถึงเครื่องของผู้ใช้เอง Helper รับการเชื่อมต่อเฉพาะในเครื่อง และต้องมี token ทุก request

## ฟอนต์

ติดตั้งฟอนต์ที่ HTML ใช้ให้ครบก่อน Import เช่น DB Ozone X, IBM Plex Sans Thai, Anuphan หรือ Noto Sans Thai

ถ้า Figma หาฟอนต์ไม่เจอ Plugin จะแทนด้วยฟอนต์อื่นและแจ้งในผลลัพธ์หลัง Import

## ปัญหาที่พบบ่อย

| อาการ | วิธีแก้ |
| --- | --- |
| `Local Helper: Not running` | รัน `npm run helper` แล้วกด **Retry connection** |
| Plugin ขอ token ใหม่ | Helper ถูกเปิดใหม่ ให้คัดลอก token ล่าสุดมาวาง |
| `Port 43127 already used` | มี Helper เปิดอยู่แล้ว ให้ใช้หน้าต่างเดิมหรือปิด process ที่ใช้ port นี้ |
| หา Chrome หรือ Edge ไม่พบ | ติดตั้ง Chrome/Edge หรือตั้งค่า `CHROME_PATH` |
| Capture เกิน 5 นาที | รัน `npm run helper -- --timeout 10` |
| HTML ใหญ่กว่า 100 MB | รัน `npm run helper -- --max-mb 200` |
| ฟอนต์ใน Figma ไม่ตรง | ติดตั้งฟอนต์และเปิด Figma ใหม่ |

ถ้า PowerShell แจ้งว่าไม่อนุญาตให้รัน script ให้ใช้ `npm.cmd` แทน `npm`

## วิธีสำรอง: Capture ด้วยคำสั่ง

สร้าง `design.json` ก่อนด้วย:

```powershell
npm run capture -- "C:\path\to\design.html"
```

ผลลัพธ์อยู่ใน `out\<ชื่อไฟล์>\<กว้าง>x<สูง>\`

| ไฟล์ | หน้าที่ |
| --- | --- |
| `design.json` | ข้อมูลสำหรับ Import เข้า Figma |
| `reference.png` | ภาพที่ Chrome วาด ใช้ตรวจเทียบ |
| `capture-report.json` | รายงานขนาด ฟอนต์ fallback และ feature ที่ไม่รองรับ |

นำ `design.json` เข้า Figma โดยเปิดส่วน **Advanced / Fallback** ใน Plugin แล้วกด **Import design.json**

## ตัวเลือกเพิ่มเติม

```powershell
# Capture ทุกหน้าจอในไฟล์
npm run capture -- "C:\path\to\design.html" --design-root all

# ขยายกล่องที่มี scroll
npm run capture -- "C:\path\to\design.html" --expand ".panel"

# บังคับ element ให้เป็นภาพ เช่น chart หรือแผนที่
npm run capture -- "C:\path\to\design.html" --raster ".chart,.my-map"

# รอหน้า render เพิ่มอีก 3 วินาที
npm run capture -- "C:\path\to\design.html" --wait 3000
```

ดูตัวเลือกทั้งหมด:

```powershell
npm run capture -- --help
npm run helper -- --help
```

## สิ่งที่รองรับ

- Bundled HTML และหน้าที่ render ด้วย JavaScript/React
- ขนาด Design อัตโนมัติ หน้ายาว และหลายหน้าจอ
- Frame, สีพื้น, border, radius, shadow และ overflow
- Text ที่แก้ไขได้ รวมข้อความไทยและข้อความหลายฟอนต์
- Inline SVG เป็น Vector
- `::before` และ `::after` แบบพื้นฐาน
- รูปภาพ, gradient, canvas และแผนที่ โดยใช้ภาพเฉพาะส่วนที่จำเป็น

## ข้อจำกัดปัจจุบัน

- Layer ใช้พิกัดจาก Chrome ยังไม่ใช่ Auto Layout
- z-index/stacking context ที่ซับซ้อนอาจไม่ตรงทั้งหมด
- `backdrop-filter`, `filter`, `mask` และ `clip-path` ยังรองรับไม่ครบ
- transform บน element ที่มีลูกอาจคลาดเคลื่อน
- `position: fixed` และ `sticky` ใช้ตำแหน่งขณะ Capture
- Baseline ตัวอักษรระหว่าง Chrome กับ Figma อาจต่างกันประมาณ 1px

ข้อจำกัดและ fallback ที่เกิดขึ้นจริงจะแสดงในผลลัพธ์หลัง Import

## สำหรับผู้พัฒนา

```powershell
npm test
npm run test:regression
npm run test:helper
npm run test:plugin
```

โครงสร้างหลัก:

```text
capture/        Capture HTML ด้วย Chrome + Playwright
local-helper/   เชื่อม Figma Plugin กับ Capture ในเครื่อง
figma-plugin/   สร้าง Layer ใน Figma
schema/         รูปแบบของ design data
test/           Automated tests
regression/     Baseline สำหรับตรวจผลย้อนหลัง
spikes/         Prototype และ reference เดิม
```

ดูรายละเอียดเพิ่มเติมที่ [ARCHITECTURE.md](ARCHITECTURE.md)

## License

MIT — ดูรายละเอียดใน [LICENSE](LICENSE)
