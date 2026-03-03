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

/* ================= SIKLUS GLOBAL ================= */

function getSiklusIndexByDate(dateObj) {
  const startDate = new Date("2026-01-26T00:00:00+07:00")
  const d = new Date(dateObj)
  d.setHours(0,0,0,0)

  const diffDays = Math.floor((d - startDate) / (1000*60*60*24))
  return ((diffDays % 5) + 5) % 5
}

/* ================= PETUGAS ================= */

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

/* ================= ABSENSI ================= */

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

    const now = new Date()
    const jamSekarang = now.getHours() + now.getMinutes() / 60

    let tanggalFinal = new Date(now)
    if (jamSekarang < 8) {
      tanggalFinal.setDate(tanggalFinal.getDate() - 1)
    }

    const globalIndex = getSiklusIndexByDate(tanggalFinal)
    const petugasIndex = (globalIndex + (siklus_offset ?? 0)) % 5

    if (!is_backup && petugasIndex === 4 && status !== "MASUK") {
      return res.status(403).json({
        error: "Anda LIBUR hari ini. Tidak bisa melakukan absensi."
      })
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

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Gagal menambah absensi" })
  }
})

/* ================= REKAP BULANAN 26–25 ================= */

app.get("/rekap-bulanan", async (req, res) => {
  const { bulan, tahun } = req.query

  if (!bulan || !tahun) {
    return res.status(400).json({ error: "Parameter bulan dan tahun wajib diisi" })
  }

  const bulanInt = parseInt(bulan)
  const tahunInt = parseInt(tahun)

  try {

    /* ===== Hitung Periode 26–25 ===== */

    let startMonth = bulanInt - 1
    let startYear = tahunInt

    if (startMonth === 0) {
      startMonth = 12
      startYear -= 1
    }

    const startDate = new Date(Date.UTC(startYear, startMonth - 1, 26))
    const endDate   = new Date(Date.UTC(tahunInt, bulanInt - 1, 25))

    const startStr = startDate.toISOString().split("T")[0]
    const endStr   = endDate.toISOString().split("T")[0]

    const petugasResult = await pool.query(
      "SELECT id, nama, siklus_offset, is_backup FROM petugas WHERE aktif = true ORDER BY id"
    )
    const petugasList = petugasResult.rows

    const absensiResult = await pool.query(
      `SELECT petugas_id, tanggal, status
       FROM absensi
       WHERE tanggal >= $1 AND tanggal <= $2`,
      [startStr, endStr]
    )

    const absensiList = absensiResult.rows

    const hasil = []

    for (const p of petugasList) {

      let masuk = 0
      let ijin = 0
      let sakit = 0
      let alpha = 0
      let backup = 0
      let hari_kerja = 0

      let tanggal_alpha = []
      let tanggal_ijin = []
      let tanggal_sakit = []
      let tanggal_backup = []

      for (
        let d = new Date(startDate);
        d <= endDate;
        d.setDate(d.getDate() + 1)
      ) {

        const tanggalStr = d.toISOString().split("T")[0]

        const globalIndex = getSiklusIndexByDate(d)
        const petugasIndex = (globalIndex + (p.siklus_offset ?? 0)) % 5
        const isLibur = petugasIndex === 4

        const absensiHari = absensiList.filter(a =>
          a.petugas_id === p.id &&
          a.tanggal.toISOString().split("T")[0] === tanggalStr
        )

        const adaMasuk = absensiHari.some(a => a.status === "MASUK")
        const adaIjin  = absensiHari.some(a => a.status === "IJIN")
        const adaSakit = absensiHari.some(a => a.status === "SAKIT")

        if (isLibur) {
          if (adaMasuk) {
            backup++
            tanggal_backup.push(tanggalStr)
          }
          continue
        }

        hari_kerja++

        if (adaMasuk) {
          masuk++
        } else if (adaIjin) {
          ijin++
          tanggal_ijin.push(tanggalStr)
        } else if (adaSakit) {
          sakit++
          tanggal_sakit.push(tanggalStr)
        } else {
          alpha++
          tanggal_alpha.push(tanggalStr)
        }
      }

      hasil.push({
        nama: p.nama,
        hari_kerja,
        masuk,
        ijin,
        sakit,
        alpha,
        backup,
        tanggal_alpha,
        tanggal_ijin,
        tanggal_sakit,
        tanggal_backup
      })
    }

    res.json({
      periode: `${startStr} s/d ${endStr}`,
      data: hasil
    })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "Gagal membuat rekap bulanan" })
  }
})

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running")
})
