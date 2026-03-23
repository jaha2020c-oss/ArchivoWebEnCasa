// server.js (Versión Corregida para la Alerta de Venta)

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

/* --------------------------
   Pool global (singleton)
   -------------------------- */
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

/* --------------------------
   LOGIN
   -------------------------- */
app.post('/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.send('Todos los campos son obligatorios');

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('usuario', sql.VarChar, usuario)
      .input('password', sql.VarChar, password)
      .query(`
        SELECT id_usuario, nombre_usuario, nombre_completo, rol
        FROM Usuario
        WHERE nombre_usuario = @usuario AND contraseña = @password
      `);

    if (result.recordset.length > 0) return res.send('OK');
    return res.send('ERROR');
  } catch (err) {
    console.error('💥 Error en /login:', err);
    res.status(500).send('Error en el servidor');
  }
});


/* --------------------------
   INVENTARIO / INGREDIENTES
   -------------------------- */
app.get('/inventario', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT 
        I.id_ingrediente,
        I.nombre_ingrediente,
        I.unidad_medida,
        I.precio_compra,
        I.disponibilidad,
        ISNULL(V.cantidad, 0) AS cantidad,
        I.fecha_actualizacion
      FROM Ingrediente I
      LEFT JOIN Inventario V ON I.id_ingrediente = V.id_ingrediente
      ORDER BY I.id_ingrediente
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Error en /inventario:', err);
    res.status(500).send('Error al obtener inventario');
  }
});

app.get('/ingredientes', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query(`SELECT id_ingrediente, nombre_ingrediente, unidad_medida, precio_compra FROM Ingrediente ORDER BY nombre_ingrediente`);
    res.json(result.recordset);
  } catch (err) {
    console.error('Error en /ingredientes:', err);
    res.status(500).send('Error al obtener ingredientes');
  }
});

/* --------------------------
   AGREGAR INGREDIENTE
   -------------------------- */
app.post('/agregarProducto', async (req, res) => {
  const { nombre, unidad, cantidad, precio, disponibilidad } = req.body;
  if (!nombre || !unidad || cantidad === undefined || !precio || disponibilidad === undefined) {
    return res.status(400).send('Faltan datos');
  }

  const cantidadNum = parseFloat(cantidad);
  const precioNum = parseFloat(precio);
  if (isNaN(cantidadNum) || isNaN(precioNum)) return res.status(400).send('Cantidad o precio inválidos');

  const disponibilidadBit = (String(disponibilidad).toLowerCase() === 'disponible' || Number(disponibilidad) === 1) ? 1 : 0;

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const reqInsertIngrediente = transaction.request();
    const insertIngredienteQ = `
      INSERT INTO Ingrediente (nombre_ingrediente, unidad_medida, precio_compra, disponibilidad, fecha_actualizacion)
      OUTPUT INSERTED.id_ingrediente
      VALUES (@nombre, @unidad, @precio, @disponibilidad, GETDATE())
    `;
    const insRes = await reqInsertIngrediente
      .input('nombre', sql.VarChar(200), nombre)
      .input('unidad', sql.VarChar(50), unidad)
      .input('precio', sql.Decimal(10, 2), precioNum)
      .input('disponibilidad', sql.Bit, disponibilidadBit)
      .query(insertIngredienteQ);

    const nuevoID = insRes.recordset[0].id_ingrediente;

    const reqInsertInv = transaction.request();
    await reqInsertInv
      .input('id_ingrediente', sql.Int, nuevoID)
      .input('cantidad', sql.Decimal(18, 2), cantidadNum)
      .query(`
        INSERT INTO Inventario (id_ingrediente, cantidad, fecha_actualizacion)
        VALUES (@id_ingrediente, @cantidad, GETDATE())
      `);

    await transaction.commit();
    res.send('OK');
  } catch (err) {
    console.error('❌ Error en transacción agregarProducto:', err);
    try { await transaction.rollback(); } catch(e){ }
    res.status(500).send('Error al insertar producto');
  }
});

/* --------------------------
   EDITAR / ELIMINAR INGREDIENTE
   -------------------------- */
