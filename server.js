require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { Pool } = require('pg')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { v4: uuidv4 } = require('uuid')

const app = express()
app.use(cors())
app.use(express.json())
app.use('/uploads', express.static('uploads'))

/* ================= DATABASE ================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

/* ================= KONFIG POS ================= */

const POS_LAT = -6.195772
const POS_LNG = 106.709001
const MAX_RADIUS = 50 // meter

/* ================= FOLDER FOTO ================= */

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads')
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, uuidv4() + path.extname(file.originalname))
})

const upload = multer({ storage })

/* ================= HELPER ================= */

function getNowWIB() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })
  )
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3
  const φ1 = lat1 * Math.PI/180
  const φ2 = lat2 * Math.PI/180
  const Δφ = (lat2-lat1) * Math.PI/180
  const Δλ = (lon2-lon1) * Math.PI/180

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2)

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)))
}

function isSpeedSuspicious(speed) {
  return speed && speed > 150
}

async function isLocationJumpSuspicious(petugas_id, lat, lng) {
  const last = await pool.query(
    `SELECT latitude, longitude 
     FROM absensi 
     WHERE petugas_id = $1
     ORDER BY tanggal DESC, jam DESC
     LIMIT 1`,
    [petugas_id]
  )

  if (last.rows.length === 0) return false

  const prev = last.rows[0]

  const distance = getDistance(
    prev.latitude,
    prev.longitude,
    lat,
    lng
  )

  return distance > 2000
}

/* ================= ROOT ================= */

app.get('/', (req, res) => {
  res.json({ status: "Absensi Backend Running" })
})

/* ================= PETUGAS ================= */

app.get('/petugas', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nama
       FROM petugas
       WHERE aktif = true
       ORDER BY id`
    )
    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Gagal mengambil petugas" })
  }
})

/* ================= ABSENSI ================= */

app.post("/absensi", upload.single("foto"), async (req, res) => {

  const {
    petugas_id,
    status,
    latitude,
    longitude,
    accuracy,
    speed,
    device_info
  } = req.body

  if (!petugas_id || !status || !latitude || !longitude || !accuracy || !req.file) {
    return res.status(400).json({ error: "Data tidak lengkap" })
  }

  try {

    const now = getNowWIB()
    const tanggal = now.toISOString().split("T")[0]
    const jam = now.toTimeString().split(" ")[0]

    /* ===== ANTI DOUBLE ===== */
    const cek = await pool.query(
      `SELECT id FROM absensi
       WHERE petugas_id = $1
       AND tanggal = $2
       AND status = $3`,
      [petugas_id, tanggal, status]
    )

    if (cek.rows.length > 0)
      return res.status(400).json({ error: `Sudah ${status}` })

    /* ===== VALIDASI GPS ===== */

    if (parseFloat(accuracy) > 30)
      return res.status(403).json({ error: "GPS tidak presisi" })

    if (isSpeedSuspicious(parseFloat(speed)))
      return res.status(403).json({ error: "Speed tidak wajar" })

    const distance = getDistance(
      parseFloat(latitude),
      parseFloat(longitude),
      POS_LAT,
      POS_LNG
    )

    if (distance > MAX_RADIUS)
      return res.status(403).json({ error: "Di luar radius 50m" })

    const suspicious = await isLocationJumpSuspicious(
      petugas_id,
      parseFloat(latitude),
      parseFloat(longitude)
    )

    /* ===== INSERT ===== */

    const result = await pool.query(
      `INSERT INTO absensi
       (petugas_id, tanggal, jam, status,
        foto, latitude, longitude,
        accuracy, speed, device_info, suspicious)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        petugas_id,
        tanggal,
        jam,
        status,
        req.file.filename,
        latitude,
        longitude,
        accuracy,
        speed,
        device_info,
        suspicious
      ]
    )

    res.status(201).json(result.rows[0])

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Gagal absensi" })
  }
})

/* ================= DASHBOARD FOTO ================= */

app.get("/admin/foto", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, a.petugas_id, a.tanggal, a.jam,
             a.status, a.foto,
             a.latitude, a.longitude,
             a.suspicious
      FROM absensi a
      ORDER BY a.tanggal DESC, a.jam DESC
    `)
    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Gagal mengambil data" })
  }
})

/* ================= START ================= */

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running")
})