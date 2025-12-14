// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");

const app = express();

// ---------- DATABASE SETUP ----------
const DATA_DIR = process.env.DATA_DIR || __dirname;
const dbPath = path.join(DATA_DIR, "hostel.db");
const db = new sqlite3.Database(dbPath);

// Helpers (SQLite)
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function ensureColumn(table, columnDef) {
  const colName = columnDef.trim().split(/\s+/)[0];
  const cols = await allAsync(`PRAGMA table_info(${table})`);
  const exists = cols.some((c) => c.name === colName);
  if (!exists) {
    await runAsync(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeUnlinkIfExists(absPath) {
  try {
    if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch (e) {
    console.error("Failed to delete file:", absPath, e);
  }
}

db.serialize(() => {
  // Students table (NOTE: old DBs might not have photo_path - we migrate below)
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hostel_code TEXT,
      name TEXT,
      address TEXT,
      course TEXT,
      phone TEXT,
      room_number TEXT,
      room_type TEXT,
      food_option TEXT,
      monthly_rent INTEGER,
      advance_paid INTEGER,
      advance_remaining INTEGER,
      date_join TEXT,
      date_leave TEXT,
      photo_path TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS rent_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER,
      date TEXT,
      rent_paid INTEGER,
      remaining INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS extra_food (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER,
      date TEXT,
      amount INTEGER,
      remaining INTEGER
    )
  `);

  // Attendance (room-wise marking; student-wise list)
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hostel_code TEXT,
      date TEXT,
      room_number TEXT,
      student_id INTEGER,
      status TEXT
    )
  `);

  // Monthly Rent/EB combined (student-wise rows; room-wise EB batch fills eb_share)
  db.run(`
    CREATE TABLE IF NOT EXISTS monthly_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hostel_code TEXT,
      student_id INTEGER,
      date TEXT,
      room_number TEXT,
      rent_paid INTEGER,
      rent_remaining INTEGER,
      eb_share INTEGER,
      eb_paid INTEGER,
      eb_remaining INTEGER
    )
  `);

  // Indexes (safe)
  db.run(`CREATE INDEX IF NOT EXISTS idx_students_hostel ON students(hostel_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_students_room ON students(hostel_code, room_number)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id, date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_room ON attendance(hostel_code, room_number, date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_monthly_accounts_student ON monthly_accounts(student_id, date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_monthly_accounts_room ON monthly_accounts(hostel_code, room_number, date)`);

  // ✅ MIGRATIONS (very important for old hostel.db)
  (async () => {
    try {
      // soft delete
      await ensureColumn("students", "is_deleted INTEGER NOT NULL DEFAULT 0");
      await ensureColumn("students", "deleted_at TEXT");

      // ✅ FIX FOR YOUR ERROR: old DB doesn't have photo_path
      await ensureColumn("students", "photo_path TEXT");
    } catch (e) {
      console.error("Error ensuring columns:", e);
    }
  })();
});
// ---------- FILE UPLOAD (PHOTOS) ----------
const uploadFolder = path.join(process.env.DATA_DIR || __dirname, "uploads");
try {
  fs.mkdirSync(uploadFolder, { recursive: true });
} catch (_) {}

// ✅ ADD THIS LINE HERE
app.use("/uploads", express.static(uploadFolder));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadFolder),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, base + ext);
  },
});
const upload = multer({ storage });


// ---------- MIDDLEWARE ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- ROUTES ----------

// -------------------- STUDENTS LISTS / SEARCH --------------------

// Get all ACTIVE students for a hostel (View All Students)
app.get("/api/students/list", (req, res) => {
  const { hostel } = req.query;
  if (!hostel) return res.status(400).json({ success: false, message: "Missing hostel code" });

  const sql = `
    SELECT id, name, room_number
    FROM students
    WHERE hostel_code = ? AND COALESCE(is_deleted, 0) = 0
    ORDER BY name COLLATE NOCASE
  `;
  db.all(sql, [hostel], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: "DB error listing students" });
    res.json({ success: true, students: rows });
  });
});

