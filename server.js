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
  app.post('/petugas', async (req, res) => {
  const { nama, no_hp } = req.body;

  if (!nama) {
    return res.status(400).json({ error: 'Nama wajib diisi' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO petugas (nama, no_hp) VALUES ($1, $2) RETURNING *',
      [nama, no_hp]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal menambahkan petugas' });
  }
});
  const result = await pool.query(
  "SELECT id, nama FROM petugas WHERE aktif = true ORDER BY id"
);
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
