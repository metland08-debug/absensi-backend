require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { Pool } = require('pg')

const app = express()
app.use(cors())
app.use(express.json())

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

app.get('/', (req, res) => {
  res.json({ status: "Absensi Backend Running" })
})

/* ================= SIKLUS 5 HARI ================= */

function getSiklusIndex() {
  const startDate = new Date("2026-01-26")
  const now = new Date()

  const today = new Date(now)
  today.setHours(0,0,0,0)

  const diffTime = today.getTime() - startDate.getTime()
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))

  return ((diffDays % 5) + 5) % 5
}

/* ================= PETUGAS ================= */

// GET semua petugas
app.get('/petugas', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, nama FROM petugas WHERE aktif = true ORDER BY id"
    )
    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Gagal mengambil petugas" })
  }
})

// POST tambah petugas
app.post('/petugas', async (req, res) => {
  const { nama, no_hp } = req.body

  if (!nama) {
    return res.status(400).json({ error: 'Nama wajib diisi' })
  }

  try {
    const result = await pool.query(
      'INSERT INTO petugas (nama, no_hp) VALUES ($1, $2) RETURNING *',
      [nama, no_hp]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Gagal menambahkan petugas' })
  }
})

/* ================= ABSENSI ================= */

// GET semua absensi
app.get("/absensi", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, p.nama, a.tanggal, a.jam, a.status
      FROM absensi a
      JOIN petugas p ON a.petugas_id = p.id
      ORDER BY a.tanggal DESC, a.jam DESC
    `)
    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Gagal mengambil data absensi" })
  }
})

// POST tambah absensi (anti double + blok LIBUR)
app.post("/absensi", async (req, res) => {
  const { petugas_id, tanggal, jam, status } = req.body

  try {

    /* ===== BLOK JIKA LIBUR ===== */
    const siklus = getSiklusIndex()
    if (siklus === 4) {
      return res.status(403).json({
        error: "Hari ini LIBUR. Tidak bisa melakukan absensi."
      })
    }

    /* ===== CEK ANTI DOUBLE ===== */
    const cek = await pool.query(
      `SELECT id FROM absensi
       WHERE petugas_id = $1
       AND tanggal = $2
       AND status = $3`,
      [petugas_id, tanggal, status]
    )

    if (cek.rows.length > 0) {
      return res.status(400).json({
        error: `Sudah melakukan ${status} pada tanggal ini`
      })
    }

    /* ===== INSERT DATA ===== */
    const result = await pool.query(
      `INSERT INTO absensi (petugas_id, tanggal, jam, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [petugas_id, tanggal, jam, status]
    )

    res.status(201).json(result.rows[0])

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Gagal menambah absensi" })
  }
})

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running")
})
