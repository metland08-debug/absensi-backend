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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

/* ================== KONFIG ================== */

const POS_LAT = -6.195772
const POS_LNG = 106.709001
const MAX_RADIUS = 50 // meter

/* ================== STORAGE FOTO ================== */

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads')
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    cb(null, uuidv4() + path.extname(file.originalname))
  }
})

const upload = multer({ storage })

/* ================== FACE API SETUP ================== */

faceapi.env.monkeyPatch({
  Canvas: canvas.Canvas,
  Image: canvas.Image,
  ImageData: canvas.ImageData
})

async function loadModels() {
  await faceapi.nets.ssdMobilenetv1.loadFromDisk('./models')
}
loadModels()

/* ================== HELPER ================== */

function getNowWIB() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }))
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

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
  return R * c
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
  ctx.font = "30px Arial"
  ctx.fillStyle = "red"
  ctx.fillText(text, 20, img.height - 40)

  const buffer = cnv.toBuffer("image/jpeg")
  fs.writeFileSync(imagePath, buffer)
}

/* ================== ABSENSI ================== */

app.post("/absensi", upload.single("foto"), async (req, res) => {

  const { petugas_id, status, latitude, longitude } = req.body

  if (!petugas_id || !status || !latitude || !longitude || !req.file) {
    return res.status(400).json({ error: "Data tidak lengkap" })
  }

  try {

    /* ===== VALIDASI LOKASI ===== */
    const distance = getDistance(
      parseFloat(latitude),
      parseFloat(longitude),
      POS_LAT,
      POS_LNG
    )

    if (distance > MAX_RADIUS) {
      fs.unlinkSync(req.file.path)
      return res.status(403).json({ error: "Di luar radius 50m" })
    }

    /* ===== FACE DETECTION ===== */
    const faceDetected = await detectFace(req.file.path)

    if (!faceDetected) {
      fs.unlinkSync(req.file.path)
      return res.status(403).json({ error: "Wajah tidak terdeteksi" })
    }

    /* ===== WATERMARK ===== */
    const now = getNowWIB()
    const tanggal = now.toISOString().split("T")[0]
    const jam = now.toTimeString().split(" ")[0]

    const watermarkText =
      `Waktu: ${tanggal} ${jam} | Lat: ${latitude}, Lng: ${longitude}`

    await addWatermark(req.file.path, watermarkText)

    /* ===== SIMPAN DB ===== */
    const result = await pool.query(
      `INSERT INTO absensi 
       (petugas_id, tanggal, jam, status, foto, latitude, longitude)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        petugas_id,
        tanggal,
        jam,
        status,
        req.file.filename,
        latitude,
        longitude
      ]
    )

    res.status(201).json(result.rows[0])

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Gagal absensi" })
  }
})

/* ================== DASHBOARD FOTO ================== */

app.get("/admin/foto", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, p.nama, a.tanggal, a.jam, a.status,
             a.foto, a.latitude, a.longitude
      FROM absensi a
      JOIN petugas p ON a.petugas_id = p.id
      ORDER BY a.tanggal DESC, a.jam DESC
    `)

    res.json(result.rows)

  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil foto absensi" })
  }
})

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running secure mode")
})
