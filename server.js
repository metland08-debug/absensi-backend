require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { Pool } = require('pg')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { v4: uuidv4 } = require('uuid')
const canvas = require('canvas')
const faceapi = require('@vladmandic/face-api')

const app = express()
app.use(cors())
app.use(express.json())
app.use('/uploads', express.static('uploads'))

/* ================= DATABASE ================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

/* ================= KONFIG ================= */

const POS_LAT = -6.195772
const POS_LNG = 106.709001
const MAX_RADIUS = 50

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

/* ================= FACE API ================= */

faceapi.env.monkeyPatch({
  Canvas: canvas.Canvas,
  Image: canvas.Image,
  ImageData: canvas.ImageData
})

async function loadModels() {
  await faceapi.nets.ssdMobilenetv1.loadFromDisk('./models')
}
loadModels()

/* ================= HELPER ================= */

function getNowWIB() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })
  )
}

function getSiklusIndex() {
  const startDate = new Date("2026-01-26T00:00:00+07:00")
  const now = getNowWIB()
  const today = new Date(now)
  today.setHours(0,0,0,0)

  const diffDays = Math.floor((today - startDate) / 86400000)
  return ((diffDays % 5) + 5) % 5
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

async function detectFace(imagePath) {
  const img = await canvas.loadImage(imagePath)
  const detection = await faceapi.detectSingleFace(img)
  return !!detection
}

async function addWatermark(imagePath, text) {
  const img = await canvas.loadImage(imagePath)
  const cnv = canvas.createCanvas(img.width, img.height)
  const ctx = cnv.getContext('2d')

  ctx.drawImage(img, 0, 0)
  ctx.font = "28px Arial"
  ctx.fillStyle = "red"
  ctx.fillText(text, 20, img.height - 40)

  fs.writeFileSync(imagePath, cnv.toBuffer("image/jpeg"))
}

/* ================= ROOT ================= */

app.get('/', (req, res) => {
  res.json({ status: "Absensi Backend Running Secure" })
})

/* ================= PETUGAS ================= */

app.get('/petugas', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nama, siklus_offset, is_backup
       FROM petugas WHERE aktif = true ORDER BY id`
    )
    res.json(result.rows)
  } catch {
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

    const petugasData = await pool.query(
      `SELECT siklus_offset, is_backup
       FROM petugas WHERE id = $1`,
      [petugas_id]
    )

    if (petugasData.rows.length === 0)
      return res.status(404).json({ error: "Petugas tidak ditemukan" })

    const { siklus_offset, is_backup } = petugasData.rows[0]

    /* ===== SIKLUS ===== */
    if (!is_backup) {
      const globalIndex = getSiklusIndex()
      const petugasIndex = (globalIndex + (siklus_offset ?? 0)) % 5
      if (petugasIndex === 4)
        return res.status(403).json({ error: "Anda LIBUR hari ini" })
    }

    /* ===== CUT OFF 08:00 ===== */
    const now = getNowWIB()
    if (now.getHours() < 8) {
      now.setDate(now.getDate() - 1)
    }

    const tanggal = now.toISOString().split("T")[0]
    const jam = getNowWIB().toTimeString().split(" ")[0]

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

    /* ===== FACE DETECTION ===== */

    const faceDetected = await detectFace(req.file.path)
    if (!faceDetected) {
      fs.unlinkSync(req.file.path)
      return res.status(403).json({ error: "Wajah tidak terdeteksi" })
    }

    /* ===== WATERMARK ===== */

    const watermark =
      `WIB ${tanggal} ${jam} | Lat:${latitude} Lng:${longitude}`

    await addWatermark(req.file.path, watermark)

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
      SELECT a.id, p.nama, a.tanggal, a.jam, a.status,
             a.foto, a.latitude, a.longitude,
             a.suspicious
      FROM absensi a
      JOIN petugas p ON a.petugas_id = p.id
      ORDER BY a.tanggal DESC, a.jam DESC
    `)
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: "Gagal mengambil data" })
  }
})

/* ================= START ================= */

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running secure mode")
})
