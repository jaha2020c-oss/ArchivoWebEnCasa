const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const app = express();

// Configuración de Middlewares
app.use(cors());
app.use(express.json()); // Vital para leer el cuerpo de las peticiones POST y PUT
app.use(express.static('public'));

// Configuración de la Base de Datos (Azure SQL)
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

// Conexión persistente mediante Pool
const poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then(pool => {
        console.log('✅ Conectado a Azure SQL correctamente.');
        return pool;
    })
    .catch(err => {
        console.error('❌ Error de conexión a la base de datos:', err);
    });

/* --- RUTA INICIAL --- */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* --- RUTAS PARA LA CANASTA (Platillos) --- */
app.get('/platillos', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().execute('sp_ObtenerPlatillosDisponibles');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send("Error al obtener platillos: " + err.message);
    }
});

/* --- RUTAS DE VENTAS (Historial y Gestión) --- */

// 1. Ver Historial Completo
app.get('/ventas', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT v.id_venta, v.fecha_venta, v.total_venta, v.metodo_pago, u.nombre_completo 
            FROM Venta v 
            INNER JOIN Usuario u ON v.id_usuario = u.id_usuario
            ORDER BY v.fecha_venta DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send("Error al obtener historial: " + err.message);
    }
});

// 2. Registrar Nueva Venta (Desde la Canasta)
app.post("/ventas", async (req, res) => {
    const { metodo_pago, id_usuario, items } = req.body;
    const usuarioFinal = id_usuario || 1; 
    
    try {
        const pool = await poolPromise;
        const totalCalculado = items.reduce((acc, p) => acc + (p.precio * p.cantidad), 0);
        
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
        res.status(500).json({ error: "Error en la transacción: " + err.message });
    }
});

// 3. Editar Venta (Actualizar método de pago y total)
app.put('/ventas/:id', async (req, res) => {
    const { id } = req.params;
    const { metodo_pago, total_venta } = req.body;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('id', sql.Int, id)
            .input('metodo', sql.VarChar(20), metodo_pago)
            .input('total', sql.Decimal(10, 2), total_venta)
            .query('UPDATE Venta SET metodo_pago = @metodo, total_venta = @total WHERE id_venta = @id');
        
        res.json({ status: 'OK', mensaje: 'Venta actualizada' });
    } catch (err) {
        res.status(500).send("Error al actualizar: " + err.message);
    }
});

// 4. Borrar Venta (Elimina detalles y luego la venta)
app.delete('/ventas/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;
        
        // Primero eliminamos los detalles (por la llave foránea)
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM DetalleVenta WHERE id_venta = @id');
            
        // Luego eliminamos la venta
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM Venta WHERE id_venta = @id');

        res.send('Venta y detalles eliminados con éxito');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error al eliminar: " + err.message);
    }
});

/* --- PUERTO --- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
});