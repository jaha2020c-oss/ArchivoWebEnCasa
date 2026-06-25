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
    connectionTimeout: 60000,
    requestTimeout: 60000,
    options: {
        encrypt: true,
        trustServerCertificate: true
    }
};

const poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then(pool => {
        console.log('✅ Conectado a Azure SQL');
        return pool;
    })
    .catch(err => {
        console.error('❌ Error de conexión:', err.message);
    });

/* --- 1. RUTAS DE NAVEGACIÓN --- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'menu.html')));
app.get('/platillos-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'platillos.html')));
app.get('/historial-ventas', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ventas.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

/* --- FUNCIÓN AUXILIAR PARA FILTROS SQL POR TIEMPO --- */
function obtenerFiltroFechaSQL(periodo) {
    if (periodo === 'hoy') {
        return "CAST(v.fecha_venta AS DATE) = CAST(GETDATE() AS DATE)";
    } else if (periodo === 'semana') {
        return "v.fecha_venta >= DATEADD(day, -7, GETDATE())";
    } else if (periodo === 'mes') {
        return "v.fecha_venta >= DATEADD(month, -1, GETDATE())";
    }
    return "1=1"; // En caso de que no coincida, devuelve todo
}

/* --- 2. API: ENDPOINTS DEL DASHBOARD CON FILTROS --- */

