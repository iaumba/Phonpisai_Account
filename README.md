# ระบบบันทึกการใช้รถ โพนพิสัย — คู่มือติดตั้งและใช้งาน (ไฟล์เดียวจบ)

ระบบบันทึกรายการใช้รถ (เข้า / ออก / เติมน้ำมัน) จากภาพที่ส่งใน LINE
อ่านค่าด้วย Gemini แล้วบันทึกลง Google Sheets — ออกแบบให้รองรับ Web Dashboard ผ่าน AppSheet

> สถาปัตยกรรมใช้ **Cloudflare Worker** เป็นสะพาน (bridge) ระหว่าง LINE กับ Google Apps Script
> ทำให้ LINE ได้รับ HTTP 200 ทันที (LINE บังคับต้องตอบ 200 เร็ว) ส่วน GAS แบบ Web App จะตอบ 302 แทน 200
> จึงต้องมีตัวกลางตอบแทน LINE ให้เสมอ

---

## 1. ภาพรวมสถาปัตยกรรม

```
ผู้ใช้ส่งรูปใน LINE
        │
        ▼
LINE Platform ───► Cloudflare Worker (bridge) ──► Google Apps Script (Web App /exec)
   webhook URL =       ตอบ 200 ทันที +               doPost(e) → เขียนชีท Log (status=queued)
   Worker URL          forward เบื้องหลัง (waitUntil)
                                               │
                                               ▼
                              Time-Driven Trigger (ทุก 1 นาที) → processQueuedMessages()
                                จับกลุ่มรูป (sender + GAP_MINUTES) = 1 เหตุการณ์
                                รอภาพครบชุด (WAIT_MINUTES) แล้วประมวลผล:
                                  1. ดาวน์โหลดรูปจาก LINE CDN
                                  2. Gemini วิเคราะห์ (เลขไมล์ / %น้ำมัน / ข้อมูลบิล)
                                  3. ระบุรถ (ชีท ผู้รับผิดชอบรถ + เปรียบเทียบเลขไมล์)
                                  4. แยกเข้า/ออก (เทียบประวัติ; fallback = เวลา)
                                  5. เขียนชีท เหตุการณ์ (+ เติมน้ำมัน ถ้ามีบิล/เกจ)
                                  6. คัดลอกรูปบิลขึ้น Google Drive + เก็บ URL
                                  7. อัปเดต Log = done
```

- ไม่มีข้อความใดถูกส่งกลับเข้า LINE (ตอบ HTTP 200 กับ LINE server เท่านั้น)
- ข้อมูลเข้าชีทช้าสุดประมาณ 3–4 นาที (รอ trigger 1 นาที + WAIT_MINUTES 3 นาที)

---

## 2. ขั้นตอนติดตั้ง (จากศูนย์)

### 2.1 สร้าง Google Sheets จากไฟล์ต้นแบบ
1. อัปโหลด `บันทึกน้ำมัน.xlsx` ขึ้น Google Drive
2. เปิดด้วย Google Sheets (แปลงเป็นชีตอัตโนมัติ)
3. เช็คให้มี 4 ชีทชื่อตรง:
   - `ผู้รับผิดชอบรถ` / `เหตุการณ์` / `เติมน้ำมัน` / `Log`
4. คัดลอก **Sheet ID** จาก URL (ส่วน `/d/<ID>/edit`)
   > ครั้งแรกที่ระบบรัน จะตั้งค่าอัตโนมัติ: โซนเวลา Asia/Bangkok + ฟอร์แมตคอลัมน์วันที่/เวลาเป็น `dd/MM/yyyy HH:mm:ss`
   > (เคยมีปัญหาชีทถูกตั้งเป็น timezone อื่นทำให้เวลาผิด — โค้ดจัดการให้แล้ว)

### 2.2 สร้าง Apps Script Project
1. เปิด Google Sheets → **ส่วนขยาย (Extensions) → Apps Script**
2. ลบโค้ดตัวอย่าง → วางโค้ดทั้งหมดจาก `บันทึกน้ำมัน.gs`
3. ตั้งชื่อโปรเจกต์ เช่น `บันทึกน้ำมัน โพนพิสัย`

