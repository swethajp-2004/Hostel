// server.js (Postgres / Supabase)
const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();

// ---------- MIDDLEWARE (MUST be before routes) ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true })); // helps if frontend accidentally sends form-encoded
app.use(express.static(path.join(__dirname, "public")));

// ---------- OPTIONAL: uploads folder (you said you DON'T want to store images now) ----------
const uploadFolder = path.join(__dirname, "uploads");
try {
  fs.mkdirSync(uploadFolder, { recursive: true });
} catch (_) {}
app.use("/uploads", express.static(uploadFolder)); // safe even if unused

// ---------- POSTGRES CONNECTION ----------
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing. Add it in Render Environment Variables.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Prevent server crash when DB drops connections
pool.on("error", (err) => {
  console.error("❌ Unexpected Postgres idle client error:", err);
});

// ---------- HELPERS ----------
async function runAsync(sql, params = []) {
  const r = await pool.query(sql, params);
  return { changes: r.rowCount, rows: r.rows };
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

// ---------- DB INIT ----------
async function initDb() {
  // STUDENTS
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

  // RENT PAYMENTS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rent_payments (
      id SERIAL PRIMARY KEY,
      student_id INTEGER,
      date TEXT,
      rent_paid INTEGER DEFAULT 0,
      remaining INTEGER DEFAULT 0
    );
  `);

  // EXTRA FOOD
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extra_food (
      id SERIAL PRIMARY KEY,
      student_id INTEGER,
      date TEXT,
      amount INTEGER DEFAULT 0,
      remaining INTEGER DEFAULT 0
    );
  `);

  // ATTENDANCE
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

  // MONTHLY ACCOUNTS
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

  // Helpful indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_students_hostel ON students(hostel_code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_students_room ON students(hostel_code, room_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id, date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_room ON attendance(hostel_code, room_number, date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_monthly_accounts_student ON monthly_accounts(student_id, date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_monthly_accounts_room ON monthly_accounts(hostel_code, room_number, date)`);

  // Unique constraints for UPSERT (very important)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance
    ON attendance(hostel_code, date, room_number, student_id)
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_monthly_accounts
    ON monthly_accounts(hostel_code, student_id, date)
  `);

  console.log("✅ Database initialized");
}

// ---------- ROUTES ----------

// Health check (easy test)
app.get("/api/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({ success: true, db: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ success: false, message: "DB not reachable" });
  }
});

// -------------------- STUDENTS LISTS / SEARCH --------------------

// Get all ACTIVE students for a hostel
app.get("/api/students/list", async (req, res) => {
  const hostel = String(req.query.hostel || "").trim();
  if (!hostel) return res.status(400).json({ success: false, message: "Missing hostel code" });

  try {
    const rows = await allAsync(
      `
      SELECT id, name, room_number
      FROM students
      WHERE hostel_code = $1 AND COALESCE(is_deleted, 0) = 0
      ORDER BY name
      `,
      [hostel]
    );
    res.json({ success: true, students: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error listing students" });
  }
});

// Get OLD (deleted) students
app.get("/api/students/old", async (req, res) => {
  const hostel = String(req.query.hostel || "").trim();
  if (!hostel) return res.status(400).json({ success: false, message: "Missing hostel code" });

  try {
    const rows = await allAsync(
      `
      SELECT id, name, room_number, room_type, deleted_at
      FROM students
      WHERE hostel_code = $1 AND COALESCE(is_deleted, 0) = 1
      ORDER BY deleted_at DESC, name
      `,
      [hostel]
    );
    res.json({ success: true, students: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error listing old students" });
  }
});

// Restore student
app.post("/api/students/:id/restore", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await runAsync(`UPDATE students SET is_deleted = 0, deleted_at = NULL WHERE id = $1`, [id]);
    if (r.changes === 0) return res.json({ success: false, message: "Student not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error restoring student" });
  }
});

// Permanent delete student + all related rows
app.delete("/api/students/:id/permanent", async (req, res) => {
  const id = Number(req.params.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`DELETE FROM attendance WHERE student_id = $1`, [id]);
    await client.query(`DELETE FROM extra_food WHERE student_id = $1`, [id]);
    await client.query(`DELETE FROM rent_payments WHERE student_id = $1`, [id]);
    await client.query(`DELETE FROM monthly_accounts WHERE student_id = $1`, [id]);

    const r = await client.query(`DELETE FROM students WHERE id = $1`, [id]);
    await client.query("COMMIT");

    if (r.rowCount === 0) return res.json({ success: false, message: "Student not found" });
    res.json({ success: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ success: false, message: "DB error permanent deleting student" });
  } finally {
    client.release();
  }
});

// By room type
app.get("/api/students/by-roomtype", async (req, res) => {
  const hostel = String(req.query.hostel || "").trim();
  const roomType = String(req.query.roomType || "").trim();
  if (!hostel || !roomType) return res.status(400).json({ success: false, message: "Missing hostel or roomType" });

  try {
    const rows = await allAsync(
      `
      SELECT id, name, room_number, room_type
      FROM students
      WHERE hostel_code = $1 AND room_type = $2 AND COALESCE(is_deleted,0)=0
      ORDER BY name
      `,
      [hostel, roomType]
    );
    res.json({ success: true, students: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error listing by room type" });
  }
});

// By room
app.get("/api/students/by-room", async (req, res) => {
  const hostel = String(req.query.hostel || "").trim();
  const room = String(req.query.room || "").trim();
  if (!hostel || !room) return res.status(400).json({ success: false, message: "Missing hostel or room" });

  try {
    const rows = await allAsync(
      `
      SELECT id, name, room_number, room_type
      FROM students
      WHERE hostel_code = $1 AND room_number = $2 AND COALESCE(is_deleted,0)=0
      ORDER BY name
      `,
      [hostel, room]
    );
    res.json({ success: true, students: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error listing by room" });
  }
});

// Search by hostel + exact name (case-insensitive)
app.get("/api/students", async (req, res) => {
  const hostel = String(req.query.hostel || "").trim();
  const name = String(req.query.name || "").trim();
  if (!hostel || !name) return res.status(400).json({ success: false, message: "Missing hostel or name" });

  try {
    const row = await getAsync(
      `
      SELECT *
      FROM students
      WHERE hostel_code = $1
        AND COALESCE(is_deleted,0)=0
        AND LOWER(name) = LOWER($2)
      LIMIT 1
      `,
      [hostel, name]
    );
    if (!row) return res.json({ success: false, message: "No student found" });
    res.json({ success: true, student: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error searching student" });
  }
});

// Get student by id
app.get("/api/students/:id", async (req, res) => {
  const id = Number(req.params.id);
  const includeDeleted = String(req.query.includeDeleted || "") === "1";

  try {
    const row = includeDeleted
      ? await getAsync(`SELECT * FROM students WHERE id = $1`, [id])
      : await getAsync(`SELECT * FROM students WHERE id = $1 AND COALESCE(is_deleted,0)=0`, [id]);

    if (!row) return res.json({ success: false, message: "Student not found" });
    res.json({ success: true, student: row });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching student" });
  }
});

// Add new student (no image storage now)
app.post("/api/students", async (req, res) => {
  const s = req.body || {};
  try {
    if (!s.hostel_code) return res.status(400).json({ success: false, message: "hostel_code missing" });
    if (!s.name) return res.status(400).json({ success: false, message: "name missing" });

    const r = await pool.query(
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
        s.hostel_code || "",
        s.name || "",
        s.address || "",
        s.course || "",
        s.phone || "",
        s.room_number || "",
        s.room_type || "",
        s.food_option || "",
        parseInt(s.monthly_rent || 0, 10),
        parseInt(s.advance_paid || 0, 10),
        parseInt(s.advance_remaining || 0, 10),
        s.date_join || "",
        s.date_leave || "",
        null, // photo_path not used
      ]
    );

    res.json({ success: true, student: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error saving student" });
  }
});

// Update student
app.put("/api/students/:id", async (req, res) => {
  const id = Number(req.params.id);
  const s = req.body || {};
  try {
    const r = await runAsync(
      `
      UPDATE students
      SET hostel_code = $1, name = $2, address = $3, course = $4, phone = $5,
          room_number = $6, room_type = $7, food_option = $8,
          monthly_rent = $9, advance_paid = $10, advance_remaining = $11,
          date_join = $12, date_leave = $13
      WHERE id = $14
      `,
      [
        s.hostel_code || "",
        s.name || "",
        s.address || "",
        s.course || "",
        s.phone || "",
        s.room_number || "",
        s.room_type || "",
        s.food_option || "",
        parseInt(s.monthly_rent || 0, 10),
        parseInt(s.advance_paid || 0, 10),
        parseInt(s.advance_remaining || 0, 10),
        s.date_join || "",
        s.date_leave || "",
        id,
      ]
    );

    if (r.changes === 0) return res.json({ success: false, message: "Student not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error updating student" });
  }
});

// Soft delete student
app.delete("/api/students/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await runAsync(
      `UPDATE students SET is_deleted = 1, deleted_at = $1 WHERE id = $2 AND COALESCE(is_deleted,0)=0`,
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
  const body = req.body || {};
  const date = body.date || "";
  const rent_paid = parseInt(body.rent_paid || 0, 10);
  const remaining = parseInt(body.remaining || 0, 10);

  try {
    const r = await pool.query(
      `INSERT INTO rent_payments (student_id, date, rent_paid, remaining) VALUES ($1,$2,$3,$4) RETURNING *`,
      [studentId, date, rent_paid, remaining]
    );
    res.json({ success: true, entry: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error adding rent" });
  }
});

app.put("/api/rent_payments/:id", async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const date = body.date || "";
  const rent_paid = parseInt(body.rent_paid || 0, 10);
  const remaining = parseInt(body.remaining || 0, 10);

  try {
    const r = await runAsync(
      `UPDATE rent_payments SET date=$1, rent_paid=$2, remaining=$3 WHERE id=$4`,
      [date, rent_paid, remaining, id]
    );
    if (r.changes === 0) return res.json({ success: false, message: "Rent entry not found" });
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
    if (r.changes === 0) return res.json({ success: false, message: "Rent entry not found" });
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
  const body = req.body || {};
  const date = body.date || "";
  const amount = parseInt(body.amount || 0, 10);
  const remaining = parseInt(body.remaining || 0, 10);

  try {
    const r = await pool.query(
      `INSERT INTO extra_food (student_id, date, amount, remaining) VALUES ($1,$2,$3,$4) RETURNING *`,
      [studentId, date, amount, remaining]
    );
    res.json({ success: true, entry: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error adding extra food" });
  }
});

app.put("/api/extra_food/:id", async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const date = body.date || "";
  const amount = parseInt(body.amount || 0, 10);
  const remaining = parseInt(body.remaining || 0, 10);

  try {
    const r = await runAsync(`UPDATE extra_food SET date=$1, amount=$2, remaining=$3 WHERE id=$4`, [
      date,
      amount,
      remaining,
      id,
    ]);
    if (r.changes === 0) return res.json({ success: false, message: "Extra food entry not found" });
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
    if (r.changes === 0) return res.json({ success: false, message: "Extra food entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting extra food entry" });
  }
});

// -------------------- ATTENDANCE --------------------
app.post("/api/rooms/:room/attendance", async (req, res) => {
  const room = String(req.params.room || "").trim();
  const body = req.body || {};

  const hostel_code = body.hostel_code;
  const date = body.date || "";
  const absent_ids = Array.isArray(body.absent_ids) ? body.absent_ids : [];

  if (!hostel_code) return res.status(400).json({ success: false, message: "Missing hostel_code" });
  if (!room) return res.status(400).json({ success: false, message: "Missing room" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  const absentSet = new Set(absent_ids.map((x) => Number(x)));

  try {
    const students = await allAsync(
      `SELECT id FROM students WHERE hostel_code=$1 AND room_number=$2 AND COALESCE(is_deleted,0)=0`,
      [hostel_code, room]
    );

    for (const s of students) {
      const status = absentSet.has(Number(s.id)) ? "Absent" : "Present";

      await pool.query(
        `
        INSERT INTO attendance (hostel_code, date, room_number, student_id, status)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (hostel_code, date, room_number, student_id)
        DO UPDATE SET status = EXCLUDED.status
        `,
        [hostel_code, date, room, Number(s.id), status]
      );
    }

    res.json({ success: true, total_students: students.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error saving attendance" });
  }
});

app.get("/api/rooms/:room/attendance", async (req, res) => {
  const room = String(req.params.room || "").trim();
  const hostel = String(req.query.hostel || "").trim();
  const date = String(req.query.date || "").trim();

  if (!hostel || !date) return res.status(400).json({ success: false, message: "Missing hostel or date" });

  try {
    const rows = await allAsync(
      `
      SELECT a.id, a.date, a.status, a.student_id, s.name
      FROM attendance a
      JOIN students s ON s.id = a.student_id
      WHERE a.hostel_code=$1 AND a.room_number=$2 AND a.date=$3
      ORDER BY s.name
      `,
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
      `SELECT id, hostel_code, date, room_number, status FROM attendance WHERE student_id=$1 ORDER BY date DESC, id DESC`,
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
  const body = req.body || {};
  const date = body.date || "";
  const room_number = body.room_number || "";
  const status = String(body.status || "").trim();

  if (status !== "Present" && status !== "Absent") {
    return res.status(400).json({ success: false, message: "Status must be Present or Absent" });
  }

  try {
    const r = await runAsync(`UPDATE attendance SET date=$1, room_number=$2, status=$3 WHERE id=$4`, [
      date,
      room_number,
      status,
      id,
    ]);
    if (r.changes === 0) return res.json({ success: false, message: "Attendance row not found" });
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
    if (r.changes === 0) return res.json({ success: false, message: "Attendance row not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting attendance" });
  }
});

// -------------------- MONTHLY RENT / EB --------------------
app.get("/api/students/:id/monthly-account", async (req, res) => {
  const studentId = Number(req.params.id);
  try {
    const rows = await allAsync(`SELECT * FROM monthly_accounts WHERE student_id=$1 ORDER BY date DESC, id DESC`, [
      studentId,
    ]);
    res.json({ success: true, entries: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error fetching monthly account" });
  }
});

app.post("/api/students/:id/monthly-account", async (req, res) => {
  const studentId = Number(req.params.id);
  const body = req.body || {};

  const hostel_code = body.hostel_code;
  const date = body.date || "";
  const room_number = body.room_number || "";

  if (!hostel_code) return res.status(400).json({ success: false, message: "Missing hostel_code" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  try {
    const rent_paid = parseInt(body.rent_paid || 0, 10);
    const rent_remaining = parseInt(body.rent_remaining || 0, 10);
    const eb_share = parseInt(body.eb_share || 0, 10);
    const eb_paid = parseInt(body.eb_paid || 0, 10);
    const eb_remaining = parseInt(body.eb_remaining || 0, 10);

    const r = await pool.query(
      `
      INSERT INTO monthly_accounts
      (hostel_code, student_id, date, room_number, rent_paid, rent_remaining, eb_share, eb_paid, eb_remaining)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [hostel_code, studentId, date, room_number, rent_paid, rent_remaining, eb_share, eb_paid, eb_remaining]
    );

    res.json({ success: true, entry: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error adding monthly account" });
  }
});

