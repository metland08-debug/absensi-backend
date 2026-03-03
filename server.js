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

function getSiklusIndex() {
  const startDate = new Date("2026-01-26")
  const today = new Date()
  today.setHours(0,0,0,0)

  const diffDays = Math.floor((today - startDate) / (1000*60*60*24))
  return ((diffDays % 5) + 5) % 5
}

app.get('/petugas', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, nama, siklus_offset, is_backup FROM petugas WHERE aktif = true ORDER BY id"
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: "Gagal mengambil petugas" })
  }
})

app.get("/absensi", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, p.nama, a.tanggal, a.jam, a.status
      FROM absensi a
      JOIN petugas p ON a.petugas_id = p.id
      ORDER BY a.tanggal DESC, a.jam DESC
    `)
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: "Gagal mengambil data absensi" })
  }
})

app.post("/absensi", async (req, res) => {
  const { petugas_id, status } = req.body

  if (!petugas_id || !status) {
    return res.status(400).json({ error: "Data tidak lengkap" })
  }

  try {
    const petugasData = await pool.query(
      `SELECT siklus_offset, is_backup FROM petugas WHERE id = $1`,
      [petugas_id]
    )

    if (petugasData.rows.length === 0) {
      return res.status(404).json({ error: "Petugas tidak ditemukan" })
    }

    const { siklus_offset, is_backup } = petugasData.rows[0]

    if (!isBackupAllowed(is_backup, siklus_offset)) {
      return res.status(403).json({
        error: "Anda LIBUR hari ini. Tidak bisa melakukan absensi."
      })
    }

    const now = new Date()
    const jamSekarang = now.getHours() + now.getMinutes() / 60

    let tanggalFinal = new Date(now)
    if (jamSekarang < 8) {
      tanggalFinal.setDate(tanggalFinal.getDate() - 1)
    }

    const tanggal = tanggalFinal.toISOString().split("T")[0]
    const jam = now.toTimeString().split(" ")[0]

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

    const result = await pool.query(
      `INSERT INTO absensi (petugas_id, tanggal, jam, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [petugas_id, tanggal, jam, status]
    )

    res.status(201).json(result.rows[0])

  } catch {
    res.status(500).json({ error: "Gagal menambah absensi" })
  }
})

function isBackupAllowed(is_backup, siklus_offset){
  if(is_backup) return true
  const globalIndex=getSiklusIndex()
  const petugasIndex=(globalIndex+(siklus_offset??0))%5
  return petugasIndex!==4
}

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running")
})