app.get('/producto/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send('ID inválido');

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT 
          I.id_ingrediente, I.nombre_ingrediente, I.unidad_medida, I.precio_compra, I.disponibilidad,
          ISNULL(V.cantidad,0) AS cantidad, I.fecha_actualizacion
        FROM Ingrediente I
        LEFT JOIN Inventario V ON I.id_ingrediente = V.id_ingrediente
        WHERE I.id_ingrediente = @id
      `);
    if (result.recordset.length === 0) return res.status(404).send('No encontrado');
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('Error en /producto/:id', err);
    res.status(500).send('Error en el servidor');
  }
});

app.post('/editarProducto', async (req, res) => {
  const { id, nombre, unidad, precio, cantidad, disponibilidad } = req.body;
  if (!id || !nombre || !unidad || precio === undefined || cantidad === undefined || disponibilidad === undefined) {
    return res.status(400).send('Faltan datos');
  }

  const idInt = parseInt(id, 10);
  const cantidadNum = parseFloat(cantidad);
  const precioNum = parseFloat(precio);
  if (isNaN(idInt) || isNaN(cantidadNum) || isNaN(precioNum)) return res.status(400).send('Datos numéricos inválidos');

  const disponibilidadBit = (String(disponibilidad).toLowerCase() === 'disponible' || Number(disponibilidad) === 1) ? 1 : 0;

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const reqUpdIng = transaction.request();
    await reqUpdIng
      .input('id', sql.Int, idInt)
      .input('nombre', sql.VarChar(200), nombre)
      .input('unidad', sql.VarChar(50), unidad)
      .input('precio', sql.Decimal(10, 2), precioNum)
      .input('disponibilidad', sql.Bit, disponibilidadBit)
      .query(`
        UPDATE Ingrediente
        SET nombre_ingrediente = @nombre,
            unidad_medida = @unidad,
            precio_compra = @precio,
            disponibilidad = @disponibilidad,
            fecha_actualizacion = GETDATE()
        WHERE id_ingrediente = @id
      `);

    const reqCheck = transaction.request();
    const chk = await reqCheck
      .input('id', sql.Int, idInt)
      .query(`SELECT TOP 1 id_inventario FROM Inventario WHERE id_ingrediente = @id`);

    if (chk.recordset.length > 0) {
      const reqUpdInv = transaction.request();
      await reqUpdInv
        .input('id', sql.Int, idInt)
        .input('cantidad', sql.Decimal(18, 2), cantidadNum)
        .query(`
          UPDATE Inventario
          SET cantidad = @cantidad, fecha_actualizacion = GETDATE()
          WHERE id_ingrediente = @id
        `);
    } else {
      const reqInsInv = transaction.request();
      await reqInsInv
        .input('id', sql.Int, idInt)
        .input('cantidad', sql.Decimal(18, 2), cantidadNum)
        .query(`
          INSERT INTO Inventario (id_ingrediente, cantidad, fecha_actualizacion)
          VALUES (@id, @cantidad, GETDATE())
        `);
    }

    await transaction.commit();
    res.send('OK');
  } catch (err) {
    console.error('Error en editarProducto:', err);
    try { await transaction.rollback(); } catch(e){ }
    res.status(500).send('Error al editar producto');
  }
});

app.post('/eliminarProducto', async (req, res) => {
  const { id } = req.body;
  const idInt = parseInt(id, 10);
  if (isNaN(idInt)) return res.status(400).send('ID inválido');

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const reqDelInv = transaction.request();
    await reqDelInv.input('id', sql.Int, idInt).query(`DELETE FROM Inventario WHERE id_ingrediente = @id`);

    const reqDelIng = transaction.request();
    await reqDelIng.input('id', sql.Int, idInt).query(`DELETE FROM Ingrediente WHERE id_ingrediente = @id`);

    await transaction.commit();
    res.send('OK');
  } catch (err) {
    console.error('Error en eliminarProducto:', err);
    try { await transaction.rollback(); } catch(e){ }
    res.status(500).send('Error al eliminar producto');
  }
});

/* --------------------------
   PLATILLOS
   -------------------------- */
app.get('/platillos', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT id_platillo, nombre_platillo, tipo, precio, disponible, fecha_actualizacion
      FROM Platillo
      ORDER BY id_platillo
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Error en /platillos:', err);
    res.status(500).send('Error al obtener platillos');
  }
});

app.get('/platillo/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send('ID inválido');

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT id_platillo, nombre_platillo, tipo, precio, disponible, fecha_actualizacion
        FROM Platillo WHERE id_platillo = @id
      `);

    if (result.recordset.length === 0) return res.status(404).send('No encontrado');
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('Error en /platillo/:id', err);
    res.status(500).send('Error en el servidor');
  }
});