// Get OLD (deleted) students for a hostel
app.get("/api/students/old", (req, res) => {
  const { hostel } = req.query;
  if (!hostel) return res.status(400).json({ success: false, message: "Missing hostel code" });

  const sql = `
    SELECT id, name, room_number, room_type, deleted_at
    FROM students
    WHERE hostel_code = ? AND COALESCE(is_deleted, 0) = 1
    ORDER BY deleted_at DESC, name COLLATE NOCASE
  `;
  db.all(sql, [hostel], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: "DB error listing old students" });
    res.json({ success: true, students: rows });
  });
});

// Restore a deleted student (UNDO)
app.post("/api/students/:id/restore", async (req, res) => {
  const id = req.params.id;
  try {
    const r = await runAsync(`UPDATE students SET is_deleted = 0, deleted_at = NULL WHERE id = ?`, [id]);
    if (r.changes === 0) return res.json({ success: false, message: "Student not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error restoring student" });
  }
});

// ✅ PERMANENT DELETE (Old Students) — cannot undo
// Also deletes related rows + deletes stored photo file if exists
app.delete("/api/students/:id/permanent", async (req, res) => {
  const id = req.params.id;

  try {
    // ✅ after migration this column will exist; safe now
    const row = await getAsync(`SELECT photo_path FROM students WHERE id = ?`, [id]);

    // cleanup child tables
    await runAsync(`DELETE FROM attendance WHERE student_id = ?`, [id]);
    await runAsync(`DELETE FROM extra_food WHERE student_id = ?`, [id]);
    await runAsync(`DELETE FROM rent_payments WHERE student_id = ?`, [id]);
    await runAsync(`DELETE FROM monthly_accounts WHERE student_id = ?`, [id]);

    // delete student
    const r = await runAsync(`DELETE FROM students WHERE id = ?`, [id]);
    if (r.changes === 0) return res.json({ success: false, message: "Student not found" });

    // delete photo file
    if (row && row.photo_path) {
      const rel = String(row.photo_path).startsWith("/") ? row.photo_path.slice(1) : row.photo_path;
      const abs = path.join(__dirname, "public", rel);
      safeUnlinkIfExists(abs);
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error permanent deleting student" });
  }
});

// Get students by room type (ACTIVE only)
app.get("/api/students/by-roomtype", (req, res) => {
  const { hostel, roomType } = req.query;
  if (!hostel || !roomType) return res.status(400).json({ success: false, message: "Missing hostel or roomType" });

  const sql = `
    SELECT id, name, room_number, room_type
    FROM students
    WHERE hostel_code = ? AND room_type = ? AND COALESCE(is_deleted, 0) = 0
    ORDER BY name COLLATE NOCASE
  `;
  db.all(sql, [hostel, roomType], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: "DB error listing by room type" });
    res.json({ success: true, students: rows });
  });
});

// Get students by room number (ACTIVE only)
app.get("/api/students/by-room", (req, res) => {
  const { hostel, room } = req.query;
  if (!hostel || !room) return res.status(400).json({ success: false, message: "Missing hostel or room" });

  const sql = `
    SELECT id, name, room_number, room_type
    FROM students
    WHERE hostel_code = ? AND room_number = ? AND COALESCE(is_deleted, 0) = 0
    ORDER BY name COLLATE NOCASE
  `;
  db.all(sql, [hostel, room], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: "DB error listing by room" });
    res.json({ success: true, students: rows });
  });
});

// Get one ACTIVE student by name + hostel (search)
app.get("/api/students", (req, res) => {
  const { hostel, name } = req.query;
  if (!hostel || !name) return res.status(400).json({ success: false, message: "Missing hostel or name" });

  const sql = `
    SELECT * FROM students
    WHERE hostel_code = ?
      AND COALESCE(is_deleted, 0) = 0
      AND LOWER(name) = LOWER(?)
    LIMIT 1
  `;
  db.get(sql, [hostel, name], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: "DB error" });
    if (!row) return res.json({ success: false, message: "No student found" });
    res.json({ success: true, student: row });
  });
});

