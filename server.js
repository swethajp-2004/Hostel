// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// ---------- POSTGRES SETUP ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Prevent crash on idle client errors
pool.on("error", (err) => {
  console.error("Unexpected PG pool error:", err);
});

// ---------- FILE UPLOAD (PHOTOS) ----------
const DATA_DIR = process.env.DATA_DIR || __dirname;
const uploadFolder = path.join(DATA_DIR, "uploads");
fs.mkdirSync(uploadFolder, { recursive: true });

// Serve uploaded images
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

// ---------- HELPERS ----------
async function runAsync(sql, params = []) {
  const r = await pool.query(sql, params);
  return { rowCount: r.rowCount, rows: r.rows };
}
async function getAsync(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows[0] || null;
}
async function allAsync(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
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

// ---------- DB INIT ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      hostel_code TEXT,
      name TEXT,
      address TEXT,
      course TEXT,
      phone TEXT,
      room_number TEXT,
      room_type TEXT,
      food_option TEXT,
      monthly_rent INTEGER DEFAULT 0,
      advance_paid INTEGER DEFAULT 0,
      advance_remaining INTEGER DEFAULT 0,
      date_join TEXT,
      date_leave TEXT,
      photo_path TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rent_payments (
      id SERIAL PRIMARY KEY,
      student_id INTEGER,
      date TEXT,
      rent_paid INTEGER DEFAULT 0,
      remaining INTEGER DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS extra_food (
      id SERIAL PRIMARY KEY,
      student_id INTEGER,
      date TEXT,
      amount INTEGER DEFAULT 0,
      remaining INTEGER DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      hostel_code TEXT,
      date TEXT,
      room_number TEXT,
      student_id INTEGER,
      status TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS monthly_accounts (
      id SERIAL PRIMARY KEY,
      hostel_code TEXT,
      student_id INTEGER,
      date TEXT,
      room_number TEXT,
      rent_paid INTEGER DEFAULT 0,
      rent_remaining INTEGER DEFAULT 0,
      eb_share INTEGER DEFAULT 0,
      eb_paid INTEGER DEFAULT 0,
      eb_remaining INTEGER DEFAULT 0
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_students_hostel ON students(hostel_code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_students_room ON students(hostel_code, room_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id, date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_room ON attendance(hostel_code, room_number, date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_monthly_accounts_student ON monthly_accounts(student_id, date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_monthly_accounts_room ON monthly_accounts(hostel_code, room_number, date)`);
}

// -------------------- ROUTES --------------------

// Get all ACTIVE students for a hostel (View All Students)
app.get("/api/students/list", async (req, res) => {
  const { hostel } = req.query;
  if (!hostel) return res.status(400).json({ success: false, message: "Missing hostel code" });

  try {
    const rows = await allAsync(
      `SELECT id, name, room_number
       FROM students
       WHERE hostel_code = $1 AND COALESCE(is_deleted, 0) = 0
       ORDER BY LOWER(name)`,
      [hostel]
    );
    res.json({ success: true, students: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB error listing students" });
  }
});

// Get OLD (deleted) students for a hostel
app.get("/api/students/old", async (req, res) => {
  const { hostel } = req.query;
  if (!hostel) return res.status(400).json({ success: false, message: "Missing hostel code" });

  try {
    const rows = await allAsync(
      `SELECT id, name, room_number, room_type, deleted_at
       FROM students
       WHERE hostel_code = $1 AND COALESCE(is_deleted, 0) = 1
       ORDER BY deleted_at DESC NULLS LAST, LOWER(name)`,
      [hostel]
    );
    res.json({ success: true, students: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB error listing old students" });
  }
});

// Restore a deleted student (UNDO)
app.post("/api/students/:id/restore", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await runAsync(`UPDATE students SET is_deleted = 0, deleted_at = NULL WHERE id = $1`, [id]);
    if (r.rowCount === 0) return res.json({ success: false, message: "Student not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error restoring student" });
  }
});

// PERMANENT DELETE (Old Students)
app.delete("/api/students/:id/permanent", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const row = await getAsync(`SELECT photo_path FROM students WHERE id = $1`, [id]);

    await runAsync(`DELETE FROM attendance WHERE student_id = $1`, [id]);
    await runAsync(`DELETE FROM extra_food WHERE student_id = $1`, [id]);
    await runAsync(`DELETE FROM rent_payments WHERE student_id = $1`, [id]);
    await runAsync(`DELETE FROM monthly_accounts WHERE student_id = $1`, [id]);

    const r = await runAsync(`DELETE FROM students WHERE id = $1`, [id]);
    if (r.rowCount === 0) return res.json({ success: false, message: "Student not found" });

    if (row && row.photo_path) {
      // photo_path is like "/uploads/filename.jpg"
      const filename = String(row.photo_path).replace(/^\/uploads\//, "");
      const abs = path.join(uploadFolder, filename);
      safeUnlinkIfExists(abs);
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error permanent deleting student" });
  }
});

// Get students by room type (ACTIVE only)
app.get("/api/students/by-roomtype", async (req, res) => {
  const { hostel, roomType } = req.query;
  if (!hostel || !roomType) return res.status(400).json({ success: false, message: "Missing hostel or roomType" });

  try {
    const rows = await allAsync(
      `SELECT id, name, room_number, room_type
       FROM students
       WHERE hostel_code = $1 AND room_type = $2 AND COALESCE(is_deleted, 0) = 0
       ORDER BY LOWER(name)`,
      [hostel, roomType]
    );
    res.json({ success: true, students: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB error listing by room type" });
  }
});

// Get students by room number (ACTIVE only)
app.get("/api/students/by-room", async (req, res) => {
  const { hostel, room } = req.query;
  if (!hostel || !room) return res.status(400).json({ success: false, message: "Missing hostel or room" });

  try {
    const rows = await allAsync(
      `SELECT id, name, room_number, room_type
       FROM students
       WHERE hostel_code = $1 AND room_number = $2 AND COALESCE(is_deleted, 0) = 0
       ORDER BY LOWER(name)`,
      [hostel, room]
    );
    res.json({ success: true, students: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB error listing by room" });
  }
});

// Search ACTIVE student by name + hostel
app.get("/api/students", async (req, res) => {
  const { hostel, name } = req.query;
  if (!hostel || !name) return res.status(400).json({ success: false, message: "Missing hostel or name" });

  try {
    const row = await getAsync(
      `SELECT *
       FROM students
       WHERE hostel_code = $1
         AND COALESCE(is_deleted, 0) = 0
         AND LOWER(name) = LOWER($2)
       LIMIT 1`,
      [hostel, name]
    );
    if (!row) return res.json({ success: false, message: "No student found" });
    res.json({ success: true, student: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB error" });
  }
});

// Get single student by ID (default active only; include deleted by ?includeDeleted=1)
app.get("/api/students/:id", async (req, res) => {
  const id = Number(req.params.id);
  const includeDeleted = String(req.query.includeDeleted || "").trim() === "1";

  try {
    const row = await getAsync(
      includeDeleted
        ? `SELECT * FROM students WHERE id = $1`
        : `SELECT * FROM students WHERE id = $1 AND COALESCE(is_deleted, 0) = 0`,
      [id]
    );
    if (!row) return res.json({ success: false, message: "Student not found" });
    res.json({ success: true, student: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB error fetching student" });
  }
});

// Add new student (FormData + optional photo)
// IMPORTANT: upload.single("photo") makes req.body available for FormData
app.post("/api/students", upload.single("photo"), async (req, res) => {
  try {
    const s = req.body || {};
    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;

    const result = await pool.query(
      `
      INSERT INTO students (
        hostel_code, name, address, course, phone,
        room_number, room_type, food_option,
        monthly_rent, advance_paid, advance_remaining,
        date_join, date_leave, photo_path,
        is_deleted, deleted_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,NULL)
      RETURNING *
      `,
      [
        (s.hostel_code || "").trim(),
        (s.name || "").trim(),
        (s.address || "").trim(),
        (s.course || "").trim(),
        (s.phone || "").trim(),
        (s.room_number || "").trim(),
        (s.room_type || "").trim(),
        (s.food_option || "").trim(),
        parseInt(s.monthly_rent || 0, 10),
        parseInt(s.advance_paid || 0, 10),
        parseInt(s.advance_remaining || 0, 10),
        (s.date_join || "").trim(),
        (s.date_leave || "").trim(),
        photoPath,
      ]
    );

    res.json({ success: true, student: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB error saving student" });
  }
});

// Update student (FormData + optional new photo)
app.put("/api/students/:id", upload.single("photo"), async (req, res) => {
  const id = Number(req.params.id);
  try {
    const s = req.body || {};

    const existing = await getAsync(`SELECT photo_path FROM students WHERE id = $1`, [id]);
    if (!existing) return res.json({ success: false, message: "Student not found" });

    const newPhotoPath = req.file ? `/uploads/${req.file.filename}` : null;
    const finalPhotoPath = newPhotoPath || existing.photo_path || null;

    const r = await runAsync(
      `
      UPDATE students
      SET hostel_code=$1, name=$2, address=$3, course=$4, phone=$5,
          room_number=$6, room_type=$7, food_option=$8,
          monthly_rent=$9, advance_paid=$10, advance_remaining=$11,
          date_join=$12, date_leave=$13, photo_path=$14
      WHERE id=$15
      `,
      [
        (s.hostel_code || "").trim(),
        (s.name || "").trim(),
        (s.address || "").trim(),
        (s.course || "").trim(),
        (s.phone || "").trim(),
        (s.room_number || "").trim(),
        (s.room_type || "").trim(),
        (s.food_option || "").trim(),
        parseInt(s.monthly_rent || 0, 10),
        parseInt(s.advance_paid || 0, 10),
        parseInt(s.advance_remaining || 0, 10),
        (s.date_join || "").trim(),
        (s.date_leave || "").trim(),
        finalPhotoPath,
        id,
      ]
    );

    if (r.rowCount === 0) return res.json({ success: false, message: "Student not found" });

    // If a new photo was uploaded, delete the old one file (optional cleanup)
    if (newPhotoPath && existing.photo_path && existing.photo_path.startsWith("/uploads/")) {
      const oldFilename = existing.photo_path.replace(/^\/uploads\//, "");
      safeUnlinkIfExists(path.join(uploadFolder, oldFilename));
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "DB error on update" });
  }
});

// Soft delete student
app.delete("/api/students/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await runAsync(
      `UPDATE students
       SET is_deleted = 1, deleted_at = $1
       WHERE id = $2 AND COALESCE(is_deleted, 0) = 0`,
      [nowIso(), id]
    );
    if (r.rowCount === 0) return res.json({ success: false, message: "Student not found (or already deleted)" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting student" });
  }
});

// -------------------- RENT PAYMENTS --------------------
app.get("/api/students/:id/rent", async (req, res) => {
  const studentId = Number(req.params.id);
  try {
    const rows = await allAsync(`SELECT * FROM rent_payments WHERE student_id = $1 ORDER BY id`, [studentId]);
    res.json({ success: true, entries: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching rent" });
  }
});

app.post("/api/students/:id/rent", async (req, res) => {
  const studentId = Number(req.params.id);
  const { date = "", rent_paid = 0, remaining = 0 } = req.body || {};
  try {
    const r = await pool.query(
      `INSERT INTO rent_payments (student_id, date, rent_paid, remaining)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [studentId, String(date), parseInt(rent_paid || 0, 10), parseInt(remaining || 0, 10)]
    );
    res.json({ success: true, entry: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error adding rent" });
  }
});

app.put("/api/rent_payments/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { date = "", rent_paid = 0, remaining = 0 } = req.body || {};
  try {
    const r = await runAsync(
      `UPDATE rent_payments SET date=$1, rent_paid=$2, remaining=$3 WHERE id=$4`,
      [String(date), parseInt(rent_paid || 0, 10), parseInt(remaining || 0, 10), id]
    );
    if (r.rowCount === 0) return res.json({ success: false, message: "Rent entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error updating rent" });
  }
});

app.delete("/api/rent_payments/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await runAsync(`DELETE FROM rent_payments WHERE id=$1`, [id]);
    if (r.rowCount === 0) return res.json({ success: false, message: "Rent entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting rent entry" });
  }
});

// -------------------- EXTRA FOOD --------------------
app.get("/api/students/:id/extra-food", async (req, res) => {
  const studentId = Number(req.params.id);
  try {
    const rows = await allAsync(`SELECT * FROM extra_food WHERE student_id=$1 ORDER BY id`, [studentId]);
    res.json({ success: true, entries: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching extra food" });
  }
});

app.post("/api/students/:id/extra-food", async (req, res) => {
  const studentId = Number(req.params.id);
  const { date = "", amount = 0, remaining = 0 } = req.body || {};
  try {
    const r = await pool.query(
      `INSERT INTO extra_food (student_id, date, amount, remaining)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [studentId, String(date), parseInt(amount || 0, 10), parseInt(remaining || 0, 10)]
    );
    res.json({ success: true, entry: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error adding extra food" });
  }
});

app.put("/api/extra_food/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { date = "", amount = 0, remaining = 0 } = req.body || {};
  try {
    const r = await runAsync(
      `UPDATE extra_food SET date=$1, amount=$2, remaining=$3 WHERE id=$4`,
      [String(date), parseInt(amount || 0, 10), parseInt(remaining || 0, 10), id]
    );
    if (r.rowCount === 0) return res.json({ success: false, message: "Extra food entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error updating extra food" });
  }
});

app.delete("/api/extra_food/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await runAsync(`DELETE FROM extra_food WHERE id=$1`, [id]);
    if (r.rowCount === 0) return res.json({ success: false, message: "Extra food entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting extra food entry" });
  }
});

// -------------------- ATTENDANCE --------------------
app.post("/api/rooms/:room/attendance", async (req, res) => {
  const room = String(req.params.room || "").trim();
  const { hostel_code, date = "", absent_ids = [] } = req.body || {};

  if (!hostel_code) return res.status(400).json({ success: false, message: "Missing hostel_code" });
  if (!room) return res.status(400).json({ success: false, message: "Missing room" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  const absentSet = new Set((absent_ids || []).map((x) => Number(x)));

  try {
    const students = await allAsync(
      `SELECT id FROM students
       WHERE hostel_code=$1 AND room_number=$2 AND COALESCE(is_deleted,0)=0`,
      [hostel_code, room]
    );

    for (const s of students) {
      const status = absentSet.has(Number(s.id)) ? "Absent" : "Present";

      const existing = await getAsync(
        `SELECT id FROM attendance
         WHERE hostel_code=$1 AND date=$2 AND room_number=$3 AND student_id=$4
         LIMIT 1`,
        [hostel_code, date, room, s.id]
      );

      if (existing) {
        await runAsync(`UPDATE attendance SET status=$1 WHERE id=$2`, [status, existing.id]);
      } else {
        await runAsync(
          `INSERT INTO attendance (hostel_code, date, room_number, student_id, status)
           VALUES ($1,$2,$3,$4,$5)`,
          [hostel_code, date, room, s.id, status]
        );
      }
    }

    res.json({ success: true, total_students: students.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error saving attendance" });
  }
});

app.get("/api/rooms/:room/attendance", async (req, res) => {
  const room = String(req.params.room || "").trim();
  const { hostel, date } = req.query || {};
  if (!hostel || !date) return res.status(400).json({ success: false, message: "Missing hostel or date" });

  try {
    const rows = await allAsync(
      `SELECT a.id, a.date, a.status, a.student_id, s.name
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE a.hostel_code=$1 AND a.room_number=$2 AND a.date=$3
       ORDER BY LOWER(s.name)`,
      [hostel, room, date]
    );
    res.json({ success: true, entries: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching attendance" });
  }
});

app.get("/api/students/:id/attendance", async (req, res) => {
  const studentId = Number(req.params.id);
  try {
    const rows = await allAsync(
      `SELECT id, hostel_code, date, room_number, status
       FROM attendance
       WHERE student_id=$1
       ORDER BY date DESC, id DESC`,
      [studentId]
    );
    res.json({ success: true, entries: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching student attendance" });
  }
});

app.put("/api/attendance/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { date = "", room_number = "", status = "" } = req.body || {};

  const statusClean = String(status || "").trim();
  if (statusClean !== "Present" && statusClean !== "Absent") {
    return res.status(400).json({ success: false, message: "Status must be Present or Absent" });
  }

  try {
    const r = await runAsync(
      `UPDATE attendance SET date=$1, room_number=$2, status=$3 WHERE id=$4`,
      [String(date), String(room_number), statusClean, id]
    );
    if (r.rowCount === 0) return res.json({ success: false, message: "Attendance row not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error updating attendance" });
  }
});

app.delete("/api/attendance/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await runAsync(`DELETE FROM attendance WHERE id=$1`, [id]);
    if (r.rowCount === 0) return res.json({ success: false, message: "Attendance row not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting attendance" });
  }
});

// -------------------- MONTHLY ACCOUNTS --------------------
app.get("/api/students/:id/monthly-account", async (req, res) => {
  const studentId = Number(req.params.id);
  try {
    const rows = await allAsync(
      `SELECT * FROM monthly_accounts WHERE student_id=$1 ORDER BY date DESC, id DESC`,
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
  const {
    hostel_code,
    date = "",
    room_number = "",
    rent_paid = 0,
    rent_remaining = 0,
    eb_share = 0,
    eb_paid = 0,
    eb_remaining = 0,
  } = req.body || {};

  if (!hostel_code) return res.status(400).json({ success: false, message: "Missing hostel_code" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  try {
    const r = await pool.query(
      `INSERT INTO monthly_accounts
       (hostel_code, student_id, date, room_number, rent_paid, rent_remaining, eb_share, eb_paid, eb_remaining)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        hostel_code,
        studentId,
        String(date),
        String(room_number),
        parseInt(rent_paid || 0, 10),
        parseInt(rent_remaining || 0, 10),
        parseInt(eb_share || 0, 10),
        parseInt(eb_paid || 0, 10),
        parseInt(eb_remaining || 0, 10),
      ]
    );
    res.json({ success: true, entry: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error adding monthly account" });
  }
});

app.put("/api/monthly_accounts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { date = "", room_number = "", rent_paid = 0, rent_remaining = 0, eb_share = 0, eb_paid = 0, eb_remaining = 0 } =
    req.body || {};

  try {
    const r = await runAsync(
      `UPDATE monthly_accounts
       SET date=$1, room_number=$2, rent_paid=$3, rent_remaining=$4, eb_share=$5, eb_paid=$6, eb_remaining=$7
       WHERE id=$8`,
      [
        String(date),
        String(room_number),
        parseInt(rent_paid || 0, 10),
        parseInt(rent_remaining || 0, 10),
        parseInt(eb_share || 0, 10),
        parseInt(eb_paid || 0, 10),
        parseInt(eb_remaining || 0, 10),
        id,
      ]
    );
    if (r.rowCount === 0) return res.json({ success: false, message: "Monthly entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error updating monthly account" });
  }
});

app.delete("/api/monthly_accounts/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await runAsync(`DELETE FROM monthly_accounts WHERE id=$1`, [id]);
    if (r.rowCount === 0) return res.json({ success: false, message: "Monthly entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting monthly account" });
  }
});

// EB batch (room-wise)
app.post("/api/rooms/:room/eb-batch", async (req, res) => {
  const room = String(req.params.room || "").trim();
  const { hostel_code, date = "", eb_total = 0 } = req.body || {};

  if (!hostel_code) return res.status(400).json({ success: false, message: "Missing hostel_code" });
  if (!room) return res.status(400).json({ success: false, message: "Missing room" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  const ebTotal = parseInt(eb_total || 0, 10);

  try {
    const students = await allAsync(
      `SELECT id FROM students
       WHERE hostel_code=$1 AND room_number=$2 AND COALESCE(is_deleted,0)=0
       ORDER BY id`,
      [hostel_code, room]
    );

    if (students.length === 0) return res.json({ success: false, message: "No active students in this room." });

    const ebShare = Math.floor(ebTotal / students.length);

    for (const s of students) {
      const existing = await getAsync(
        `SELECT id, eb_paid FROM monthly_accounts
         WHERE hostel_code=$1 AND student_id=$2 AND date=$3
         LIMIT 1`,
        [hostel_code, s.id, date]
      );

      if (existing) {
        const currentEbPaid = parseInt(existing.eb_paid || 0, 10);
        const newEbRemaining = Math.max(0, ebShare - currentEbPaid);

        await runAsync(
          `UPDATE monthly_accounts
           SET room_number=$1, eb_share=$2, eb_remaining=$3
           WHERE id=$4`,
          [room, ebShare, newEbRemaining, existing.id]
        );
      } else {
        await runAsync(
          `INSERT INTO monthly_accounts
           (hostel_code, student_id, date, room_number, rent_paid, rent_remaining, eb_share, eb_paid, eb_remaining)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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

// Room monthly list for date (used by frontend)
app.get("/api/rooms/:room/monthly-account", async (req, res) => {
  const room = String(req.params.room || "").trim();
  const { hostel, date } = req.query || {};

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
         ON ma.student_id = s.id AND ma.hostel_code = s.hostel_code AND ma.date = $1
       WHERE s.hostel_code = $2 AND s.room_number = $3 AND COALESCE(s.is_deleted,0)=0
       ORDER BY LOWER(s.name)`,
      [String(date), String(hostel), room]
    );

    res.json({ success: true, entries: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching room monthly account" });
  }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