app.post('/agregarPlatillo', async (req, res) => {
  const { nombre, tipo, precio, disponible } = req.body;
  if (!nombre || !tipo || precio === undefined || disponible === undefined) return res.status(400).send('Faltan datos');

  const precioNum = parseFloat(precio);
  if (isNaN(precioNum)) return res.status(400).send('Precio inválido');

  const disponibleBit = (String(disponible).toLowerCase() === 'disponible' || Number(disponible) === 1) ? 1 : 0;

  try {
    const pool = await getPool();
    await pool.request()
      .input('nombre', sql.VarChar(200), nombre)
      .input('tipo', sql.VarChar(100), tipo)
      .input('precio', sql.Decimal(10, 2), precioNum)
      .input('disponible', sql.Bit, disponibleBit)
      .query(`
        INSERT INTO Platillo (nombre_platillo, tipo, precio, disponible, fecha_actualizacion)
        VALUES (@nombre, @tipo, @precio, @disponible, GETDATE())
      `);
    res.send('OK');
  } catch (err) {
    console.error('Error en /agregarPlatillo:', err);
    res.status(500).send('Error al agregar platillo');
  }
});

app.post('/editarPlatillo', async (req, res) => {
  const { id, nombre, tipo, precio, disponible } = req.body;
  if (!id || !nombre || !tipo || precio === undefined || disponible === undefined) return res.status(400).send('Faltan datos');

  const idInt = parseInt(id, 10);
  const precioNum = parseFloat(precio);
  if (isNaN(idInt) || isNaN(precioNum)) return res.status(400).send('Datos inválidos');

  const disponibleBit = (String(disponible).toLowerCase() === 'disponible' || Number(disponible) === 1) ? 1 : 0;

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const reqUpd = transaction.request();
    await reqUpd
      .input('id', sql.Int, idInt)
      .input('nombre', sql.VarChar(200), nombre)
      .input('tipo', sql.VarChar(100), tipo)
      .input('precio', sql.Decimal(10, 2), precioNum)
      .input('disponible', sql.Bit, disponibleBit)
      .query(`
        UPDATE Platillo
        SET nombre_platillo = @nombre,
            tipo = @tipo,
            precio = @precio,
            disponible = @disponible,
            fecha_actualizacion = GETDATE()
        WHERE id_platillo = @id
      `);

    await transaction.commit();
    res.send('OK');
  } catch (err) {
    console.error('Error en /editarPlatillo:', err);
    try { await transaction.rollback(); } catch(e){ }
    res.status(500).send('Error al editar platillo');
  }
});

app.post('/eliminarPlatillo', async (req, res) => {
  const { id } = req.body;
  const idInt = parseInt(id, 10);
  if (isNaN(idInt)) return res.status(400).send('ID inválido');

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const reqCheck = transaction.request();
    const relCheck = await reqCheck.query(`
      SELECT OBJECT_ID('Platillo_Ingrediente') AS obj1
    `);
    const hasRel = relCheck.recordset[0] && relCheck.recordset[0].obj1 !== null;

    if (hasRel) {
      const reqDelRel = transaction.request();
      await reqDelRel.input('id', sql.Int, idInt).query(`DELETE FROM Platillo_Ingrediente WHERE id_platillo = @id`);
    }

    const reqDel = transaction.request();
    await reqDel.input('id', sql.Int, idInt).query(`DELETE FROM Platillo WHERE id_platillo = @id`);

    await transaction.commit();
    res.send('OK');
  } catch (err) {
    console.error('Error en /eliminarPlatillo:', err);
    try { await transaction.rollback(); } catch(e){ }
    res.status(500).send('Error al eliminar platillo');
  }
});

/* --------------------------
   COMPRAS
   -------------------------- */
