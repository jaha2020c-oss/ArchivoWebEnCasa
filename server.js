const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURACIÓN DE SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

/* --- 1. RUTAS DE NAVEGACIÓN (PÁGINAS WEB HTML) --- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'menu.html')));
app.get('/platillos-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'platillos.html')));
app.get('/historial-ventas', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ventas.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

/* --- FUNCIÓN AUXILIAR PARA FILTROS POR FECHA --- */
function obtenerFechaInicio(periodo) {
    const ahora = new Date();
    if (periodo === 'hoy') {
        ahora.setHours(0, 0, 0, 0);
        return ahora.toISOString();
    } else if (periodo === 'semana') {
        ahora.setDate(ahora.getDate() - 7);
        return ahora.toISOString();
    } else if (periodo === 'mes') {
        ahora.setMonth(ahora.getMonth() - 1);
        return ahora.toISOString();
    }
    return null;
}

/* --- 2. API: ENDPOINTS DEL DASHBOARD CON FILTROS --- */

// 2.A) KPIs Generales por tiempo
app.get('/api/dashboard/metricas', async (req, res) => {
    const periodo = req.query.periodo || 'hoy';
    const fechaInicio = obtenerFechaInicio(periodo);

    try {
        let queryVentas = supabase.from('ventas').select('total_venta');
        if (fechaInicio) queryVentas = queryVentas.gte('fecha_venta', fechaInicio);
        
        const { data: ventas, error: errVentas } = await queryVentas;
        if (errVentas) throw errVentas;

        const ingresos = ventas.reduce((acc, v) => acc + Number(v.total_venta), 0);
        const ordenes = ventas.length;

        let queryDetalles = supabase.from('detalle_ventas').select('cantidad, nombre_platillo, ventas!inner(fecha_venta)');
        if (fechaInicio) queryDetalles = queryDetalles.gte('ventas.fecha_venta', fechaInicio);
        
        const { data: detalles, error: errDetalles } = await queryDetalles;
        if (errDetalles) throw errDetalles;

        const conteoPlatillos = {};
        detalles.forEach(d => {
            const nombre = d.nombre_platillo || 'Desconocido';
            conteoPlatillos[nombre] = (conteoPlatillos[nombre] || 0) + d.cantidad;
        });

        let platilloEstrella = 'Ninguno';
        let maxVendido = 0;
        for (const [nombre, cantidad] of Object.entries(conteoPlatillos)) {
            if (cantidad > maxVendido) {
                maxVendido = cantidad;
                platilloEstrella = nombre;
            }
        }

        const { data: stockBajo, error: errStock } = await supabase
            .from('platillos')
            .select('id_platillo')
            .lte('stock_actual', 5)
            .eq('disponible', true);
            
        if (errStock) throw errStock;

        res.json({
            ingresos,
            ordenes,
            platilloEstrella,
            alertasStock: stockBajo ? stockBajo.length : 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.B) Ranking completo de platillos
app.get('/api/dashboard/ranking-platillos', async (req, res) => {
    const periodo = req.query.periodo || 'hoy';
    const fechaInicio = obtenerFechaInicio(periodo);

    try {
        let query = supabase.from('detalle_ventas').select('nombre_platillo, cantidad, subtotal, ventas!inner(fecha_venta)');
        if (fechaInicio) query = query.gte('ventas.fecha_venta', fechaInicio);

        const { data, error } = await query;
        if (error) throw error;

        const rankingMap = {};
        data.forEach(item => {
            const nombre = item.nombre_platillo;
            if (!rankingMap[nombre]) {
                rankingMap[nombre] = { nombre_platillo: nombre, total_vendido: 0, ganancia_total: 0 };
            }
            rankingMap[nombre].total_vendido += item.cantidad;
            rankingMap[nombre].ganancia_total += Number(item.subtotal);
        });

        const rankingArray = Object.values(rankingMap).sort((a, b) => b.total_vendido - a.total_vendido);
        res.json(rankingArray);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.C) Métodos de pago por tiempo
app.get('/api/dashboard/metodos-pago', async (req, res) => {
    const periodo = req.query.periodo || 'hoy';
    const fechaInicio = obtenerFechaInicio(periodo);

    try {
        let query = supabase.from('ventas').select('metodo_pago');
        if (fechaInicio) query = query.gte('fecha_venta', fechaInicio);

        const { data, error } = await query;
        if (error) throw error;

        const conteoMetodos = {};
        data.forEach(v => {
            const metodo = v.metodo_pago || 'Otros';
            conteoMetodos[metodo] = (conteoMetodos[metodo] || 0) + 1;
        });

        const resultado = Object.keys(conteoMetodos).map(metodo => ({
            metodo_pago: metodo,
            cantidad: conteoMetodos[metodo]
        }));

        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- 3. API: GESTIÓN DE PLATILLOS --- */
app.get('/platillos', async (req, res) => {
    const ordenAsc = req.query.orden === 'ASC';
    try {
        const { data, error } = await supabase
            .from('platillos')
            .select('*')
            .order('id_platillo', { ascending: ordenAsc });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/platillos/buscar', async (req, res) => {
    const nombre = req.query.nombre || '';
    try {
        const { data, error } = await supabase
            .from('platillos')
            .select('*')
            .ilike('nombre_platillo', `%${nombre}%`);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/agregarPlatillo', async (req, res) => {
    const { nombre, tipo, precio, disponible } = req.body;
    try {
        const { error } = await supabase.from('platillos').insert([
            {
                nombre_platillo: nombre,
                tipo,
                precio,
                disponible: disponible === 'Disponible' || disponible === true
            }
        ]);
        if (error) throw error;
        res.send('OK');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.post('/editarPlatillo', async (req, res) => {
    const { id, nombre, tipo, precio, disponible } = req.body;
    try {
        const { error } = await supabase
            .from('platillos')
            .update({
                nombre_platillo: nombre,
                tipo,
                precio,
                disponible: disponible === 'Disponible' || disponible === true
            })
            .eq('id_platillo', id);

        if (error) throw error;
        res.send('OK');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

/* --- 4. API: GESTIÓN DE VENTAS --- */
app.post('/guardar-venta', async (req, res) => {
    const { total_venta, metodo_pago, nombre_cliente, productos } = req.body;
    try {
        const { data: venta, error: errVenta } = await supabase
            .from('ventas')
            .insert([{
                total_venta,
                metodo_pago,
                nombre_mostrar: nombre_cliente || 'Anónimo'
            }])
            .select('id_venta')
            .single();

        if (errVenta) throw errVenta;

        const id_venta = venta.id_venta;

        for (let prod of productos) {
            const { error: errDetalle } = await supabase
                .from('detalle_ventas')
                .insert([{
                    id_venta,
                    id_platillo: prod.id_platillo,
                    nombre_platillo: prod.nombre_platillo || 'Platillo',
                    cantidad: prod.cantidad,
                    precio: prod.precio || (prod.subtotal / prod.cantidad),
                    subtotal: prod.subtotal
                }]);

            if (errDetalle) throw errDetalle;

            // Actualización dinámica del stock en base de datos
            const { data: platillo } = await supabase
                .from('platillos')
                .select('stock_actual')
                .eq('id_platillo', prod.id_platillo)
                .single();

            if (platillo) {
                const nuevoStock = Math.max(0, platillo.stock_actual - prod.cantidad);
                await supabase
                    .from('platillos')
                    .update({
                        stock_actual: nuevoStock,
                        disponible: nuevoStock > 0
                    })
                    .eq('id_platillo', prod.id_platillo);
            }
        }

        res.json({ success: true, mensaje: "Venta guardada", id_venta });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/ventas', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('ventas')
            .select('id_venta, fecha_venta, total_venta, metodo_pago, nombre_mostrar')
            .order('id_venta', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/ventas/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('ventas')
            .delete()
            .eq('id_venta', id);

        if (error) throw error;
        res.send('Venta eliminada');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get('/ventas/:id/detalles', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('detalle_ventas')
            .select('cantidad, subtotal, nombre_platillo, precio')
            .eq('id_venta', id);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- 5. HISTORIAL DE COMPRAS Y AUTENTICACIÓN --- */
app.get('/mis-compras/:nombre', async (req, res) => {
    try {
        const nombre = req.params.nombre;
        const { data, error } = await supabase
            .from('ventas')
            .select('id_venta, fecha_venta, total_venta, metodo_pago, detalle_ventas(nombre_platillo, cantidad)')
            .eq('nombre_mostrar', nombre)
            .order('id_venta', { ascending: false });

        if (error) throw error;

        const resultado = data.map(v => {
            const prods = v.detalle_ventas.map(d => `${d.nombre_platillo} x${d.cantidad}`).join('<br>');
            return {
                id_venta: v.id_venta,
                fecha_venta: v.fecha_venta,
                total_venta: v.total_venta,
                metodo_pago: v.metodo_pago,
                productos: prods
            };
        });

        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/login', async (req, res) => {
    const { nombre_usuario, contrasena } = req.body;
    try {
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('nombre_usuario', nombre_usuario)
            .single();

        if (error || !user) {
            return res.status(404).json({ success: false, mensaje: "Usuario no encontrado" });
        }

        if (user.contrasena.trim() === contrasena.toString().trim()) {
            res.json({ success: true, nombre: user.nombre_completo, id_usuario: user.id_usuario });
        } else {
            res.status(401).json({ success: false, mensaje: "Contraseña incorrecta" });
        }
    } catch (err) {
        res.status(500).json({ success: false, mensaje: "Error: " + err.message });
    }
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});