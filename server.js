// server.js - Versión Final con Stored Procedures para Canasta y Admin
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

// Root -> sirve login.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

/* POOL GLOBAL */
let poolPromise = null;
async function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config)
      .connect()
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

/* LOGIN */
app.post('/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.send('Todos los campos son obligatorios');

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('usuario', sql.VarChar, usuario)
      .input('password', sql.VarChar, password)
      .query(`SELECT id_usuario, nombre_usuario, nombre_completo, rol 
              FROM Usuario WHERE nombre_usuario = @usuario AND contraseña = @password`);

    if (result.recordset.length > 0) return res.send('OK');
    return res.send('ERROR');
  } catch (err) {
    res.status(500).send('Error en el servidor');
  }
});

/* PLATILLOS (Usa SP para la Canasta y el Admin) */
app.get('/platillos', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().execute('sp_ObtenerPlatillosDisponibles');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).send('Error al obtener platillos');
  }
});

app.post('/agregarPlatillo', async (req, res) => {
  const { nombre, tipo, precio, disponible } = req.body;
  const precioNum = parseFloat(precio);
  const disponibleBit = (String(disponible).toLowerCase() === 'disponible' || Number(disponible) === 1) ? 1 : 0;

  try {
    const pool = await getPool();
    await pool.request()
      .input('nombre', sql.VarChar(200), nombre)
      .input('tipo', sql.VarChar(100), tipo)
      .input('precio', sql.Decimal(10, 2), precioNum)
      .input('disponible', sql.Bit, disponibleBit)
      .query(`INSERT INTO Platillo (nombre_platillo, tipo, precio, disponible, fecha_actualizacion)
              VALUES (@nombre, @tipo, @precio, @disponible, GETDATE())`);
    res.send('OK');
  } catch (err) {
    res.status(500).send('Error al agregar platillo');
  }
});

app.post('/eliminarPlatillo', async (req, res) => {
  const { id } = req.body;
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Int, id).query(`DELETE FROM Platillo WHERE id_platillo = @id`);
    res.send('OK');
  } catch (err) {
    res.status(500).send('Error al eliminar platillo');
  }
});

/* VENTAS (Usa SPs para registrar desde Canasta o Admin) */
app.post("/ventas", async (req, res) => {
  const { metodo_pago, id_usuario, items } = req.body;
  const usuarioFinal = id_usuario || 1; 
  const metodoFinal = metodo_pago || 'Efectivo';

  if (!items || items.length === 0) return res.status(400).json({ error: "No hay productos" });

  try {
    const totalCalculado = items.reduce((acc, p) => acc + (p.precio * (p.cantidad || p.cant)), 0);
    const totalRedondeado = Math.round((totalCalculado + Number.EPSILON) * 100) / 100;
    
    const pool = await getPool(); 
    const transaction = new sql.Transaction(pool);

    await transaction.begin();

    // 1. Ejecutar SP de Cabecera
    const venta = await transaction.request()
      .input("total_venta", sql.Decimal(10, 2), totalRedondeado)
      .input("metodo_pago", sql.VarChar(20), metodoFinal)
      .input("id_usuario", sql.Int, usuarioFinal)
      .execute('sp_RegistrarVenta');

    const idVenta = venta.recordset[0].id_venta;

    // 2. Ejecutar SP de Detalle para cada item
    for (let p of items) {
      const cantidad = p.cantidad || p.cant;
      await transaction.request()
        .input("id_venta", sql.Int, idVenta)
        .input("id_platillo", sql.Int, p.id_platillo)
        .input("cantidad", sql.Int, cantidad)
        .input("subtotal", sql.Decimal(10, 2), (p.precio * cantidad))
        .execute('sp_RegistrarDetalleVenta');
    }

    await transaction.commit();
    res.json({ status: "OK", id_venta: idVenta });
  } catch (err) {
    console.error("Error en Ventas:", err);
    res.status(500).json({ error: "Error al registrar venta" });
  }
});

/* HISTORIAL DE VENTAS (Para el Admin) */
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

/* INICIAR SERVIDOR */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});