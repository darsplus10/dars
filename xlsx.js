/* ============================================================
   قراءة وكتابة ملفات Excel (.xlsx) — بلا مكتبات خارجية ولا خطوة بناء
   الكتابة تنتج OOXML حقيقياً داخل حاوية ZIP، فيفتحه Excel وGoogle Sheets
   وLibreOffice بلا أي تحذير «الصيغة لا تطابق الامتداد».
   والقراءة تفكّ الضغط بـ DecompressionStream المدمج في المتصفح.

     saveXlsx(filename, sheets)   تنزيل مصنَّف
     xlsxBlob(sheets)             بناء المصنَّف بلا تنزيل
     readXlsx(file)               قراءة ملف اختاره المستخدم من جهازه
   ============================================================ */

(function () {
  'use strict';

  /* ---------------------- ZIP (تخزين بلا ضغط) ---------------------- */

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const utf8 = s => new TextEncoder().encode(s);
  const u16 = n => new Uint8Array([n & 255, (n >>> 8) & 255]);
  const u32 = n => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

  function concat(parts) {
    let len = 0;
    parts.forEach(p => { len += p.length; });
    const out = new Uint8Array(len);
    let at = 0;
    parts.forEach(p => { out.set(p, at); at += p.length; });
    return out;
  }

  const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = d => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

  /** حاوية ZIP بطريقة store — Excel يقبلها، ولا نحتاج ضاغطاً. */
  function zipStore(files) {
    const now = new Date();
    const tm = u16(dosTime(now));
    const dt = u16(dosDate(now));
    const locals = [];
    const centrals = [];
    let offset = 0;

    files.forEach(f => {
      const name = utf8(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = concat([
        u32(0x04034b50), u16(20), u16(0), u16(0), tm, dt,
        u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0), name, data,
      ]);
      centrals.push(concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), tm, dt,
        u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
      ]));
      locals.push(local);
      offset += local.length;
    });

    const cd = concat(centrals);
    const eocd = concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cd.length), u32(offset), u16(0),
    ]);
    return concat([concat(locals), cd, eocd]);
  }

  /* ---------------------- XML ---------------------- */

  const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

  const xe = v => String(v == null ? '' : v)
    .replace(/[&<>"']/g, ch => XML_ESC[ch])
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const NS  = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const NSR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NSP = 'http://schemas.openxmlformats.org/package/2006/relationships';

  /** 0 ← A، 26 ← AA */
  function colName(i) {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  /* ---------------------- الأنماط ---------------------- */

  /* أسماء تُمرَّر في الخلية: { v: القيمة, s: 'head' } */
  const STYLE = {
    base:  0,   // نص عادي بلا إطار
    head:  1,   // رأس الجدول: عريض على خلفية رمادية
    title: 2,   // عنوان التقرير
    meta:  3,   // سطر البيانات الصغير تحت العنوان
    text:  4,   // خلية نصية داخل الجدول
    num:   5,   // رقم في الوسط داخل الجدول
    bad:   6,   // رقم أحمر عريض (الغياب بدون عذر)
    total: 7,   // سطر المجموع
    pct:   8,   // نسبة مئوية
  };

  const STYLES_XML = HEAD +
    '<styleSheet xmlns="' + NS + '">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="0&quot;%&quot;"/></numFmts>' +
    '<fonts count="5">' +
      '<font><sz val="11"/><name val="Arial"/></font>' +
      '<font><b/><sz val="11"/><name val="Arial"/></font>' +
      '<font><b/><sz val="14"/><name val="Arial"/></font>' +
      '<font><sz val="10"/><color rgb="FF6B7280"/><name val="Arial"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFB3261E"/><name val="Arial"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF3F9"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border>' +
        '<left style="thin"><color rgb="FFD5DBE4"/></left>' +
        '<right style="thin"><color rgb="FFD5DBE4"/></right>' +
        '<top style="thin"><color rgb="FFD5DBE4"/></top>' +
        '<bottom style="thin"><color rgb="FFD5DBE4"/></bottom>' +
        '<diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="9">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">' +
        '<alignment readingOrder="2"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center" vertical="center" wrapText="1" readingOrder="2"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
        '<alignment readingOrder="2"/></xf>' +
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">' +
        '<alignment readingOrder="2"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
        '<alignment vertical="center" readingOrder="2"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center" vertical="center" readingOrder="2"/></xf>' +
      '<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center" vertical="center" readingOrder="2"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center" vertical="center" readingOrder="2"/></xf>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center" vertical="center" readingOrder="2"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  /* ---------------------- الورقة ---------------------- */

  function cellXml(ref, cell) {
    let v = cell;
    let s = 0;
    if (cell && typeof cell === 'object') { v = cell.v; s = cell.s; }
    const si = typeof s === 'string' ? (STYLE[s] || 0) : (s || 0);
    const attr = ' r="' + ref + '"' + (si ? ' s="' + si + '"' : '');

    if (v === null || v === undefined || v === '') return '<c' + attr + '/>';
    if (typeof v === 'number' && isFinite(v)) return '<c' + attr + '><v>' + v + '</v></c>';
    return '<c' + attr + ' t="inlineStr"><is><t xml:space="preserve">' + xe(v) + '</t></is></c>';
  }

  /** sheet = { name, cols:[عرض], rows:[[خلية]], freeze, filter:'A4:J20', merges:['A1:J1'] } */
  function sheetXml(sh) {
    const rows = sh.rows || [];
    let wide = 1;
    rows.forEach(r => { wide = Math.max(wide, r.length); });

    const cols = (sh.cols || []).map((w, i) =>
      '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('');

    const pane = sh.freeze
      ? '<pane ySplit="' + sh.freeze + '" topLeftCell="A' + (sh.freeze + 1) +
        '" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>'
      : '';

    const body = rows.map((r, ri) =>
      '<row r="' + (ri + 1) + '">' +
      r.map((c, ci) => cellXml(colName(ci) + (ri + 1), c)).join('') +
      '</row>').join('');

    const merges = (sh.merges || []).length
      ? '<mergeCells count="' + sh.merges.length + '">' +
        sh.merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>'
      : '';

    return HEAD +
      '<worksheet xmlns="' + NS + '">' +
      '<dimension ref="A1:' + colName(wide - 1) + Math.max(rows.length, 1) + '"/>' +
      '<sheetViews><sheetView rightToLeft="1" workbookViewId="0">' + pane + '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="18"/>' +
      (cols ? '<cols>' + cols + '</cols>' : '') +
      '<sheetData>' + body + '</sheetData>' +
      (sh.filter ? '<autoFilter ref="' + sh.filter + '"/>' : '') +
      merges +
      '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
      '</worksheet>';
  }

  /** اسم ورقة مقبول في Excel: 31 حرفاً بلا الرموز الممنوعة. */
  const sheetName = (n, i) =>
    (String(n || '').replace(/[\\/?*[\]:]/g, ' ').trim() || ('ورقة ' + (i + 1))).slice(0, 31);

  /* ---------------------- بناء المصنَّف ---------------------- */

  function xlsxBlob(sheets) {
    const list = Array.isArray(sheets) ? sheets : [sheets];

    const names = list.map((sh, i) => sheetName(sh.name, i));
    const workbook = HEAD +
      '<workbook xmlns="' + NS + '" xmlns:r="' + NSR + '"><sheets>' +
      names.map((n, i) =>
        '<sheet name="' + xe(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
      '</sheets></workbook>';

    const wbRels = HEAD +
      '<Relationships xmlns="' + NSP + '">' +
      list.map((sh, i) =>
        '<Relationship Id="rId' + (i + 1) + '" Type="' + NSR + '/worksheet" Target="worksheets/sheet' +
        (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (list.length + 1) + '" Type="' + NSR + '/styles" Target="styles.xml"/>' +
      '</Relationships>';

    const types = HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      list.map((sh, i) =>
        '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    const rootRels = HEAD +
      '<Relationships xmlns="' + NSP + '">' +
      '<Relationship Id="rId1" Type="' + NSR + '/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    const files = [
      { name: '[Content_Types].xml', data: utf8(types) },
      { name: '_rels/.rels',         data: utf8(rootRels) },
      { name: 'xl/workbook.xml',     data: utf8(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(wbRels) },
      { name: 'xl/styles.xml',       data: utf8(STYLES_XML) },
    ];
    list.forEach((sh, i) => {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXml(sh)) });
    });

    return new Blob([zipStore(files)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  function saveXlsx(filename, sheets) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(xlsxBlob(sheets));
    a.download = /\.xlsx$/i.test(filename) ? filename : filename + '.xlsx';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ============================================================
     قراءة ملفات .xlsx
     ============================================================ */

  /** فكّ ضغط deflate عبر المتصفح نفسه — بلا مكتبة. */
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('متصفحك لا يدعم فك ضغط ملفات Excel. حدّثه، أو احفظ الملف بصيغة CSV.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** يفكّ حاوية ZIP ويعيد { 'اسم الجزء': بايتات }. */
  async function unzip(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dec = new TextDecoder();

    let eo = buf.length - 22;
    while (eo >= 0 && dv.getUint32(eo, true) !== 0x06054b50) eo--;
    if (eo < 0) throw new Error('الملف ليس ملف Excel صالحاً (لم أجد فهرس ZIP).');

    const count = dv.getUint16(eo + 10, true);
    let off = dv.getUint32(eo + 16, true);
    const out = {};

    for (let i = 0; i < count; i++) {
      if (off + 46 > buf.length || dv.getUint32(off, true) !== 0x02014b50) break;
      const method  = dv.getUint16(off + 10, true);
      const csize   = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const cmtLen  = dv.getUint16(off + 32, true);
      const lho     = dv.getUint32(off + 42, true);
      const name    = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));

      // أطوال الترويسة المحلية قد تختلف عن الفهرس، فنقرأها من مكانها
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const raw = buf.subarray(start, start + csize);
      out[name] = method === 0 ? raw : await inflateRaw(raw);

      off += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  const parseXml = bytes =>
    new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');

  const tagsOf = (node, tag) => Array.prototype.slice.call(node.getElementsByTagName(tag));

  /** جدول النصوص المشتركة — Excel يخزّن كل نص مرة واحدة ويشير إليه برقم. */
  function sharedStrings(doc) {
    if (!doc) return [];
    return tagsOf(doc, 'si').map(si =>
      tagsOf(si, 't')
        .filter(t => !t.parentNode || t.parentNode.nodeName.indexOf('rPh') === -1)
        .map(t => t.textContent).join(''));
  }

  /* تنسيقات التاريخ المدمجة في Excel */
  const DATE_FMT = [14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57];

  /** لكل نمط خلية: هل هو تنسيق تاريخ؟ (Excel يخزّن التواريخ كأرقام) */
  function dateStyles(doc) {
    if (!doc) return [];
    const custom = {};
    tagsOf(doc, 'numFmt').forEach(n => {
      const code = (n.getAttribute('formatCode') || '')
        .replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
      custom[Number(n.getAttribute('numFmtId'))] = /[ymd]/i.test(code);
    });
    const xfs = doc.getElementsByTagName('cellXfs')[0];
    if (!xfs) return [];
    return tagsOf(xfs, 'xf').map(xf => {
      const id = Number(xf.getAttribute('numFmtId') || 0);
      return DATE_FMT.indexOf(id) !== -1 || custom[id] === true;
    });
  }

  /* Excel يعدّ الأيام من 1899-12-30 (مع خطأ سنة 1900 الكبيسة التاريخي) */
  const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
  const serialToDate = n => new Date(EXCEL_EPOCH + Math.round(n * 86400) * 1000);

  /** 'B7' ← 1 */
  function refCol(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const ch = ref.charCodeAt(i);
      if (ch < 65 || ch > 90) break;
      n = n * 26 + (ch - 64);
    }
    return n - 1;
  }

  function sheetRows(doc, strings, flags) {
    const rows = [];
    tagsOf(doc, 'row').forEach(row => {
      const ri = Number(row.getAttribute('r') || (rows.length + 1)) - 1;
      const cells = [];
      tagsOf(row, 'c').forEach(c => {
        const ref = c.getAttribute('r') || '';
        const ci = ref ? refCol(ref) : cells.length;
        const t = c.getAttribute('t');
        let val = null;

        if (t === 'inlineStr') {
          const is = c.getElementsByTagName('is')[0];
          val = is ? tagsOf(is, 't').map(x => x.textContent).join('') : '';
        } else {
          const v = c.getElementsByTagName('v')[0];
          const raw = v ? v.textContent : null;
          if (raw === null || raw === '') val = null;
          else if (t === 's') val = strings[Number(raw)] != null ? strings[Number(raw)] : '';
          else if (t === 'str') val = raw;
          else if (t === 'b') val = raw === '1';
          else if (t === 'e') val = null;
          else {
            const num = Number(raw);
            const si = Number(c.getAttribute('s') || 0);
            if (!isFinite(num)) val = raw;
            else val = flags[si] ? serialToDate(num) : num;
          }
        }
        if (ci >= 0) cells[ci] = val;
      });
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
      if (ri >= 0) rows[ri] = cells;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  }

  /** يقرأ ملف Excel من جهاز المستخدم → { sheets: [{ name, rows }] } */
  async function readXlsx(file) {
    const parts = await unzip(new Uint8Array(await file.arrayBuffer()));
    const get = n => (parts[n] ? parseXml(parts[n]) : null);

    const strings = sharedStrings(get('xl/sharedStrings.xml'));
    const flags = dateStyles(get('xl/styles.xml'));

    const relMap = {};
    const rels = get('xl/_rels/workbook.xml.rels');
    if (rels) {
      tagsOf(rels, 'Relationship').forEach(r => {
        relMap[r.getAttribute('Id')] = r.getAttribute('Target') || '';
      });
    }

    const sheets = [];
    const wb = get('xl/workbook.xml');
    if (wb) {
      tagsOf(wb, 'sheet').forEach(s => {
        const rid = s.getAttributeNS(NSR, 'id') || s.getAttribute('r:id');
        const target = String(relMap[rid] || '').replace(/^\/?xl\//, '').replace(/^\//, '');
        const path = parts['xl/' + target] ? 'xl/' + target : (parts[target] ? target : '');
        if (!path) return;
        sheets.push({
          name: s.getAttribute('name') || '',
          rows: sheetRows(parseXml(parts[path]), strings, flags),
        });
      });
    }
    if (!sheets.length && parts['xl/worksheets/sheet1.xml']) {
      sheets.push({
        name: 'ورقة1',
        rows: sheetRows(parseXml(parts['xl/worksheets/sheet1.xml']), strings, flags),
      });
    }
    if (!sheets.length) throw new Error('لم أجد أي ورقة داخل الملف.');
    return { sheets };
  }

  window.xlsxBlob = xlsxBlob;
  window.saveXlsx = saveXlsx;
  window.readXlsx = readXlsx;
})();
