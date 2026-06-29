const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Admin password ───────────────────────────────────────────────────────────
// Stored in the database (settings table) so it survives redeploys.
let ADMIN_PASSWORD = 'torrey'; // overwritten on startup once DB is ready

async function loadAdminPassword() {
  try {
    const rows = await query("SELECT `value` FROM settings WHERE `key` = 'admin_password'");
    if (rows.length) ADMIN_PASSWORD = rows[0].value;
  } catch { /* use default */ }
}
async function saveAdminPassword(pw) {
  await query(
    "INSERT INTO settings (`key`, `value`) VALUES ('admin_password', ?) ON DUPLICATE KEY UPDATE `value` = ?",
    [pw, pw]
  );
}

// ── Email configuration ───────────────────────────────────────────────────────
// Set BREVO_API_KEY and BREVO_SENDER_EMAIL as environment variables in Railway.
// Sign up at brevo.com, verify a sender email address, then copy your API key.
const RECIPIENT_EMAIL = 'emmawillsd@gmail.com';

async function sendBrevoEmail(to, subject, text) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Torrey Database', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: to }],
      subject,
      textContent: text
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
}

// ── Database configuration ───────────────────────────────────────────────────
// On Railway, set MYSQLHOST, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE, MYSQLPORT
// as environment variables in the Railway dashboard. Locally it falls back to
// the hardcoded values below.
const DB_CONFIG = {
  host:     process.env.MYSQLHOST     || 'localhost',
  user:     process.env.MYSQLUSER     || 'root',
  password: process.env.MYSQLPASSWORD || 'CSTSstudenschoo1',
  database: process.env.MYSQLDATABASE || 'torrey2',
  port:     process.env.MYSQLPORT     || 3306,
};

let pool;
async function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}
async function query(sql, params = []) {
  const db = await getPool();
  const [rows] = await db.execute(sql, params);
  return rows;
}

// ── Admin session ────────────────────────────────────────────────────────────
const adminTokens = new Set();

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/forgot-password', async (req, res) => {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
    return res.status(503).json({ error: 'Email is not configured yet. Set BREVO_API_KEY and BREVO_SENDER_EMAIL in Railway environment variables.' });
  }
  try {
    await sendBrevoEmail(
      RECIPIENT_EMAIL,
      'Torrey Database — Admin Password',
      `The current Torrey Database admin password is:\n\n  ${ADMIN_PASSWORD}\n\nIf you did not request this, you can ignore this email.`
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[/api/forgot-password]', err.message);
    res.status(500).json({ error: 'Failed to send email. Check server console for details.' });
  }
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);
  res.json({ token });
});

app.post('/api/admin/logout', adminAuth, (req, res) => {
  adminTokens.delete(req.headers['x-admin-token']);
  res.sendStatus(204);
});

app.post('/api/admin/change-password', adminAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields are required.' });
  if (currentPassword !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Current password is incorrect.' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  ADMIN_PASSWORD = newPassword;
  await saveAdminPassword(newPassword);
  res.json({ ok: true });
});