// 2.A) KPIs Generales por tiempo
app.get('/api/dashboard/metricas', async (req, res) => {
    const periodo = req.query.periodo || 'hoy';
    const condicionFecha = obtenerFiltroFechaSQL(periodo);
    
    try {
        const pool = await poolPromise;
        
        const resultVentas = await pool.request().query(`
            SELECT ISNULL(SUM(v.total_venta), 0) AS ingresos, COUNT(v.id_venta) AS ordenes
            FROM Venta v WHERE ${condicionFecha}
        `);

        const resultEstrella = await pool.request().query(`
            SELECT TOP 1 p.nombre_platillo
            FROM DetalleVenta dv
            INNER JOIN Venta v ON dv.id_venta = v.id_venta
            INNER JOIN Platillo p ON dv.id_platillo = p.id_platillo
            WHERE ${condicionFecha}
            GROUP BY p.nombre_platillo ORDER BY SUM(dv.cantidad) DESC
        `);

        const resultStock = await pool.request().query(`
            SELECT COUNT(*) AS Alertas FROM Platillo WHERE stock_actual <= 5 AND disponible = 1
        `);

        res.json({
            ingresos: resultVentas.recordset[0].ingresos,
            ordenes: resultVentas.recordset[0].ordenes,
            platilloEstrella: resultEstrella.recordset[0] ? resultEstrella.recordset[0].nombre_platillo : 'Ninguno',
            alertasStock: resultStock.recordset[0].Alertas
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2.B) Ranking completo de platillos, ventas y ganancias con filtro de tiempo
app.get('/api/dashboard/ranking-platillos', async (req, res) => {
    const periodo = req.query.periodo || 'hoy';
    const condicionFecha = obtenerFiltroFechaSQL(periodo);
    
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT 
                p.nombre_platillo,
                SUM(dv.cantidad) AS total_vendido,
                SUM(dv.subtotal) AS ganancia_total
            FROM DetalleVenta dv
            INNER JOIN Venta v ON dv.id_venta = v.id_venta
            INNER JOIN Platillo p ON dv.id_platillo = p.id_platillo
            WHERE ${condicionFecha}
            GROUP BY p.nombre_platillo
            ORDER BY total_vendido DESC
        `);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2.C) Métodos de pago por tiempo
app.get('/api/dashboard/metodos-pago', async (req, res) => {
    const periodo = req.query.periodo || 'hoy';
    const condicionFecha = obtenerFiltroFechaSQL(periodo);
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT v.metodo_pago, COUNT(*) AS cantidad
            FROM Venta v WHERE ${condicionFecha} GROUP BY v.metodo_pago
        `);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* --- 3. API: GESTIÓN DE PLATILLOS --- */
app.get('/platillos', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().input('Orden', sql.VarChar, req.query.orden || 'DESC').execute('sp_ObtenerTodosPlatillos');
        const mapeado = result.recordset.map(p => ({
            id_platillo: p.id_platillo,
            nombre_platillo: p.nombre_platillo || p.nombre,
            tipo: p.tipo, precio: p.precio, disponible: p.disponible, stock_actual: p.stock_actual, stock_maximo: p.stock_maximo
        }));
        res.json(mapeado);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/platillos/buscar', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().input('Nombre', sql.VarChar, req.query.nombre || '').execute('sp_BuscarPlatilloPorNombre');
        const mapeado = result.recordset.map(p => ({
            id_platillo: p.id_platillo, nombre_platillo: p.nombre_platillo || p.nombre, tipo: p.tipo, precio: p.precio, disponible: p.disponible, stock_actual: p.stock_actual, stock_maximo: p.stock_maximo
        }));
        res.json(mapeado);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/agregarPlatillo', async (req, res) => {
    const { nombre, tipo, precio, disponible } = req.body;
    try {
        const pool = await poolPromise;
        await pool.request().input('Nombre', sql.VarChar, nombre).input('Tipo', sql.VarChar, tipo).input('Precio', sql.Decimal(10, 2), precio).input('Disponible', sql.Bit, disponible === 'Disponible' ? 1 : 0).execute('sp_InsertarPlatillo');
        res.send('OK');
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/editarPlatillo', async (req, res) => {
    const { id, nombre, tipo, precio, disponible } = req.body;
    try {
        const pool = await poolPromise;
        await pool.request().input('Id', sql.Int, id).input('Nombre', sql.VarChar, nombre).input('Tipo', sql.VarChar, tipo).input('Precio', sql.Decimal(10, 2), precio).input('Disponible', sql.Bit, disponible === 'Disponible' ? 1 : 0).execute('sp_EditarPlatillo');
        res.send('OK');
    } catch (err) { res.status(500).send(err.message); }
});

/* --- 4. API: GESTIÓN DE VENTAS --- */
app.post('/guardar-venta', async (req, res) => {
    const { total_venta, metodo_pago, id_usuario, nombre_cliente, productos } = req.body;
    try {
        const pool = await poolPromise;
        const ahora = new Date();
        const diferenciaNicaragua = -6 * 60 * 60 * 1000; 
        const fechaActual = new Date(ahora.getTime() + (ahora.getTimezoneOffset() * 60000) + diferenciaNicaragua);

        const resultVenta = await pool.request()
            .input('total_venta', sql.Decimal(10, 2), total_venta)
            .input('metodo_pago', sql.VarChar(20), metodo_pago)
            .input('id_usuario', sql.Int, id_usuario || 0) 
            .input('nombre_cliente', sql.VarChar(100), nombre_cliente)
            .input('fecha_venta', sql.DateTime, fechaActual)
            .execute('sp_RegistrarVenta');

        const id_venta = resultVenta.recordset[0].id_venta;
        
        for (let prod of productos) {
            await pool.request().input('id_venta', sql.Int, id_venta).input('id_platillo', sql.Int, prod.id_platillo).input('cantidad', sql.Int, prod.cantidad).input('subtotal', sql.Decimal(10, 2), prod.subtotal).execute('sp_RegistrarDetalleVenta');
            await pool.request().input('cantidad', sql.Int, prod.cantidad).input('id_platillo', sql.Int, prod.id_platillo).query(`UPDATE Platillo SET stock_actual = CASE WHEN stock_actual - @cantidad < 0 THEN 0 ELSE stock_actual - @cantidad END WHERE id_platillo = @id_platillo`);
            await pool.request().input('id_platillo', sql.Int, prod.id_platillo).query(`UPDATE Platillo SET disponible = 0 WHERE id_platillo = @id_platillo AND stock_actual <= 0`);
        }
        res.json({ success: true, mensaje: "Venta guardada", id_venta });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/ventas', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`SELECT v.id_venta, CONVERT(VARCHAR(25), v.fecha_venta, 120) AS fecha_venta, v.total_venta, v.metodo_pago, ISNULL(v.nombre_cliente, ISNULL(u.nombre_completo, 'Cliente General')) AS nombre_mostrar FROM Venta v LEFT JOIN Usuario u ON v.id_usuario = u.id_usuario ORDER BY v.id_venta DESC`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/ventas/:id', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { id } = req.params;
        await pool.request().input('id', sql.Int, id).query('DELETE FROM DetalleVenta WHERE id_venta = @id');
        await pool.request().input('id', sql.Int, id).query('DELETE FROM Venta WHERE id_venta = @id');
        res.send('Venta actualizada');
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/ventas/:id/detalles', async (req, res) => {
    try {
        const pool = await poolPromise;
        const { id } = req.params;
        const result = await pool.request().input('id_venta', sql.Int, id).query(`SELECT dv.cantidad, dv.subtotal, p.nombre_platillo, p.precio FROM DetalleVenta dv INNER JOIN Platillo p ON dv.id_platillo = p.id_platillo WHERE dv.id_venta = @id_venta`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/login', async (req, res) => {
    const { nombre_usuario, contrasena } = req.body;
    try {
        const pool = await poolPromise;
        const result = await pool.request().input('u', sql.VarChar, nombre_usuario).query('SELECT * FROM Usuario WHERE nombre_usuario = @u');
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