// Get single student by ID (default active only; include deleted by ?includeDeleted=1)
app.get("/api/students/:id", (req, res) => {
  const id = req.params.id;
  const includeDeleted = String(req.query.includeDeleted || "").trim() === "1";

  const sql = includeDeleted
    ? `SELECT * FROM students WHERE id = ?`
    : `SELECT * FROM students WHERE id = ? AND COALESCE(is_deleted, 0) = 0`;

  db.get(sql, [id], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: "DB error fetching student" });
    if (!row) return res.json({ success: false, message: "Student not found" });
    res.json({ success: true, student: row });
  });
});

// Add new student (with optional photo)
app.post("/api/students", upload.single("photo"), (req, res) => {
  const s = req.body;
  const photoPath = req.file ? `/uploads/${req.file.filename}` : null;

  const stmt = db.prepare(`
    INSERT INTO students (
      hostel_code, name, address, course, phone,
      room_number, room_type, food_option,
      monthly_rent, advance_paid, advance_remaining,
      date_join, date_leave, photo_path,
      is_deleted, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
  `);

  stmt.run(
    s.hostel_code,
    s.name,
    s.address,
    s.course,
    s.phone,
    s.room_number,
    s.room_type,
    s.food_option,
    parseInt(s.monthly_rent || "0", 10),
    parseInt(s.advance_paid || "0", 10),
    parseInt(s.advance_remaining || "0", 10),
    s.date_join || "",
    s.date_leave || "",
    photoPath,
    function (err) {
      if (err) return res.status(500).json({ success: false, message: "DB error" });
      res.json({
        success: true,
        student: {
          id: this.lastID,
          ...s,
          monthly_rent: parseInt(s.monthly_rent || "0", 10),
          advance_paid: parseInt(s.advance_paid || "0", 10),
          advance_remaining: parseInt(s.advance_remaining || "0", 10),
          photo_path: photoPath,
          is_deleted: 0,
          deleted_at: null,
        },
      });
    }
  );
});

// Update student details (and optionally photo)
app.put("/api/students/:id", upload.single("photo"), (req, res) => {
  const id = req.params.id;
  const s = req.body;
  const newPhotoPath = req.file ? `/uploads/${req.file.filename}` : null;

  db.get(`SELECT photo_path FROM students WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: "DB error" });

    const photoPath = newPhotoPath || (row ? row.photo_path : null);

    const stmt = db.prepare(`
      UPDATE students
      SET hostel_code = ?, name = ?, address = ?, course = ?, phone = ?,
          room_number = ?, room_type = ?, food_option = ?,
          monthly_rent = ?, advance_paid = ?, advance_remaining = ?,
          date_join = ?, date_leave = ?, photo_path = ?
      WHERE id = ?
    `);

    stmt.run(
      s.hostel_code,
      s.name,
      s.address,
      s.course,
      s.phone,
      s.room_number,
      s.room_type,
      s.food_option,
      parseInt(s.monthly_rent || "0", 10),
      parseInt(s.advance_paid || "0", 10),
      parseInt(s.advance_remaining || "0", 10),
      s.date_join || "",
      s.date_leave || "",
      photoPath,
      id,
      function (err2) {
        if (err2) return res.status(500).json({ success: false, message: "DB error on update" });
        res.json({ success: true });
      }
    );
  });
});

// Soft delete student
app.delete("/api/students/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const r = await runAsync(
      `UPDATE students SET is_deleted = 1, deleted_at = ? WHERE id = ? AND COALESCE(is_deleted, 0) = 0`,
      [nowIso(), id]
    );
    if (r.changes === 0) return res.json({ success: false, message: "Student not found (or already deleted)" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting student" });
  }
});

// -------------------- RENT PAYMENTS --------------------
app.get("/api/students/:id/rent", (req, res) => {
  const studentId = req.params.id;
  db.all(`SELECT * FROM rent_payments WHERE student_id = ? ORDER BY id`, [studentId], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: "DB error fetching rent" });
    res.json({ success: true, entries: rows });
  });
});

app.post("/api/students/:id/rent", (req, res) => {
  const studentId = req.params.id;
  const { date = "", rent_paid = 0, remaining = 0 } = req.body;

  const stmt = db.prepare(`
    INSERT INTO rent_payments (student_id, date, rent_paid, remaining)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(studentId, date, parseInt(rent_paid || "0", 10), parseInt(remaining || "0", 10), function (err) {
    if (err) return res.status(500).json({ success: false, message: "DB error adding rent" });
    res.json({
      success: true,
      entry: { id: this.lastID, student_id: Number(studentId), date, rent_paid: parseInt(rent_paid || "0", 10), remaining: parseInt(remaining || "0", 10) },
    });
  });
});

app.put("/api/rent_payments/:id", (req, res) => {
  const id = req.params.id;
  const { date = "", rent_paid = 0, remaining = 0 } = req.body;

  const stmt = db.prepare(`
    UPDATE rent_payments
    SET date = ?, rent_paid = ?, remaining = ?
    WHERE id = ?
  `);

  stmt.run(date, parseInt(rent_paid || "0", 10), parseInt(remaining || "0", 10), id, function (err) {
    if (err) return res.status(500).json({ success: false, message: "DB error updating rent" });
    if (this.changes === 0) return res.json({ success: false, message: "Rent entry not found" });
    res.json({ success: true });
  });
});

app.delete("/api/rent_payments/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const r = await runAsync(`DELETE FROM rent_payments WHERE id = ?`, [id]);
    if (r.changes === 0) return res.json({ success: false, message: "Rent entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting rent entry" });
  }
});