// ── Serve frontend ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ════════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/books', async (req, res) => {
  try {
    const s = `%${req.query.search || ''}%`;
    const rows = await query(
      `SELECT id, title, Author AS author FROM book
       WHERE title LIKE ? OR Author LIKE ?
       ORDER BY title LIMIT 50`,
      [s, s]
    );
    res.json(rows);
  } catch (err) { console.error('[/api/books]', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/books/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [book] = await query(
      `SELECT id, title, Author AS author FROM book WHERE id = ?`, [id]
    );
    if (!book) return res.status(404).json({ error: 'Book not found' });

    const genres = await query(
      `SELECT g.genre_id, g.genre_name FROM book_gen bg
       JOIN genre g ON bg.genre_id = g.genre_id
       WHERE bg.book_id = ? ORDER BY g.genre_name`, [id]
    );

    const professorRows = await query(
      `SELECT p.professors_id, p.professors_name, g.genre_id, g.genre_name, c.office_hours
       FROM book_gen bg
       JOIN current_genre cg ON bg.genre_id = cg.genre_id
       JOIN professors p ON cg.professors_id = p.professors_id
       JOIN current c ON c.professors_id = p.professors_id
       JOIN genre g ON g.genre_id = bg.genre_id
       WHERE bg.book_id = ?
       ORDER BY p.professors_name, g.genre_name`, [id]
    );

    const professorMap = {};
    for (const row of professorRows) {
      if (!professorMap[row.professors_id]) {
        professorMap[row.professors_id] = {
          id: row.professors_id, name: row.professors_name,
          office_hours: row.office_hours, genres: [],
        };
      }
      if (!professorMap[row.professors_id].genres.find(g => g.genre_id === row.genre_id)) {
        professorMap[row.professors_id].genres.push({ genre_id: row.genre_id, genre_name: row.genre_name });
      }
    }

    const lectures = await query(
      `SELECT l.id, l.title, l.dates, l.link, p.professors_name AS professor
       FROM book_lectures bl
       JOIN lectures l ON bl.lecture_id = l.id
       JOIN professors p ON l.professors_id = p.professors_id
       WHERE bl.book_id = ?
       ORDER BY l.dates DESC, l.title`, [id]
    );

    res.json({ ...book, genres, connectedProfessors: Object.values(professorMap), lectures });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/professors', async (req, res) => {
  try {
    const s = `%${req.query.search || ''}%`;
    const rows = await query(
      `SELECT p.professors_id AS id, p.professors_name AS name, c.office_hours
       FROM professors p
       JOIN current c ON c.professors_id = p.professors_id
       WHERE p.professors_name LIKE ?
       ORDER BY p.professors_name LIMIT 50`, [s]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/lectures', async (req, res) => {
  try {
    const s = `%${req.query.search || ''}%`;
    const rows = await query(
      `SELECT l.id, l.title, l.dates, l.link,
              p.professors_id AS professor_id, p.professors_name AS professor
       FROM lectures l
       LEFT JOIN professors p ON l.professors_id = p.professors_id
       WHERE l.title LIKE ? OR p.professors_name LIKE ?
       ORDER BY l.title LIMIT 50`,
      [s, s]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/lectures/:id', async (req, res) => {
  try {
    const [lec] = await query(
      `SELECT l.id, l.title, l.dates, l.link,
              p.professors_id AS professor_id, p.professors_name AS professor
       FROM lectures l
       LEFT JOIN professors p ON l.professors_id = p.professors_id
       WHERE l.id = ?`, [req.params.id]
    );
    if (!lec) return res.status(404).json({ error: 'Lecture not found' });

    const books = await query(
      `SELECT b.id, b.title, b.Author AS author
       FROM book b
       JOIN book_lectures bl ON b.id = bl.book_id
       WHERE bl.lecture_id = ?`, [req.params.id]
    );

    res.json({ ...lec, books });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/professors/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [professor] = await query(
      `SELECT p.professors_id AS id, p.professors_name AS name, c.office_hours
       FROM professors p JOIN current c ON c.professors_id = p.professors_id
       WHERE p.professors_id = ?`, [id]
    );
    if (!professor) return res.status(404).json({ error: 'Professor not found' });

    const genres = await query(
      `SELECT g.genre_id, g.genre_name FROM current_genre cg
       JOIN genre g ON cg.genre_id = g.genre_id
       WHERE cg.professors_id = ? ORDER BY g.genre_name`, [id]
    );

    const lectureRows = await query(
      `SELECT l.id, l.title, l.dates, l.link,
              b.id AS book_id, b.title AS book_title, b.Author AS book_author
       FROM lectures l
       LEFT JOIN book_lectures bl ON bl.lecture_id = l.id
       LEFT JOIN book b ON b.id = bl.book_id
       WHERE l.professors_id = ?
       ORDER BY l.dates DESC, l.title`, [id]
    );

    const lectureMap = {};
    for (const row of lectureRows) {
      if (!lectureMap[row.id]) {
        lectureMap[row.id] = { id: row.id, title: row.title, dates: row.dates, link: row.link, books: [] };
      }
      if (row.book_id) {
        lectureMap[row.id].books.push({ id: row.book_id, title: row.book_title, author: row.book_author });
      }
    }

    res.json({ ...professor, genres, lectures: Object.values(lectureMap) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN: REFERENCE DATA
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/ref/books', adminAuth, async (req, res) => {
  const rows = await query(`SELECT id, title, Author AS author FROM book ORDER BY title`);
  res.json(rows);
});

app.get('/api/admin/ref/professors', adminAuth, async (req, res) => {
  const rows = await query(
    `SELECT professors_id AS id, professors_name AS name FROM professors ORDER BY professors_name`
  );
  res.json(rows);
});

app.get('/api/admin/ref/current-professors', adminAuth, async (req, res) => {
  const rows = await query(
    `SELECT p.professors_id AS id, p.professors_name AS name
     FROM professors p JOIN current c ON c.professors_id = p.professors_id
     ORDER BY p.professors_name`
  );
  res.json(rows);
});

app.get('/api/admin/ref/genres', adminAuth, async (req, res) => {
  const rows = await query(`SELECT genre_id AS id, genre_name AS name FROM genre ORDER BY genre_name`);
  res.json(rows);
});

app.get('/api/admin/ref/lectures', adminAuth, async (req, res) => {
  const rows = await query(
    `SELECT l.id, l.title, l.dates, p.professors_name AS professor
     FROM lectures l JOIN professors p ON l.professors_id = p.professors_id
     ORDER BY l.title`
  );
  res.json(rows);
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN: ID GENERATION
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/next-id/:type', adminAuth, async (req, res) => {
  try {
    const { type } = req.params;
    if (type === 'professor') {
      const [row] = await query(`SELECT MAX(CAST(professors_id AS UNSIGNED)) AS max FROM professors`);
      return res.json({ id: String((row.max || 0) + 1).padStart(3, '0') });
    }
    if (type === 'genre') {
      const [row] = await query(`SELECT MAX(CAST(genre_id AS UNSIGNED)) AS max FROM genre`);
      return res.json({ id: String((row.max || 0) + 1).padStart(2, '0') });
    }
    if (type === 'lecture') {
      const [row] = await query(`SELECT MAX(CAST(id AS UNSIGNED)) AS max FROM lectures`);
      return res.json({ id: String((row.max || 0) + 1).padStart(3, '0') });
    }
    res.status(400).json({ error: 'Unknown type' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/check-book-id/:id', adminAuth, async (req, res) => {
  try {
    const rows = await query(`SELECT id FROM book WHERE id = ?`, [req.params.id]);
    res.json({ exists: rows.length > 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN: BOOKS CRUD
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/books', adminAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT b.id, b.title, b.Author AS author,
              COUNT(DISTINCT bg.genre_id)   AS genre_count,
              COUNT(DISTINCT bl.lecture_id) AS lecture_count
       FROM book b
       LEFT JOIN book_gen bg ON bg.book_id = b.id
       LEFT JOIN book_lectures bl ON bl.book_id = b.id
       GROUP BY b.id, b.title, b.Author
       ORDER BY b.title`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/books/:id', adminAuth, async (req, res) => {
  try {
    const [book] = await query(
      `SELECT id, title, Author AS author FROM book WHERE id = ?`, [req.params.id]
    );
    if (!book) return res.status(404).json({ error: 'Not found' });
    const genres   = await query(`SELECT genre_id FROM book_gen WHERE book_id = ?`,         [req.params.id]);
    const lectures = await query(`SELECT lecture_id FROM book_lectures WHERE book_id = ?`,  [req.params.id]);
    res.json({
      ...book,
      genre_ids:   genres.map(g => g.genre_id),
      lecture_ids: lectures.map(l => l.lecture_id),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/books', adminAuth, async (req, res) => {
  try {
    const { id, title, author, genre_ids = [], lecture_ids = [] } = req.body;
    await query(`INSERT INTO book (id, title, Author) VALUES (?, ?, ?)`, [id, title, author]);
    for (const gid of genre_ids)
      await query(`INSERT INTO book_gen (book_id, genre_id) VALUES (?, ?)`, [id, gid]);
    for (const lid of lecture_ids)
      await query(`INSERT INTO book_lectures (book_id, lecture_id) VALUES (?, ?)`, [id, lid]);
    res.json({ id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/books/:id', adminAuth, async (req, res) => {
  try {
    const { title, author, genre_ids = [], lecture_ids = [] } = req.body;
    await query(`UPDATE book SET title = ?, Author = ? WHERE id = ?`, [title, author, req.params.id]);
    await query(`DELETE FROM book_gen WHERE book_id = ?`,       [req.params.id]);
    await query(`DELETE FROM book_lectures WHERE book_id = ?`,  [req.params.id]);
    for (const gid of genre_ids)
      await query(`INSERT INTO book_gen (book_id, genre_id) VALUES (?, ?)`, [req.params.id, gid]);
    for (const lid of lecture_ids)
      await query(`INSERT INTO book_lectures (book_id, lecture_id) VALUES (?, ?)`, [req.params.id, lid]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/books/:id', adminAuth, async (req, res) => {
  try {
    await query(`DELETE FROM book_gen WHERE book_id = ?`,       [req.params.id]);
    await query(`DELETE FROM book_lectures WHERE book_id = ?`,  [req.params.id]);
    await query(`DELETE FROM book WHERE id = ?`,                [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN: PROFESSORS CRUD
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/professors', adminAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT p.professors_id AS id, p.professors_name AS name,
              CASE WHEN c.professors_id IS NOT NULL THEN 1 ELSE 0 END AS is_current,
              c.office_hours,
              COUNT(DISTINCT cg.genre_id) AS genre_count
       FROM professors p
       LEFT JOIN current c ON c.professors_id = p.professors_id
       LEFT JOIN current_genre cg ON cg.professors_id = p.professors_id
       GROUP BY p.professors_id, p.professors_name, c.professors_id, c.office_hours
       ORDER BY p.professors_name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/professors/:id', adminAuth, async (req, res) => {
  try {
    const [prof] = await query(
      `SELECT professors_id AS id, professors_name AS name FROM professors WHERE professors_id = ?`,
      [req.params.id]
    );
    if (!prof) return res.status(404).json({ error: 'Not found' });
    const [curr] = await query(`SELECT office_hours FROM current WHERE professors_id = ?`, [req.params.id]);
    const genres = await query(`SELECT genre_id FROM current_genre WHERE professors_id = ?`, [req.params.id]);
    res.json({
      ...prof,
      is_current:   !!curr,
      office_hours: curr?.office_hours || '',
      genre_ids:    genres.map(g => g.genre_id),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/professors', adminAuth, async (req, res) => {
  try {
    const { id, name, is_current, office_hours, genre_ids = [] } = req.body;
    await query(`INSERT INTO professors (professors_id, professors_name) VALUES (?, ?)`, [id, name]);
    if (is_current) {
      await query(`INSERT INTO current (professors_id, office_hours) VALUES (?, ?)`, [id, office_hours || null]);
      for (const gid of genre_ids)
        await query(`INSERT INTO current_genre (professors_id, genre_id) VALUES (?, ?)`, [id, gid]);
    }
    res.json({ id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/professors/:id', adminAuth, async (req, res) => {
  try {
    const { name, is_current, office_hours, genre_ids = [] } = req.body;
    await query(`UPDATE professors SET professors_name = ? WHERE professors_id = ?`, [name, req.params.id]);
    await query(`DELETE FROM current_genre WHERE professors_id = ?`, [req.params.id]);
    await query(`DELETE FROM current WHERE professors_id = ?`,       [req.params.id]);
    if (is_current) {
      await query(`INSERT INTO current (professors_id, office_hours) VALUES (?, ?)`,
        [req.params.id, office_hours || null]);
      for (const gid of genre_ids)
        await query(`INSERT INTO current_genre (professors_id, genre_id) VALUES (?, ?)`, [req.params.id, gid]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/professors/:id', adminAuth, async (req, res) => {
  try {
    const lectures = await query(`SELECT id FROM lectures WHERE professors_id = ?`, [req.params.id]);
    for (const l of lectures)
      await query(`DELETE FROM book_lectures WHERE lecture_id = ?`, [l.id]);
    await query(`DELETE FROM lectures WHERE professors_id = ?`,      [req.params.id]);
    await query(`DELETE FROM current_genre WHERE professors_id = ?`, [req.params.id]);
    await query(`DELETE FROM current WHERE professors_id = ?`,       [req.params.id]);
    await query(`DELETE FROM professors WHERE professors_id = ?`,    [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN: LECTURES CRUD
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/lectures', adminAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT l.id, l.title, l.dates, l.link,
              p.professors_name AS professor,
              COUNT(DISTINCT bl.book_id) AS book_count
       FROM lectures l
       JOIN professors p ON l.professors_id = p.professors_id
       LEFT JOIN book_lectures bl ON bl.lecture_id = l.id
       GROUP BY l.id, l.title, l.dates, l.link, p.professors_name
       ORDER BY l.dates DESC, l.title`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/lectures/:id', adminAuth, async (req, res) => {
  try {
    const [lec] = await query(
      `SELECT id, title, dates, professors_id, link FROM lectures WHERE id = ?`, [req.params.id]
    );
    if (!lec) return res.status(404).json({ error: 'Not found' });
    const books = await query(`SELECT book_id FROM book_lectures WHERE lecture_id = ?`, [req.params.id]);
    res.json({ ...lec, book_ids: books.map(b => b.book_id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/lectures', adminAuth, async (req, res) => {
  try {
    const { id, title, dates, professors_id, link, book_ids = [] } = req.body;
    await query(
      `INSERT INTO lectures (id, title, dates, professors_id, link) VALUES (?, ?, ?, ?, ?)`,
      [id, title, dates, professors_id, link]
    );
    for (const bid of book_ids)
      await query(`INSERT INTO book_lectures (book_id, lecture_id) VALUES (?, ?)`, [bid, id]);
    res.json({ id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/lectures/:id', adminAuth, async (req, res) => {
  try {
    const { title, dates, professors_id, link, book_ids = [] } = req.body;
    await query(
      `UPDATE lectures SET title = ?, dates = ?, professors_id = ?, link = ? WHERE id = ?`,
      [title, dates, professors_id, link, req.params.id]
    );
    await query(`DELETE FROM book_lectures WHERE lecture_id = ?`, [req.params.id]);
    for (const bid of book_ids)
      await query(`INSERT INTO book_lectures (book_id, lecture_id) VALUES (?, ?)`, [bid, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/lectures/:id', adminAuth, async (req, res) => {
  try {
    await query(`DELETE FROM book_lectures WHERE lecture_id = ?`, [req.params.id]);
    await query(`DELETE FROM lectures WHERE id = ?`,              [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN: GENRES CRUD
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/genres', adminAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT g.genre_id AS id, g.genre_name AS name,
              COUNT(DISTINCT bg.book_id)       AS book_count,
              COUNT(DISTINCT cg.professors_id) AS professor_count
       FROM genre g
       LEFT JOIN book_gen bg ON bg.genre_id = g.genre_id
       LEFT JOIN current_genre cg ON cg.genre_id = g.genre_id
       GROUP BY g.genre_id, g.genre_name
       ORDER BY g.genre_name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/genres/:id', adminAuth, async (req, res) => {
  try {
    const [genre] = await query(
      `SELECT genre_id AS id, genre_name AS name FROM genre WHERE genre_id = ?`, [req.params.id]
    );
    if (!genre) return res.status(404).json({ error: 'Not found' });
    const books      = await query(`SELECT book_id FROM book_gen WHERE genre_id = ?`,            [req.params.id]);
    const professors = await query(`SELECT professors_id FROM current_genre WHERE genre_id = ?`, [req.params.id]);
    res.json({
      ...genre,
      book_ids:      books.map(b => b.book_id),
      professor_ids: professors.map(p => p.professors_id),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/genres', adminAuth, async (req, res) => {
  try {
    const { id, name, book_ids = [], professor_ids = [] } = req.body;
    await query(`INSERT INTO genre (genre_id, genre_name) VALUES (?, ?)`, [id, name]);
    for (const bid of book_ids)
      await query(`INSERT INTO book_gen (book_id, genre_id) VALUES (?, ?)`, [bid, id]);
    for (const pid of professor_ids)
      await query(`INSERT INTO current_genre (professors_id, genre_id) VALUES (?, ?)`, [pid, id]);
    res.json({ id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/genres/:id', adminAuth, async (req, res) => {
  try {
    const { name, book_ids = [], professor_ids = [] } = req.body;
    await query(`UPDATE genre SET genre_name = ? WHERE genre_id = ?`, [name, req.params.id]);
    await query(`DELETE FROM book_gen WHERE genre_id = ?`,        [req.params.id]);
    await query(`DELETE FROM current_genre WHERE genre_id = ?`,   [req.params.id]);
    for (const bid of book_ids)
      await query(`INSERT INTO book_gen (book_id, genre_id) VALUES (?, ?)`, [bid, req.params.id]);
    for (const pid of professor_ids)
      await query(`INSERT INTO current_genre (professors_id, genre_id) VALUES (?, ?)`, [pid, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/genres/:id', adminAuth, async (req, res) => {
  try {
    await query(`DELETE FROM book_gen WHERE genre_id = ?`,      [req.params.id]);
    await query(`DELETE FROM current_genre WHERE genre_id = ?`, [req.params.id]);
    await query(`DELETE FROM genre WHERE genre_id = ?`,         [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
async function start() {
  // Create settings table if it doesn't exist, then load the saved password
  try {
    await query('CREATE TABLE IF NOT EXISTS settings (`key` VARCHAR(50) PRIMARY KEY, `value` TEXT NOT NULL)');
    await query("INSERT IGNORE INTO settings (`key`, `value`) VALUES ('admin_password', 'torrey')");
    await loadAdminPassword();
  } catch (err) {
    console.error('[startup] DB init error:', err.message);
  }
  app.listen(PORT, () => console.log(`Torrey Database running on port ${PORT}`));
}
start();
