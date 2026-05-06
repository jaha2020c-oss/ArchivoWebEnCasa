/* =============================================================
   AVANCES BD: RESTAURANTE "COMO EN CASA"
   ============================================================= */

-- 1. CONFIGURACIÓN DE ACCESO
-- (Ejecutar solo si es necesario crear el login)
-- create LOGIN administrador with PASSWORD = '12345678';
-- create user administrador for login administrador;
-- alter role db_owner add member administrador;

-- 2. TABLA: USUARIO
create table Usuario(
	id_usuario int identity(1,1) primary key,
	nombre_usuario varchar(50) not null,
	contraseña varchar(50) not null,
	nombre_completo varchar(100),
	rol varchar(20) default 'Cajero'
);

-- Inserción de prueba (Importante: Admin debe ser ID 1 para la Canasta)
insert into Usuario(nombre_usuario, contraseña, nombre_completo, rol)
values('admin', '12345678', 'Karen Ubeda', 'Administrador');

insert into Usuario(nombre_usuario, contraseña, nombre_completo, rol)
values('cajera', '12345678', 'Esteban Perez', 'Cajero');


-- 3. TABLA: PLATILLO
create table Platillo(
	id_platillo int identity(1,1) primary key,
	nombre_platillo varchar(100) not null,
	tipo varchar(50) not null,
	precio decimal(10,2) not null,
	disponible bit default 1,
	fecha_actualizacion datetime default getdate()
);

-- Inserción de platillos (Configurados para la Canasta)
insert into Platillo(nombre_platillo, tipo, precio, disponible)
values 
('Gallo pinto con huevo revuelto', 'Desayuno', 60, 1),
('Pollo asado', 'Almuerzo', 320, 1),
('Sopa de pescado', 'Especial', 200, 1),
('Cacao', 'Bebida', 30, 1);


-- 4. TABLA: VENTA
create table Venta(
	id_venta int identity(1,1) primary key,
	fecha_venta datetime not null default getdate(),
	total_venta decimal(10,2) not null,
	metodo_pago varchar(20) not null,
	id_usuario int not null,
	foreign key (id_usuario) references Usuario(id_usuario)
);


-- 5. TABLA: DETALLE VENTA
create table DetalleVenta(
	id_detalle int identity(1,1) primary key,
	id_venta int not null,
	id_platillo int not null,
	cantidad int not null,
	subtotal decimal(10,2) not null,
	foreign key (id_venta) references Venta(id_venta),
	foreign key (id_platillo) references Platillo(id_platillo)
);


/* =============================================================
   PROCEDIMIENTOS ALMACENADOS (STORED PROCEDURES)
   ============================================================= */

-- SP 1: Obtener platillos para la Canasta
GO
CREATE PROCEDURE sp_ObtenerPlatillosDisponibles
AS
BEGIN
    SELECT id_platillo, nombre_platillo, precio 
    FROM Platillo 
    WHERE disponible = 1 
    ORDER BY nombre_platillo ASC;
END;
GO

-- SP 2: Registrar la cabecera de la Venta
GO
CREATE PROCEDURE sp_RegistrarVenta
    @total_venta DECIMAL(10, 2),
    @metodo_pago VARCHAR(20),
    @id_usuario INT
AS
BEGIN
    INSERT INTO Venta (fecha_venta, total_venta, metodo_pago, id_usuario)
    VALUES (GETDATE(), @total_venta, @metodo_pago, @id_usuario);
    
    SELECT SCOPE_IDENTITY() AS id_venta;
END;
GO

-- SP 3: Registrar el detalle de la Venta
GO
CREATE PROCEDURE sp_RegistrarDetalleVenta
    @id_venta INT,
    @id_platillo INT,
    @cantidad INT,
    @subtotal DECIMAL(10, 2)
AS
BEGIN
    INSERT INTO DetalleVenta (id_venta, id_platillo, cantidad, subtotal)
    VALUES (@id_venta, @id_platillo, @cantidad, @subtotal);
END;
GO


/* =============================================================
   CONSULTAS DE VISUALIZACIÓN
   ============================================================= */
select * from Usuario;
select * from Platillo;
select * from Venta;
select * from DetalleVenta;