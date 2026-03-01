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

app.get('/petugas', async (req, res) => {
  const result = await pool.query(
    'select id, nama from petugas where aktif=true order by nama'
  )
  res.json(result.rows)
})

app.post('/absen', async (req, res) => {
  const { petugas_id, status } = req.body

  await pool.query(
    `insert into absensi (petugas_id, status)
     values ($1,$2)`,
    [petugas_id, status]
  )

  res.json({ success: true })
})

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running")
})