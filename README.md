# PMS Mockup Redesign — Deployable Prototype

ระบบประเมินผลงานพนักงานและอนุมัติเกรดประจำปี สำหรับทำ Prototype บน Git/Vercel โดยใช้ Google Apps Script + Google Sheets เป็น backend

## สิ่งที่ปรับจากไฟล์เดิม

- เพิ่ม `index.html` สำหรับ Login ด้วย Email + PIN
- แก้ `js/api.js` ไม่ใช้ `mode: no-cors` และไม่ mock success แล้ว
- เพิ่ม Vercel Serverless Proxy ที่ `api/gas-proxy.js` เพื่อส่ง request ไป Google Apps Script
- เพิ่ม `backend/Code.gs` เวอร์ชันใหม่สำหรับวางใน Apps Script
- เพิ่ม session token ฝั่ง GAS ผ่าน `CacheService`
- Backend ตรวจสิทธิ์จาก session ไม่เชื่อ `userId` / `deptScope` จาก frontend แล้ว
- เพิ่ม `upload_evidence_to_drive` เพื่อเก็บไฟล์หลักฐานใน Google Drive และเก็บเฉพาะ URL ลง Sheet
- เพิ่ม Audit Log และ System Log
- เพิ่ม Save Draft ฝั่ง Manager
- Backend คำนวณ `TotalScore` และ `InitGrade` ซ้ำเองก่อนบันทึก
- เพิ่ม `vercel.json`, `package.json`, `.gitignore`

## โครงสร้างไฟล์

```text
.
├── index.html
├── manager.html
├── director.html
├── js/
│   └── api.js
├── api/
│   └── gas-proxy.js
├── backend/
│   └── Code.gs
├── vercel.json
├── package.json
└── README.md
```

## การตั้งค่า Google Apps Script

1. เปิด Google Sheets ฐานข้อมูลประเมิน
2. ไปที่ Extensions > Apps Script
3. วางโค้ดจาก `backend/Code.gs`
4. ไปที่ Project Settings > Script Properties แล้วเพิ่มค่าเหล่านี้

```text
DB_EVAL_ID = Spreadsheet ID ของไฟล์ฐานข้อมูลประเมิน
DB_KPI_ID = Spreadsheet ID ของไฟล์ KPI_MASTER
EVIDENCE_FOLDER_ID = Folder ID ใน Google Drive สำหรับเก็บหลักฐาน
```

5. Deploy เป็น Web App
   - Execute as: Me
   - Who has access: Anyone หรือ Anyone within organization ตามสิทธิ์ที่ต้องการทดสอบ
6. Copy Web App URL ไปใช้ใน Vercel Environment Variable ชื่อ `GAS_WEBAPP_URL`

## Sheet ที่ต้องมีใน DB_EVAL_ID

### 1) Users

Header ขั้นต่ำ:

```text
Email | PIN (6 หลัก) | Role (Manager/Director) | UserID | Dept | Active
```

ตัวอย่าง:

```text
manager@company.com | 123456 | Manager | M7601 | ฝ่ายทรัพยากรบุคคล | TRUE
director@company.com | 654321 | Director | D001 | All | TRUE
```

หมายเหตุ:

- `UserID` ของ Manager ต้องตรงกับ `ManagerID` ในชีต Employees
- `Dept` ของ Director ใส่ `All` เพื่อเห็นทั้งหมด หรือใส่หลายแผนกโดยคั่นด้วย comma เช่น `ฝ่ายข่าว,ฝ่ายทรัพยากรบุคคล`

### 2) Employees

Header ที่ระบบใช้:

```text
รหัสพนักงาน | คำนำหน้า | ชื่อ | สกุล | ชื่อเล่น | แผนก | ตำแหน่ง | ManagerID
```

### 3) Eval_Data

ระบบจะสร้าง/เติม header ที่ขาดให้อัตโนมัติ แต่แนะนำให้มี:

```text
รหัสพนักงาน | TotalScore | InitGrade | AdjGrade | Reason | Status | Payload | SubmittedBy | SubmittedAt | ConfirmedBy | ConfirmedAt
```

### 4) Audit_Log และ System_Logs

ระบบจะสร้างให้อัตโนมัติถ้ายังไม่มี

## Sheet ที่ต้องมีใน DB_KPI_ID

### KPI_2026

Header ที่ระบบอ่านได้:

```text
รหัสพนักงาน | KPI_ID | ประเภท | รายละเอียด KPIs | หมายเหตุ | สูตรคำนวณ | น้ำหนัก (%) | 1 | 2 | 3 | 4 | 5
```

ถ้าไม่มี `KPI_ID` ระบบจะสร้าง ID ชั่วคราวเป็น `KPI_<รหัสพนักงาน>_<ลำดับ>`

## การตั้งค่า Vercel

1. Push project นี้ขึ้น GitHub
2. Import repo เข้า Vercel
3. ตั้ง Environment Variable:

```text
GAS_WEBAPP_URL = URL ของ Apps Script Web App
```

4. Deploy
5. เปิดหน้า `/` จะเจอ Login

## หมายเหตุสำคัญ

โปรเจกต์นี้เป็น Prototype ที่แก้ให้เหมาะกับการฝากบน Git/Vercel และทดสอบ flow จริงมากขึ้น แต่ยังไม่ใช่ระบบ Production เต็มรูปแบบสำหรับข้อมูลประเมินจริงทั้งองค์กร หากจะใช้จริงควรเพิ่มอย่างน้อย:

- Google Workspace SSO แทน PIN
- Permission model รายบริษัท/BU/ฝ่าย
- Data validation สำหรับ KPI ที่ไม่ใช่ตัวเลข
- Backup/restore policy
- Versioning ของคะแนนและการปรับเกรด
- Security review ก่อนเปิดใช้กับข้อมูลจริง