// -------------------- EXTRA FOOD --------------------
app.get("/api/students/:id/extra-food", (req, res) => {
  const studentId = req.params.id;
  db.all(`SELECT * FROM extra_food WHERE student_id = ? ORDER BY id`, [studentId], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: "DB error fetching extra food" });
    res.json({ success: true, entries: rows });
  });
});

app.post("/api/students/:id/extra-food", (req, res) => {
  const studentId = req.params.id;
  const { date = "", amount = 0, remaining = 0 } = req.body;

  const stmt = db.prepare(`
    INSERT INTO extra_food (student_id, date, amount, remaining)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(studentId, date, parseInt(amount || "0", 10), parseInt(remaining || "0", 10), function (err) {
    if (err) return res.status(500).json({ success: false, message: "DB error adding extra food" });
    res.json({
      success: true,
      entry: { id: this.lastID, student_id: Number(studentId), date, amount: parseInt(amount || "0", 10), remaining: parseInt(remaining || "0", 10) },
    });
  });
});

app.put("/api/extra_food/:id", (req, res) => {
  const id = req.params.id;
  const { date = "", amount = 0, remaining = 0 } = req.body;

  const stmt = db.prepare(`
    UPDATE extra_food
    SET date = ?, amount = ?, remaining = ?
    WHERE id = ?
  `);

  stmt.run(date, parseInt(amount || "0", 10), parseInt(remaining || "0", 10), id, function (err) {
    if (err) return res.status(500).json({ success: false, message: "DB error updating extra food" });
    if (this.changes === 0) return res.json({ success: false, message: "Extra food entry not found" });
    res.json({ success: true });
  });
});

app.delete("/api/extra_food/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const r = await runAsync(`DELETE FROM extra_food WHERE id = ?`, [id]);
    if (r.changes === 0) return res.json({ success: false, message: "Extra food entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting extra food entry" });
  }
});

// -------------------- ATTENDANCE --------------------
app.post("/api/rooms/:room/attendance", async (req, res) => {
  const room = req.params.room;
  const { hostel_code, date = "", absent_ids = [] } = req.body;

  if (!hostel_code) return res.status(400).json({ success: false, message: "Missing hostel_code" });
  if (!room) return res.status(400).json({ success: false, message: "Missing room" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  const absentSet = new Set((absent_ids || []).map((x) => Number(x)));

  try {
    const students = await allAsync(
      `SELECT id FROM students WHERE hostel_code = ? AND room_number = ? AND COALESCE(is_deleted,0)=0`,
      [hostel_code, room]
    );

    for (const s of students) {
      const status = absentSet.has(Number(s.id)) ? "Absent" : "Present";
      const existing = await getAsync(
        `SELECT id FROM attendance WHERE hostel_code=? AND date=? AND room_number=? AND student_id=? LIMIT 1`,
        [hostel_code, date, room, s.id]
      );

      if (existing) await runAsync(`UPDATE attendance SET status=? WHERE id=?`, [status, existing.id]);
      else
        await runAsync(
          `INSERT INTO attendance (hostel_code, date, room_number, student_id, status) VALUES (?,?,?,?,?)`,
          [hostel_code, date, room, s.id, status]
        );
    }

    res.json({ success: true, total_students: students.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error saving attendance" });
  }
});

app.get("/api/rooms/:room/attendance", async (req, res) => {
  const room = req.params.room;
  const { hostel, date } = req.query;
  if (!hostel || !date) return res.status(400).json({ success: false, message: "Missing hostel or date" });

  try {
    const rows = await allAsync(
      `SELECT a.id, a.date, a.status, a.student_id, s.name
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE a.hostel_code=? AND a.room_number=? AND a.date=?
       ORDER BY s.name COLLATE NOCASE`,
      [hostel, room, date]
    );
    res.json({ success: true, entries: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching attendance" });
  }
});

app.get("/api/students/:id/attendance", async (req, res) => {
  const studentId = req.params.id;
  try {
    const rows = await allAsync(
      `SELECT id, hostel_code, date, room_number, status
       FROM attendance
       WHERE student_id=?
       ORDER BY date DESC, id DESC`,
      [studentId]
    );
    res.json({ success: true, entries: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching student attendance" });
  }
});

// ✅ Edit single attendance row
app.put("/api/attendance/:id", async (req, res) => {
  const id = req.params.id;
  const { date = "", room_number = "", status = "" } = req.body;

  const statusClean = String(status || "").trim();
  if (statusClean !== "Present" && statusClean !== "Absent") {
    return res.status(400).json({ success: false, message: "Status must be Present or Absent" });
  }

  try {
    const r = await runAsync(
      `UPDATE attendance SET date = ?, room_number = ?, status = ? WHERE id = ?`,
      [date, room_number, statusClean, id]
    );
    if (r.changes === 0) return res.json({ success: false, message: "Attendance row not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error updating attendance" });
  }
});

// ✅ Delete single attendance row
app.delete("/api/attendance/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const r = await runAsync(`DELETE FROM attendance WHERE id = ?`, [id]);
    if (r.changes === 0) return res.json({ success: false, message: "Attendance row not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting attendance" });
  }
});

// -------------------- MONTHLY RENT / EB --------------------
app.get("/api/students/:id/monthly-account", async (req, res) => {
  const studentId = req.params.id;
  try {
    const rows = await allAsync(
      `SELECT * FROM monthly_accounts WHERE student_id=? ORDER BY date DESC, id DESC`,
      [studentId]
    );
    res.json({ success: true, entries: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching monthly account" });
  }
});

app.post("/api/students/:id/monthly-account", async (req, res) => {
  const studentId = Number(req.params.id);
  const { hostel_code, date = "", room_number = "", rent_paid = 0, rent_remaining = 0, eb_share = 0, eb_paid = 0, eb_remaining = 0 } = req.body;

  if (!hostel_code) return res.status(400).json({ success: false, message: "Missing hostel_code" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  try {
    const r = await runAsync(
      `INSERT INTO monthly_accounts
       (hostel_code, student_id, date, room_number, rent_paid, rent_remaining, eb_share, eb_paid, eb_remaining)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        hostel_code,
        studentId,
        date,
        room_number,
        parseInt(rent_paid || "0", 10),
        parseInt(rent_remaining || "0", 10),
        parseInt(eb_share || "0", 10),
        parseInt(eb_paid || "0", 10),
        parseInt(eb_remaining || "0", 10),
      ]
    );
    res.json({ success: true, entry: { id: r.lastID } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error adding monthly account" });
  }
});