### 2.3 ตั้งค่า ScriptProperties
ไปที่ **Project Settings → Script Properties → Add property**:

| Property | ค่าที่ต้องตั้ง | หมายเหตุ |
|----------|--------------|----------|
| `LINE_ACCESS_TOKEN` | Channel access token | ต้องเป็น token ของบอทแชนแนล **เดียวกับที่ตั้ง webhook** (ดู 2.7) |
| `GOOGLE_SHEET_ID` | Sheet ID จากข้อ 2.1 | ระบุสเปรดชีตที่บันทึก |
| `FOLDER_ID` | ID โฟลเดอร์ Drive สำหรับเก็บรูปบิล | แชร์ให้โฟลเดอร์นี้เข้าถึงได้ |
| `GEMINI_API_KEY` | API Key จาก Google AI Studio | https://aistudio.google.com |

> ⚠️ **ข้อผิดพลาดที่เจอบ่อย:** ใช้ `LINE_ACCESS_TOKEN` ของบอทคนละแชนแนล → LINE คืน `400 Bad request`
> ตอนดาวน์โหลดรูป (auth ผ่านแต่รูปไม่ได้เป็นของแชนแนลนี้) — ต้องใช้ token ของแชนแนลเดียวกับที่รับ webhook เดียวกันเสมอ

**ค่า config เพิ่มเติม (ไม่ตั้งก็ได้ ใช้ default):**

| Property | default | ความหมาย |
|----------|---------|----------|
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | ชื่อรุ่น Gemini หลัก (เช็ครุ่นจริงใน AI Studio) — หากตัวหลักแน่น/ปิด ระบบจะสลับใช้รุ่นสำรองอัตโนมัติ: `3.6-flash` → `3.7-flash` → `3.5-flash` → `3.5-flash-lite` → `3.1-flash-lite` |
| `WAIT_MINUTES` | `3` | รอเท่าไรจึงเริ่มประมวลผล (ให้ภาพมาครบชุด) |
| `GAP_MINUTES` | `10` | รูปจากคนเดียวกันห่างกันไม่เกินนี้ = เหตุการณ์เดียวกัน |
| `TZ` | `Asia/Bangkok` | เขตเวลาที่ใช้ |
| `SHEET_VEHICLES` / `SHEET_EVENTS` / `SHEET_FUEL` / `SHEET_LOG` | ตามชื่อชีทของไฟล์ | เปลี่ยนชื่อชีทได้โดยไม่ต้องแกะโค้ด |

### 2.4 ตรวจสอบรุ่น Gemini
1. เปิด https://aistudio.google.com → ดูรายการโมเดลที่เปิดใช้งาน
2. ถ้าไม่มีชื่อ `gemini-3.5-flash-lite` ให้ใช้รุ่นที่มีจริง เช่น `gemini-2.5-flash`
3. ตั้งค่า `GEMINI_MODEL` ใน Script Properties ตามชื่อจริง

### 2.5 Deploy Apps Script (Web app) และหมายเหตุ "ทุกครั้งที่แก้โค้ด"
1. **ทำให้ใช้งานได้ → การทำให้ใช้งานได้รายการใหม่ → Web app**
   - Execute as: **ฉัน (Me)**
   - Who has access: **ทุกคน (Anyone)** — LINE ไม่ได้ส่ง auth มาด้วย
2. คัดลอก **URL /exec** เช่น `https://script.google.com/macros/s/<id>/exec`

> 🔁 **วงรอบแก้โค้ดทุกครั้ง:**
> ใน UI ของ Google (ภาษาไทย) ไม่มีตัวเลือก "(HEAD)" — การแก้โค้ดในโปรเจกต์แล้ว **บันทึก** จะสร้างเวอร์ชันใหม่ตามเลข แต่ deployment เดิมยังชี้เวอร์ชันเก่า
> ดังนั้น**ทุกครั้งที่แก้โค้ด GAS ต้องทำครบ 3 ขั้น**:
> 1. แก้โค้ด → บันทึก → **การทำให้ใช้งานได้รายการใหม่** → ได้ URL `/exec` **ใหม่**
> 2. เปิด `worker.js` → แก้ `GAS_URL` ให้ชี้ URL ใหม่
> 3. Redeploy worker (ดู 2.6) → เปลี่ยน LINE webhook ให้ชี้ worker URL เดิม **ไม่ต้องแก้** (หาแค่ URL เดิม worker เดิม)

