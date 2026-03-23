

create LOGIN administrador with PASSWORD = '12345678';
create user administrador for login administrador;
alter role db_owner add member administrador;

select name from sys.tables;
SELECT TOP 5 * FROM Usuario;

create table Usuario(
	id_usuario int identity(1,1)primary key,
	nombre_usuario varchar(50)not null,
	contraseña varchar(50)not null,
	nombre_completo varchar(100),
	rol varchar(20) default 'Cajero'
);

exec sp_rename 'Usuario.contraseña', '[contraseña]', 'COLUMN';

select *from Usuario;

--Prueba a insertar un Cajero
insert into Usuario(nombre_usuario,contraseña,nombre_completo)
values('cajera','12345678','Esteban Perez');
update Usuario set nombre_completo = 'Esteban Perez' where id_usuario = 3;

--Prueba a insertar un Administrador
insert into Usuario(nombre_usuario,contraseña,nombre_completo,rol)
values('admin','23456789','Karen Ubeda','Administrador');
--delete from Usuario where id_usuario =;

create table Venta(
	id_venta int identity(1,1)primary key,
	fecha_venta date not null,
	total_venta decimal(10,2)not null,
	metodo_pago varchar(20) not null,
	id_usuario int not null,
	foreign key (id_usuario) references Usuario(id_usuario)
);

select *from Venta;

--Prueba de venta
insert into Venta(fecha_venta,total_venta,metodo_pago,id_usuario)
values('08-11-2025','380','Efectivo',1),('07-11-2025','120','Transferencia',1);

create table Platillo(
	id_platillo int identity(1,1)primary key,
	nombre_platillo varchar(100)not null,
	tipo varchar(50)not null,
	precio decimal(10,2)not null,
	disponible bit default 1
);

ALTER TABLE Platillo
ADD fecha_actualizacion DATETIME DEFAULT GETDATE();


select *from Platillo;

--Prueba de platillo disponibles
insert into Platillo(nombre_platillo,tipo,precio)
values('Gallo pinto con huevo revuelto','Desayuno','60'),('Pollo asado','Almuerzo','320');
--Prueba de platillo no disponible
insert into Platillo(nombre_platillo,tipo,precio,disponible)
values('Sopa de pescado','Especial','200','0'),('Cacao','Bebida','30','0');

create table DetalleVenta(
	id_detalle int identity(1,1)primary key,
	id_venta int not null,
	id_platillo int not null,
	cantidad int not null,
	subtotal decimal(10,2)not null,
	foreign key (id_venta) references Venta(id_venta),
	foreign key (id_platillo) references Platillo(id_platillo)
);

--Prueba detalleventa
insert into DetalleVenta(id_venta,id_platillo,cantidad,subtotal)
values(1,1,1,60),(1,2,1,320),(2,1,2,120);

select id_venta,id_platillo,cantidad,subtotal from DetalleVenta;

create table Ingrediente(
	id_ingrediente int identity(1,1) primary key,
	nombre_ingrediente varchar(100) not null,
	unidad_medida varchar(50) not null,
	precio_compra decimal(10,2) not null,
	disponibilidad bit default 1
);

alter table Ingrediente drop column fecha_actualizacion;
alter table Ingrediente add fecha_actualizacion DATETIME not null default getdate();
exec sp_columns Ingrediente;

--Prueba ingrediente disponible
insert into Ingrediente(nombre_ingrediente,unidad_medida,precio_compra)
values('Arroz','Kg',53),('Pollo','Kg',30);
--Prueba ingrediente no disponible
insert into Ingrediente(nombre_ingrediente,unidad_medida,precio_compra,disponibilidad)
values('Huevo','cajilla',180,0),('Frijoles','Kg',60,0);

select *from Ingrediente;

create table Inventario(
	id_inventario int identity(1,1)primary key,
	id_ingrediente int not null,
	cantidad decimal(10,2) not null,
	fecha_actualizacion date not null,
	foreign key(id_ingrediente) references Ingrediente(id_ingrediente)
);

--Prueba inventario
insert into Inventario(id_ingrediente,cantidad,fecha_actualizacion)
values(1,10,GETDATE()),(2,5,GETDATE());

select *from Inventario;

create table Detalle_Platillo(
	id_detalle_platillo int identity(1,1)primary key,
	id_platillo int not null,
	id_ingrediente int not null,
	cantidad_usada decimal(10,2)not null,
	unidad_medida varchar(20)not null,
	foreign key (id_platillo) references Platillo(id_platillo),
	foreign key (id_ingrediente) references Ingrediente(id_ingrediente)
);

--prueba detalleplatillo
insert into Detalle_Platillo(id_platillo,id_ingrediente,cantidad_usada,unidad_medida)
values(2,2,1.20,'Kg');

select *from Detalle_Platillo;

create table Compra(
	id_compra int identity(1,1) primary key,
	fecha_compra date not null default getdate(),
	total_compra decimal(10,2),
	id_usuario int not null,
	foreign key (id_usuario) references Usuario(id_usuario)
);

--Prueba compra
insert into Compra(id_usuario,total_compra)
values(1,150);

select *from Compra;

create table DetalleCompra(
	id_detalle_compra int identity(1,1)primary key,
	id_compra int not null,
	id_ingrediente int not null,
	cantidad decimal(10,2) not null,
	precio decimal(10,2)not null,
	subtotal decimal(10,2)not null,
	foreign key (id_compra) references Compra(id_compra),
	foreign key (id_ingrediente) references Ingrediente(id_ingrediente)
);

--Prueba detallecompra
insert into DetalleCompra(id_compra,id_ingrediente,cantidad,precio,subtotal)
values(1,2,5,30,150);

select *from DetalleCompra;

--Visualizacion de tablas
select *from Usuario;
select *from Venta;
select *from Platillo;
select id_venta,id_platillo,cantidad,subtotal from DetalleVenta;
select *from Ingrediente;
select *from Inventario;
select *from Detalle_Platillo;
select *from Compra;
select *from DetalleCompra;
