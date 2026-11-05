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

function crearToken(datos, minutos = SESION_HORAS * 60) {
    const payload = Buffer.from(JSON.stringify({ ...datos, exp: Date.now() + minutos * 60 * 1000 })).toString('base64url');
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
    // Solo sirven los tokens de tipo "sesion" (un token de recuperar contraseña NO abre el panel)
    const datos = leerToken(leerCookies(req)[COOKIE_NAME]);
    return datos && datos.tipo === 'sesion' ? datos : null;
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

/* =====================================================================
   CONTRASEÑAS, CORREO (API de Gmail por HTTPS) Y REGLAS DE NEGOCIO
   ===================================================================== */
const util = require('util');
const scryptAsync = util.promisify(crypto.scrypt);

// Cifrado de contraseñas con scrypt (incluido en Node, no necesita paquetes)
async function cifrarContrasena(clave) {
    const salt = crypto.randomBytes(16);
    const hash = await scryptAsync(String(clave), salt, 64);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verificarContrasena(guardada, ingresada) {
    const g = String(guardada || '');
    const clave = String(ingresada).trim();
    if (g.startsWith('scrypt$')) {
        const [, saltHex, hashHex] = g.split('$');
        if (!saltHex || !hashHex) return false;
        const esperado = Buffer.from(hashHex, 'hex');
        const calculado = await scryptAsync(clave, Buffer.from(saltHex, 'hex'), esperado.length);
        return calculado.length === esperado.length && crypto.timingSafeEqual(calculado, esperado);
    }
    // Contraseña antigua en texto plano: se cifra sola en el primer inicio de sesión correcto
    return igualesSeguro(g.trim(), clave);
}

// Límites generales (en memoria): devuelve true cuando se superó el máximo
const limites = new Map();
function excedeLimite(clave, max, ventanaMs) {
    const ahora = Date.now();
    const reg = limites.get(clave);
    if (!reg || reg.hasta < ahora) {
        limites.set(clave, { n: 1, hasta: ahora + ventanaMs });
        return false;
    }
    reg.n++;
    return reg.n > max;
}

// Envío de correo con la API de Gmail. Render gratis bloquea SMTP (puertos 25, 465 y 587),
// por eso se usa HTTPS (puerto 443). Variables necesarias en Render:
// GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET y GMAIL_REFRESH_TOKEN
async function enviarCorreoGmail(para, asunto, html) {
    const { GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
    if (!GMAIL_USER || !GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
        const e = new Error('Faltan las variables de Gmail en el servidor');
        e.codigo = 'NO_CONFIGURADO';
        throw e;
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GMAIL_CLIENT_ID,
            client_secret: GMAIL_CLIENT_SECRET,
            refresh_token: GMAIL_REFRESH_TOKEN,
            grant_type: 'refresh_token'
        })
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
        throw new Error('Google rechazó el acceso: ' + (tokenJson.error_description || tokenJson.error || tokenRes.status));
    }

    const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
    const mensaje = [
        `From: =?UTF-8?B?${b64('Como en Casa')}?= <${GMAIL_USER}>`,
        `To: ${para}`,
        `Subject: =?UTF-8?B?${b64(asunto)}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64(html).replace(/.{1,76}/g, '$&\r\n')
    ].join('\r\n');

    const envio = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenJson.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(mensaje).toString('base64url') })
    });
    if (!envio.ok) {
        const detalle = await envio.text().catch(() => '');
        throw new Error('Gmail no aceptó el mensaje: ' + envio.status + ' ' + detalle.slice(0, 200));
    }
}

// --- Reglas de negocio que se pueden ajustar ---
const REEMBOLSO_MODO = 'dia';            // 'dia' = solo el mismo día (hora de Managua) | 'horas24' = dentro de las 24 horas
const REEMBOLSO_CUENTA_COSTO = true;     // true: un reembolso cuenta como pérdida del costo del platillo | false: cuenta 0
const COMISION_TARJETA_PCT = 0;          // % que cobra el banco por pago con tarjeta (0 = no se considera)

function dentroDeVentanaReembolso(fechaVenta) {
    const venta = new Date(fechaVenta).getTime();
    const ahora = Date.now();
    if (isNaN(venta)) return false;
    if (REEMBOLSO_MODO === 'horas24') return ahora - venta <= 24 * 3600 * 1000;
    const DIA = 24 * 3600 * 1000;
    return Math.floor((venta - OFFSET_MANAGUA_MS) / DIA) === Math.floor((ahora - OFFSET_MANAGUA_MS) / DIA);
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

/* --- 2. API: ENDPOINTS DEL DASHBOARD (solo administrador) --- */
app.use('/api/dashboard', protegerApi);

const COLUMNAS_VENTA_COMPLETAS = 'id_venta, fecha_venta, total_venta, metodo_pago, nombre_mostrar, detalle_ventas(id_platillo, nombre_platillo, cantidad, precio, subtotal, costo_unitario), reembolsos(estado, motivo, fecha_solicitud)';
const COLUMNAS_VENTA_BASICAS = 'id_venta, fecha_venta, total_venta, metodo_pago, nombre_mostrar, detalle_ventas(id_platillo, nombre_platillo, cantidad, precio, subtotal)';

// Ventas con sus detalles y su reembolso. Si todavía no se ejecutó el SQL nuevo, usa las columnas básicas.
async function ventasConDetalle(fechaInicio) {
    let ultimoError = null;
    for (const columnas of [COLUMNAS_VENTA_COMPLETAS, COLUMNAS_VENTA_BASICAS]) {
        let consulta = supabase.from('ventas').select(columnas).order('id_venta', { ascending: false });
        if (fechaInicio) consulta = consulta.gte('fecha_venta', fechaInicio);
        const { data, error } = await consulta;
        if (!error) return data;
        ultimoError = error;
    }
    throw ultimoError;
}

function uno(x) { return Array.isArray(x) ? (x[0] || null) : (x || null); }
function esTarjeta(metodo) { return String(metodo || '').toLowerCase().includes('tarjeta'); }

// Cobrado y ganancia de una venta:
//  - base     = suma de los subtotales (precio de los platillos, SIN IVA)
//  - costo    = cantidad x costo_unitario guardado al vender
//  - iva      = lo cobrado de más con tarjeta (no es ganancia: se entrega a la DGI)
//  - ganancia = base - costo - comisión; si hubo reembolso aceptado: -costo (o 0 según REEMBOLSO_CUENTA_COSTO)
function analizarVenta(v) {
    const detalles = v.detalle_ventas || [];
    const base = detalles.reduce((a, d) => a + Number(d.subtotal || 0), 0);
    const costo = detalles.reduce((a, d) => a + Number(d.cantidad || 0) * Number(d.costo_unitario || 0), 0);
    const reembolso = uno(v.reembolsos);
    const reembolsada = !!reembolso && reembolso.estado === 'Aceptado';
    const total = Number(v.total_venta || 0);
    const tarjeta = esTarjeta(v.metodo_pago);
    const iva = tarjeta ? Math.max(0, total - base) : 0;
    const comision = tarjeta ? (total * COMISION_TARJETA_PCT) / 100 : 0;
    let ganancia;
    if (reembolsada) ganancia = REEMBOLSO_CUENTA_COSTO ? -costo : 0;
    else ganancia = base - costo - comision;
    return { base, costo, iva, total, reembolsada, ganancia, detalles };
}

// 2.A) KPIs por período
app.get('/api/dashboard/metricas', async (req, res) => {
    const periodo = req.query.periodo || 'hoy';

    try {
        const ventas = await ventasConDetalle(obtenerFechaInicio(periodo));

        let ingresos = 0, ganancia = 0, iva = 0, ordenes = 0, reembolsos = 0;
        const conteoPlatillos = {};

        ventas.forEach(v => {
            const a = analizarVenta(v);
            ganancia += a.ganancia;
            if (a.reembolsada) { reembolsos++; return; }
            ingresos += a.total;
            iva += a.iva;
            ordenes++;
            a.detalles.forEach(d => {
                const nombre = d.nombre_platillo || 'Desconocido';
                conteoPlatillos[nombre] = (conteoPlatillos[nombre] || 0) + Number(d.cantidad || 0);
            });
        });

        let platilloEstrella = 'Ninguno';
        let maxVendido = 0;
        for (const [nombre, cantidad] of Object.entries(conteoPlatillos)) {
            if (cantidad > maxVendido) { maxVendido = cantidad; platilloEstrella = nombre; }
        }

        const { data: stockBajo, error: errStock } = await supabase
            .from('platillos')
            .select('id_platillo')
            .lte('stock_actual', 5)
            .eq('disponible', true);
        if (errStock) throw errStock;

        // Solicitudes de reembolso pendientes (si la tabla aún no existe, se muestra 0)
        let reembolsosPendientes = 0;
        const pend = await supabase.from('reembolsos').select('id_venta').eq('estado', 'Pendiente');
        if (!pend.error && pend.data) reembolsosPendientes = pend.data.length;

        res.json({
            ingresos,
            ganancia,
            iva,
            ordenes,
            reembolsos,
            reembolsosPendientes,
            platilloEstrella,
            alertasStock: stockBajo ? stockBajo.length : 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.B) Ranking de platillos (ventas sin reembolsar)
app.get('/api/dashboard/ranking-platillos', async (req, res) => {
    const periodo = req.query.periodo || 'hoy';

    try {
        const ventas = await ventasConDetalle(obtenerFechaInicio(periodo));
        const rankingMap = {};

        ventas.forEach(v => {
            const a = analizarVenta(v);
            if (a.reembolsada) return;
            a.detalles.forEach(d => {
                const nombre = d.nombre_platillo || 'Desconocido';
                if (!rankingMap[nombre]) rankingMap[nombre] = { nombre_platillo: nombre, total_vendido: 0, ingreso_total: 0, ganancia_total: 0 };
                const cantidad = Number(d.cantidad || 0);
                rankingMap[nombre].total_vendido += cantidad;
                rankingMap[nombre].ingreso_total += Number(d.subtotal || 0);
                rankingMap[nombre].ganancia_total += Number(d.subtotal || 0) - cantidad * Number(d.costo_unitario || 0);
            });
        });

        res.json(Object.values(rankingMap).sort((a, b) => b.total_vendido - a.total_vendido));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.C) Métodos de pago (ventas sin reembolsar)
app.get('/api/dashboard/metodos-pago', async (req, res) => {
    const periodo = req.query.periodo || 'hoy';

    try {
        const ventas = await ventasConDetalle(obtenerFechaInicio(periodo));
        const conteoMetodos = {};

        ventas.forEach(v => {
            if (analizarVenta(v).reembolsada) return;
            const metodo = v.metodo_pago || 'Otros';
            conteoMetodos[metodo] = (conteoMetodos[metodo] || 0) + 1;
        });

        res.json(Object.keys(conteoMetodos).map(metodo => ({ metodo_pago: metodo, cantidad: conteoMetodos[metodo] })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.D) Lista de facturas del último mes (no depende del filtro Hoy / Semana / Mes)
app.get('/api/dashboard/facturas', async (req, res) => {
    try {
        const ventas = await ventasConDetalle(obtenerFechaInicio('mes'));
        res.json(ventas.map(v => {
            const r = uno(v.reembolsos);
            return {
                id_venta: v.id_venta,
                nombre_mostrar: v.nombre_mostrar || 'Anónimo',
                fecha_venta: v.fecha_venta,
                total_venta: Number(v.total_venta || 0),
                metodo_pago: v.metodo_pago,
                reembolso: r ? { estado: r.estado, motivo: r.motivo, fecha_solicitud: r.fecha_solicitud } : null
            };
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2.E) El administrador acepta o rechaza un reembolso
app.post('/api/dashboard/reembolsos/resolver', async (req, res) => {
    const id = parseInt(req.body && req.body.id_venta);
    const accion = req.body && req.body.accion;
    if (!id || !['aceptar', 'rechazar'].includes(accion)) {
        return res.status(400).json({ success: false, error: 'Datos no válidos.' });
    }

    try {
        const estado = accion === 'aceptar' ? 'Aceptado' : 'Rechazado';
        const { data, error } = await supabase
            .from('reembolsos')
            .update({ estado, fecha_resolucion: new Date().toISOString() })
            .eq('id_venta', id)
            .eq('estado', 'Pendiente')
            .select('id_reembolso');

        if (error) throw error;
        if (!data || data.length === 0) {
            return res.status(409).json({ success: false, error: 'La solicitud ya fue atendida o no existe.' });
        }
        res.json({ success: true, estado });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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
            // Existencias y costo actual del platillo (el costo queda guardado en el detalle para calcular la ganancia)
            let consultaPlatillo = await supabase
                .from('platillos')
                .select('stock_actual, costo')
                .eq('id_platillo', prod.id_platillo)
                .single();
            if (consultaPlatillo.error && /costo/i.test(consultaPlatillo.error.message || '')) {
                consultaPlatillo = await supabase
                    .from('platillos')
                    .select('stock_actual')
                    .eq('id_platillo', prod.id_platillo)
                    .single();
            }
            const platillo = consultaPlatillo.data;

            const detalle = {
                id_venta,
                id_platillo: prod.id_platillo,
                nombre_platillo: prod.nombre_platillo || prod.nombre || 'Platillo',
                cantidad: prod.cantidad,
                precio: prod.precio || (prod.subtotal / prod.cantidad),
                subtotal: prod.subtotal,
                costo_unitario: platillo && platillo.costo != null ? Number(platillo.costo) : 0
            };

            let insDetalle = await supabase.from('detalle_ventas').insert([detalle]);
            // Si todavía no existe la columna costo_unitario, el detalle se guarda igual
            if (insDetalle.error && /costo_unitario/i.test(insDetalle.error.message || '')) {
                delete detalle.costo_unitario;
                insDetalle = await supabase.from('detalle_ventas').insert([detalle]);
            }
            if (insDetalle.error) throw insDetalle.error;

            // Actualización dinámica del stock en base de datos
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
        let r = await supabase
            .from('ventas')
            .select('id_venta, fecha_venta, total_venta, metodo_pago, nombre_mostrar, reembolsos(estado)')
            .order('id_venta', { ascending: false });

        if (r.error) {
            r = await supabase
                .from('ventas')
                .select('id_venta, fecha_venta, total_venta, metodo_pago, nombre_mostrar')
                .order('id_venta', { ascending: false });
        }
        if (r.error) throw r.error;

        res.json(r.data.map(v => {
            const reembolso = uno(v.reembolsos);
            const { reembolsos, ...resto } = v;
            return { ...resto, reembolso_estado: reembolso ? reembolso.estado : null };
        }));
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

        let r = await supabase
            .from('ventas')
            .select('id_venta, codigo_acceso, fecha_venta, total_venta, metodo_pago, nombre_mostrar, detalle_ventas(nombre_platillo, cantidad, precio, subtotal), reembolsos(estado)')
            .in('codigo_acceso', codigos)
            .order('id_venta', { ascending: false });

        // Si todavía no existe la tabla de reembolsos, se muestran las compras sin esa información
        if (r.error) {
            r = await supabase
                .from('ventas')
                .select('id_venta, codigo_acceso, fecha_venta, total_venta, metodo_pago, nombre_mostrar, detalle_ventas(nombre_platillo, cantidad, precio, subtotal)')
                .in('codigo_acceso', codigos)
                .order('id_venta', { ascending: false });
        }
        if (r.error) throw r.error;

        res.json(r.data.map(v => {
            const reembolso = uno(v.reembolsos);
            const estado = reembolso ? reembolso.estado : null;
            return {
                id_venta: v.id_venta,
                codigo: v.codigo_acceso,
                fecha_venta: v.fecha_venta,
                total_venta: Number(v.total_venta || 0),
                metodo_pago: v.metodo_pago,
                nombre_mostrar: v.nombre_mostrar || 'Anónimo',
                items: (v.detalle_ventas || []).map(d => ({
                    nombre: d.nombre_platillo,
                    cantidad: d.cantidad,
                    precio: Number(d.precio),
                    subtotal: Number(d.subtotal)
                })),
                reembolso_estado: estado,
                puede_reembolsar: !estado && dentroDeVentanaReembolso(v.fecha_venta)
            };
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// El cliente pide un reembolso (solo el mismo día de la compra y con un motivo)
app.post('/reembolsos/solicitar', async (req, res) => {
    try {
        if (excedeLimite('reembolso:' + ipDe(req), 20, 15 * 60 * 1000)) {
            return res.status(429).json({ success: false, error: 'Demasiados intentos. Espera unos minutos.' });
        }

        const { codigo, motivo } = req.body || {};
        if (typeof codigo !== 'string' || !/^[a-f0-9]{32}$/.test(codigo)) {
            return res.status(400).json({ success: false, error: 'Compra no válida.' });
        }
        const texto = String(motivo || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
        if (texto.length < 5) {
            return res.status(400).json({ success: false, error: 'Escribe el motivo del reembolso (mínimo 5 caracteres).' });
        }

        const { data: venta, error: errVenta } = await supabase
            .from('ventas')
            .select('id_venta, fecha_venta')
            .eq('codigo_acceso', codigo)
            .single();
        if (errVenta || !venta) {
            return res.status(404).json({ success: false, error: 'No se encontró la compra.' });
        }

        if (!dentroDeVentanaReembolso(venta.fecha_venta)) {
            return res.status(403).json({ success: false, error: 'El reembolso solo está disponible durante el mismo día de la compra.' });
        }

        const { error } = await supabase
            .from('reembolsos')
            .insert([{ id_venta: venta.id_venta, motivo: texto, estado: 'Pendiente' }]);
        if (error) {
            if (error.code === '23505') {
                return res.status(409).json({ success: false, error: 'Este pedido ya tiene una solicitud de reembolso.' });
            }
            throw error;
        }

        res.json({ success: true, estado: 'Pendiente' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'No se pudo registrar la solicitud: ' + err.message });
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

        if (await verificarContrasena(user.contrasena, contrasena)) {
            intentosLogin.delete(ip);

            // Si la contraseña seguía guardada en texto plano, se cifra ahora
            if (!String(user.contrasena).startsWith('scrypt$')) {
                try {
                    await supabase
                        .from('usuarios')
                        .update({ contrasena: await cifrarContrasena(String(contrasena).trim()) })
                        .eq('id_usuario', user.id_usuario);
                } catch (e) { /* si falla, se intentará en el próximo inicio de sesión */ }
            }

            const token = crearToken({ tipo: 'sesion', id: user.id_usuario, nombre: user.nombre_completo });
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

/* --- 6. RECUPERAR CONTRASEÑA (código de 6 dígitos enviado a Gmail) --- */
const EMAIL_REGEX = /^[^\s@<>,;:"'\\]+@[^\s@<>,;:"'\\]+\.[^\s@<>,;:"'\\]+$/;
const CODIGO_MINUTOS = 10;
const MAX_INTENTOS_CODIGO = 5;

function hashCodigo(email, codigo) {
    return firmar(`otp:${email}:${codigo}`);
}

function htmlCorreoCodigo(nombre, codigo) {
    const saludo = nombre ? `Hola, ${String(nombre).replace(/[<>&]/g, '')}.` : 'Hola.';
    return `<div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;border:1px solid #eee;border-radius:12px;padding:24px;">
        <h2 style="color:#e30613;margin-top:0;">Como en Casa</h2>
        <p>${saludo} Recibimos una solicitud para recuperar la contraseña de administración.</p>
        <p>Tu código de verificación es:</p>
        <p style="font-size:34px;font-weight:bold;letter-spacing:8px;text-align:center;background:#f5f5f5;border-radius:8px;padding:14px;margin:18px 0;">${codigo}</p>
        <p>El código vence en ${CODIGO_MINUTOS} minutos y solo se puede usar una vez.</p>
        <p style="color:#888;font-size:13px;">Si tú no lo pediste, ignora este mensaje: tu contraseña no cambiará.</p>
    </div>`;
}

// Paso 1: pedir el código
app.post('/recuperar/solicitar', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(email) || email.length > 150) {
        return res.status(400).json({ success: false, mensaje: 'Escribe un correo válido.' });
    }
    if (excedeLimite('rec-ip:' + ipDe(req), 8, 15 * 60 * 1000) || excedeLimite('rec-mail:' + email, 3, 15 * 60 * 1000)) {
        return res.status(429).json({ success: false, mensaje: 'Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo.' });
    }

    // La respuesta es la misma exista o no el correo, para no revelar qué correos están registrados
    const respuestaGenerica = {
        success: true,
        mensaje: 'Si el correo está registrado, enviamos un código de 6 dígitos. Revisa tu bandeja de entrada y la carpeta de spam.'
    };

    try {
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('id_usuario, nombre_completo, activo')
            .eq('email', email)
            .maybeSingle();
        if (error) throw error;
        if (!user || user.activo === false) return res.json(respuestaGenerica);

        const codigo = String(crypto.randomInt(100000, 1000000));
        await supabase.from('password_resets').delete().eq('email', email);
        const { error: errIns } = await supabase.from('password_resets').insert([{
            email,
            code: hashCodigo(email, codigo),
            expires_at: new Date(Date.now() + CODIGO_MINUTOS * 60 * 1000).toISOString()
        }]);
        if (errIns) throw errIns;

        try {
            await enviarCorreoGmail(email, 'Tu código para recuperar la contraseña - Como en Casa', htmlCorreoCodigo(user.nombre_completo, codigo));
        } catch (e) {
            await supabase.from('password_resets').delete().eq('email', email);
            console.error('Error al enviar el correo:', e.message);
            if (e.codigo === 'NO_CONFIGURADO') {
                return res.status(503).json({ success: false, mensaje: 'El envío de correos todavía no está configurado en el servidor.' });
            }
            return res.status(502).json({ success: false, mensaje: 'No se pudo enviar el correo. Inténtalo de nuevo en unos minutos.' });
        }

        res.json(respuestaGenerica);
    } catch (err) {
        console.error('Error en recuperar/solicitar:', err.message);
        res.status(500).json({ success: false, mensaje: 'No se pudo procesar la solicitud.' });
    }
});

// Paso 2: comprobar el código
app.post('/recuperar/verificar', async (req, res) => {
    if (excedeLimite('ver-ip:' + ipDe(req), 20, 15 * 60 * 1000)) {
        return res.status(429).json({ success: false, mensaje: 'Demasiados intentos. Espera unos minutos.' });
    }
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const codigo = String((req.body && req.body.codigo) || '').replace(/\D/g, '');
    if (!EMAIL_REGEX.test(email) || codigo.length !== 6) {
        return res.status(400).json({ success: false, mensaje: 'Escribe el código de 6 dígitos.' });
    }

    try {
        const { data: fila, error } = await supabase
            .from('password_resets')
            .select('id, code, expires_at, intentos')
            .eq('email', email)
            .order('id', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw error;

        if (!fila) {
            return res.status(400).json({ success: false, mensaje: 'El código no es válido o ya venció. Solicita uno nuevo.' });
        }
        if (new Date(fila.expires_at).getTime() < Date.now()) {
            await supabase.from('password_resets').delete().eq('id', fila.id);
            return res.status(400).json({ success: false, mensaje: 'El código venció. Solicita uno nuevo.' });
        }
        if ((fila.intentos || 0) >= MAX_INTENTOS_CODIGO) {
            await supabase.from('password_resets').delete().eq('id', fila.id);
            return res.status(429).json({ success: false, mensaje: 'Demasiados intentos con este código. Solicita uno nuevo.' });
        }
        if (!igualesSeguro(fila.code, hashCodigo(email, codigo))) {
            await supabase.from('password_resets').update({ intentos: (fila.intentos || 0) + 1 }).eq('id', fila.id);
            return res.status(400).json({ success: false, mensaje: 'Código incorrecto.' });
        }

        // Código correcto: se da un margen de 10 minutos para escribir la nueva contraseña
        await supabase
            .from('password_resets')
            .update({ expires_at: new Date(Date.now() + CODIGO_MINUTOS * 60 * 1000).toISOString() })
            .eq('id', fila.id);

        res.json({ success: true, token: crearToken({ tipo: 'reset', email, rid: fila.id }, CODIGO_MINUTOS) });
    } catch (err) {
        console.error('Error en recuperar/verificar:', err.message);
        res.status(500).json({ success: false, mensaje: 'No se pudo verificar el código.' });
    }
});

// Paso 3: guardar la nueva contraseña (el código se puede usar una sola vez)
app.post('/recuperar/cambiar', async (req, res) => {
    if (excedeLimite('cam-ip:' + ipDe(req), 10, 15 * 60 * 1000)) {
        return res.status(429).json({ success: false, mensaje: 'Demasiados intentos. Espera unos minutos.' });
    }
    const { token, nueva, confirmar } = req.body || {};
    const datos = leerToken(token);
    if (!datos || datos.tipo !== 'reset') {
        return res.status(400).json({ success: false, mensaje: 'La verificación venció. Solicita un código nuevo.' });
    }
    const clave = String(nueva || '').trim();
    if (clave.length < 8 || clave.length > 100) {
        return res.status(400).json({ success: false, mensaje: 'La contraseña debe tener entre 8 y 100 caracteres.' });
    }
    if (clave !== String(confirmar || '').trim()) {
        return res.status(400).json({ success: false, mensaje: 'Las contraseñas no coinciden.' });
    }

    try {
        const { data: fila, error } = await supabase
            .from('password_resets')
            .select('id, expires_at')
            .eq('id', datos.rid)
            .eq('email', datos.email)
            .maybeSingle();
        if (error) throw error;
        if (!fila || new Date(fila.expires_at).getTime() < Date.now()) {
            return res.status(400).json({ success: false, mensaje: 'Este código ya se usó o venció. Solicita uno nuevo.' });
        }

        const hash = await cifrarContrasena(clave);
        const { error: errUp } = await supabase.from('usuarios').update({ contrasena: hash }).eq('email', datos.email);
        if (errUp) throw errUp;

        await supabase.from('password_resets').delete().eq('email', datos.email);
        res.json({ success: true, mensaje: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
    } catch (err) {
        console.error('Error en recuperar/cambiar:', err.message);
        res.status(500).json({ success: false, mensaje: 'No se pudo cambiar la contraseña.' });
    }
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
