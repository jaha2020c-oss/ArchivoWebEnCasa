/* --- 1. CONFIGURACIÓN DE ACCESO --- */
IF NOT EXISTS (SELECT * FROM sys.server_principals WHERE name = 'administrador')
BEGIN
    CREATE LOGIN administrador WITH PASSWORD = '12345678';
    CREATE USER administrador FOR LOGIN administrador;
    ALTER ROLE db_owner ADD MEMBER administrador;
END

/* --- 2. CREACIÓN DE TABLAS --- */

CREATE TABLE Usuario (
    id_usuario INT IDENTITY(1,1) PRIMARY KEY,
    nombre_usuario VARCHAR(50) NOT NULL,
    contraseña VARCHAR(50) NOT NULL, -- Se mantiene para server.js
    nombre_completo VARCHAR(100),
    rol VARCHAR(20) DEFAULT 'Cajero'
);

CREATE TABLE Platillo (
    id_platillo INT IDENTITY(1,1) PRIMARY KEY,
    nombre_platillo VARCHAR(100) NOT NULL,
    tipo VARCHAR(50) NOT NULL,
    precio DECIMAL(10,2) NOT NULL,
    disponible BIT DEFAULT 1,
    fecha_actualizacion DATETIME DEFAULT GETDATE()
);

CREATE TABLE Venta (
    id_venta INT IDENTITY(1,1) PRIMARY KEY,
    fecha_venta DATETIME DEFAULT GETDATE(), -- Registra fecha, hora, min, seg
    total_venta DECIMAL(10,2) NOT NULL,
    metodo_pago VARCHAR(20) NOT NULL,
    id_usuario INT NOT NULL,
    FOREIGN KEY (id_usuario) REFERENCES Usuario(id_usuario)
);

CREATE TABLE DetalleVenta (
    id_detalle INT IDENTITY(1,1) PRIMARY KEY,
    id_venta INT NOT NULL,
    id_platillo INT NOT NULL,
    cantidad INT NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (id_venta) REFERENCES Venta(id_venta),
    FOREIGN KEY (id_platillo) REFERENCES Platillo(id_platillo)
);

/* --- 3. INSERCIÓN DE DATOS INICIALES --- */

INSERT INTO Usuario(nombre_usuario, contraseña, nombre_completo, rol)
VALUES ('admin', '23456789', 'Karen Ubeda', 'Administrador'),
       ('cajera', '12345678', 'Esteban Perez', 'Cajero');

INSERT INTO Platillo(nombre_platillo, tipo, precio, disponible)
VALUES ('Gallo pinto con huevo', 'Desayuno', 60, 1),
       ('Pollo asado', 'Almuerzo', 320, 1),
       ('Cacao', 'Bebida', 30, 1);

/* --- 4. PROCEDIMIENTOS ALMACENADOS (PARA SERVER.JS) --- */

-- A. PLATILLOS: Obtener todos (Con orden dinámico)
GO
CREATE PROCEDURE sp_ObtenerTodosPlatillos
    @Orden VARCHAR(5) = 'DESC'
AS
BEGIN
    IF @Orden = 'ASC'
        SELECT * FROM Platillo ORDER BY id_platillo ASC;
    ELSE
        SELECT * FROM Platillo ORDER BY id_platillo DESC;
END
GO

-- B. PLATILLOS: Insertar nuevo
CREATE PROCEDURE sp_InsertarPlatillo
    @Nombre VARCHAR(100),
    @Tipo VARCHAR(50),
    @Precio DECIMAL(10,2),
    @Disponible BIT
AS
BEGIN
    INSERT INTO Platillo (nombre_platillo, tipo, precio, disponible, fecha_actualizacion)
    VALUES (@Nombre, @Tipo, @Precio, @Disponible, GETDATE());
END
GO

-- C. PLATILLOS: Editar existente
CREATE PROCEDURE sp_EditarPlatillo
    @Id INT,
    @Nombre VARCHAR(100),
    @Tipo VARCHAR(50),
    @Precio DECIMAL(10,2),
    @Disponible BIT
AS
BEGIN
    UPDATE Platillo 
    SET nombre_platillo = @Nombre, tipo = @Tipo, precio = @Precio, 
        disponible = @Disponible, fecha_actualizacion = GETDATE()
    WHERE id_platillo = @Id;
END
GO

-- D. PLATILLOS: Eliminar
CREATE PROCEDURE sp_EliminarPlatillo
    @Id INT
AS
BEGIN
    DELETE FROM Platillo WHERE id_platillo = @Id;
END
GO

-- E. VENTAS: Registrar Cabecera (Retorna ID para Detalle)
CREATE PROCEDURE sp_RegistrarVenta
    @total_venta DECIMAL(10,2),
    @metodo_pago VARCHAR(20),
    @id_usuario INT
AS
BEGIN
    INSERT INTO Venta (fecha_venta, total_venta, metodo_pago, id_usuario)
    VALUES (GETDATE(), @total_venta, @metodo_pago, @id_usuario);
    
    SELECT SCOPE_IDENTITY() AS id_venta;
END
GO

-- F. VENTAS: Registrar Detalle
CREATE PROCEDURE sp_RegistrarDetalleVenta
    @id_venta INT,
    @id_platillo INT,
    @cantidad INT,
    @subtotal DECIMAL(10,2)
AS
BEGIN
    INSERT INTO DetalleVenta (id_venta, id_platillo, cantidad, subtotal)
    VALUES (@id_venta, @id_platillo, @cantidad, @subtotal);
END
GO