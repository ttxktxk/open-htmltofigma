# Regression baseline

`npm run test:regression` ใช้หน้าจริงจาก Claude Design 2 หน้าที่ผ่านการ import ใน Figma แล้วเป็นเกณฑ์:

| baseline | Design size | ลักษณะ |
| --- | --- | --- |
| `fixed-screen-1920x992` | 1920×992 | หน้าจอความสูงคงที่ |
| `long-page-1920x2415` | 1920×2415 | หน้ายาว |

ไฟล์ HTML จริงเป็นงานของโปรเจกต์ จึง **ไม่ขึ้น git** (`regression/inputs/` อยู่ใน `.gitignore`) — วางไว้ในเครื่องเองแบบใดแบบหนึ่ง:

1. ตั้งชื่อไฟล์ตาม baseline: `regression\inputs\fixed-screen-1920x992.html`, `regression\inputs\long-page-1920x2415.html`
2. หรือคงชื่อไฟล์จริงไว้ แล้วสร้าง `regression\inputs\inputs.json` (ไม่ขึ้น git เช่นกัน) เพื่อจับคู่ชื่อ:

```json
{
  "fixed-screen-1920x992": "<ชื่อไฟล์จริงหน้า 1920x992>.html",
  "long-page-1920x2415": "<ชื่อไฟล์จริงหน้า 1920x2415>.html"
}
```

หรือชี้ไปที่โฟลเดอร์อื่น: `npm run test:regression -- --inputs "C:\path\to\folder"`

## ตรวจอะไรบ้าง (ต่อไฟล์)

1. Root Frame = Design size ที่ตรวจเจอจากไฟล์ (`data-screen-label`)
2. `capture\cli.js` ได้ design.json **เหมือน** `spikes\capture.js` บนเครื่องเดียวกัน (ไม่ถอยหลังจาก prototype ที่ผ่านแล้ว)
3. capture ซ้ำได้ normalized design.json เหมือนเดิม
4. จำนวน layer ตามชนิด, จำนวนบรรทัดของทุกข้อความ, ฟอนต์ที่ Chrome ใช้ และ CSS ที่ไม่รองรับ = `baselines.json`
5. วาด design.json กลับเป็นภาพ เทียบ `reference.png`: ความต่างด้าน layout ≤ `maxLayoutPct`
6. mock Figma import: plugin production สร้างครบทุก layer และได้ผลเหมือน plugin ของ spike

ผลอยู่ใน `regression\out\` (ไม่ขึ้น git)

## อัปเดต baseline

ทำเฉพาะเมื่อเปลี่ยนพฤติกรรมโดยตั้งใจและตรวจใน Figma แล้ว:

```powershell
npm run test:regression -- --update
```

แล้ว commit `regression\baselines.json` พร้อมเหตุผล
