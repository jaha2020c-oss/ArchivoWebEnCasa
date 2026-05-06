const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();
const bodyParser = require('body-parser');
const path = require('path');

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true,
    trustServerCertificate: true
  }
};

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

// Pool Global para Azure
let poolPromise = null;
async function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config).connect()
      .then(pool => {
        console.log('📌 Conexión SQL establecida correctamente.');
        return pool;
      })
      .catch(err => {
        console.error('❌ Error conectando a la BD:', err);
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

/* --- RUTAS DE PLATILLOS --- */
app.get('/platillos', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().execute('sp_ObtenerPlatillosDisponibles');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).send('Error al obtener platillos');
  }
});

/* --- RUTAS DE VENTAS --- */

// 1. Registrar (Desde Canasta)
app.post("/ventas", async (req, res) => {
  const { metodo_pago, id_usuario, items } = req.body;
  const usuarioFinal = id_usuario || 1; 
  try {
    const totalCalculado = items.reduce((acc, p) => acc + (p.precio * p.cantidad), 0);
    const pool = await getPool(); 
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    const venta = await transaction.request()
      .input("total_venta", sql.Decimal(10, 2), totalCalculado)
      .input("metodo_pago", sql.VarChar(20), metodo_pago || 'Efectivo')
      .input("id_usuario", sql.Int, usuarioFinal)
      .execute('sp_RegistrarVenta');

    const idVenta = venta.recordset[0].id_venta;

    for (let p of items) {
      await transaction.request()
        .input("id_venta", sql.Int, idVenta)
        .input("id_platillo", sql.Int, p.id_platillo)
        .input("cantidad", sql.Int, p.cantidad)
        .input("subtotal", sql.Decimal(10, 2), (p.precio * p.cantidad))
        .execute('sp_RegistrarDetalleVenta');
    }
    await transaction.commit();
    res.json({ status: "OK", id_venta: idVenta });
  } catch (err) {
    res.status(500).json({ error: "Error al registrar venta" });
  }
});

// 2. Ver Historial
app.get("/ventas", async (req, res) => {
  try {
    const pool = await getPool(); 
    const resultado = await pool.request().query(`
      SELECT v.id_venta, v.fecha_venta, v.total_venta, v.metodo_pago, u.nombre_completo
      FROM Venta v INNER JOIN Usuario u ON v.id_usuario = u.id_usuario
      ORDER BY v.id_venta DESC`);
    res.json(resultado.recordset);
  } catch (err) {
    res.status(500).send('Error al obtener historial');
  }
});

// 3. Editar Venta
app.put('/ventas/:id', async (req, res) => {
  const { id } = req.params;
  const { metodo_pago, total_venta } = req.body;
  try {
    const pool = await getPool();
    await pool.request()
      .input('id_venta', sql.Int, id)
      .input('metodo_pago', sql.VarChar(20), metodo_pago)
      .input('total_venta', sql.Decimal(10, 2), total_venta)
      .execute('sp_ActualizarVenta'); 
    res.json({ status: 'OK' });
  } catch (err) {
    res.status(500).send('Error al actualizar');
  }
});

// 4. Eliminar Venta
app.delete('/ventas/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await getPool();
    await pool.request()
      .input('id_venta', sql.Int, id)
      .execute('sp_EliminarVenta'); 
    res.send('Eliminado');
  } catch (err) {
    res.status(500).send('Error al eliminar');
  }
});

/* --- INICIO --- */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));