### 2.6 สร้าง Cloudflare Worker (bridge `fleet`)
1. เข้า **Cloudflare Dashboard → Workers & Pages → สร้างแอปพลิเคชัน (Create)** → ตั้งชื่อ เช่น `fleet`
2. กด **แก้ไขโค้ด (Edit code)** → ลบโค้ดตัวอย่าง → วางโค้ดนี้ทับ:

```javascript
const GAS_URL = 'https://script.google.com/macros/s/AKfycbz4i0kEs59CS87eRAkEWTfXJR1lTAmOYjcq3WezcfU90QeZekz1p1_9B6P0gIda1oxI/exec';

export default {
  async fetch(request, env, ctx) {
    let raw = '';
    try {
      raw = await request.text();
    } catch (e) {}

    ctx.waitUntil(
      fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw
      }).then((r) => r.text()).catch((e) => console.error('GAS forward error:', String(e)))
    );

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
```

> แทนที่ `GAS_URL` ด้วย URL `/exec` ของตัวเอง (ข้อ 2.5) แยกกันหนังเป็นเลน

3. กด **Deploy** (มุมขวาบน) → รอข้อความ "Deployment created"
4. โน้ต URL ที่ได้ เช่น `https://fleet.thongsuk.workers.dev/`
5. ตรวจว่า deploy สำเร็จ: เปิด URL ในเบราว์เซอร์ → ต้องเห็น `{"success":true}`
   (ถ้ายังเห็น error แบบ debug เก่า = deploy ยังไม่เรียบร้อย)

> 💬 การส่ง 200 ทันที: worker กดรับ LINE ก่อนแล้วค่อย forward ไป GAS เบื้องหลัง —
> LINE ไม่เห็นความล่าช้าของ GAS และจะไม่ retry ซ้ำ

### 2.7 ตั้งค่า LINE Channel
1. เปิด **LINE Developers → Messaging API Channel** (ของบอทที่ผู้ใช้ส่งรูปมาให้)
2. หน้า **Messaging API**:
   - เปิด **Use webhook**
   - **Webhook URL** = **URL ของ Worker** (ข้อ 2.6) — *ไม่ใช่ URL ของ GAS /exec ตรงๆ*
   - กด **Verify** → ควรได้ความสำเร็จ (worker ตอบ 200)
   - ปิด Auto-reply / Greeting ถ้าไม่ให้ LINE รบกวน
3. ตั้ง **Channel access token** ในหน้าเดียวกัน → ใช้คัดลอกไปใส่ `LINE_ACCESS_TOKEN` (ข้อ 2.3)
   - **ต้องเป็นแชนแนลเดียวกับข้อนี้เท่านั้น**

### 2.8 ติดตั้ง Trigger (Worker ประมวลผลคิว)
Apps Script → **ล็อค (Trigger)** → **Add Trigger**:
- Function: `processQueuedMessages` ｜ Time-driven ｜ Minutes timer **ทุก 1 นาที**
- หรือรัน `installTimeTrigger()` ด้วยมือครั้งเดียว

### 2.9 เติมข้อมูลผู้รับผิดชอบรถ
ในชีท `ผู้รับผิดชอบรถ` (ห้ามเกิน 10 คน / 10 คัน):

| line_id | name | plate |
|---------|------|-------|
| Uxxxxxxxxxxx | สมชาย | งx 6956 กรุงเทพฯ |

- `line_id` = userId ผู้ส่ง (ดูใน Log หลังส่งรูปครั้งแรก)
- `plate` = ทะเบียนรถประจำของคนนั้น

### 2.10 ทดสอบระบบ
1. ส่งรูปจริงจาก LINE (เกจ/เลขไมล์ หรือชุดเติมน้ำมัน: เกจก่อน-บิล-เกจหลัง)
2. รอ ~4–5 นาที → เช็คชีท `Log` = `done` → `เหตุการณ์` มีแถว → (ถ้ามีบิล) `เติมน้ำมัน` + ไฟล์ใน Drive

---