app.get('/compras', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT C.id_compra, C.fecha_compra, C.total_compra, C.id_usuario, U.nombre_completo
      FROM Compra C
      LEFT JOIN Usuario U ON C.id_usuario = U.id_usuario
      ORDER BY C.fecha_compra DESC, C.id_compra DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Error en /compras:', err);
    res.status(500).send('Error al obtener compras');
  }
});

app.get('/compra/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send('ID inválido');

  try {
    const pool = await getPool();
    const header = await pool.request().input('id', sql.Int, id).query(`SELECT id_compra, fecha_compra, total_compra, id_usuario FROM Compra WHERE id_compra = @id`);
    if (header.recordset.length === 0) return res.status(404).send('Compra no encontrada');

    const detalles = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT D.id_detalle_compra, D.id_ingrediente, I.nombre_ingrediente, D.cantidad, D.precio, D.subtotal
        FROM DetalleCompra D
        LEFT JOIN Ingrediente I ON D.id_ingrediente = I.id_ingrediente
        WHERE D.id_compra = @id
      `);

    res.json({ compra: header.recordset[0], detalles: detalles.recordset });
  } catch (err) {
    console.error('Error en /compra/:id', err);
    res.status(500).send('Error al obtener la compra');
  }
});

app.post('/registrarCompra', async (req, res) => {
  const { id_usuario, items } = req.body;
  if (!id_usuario || !Array.isArray(items) || items.length === 0) return res.status(400).send('Faltan datos (usuario/items)');

  for (const it of items) {
    if (!it.id_ingrediente || it.cantidad === undefined || it.precio === undefined) {
      return res.status(400).send('Cada item necesita id_ingrediente, cantidad y precio');
    }
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const reqInsertCompra = transaction.request();
    const insertCompraQ = `
      INSERT INTO Compra (id_usuario, fecha_compra, total_compra)
      OUTPUT INSERTED.id_compra
      VALUES (@id_usuario, GETDATE(), 0)
    `;
    const newCompraRes = await reqInsertCompra.input('id_usuario', sql.Int, id_usuario).query(insertCompraQ);
    const idCompra = newCompraRes.recordset[0].id_compra;

    let total = 0;

    for (const it of items) {
      const id_ing = parseInt(it.id_ingrediente, 10);
      const cantidad = parseFloat(it.cantidad);
      const precio = parseFloat(it.precio);
      const subtotal = Math.round((cantidad * precio + Number.EPSILON) * 100) / 100;

      const reqDet = transaction.request();
      await reqDet
        .input('id_compra', sql.Int, idCompra)
        .input('id_ingrediente', sql.Int, id_ing)
        .input('cantidad', sql.Decimal(18, 2), cantidad)
        .input('precio', sql.Decimal(10, 2), precio)
        .input('subtotal', sql.Decimal(10, 2), subtotal)
        .query(`
          INSERT INTO DetalleCompra (id_compra, id_ingrediente, cantidad, precio, subtotal)
          VALUES (@id_compra, @id_ingrediente, @cantidad, @precio, @subtotal)
        `);

      const reqCheck = transaction.request();
      const check = await reqCheck.input('id_ing', sql.Int, id_ing).query(`SELECT TOP 1 id_inventario FROM Inventario WHERE id_ingrediente = @id_ing`);

      if (check.recordset.length > 0) {
        const reqUpd = transaction.request();
        await reqUpd
          .input('id_ing', sql.Int, id_ing)
          .input('add', sql.Decimal(18, 2), cantidad)
          .query(`
            UPDATE Inventario
            SET cantidad = cantidad + @add, fecha_actualizacion = GETDATE()
            WHERE id_ingrediente = @id_ing
          `);
      } else {
        const reqIns = transaction.request();
        await reqIns
          .input('id_ing', sql.Int, id_ing)
          .input('cant', sql.Decimal(18, 2), cantidad)
          .query(`
            INSERT INTO Inventario (id_ingrediente, cantidad, fecha_actualizacion)
            VALUES (@id_ing, @cant, GETDATE())
          `);
      }

      total += subtotal;
    }

    const reqUpdTotal = transaction.request();
    await reqUpdTotal
      .input('total', sql.Decimal(10, 2), Math.round((total + Number.EPSILON) * 100) / 100)
      .input('id_compra', sql.Int, idCompra)
      .query(`UPDATE Compra SET total_compra = @total WHERE id_compra = @id_compra`);

    await transaction.commit();
    res.send('OK');
  } catch (err) {
    console.error('Error en /registrarCompra:', err);
    try { await transaction.rollback(); } catch (e) { }
    res.status(500).send('Error al registrar compra');
  }
});

app.post('/editarCompra', async (req, res) => {
  const { id_compra, items } = req.body;
  const idCompra = parseInt(id_compra, 10);
  if (isNaN(idCompra) || !Array.isArray(items)) return res.status(400).send('Datos inválidos');

  for (const it of items) {
    if (!it.id_ingrediente || it.cantidad === undefined || it.precio === undefined) {
      return res.status(400).send('Cada item necesita id_ingrediente, cantidad y precio');
    }
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const reqOld = transaction.request();
    const oldRes = await reqOld.input('idc', sql.Int, idCompra).query(`
      SELECT id_detalle_compra, id_ingrediente, cantidad, precio, subtotal
      FROM DetalleCompra WHERE id_compra = @idc
    `);

    const mapOld = {};
    for (const r of oldRes.recordset) mapOld[r.id_ingrediente] = parseFloat(r.cantidad);

    for (const it of items) {
      const id_ing = parseInt(it.id_ingrediente, 10);
      const nuevaCant = parseFloat(it.cantidad);
      const viejaCant = mapOld[id_ing] ? parseFloat(mapOld[id_ing]) : 0;
      const delta = nuevaCant - viejaCant;

      if (delta !== 0) {
        const reqCheck = transaction.request();
        const check = await reqCheck.input('id_ing', sql.Int, id_ing).query(`SELECT TOP 1 id_inventario FROM Inventario WHERE id_ingrediente = @id_ing`);

        if (check.recordset.length > 0) {
          const reqUpd = transaction.request();
          await reqUpd
            .input('id_ing', sql.Int, id_ing)
            .input('delta', sql.Decimal(18, 2), delta)
            .query(`
              UPDATE Inventario
              SET cantidad = cantidad + @delta, fecha_actualizacion = GETDATE()
              WHERE id_ingrediente = @id_ing
            `);
        } else {
          if (delta < 0) throw new Error('No hay inventario suficiente para aplicar esta edición (ingrediente sin inventario previo).');
          const reqIns = transaction.request();
          await reqIns
            .input('id_ing', sql.Int, id_ing)
            .input('cant', sql.Decimal(18, 2), delta)
            .query(`INSERT INTO Inventario (id_ingrediente, cantidad, fecha_actualizacion) VALUES (@id_ing, @cant, GETDATE())`);
        }
      }

      if (mapOld[id_ing] !== undefined) delete mapOld[id_ing];
    }

    for (const oldId in mapOld) {
      const id_ing = parseInt(oldId, 10);
      const resta = -parseFloat(mapOld[oldId]);
      if (resta === 0) continue;

      const reqCheck2 = transaction.request();
      const check2 = await reqCheck2.input('id_ing', sql.Int, id_ing).query(`SELECT TOP 1 id_inventario FROM Inventario WHERE id_ingrediente = @id_ing`);
      if (check2.recordset.length > 0) {
        const reqUpd2 = transaction.request();
        await reqUpd2
          .input('id_ing', sql.Int, id_ing)
          .input('delta', sql.Decimal(18, 2), resta)
          .query(`
            UPDATE Inventario
            SET cantidad = cantidad + @delta, fecha_actualizacion = GETDATE()
            WHERE id_ingrediente = @id_ing
          `);
      } else {
        throw new Error('No hay inventario para restar (editar compra) en ingrediente viejo.');
      }
    }

    const reqDel = transaction.request();
    await reqDel.input('idc', sql.Int, idCompra).query(`DELETE FROM DetalleCompra WHERE id_compra = @idc`);

    let total = 0;
    for (const it of items) {
      const id_ing = parseInt(it.id_ingrediente, 10);
      const cantidad = parseFloat(it.cantidad);
      const precio = parseFloat(it.precio);
      const subtotal = Math.round((cantidad * precio + Number.EPSILON) * 100) / 100;

      const reqIns = transaction.request();
      await reqIns
        .input('idc', sql.Int, idCompra)
        .input('id_ing', sql.Int, id_ing)
        .input('cant', sql.Decimal(18, 2), cantidad)
        .input('precio', sql.Decimal(10, 2), precio)
        .input('subtotal', sql.Decimal(10, 2), subtotal)
        .query(`
          INSERT INTO DetalleCompra (id_compra, id_ingrediente, cantidad, precio, subtotal)
          VALUES (@idc, @id_ing, @cant, @precio, @subtotal)
        `);

      total += subtotal;
    }

    const reqUpdTotal = transaction.request();
    await reqUpdTotal
      .input('total', sql.Decimal(10, 2), Math.round((total + Number.EPSILON) * 100) / 100)
      .input('idc', sql.Int, idCompra)
      .query(`UPDATE Compra SET total_compra = @total WHERE id_compra = @idc`);

    await transaction.commit();
    res.send('OK');
  } catch (err) {
    console.error('Error en /editarCompra:', err);
    try { await transaction.rollback(); } catch(e){ }
    res.status(500).send('Error al editar compra: ' + (err.message || ''));
  }
});

app.post('/eliminarCompra', async (req, res) => {
  const { id_compra } = req.body;
  const idCompra = parseInt(id_compra, 10);
  if (isNaN(idCompra)) return res.status(400).send('ID inválido');

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const reqDetalles = transaction.request();
    const detalles = await reqDetalles.input('idc', sql.Int, idCompra).query(`
      SELECT id_detalle_compra, id_ingrediente, cantidad FROM DetalleCompra WHERE id_compra = @idc
    `);

    for (const d of detalles.recordset) {
      const id_ing = d.id_ingrediente;
      const cantidad = parseFloat(d.cantidad);

      const reqCheck = transaction.request();
      const check = await reqCheck.input('id_ing', sql.Int, id_ing).query(`SELECT TOP 1 id_inventario FROM Inventario WHERE id_ingrediente = @id_ing`);
      if (check.recordset.length > 0) {
        const reqUpd = transaction.request();
        await reqUpd
          .input('id_ing', sql.Int, id_ing)
          .input('delta', sql.Decimal(18, 2), -cantidad)
          .query(`
            UPDATE Inventario
            SET cantidad = cantidad + @delta, fecha_actualizacion = GETDATE()
            WHERE id_ingrediente = @id_ing
          `);
      } else {
        throw new Error('Inventario inconsistente: ingrediente sin fila al eliminar compra.');
      }
    }

    const reqDelDet = transaction.request();
    await reqDelDet.input('idc', sql.Int, idCompra).query(`DELETE FROM DetalleCompra WHERE id_compra = @idc`);
    const reqDelComp = transaction.request();
    await reqDelComp.input('idc', sql.Int, idCompra).query(`DELETE FROM Compra WHERE id_compra = @idc`);

    await transaction.commit();
    res.send('OK');
  } catch (err) {
    console.error('Error en /eliminarCompra:', err);
    try { await transaction.rollback(); } catch(e){ }
    res.status(500).send('Error al eliminar compra: ' + (err.message || ''));
  }
});

/* --------------------------
   USUARIOS Y VENTAS
   -------------------------- */

app.get("/usuarios", async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(` 
      SELECT id_usuario, nombre_usuario, nombre_completo, rol
      FROM Usuario
    `);

    const usuarios = result.recordset.map(u => ({
      id_usuario: u.id_usuario,
      nombre_usuario: u.nombre_usuario?.trim(),
      nombre_completo: u.nombre_completo?.trim(),
      rol: u.rol?.trim()
    }));

    return res.json(usuarios);
  } catch (err) {
    console.error('Error en /usuarios:', err);
    res.status(500).json({ error: "Error al obtener usuarios", detalle: err });
  }
});


// ===============================================
// 🎯 CORRECCIÓN EN POST /VENTAS (CÁLCULO DEL TOTAL)
// ===============================================
app.post("/ventas", async (req, res) => {
  // No necesitamos fecha_venta ni total_venta de req.body, los calcularemos.
  const { metodo_pago, id_usuario, items } = req.body;
  const productos = items; 

  if (!productos || productos.length === 0) {
    return res.status(400).json({ error: "No hay productos en la venta" });
  }

  try {
    // 1. Calcular el total de la venta
    const totalCalculado = productos.reduce((acc, p) => acc + (p.precio * p.cantidad), 0);
    // Redondear a dos decimales
    const totalRedondeado = Math.round((totalCalculado + Number.EPSILON) * 100) / 100;
    
    const pool = await getPool(); 
    const transaction = new sql.Transaction(pool);

    try {
      await transaction.begin();

      // 2. Insertar la venta con el total calculado
      const venta = await transaction.request()
        .input("total", sql.Decimal(10, 2), totalRedondeado) // USAMOS EL TOTAL CALCULADO
        .input("metodo", sql.VarChar(20), metodo_pago)
        .input("usuario", sql.Int, id_usuario)
        .query(`
          INSERT INTO Venta (fecha_venta, total_venta, metodo_pago, id_usuario)
          OUTPUT INSERTED.id_venta
          VALUES (GETDATE(), @total, @metodo, @usuario)
        `);

      const idVenta = venta.recordset[0].id_venta;

      // 3. Insertar detalles
      for (let p of productos) {
        const subtotal = p.precio * p.cantidad;
        await transaction.request()
          .input("idv", sql.Int, idVenta)
          .input("idp", sql.Int, p.id_platillo)
          .input("cant", sql.Int, p.cantidad)
          .input("sub", sql.Decimal(10, 2), subtotal) 
          .query(`
            INSERT INTO DetalleVenta (id_venta, id_platillo, cantidad, subtotal)
            VALUES (@idv, @idp, @cant, @sub)
          `);
      }

      await transaction.commit();
      res.json({ status: "OK", id_venta: idVenta }); 
    } catch (transactionErr) {
      await transaction.rollback();
      throw transactionErr;
    }

  } catch (err) {
    console.error('Error en /ventas (POST):', err);
    res.status(500).json({ error: "Error al registrar venta", detalle: err });
  }
});
// ===============================================

app.get("/ventas", async (req, res) => {
  try {
    const pool = await getPool(); 
    const resultado = await pool.request().query(`
      SELECT v.id_venta, v.fecha_venta, v.total_venta, v.metodo_pago,
             u.nombre_usuario, u.nombre_completo -- AÑADIDO nombre_completo para el historial
      FROM Venta v
      INNER JOIN Usuario u ON v.id_usuario = u.id_usuario
      ORDER BY v.id_venta DESC
    `);

    res.json(resultado.recordset);

  } catch (err) {
    console.error('Error en /ventas (GET):', err);
    res.status(500).json({ error: "Error al obtener historial", detalle: err });
  }
});

app.get("/ventas/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
    if(isNaN(id)) return res.status(400).json({ error: "ID inválido" });

  try {
    const pool = await getPool(); 
    const detalle = await pool.request().input('id', sql.Int, id).query(`
      SELECT v.id_venta, v.fecha_venta, v.total_venta, v.metodo_pago,
             u.nombre_usuario, u.nombre_completo, -- Seleccionar nombre completo también para el detalle
             p.nombre_platillo, d.cantidad, d.subtotal
      FROM Venta v
      INNER JOIN Usuario u ON v.id_usuario = u.id_usuario
      INNER JOIN DetalleVenta d ON v.id_venta = d.id_venta
      INNER JOIN Platillo p ON p.id_platillo = d.id_platillo
      WHERE v.id_venta = @id
    `);

    res.json(detalle.recordset);

  } catch (err) {
    console.error('Error en /ventas/:id (GET):', err);
    res.status(500).json({ error: "Error al obtener detalle", detalle: err });
  }
});

app.delete("/ventas/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
    if(isNaN(id)) return res.status(400).json({ error: "ID inválido" });


  try {
    const pool = await getPool(); 

    await pool.request().input('id', sql.Int, id).query(`DELETE FROM DetalleVenta WHERE id_venta = @id`);
    await pool.request().input('id', sql.Int, id).query(`DELETE FROM Venta WHERE id_venta = @id`);

    res.json({ mensaje: "Venta eliminada correctamente" });

  } catch (err) {
    console.error('Error en /ventas/:id (DELETE):', err);
    res.status(500).json({ error: "Error al eliminar venta", detalle: err });
  }
});

/* --------------------------
   Iniciar servidor
   -------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});