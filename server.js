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

/* --- 1. RUTAS DE NAVEGACIÓN (PÁGINAS WEB HTML) --- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'menu.html')));
app.get('/platillos-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'platillos.html')));

// IMPORTANTE: Cambiamos la ruta de la página web a /historial-ventas para que NO choque con los datos de la API
app.get('/historial-ventas', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ventas.html')));


/* --- 2. API: GESTIÓN DE PLATILLOS (Sincronizado con index.html y platillos.html) --- */

// Obtener todos - Sincronizado con fetch('/platillos')
app.get('/platillos', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('Orden', sql.VarChar, req.query.orden || 'DESC')
            .execute('sp_ObtenerTodosPlatillos');
        
        // Formateo de seguridad: Nos aseguramos de que si la base de datos devuelve 'nombre' o 'nombre_platillo', el frontend reciba ambos sin romperse
        const mapeado = result.recordset.map(p => ({
            id_platillo: p.id_platillo,
            nombre_platillo: p.nombre_platillo || p.nombre,
            tipo: p.tipo,
            precio: p.precio,
            disponible: p.disponible
        }));
        
        res.json(mapeado);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Buscar por nombre - Sincronizado con fetch('/platillos/buscar')
app.get('/platillos/buscar', async (req, res) => {
    try {
        const nombre = req.query.nombre || '';
        const pool = await poolPromise;
        const result = await pool.request()
            .input('Nombre', sql.VarChar, nombre)
            .execute('sp_BuscarPlatilloPorNombre');
            
        const mapeado = result.recordset.map(p => ({
            id_platillo: p.id_platillo,
            nombre_platillo: p.nombre_platillo || p.nombre,
            tipo: p.tipo,
            precio: p.precio,
            disponible: p.disponible
        }));
        res.json(mapeado);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Agregar
app.post('/agregarPlatillo', async (req, res) => {
    const { nombre, tipo, precio, disponible } = req.body;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('Nombre', sql.VarChar, nombre)
            .input('Tipo', sql.VarChar, tipo)
            .input('Precio', sql.Decimal(10, 2), precio)
            .input('Disponible', sql.Bit, disponible === 'Disponible' ? 1 : 0)
            .execute('sp_InsertarPlatillo');
        res.send('OK');
    } catch (err) { res.status(500).send(err.message); }
});

// Editar - Sincronizado con fetch('/editarPlatillo')
app.post('/editarPlatillo', async (req, res) => {
    const { id, nombre, tipo, precio, disponible } = req.body;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('Id', sql.Int, id)
            .input('Nombre', sql.VarChar, nombre)
            .input('Tipo', sql.VarChar, tipo)
            .input('Precio', sql.Decimal(10, 2), precio)
            .input('Disponible', sql.Bit, disponible === 'Disponible' ? 1 : 0)
            .execute('sp_EditarPlatillo');
        res.send('OK');
    } catch (err) { res.status(500).send(err.message); }
});


/* --- 3. API: GESTIÓN DE VENTAS (Sincronizado con index.html y ventas.html) --- */

// Guardar venta - Sincronizado con fetch('/guardar-venta')
app.post('/guardar-venta', async (req, res) => {
    const { total_venta, metodo_pago, id_usuario, productos } = req.body;
    try {
        const pool = await poolPromise;

        // SE CORRIGIÓ AQUÍ: Eliminamos la línea de 'fecha_venta' para enviar solo los 3 parámetros que espera el SP
        const resultVenta = await pool.request()
            .input('total_venta', sql.Decimal(10, 2), total_venta)
            .input('metodo_pago', sql.VarChar(20), metodo_pago)
            .input('id_usuario', sql.Int, id_usuario)
            .execute('sp_RegistrarVenta');

        const id_venta = resultVenta.recordset[0].id_venta;
        for (let prod of productos) {
            await pool.request()
                .input('id_venta', sql.Int, id_venta)
                .input('id_platillo', sql.Int, prod.id_platillo)
                .input('cantidad', sql.Int, prod.cantidad)
                .input('subtotal', sql.Decimal(10, 2), prod.subtotal)
                .execute('sp_RegistrarDetalleVenta');
        }
        res.json({ success: true, mensaje: "Venta guardada" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Obtener todas las ventas - Sincronizado con el fetch('/ventas') de tu tabla historial
app.get('/ventas', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT v.id_venta, v.fecha_venta, v.total_venta, v.metodo_pago, u.nombre_completo 
            FROM Venta v INNER JOIN Usuario u ON v.id_usuario = u.id_usuario
            ORDER BY v.id_venta DESC
        `);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Eliminar registro de venta - Sincronizado con fetch('/ventas/${id}')
app.delete('/ventas/:id', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { id } = req.params;
        await pool.request().input('id', sql.Int, id).query('DELETE FROM DetalleVenta WHERE id_venta = @id');
        await pool.request().input('id', sql.Int, id).query('DELETE FROM Venta WHERE id_venta = @id');
        res.send('Venta actualizada');
    } catch (err) { res.status(500).send(err.message); }
});

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
            const dbPass = user.contraseña || user.contrasena || user.password;
            if (dbPass && dbPass.toString().trim() === contrasena.toString().trim()) {
                res.json({ success: true, nombre: user.nombre_completo, id_usuario: user.id_usuario });
            } else { res.status(401).json({ success: false, mensaje: "Contraseña incorrecta" }); }
        } else { res.status(404).json({ success: false, mensaje: "Usuario no encontrado" }); }
    } catch (err) { res.status(500).json({ success: false, mensaje: "Error: " + err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 Servidor corriendo en puerto ${PORT}`); });