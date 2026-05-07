const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de Azure SQL
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

// Conexión mediante Pool
const poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then(pool => {
        console.log('✅ Conectado a Azure SQL');
        return pool;
    })
    .catch(err => {
        console.error('❌ Error de conexión:', err.message);
    });

/* --- RUTAS DE NAVEGACIÓN (Para evitar el "Cannot GET") --- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'Login.html')));
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
            // Buscamos la clave en cualquier columna posible (contrasena o password)
            const dbPass = user.contrasena || user.password || user.contraseña;

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

/* --- API: PLATILLOS (Para la Canasta) --- */
app.get('/platillos', async (req, res) => {
    try {
        const pool = await poolPromise;
        // Intenta primero con el procedimiento, si falla usa SELECT
        let result;
        try {
            result = await pool.request().execute('sp_ObtenerPlatillosDisponibles');
        } catch (e) {
            result = await pool.request().query('SELECT id_platillo, nombre_platillo, precio FROM Platillo');
        }
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- API: VENTAS (Historial) --- */
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
        // Borrar primero el detalle por la llave foránea
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
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});