app.put("/api/monthly_accounts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};

  try {
    const r = await runAsync(
      `
      UPDATE monthly_accounts
      SET date=$1, room_number=$2, rent_paid=$3, rent_remaining=$4, eb_share=$5, eb_paid=$6, eb_remaining=$7
      WHERE id=$8
      `,
      [
        body.date || "",
        body.room_number || "",
        parseInt(body.rent_paid || 0, 10),
        parseInt(body.rent_remaining || 0, 10),
        parseInt(body.eb_share || 0, 10),
        parseInt(body.eb_paid || 0, 10),
        parseInt(body.eb_remaining || 0, 10),
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
  const id = Number(req.params.id);
  try {
    const r = await runAsync(`DELETE FROM monthly_accounts WHERE id=$1`, [id]);
    if (r.changes === 0) return res.json({ success: false, message: "Monthly entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error deleting monthly account" });
  }
});

app.post("/api/rooms/:room/eb-batch", async (req, res) => {
  const room = String(req.params.room || "").trim();
  const body = req.body || {};

  const hostel_code = body.hostel_code;
  const date = body.date || "";
  const ebTotal = parseInt(body.eb_total || 0, 10);

  if (!hostel_code) return res.status(400).json({ success: false, message: "Missing hostel_code" });
  if (!room) return res.status(400).json({ success: false, message: "Missing room" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  try {
    const students = await allAsync(
      `SELECT id FROM students WHERE hostel_code=$1 AND room_number=$2 AND COALESCE(is_deleted,0)=0 ORDER BY id`,
      [hostel_code, room]
    );

    if (students.length === 0) return res.json({ success: false, message: "No active students in this room." });

    const ebShare = Math.floor(ebTotal / students.length);

    for (const s of students) {
      // upsert monthly_accounts row for that date
      await pool.query(
        `
        INSERT INTO monthly_accounts
        (hostel_code, student_id, date, room_number, rent_paid, rent_remaining, eb_share, eb_paid, eb_remaining)
        VALUES ($1,$2,$3,$4,0,0,$5,0,$5)
        ON CONFLICT (hostel_code, student_id, date)
        DO UPDATE SET
          room_number = EXCLUDED.room_number,
          eb_share = EXCLUDED.eb_share,
          eb_remaining = GREATEST(0, EXCLUDED.eb_share - monthly_accounts.eb_paid)
        `,
        [hostel_code, Number(s.id), date, room, ebShare]
      );
    }

    res.json({ success: true, room, date, total_students: students.length, eb_total: ebTotal, eb_share: ebShare });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: "DB error saving EB batch" });
  }
});

app.get("/api/rooms/:room/monthly-account", async (req, res) => {
  const room = String(req.params.room || "").trim();
  const hostel = String(req.query.hostel || "").trim();
  const date = String(req.query.date || "").trim();

  if (!hostel) return res.status(400).json({ success: false, message: "Missing hostel" });
  if (!date) return res.status(400).json({ success: false, message: "Missing date" });

  try {
    const rows = await allAsync(
      `
      SELECT
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
      ORDER BY s.name
      `,
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

initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ DB init failed:", err);
    process.exit(1);
  });
