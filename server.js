const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());

// --- CONFIGURACIÓN DE SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

/* =====================================================================
   SESIÓN DE ADMINISTRADOR (ligera: no necesita paquetes ni variables nuevas)
   - Cookie firmada con HMAC. Si defines SESSION_SECRET en Render se usa esa;
     si no, se usa SUPABASE_ANON_KEY que ya tienes configurada.
   ===================================================================== */
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.SUPABASE_ANON_KEY || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'admin_sesion';
const SESION_HORAS = 12;

function firmar(texto) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(texto).digest('base64url');
}

function crearToken(datos) {
    const payload = Buffer.from(JSON.stringify({ ...datos, exp: Date.now() + SESION_HORAS * 3600 * 1000 })).toString('base64url');
    return `${payload}.${firmar(payload)}`;
}

function leerToken(token) {
    if (!token || typeof token !== 'string') return null;
    const [payload, firma] = token.split('.');
    if (!payload || !firma) return null;
    const a = Buffer.from(firma);
    const b = Buffer.from(firmar(payload));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const datos = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!datos.exp || datos.exp < Date.now()) return null;
        return datos;
    } catch (e) {
        return null;
    }
}

function leerCookies(req) {
    const cookies = {};
    (req.headers.cookie || '').split(';').forEach(par => {
        const i = par.indexOf('=');
        if (i > -1) cookies[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    });
    return cookies;
}

function sesionAdmin(req) {
    return leerToken(leerCookies(req)[COOKIE_NAME]);
}

function cookieSesion(req, valor, maxAgeSegundos) {
    const seguro = req.secure || req.headers['x-forwarded-proto'] === 'https';
    return `${COOKIE_NAME}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSegundos}${seguro ? '; Secure' : ''}`;
}

// Páginas de administración: si no hay sesión, mandar al login
function protegerPagina(req, res, next) {
    const sesion = sesionAdmin(req);
    if (!sesion) return res.redirect('/login');
    req.admin = sesion;
    res.set('Cache-Control', 'no-store');
    next();
}

// Rutas de datos de administración: si no hay sesión, responder 401
function protegerApi(req, res, next) {
    const sesion = sesionAdmin(req);
    if (!sesion) return res.status(401).json({ success: false, error: 'No autorizado. Inicia sesión como administrador.' });
    req.admin = sesion;
    next();
}

// Límite de intentos de login (por IP, en memoria)
const intentosLogin = new Map();
const MAX_INTENTOS = 8;
const VENTANA_MS = 15 * 60 * 1000;

function ipDe(req) {
    return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function registrarFallo(ip) {
    const ahora = Date.now();
    const reg = intentosLogin.get(ip);
    if (!reg || reg.hasta < ahora) intentosLogin.set(ip, { n: 1, hasta: ahora + VENTANA_MS });
    else reg.n++;
}

function igualesSeguro(a, b) {
    const A = Buffer.from(String(a));
    const B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/* --- 1. RUTAS DE NAVEGACIÓN --- */
// Páginas de administración (ahora viven en /admin, fuera de /public, y requieren sesión).
// Van ANTES de express.static a propósito.
const ADMIN_DIR = path.join(__dirname, 'admin');
app.get('/menu', protegerPagina, (req, res) => res.sendFile(path.join(ADMIN_DIR, 'menu.html')));
app.get('/platillos-admin', protegerPagina, (req, res) => res.sendFile(path.join(ADMIN_DIR, 'platillos.html')));
app.get('/historial-ventas', protegerPagina, (req, res) => res.sendFile(path.join(ADMIN_DIR, 'ventas.html')));
app.get('/dashboard', protegerPagina, (req, res) => res.sendFile(path.join(ADMIN_DIR, 'dashboard.html')));

// Direcciones antiguas: se redirigen a las nuevas (por si alguien las tiene guardadas)
app.get('/menu.html', (req, res) => res.redirect('/menu'));
app.get('/platillos.html', (req, res) => res.redirect('/platillos-admin'));
app.get('/ventas.html', (req, res) => res.redirect('/historial-ventas'));
app.get('/dashboard.html', (req, res) => res.redirect('/dashboard'));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

/* --- FUNCIÓN AUXILIAR PARA FILTROS POR FECHA --- */
// Nicaragua es UTC-6 todo el año (sin horario de verano) y Render corre en UTC.
const OFFSET_MANAGUA_MS = 6 * 60 * 60 * 1000;

function obtenerFechaInicio(periodo) {
    const ahora = new Date();
    if (periodo === 'hoy') {
        // Medianoche de Managua expresada en UTC
        const local = new Date(ahora.getTime() - OFFSET_MANAGUA_MS);
        const inicio = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + OFFSET_MANAGUA_MS;
        return new Date(inicio).toISOString();
    } else if (periodo === 'semana') {
        ahora.setDate(ahora.getDate() - 7);
        return ahora.toISOString();
    } else if (periodo === 'mes') {
        ahora.setMonth(ahora.getMonth() - 1);
        return ahora.toISOString();
    }
    return null;
}

/* --- 2. API: ENDPOINTS DEL DASHBOARD CON FILTROS (solo administrador) --- */
app.use('/api/dashboard', protegerApi);

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
// Lectura pública (la usa el menú y la canasta de los clientes)
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

// Escritura: solo administrador
app.post('/agregarPlatillo', protegerApi, async (req, res) => {
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

app.post('/editarPlatillo', protegerApi, async (req, res) => {
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

// Reponer el stock de todos los platillos a su máximo (botón en /platillos-admin)
app.post('/admin/reponer-stock', protegerApi, async (req, res) => {
    try {
        const { data, error } = await supabase.from('platillos').select('id_platillo, stock_maximo');
        if (error) throw error;

        const resultados = await Promise.all(data.map(p =>
            supabase
                .from('platillos')
                .update({ stock_actual: p.stock_maximo, disponible: p.stock_maximo > 0 })
                .eq('id_platillo', p.id_platillo)
        ));

        const fallo = resultados.find(r => r.error);
        if (fallo) throw fallo.error;

        res.json({ success: true, repuestos: data.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* --- 4. API: GESTIÓN DE VENTAS --- */
// Registrar una venta: público (lo usa la canasta)
app.post('/guardar-venta', async (req, res) => {
    const { total_venta, metodo_pago, nombre_cliente, productos } = req.body;

    if (!Array.isArray(productos) || productos.length === 0) {
        return res.status(400).json({ success: false, error: 'La venta no tiene productos.' });
    }

    // Se quitan caracteres que permitirían meter código HTML en el nombre
    const nombreLimpio = String(nombre_cliente || '').replace(/[<>&"'`]/g, '').trim().slice(0, 50) || 'Anónimo';

    try {
        // Código secreto de esta compra: sirve para que el cliente vea SOLO sus compras en "Mis Compras"
        const codigo = crypto.randomBytes(16).toString('hex');
        let codigoGuardado = codigo;

        let insercion = await supabase
            .from('ventas')
            .insert([{ total_venta, metodo_pago, nombre_mostrar: nombreLimpio, codigo_acceso: codigo }])
            .select('id_venta')
            .single();

        // Si todavía no se ha creado la columna codigo_acceso en Supabase, la venta se guarda igual (sin código)
        if (insercion.error && /codigo_acceso/i.test(insercion.error.message || '')) {
            codigoGuardado = null;
            insercion = await supabase
                .from('ventas')
                .insert([{ total_venta, metodo_pago, nombre_mostrar: nombreLimpio }])
                .select('id_venta')
                .single();
        }

        if (insercion.error) throw insercion.error;

        const id_venta = insercion.data.id_venta;

        for (let prod of productos) {
            const { error: errDetalle } = await supabase
                .from('detalle_ventas')
                .insert([{
                    id_venta,
                    id_platillo: prod.id_platillo,
                    nombre_platillo: prod.nombre_platillo || prod.nombre || 'Platillo',
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

        res.json({ success: true, mensaje: "Venta guardada", id_venta, codigo_acceso: codigoGuardado });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Historial completo de ventas: solo administrador
app.get('/ventas', protegerApi, async (req, res) => {
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

app.delete('/ventas/:id', protegerApi, async (req, res) => {
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

app.get('/ventas/:id/detalles', protegerApi, async (req, res) => {
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

/* --- 5. MIS COMPRAS (privado por código) Y AUTENTICACIÓN --- */
// El cliente envía los códigos secretos guardados en SU navegador; ya no se busca por nombre.
app.post('/mis-compras', async (req, res) => {
    try {
        const crudos = req.body && Array.isArray(req.body.codigos) ? req.body.codigos : [];
        const codigos = crudos
            .filter(c => typeof c === 'string' && /^[a-f0-9]{32}$/.test(c))
            .slice(0, 200);

        if (codigos.length === 0) return res.json([]);

        const { data, error } = await supabase
            .from('ventas')
            .select('id_venta, fecha_venta, total_venta, metodo_pago, detalle_ventas(nombre_platillo, cantidad)')
            .in('codigo_acceso', codigos)
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
    const ip = ipDe(req);
    const reg = intentosLogin.get(ip);
    if (reg && reg.hasta > Date.now() && reg.n >= MAX_INTENTOS) {
        return res.status(429).json({ success: false, mensaje: "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo." });
    }

    const { nombre_usuario, contrasena } = req.body || {};
    if (!nombre_usuario || contrasena === undefined || contrasena === null) {
        return res.status(400).json({ success: false, mensaje: "Escribe usuario y contraseña" });
    }

    try {
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('nombre_usuario', nombre_usuario)
            .single();

        if (error || !user) {
            registrarFallo(ip);
            return res.status(404).json({ success: false, mensaje: "Usuario no encontrado" });
        }

        if (user.activo === false) {
            return res.status(403).json({ success: false, mensaje: "Usuario desactivado" });
        }

        if (igualesSeguro(String(user.contrasena).trim(), String(contrasena).trim())) {
            intentosLogin.delete(ip);
            const token = crearToken({ id: user.id_usuario, nombre: user.nombre_completo });
            res.setHeader('Set-Cookie', cookieSesion(req, token, SESION_HORAS * 3600));
            res.json({ success: true, nombre: user.nombre_completo, id_usuario: user.id_usuario });
        } else {
            registrarFallo(ip);
            res.status(401).json({ success: false, mensaje: "Contraseña incorrecta" });
        }
    } catch (err) {
        res.status(500).json({ success: false, mensaje: "Error: " + err.message });
    }
});

app.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', cookieSesion(req, '', 0));
    res.json({ success: true });
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