## 3. โครงสร้างข้อมูล

| ชีท | หัวคอลัมน์ |
|-----|-----------|
| `ผู้รับผิดชอบรถ` | `line_id` (Key) ｜ `name` ｜ `plate` |
| `เหตุการณ์` | `event_id` (Key) ｜ `timestamp` ｜ `event_time` ｜ `event_type` ｜ `sender_line_id` ｜ `plate` ｜ `mileage_km` ｜ `fuel_pct` ｜ `error_note` |
| `เติมน้ำมัน` | `event_id` (Key) ｜ `fuel_before_pct` ｜ `fuel_after_pct` ｜ `amount_baht` ｜ `price_per_liter` ｜ `liters` ｜ `district` ｜ `receipt_url` ｜ `error_note` ｜ `gauge_before_url` ｜ `gauge_after_url` |
| `Log` | `message_id` (Key) ｜ `sender_line_id` ｜ `event_id` ｜ `status` ｜ `error_log` ｜ `received_at` |

- `event_type`: `เข้า` / `ออก` / `เติมน้ำมัน`
- `fuel_pct`: ระดับน้ำมันของเหตุการณ์นั้น (เติม = ค่าหลังเติม, เข้า/ออก = ค่าเกจที่อ่านได้) — กรอกอัตโนมัติถ้าภาพเห็นเกจ
- คอลัมน์ตัวเลขที่อ่านไม่ได้ → **เว้นว่าง** (ห้ามใส่ `-` เพื่อให้ AppSheet เดาประเภทได้)
- `Log.status`: `queued` → `done` / `error` ; `message_id` กันบันทึกซ้ำ
- `error_log`: error ถ้ามี หรือ **สรุปผลวิเคราะห์รายภาพ** เช่น `img1:odometer,มิล62534 | img2:receipt,บิล1000 | img3:fuel_gauge,%50` (ใช้วินิจฉัยว่าอ่านรูปใดได้/ไม่ได้)

---

## 4. กฎการทำงานที่ฝังในโค้ด

| เรื่อง | พฤติกรรม |
|-------|---------|
| ระบุรถ | 1) ใช้ `ผู้รับผิดชอบรถ` ตาม line_id 2) ถ้าไมล์ไม่ตรงรถประจำ → เทียบประวัติไมล์คันอื่น |
| แยกเข้า/ออก | สลับกับเหตุการณ์ล่าสุดของคัน (ถ้าไม่มีประวัติ: ก่อนเที่ยง=ออก / หลังเที่ยง=เข้า) |
| รูปเกจ 1 ใบ | ถือเป็นภาพ "หลังเติม" |
| ระดับน้ำมัน (%) | เก็บทุกเหตุการณ์: กรณีเติม = ค่าหลังเติม, เข้า/ออก = ค่าเกจที่อ่านได้; อ่านจากทุกภาพที่เห็นเข็ม (รวมรูปแผงมีทั้งไมล์+เกจ) |
| upload รูป | บิล + เกจก่อน/หลังเติม ขึ้น Drive ทั้งหมด (ชื่อ ทะเบียน_เวลา, ต่อท้าย _before/_after) เก็บ URL ในชีท เติมน้ำมัน |
| เวลาบิล | ใช้เวลาบนใบเสร็จ → แปลงเป็น ค.ศ.; อ่านไม่ได้ใช้เวลา LINE |
| ชื่อไฟล์บิลใน Drive | `ทะเบียน_ปีคศ.เดือนวัน_ชั่วโมงนาที` เช่น `6956_20260923_1539.jpg` |
| บันทึก error | ลงคอลัมน์ `error_note` / `error_log` เสมอ (แสดงเหตุผลจริง เช่น error จาก Gemini) |
| โซนเวลา/ฟอร์แมต | `setupSheet_()` รันอัตโนมัติครั้งแรก: ตั้งชีตเป็น Asia/Bangkok + ฟอร์แมตวันที่เป็น `dd/MM/yyyy HH:mm:ss`; เพิ่มคอลัมน์ `fuel_pct` ในชีท เหตุการณ์ ให้อัตโนมัติถ้ายังไม่มี |

---

## 5. การต่อเชื่อม AppSheet (ภายหลัง)