app.put("/api/monthly_accounts/:id", async (req, res) => {
  const id = req.params.id;
  const { date = "", room_number = "", rent_paid = 0, rent_remaining = 0, eb_share = 0, eb_paid = 0, eb_remaining = 0 } = req.body;

  try {
    const r = await runAsync(
      `UPDATE monthly_accounts
       SET date=?, room_number=?, rent_paid=?, rent_remaining=?, eb_share=?, eb_paid=?, eb_remaining=?
       WHERE id=?`,
      [
        date,
        room_number,
        parseInt(rent_paid || "0", 10),
        parseInt(rent_remaining || "0", 10),
        parseInt(eb_share || "0", 10),
        parseInt(eb_paid || "0", 10),
        parseInt(eb_remaining || "0", 10),
        id,
      ]
    );
    if (r.changes === 0) return res.json({ success: false, message: "Monthly entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error updating monthly account" });
  }
});

app.delete("/api/monthly_accounts/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const r = await runAsync(`DELETE FROM monthly_accounts WHERE id=?`, [id]);
    if (r.changes === 0) return res.json({ success: false, message: "Monthly entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting monthly account" });
  }
});

app.post("/api/rooms/:room/eb-batch", async (req, res) => {
  const room = req.params.room;
  const { hostel_code, date = "", eb_total = 0 } = req.body;

  if (!hostel_code) return res.status(400).json({ success: false, message: "Missing hostel_code" });
  if (!room) return res.status(400).json({ success: false, message: "Missing room" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  const ebTotal = parseInt(eb_total || "0", 10);

  try {
    const students = await allAsync(
      `SELECT id FROM students WHERE hostel_code=? AND room_number=? AND COALESCE(is_deleted,0)=0 ORDER BY id`,
      [hostel_code, room]
    );

    if (students.length === 0) return res.json({ success: false, message: "No active students in this room." });

    const ebShare = Math.floor(ebTotal / students.length);

    for (const s of students) {
      const existing = await getAsync(
        `SELECT id, eb_paid FROM monthly_accounts WHERE hostel_code=? AND student_id=? AND date=? LIMIT 1`,
        [hostel_code, s.id, date]
      );

      if (existing) {
        const currentEbPaid = parseInt(existing.eb_paid || 0, 10);
        const newEbRemaining = Math.max(0, ebShare - currentEbPaid);

        await runAsync(`UPDATE monthly_accounts SET room_number=?, eb_share=?, eb_remaining=? WHERE id=?`, [
          room,
          ebShare,
          newEbRemaining,
          existing.id,
        ]);
      } else {
        await runAsync(
          `INSERT INTO monthly_accounts
           (hostel_code, student_id, date, room_number, rent_paid, rent_remaining, eb_share, eb_paid, eb_remaining)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [hostel_code, s.id, date, room, 0, 0, ebShare, 0, ebShare]
        );
      }
    }

    res.json({ success: true, room, date, total_students: students.length, eb_total: ebTotal, eb_share: ebShare });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error saving EB batch" });
  }
});

app.get("/api/rooms/:room/monthly-account", async (req, res) => {
  const room = req.params.room;
  const { hostel, date } = req.query;

  if (!hostel) return res.status(400).json({ success: false, message: "Missing hostel" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  try {
    const rows = await allAsync(
      `SELECT
         s.id AS student_id,
         s.name,
         s.room_number,
         s.room_type,
         s.monthly_rent,
         ma.id AS monthly_id,
         ma.date,
         COALESCE(ma.rent_paid, 0) AS rent_paid,
         COALESCE(ma.rent_remaining, 0) AS rent_remaining,
         COALESCE(ma.eb_share, 0) AS eb_share,
         COALESCE(ma.eb_paid, 0) AS eb_paid,
         COALESCE(ma.eb_remaining, 0) AS eb_remaining
       FROM students s
       LEFT JOIN monthly_accounts ma
         ON ma.student_id = s.id AND ma.hostel_code = s.hostel_code AND ma.date = ?
       WHERE s.hostel_code = ? AND s.room_number = ? AND COALESCE(s.is_deleted,0)=0
       ORDER BY s.name COLLATE NOCASE`,
      [date, hostel, room]
    );

    res.json({ success: true, entries: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching room monthly account" });
  }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

