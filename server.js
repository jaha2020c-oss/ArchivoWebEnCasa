const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const app = express();

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURACIÓN DE AZURE SQL ---
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

// --- CONEXIÓN MEDIANTE POOL ---
const poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then(pool => {
        console.log('✅ Conectado a Azure SQL');
        return pool;
    })
    .catch(err => {
        console.error('❌ Error de conexión:', err.message);
    });

/* --- RUTAS DE NAVEGACIÓN --- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'Login.html')));
app.get('/menu.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'Menu.html')));
app.get('/ventas.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'Ventas.html')));
app.get('/canasta.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'canasta.html')));

/* --- API: LOGIN --- */
app.post('/login', async (req, res) => {
    const { nombre_usuario, contrasena } = req.body;
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('u', sql.VarChar, nombre_usuario)
            .query('SELECT * FROM Usuario WHERE nombre_usuario = @u');

        if (result.recordset.length > 0) {
            const user = result.recordset[0];
            // Detecta columna 'contraseña' o 'password' para evitar errores de undefined
            const dbPass = user.contraseña || user.contrasena || user.password;

            if (dbPass && dbPass.toString().trim() === contrasena.toString().trim()) {
                res.json({ success: true, nombre: user.nombre_completo });
            } else {
                res.status(401).json({ success: false, mensaje: "Contraseña incorrecta" });
            }
        } else {
            res.status(404).json({ success: false, mensaje: "Usuario no encontrado" });
        }
    } catch (err) {
        res.status(500).json({ success: false, mensaje: "Error: " + err.message });
    }
});

/* --- API: PLATILLOS (PARA LLENAR LA CANASTA) --- */
app.get('/platillos', async (req, res) => {
    try {
        const pool = await poolPromise;
        // Llama al procedimiento que ya tienes en Azure
        const result = await pool.request().execute('sp_ObtenerPlatillosDisponibles');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- API: GUARDAR VENTA (SINCRONIZADA CON STORED PROCEDURES) --- */
app.post('/guardar-venta', async (req, res) => {
    const { total_venta, metodo_pago, id_usuario, productos } = req.body;

    try {
        const pool = await poolPromise;
        
        // 1. Ejecutar procedimiento de la Cabecera de Venta
        const resultVenta = await pool.request()
            .input('total_venta', sql.Decimal(10, 2), total_venta)
            .input('metodo_pago', sql.VarChar(20), metodo_pago)
            .input('id_usuario', sql.Int, id_usuario)
            .execute('sp_RegistrarVenta');

        const id_venta = resultVenta.recordset[0].id_venta;

        // 2. Ejecutar procedimiento para cada Detalle de Venta
        for (let prod of productos) {
            await pool.request()
                .input('id_venta', sql.Int, id_venta)
                .input('id_platillo', sql.Int, prod.id_platillo)
                .input('cantidad', sql.Int, prod.cantidad)
                .input('subtotal', sql.Decimal(10, 2), prod.subtotal)
                .execute('sp_RegistrarDetalleVenta');
        }

        res.json({ success: true, mensaje: "Venta guardada correctamente" });
    } catch (err) {
        console.error('Error al guardar venta:', err.message);
        res.status(500).json({ success: false, mensaje: "Error en Azure: " + err.message });
    }
});

/* --- API: HISTORIAL DE VENTAS --- */
app.get('/ventas', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT v.id_venta, v.fecha_venta, v.total_venta, v.metodo_pago, u.nombre_completo 
            FROM Venta v 
            INNER JOIN Usuario u ON v.id_usuario = u.id_usuario
            ORDER BY v.id_venta DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

/* --- API: BORRAR VENTA --- */
app.delete('/ventas/:id', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { id } = req.params;
        // Borramos detalles y luego cabecera
        await pool.request().input('id', sql.Int, id).query('DELETE FROM DetalleVenta WHERE id_venta = @id');
        await pool.request().input('id', sql.Int, id).query('DELETE FROM Venta WHERE id_venta = @id');
        res.send('Venta eliminada');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

/* --- INICIO DEL SERVIDOR --- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});