1. AppSheet → **Create app → Choose data** → เลือก Spreadsheet นี้
2. ลบ/ปิดตาราง `Log` (Data > Tables)
3. Key: `เหตุการณ์.event_id`, `เติมน้ำมัน.event_id`, `ผู้รับผิดชอบรถ.line_id`
4. Reference: `เหตุการณ์.sender_line_id` → `ผู้รับผิดชอบรถ.line_id`; `เติมน้ำมัน.event_id` → `เหตุการณ์.event_id`
5. สร้าง Views/Charts: filter `event_type`, กราฟ `amount_baht` / `liters`
6. ตั้ง security filter ตามผู้ใช้ตามต้องการ

---

## 6. การแก้ปัญหาเบื้องต้น (Troubleshooting)

| อาการ | สาเหตุ | วิธีแก้ |
|-------|--------|--------|
| LINE Verify ไม่ผ่าน / webhook ไม่เข้า | Worker ยังไม่ deploy หรือลง URL ผิด | เปิด URL worker ใน browser ต้องเห็น `{"success":true}` (ถ้าเห็น error เก่า = deploy ไม่สำเร็จ) |
| ไม่มีข้อมูลเข้า Sheets | Deploy GAS เป็นแบบใครๆ / webhook ชี้ผิด | Web app + Access=ทุกคน; webhook ชี้ URL Worker |
| Log = `error` + `ดาวน์โหลดรูปไม่สำเร็จ (400) Bad request` | **token ผิดแชนแนล/ผิดบอท** | ใช้ token ของแชนแนลเดียวกับที่ตั้ง webhook (ดู 2.7); ตรวจได้โดยโทร bot/info แล้วเปรียบเทียบชื่อบอท |
| `Gemini error (503) high demand` | Gemini ติดคิวชั่วคราว | ระบบลองซ้ำ + สลับโมเดลสำรองอัตโนมัติ; ถ้ายังพลาดส่งรูปใหม่ (จะเห็นผลวิเคราะห์รายภาพใน `Log.error_log`) |
| เวลาในชีทผิดโซน | ชีท timezone เดิมไม่ใช่ BKK | โค้ดใหม่ตั้งอัตโนมัติครั้งแรก; ตรวจ File → Settings → Timezone = Bangkok |
| รูปภาพมาไม่ครบเป็นเหตุการณ์เดียว | ส่งห่างกันเกิน `GAP_MINUTES` | เพิ่ม `GAP_MINUTES` (เช่น 15) |
| ข้อมูลช้าเกินคาด | Trigger 1 นาที + WAIT 3 นาที | ลด `WAIT_MINUTES` ถ้าอยากได้ไวขึ้น |
| AppSheet เดาประเภทคอลัมน์ผิด | มี `-` หรือ text ในคอลัมน์ตัวเลข | ใช้ค่าว่างแทน `-` |
| รายการซ้ำ | LINE retry / duplicate | ระบบกันซ้ำด้วย `message_id` อยู่แล้ว; เช็ค Log |

> 💡 **เคล็ดลับตรวจ token เร็ว:** `GET https://api.line.me/v2/bot/info` ด้วย Bearer token → หน้าชื่อบอท
> ต้องตรงกับชื่อบอทที่ตัวคุณเองคุย/ส่งรูปจริงในแอป LINE

---

## 7. ไฟล์ในโปรเจกต์

| ไฟล์ | หน้าที่ |
|------|--------|
| `บันทึกน้ำมัน.xlsx` | ต้นแบบ Google Sheets (4 ชีท) |
| `บันทึกน้ำมัน.gs` | โค้ด Google Apps Script ทั้งหมด |
| `worker.js` | โค้ด Cloudflare Worker (bridge) — deploy ผ่าน dashboard ของ worker `fleet` |
| `Prompt.md` | สเปก/กฎการทำงานของระบบ |

---

> หมายเหตุ: ระบบไม่ Verify LINE Signature (ตามข้อกำหนด); ข้อมูลแบบ Async — ผู้ใช้ต้องรอ 3–4 นาทีก่อนเห็นผล
> ชื่อโมเดล Gemini ควรยืนยันกับ AI Studio ว่ามีจริงก่อนใช้งานจริง