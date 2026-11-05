/* =====================================================================
   FACTURA COMPARTIDA (cliente y administrador)
   Mismo formato que el comprobante PDF de la compra.
   Factura.html(f) -> HTML para mostrar en pantalla (sin botones de imprimir)
   Factura.pdf(f)  -> descarga / imprime el PDF
   f = { id_venta, fecha_venta, nombre_mostrar, metodo_pago, total_venta,
         reembolso_estado, items: [{ nombre, precio, cantidad, subtotal }] }
   ===================================================================== */
(function () {
    function esc(t) {
        return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function dinero(n) { return 'C$ ' + Number(n || 0).toFixed(2); }

    function esTarjeta(metodo) { return String(metodo || '').toLowerCase().indexOf('tarjeta') !== -1; }

    function totales(f) {
        var subtotal = (f.items || []).reduce(function (a, i) { return a + Number(i.subtotal || 0); }, 0);
        var total = f.total_venta != null ? Number(f.total_venta) : subtotal;
        var iva = esTarjeta(f.metodo_pago) ? Math.max(0, total - subtotal) : 0;
        return { subtotal: subtotal, iva: iva, total: total };
    }

    function fechaTexto(f) {
        var d = new Date(f.fecha_venta);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString('es-NI') + ' ' + d.toLocaleTimeString('es-NI');
    }

    function nombreMetodo(m) { return String(m || 'Efectivo').replace(/[^\wÁÉÍÓÚáéíóúñÑ ]/g, '').trim(); }

    function html(f) {
        var t = totales(f);
        var filas = (f.items || []).map(function (i, idx) {
            return '<tr style="background:' + (idx % 2 === 0 ? '#f4f4f4' : '#ffffff') + ';">' +
                '<td style="padding:10px;">' + esc(i.nombre) + '</td>' +
                '<td style="padding:10px;text-align:right;white-space:nowrap;">' + dinero(i.precio) + '</td>' +
                '<td style="padding:10px;text-align:center;">' + esc(i.cantidad) + '</td>' +
                '<td style="padding:10px;text-align:right;white-space:nowrap;">' + dinero(i.subtotal) + '</td></tr>';
        }).join('');

        var desglose = '';
        if (t.iva > 0) {
            desglose =
                '<tr><td style="padding:2px 18px 2px 0;">Subtotal:</td><td style="text-align:right;">' + dinero(t.subtotal) + '</td></tr>' +
                '<tr><td style="padding:2px 18px 2px 0;">IVA (15%):</td><td style="text-align:right;">' + dinero(t.iva) + '</td></tr>';
        }

        var sello = f.reembolso_estado === 'Aceptado'
            ? '<div style="margin-top:12px;display:inline-block;border:2px solid #2e7d32;color:#2e7d32;border-radius:6px;padding:3px 12px;font-weight:bold;font-size:13px;">COMPRA REEMBOLSADA</div>'
            : '';

        return '<div style="font-family:Arial,Helvetica,sans-serif;color:#555;text-align:left;padding:4px 8px;">' +
            '<div style="display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;">' +
                '<div><div style="font-size:30px;font-weight:bold;color:#e30613;line-height:1.1;">COMO EN CASA</div>' +
                '<div style="font-size:14px;margin-top:6px;line-height:1.5;">Sabor Casero y Tradicional<br>Managua, Nicaragua</div></div>' +
                '<div><div style="font-weight:bold;font-size:15px;color:#444;">COMPROBANTE DE COMPRA</div>' +
                '<div style="font-size:14px;margin-top:6px;line-height:1.5;">No. Registro: #' + esc(f.id_venta) + '<br>Fecha: ' + esc(fechaTexto(f)) + '</div></div>' +
            '</div>' +
            '<div style="border-top:3px solid #e30613;margin:14px 0;"></div>' +
            '<div style="font-size:14px;line-height:1.9;"><b>Cliente / Atendido por:</b> ' + esc(f.nombre_mostrar || 'Anónimo') +
                '<br><b>Método de Pago:</b> ' + esc(nombreMetodo(f.metodo_pago)) + '</div>' +
            sello +
            '<table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px;">' +
                '<thead><tr style="background:#e30613;color:#fff;">' +
                '<th style="text-align:left;padding:10px;">Producto</th>' +
                '<th style="text-align:right;padding:10px;">Precio Unit.</th>' +
                '<th style="text-align:center;padding:10px;">Cant.</th>' +
                '<th style="text-align:right;padding:10px;">Subtotal</th></tr></thead>' +
                '<tbody>' + filas + '</tbody></table>' +
            '<div style="display:flex;justify-content:flex-end;margin-top:14px;">' +
                '<table style="font-size:15px;border-collapse:collapse;">' + desglose +
                '<tr style="font-weight:bold;font-size:18px;color:#444;"><td style="padding:6px 18px 0 0;">TOTAL NETO:</td><td style="text-align:right;padding-top:6px;">' + dinero(t.total) + '</td></tr></table>' +
            '</div>' +
            '<div style="text-align:center;font-style:italic;font-size:13px;margin-top:18px;">¡Muchas gracias por ser parte de nuestra gran familia!</div>' +
        '</div>';
    }

    function pdf(f) {
        var jsPDF = window.jspdf.jsPDF;
        var doc = new jsPDF({ unit: 'mm', format: 'a5' });
        var rojo = [227, 6, 19];
        var gris = [85, 85, 85];
        var t = totales(f);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.setTextColor(rojo[0], rojo[1], rojo[2]);
        doc.text('COMO EN CASA', 15, 15);

        doc.setFontSize(9);
        doc.setTextColor(gris[0], gris[1], gris[2]);
        doc.setFont('helvetica', 'normal');
        doc.text('Sabor Casero y Tradicional', 15, 20);
        doc.text('Managua, Nicaragua', 15, 24);

        doc.setFont('helvetica', 'bold');
        doc.text('COMPROBANTE DE COMPRA', 82, 15);
        doc.setFont('helvetica', 'normal');
        doc.text('No. Registro: #' + f.id_venta, 82, 20);
        doc.text('Fecha: ' + fechaTexto(f), 82, 24);

        doc.setDrawColor(rojo[0], rojo[1], rojo[2]);
        doc.setLineWidth(0.5);
        doc.line(15, 28, 135, 28);

        doc.setFont('helvetica', 'bold');
        doc.text('Cliente / Atendido por:', 15, 35);
        doc.setFont('helvetica', 'normal');
        doc.text(String(f.nombre_mostrar || 'Anónimo'), 53, 35);

        doc.setFont('helvetica', 'bold');
        doc.text('Método de Pago:', 15, 40);
        doc.setFont('helvetica', 'normal');
        doc.text(nombreMetodo(f.metodo_pago), 45, 40);

        doc.autoTable({
            startY: 46,
            margin: { left: 15, right: 15 },
            head: [['Producto', 'Precio Unit.', 'Cant.', 'Subtotal']],
            body: (f.items || []).map(function (i) {
                return [i.nombre, dinero(i.precio), i.cantidad, dinero(i.subtotal)];
            }),
            theme: 'striped',
            headStyles: { fillColor: rojo, textColor: [255, 255, 255], fontStyle: 'bold' },
            styles: { font: 'helvetica', fontSize: 9 },
            columnStyles: { 0: { cellWidth: 'auto' }, 1: { halign: 'right' }, 2: { halign: 'center' }, 3: { halign: 'right' } }
        });

        var y = doc.lastAutoTable.finalY + 8;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);

        if (t.iva > 0) {
            doc.text('Subtotal:', 80, y);
            doc.text(dinero(t.subtotal), 135, y, { align: 'right' });
            y += 5;
            doc.text('IVA (15%):', 80, y);
            doc.text(dinero(t.iva), 135, y, { align: 'right' });
            y += 6;
        }

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('TOTAL NETO:', 80, y);
        doc.text(dinero(t.total), 135, y, { align: 'right' });

        if (f.reembolso_estado === 'Aceptado') {
            doc.setTextColor(46, 125, 50);
            doc.setFontSize(10);
            doc.text('COMPRA REEMBOLSADA', 80, y + 8);
            doc.setTextColor(gris[0], gris[1], gris[2]);
        }

        doc.setFont('helvetica', 'italic');
        doc.setFontSize(9);
        doc.text('¡Muchas gracias por ser parte de nuestra gran familia!', 75, y + 20, { align: 'center' });

        doc.save('Factura_ComoEnCasa_' + f.id_venta + '.pdf');
    }

    window.Factura = { html: html, pdf: pdf, esc: esc, dinero: dinero };
})();
