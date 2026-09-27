/* ============================================================
   DarsPlus — أحد منتجات أنظمة تسنيم المحوسبة (Tasnim Systems)
   سجل الصف الدراسي — تطبيق ثابت يعمل بالكامل داخل المتصفح
   التخزين: localStorage  |  التاريخ والوقت: من نظام الجهاز
   ============================================================ */

const STORE_KEY = 'sijil.v1';

const STATUS = {
  present: { label: 'حاضر',  cls: 'present' },
  late:    { label: 'متأخر', cls: 'late'    },
  excused: { label: 'مأذون', cls: 'excused' },
  absent:  { label: 'غائب',  cls: 'absent'  },
};
const STATUS_KEYS = Object.keys(STATUS);

/* ---------------------- التخزين ---------------------- */

let DB = { classes: [] };

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    DB = raw ? JSON.parse(raw) : { classes: [] };
    if (!Array.isArray(DB.classes)) DB.classes = [];
  } catch (e) {
    DB = { classes: [] };
  }
  ensureRoster();
}

/** ملف الصف قسم مستقل — يُهيّأ هنا، ويُرحَّل إليه ما كان محفوظاً داخل صف سابقاً. */
function ensureRoster() {
  if (!DB.roster || typeof DB.roster !== 'object') DB.roster = {};
  if (!DB.roster.name) DB.roster.name = ROSTER_NAME;
  if (!Array.isArray(DB.roster.students)) DB.roster.students = [];
  if (!Array.isArray(DB.roster.letters)) DB.roster.letters = [];
  if (DB.roster.students.length) return;

  const src = DB.classes.find(c =>
    Array.isArray(c.students) && c.students.some(st => hasProfile(st) || eventsOf(st).length));
  if (!src) return;

  DB.roster.students = src.students
    .filter(st => hasProfile(st) || eventsOf(st).length)
    .map(st => JSON.parse(JSON.stringify(st)));

  // الصف يحتفظ بما يلزم الحضور فقط
  src.students.forEach(st => {
    PROFILE_KEYS.forEach(k => { if (k !== 'phone') delete st[k]; });
    delete st.events;
  });
}

/** حفظ محلي فوري، ثم مزامنة مع الخادم إن كان متاحاً. */
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(DB));
  } catch (e) {
    /* التخزين المحلي مجرد ذاكرة مؤقتة عند العمل مع الخادم */
  }
  if (REMOTE.mode === 'remote') schedulePush();
}

const findClass   = id => DB.classes.find(c => c.id === id);
const findSession = (cls, id) => cls && cls.sessions.find(s => s.id === id);

/* ---------------------- المزامنة مع الخادم ---------------------- */

const KEY_STORE = 'sijil.key';

/* ---------------------- الدخول ---------------------- */

/* اسم المستخدم، وبصمة SHA-256 لكلمة المرور بدل كتابتها صريحة في الملف.
   هذا يمنع قراءتها بالعين من مصدر الصفحة فقط — الحماية الحقيقية هي
   APP_PASSWORD على الخادم، لأنه وحده يمنع جلب البيانات من /api/data. */
const AUTH_USER = 'bashir';
const AUTH_HASH = '7fa8edcb36ee4688347e5b319a04a6508c9002f234336fa3de75b4c77ae2d39c';
const SESSION_KEY = 'sijil.session';

const SESSION = { ok: false, user: '' };

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** يستعيد جلسة سابقة من هذا المتصفح. */
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && s.user) { SESSION.ok = true; SESSION.user = s.user; }
  } catch (e) { /* جلسة تالفة — تُتجاهل */ }
}

function endSession() {
  SESSION.ok = false;
  SESSION.user = '';
  REMOTE.key = '';
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(KEY_STORE);
  paintSession();
  router();
}

/** يُظهر أو يُخفي شريط التنقّل واسم المستخدم حسب حالة الدخول. */
function paintSession() {
  document.body.classList.toggle('locked', !SESSION.ok);
  const who = document.getElementById('whoBadge');
  if (who) {
    who.textContent = SESSION.ok ? SESSION.user : '';
    who.hidden = !SESSION.ok;
  }
}

const REMOTE = {
  mode: 'local',       // local | remote
  protected: false,
  key: '',
  status: 'local',     // local | syncing | saved | offline | locked | conflict
  updatedAt: null,
  timer: null,
  pending: false,
};

const STATUS_TEXT = {
  local:    'تخزين محلي',
  syncing:  'جارٍ الحفظ…',
  saved:    'محفوظ على الموقع',
  offline:  'تعذّر الاتصال — محفوظ محلياً',
  locked:   'مقفل',
  conflict: 'تعارض مع جهاز آخر',
};

function setStatus(s) {
  REMOTE.status = s;
  const el = document.getElementById('syncBadge');
  if (!el) return;
  el.textContent = STATUS_TEXT[s] || s;
  el.className = 'sync ' + s;
}

/** ترويسات HTTP تقبل ASCII فقط، لذا يُرسل المفتاح بترميز base64 ليدعم العربية. */
const encodeKey = s =>
  btoa(String.fromCharCode.apply(null, Array.from(new TextEncoder().encode(s))));

const apiHeaders = () => {
  const h = { 'content-type': 'application/json' };
  if (REMOTE.key) h['x-app-key'] = encodeKey(REMOTE.key);
  return h;
};

/** هل الموقع يملك خادماً للحفظ؟ */
async function detectServer() {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json();
    if (!j || !j.server) return false;
    REMOTE.mode = 'remote';
    REMOTE.protected = !!j.protected;
    REMOTE.key = REMOTE.protected ? (localStorage.getItem(KEY_STORE) || '') : '';
    return true;
  } catch (e) {
    return false;
  }
}

/** جلب البيانات من الخادم. */
async function pull() {
  if (REMOTE.mode !== 'remote') return;
  if (REMOTE.protected && !REMOTE.key) { setStatus('locked'); return; }

  setStatus('syncing');
  try {
    const r = await fetch('/api/data', { headers: apiHeaders(), cache: 'no-store' });
    if (r.status === 401) { REMOTE.key = ''; localStorage.removeItem(KEY_STORE); setStatus('locked'); return; }
    if (!r.ok) throw new Error('http ' + r.status);

    const j = await r.json();
    REMOTE.updatedAt = j.updatedAt;

    if (j.data && Array.isArray(j.data.classes)) {
      DB = j.data;
      ensureRoster();
      try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) {}
    } else if (DB.classes.length || DB.roster.students.length) {
      // الخادم فارغ وعندنا بيانات محلية سابقة — نرفعها كبداية
      await push(true);
      return;
    }
    setStatus('saved');
  } catch (e) {
    setStatus('offline');
  }
}

/** تأجيل الرفع لتجميع التعديلات المتتابعة. */
function schedulePush() {
  setStatus('syncing');
  clearTimeout(REMOTE.timer);
  REMOTE.timer = setTimeout(() => push(false), 700);
}

/** رفع البيانات إلى الخادم. */
async function push(force) {
  if (REMOTE.mode !== 'remote') return;
  if (REMOTE.protected && !REMOTE.key) { setStatus('locked'); return; }
  if (REMOTE.pending) { schedulePush(); return; }

  REMOTE.pending = true;
  setStatus('syncing');
  try {
    const r = await fetch('/api/data', {
      method: 'PUT',
      headers: apiHeaders(),
      body: JSON.stringify({ data: DB, baseUpdatedAt: REMOTE.updatedAt, force: !!force }),
    });

    if (r.status === 401) { REMOTE.key = ''; localStorage.removeItem(KEY_STORE); setStatus('locked'); router(); return; }

    if (r.status === 409) {
      setStatus('conflict');
      const ok = confirm(
        'تم تعديل البيانات من جهاز آخر بعد آخر مزامنة.\n\n' +
        'موافق = اعتماد بيانات هذا الجهاز والكتابة فوق الأخرى\n' +
        'إلغاء = جلب بيانات الخادم والتخلّي عن تعديلات هذا الجهاز'
      );
      REMOTE.pending = false;
      if (ok) return push(true);
      await pull();
      router();
      return;
    }

    if (!r.ok) throw new Error('http ' + r.status);

    const j = await r.json();
    REMOTE.updatedAt = j.updatedAt;
    setStatus('saved');
  } catch (e) {
    setStatus('offline');
  } finally {
    REMOTE.pending = false;
  }
}

/** صفحة الدخول: اسم مستخدم وكلمة مرور. */
function viewLogin() {
  paintSession();
  render(`
    <div class="login">
      <div class="login-card">
        <div class="login-logo">📘</div>
        <h1>DarsPlus</h1>
        <p class="maker">أحد منتجات أنظمة تسنيم المحوسبة · Tasnim Systems</p>
        <p class="sub">سجّل الدخول للوصول إلى الصفوف وبطاقات الطلاب.</p>

        <form id="loginForm" autocomplete="on">
          <div class="field">
            <label for="usr">اسم المستخدم</label>
            <input type="text" id="usr" name="username" autocomplete="username"
                   autocapitalize="off" spellcheck="false" required autofocus>
          </div>
          <div class="field">
            <label for="pw">كلمة المرور</label>
            <input type="password" id="pw" name="password"
                   autocomplete="current-password" required>
          </div>
          <button class="btn login-btn" type="submit" id="loginBtn">دخول</button>
          <div class="login-msg" id="loginMsg" role="status"></div>
        </form>
      </div>
    </div>
  `);

  const msg = document.getElementById('loginMsg');
  const fail = text => {
    msg.textContent = text;
    msg.className = 'login-msg bad';
    document.getElementById('loginBtn').disabled = false;
  };

  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    msg.textContent = 'جارٍ التحقق…';
    msg.className = 'login-msg';

    const user = document.getElementById('usr').value.trim().toLowerCase();
    const pass = document.getElementById('pw').value;

    let hash = '';
    try {
      hash = await sha256Hex(pass);
    } catch (err) {
      fail('المتصفح لا يدعم التحقق المطلوب. حدّثه أو افتح الموقع عبر https.');
      return;
    }

    if (user !== AUTH_USER || hash !== AUTH_HASH) {
      fail('اسم المستخدم أو كلمة المرور غير صحيحة.');
      return;
    }

    // الخادم محمي؟ إذن كلمة المرور نفسها هي مفتاح /api/data
    if (REMOTE.mode === 'remote' && REMOTE.protected) {
      REMOTE.key = pass;
      let r;
      try {
        r = await fetch('/api/data', { headers: apiHeaders(), cache: 'no-store' });
      } catch (err) {
        REMOTE.key = '';
        fail('تعذّر الاتصال بالخادم. تحقّق من الشبكة وأعد المحاولة.');
        return;
      }
      if (r.status === 401) {
        REMOTE.key = '';
        fail('الخادم رفض كلمة المرور — اضبط APP_PASSWORD في Netlify على القيمة نفسها.');
        return;
      }
      localStorage.setItem(KEY_STORE, REMOTE.key);
    }

    SESSION.ok = true;
    SESSION.user = AUTH_USER;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user: AUTH_USER, at: Date.now() }));
    paintSession();

    if (REMOTE.mode === 'remote') {
      setStatus('syncing');
      await pull();
    }
    go('/');
    router();
  });
}

/* ---------------------- أدوات عامة ---------------------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ESCAPES[c]);

const pad2 = n => String(n).padStart(2, '0');

/** تاريخ اليوم من نظام الجهاز بصيغة YYYY-MM-DD. */
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** وقت النظام الحالي HH:MM. */
function nowTime() {
  const d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

const WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function weekdayAr(iso) {
  const p = String(iso).split('-').map(Number);
  return WEEKDAYS[new Date(p[0], p[1] - 1, p[2]).getDay()] || '';
}

const fmtDate = iso => weekdayAr(iso) + ' ' + iso;

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
                   'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

/** '2026-09' ← 'سبتمبر 2026' */
function monthLabel(ym) {
  const p = String(ym || '').split('-');
  return (MONTHS_AR[Number(p[1]) - 1] || '') + ' ' + (p[0] || '');
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/** تنزيل ملف نصي (مع BOM ليقرأ Excel العربية بشكل صحيح). */
function download(filename, text, bom) {
  const blob = new Blob([(bom === false ? '' : '﻿') + text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const csvRow  = arr => arr.map(csvCell).join(',');

const classHeader = c =>
  [c.subject, c.grade, c.section, c.year, c.location].filter(Boolean).join(' · ');

/* ---------------------- إحصاءات ---------------------- */

function emptyCounts() {
  return { present: 0, late: 0, excused: 0, absent: 0 };
}

/** عدّاد الحالات في حصة واحدة. */
function sessionCounts(cls, session) {
  const out = emptyCounts();
  cls.students.forEach(st => {
    const r = session.records[st.id];
    if (r && out[r.status] !== undefined) out[r.status]++;
  });
  return out;
}

/** إحصاء طالب عبر كل حصص الصف — أو عبر قائمة حصص محدودة (مدى تاريخي مثلاً).
 *  يجمع كذلك تواريخ كل حالة ليعرضها تقرير الغياب مفصّلة. */
function studentStats(cls, studentId, sessions) {
  const out = emptyCounts();
  out.total = 0;
  out.minutesLate = 0;
  out.dates = { present: [], late: [], excused: [], absent: [] };
  (sessions || cls.sessions).forEach(s => {
    const r = s.records[studentId];
    if (!r) return;
    out.total++;
    if (out[r.status] !== undefined) out[r.status]++;
    if (out.dates[r.status]) {
      out.dates[r.status].push(
        s.date + (r.status === 'late' && r.late ? ' (' + r.late + ' د)' : ''));
    }
    out.minutesLate += Number(r.late || 0);
  });
  out.attended = out.present + out.late;
  out.missed = out.absent + out.excused;
  out.rate = out.total ? Math.round((out.attended / out.total) * 100) : 0;
  out.absentRate = out.total ? Math.round((out.missed / out.total) * 100) : 0;
  return out;
}

/** ترتيب الحصص: الأحدث أولاً. */
const sortedSessions = cls =>
  cls.sessions.slice().sort((a, b) =>
    (b.date + pad2(b.period)).localeCompare(a.date + pad2(a.period)));

/** ترتيب الحصص: الأقدم أولاً — توثيق الدروس يُقرأ بتسلسل زمني. */
const chronoSessions = cls =>
  cls.sessions.slice().sort((a, b) =>
    (a.date + pad2(a.period)).localeCompare(b.date + pad2(b.period)));

/** الأشهر التي فيها حصص مسجّلة — مصدر قائمة «حسب الشهر»، الأقدم أولاً. */
const monthsOf = cls =>
  Array.from(new Set(cls.sessions.map(s => (s.date || '').slice(0, 7)).filter(Boolean))).sort();

/** يحوّل اختيار الفترة إلى مدى تاريخي + عنوان يُكتب في الترويسة المطبوعة. */
function periodSpan(v) {
  if (v.mode === 'month' && v.month) {
    return { from: v.month + '-01', to: v.month + '-31', label: 'شهر ' + monthLabel(v.month) };
  }
  if (v.mode === 'range' && (v.from || v.to)) {
    return {
      from: v.from,
      to: v.to,
      label: (v.from ? 'من ' + v.from : 'من بداية السجل') +
             (v.to ? ' إلى ' + v.to : ' حتى آخر حصة'),
    };
  }
  return { from: '', to: '', label: 'كل الفترة' };
}

/** أسماء طلاب حصة واحدة مصنّفة حسب الحالة (للتقارير المطبوعة). */
function namesByStatus(cls, session) {
  const out = { present: [], late: [], excused: [], absent: [] };
  cls.students.forEach(st => {
    const r = session.records[st.id];
    if (!r || !out[r.status]) return;
    out[r.status].push(st.name + (r.status === 'late' && r.late ? ' (' + r.late + ' د)' : ''));
  });
  return out;
}

/** هل كُتب «ما تم إنجازه» — وهو جوهر توثيق الدرس، لا الحضور وحده؟ */
const isDocumented = s => !!(s.notes || '').trim();

/* ---------------------- الطباعة ---------------------- */

const nl2br = v => esc(v).replace(/\n/g, '<br>');

/** ترويسة تظهر في الورقة المطبوعة فقط — المطبوع يفقد شريط الموقع. */
function printHead(cls, title, extra) {
  return `<div class="print-only print-head">
      <div class="ph-top"><b>${esc(title)}</b><span>طُبع في ${esc(fmtDate(todayISO()))}</span></div>
      <div class="ph-meta">${esc(cls.name)}${classHeader(cls) ? ' · ' + esc(classHeader(cls)) : ''}${
        cls.teacher ? ' · المعلم: ' + esc(cls.teacher) : ''}${extra ? ' · ' + esc(extra) : ''}</div>
    </div>`;
}

/** سطر التواقيع أسفل الورقة المطبوعة. */
const printSign = () => `<div class="print-only sign-row">
    <span>توقيع المعلم: ......................</span>
    <span>الاطلاع: ......................</span>
    <span>التاريخ: ..................</span>
  </div>`;

/* ---------------------- التوجيه ---------------------- */

const app = document.getElementById('app');

const ROUTES = [
  [/^\/?$/,                                      () => viewHome()],
  [/^\/classes$/,                                () => viewClasses()],
  [/^\/profile$/,                                () => viewProfile()],
  [/^\/profile\/card\/new$/,                     () => viewCardForm(null)],
  [/^\/profile\/card\/([^/]+)$/,                  m => viewCardForm(m[1])],
  [/^\/profile\/events$/,                       () => viewEvents('')],
  [/^\/profile\/events\/([^/]+)$/,               m => viewEvents(m[1])],
  [/^\/profile\/event\/new$/,                   () => viewEventForm(null, '')],
  [/^\/profile\/event\/new\/([^/]+)$/,           m => viewEventForm(null, m[1])],
  [/^\/profile\/event\/([^/]+)$/,                m => viewEventForm(m[1], '')],
  [/^\/profile\/letters$/,                      () => viewLetters()],
  [/^\/profile\/letter\/new\/([^/]+)$/,          m => viewLetterForm(null, m[1])],
  [/^\/profile\/letter\/([^/]+)$/,               m => viewLetterForm(m[1], '')],
  [/^\/backup$/,                                 () => viewBackup()],
  [/^\/class\/new$/,                             () => viewClassForm(null)],
  [/^\/class\/([^/]+)\/edit$/,                   m => viewClassForm(m[1])],
  [/^\/class\/([^/]+)\/students$/,               m => viewStudents(m[1])],
  [/^\/class\/([^/]+)\/report$/,                 m => viewReport(m[1])],
  [/^\/class\/([^/]+)\/absence$/,                m => viewAbsence(m[1])],
  [/^\/class\/([^/]+)\/lessons$/,                m => viewLessons(m[1])],
  [/^\/class\/([^/]+)\/session\/new$/,           m => viewSessionForm(m[1], null)],
  [/^\/class\/([^/]+)\/session\/([^/]+)\/edit$/, m => viewSessionForm(m[1], m[2])],
  [/^\/class\/([^/]+)\/session\/([^/]+)$/,       m => viewSession(m[1], m[2])],
  [/^\/class\/([^/]+)$/,                         m => viewClass(m[1])],
];

function router() {
  if (!SESSION.ok || REMOTE.status === 'locked') { viewLogin(); return; }

  const path = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
  for (let i = 0; i < ROUTES.length; i++) {
    const m = path.match(ROUTES[i][0]);
    if (m) { ROUTES[i][1](m); window.scrollTo(0, 0); return; }
  }
  render('<div class="empty">الصفحة غير موجودة. <a href="#/">العودة للرئيسية</a></div>');
}

const render = html => { app.innerHTML = html; };
const go = path => { location.hash = '#' + path; };
const notFound = what => render('<div class="empty">' + what + ' غير موجود. <a href="#/">العودة للرئيسية</a></div>');

/* ---------------------- الرئيسية: بوّابة القسمين ---------------------- */

/** صفحة البداية: زرّان كبيران — توثيق الدروس، وملف الصف. */
function viewHome() {
  const classes  = DB.classes.length;
  const students = DB.classes.reduce((n, c) => n + c.students.length, 0);
  const sessions = DB.classes.reduce((n, c) => n + c.sessions.length, 0);
  const cards    = DB.roster.students.length;
  const filled   = DB.roster.students.filter(hasProfile).length;

  render(`
    <div class="hero">
      <h1>DarsPlus</h1>
      <p class="sub">اختر ما تريد العمل عليه.</p>
    </div>

    <div class="hubgrid">
      <a class="hub" href="#/classes">
        <span class="hub-ico">📘</span>
        <h2>توثيق الدروس</h2>
        <p>الصفوف وقوائم الطلاب، تسجيل الحضور والغياب والتأخر، توثيق الحصص،
           وتقارير الحضور والغياب مع الطباعة وتحميل Excel.</p>
        <span class="hub-meta">${classes} صفاً · ${students} طالباً · ${sessions} حصة موثّقة</span>
        <span class="hub-go">ادخل</span>
      </a>

      <a class="hub alt" href="#/profile">
        <span class="hub-ico">🪪</span>
        <h2>ملف الصف</h2>
        <p>ملف مستقل لصف ${esc(DB.roster.name)}: بطاقة هوية لكل طالب، وسجل أحداث
           يوثّق السلوك والحوادث ولقاءات الأهل والمحادثات.</p>
        <span class="hub-meta">${esc(DB.roster.name)} · ${cards} بطاقة · ${filled} مكتملة</span>
        <span class="hub-go">ادخل</span>
      </a>
    </div>
  `);
}

/* ---------------------- الصفوف ---------------------- */

function viewClasses() {
  const cards = DB.classes.map(c => {
    const tags = [c.subject, c.grade, c.section, c.year].filter(Boolean)
      .map(t => '<span class="tag">' + esc(t) + '</span>').join('');
    return '<a class="classcard" href="#/class/' + c.id + '">' +
             '<h3>' + esc(c.name) + '</h3>' +
             '<div>' + (tags || '<span class="tag">بدون عناوين</span>') + '</div>' +
             '<div class="meta">' + c.students.length + ' طالب · ' +
             c.sessions.length + ' حصة موثّقة</div>' +
           '</a>';
  }).join('');

  render(`
    <div class="crumb"><a href="#/">الرئيسية</a> ← الصفوف</div>
    <div class="page-head">
      <div>
        <h1>الصفوف الدراسية</h1>
        <p class="sub">أنشئ صفاً، ارفع قائمة الطلاب، ثم سجّل الحضور ووثّق الحصص.</p>
      </div>
      <div class="actions"><a class="btn" href="#/class/new">+ صف جديد</a></div>
    </div>
    ${DB.classes.length
      ? '<div class="grid g2">' + cards + '</div>'
      : '<div class="empty">لا توجد صفوف بعد.<br><br><a class="btn" href="#/class/new">إنشاء أول صف</a></div>'}
  `);
}

/* ---------------------- إنشاء / تعديل صف ---------------------- */

function viewClassForm(id) {
  const c = id ? findClass(id) : null;
  if (id && !c) return notFound('الصف');
  const v = f => esc(c ? c[f] || '' : '');

  render(`
    <div class="crumb"><a href="#/classes">الصفوف</a> ← ${c ? esc(c.name) : 'صف جديد'}</div>
    <h1>${c ? 'تعديل بيانات الصف' : 'إنشاء صف دراسي'}</h1>
    <p class="sub">اسم الصف مطلوب، وبقية العناوين اختيارية وتظهر في رأس التقارير والكشوف المطبوعة.</p>

    <form id="classForm" class="card">
      <div class="field">
        <label>اسم الصف *</label>
        <input type="text" name="name" required maxlength="120" value="${v('name')}"
               placeholder="مثال: الصف الثالث المتوسط — شعبة أ">
      </div>

      <div class="grid g2">
        <div class="field"><label>المادة</label>
          <input type="text" name="subject" value="${v('subject')}" placeholder="رياضيات"></div>
        <div class="field"><label>المرحلة / الصف</label>
          <input type="text" name="grade" value="${v('grade')}" placeholder="ثالث متوسط"></div>
        <div class="field"><label>الشعبة</label>
          <input type="text" name="section" value="${v('section')}" placeholder="أ"></div>
        <div class="field"><label>العام الدراسي</label>
          <input type="text" name="year" value="${v('year')}" placeholder="1447 / 2026"></div>
        <div class="field"><label>اسم المعلم</label>
          <input type="text" name="teacher" value="${v('teacher')}"></div>
        <div class="field"><label>القاعة / المكان</label>
          <input type="text" name="location" value="${v('location')}" placeholder="قاعة 12"></div>
      </div>

      <div class="field">
        <label>وصف أو ملاحظات عامة</label>
        <textarea name="note" placeholder="أهداف المقرر، توزيع الدرجات، تعليمات عامة...">${v('note')}</textarea>
      </div>

      <div class="actions">
        <button class="btn" type="submit">${c ? 'حفظ التعديلات' : 'إنشاء الصف'}</button>
        <a class="btn ghost" href="${c ? '#/class/' + c.id : '#/'}">إلغاء</a>
        ${c ? '<button class="btn danger" type="button" id="delClass">حذف الصف</button>' : ''}
      </div>
    </form>
  `);

  document.getElementById('classForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    if (!f.name.trim()) return;

    if (c) {
      Object.assign(c, f);
      save();
      toast('تم حفظ التعديلات');
      go('/class/' + c.id);
    } else {
      const nc = Object.assign({ id: uid() }, f,
        { createdAt: new Date().toISOString(), students: [], sessions: [] });
      DB.classes.push(nc);
      save();
      toast('تم إنشاء الصف — أضف الطلاب الآن');
      go('/class/' + nc.id + '/students');
    }
  });

  const del = document.getElementById('delClass');
  if (del) del.addEventListener('click', () => {
    if (!confirm('حذف الصف "' + c.name + '" مع كل طلابه وحصصه نهائياً؟')) return;
    DB.classes = DB.classes.filter(x => x.id !== c.id);
    save();
    toast('تم حذف الصف');
    go('/classes');
  });
}

/* ---------------------- صفحة الصف ---------------------- */

function viewClass(id) {
  const c = findClass(id);
  if (!c) return notFound('الصف');

  const totals = emptyCounts();
  c.sessions.forEach(s => {
    const k = sessionCounts(c, s);
    STATUS_KEYS.forEach(x => totals[x] += k[x]);
  });

  const rows = sortedSessions(c).map(s => {
    const k = sessionCounts(c, s);
    return `<tr>
        <td class="nowrap">${esc(fmtDate(s.date))}</td>
        <td class="num">${esc(s.period)}</td>
        <td><a href="#/class/${c.id}/session/${s.id}">${esc(s.title)}</a>
            ${s.topic ? '<div class="hint">' + esc(s.topic) + '</div>' : ''}</td>
        <td class="nowrap">
          <span class="pill present">${k.present}</span>
          <span class="pill late">${k.late}</span>
          <span class="pill excused">${k.excused}</span>
          <span class="pill absent">${k.absent}</span>
        </td>
        <td class="nowrap no-print">
          <a class="btn ghost sm" href="#/class/${c.id}/session/${s.id}/edit">تعديل</a>
        </td>
      </tr>`;
  }).join('');

  render(`
    ${printHead(c, 'سجل الحصص', c.sessions.length + ' حصة')}
    <div class="crumb no-print"><a href="#/classes">الصفوف</a> ← ${esc(c.name)}</div>
    <div class="page-head">
      <div>
        <h1>${esc(c.name)}</h1>
        <p class="sub">${esc(classHeader(c)) || 'لم تُضف عناوين لهذا الصف بعد'}
          ${c.teacher ? ' — المعلم: ' + esc(c.teacher) : ''}</p>
      </div>
      <div class="actions no-print">
        <a class="btn" href="#/class/${c.id}/session/new">+ تسجيل حصة</a>
        <a class="btn ghost" href="#/class/${c.id}/students">الطلاب (${c.students.length})</a>
        <a class="btn ghost" href="#/class/${c.id}/lessons">توثيق الدروس</a>
        <a class="btn ghost" href="#/class/${c.id}/report">تقرير الحضور</a>
        <a class="btn ghost" href="#/class/${c.id}/absence">تقرير الغياب والتأخر</a>
        <a class="btn ghost" href="#/class/${c.id}/edit">إعدادات الصف</a>
        <button class="btn ghost" id="printClass">طباعة السجل</button>
      </div>
    </div>

    ${c.note ? '<div class="card"><h2>ملاحظات الصف</h2><div>' + esc(c.note).replace(/\n/g, '<br>') + '</div></div>' : ''}

    <div class="grid g4" style="margin-bottom:22px">
      <div class="stat"><b>${c.students.length}</b><span>عدد الطلاب</span></div>
      <div class="stat"><b>${c.sessions.length}</b><span>الحصص الموثّقة</span></div>
      <div class="stat present"><b>${totals.present}</b><span>مجموع الحضور</span></div>
      <div class="stat late"><b>${totals.late}</b><span>مجموع التأخر</span></div>
      <div class="stat excused"><b>${totals.excused}</b><span>غياب بعذر</span></div>
      <div class="stat absent"><b>${totals.absent}</b><span>غياب بدون عذر</span></div>
    </div>

    <h2>سجل الحصص</h2>
    ${c.sessions.length ? `<div class="table-wrap"><table>
        <thead><tr>
          <th>التاريخ</th><th>الحصة</th><th>العنوان والموضوع</th>
          <th>حاضر / متأخر / مأذون / غائب</th><th class="no-print"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
      : `<div class="empty">لا توجد حصص مسجّلة.${c.students.length
            ? ' <a href="#/class/' + c.id + '/session/new">سجّل الحصة الأولى</a>'
            : ' أضف الطلاب أولاً من <a href="#/class/' + c.id + '/students">صفحة الطلاب</a>.'}</div>`}
    ${printSign()}
  `);

  document.getElementById('printClass').addEventListener('click', () => window.print());
}

/* ---------------------- الطلاب ---------------------- */

/** كلمات ترويسة شائعة في ملفات CSV — تُستخدم لتخطّي السطر الأول إن كان عناوين أعمدة. */
const HEADER_WORDS = new Set([
  '#', 'م', 'رقم', 'الرقم', 'رقم الطالب', 'id', 'no', 'number',
  'اسم', 'الاسم', 'الطالب', 'اسم الطالب', 'name', 'student', 'student name',
  'جوال', 'الجوال', 'هاتف', 'الهاتف', 'رقم الجوال', 'phone', 'mobile',
]);

const isHeaderRow = parts =>
  parts.filter(Boolean).length > 0 &&
  parts.filter(Boolean).every(p => HEADER_WORDS.has(p.toLowerCase()));

/** تحليل نص/CSV إلى قائمة طلاب: "رقم,اسم,جوال" أو اسم في كل سطر. */
function parseStudents(text) {
  const out = [];
  let first = true;

  text.replace(/^﻿/, '').split(/\r?\n/).forEach(line => {
    const raw = line.trim();
    if (!raw) return;
    const parts = raw.split(/[,;\t]/).map(s => s.trim().replace(/^"|"$/g, ''));

    // تخطّي صف عناوين الأعمدة إن وُجد في أول سطر
    if (first) {
      first = false;
      if (isHeaderRow(parts)) return;
    }

    let no = '', name = '', phone = '';
    if (parts.length === 1) {
      name = parts[0];
    } else if (/^\d+$/.test(parts[0])) {
      no = parts[0]; name = parts[1] || ''; phone = parts[2] || '';
    } else {
      name = parts[0]; no = parts[1] || ''; phone = parts[2] || '';
    }
    // إزالة الترقيم اليدوي في بداية السطر مثل "1- " أو "٢. "
    const numbered = name.match(/^[\d٠-٩]+\s*[-.)،:]\s*(.+)$/);
    if (numbered) name = numbered[1];

    name = name.replace(/\s+/g, ' ').trim();
    if (name) out.push({ id: uid(), no, name, phone, active: true });
  });
  return out;
}

function viewStudents(id) {
  const c = findClass(id);
  if (!c) return notFound('الصف');

  const rows = c.students.map((s, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td>${esc(s.no || '')}</td>
      <td>${esc(s.name)}</td>
      <td>${esc(s.phone || '')}</td>
      <td class="nowrap no-print">
        <button class="btn ghost sm" data-edit="${s.id}">تعديل</button>
        <button class="btn ghost sm" data-del="${s.id}">حذف</button>
      </td>
    </tr>`).join('');

  render(`
    <div class="crumb"><a href="#/classes">الصفوف</a> ← <a href="#/class/${c.id}">${esc(c.name)}</a> ← الطلاب</div>
    <div class="page-head">
      <div><h1>طلاب الصف</h1><p class="sub">${c.students.length} طالب في ${esc(c.name)}</p></div>
      <div class="actions no-print">
        <button class="btn ghost" id="expStudents">تصدير CSV</button>
        <a class="btn ghost" href="#/class/${c.id}">رجوع للصف</a>
      </div>
    </div>

    <div class="card no-print">
      <h2>رفع قائمة الطلاب</h2>
      <div class="field">
        <label>ارفع ملف CSV أو TXT</label>
        <input type="file" id="fileInput" accept=".csv,.txt,text/csv,text/plain">
        <div class="hint">الصيغ المقبولة: <code>اسم الطالب</code> في كل سطر، أو <code>الرقم,الاسم,الجوال</code>.</div>
      </div>
      <div class="field">
        <label>أو الصق الأسماء هنا (اسم في كل سطر)</label>
        <textarea id="pasteBox" placeholder="١- محمد أحمد&#10;٢- سارة خالد&#10;أو:&#10;1001,محمد أحمد,0500000000"></textarea>
      </div>
      <div class="actions">
        <button class="btn" id="addPaste">إضافة إلى القائمة</button>
        <button class="btn ghost" id="replaceAll">استبدال القائمة بالكامل</button>
        ${c.students.length ? '<button class="btn danger" id="clearAll">حذف كل الطلاب</button>' : ''}
      </div>
      <div class="hint">الاستبدال يحذف الطلاب الحاليين وسجلات حضورهم في الحصص السابقة.</div>
    </div>

    ${c.students.length ? `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>الرقم</th><th>اسم الطالب</th><th>الجوال</th><th class="no-print"></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
      : '<div class="empty">لا يوجد طلاب بعد — ارفع القائمة من الأعلى.</div>'}
  `);

  const readInto = (list, replace) => {
    if (!list.length) { toast('لم يُعثر على أسماء صالحة'); return; }
    if (replace) {
      if (!confirm('سيتم حذف ' + c.students.length + ' طالب وسجلات حضورهم. متابعة؟')) return;
      const keep = new Set(list.map(s => s.id));
      c.students = list;
      c.sessions.forEach(s => {
        Object.keys(s.records).forEach(k => { if (!keep.has(k)) delete s.records[k]; });
      });
    } else {
      c.students = c.students.concat(list);
    }
    save();
    toast('تمت إضافة ' + list.length + ' طالب');
    viewStudents(id);
  };

  document.getElementById('addPaste').addEventListener('click', () =>
    readInto(parseStudents(document.getElementById('pasteBox').value), false));

  document.getElementById('replaceAll').addEventListener('click', () =>
    readInto(parseStudents(document.getElementById('pasteBox').value), true));

  document.getElementById('fileInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      document.getElementById('pasteBox').value = r.result;
      toast('تم تحميل الملف — اضغط "إضافة إلى القائمة"');
    };
    r.readAsText(file, 'UTF-8');
  });

  const clear = document.getElementById('clearAll');
  if (clear) clear.addEventListener('click', () => {
    if (!confirm('حذف كل الطلاب وسجلات حضورهم؟')) return;
    c.students = [];
    c.sessions.forEach(s => s.records = {});
    save();
    viewStudents(id);
  });

  document.getElementById('expStudents').addEventListener('click', () => {
    const lines = [csvRow(['الرقم', 'اسم الطالب', 'الجوال'])]
      .concat(c.students.map(s => csvRow([s.no, s.name, s.phone])));
    download('طلاب-' + c.name + '.csv', lines.join('\r\n'));
  });

  app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    const sid = b.dataset.del;
    const st = c.students.find(x => x.id === sid);
    if (!confirm('حذف الطالب "' + st.name + '" وسجل حضوره؟')) return;
    c.students = c.students.filter(x => x.id !== sid);
    c.sessions.forEach(s => delete s.records[sid]);
    save();
    viewStudents(id);
  }));

  app.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const st = c.students.find(x => x.id === b.dataset.edit);
    const name = prompt('اسم الطالب:', st.name);
    if (name === null) return;
    const no = prompt('رقم الطالب (اختياري):', st.no || '');
    if (no === null) return;
    st.name = name.trim() || st.name;
    st.no = no.trim();
    save();
    viewStudents(id);
  }));
}

/* ---------------------- تسجيل / تعديل حصة ---------------------- */

function viewSessionForm(classId, sessionId) {
  const c = findClass(classId);
  if (!c) return notFound('الصف');
  const s = sessionId ? findSession(c, sessionId) : null;
  if (sessionId && !s) return notFound('الحصة');

  if (!c.students.length) {
    return render(`<div class="empty">أضف طلاب الصف أولاً.<br><br>
      <a class="btn" href="#/class/${c.id}/students">رفع قائمة الطلاب</a></div>`);
  }

  // التاريخ يبدأ من تاريخ النظام ويمكن تغييره يدوياً (لتوثيق حصة سابقة مثلاً)
  const date = s ? s.date : todayISO();
  const time = s ? s.time : nowTime();
  const nextPeriod = s ? s.period
    : (c.sessions.filter(x => x.date === date).length + 1);

  const rows = c.students.map((st, i) => {
    const r = (s && s.records[st.id]) || { status: 'present', late: 0, note: '' };
    const seg = STATUS_KEYS.map(k => `
        <input type="radio" id="r_${st.id}_${k}" name="st_${st.id}" value="${k}"
               ${r.status === k ? 'checked' : ''}>
        <label class="${k}" for="r_${st.id}_${k}">${STATUS[k].label}</label>`).join('');
    return `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(st.name)}${st.no ? '<div class="hint">' + esc(st.no) + '</div>' : ''}</td>
        <td><div class="seg">${seg}</div></td>
        <td style="width:110px"><input type="number" min="0" max="180" name="late_${st.id}"
              value="${Number(r.late) || 0}" placeholder="0"></td>
        <td style="min-width:170px"><input type="text" name="note_${st.id}"
              value="${esc(r.note || '')}" placeholder="ملاحظة"></td>
      </tr>`;
  }).join('');

  render(`
    <div class="crumb"><a href="#/classes">الصفوف</a> ← <a href="#/class/${c.id}">${esc(c.name)}</a>
      ← ${s ? 'تعديل حصة' : 'حصة جديدة'}</div>
    <h1>${s ? 'تعديل الحصة' : 'تسجيل حصة جديدة'}</h1>
    <p class="sub">${esc(classHeader(c))}</p>

    <form id="sessionForm">
      <div class="card">
        <h2>توثيق الحصة</h2>
        <div class="grid g3">
          <div class="field">
            <label>تاريخ الحصة *</label>
            <input type="date" name="date" id="dateInput" value="${esc(date)}" required>
            <div class="hint">
              <b id="dateDay">${esc(weekdayAr(date))}</b>
              — ${s ? 'يمكنك اختيار أي تاريخ آخر' : 'يبدأ بتاريخ اليوم، ويمكنك تغييره لأي تاريخ آخر (لتوثيق حصة سابقة مثلاً)'}
              <button type="button" class="linkbtn" id="todayBtn">اليوم</button>
            </div>
          </div>
          <div class="field">
            <label>وقت التسجيل (من النظام)</label>
            <input type="text" value="${esc(time)}" readonly>
            <input type="hidden" name="time" value="${esc(time)}">
          </div>
          <div class="field">
            <label>رقم الحصة</label>
            <input type="number" name="period" id="periodInput" min="1" max="12" value="${nextPeriod}" required>
          </div>
        </div>

        <div class="field">
          <label>عنوان الحصة *</label>
          <input type="text" name="title" required maxlength="200"
                 value="${s ? esc(s.title) : ''}" placeholder="مثال: الدرس الرابع — المعادلات الخطية">
        </div>
        <div class="field">
          <label>الموضوع / الهدف</label>
          <input type="text" name="topic" maxlength="255"
                 value="${s ? esc(s.topic || '') : ''}" placeholder="حل المعادلة من الدرجة الأولى بمجهول واحد">
        </div>
        <div class="grid g2">
          <div class="field">
            <label>ما تم إنجازه وملاحظات الحصة</label>
            <textarea name="notes" placeholder="الأنشطة، وسائل الشرح، مستوى التفاعل...">${s ? esc(s.notes || '') : ''}</textarea>
          </div>
          <div class="field">
            <label>الواجب المنزلي</label>
            <textarea name="homework" placeholder="تمارين صفحة 45، الأسئلة 1-6">${s ? esc(s.homework || '') : ''}</textarea>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="page-head" style="margin-bottom:12px">
          <h2 style="margin:0">تحضير الطلاب (${c.students.length})</h2>
          <div class="actions no-print">
            ${STATUS_KEYS.map(k => '<button type="button" class="btn ghost sm" data-all="' + k + '">الكل ' + STATUS[k].label + '</button>').join('')}
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>اسم الطالب</th><th>الحالة</th>
            <th>دقائق التأخر</th><th>ملاحظة</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>

      <div class="sticky-save actions">
        <button class="btn" type="submit">${s ? 'حفظ التعديلات' : 'حفظ الحصة'}</button>
        <a class="btn ghost" href="#/class/${c.id}">إلغاء</a>
        ${s ? '<button class="btn danger" type="button" id="delSession">حذف الحصة</button>' : ''}
      </div>
    </form>
  `);

  app.querySelectorAll('[data-all]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.all;
    c.students.forEach(st => {
      const el = document.getElementById('r_' + st.id + '_' + k);
      if (el) el.checked = true;
    });
  }));

  // متابعة التاريخ المختار: تحديث اسم اليوم، واقتراح رقم الحصة التالي في ذلك اليوم
  const dateInput = document.getElementById('dateInput');
  const dayLabel = document.getElementById('dateDay');
  const periodInput = document.getElementById('periodInput');
  let periodTouched = !!s;

  periodInput.addEventListener('input', () => { periodTouched = true; });

  function onDateChange() {
    const v = dateInput.value;
    dayLabel.textContent = v ? weekdayAr(v) : '—';
    if (!periodTouched && v) {
      periodInput.value =
        c.sessions.filter(x => x.date === v && (!s || x.id !== s.id)).length + 1;
    }
  }

  dateInput.addEventListener('change', onDateChange);
  dateInput.addEventListener('input', onDateChange);

  document.getElementById('todayBtn').addEventListener('click', () => {
    dateInput.value = todayISO();
    onDateChange();
  });

  document.getElementById('sessionForm').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const period = Number(fd.get('period')) || 1;
    const sDate = (fd.get('date') || '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(sDate) || isNaN(new Date(sDate).getTime())) {
      alert('اختر تاريخاً صحيحاً للحصة.');
      dateInput.focus();
      return;
    }
    if (sDate > todayISO() &&
        !confirm('التاريخ المختار (' + fmtDate(sDate) + ') في المستقبل. المتابعة؟')) {
      return;
    }

    const clash = c.sessions.find(x =>
      x.date === sDate && Number(x.period) === period && (!s || x.id !== s.id));
    if (clash && !confirm('توجد حصة أخرى بنفس التاريخ ورقم الحصة. المتابعة على أي حال؟')) return;

    const records = {};
    c.students.forEach(st => {
      const status = fd.get('st_' + st.id) || 'present';
      records[st.id] = {
        status,
        late: status === 'late' ? (Number(fd.get('late_' + st.id)) || 0) : 0,
        note: (fd.get('note_' + st.id) || '').trim(),
      };
    });

    const data = {
      date: sDate,
      time: fd.get('time'),
      period,
      title: (fd.get('title') || '').trim(),
      topic: (fd.get('topic') || '').trim(),
      notes: (fd.get('notes') || '').trim(),
      homework: (fd.get('homework') || '').trim(),
      records,
    };

    if (s) {
      Object.assign(s, data, { updatedAt: new Date().toISOString() });
      save();
      toast('تم حفظ التعديلات');
      go('/class/' + c.id + '/session/' + s.id);
    } else {
      const ns = Object.assign({ id: uid() }, data, { createdAt: new Date().toISOString() });
      c.sessions.push(ns);
      save();
      toast('تم حفظ الحصة');
      go('/class/' + c.id + '/session/' + ns.id);
    }
  });

  const del = document.getElementById('delSession');
  if (del) del.addEventListener('click', () => {
    if (!confirm('حذف هذه الحصة وسجل حضورها نهائياً؟')) return;
    c.sessions = c.sessions.filter(x => x.id !== s.id);
    save();
    toast('تم حذف الحصة');
    go('/class/' + c.id);
  });
}

/* ---------------------- عرض حصة ---------------------- */

function viewSession(classId, sessionId) {
  const c = findClass(classId);
  if (!c) return notFound('الصف');
  const s = findSession(c, sessionId);
  if (!s) return notFound('الحصة');

  const k = sessionCounts(c, s);

  const rows = c.students.map((st, i) => {
    const r = s.records[st.id] || { status: 'absent', late: 0, note: '' };
    return `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(st.no || '')}</td>
        <td>${esc(st.name)}</td>
        <td><span class="pill ${r.status}">${STATUS[r.status].label}</span></td>
        <td>${r.late ? esc(r.late) + ' د' : '—'}</td>
        <td>${esc(r.note || '')}</td>
      </tr>`;
  }).join('');

  const block = (title, body) => body
    ? '<div class="field"><label>' + title + '</label><div>' + esc(body).replace(/\n/g, '<br>') + '</div></div>'
    : '';

  render(`
    ${printHead(c, 'كشف حصة — ' + s.title, fmtDate(s.date) + ' · الحصة ' + s.period)}
    <div class="crumb no-print"><a href="#/classes">الصفوف</a> ← <a href="#/class/${c.id}">${esc(c.name)}</a> ← الحصة</div>
    <div class="page-head">
      <div>
        <h1>${esc(s.title)}</h1>
        <p class="sub">${esc(c.name)} · ${esc(classHeader(c))}</p>
      </div>
      <div class="actions no-print">
        <a class="btn" href="#/class/${c.id}/session/${s.id}/edit">تعديل</a>
        <button class="btn ghost" id="printBtn">طباعة الكشف</button>
        <button class="btn ghost" id="expSession">تصدير CSV</button>
      </div>
    </div>

    <div class="card">
      <div class="grid g3">
        <div><label>التاريخ</label><div>${esc(fmtDate(s.date))}</div></div>
        <div><label>رقم الحصة</label><div>${esc(s.period)}</div></div>
        <div><label>وقت التسجيل</label><div>${esc(s.time)}</div></div>
      </div>
      ${s.topic ? '<div style="margin-top:14px"><label>الموضوع</label><div>' + esc(s.topic) + '</div></div>' : ''}
      <div class="grid g2" style="margin-top:14px">
        ${block('ما تم إنجازه', s.notes)}
        ${block('الواجب المنزلي', s.homework)}
      </div>
    </div>

    <div class="grid g4" style="margin-bottom:22px">
      <div class="stat present"><b>${k.present}</b><span>حاضر</span></div>
      <div class="stat late"><b>${k.late}</b><span>متأخر</span></div>
      <div class="stat excused"><b>${k.excused}</b><span>مأذون</span></div>
      <div class="stat absent"><b>${k.absent}</b><span>غائب</span></div>
    </div>

    <h2>كشف الحضور</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>الرقم</th><th>اسم الطالب</th><th>الحالة</th>
        <th>التأخر</th><th>ملاحظة</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${printSign()}
  `);

  document.getElementById('printBtn').addEventListener('click', () => window.print());

  document.getElementById('expSession').addEventListener('click', () => {
    const lines = [
      csvRow([c.name, classHeader(c)]),
      csvRow(['الحصة', s.title, 'التاريخ', fmtDate(s.date), 'رقم الحصة', s.period]),
      csvRow(['الموضوع', s.topic, 'الواجب', s.homework]),
      '',
      csvRow(['#', 'الرقم', 'اسم الطالب', 'الحالة', 'دقائق التأخر', 'ملاحظة']),
    ];
    c.students.forEach((st, i) => {
      const r = s.records[st.id] || { status: 'absent', late: 0, note: '' };
      lines.push(csvRow([i + 1, st.no, st.name, STATUS[r.status].label, r.late, r.note]));
    });
    download('حصة-' + s.date + '-' + c.name + '.csv', lines.join('\r\n'));
  });
}

/* ---------------------- التقرير ---------------------- */

function viewReport(classId) {
  const c = findClass(classId);
  if (!c) return notFound('الصف');

  if (!c.sessions.length) {
    return render(`<div class="empty">لا توجد حصص مسجّلة لبناء تقرير.<br><br>
      <a class="btn" href="#/class/${c.id}/session/new">تسجيل حصة</a></div>`);
  }

  const rows = c.students.map((st, i) => {
    const s = studentStats(c, st.id);
    const barCls = s.rate >= 85 ? '' : (s.rate >= 70 ? 'warn' : 'bad');
    return `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(st.no || '')}</td>
        <td>${esc(st.name)}</td>
        <td>${s.present}</td>
        <td>${s.late}${s.minutesLate ? ' <span class="hint">(' + s.minutesLate + ' د)</span>' : ''}</td>
        <td>${s.excused}</td>
        <td>${s.absent}</td>
        <td class="nowrap">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="bar ${barCls}"><i style="width:${s.rate}%"></i></div>
            <span>${s.rate}%</span>
          </div>
        </td>
      </tr>`;
  }).join('');

  render(`
    ${printHead(c, 'تقرير الحضور', c.sessions.length + ' حصة')}
    <div class="crumb no-print"><a href="#/classes">الصفوف</a> ← <a href="#/class/${c.id}">${esc(c.name)}</a> ← التقرير</div>
    <div class="page-head">
      <div>
        <h1>تقرير الحضور</h1>
        <p class="sub">${esc(c.name)} · ${esc(classHeader(c))} · ${c.sessions.length} حصة ·
          صدر بتاريخ ${esc(fmtDate(todayISO()))}</p>
      </div>
      <div class="actions no-print">
        <button class="btn ghost" id="printBtn">طباعة</button>
        <button class="btn ghost" id="xlsReport">تحميل Excel</button>
        <button class="btn ghost" id="expReport">تصدير CSV</button>
        <a class="btn ghost" href="#/class/${c.id}/absence">تقرير الغياب والتأخر</a>
        <a class="btn ghost" href="#/class/${c.id}/lessons">توثيق الدروس</a>
        <a class="btn ghost" href="#/class/${c.id}">رجوع</a>
      </div>
    </div>

    <div class="table-wrap"><table>
      <thead><tr>
        <th>#</th><th>الرقم</th><th>اسم الطالب</th>
        <th>حاضر</th><th>متأخر</th><th>مأذون</th><th>غائب</th><th>نسبة الحضور</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hint">نسبة الحضور = (حاضر + متأخر) ÷ عدد الحصص المسجّلة للطالب.</p>
    ${printSign()}
  `);

  document.getElementById('printBtn').addEventListener('click', () => window.print());

  document.getElementById('expReport').addEventListener('click', () => {
    const lines = [
      csvRow([c.name, classHeader(c)]),
      csvRow(['عدد الحصص', c.sessions.length, 'تاريخ التقرير', fmtDate(todayISO())]),
      '',
      csvRow(['#', 'الرقم', 'اسم الطالب', 'حاضر', 'متأخر', 'دقائق التأخر', 'مأذون', 'غائب', 'نسبة الحضور %']),
    ];
    c.students.forEach((st, i) => {
      const s = studentStats(c, st.id);
      lines.push(csvRow([i + 1, st.no, st.name, s.present, s.late, s.minutesLate, s.excused, s.absent, s.rate]));
    });
    download('تقرير-' + c.name + '-' + todayISO() + '.csv', lines.join('\r\n'));
  });

  document.getElementById('xlsReport').addEventListener('click', () => {
    const head = ['#', 'الرقم', 'اسم الطالب', 'حاضر', 'متأخر', 'دقائق التأخر',
                  'مأذون', 'غائب', 'نسبة الحضور'];
    const rows = [
      [{ v: 'تقرير الحضور', s: 'title' }],
      [{
        v: [c.name, classHeader(c), c.teacher ? 'المعلم: ' + c.teacher : '',
            c.sessions.length + ' حصة', 'صدر بتاريخ ' + fmtDate(todayISO())]
          .filter(Boolean).join('  ·  '),
        s: 'meta',
      }],
      [],
      head.map(h => ({ v: h, s: 'head' })),
    ];
    c.students.forEach((st, i) => {
      const s = studentStats(c, st.id);
      rows.push([
        { v: i + 1, s: 'num' },
        { v: st.no || '', s: 'num' },
        { v: st.name, s: 'text' },
        { v: s.present, s: 'num' },
        { v: s.late, s: 'num' },
        { v: s.minutesLate, s: 'num' },
        { v: s.excused, s: 'num' },
        { v: s.absent, s: s.absent ? 'bad' : 'num' },
        { v: s.rate, s: 'pct' },
      ]);
    });
    saveXlsx('تقرير-' + c.name + '-' + todayISO() + '.xlsx', {
      name: 'تقرير الحضور',
      cols: [5, 9, 26, 10, 10, 12, 10, 10, 12],
      rows,
      freeze: 4,
      filter: 'A4:I' + (4 + c.students.length),
      merges: ['A1:I1', 'A2:I2'],
    });
    toast('تم تنزيل ملف Excel');
  });
}

/* ---------------------- تقرير الغياب والتأخر ---------------------- */

/** عوامل التصفية — تبقى بين عمليات إعادة الرسم داخل الصف الواحد. */
const ABSENCE_VIEW = {
  classId: '', mode: 'all', month: '', from: '', to: '',
  sort: 'list', only: false, dates: false,
};

function viewAbsence(classId) {
  const c = findClass(classId);
  if (!c) return notFound('الصف');

  if (!c.sessions.length) {
    return render(`<div class="empty">لا توجد حصص مسجّلة لبناء تقرير الغياب.<br><br>
      <a class="btn" href="#/class/${c.id}/session/new">تسجيل حصة</a></div>`);
  }

  const v = ABSENCE_VIEW;
  const months = monthsOf(c);

  // تبديل الصف يعيد التصفية إلى وضعها الافتراضي
  if (v.classId !== c.id) {
    v.classId = c.id;
    v.mode = 'all';
    v.from = '';
    v.to = '';
  }
  // الشهر المختار قد يختفي بعد حذف حصص — أعِده إلى آخر شهر فيه حصص
  if (months.indexOf(v.month) === -1) v.month = months[months.length - 1] || '';

  const span = periodSpan(v);
  const list = chronoSessions(c).filter(s =>
    (!span.from || s.date >= span.from) && (!span.to || s.date <= span.to));

  const stats = c.students.map((st, i) => ({ st, no: i + 1, k: studentStats(c, st.id, list) }));

  const tot = { absent: 0, excused: 0, late: 0, minutes: 0, clean: 0 };
  stats.forEach(x => {
    tot.absent  += x.k.absent;
    tot.excused += x.k.excused;
    tot.late    += x.k.late;
    tot.minutes += x.k.minutesLate;
    if (!x.k.absent && !x.k.excused && !x.k.late) tot.clean++;
  });

  const shown = v.only ? stats.filter(x => x.k.absent || x.k.excused || x.k.late) : stats.slice();
  if (v.sort === 'most') {
    shown.sort((a, b) =>
      (b.k.absent - a.k.absent) || (b.k.excused - a.k.excused) ||
      (b.k.late - a.k.late) || (a.no - b.no));
  }

  /** سطر التواريخ تحت الطالب — يظهر في الطباعة أيضاً عند تفعيل «إظهار التواريخ». */
  const datesOf = k => [
    k.dates.absent.length  ? 'غياب: ' + k.dates.absent.join('، ') : '',
    k.dates.excused.length ? 'بعذر: ' + k.dates.excused.join('، ') : '',
    k.dates.late.length    ? 'تأخر: ' + k.dates.late.join('، ') : '',
  ].filter(Boolean).join('  —  ');

  const rows = shown.map(x => {
    const k = x.k;
    const barCls = k.absentRate <= 10 ? '' : (k.absentRate <= 25 ? 'warn' : 'bad');
    const detail = v.dates ? datesOf(k) : '';
    return `<tr>
        <td class="num">${x.no}</td>
        <td>${esc(x.st.no || '')}</td>
        <td>${esc(x.st.name)}</td>
        <td>${k.total}</td>
        <td${k.absent ? ' class="danger-num"' : ''}>${k.absent}</td>
        <td>${k.excused}</td>
        <td><b>${k.missed}</b></td>
        <td>${k.late}</td>
        <td>${k.minutesLate || '—'}</td>
        <td class="nowrap">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="bar ${barCls}"><i style="width:${k.absentRate}%"></i></div>
            <span>${k.absentRate}%</span>
          </div>
        </td>
      </tr>` + (detail
        ? `<tr class="datesrow"><td></td><td colspan="9">${esc(detail)}</td></tr>`
        : '');
  }).join('');

  const seg = (attr, val, cur, label) =>
    `<button class="btn ghost sm${cur === val ? ' on' : ''}" data-${attr}="${val}">${label}</button>`;

  const monthOpts = months.map(m =>
    `<option value="${esc(m)}"${m === v.month ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('');

  render(`
    ${printHead(c, 'تقرير الغياب والتأخر', span.label + ' · ' + list.length + ' حصة')}
    <div class="crumb no-print"><a href="#/classes">الصفوف</a> ←
      <a href="#/class/${c.id}">${esc(c.name)}</a> ← تقرير الغياب والتأخر</div>

    <div class="page-head">
      <div>
        <h1>تقرير الغياب والتأخر</h1>
        <p class="sub">${esc(c.name)} · ${esc(classHeader(c))} · ${esc(span.label)} ·
          ${list.length} حصة · صدر بتاريخ ${esc(fmtDate(todayISO()))}</p>
      </div>
      <div class="actions no-print">
        <button class="btn" id="printBtn">طباعة</button>
        <button class="btn ghost" id="xlsAbsence">تحميل Excel</button>
        <button class="btn ghost" id="expAbsence">تصدير CSV</button>
        <a class="btn ghost" href="#/class/${c.id}/report">تقرير الحضور</a>
        <a class="btn ghost" href="#/class/${c.id}">رجوع</a>
      </div>
    </div>

    <div class="card no-print">
      <div class="filters">
        <div class="f"><label>الفترة</label>
          <div class="actions">
            ${seg('pmode', 'all', v.mode, 'كل الفترة')}
            ${seg('pmode', 'month', v.mode, 'حسب الشهر')}
            ${seg('pmode', 'range', v.mode, 'بين تاريخين')}
          </div></div>

        ${v.mode === 'month'
          ? `<div class="f"><label for="fMonth">الشهر</label>
               <select id="fMonth">${monthOpts}</select></div>`
          : ''}

        ${v.mode === 'range'
          ? `<div class="f"><label for="fFrom">من تاريخ</label>
               <input type="date" id="fFrom" value="${esc(v.from)}"></div>
             <div class="f"><label for="fTo">إلى تاريخ</label>
               <input type="date" id="fTo" value="${esc(v.to)}"></div>`
          : ''}

        <div class="f"><label>الترتيب</label>
          <div class="actions">
            ${seg('sort', 'list', v.sort, 'ترتيب القائمة')}
            ${seg('sort', 'most', v.sort, 'الأكثر غياباً')}
          </div></div>

        <div class="f"><label>خيارات</label>
          <div class="actions">
            <button class="btn ghost sm${v.only ? ' on' : ''}" id="fOnly">من لديه غياب أو تأخر فقط</button>
            <button class="btn ghost sm${v.dates ? ' on' : ''}" id="fDates">إظهار التواريخ</button>
          </div></div>
      </div>
      <p class="hint">التصفية تنطبق على ما يُطبع ويُصدَّر أيضاً —
        ${list.length} من ${c.sessions.length} حصة، و${shown.length} من ${c.students.length} طالباً.</p>
    </div>

    <div class="grid g4" style="margin-bottom:22px">
      <div class="stat"><b>${list.length}</b><span>حصص في الفترة</span></div>
      <div class="stat absent"><b>${tot.absent}</b><span>غياب بدون عذر</span></div>
      <div class="stat excused"><b>${tot.excused}</b><span>غياب بعذر</span></div>
      <div class="stat late"><b>${tot.late}</b><span>مرات التأخر</span></div>
      <div class="stat late"><b>${tot.minutes}</b><span>دقائق التأخر</span></div>
      <div class="stat present"><b>${tot.clean}</b><span>طلاب بلا غياب ولا تأخر</span></div>
    </div>

    ${!list.length
      ? '<div class="empty">لا توجد حصص داخل الفترة المختارة.</div>'
      : (!shown.length
        ? '<div class="empty">لا يوجد طالب عليه غياب أو تأخر في هذه الفترة.</div>'
        : `<div class="table-wrap"><table>
            <thead><tr>
              <th>#</th><th>الرقم</th><th>اسم الطالب</th><th>حصص مسجّلة</th>
              <th>غياب بدون عذر</th><th>غياب بعذر</th><th>إجمالي الغياب</th>
              <th>مرات التأخر</th><th>دقائق التأخر</th><th>نسبة الغياب</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`)}

    <p class="hint">نسبة الغياب = (غياب بدون عذر + غياب بعذر) ÷ عدد الحصص المسجّلة للطالب في الفترة.</p>
    ${printSign()}
  `);

  const refresh = () => viewAbsence(c.id);

  app.querySelectorAll('[data-pmode]').forEach(b => b.addEventListener('click', () => {
    v.mode = b.dataset.pmode;
    refresh();
  }));
  app.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
    v.sort = b.dataset.sort;
    refresh();
  }));

  const mSel = document.getElementById('fMonth');
  if (mSel) mSel.addEventListener('change', e => { v.month = e.target.value; refresh(); });

  const fFrom = document.getElementById('fFrom');
  if (fFrom) fFrom.addEventListener('change', e => { v.from = e.target.value; refresh(); });

  const fTo = document.getElementById('fTo');
  if (fTo) fTo.addEventListener('change', e => { v.to = e.target.value; refresh(); });

  document.getElementById('fOnly').addEventListener('click', () => { v.only = !v.only; refresh(); });
  document.getElementById('fDates').addEventListener('click', () => { v.dates = !v.dates; refresh(); });

  document.getElementById('printBtn').addEventListener('click', () => window.print());

  document.getElementById('expAbsence').addEventListener('click', () => {
    const lines = [
      csvRow([c.name, classHeader(c), c.teacher || '']),
      csvRow(['تقرير الغياب والتأخر', span.label, 'عدد الحصص', list.length,
              'تاريخ التصدير', fmtDate(todayISO())]),
      '',
      csvRow(['#', 'الرقم', 'اسم الطالب', 'حصص مسجّلة', 'غياب بدون عذر', 'غياب بعذر',
              'إجمالي الغياب', 'مرات التأخر', 'دقائق التأخر', 'نسبة الغياب %',
              'تواريخ الغياب', 'تواريخ الغياب بعذر', 'تواريخ التأخر']),
    ];
    shown.forEach(x => {
      const k = x.k;
      lines.push(csvRow([x.no, x.st.no, x.st.name, k.total, k.absent, k.excused, k.missed,
        k.late, k.minutesLate, k.absentRate,
        k.dates.absent.join('، '), k.dates.excused.join('، '), k.dates.late.join('، ')]));
    });
    lines.push('');
    lines.push(csvRow(['المجموع', '', '', '', tot.absent, tot.excused,
                       tot.absent + tot.excused, tot.late, tot.minutes]));
    download('غياب-وتأخر-' + c.name + '-' +
      (v.mode === 'month' && v.month ? v.month : todayISO()) + '.csv', lines.join('\r\n'));
  });

  /** سطر البيانات الذي يتصدّر كل ورقة Excel. */
  const xlsMeta = [
    c.name, classHeader(c), c.teacher ? 'المعلم: ' + c.teacher : '',
    span.label, list.length + ' حصة', 'صدر بتاريخ ' + fmtDate(todayISO()),
  ].filter(Boolean).join('  ·  ');

  /** ورقة «ملخّص الغياب»: سطر لكل طالب — نفس جدول الشاشة. */
  const xlsSummary = () => {
    const head = ['#', 'الرقم', 'اسم الطالب', 'حصص مسجّلة', 'غياب بدون عذر', 'غياب بعذر',
                  'إجمالي الغياب', 'مرات التأخر', 'دقائق التأخر', 'نسبة الغياب'];
    const rows = [
      [{ v: 'تقرير الغياب والتأخر', s: 'title' }],
      [{ v: xlsMeta, s: 'meta' }],
      [],
      head.map(h => ({ v: h, s: 'head' })),
    ];
    shown.forEach(x => {
      const k = x.k;
      rows.push([
        { v: x.no, s: 'num' },
        { v: x.st.no || '', s: 'num' },
        { v: x.st.name, s: 'text' },
        { v: k.total, s: 'num' },
        { v: k.absent, s: k.absent ? 'bad' : 'num' },
        { v: k.excused, s: 'num' },
        { v: k.missed, s: 'num' },
        { v: k.late, s: 'num' },
        { v: k.minutesLate, s: 'num' },
        { v: k.absentRate, s: 'pct' },
      ]);
    });
    rows.push([
      { v: 'المجموع', s: 'total' }, { v: '', s: 'total' }, { v: '', s: 'total' },
      { v: '', s: 'total' }, { v: tot.absent, s: 'total' }, { v: tot.excused, s: 'total' },
      { v: tot.absent + tot.excused, s: 'total' }, { v: tot.late, s: 'total' },
      { v: tot.minutes, s: 'total' }, { v: '', s: 'total' },
    ]);
    return {
      name: 'ملخص الغياب',
      cols: [5, 9, 26, 11, 12, 11, 11, 10, 11, 11],
      rows,
      freeze: 4,
      filter: 'A4:J' + (4 + shown.length),
      merges: ['A1:J1', 'A2:J2'],
    };
  };

  /** ورقة «تفاصيل الغياب»: سطر لكل واقعة غياب أو تأخر — تصلح لجداول Excel المحورية. */
  const xlsDetail = () => {
    const head = ['التاريخ', 'اليوم', 'الحصة', 'عنوان الدرس', 'اسم الطالب',
                  'الحالة', 'دقائق التأخر', 'ملاحظة'];
    const rows = [
      [{ v: 'تفاصيل الغياب والتأخر', s: 'title' }],
      [{ v: xlsMeta, s: 'meta' }],
      [],
      head.map(h => ({ v: h, s: 'head' })),
    ];
    const ids = {};
    shown.forEach(x => { ids[x.st.id] = true; });
    list.forEach(s => {
      c.students.forEach(st => {
        const r = ids[st.id] ? s.records[st.id] : null;
        if (!r || r.status === 'present') return;
        rows.push([
          { v: s.date, s: 'num' },
          { v: weekdayAr(s.date), s: 'num' },
          { v: Number(s.period) || s.period, s: 'num' },
          { v: s.title, s: 'text' },
          { v: st.name, s: 'text' },
          { v: (STATUS[r.status] || {}).label || r.status, s: r.status === 'absent' ? 'bad' : 'num' },
          { v: Number(r.late || 0), s: 'num' },
          { v: r.note || '', s: 'text' },
        ]);
      });
    });
    if (rows.length === 4) rows.push([{ v: 'لا غياب ولا تأخر في هذه الفترة.', s: 'text' }]);
    return {
      name: 'تفاصيل الغياب',
      cols: [13, 11, 8, 24, 26, 11, 11, 30],
      rows,
      freeze: 4,
      filter: 'A4:H' + Math.max(rows.length, 4),
      merges: ['A1:H1', 'A2:H2'],
    };
  };

  document.getElementById('xlsAbsence').addEventListener('click', () => {
    saveXlsx('غياب-وتأخر-' + c.name + '-' +
      (v.mode === 'month' && v.month ? v.month : todayISO()) + '.xlsx',
      [xlsSummary(), xlsDetail()]);
    toast('تم تنزيل ملف Excel');
  });
}

/* ---------------------- تقرير توثيق الدروس ---------------------- */

/** عوامل التصفية — تبقى بين عمليات إعادة الرسم داخل الصف الواحد. */
const LESSONS_VIEW = { classId: '', from: '', to: '', mode: 'table' };

function viewLessons(classId) {
  const c = findClass(classId);
  if (!c) return notFound('الصف');

  if (!c.sessions.length) {
    return render(`<div class="empty">لا توجد حصص موثّقة لبناء التقرير.<br><br>
      <a class="btn" href="#/class/${c.id}/session/new">تسجيل حصة</a></div>`);
  }

  // تبديل الصف يعيد التصفية إلى وضعها الافتراضي
  if (LESSONS_VIEW.classId !== c.id) {
    LESSONS_VIEW.classId = c.id;
    LESSONS_VIEW.from = '';
    LESSONS_VIEW.to = '';
  }

  const from = LESSONS_VIEW.from;
  const to   = LESSONS_VIEW.to;
  const mode = LESSONS_VIEW.mode;

  const list = chronoSessions(c).filter(s =>
    (!from || s.date >= from) && (!to || s.date <= to));

  const totals = emptyCounts();
  let documented = 0, withHomework = 0;
  list.forEach(s => {
    const k = sessionCounts(c, s);
    STATUS_KEYS.forEach(x => totals[x] += k[x]);
    if (isDocumented(s)) documented++;
    if ((s.homework || '').trim()) withHomework++;
  });

  const range = list.length
    ? 'من ' + list[0].date + ' إلى ' + list[list.length - 1].date
    : 'لا حصص في المدى المختار';

  const pills = k => `<span class="pill present">${k.present}</span>
      <span class="pill late">${k.late}</span>
      <span class="pill excused">${k.excused}</span>
      <span class="pill absent">${k.absent}</span>`;

  const rows = list.map((s, i) => {
    const k = sessionCounts(c, s);
    return `<tr>
        <td class="num">${i + 1}</td>
        <td class="nowrap">${esc(weekdayAr(s.date))}<div class="hint">${esc(s.date)}</div></td>
        <td class="num">${esc(s.period)}</td>
        <td><b>${esc(s.title)}</b>${s.topic ? '<div class="hint">' + nl2br(s.topic) + '</div>' : ''}</td>
        <td class="cellwrap">${s.notes ? nl2br(s.notes) : '<span class="hint">لم يُوثّق</span>'}</td>
        <td class="cellwrap">${s.homework ? nl2br(s.homework) : '—'}</td>
        <td class="nowrap">${pills(k)}</td>
      </tr>`;
  }).join('');

  const field = (title, body) =>
    `<div class="field"><label>${title}</label><div>${body ? nl2br(body) : '<span class="hint">—</span>'}</div></div>`;

  const cards = list.map((s, i) => {
    const k = sessionCounts(c, s);
    const n = namesByStatus(c, s);
    const missing = [
      n.absent.length  ? 'الغائبون: ' + n.absent.join('، ') : '',
      n.excused.length ? 'المأذون لهم: ' + n.excused.join('، ') : '',
      n.late.length    ? 'المتأخرون: ' + n.late.join('، ') : '',
    ].filter(Boolean);
    return `<div class="card lesson">
        <div class="lesson-head">
          <h3>${i + 1}. ${esc(s.title)}</h3>
          <span class="tag">${esc(fmtDate(s.date))} · الحصة ${esc(s.period)}</span>
        </div>
        ${field('الموضوع / الهدف', s.topic)}
        <div class="grid g2">
          ${field('ما تم إنجازه', s.notes)}
          ${field('الواجب المنزلي', s.homework)}
        </div>
        <div class="lesson-att">
          <label>الحضور</label>
          ${pills(k)}
          <div class="names">${missing.length ? esc(missing.join(' — ')) : 'حضور كامل.'}</div>
        </div>
      </div>`;
  }).join('');

  const seg = (val, label) =>
    `<button class="btn ghost sm${mode === val ? ' on' : ''}" data-mode="${val}">${label}</button>`;

  render(`
    ${printHead(c, 'توثيق الدروس', range)}
    <div class="crumb no-print"><a href="#/classes">الصفوف</a> ←
      <a href="#/class/${c.id}">${esc(c.name)}</a> ← توثيق الدروس</div>

    <div class="page-head">
      <div>
        <h1>توثيق الدروس</h1>
        <p class="sub">${esc(c.name)} · ${esc(classHeader(c))} · ${esc(range)} ·
          صدر بتاريخ ${esc(fmtDate(todayISO()))}</p>
      </div>
      <div class="actions no-print">
        <button class="btn ghost" id="printBtn">طباعة</button>
        <button class="btn ghost" id="expLessons">تصدير CSV</button>
        <a class="btn ghost" href="#/class/${c.id}/report">تقرير الحضور</a>
        <a class="btn ghost" href="#/class/${c.id}/absence">تقرير الغياب والتأخر</a>
        <a class="btn ghost" href="#/class/${c.id}">رجوع</a>
      </div>
    </div>

    <div class="card no-print">
      <div class="filters">
        <div class="f"><label for="fFrom">من تاريخ</label>
          <input type="date" id="fFrom" value="${esc(from)}"></div>
        <div class="f"><label for="fTo">إلى تاريخ</label>
          <input type="date" id="fTo" value="${esc(to)}"></div>
        <div class="f"><label>طريقة العرض</label>
          <div class="actions">${seg('table', 'جدول مختصر')}${seg('cards', 'بطاقات تفصيلية')}</div></div>
        <div class="f"><button class="btn ghost" id="fClear">كل الحصص</button></div>
      </div>
      <p class="hint">التصفية تنطبق على ما يُطبع ويُصدَّر أيضاً — ${list.length} من ${c.sessions.length} حصة.</p>
    </div>

    <div class="grid g4" style="margin-bottom:22px">
      <div class="stat"><b>${list.length}</b><span>حصص في التقرير</span></div>
      <div class="stat"><b>${documented}</b><span>وثّقت ما أُنجز</span></div>
      <div class="stat"><b>${withHomework}</b><span>لها واجب منزلي</span></div>
      <div class="stat"><b>${list.length - documented}</b><span>ينقصها التوثيق</span></div>
      <div class="stat present"><b>${totals.present}</b><span>مجموع الحضور</span></div>
      <div class="stat late"><b>${totals.late}</b><span>مجموع التأخر</span></div>
      <div class="stat excused"><b>${totals.excused}</b><span>غياب بعذر</span></div>
      <div class="stat absent"><b>${totals.absent}</b><span>غياب بدون عذر</span></div>
    </div>

    ${!list.length
      ? '<div class="empty">لا توجد حصص داخل المدى المختار.</div>'
      : (mode === 'cards'
        ? cards
        : `<div class="table-wrap"><table>
            <thead><tr>
              <th>#</th><th>اليوم والتاريخ</th><th>الحصة</th><th>العنوان والموضوع</th>
              <th>ما تم إنجازه</th><th>الواجب المنزلي</th>
              <th>حاضر / متأخر / مأذون / غائب</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`)}
    ${printSign()}
  `);

  const refresh = () => viewLessons(c.id);

  document.getElementById('fFrom').addEventListener('change', e => {
    LESSONS_VIEW.from = e.target.value;
    refresh();
  });
  document.getElementById('fTo').addEventListener('change', e => {
    LESSONS_VIEW.to = e.target.value;
    refresh();
  });
  document.getElementById('fClear').addEventListener('click', () => {
    LESSONS_VIEW.from = '';
    LESSONS_VIEW.to = '';
    refresh();
  });
  app.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    LESSONS_VIEW.mode = b.dataset.mode;
    refresh();
  }));

  document.getElementById('printBtn').addEventListener('click', () => window.print());

  document.getElementById('expLessons').addEventListener('click', () => {
    const lines = [
      csvRow([c.name, classHeader(c), c.teacher || '']),
      csvRow(['تقرير توثيق الدروس', range, 'عدد الحصص', list.length,
              'تاريخ التصدير', fmtDate(todayISO())]),
      '',
      csvRow(['#', 'التاريخ', 'اليوم', 'رقم الحصة', 'عنوان الدرس', 'الموضوع / الهدف',
              'ما تم إنجازه', 'الواجب المنزلي',
              'حاضر', 'متأخر', 'مأذون', 'غائب', 'أسماء الغائبين']),
    ];
    list.forEach((s, i) => {
      const k = sessionCounts(c, s);
      const n = namesByStatus(c, s);
      lines.push(csvRow([i + 1, s.date, weekdayAr(s.date), s.period, s.title, s.topic,
        s.notes, s.homework, k.present, k.late, k.excused, k.absent, n.absent.join('، ')]));
    });
    download('توثيق-الدروس-' + c.name + '-' + todayISO() + '.csv', lines.join('\r\n'));
  });
}

/* ============================================================
   ملف الصف — قسم مستقل تماماً عن «توثيق الدروس».
   بياناته في DB.roster وحده: قائمة طلاب بأسمائها وبطاقاتها وأحداثها،
   بلا مادة ولا شعبة ولا حصص. تُحفظ مع باقي السجل على خادم الموقع.
   ============================================================ */

const ROSTER_NAME = 'الثامن 2';

/** حقول بطاقة الهوية — كلها اختيارية. */
const PROFILE_KEYS = ['birth', 'nid', 'mentors', 'phone', 'father', 'fatherPhone', 'fatherWork',
                      'mother', 'motherPhone', 'motherWork', 'siblings', 'rank', 'town'];

/** عناوين الأعمدة المقبولة في ملف Excel لكل حقل. */
const PROFILE_COLS = [
  { key: 'name',        words: ['اسم الطالب', 'اسم التلميذ', 'الاسم'] },
  { key: 'birth',       words: ['تاريخ الميلاد', 'الميلاد'] },
  { key: 'nid',         words: ['رقم الهويه', 'الهويه', 'رقم الهويه الشخصيه'] },
  { key: 'mentors',     words: ['اسم المربين', 'المربين', 'المربي', 'المربيه'] },
  { key: 'phone',       words: ['هاتف الطالب', 'جوال الطالب', 'هاتف التلميذ'] },
  { key: 'father',      words: ['اسم الاب'] },
  { key: 'fatherPhone', words: ['هاتف الاب', 'جوال الاب'] },
  { key: 'fatherWork',  words: ['مكان عمل الاب', 'عمل الاب', 'مهنه الاب'] },
  { key: 'mother',      words: ['اسم الام'] },
  { key: 'motherPhone', words: ['هاتف الام', 'جوال الام'] },
  { key: 'motherWork',  words: ['مكان عمل الام', 'عمل الام', 'مهنه الام'] },
  { key: 'siblings',    words: ['عدد اخوه الطالب', 'عدد الاخوه', 'عدد اخوه'] },
  { key: 'rank',        words: ['ترتيب الطالب بين اخوته', 'ترتيب الطالب', 'الترتيب بين الاخوه'] },
  { key: 'town',        words: ['البلده', 'القريه', 'المدينه', 'مكان السكن', 'السكن'] },
];

/** تطبيع عربي للمقارنة: يزيل التشكيل ويوحّد الألف والتاء المربوطة والياء. */
const normAr = s => String(s == null ? '' : s)
  .replace(/[ً-ْـ]/g, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/[ىئ]/g, 'ي')
  .replace(/ؤ/g, 'و')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const hasProfile = st => PROFILE_KEYS.some(k => st[k]);

/** صف عناوين ← { اسم الحقل: رقم العمود } */
function mapColumns(row) {
  const map = {};
  (row || []).forEach((cell, i) => {
    const h = normAr(cell);
    if (!h) return;
    let hit = PROFILE_COLS.find(col => col.words.some(w => normAr(w) === h));
    if (!hit) hit = PROFILE_COLS.find(col => col.words.some(w => h.indexOf(normAr(w)) !== -1));
    if (hit && map[hit.key] === undefined) map[hit.key] = i;
  });
  return map;
}

/** خلية Excel ← نص جاهز للعرض. */
function cellText(v, key) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? ''
      : v.getUTCFullYear() + '-' + pad2(v.getUTCMonth() + 1) + '-' + pad2(v.getUTCDate());
  }
  if (typeof v === 'number') {
    const s = String(v);
    // أرقام الهوية تُحفظ في Excel كأعداد، فتضيع الأصفار البادئة
    return (key === 'nid' && s.length === 8) ? s.padStart(9, '0') : s;
  }
  return String(v).replace(/\s+/g, ' ').trim();
}

/** أوراق Excel ← قائمة سجلات طلاب. يعيد null إن لم يجد عمود «اسم الطالب». */
function rosterFromRows(rows) {
  let map = null;
  let head = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const m = mapColumns(rows[i]);
    if (m.name !== undefined) { map = m; head = i; break; }
  }
  if (!map) return null;

  const out = [];
  for (let i = head + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rec = {};
    Object.keys(map).forEach(k => { rec[k] = cellText(row[map[k]], k); });
    if (rec.name) out.push(rec);
  }
  return out;
}

/** يدمج السجلات في ملف الصف: مطابقة بالاسم، وإضافة من لم يكن موجوداً. */
function applyRoster(recs) {
  const R = DB.roster;
  const byName = {};
  R.students.forEach(st => { byName[normAr(st.name)] = st; });

  let updated = 0;
  let added = 0;
  recs.forEach(r => {
    const key = normAr(r.name);
    let st = byName[key];
    if (!st) {
      st = { id: uid(), no: '', name: r.name, phone: '', events: [] };
      R.students.push(st);
      byName[key] = st;
      added++;
    } else {
      updated++;
    }
    PROFILE_KEYS.forEach(k => { if (r[k]) st[k] = r[k]; });
  });
  return { updated, added };
}

/** العمر بالسنوات من تاريخ ميلاد ISO. */
function ageOf(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  const b = new Date(iso + 'T00:00:00');
  if (isNaN(b.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) a--;
  return a >= 0 && a < 120 ? a : null;
}

/** حرفان من الاسم للصورة الرمزية. */
const initialsOf = name => String(name || '')
  .trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0)).join('');

/** لون ثابت لكل اسم — يُبقي البطاقة مميّزة بلا صور. */
function hueOf(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** ترويسة الطباعة لصفحات ملف الصف — بلا بيانات صف دراسي. */
function rosterHead(title, extra) {
  return `<div class="print-only print-head">
      <div class="ph-top"><b>${esc(title)}</b><span>طُبع في ${esc(fmtDate(todayISO()))}</span></div>
      <div class="ph-meta">${esc(DB.roster.name)}${extra ? ' · ' + esc(extra) : ''}</div>
    </div>`;
}

/** سطر يوضّح أين تُحفظ البيانات فعلاً. */
function storageNote() {
  if (REMOTE.mode !== 'remote') {
    return 'تعمل الآن بلا خادم — التعديلات محفوظة في هذا المتصفح فقط. ' +
           'افتح الموقع المنشور ليُحفظ كل شيء على الخادم.';
  }
  return 'كل تعديل يُحفظ تلقائياً على خادم الموقع، وتجده من أي جهاز تفتح منه الرابط.';
}

/* ---------------------- بطاقات الطلاب ---------------------- */

const PROFILE_VIEW = { q: '', hideId: false };

function viewProfile() {
  const R = DB.roster;
  const v = PROFILE_VIEW;
  const filled = R.students.filter(hasProfile).length;

  // أرقام هوية مكرّرة — خطأ شائع عند نسخ الصفوف في Excel
  const idSeen = {};
  R.students.forEach(st => { if (st.nid) idSeen[st.nid] = (idSeen[st.nid] || 0) + 1; });

  const q = normAr(v.q);
  const list = R.students.filter(st => !q ||
    [st.name, st.town, st.nid, st.phone, st.father, st.mother, st.fatherWork, st.motherWork]
      .some(x => normAr(x).indexOf(q) !== -1));

  const tel = n => {
    const clean = String(n || '').replace(/[^\d+]/g, '');
    return clean ? '<a href="tel:' + esc(clean) + '">' + esc(n) + '</a>' : '';
  };

  const F = (label, html, cls) =>
    '<div' + (cls ? ' class="' + cls + '"' : '') + '><dt>' + label + '</dt>' +
    '<dd>' + (html || '<span class="hint">—</span>') + '</dd></div>';

  const cards = list.map(st => {
    const n = R.students.indexOf(st) + 1;
    const age = ageOf(st.birth);
    const dup = st.nid && idSeen[st.nid] > 1;
    const nid = st.nid ? (v.hideId ? '•••••••••' : esc(st.nid)) : '';
    const evN = eventsOf(st).length;

    const chips = [
      st.town ? '<span class="chip">' + esc(st.town) + '</span>' : '',
      age !== null ? '<span class="chip">' + age + ' سنة</span>' : '',
      evN ? '<span class="chip ok">' + eventsAr(evN) + '</span>' : '',
      dup ? '<span class="chip warn">رقم هوية مكرّر</span>' : '',
    ].filter(Boolean).join('');

    return `<article class="idcard" style="--h:${hueOf(st.name)}">
        <header class="idc-top">
          <div class="idc-ava">${esc(initialsOf(st.name))}</div>
          <div class="idc-id">
            <h3>${esc(st.name)}</h3>
            <div class="idc-sub">${chips || '<span class="hint">لا بيانات إضافية</span>'}</div>
          </div>
          <span class="idc-no">${n}</span>
        </header>

        <dl class="idc-grid">
          ${F('تاريخ الميلاد', st.birth ? '<span class="mono">' + esc(st.birth) + '</span>' : '')}
          ${F('رقم الهوية', nid ? '<span class="mono">' + nid + '</span>' : '')}
          ${F('هاتف الطالب', tel(st.phone), 'wide')}
        </dl>

        <div class="idc-sec">
          <h4>الأب</h4>
          <dl class="idc-grid">
            ${F('الاسم', esc(st.father || ''))}
            ${F('الهاتف', tel(st.fatherPhone))}
            ${F('مكان العمل', esc(st.fatherWork || ''), 'wide')}
          </dl>
        </div>

        <div class="idc-sec">
          <h4>الأم</h4>
          <dl class="idc-grid">
            ${F('الاسم', esc(st.mother || ''))}
            ${F('الهاتف', tel(st.motherPhone))}
            ${F('مكان العمل', esc(st.motherWork || ''), 'wide')}
          </dl>
        </div>

        <div class="idc-foot">
          <span>عدد الإخوة: <b>${esc(st.siblings || '—')}</b></span>
          <span>ترتيبه بينهم: <b>${esc(st.rank || '—')}</b></span>
          ${st.mentors ? '<span>المربّون: ' + esc(st.mentors) + '</span>' : ''}
        </div>

        <div class="idc-acts no-print">
          <a class="btn ghost sm" href="#/profile/events/${st.id}">الأحداث (${evN})</a>
          <button class="btn ghost sm" data-print="${st.id}">طباعة البطاقة</button>
          <a class="btn ghost sm" href="#/profile/card/${st.id}">تعديل</a>
          <button class="btn ghost sm danger-link" data-delcard="${st.id}">حذف</button>
        </div>
      </article>`;
  }).join('');

  render(`
    ${rosterHead('ملف صف ' + R.name, R.students.length + ' طالباً')}
    <div class="crumb no-print"><a href="#/">الرئيسية</a> ← ملف الصف</div>

    <div class="page-head">
      <div>
        <h1>ملف صف ${esc(R.name)}</h1>
        <p class="sub">${R.students.length} طالباً · ${filled} بطاقة مكتملة ·
          صدر بتاريخ ${esc(fmtDate(todayISO()))}</p>
      </div>
      <div class="actions no-print">
        <a class="btn" href="#/profile/card/new">+ إضافة طالب</a>
        <button class="btn ghost" id="printBtn">طباعة</button>
        <a class="btn ghost" href="#/profile/events">سجل الأحداث</a>
        <a class="btn ghost" href="#/profile/letters">مراسلات مع الأهل</a>
        <button class="btn ghost" id="impRoster">استيراد من Excel</button>
        <button class="btn ghost${v.hideId ? ' on' : ''}" id="hideId">${
          v.hideId ? 'إظهار أرقام الهوية' : 'إخفاء أرقام الهوية'}</button>
      </div>
    </div>
    <input type="file" id="rosterFile" accept=".xlsx,.xlsm" hidden>

    ${!R.students.length
      ? `<div class="empty">لا توجد بطاقات بعد.<br>
          استورد قائمة طلاب ${esc(R.name)} من ملف Excel، أو أضفهم واحداً واحداً.<br><br>
          <button class="btn" id="impEmpty">استيراد من ملف Excel</button>
          <a class="btn ghost" href="#/profile/card/new">إضافة طالب يدوياً</a>
          <p class="hint">${storageNote()}</p></div>`
      : `<div class="card no-print">
          <div class="filters">
            <div class="f" style="flex:1;min-width:240px">
              <label for="pq">بحث</label>
              <input type="text" id="pq" value="${esc(v.q)}"
                placeholder="اسم الطالب، البلدة، رقم الهوية، اسم الأب أو الأم…">
            </div>
            <div class="f"><button class="btn ghost" id="pClear">إظهار الكل</button></div>
          </div>
          <p class="hint">${list.length} من ${R.students.length} طالباً${
            filled < R.students.length
              ? ' — ' + (R.students.length - filled) + ' بطاقة تنقصها البيانات.'
              : ''} ${storageNote()}</p>
        </div>
        ${list.length
          ? '<div class="idgrid">' + cards + '</div>'
          : '<div class="empty">لا نتيجة مطابقة للبحث.</div>'}`}
  `);

  const fileInput = document.getElementById('rosterFile');

  /** يقرأ ملف Excel من جهاز المعلّم — ثم تُحفظ البيانات على الخادم. */
  const pickFile = () => fileInput.click();
  const impBtn = document.getElementById('impRoster');
  const impEmpty = document.getElementById('impEmpty');
  if (impBtn) impBtn.addEventListener('click', pickFile);
  if (impEmpty) impEmpty.addEventListener('click', pickFile);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;

    let recs = null;
    try {
      const wb = await readXlsx(file);
      for (let i = 0; i < wb.sheets.length && !(recs && recs.length); i++) {
        recs = rosterFromRows(wb.sheets[i].rows);
      }
    } catch (err) {
      alert('تعذّر قراءة الملف: ' + ((err && err.message) || err));
      return;
    }

    if (!recs || !recs.length) {
      alert('لم أجد عمود «اسم الطالب» في الملف.\n' +
            'تأكّد أن الصف الأول يحمل عناوين الأعمدة مثل: اسم الطالب، تاريخ الميلاد، رقم الهوية…');
      return;
    }

    const known = {};
    R.students.forEach(st => { known[normAr(st.name)] = true; });
    const willAdd = recs.filter(r => !known[normAr(r.name)]).length;

    if (!confirm('الملف يحتوي ' + recs.length + ' طالباً:\n' +
                 '• تحديث بيانات ' + (recs.length - willAdd) + ' طالباً موجوداً\n' +
                 '• إضافة ' + willAdd + ' طالباً جديداً\n\nالمتابعة؟')) return;

    const res = applyRoster(recs);
    save();
    toast('حُدّث ' + res.updated + ' وأُضيف ' + res.added);
    viewProfile();
  });

  /** طباعة بطاقة واحدة: نخفي البقية بـ CSS بدل إعادة الرسم. */
  app.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => {
    const card = b.closest('.idcard');
    document.body.classList.add('print-one');
    card.classList.add('print-target');
    const restore = () => {
      document.body.classList.remove('print-one');
      card.classList.remove('print-target');
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
    setTimeout(restore, 1500);   // متصفحات لا تطلق afterprint
  }));

  app.querySelectorAll('[data-delcard]').forEach(b => b.addEventListener('click', () => {
    const st = R.students.find(x => x.id === b.dataset.delcard);
    if (!st) return;
    const n = eventsOf(st).length;
    if (!confirm('حذف بطاقة «' + st.name + '»' +
                 (n ? ' و' + eventsAr(n) : '') + ' نهائياً؟')) return;
    R.students = R.students.filter(x => x.id !== st.id);
    save();
    toast('حُذفت البطاقة');
    viewProfile();
  }));

  document.getElementById('printBtn').addEventListener('click', () => window.print());

  document.getElementById('hideId').addEventListener('click', () => {
    v.hideId = !v.hideId;
    viewProfile();
  });

  const pq = document.getElementById('pq');
  if (pq) {
    pq.addEventListener('input', e => {
      v.q = e.target.value;
      viewProfile();
      const box = document.getElementById('pq');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    });
    document.getElementById('pClear').addEventListener('click', () => {
      v.q = '';
      viewProfile();
    });
  }
}

/* ---------------------- تعديل بطاقة طالب ---------------------- */

/** حقول نموذج البطاقة: [المفتاح، العنوان، نوع الحقل، عرض كامل؟] */
const CARD_FIELDS = [
  ['name',        'اسم الطالب',      'text', true],
  ['birth',       'تاريخ الميلاد',   'date', false],
  ['nid',         'رقم الهوية',      'text', false],
  ['phone',       'هاتف الطالب',     'tel',  false],
  ['town',        'البلدة',          'text', false],
  ['father',      'اسم الأب',        'text', false],
  ['fatherPhone', 'هاتف الأب',       'tel',  false],
  ['fatherWork',  'مكان عمل الأب',   'text', true],
  ['mother',      'اسم الأم',        'text', false],
  ['motherPhone', 'هاتف الأم',       'tel',  false],
  ['motherWork',  'مكان عمل الأم',   'text', true],
  ['siblings',    'عدد الإخوة',      'text', false],
  ['rank',        'ترتيبه بين إخوته', 'text', false],
  ['mentors',     'اسم المربّين',    'text', true],
  ['no',          'رقم الطالب (اختياري)', 'text', false],
];

/** نموذج البطاقة: studentId = null لإضافة طالب جديد يدوياً، وإلا تعديل بطاقة قائمة. */
function viewCardForm(studentId) {
  const R = DB.roster;
  const isNew = !studentId;
  const st = isNew ? { name: '' } : R.students.find(x => x.id === studentId);
  if (!st) return notFound('الطالب');

  const fields = CARD_FIELDS.map(([key, label, type, wide]) =>
    `<div class="field${wide ? ' wide' : ''}">
       <label for="f_${key}">${label}</label>
       <input type="${type}" id="f_${key}" name="${key}" value="${esc(st[key] || '')}"
              ${key === 'name' ? 'required' + (isNew ? ' autofocus' : '') : ''}>
     </div>`).join('');

  const title = isNew ? 'إضافة طالب' : 'تعديل بطاقة';

  render(`
    <div class="crumb"><a href="#/">الرئيسية</a> ←
      <a href="#/profile">ملف الصف</a> ← ${title}</div>

    <div class="page-head">
      <div>
        <h1>${title}</h1>
        <p class="sub">${isNew ? 'طالب جديد' : esc(st.name)} · ${esc(R.name)}</p>
      </div>
      <div class="actions">
        <a class="btn ghost" href="#/profile">رجوع للبطاقات</a>
      </div>
    </div>

    <form id="cardForm">
      <div class="card">
        <div class="cardgrid">${fields}</div>
        <p class="hint">${isNew ? 'اسم الطالب وحده مطلوب، وبقية الحقول يمكن إكمالها لاحقاً. '
                                : 'اترك أي حقل فارغاً ليظهر في البطاقة بعلامة «—». '}${storageNote()}</p>
      </div>
      <div class="sticky-save actions">
        <button class="btn" type="submit">${isNew ? 'إضافة الطالب' : 'حفظ التعديلات'}</button>
        ${isNew ? '<button class="btn ghost" type="submit" data-again="1">إضافة وطالب آخر</button>' : ''}
        <a class="btn ghost" href="#/profile">إلغاء</a>
        ${isNew ? '' : '<button class="btn danger" type="button" id="delCard">حذف البطاقة</button>'}
      </div>
    </form>
  `);

  document.getElementById('cardForm').addEventListener('submit', e => {
    e.preventDefault();
    const again = !!(e.submitter && e.submitter.dataset.again);
    const fd = new FormData(e.target);
    const name = String(fd.get('name') || '').replace(/\s+/g, ' ').trim();
    if (!name) { alert('اسم الطالب مطلوب.'); return; }

    // الاسم مفتاح المطابقة عند الاستيراد من Excel — التكرار يربك الدمج لاحقاً
    const twin = R.students.find(x => x !== st && normAr(x.name) === normAr(name));
    if (twin && !confirm('يوجد في الصف طالب باسم «' + twin.name + '». المتابعة رغم ذلك؟')) return;

    CARD_FIELDS.forEach(([key]) => {
      st[key] = String(fd.get(key) || '').replace(/\s+/g, ' ').trim();
    });
    st.name = name;

    if (isNew) {
      st.id = uid();
      st.events = [];
      R.students.push(st);
    }
    save();

    if (isNew && again) {
      toast('أُضيف ' + name);
      viewCardForm(null);
      window.scrollTo(0, 0);
      return;
    }
    toast(isNew ? 'أُضيف الطالب' : 'حُفظت البطاقة');
    go('/profile');
  });

  if (isNew) return;

  document.getElementById('delCard').addEventListener('click', () => {
    const n = eventsOf(st).length;
    if (!confirm('حذف بطاقة «' + st.name + '»' + (n ? ' و' + eventsAr(n) : '') + ' نهائياً؟')) return;
    R.students = R.students.filter(x => x.id !== st.id);
    save();
    toast('حُذفت البطاقة');
    go('/profile');
  });
}

/* ---------------------- توثيق أحداث الطلاب ---------------------- */

/** أنواع الأحداث — الترتيب هنا هو ترتيب الأزرار والإحصاء. */
const EVENT_TYPES = {
  behavior: { label: 'توثيق سلوك',           cls: 'late'  },
  incident: { label: 'تقرير عن حادثة',       cls: 'bad'   },
  parents:  { label: 'لقاء مع أولياء الأمور', cls: 'brand' },
  talk:     { label: 'محادثة مع طالب',        cls: 'ok'    },
  special:  { label: 'حدث خاص',              cls: 'exc'   },
  other:    { label: 'حدث آخر',              cls: 'muted' },
};
const EVENT_KEYS = Object.keys(EVENT_TYPES);

const eventLabel = t => (EVENT_TYPES[t] || EVENT_TYPES.other).label;
const eventCls   = t => (EVENT_TYPES[t] || EVENT_TYPES.other).cls;

const eventsOf = st => (st.events || []);

/** صياغة عربية سليمة لعدد الأحداث: حدث · حدثان · أحداث · حدثاً. */
function eventsAr(n) {
  if (n === 1) return 'حدث موثّق';
  if (n === 2) return 'حدثان موثّقان';
  if (n <= 10) return n + ' أحداث موثّقة';
  return n + ' حدثاً موثّقاً';
}

/** كل أحداث ملف الصف مسطّحة ومرتّبة — الأحدث أولاً. */
function allEvents() {
  const out = [];
  DB.roster.students.forEach(st => eventsOf(st).forEach(e => out.push({ st, e })));
  return out.sort((a, b) =>
    (b.e.date + (b.e.time || '')).localeCompare(a.e.date + (a.e.time || '')));
}

function findEvent(eid) {
  const list = DB.roster.students;
  for (let i = 0; i < list.length; i++) {
    const e = eventsOf(list[i]).find(x => x.id === eid);
    if (e) return { st: list[i], e };
  }
  return null;
}

const EVENTS_VIEW = { student: '', type: '', from: '', to: '' };

function viewEvents(studentId) {
  const R = DB.roster;
  const v = EVENTS_VIEW;

  // الطالب يأتي من المسار — وفتح الصفحة بلا طالب يعني «كل الطلاب»
  v.student = studentId || '';
  if (v.student && !R.students.some(st => st.id === v.student)) v.student = '';

  const list = allEvents().filter(x =>
    (!v.student || x.st.id === v.student) &&
    (!v.type || x.e.type === v.type) &&
    (!v.from || x.e.date >= v.from) &&
    (!v.to || x.e.date <= v.to));

  const counts = {};
  EVENT_KEYS.forEach(k => { counts[k] = 0; });
  allEvents().forEach(x => {
    if (v.student && x.st.id !== v.student) return;
    if (counts[x.e.type] !== undefined) counts[x.e.type]++;
  });

  const who = v.student ? (R.students.find(st => st.id === v.student) || {}).name : '';
  const range = (v.from || v.to)
    ? (v.from ? 'من ' + v.from : 'من البداية') + (v.to ? ' إلى ' + v.to : ' حتى اليوم')
    : 'كل الفترة';

  const field = (label, body) => body
    ? `<div class="evt-f"><label>${label}</label><div>${nl2br(body)}</div></div>` : '';

  const cards = list.map(x => {
    const e = x.e;
    return `<article class="evt ${eventCls(e.type)}">
        <header class="evt-top">
          <div>
            <span class="pill ${eventCls(e.type)}">${esc(eventLabel(e.type))}</span>
            <b class="evt-name">${esc(x.st.name)}</b>
          </div>
          <span class="evt-when">${esc(fmtDate(e.date))}${e.time ? ' · ' + esc(e.time) : ''}</span>
        </header>
        <h3 class="evt-title">${esc(e.title || eventLabel(e.type))}</h3>
        ${field('ما حدث', e.body)}
        ${field('الإجراء والمتابعة', e.action)}
        ${field('الحاضرون', e.people)}
        <div class="evt-acts no-print">
          <button class="btn ghost sm" data-pevt="${e.id}">طباعة</button>
          <a class="btn ghost sm" href="#/profile/event/${e.id}">تعديل</a>
          <button class="btn ghost sm danger-link" data-devt="${e.id}">حذف</button>
        </div>
      </article>`;
  }).join('');

  const typeBtn = (val, label) =>
    `<button class="btn ghost sm${v.type === val ? ' on' : ''}" data-etype="${val}">${label}</button>`;

  const studentOpts = R.students.map(st =>
    `<option value="${esc(st.id)}"${st.id === v.student ? ' selected' : ''}>${esc(st.name)}</option>`).join('');

  render(`
    ${rosterHead('سجل الأحداث' + (who ? ' — ' + who : ''), range + ' · ' + list.length + ' حدثاً')}
    <div class="crumb no-print"><a href="#/">الرئيسية</a> ←
      <a href="#/profile">ملف الصف</a> ← سجل الأحداث</div>

    <div class="page-head">
      <div>
        <h1>سجل الأحداث${who ? ' — ' + esc(who) : ''}</h1>
        <p class="sub">${esc(R.name)} · ${esc(range)} · ${list.length} حدثاً ·
          صدر بتاريخ ${esc(fmtDate(todayISO()))}</p>
      </div>
      <div class="actions no-print">
        <a class="btn" href="#/profile/event/new${v.student ? '/' + v.student : ''}">+ توثيق حدث</a>
        <button class="btn ghost" id="printBtn">طباعة</button>
        <button class="btn ghost" id="xlsEvents">تحميل Excel</button>
        <a class="btn ghost" href="#/profile">البطاقات</a>
      </div>
    </div>

    ${!R.students.length
      ? `<div class="empty">لا توجد بطاقات في ملف الصف بعد.<br><br>
          <a class="btn" href="#/profile">استيراد الطلاب</a></div>`
      : `<div class="card no-print">
          <div class="filters">
            <div class="f" style="min-width:220px">
              <label for="eStudent">الطالب</label>
              <select id="eStudent">
                <option value="">كل الطلاب</option>
                ${studentOpts}
              </select>
            </div>
            <div class="f"><label for="eFrom">من تاريخ</label>
              <input type="date" id="eFrom" value="${esc(v.from)}"></div>
            <div class="f"><label for="eTo">إلى تاريخ</label>
              <input type="date" id="eTo" value="${esc(v.to)}"></div>
            <div class="f" style="flex:1 1 100%"><label>النوع</label>
              <div class="actions">
                ${typeBtn('', 'الكل')}
                ${EVENT_KEYS.map(k => typeBtn(k, EVENT_TYPES[k].label)).join('')}
              </div></div>
          </div>
          <p class="hint">${storageNote()}</p>
        </div>

        <div class="grid g3" style="margin-bottom:20px">
          ${EVENT_KEYS.map(k =>
            `<div class="stat"><b>${counts[k]}</b><span>${EVENT_TYPES[k].label}</span></div>`).join('')}
        </div>

        ${list.length
          ? '<div class="evtlist">' + cards + '</div>'
          : `<div class="empty">لا أحداث موثّقة${who ? ' لـ' + esc(who) : ''} ضمن هذه التصفية.<br><br>
              <a class="btn" href="#/profile/event/new${v.student ? '/' + v.student : ''}">توثيق أول حدث</a></div>`}`}
    ${printSign()}
  `);

  const sel = document.getElementById('eStudent');
  if (sel) sel.addEventListener('change', e => {
    go('/profile/events' + (e.target.value ? '/' + e.target.value : ''));
  });

  const f1 = document.getElementById('eFrom');
  if (f1) f1.addEventListener('change', e => { v.from = e.target.value; viewEvents(v.student); });
  const f2 = document.getElementById('eTo');
  if (f2) f2.addEventListener('change', e => { v.to = e.target.value; viewEvents(v.student); });

  app.querySelectorAll('[data-etype]').forEach(b => b.addEventListener('click', () => {
    v.type = b.dataset.etype;
    viewEvents(v.student);
  }));

  /** طباعة حدث واحد — نفس أسلوب طباعة بطاقة واحدة. */
  app.querySelectorAll('[data-pevt]').forEach(b => b.addEventListener('click', () => {
    const card = b.closest('.evt');
    document.body.classList.add('print-one');
    card.classList.add('print-target');
    const restore = () => {
      document.body.classList.remove('print-one');
      card.classList.remove('print-target');
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
    setTimeout(restore, 1500);
  }));

  app.querySelectorAll('[data-devt]').forEach(b => b.addEventListener('click', () => {
    const hit = findEvent(b.dataset.devt);
    if (!hit) return;
    if (!confirm('حذف هذا الحدث من سجل «' + hit.st.name + '» نهائياً؟')) return;
    hit.st.events = eventsOf(hit.st).filter(x => x.id !== hit.e.id);
    save();
    toast('حُذف الحدث');
    viewEvents(v.student);
  }));

  document.getElementById('printBtn').addEventListener('click', () => window.print());

  const xls = document.getElementById('xlsEvents');
  if (xls) xls.addEventListener('click', () => {
    const head = ['#', 'التاريخ', 'اليوم', 'الوقت', 'اسم الطالب', 'نوع الحدث',
                  'العنوان', 'ما حدث', 'الإجراء والمتابعة', 'الحاضرون'];
    const rows = [
      [{ v: 'سجل الأحداث' + (who ? ' — ' + who : ''), s: 'title' }],
      [{
        v: [R.name, range, list.length + ' حدثاً', 'صدر بتاريخ ' + fmtDate(todayISO())]
          .filter(Boolean).join('  ·  '),
        s: 'meta',
      }],
      [],
      head.map(h => ({ v: h, s: 'head' })),
    ];
    list.forEach((x, i) => {
      const e = x.e;
      rows.push([
        { v: i + 1, s: 'num' },
        { v: e.date, s: 'num' },
        { v: weekdayAr(e.date), s: 'num' },
        { v: e.time || '', s: 'num' },
        { v: x.st.name, s: 'text' },
        { v: eventLabel(e.type), s: e.type === 'incident' ? 'bad' : 'num' },
        { v: e.title || '', s: 'text' },
        { v: e.body || '', s: 'text' },
        { v: e.action || '', s: 'text' },
        { v: e.people || '', s: 'text' },
      ]);
    });
    saveXlsx('أحداث-' + R.name + (who ? '-' + who : '') + '-' + todayISO() + '.xlsx', {
      name: 'سجل الأحداث',
      cols: [5, 13, 11, 8, 24, 20, 26, 40, 34, 24],
      rows,
      freeze: 4,
      filter: 'A4:J' + (4 + list.length),
      merges: ['A1:J1', 'A2:J2'],
    });
    toast('تم تنزيل ملف Excel');
  });
}

/* ---------------------- نموذج توثيق حدث ---------------------- */

function viewEventForm(eventId, presetStudent) {
  const R = DB.roster;

  if (!R.students.length) {
    return render(`<div class="empty">لا توجد بطاقات في ملف الصف بعد.<br><br>
      <a class="btn" href="#/profile">ملف الصف</a></div>`);
  }

  const hit = eventId ? findEvent(eventId) : null;
  if (eventId && !hit) return notFound('الحدث');

  const e = hit ? hit.e : {
    type: 'behavior', date: todayISO(), time: nowTime(),
    title: '', body: '', action: '', people: '',
  };
  const sid = hit ? hit.st.id : (presetStudent || R.students[0].id);

  const studentOpts = R.students.map(st =>
    `<option value="${esc(st.id)}"${st.id === sid ? ' selected' : ''}>${esc(st.name)}</option>`).join('');

  const typeOpts = EVENT_KEYS.map(k =>
    `<option value="${k}"${k === e.type ? ' selected' : ''}>${esc(EVENT_TYPES[k].label)}</option>`).join('');

  render(`
    <div class="crumb"><a href="#/">الرئيسية</a> ←
      <a href="#/profile">ملف الصف</a> ←
      <a href="#/profile/events">سجل الأحداث</a> ← ${hit ? 'تعديل حدث' : 'حدث جديد'}</div>

    <div class="page-head">
      <div>
        <h1>${hit ? 'تعديل حدث' : 'توثيق حدث'}</h1>
        <p class="sub">${esc(R.name)}${hit ? ' · ' + esc(hit.st.name) : ''}</p>
      </div>
      <div class="actions">
        <a class="btn ghost" href="#/profile/events">سجل الأحداث</a>
      </div>
    </div>

    <form id="evtForm">
      <div class="card">
        <div class="cardgrid">
          <div class="field">
            <label for="f_student">الطالب</label>
            <select id="f_student" name="student">${studentOpts}</select>
          </div>
          <div class="field">
            <label for="f_type">نوع الحدث</label>
            <select id="f_type" name="type">${typeOpts}</select>
          </div>
          <div class="field">
            <label for="f_date">التاريخ</label>
            <input type="date" id="f_date" name="date" value="${esc(e.date)}" required>
          </div>
          <div class="field">
            <label for="f_time">الوقت</label>
            <input type="time" id="f_time" name="time" value="${esc(e.time || '')}">
          </div>
          <div class="field wide">
            <label for="f_title">العنوان</label>
            <input type="text" id="f_title" name="title" value="${esc(e.title || '')}"
                   placeholder="عنوان مختصر يلخّص الحدث">
          </div>
          <div class="field wide">
            <label for="f_body">ما حدث</label>
            <textarea id="f_body" name="body"
              placeholder="وصف الحدث كما جرى: المكان، الزمان، ما قيل وما فعل.">${esc(e.body || '')}</textarea>
          </div>
          <div class="field wide">
            <label for="f_action">الإجراء والمتابعة</label>
            <textarea id="f_action" name="action"
              placeholder="ما اتُّخذ من إجراء، وما يحتاج متابعة لاحقاً.">${esc(e.action || '')}</textarea>
          </div>
          <div class="field wide">
            <label for="f_people">الحاضرون</label>
            <input type="text" id="f_people" name="people" value="${esc(e.people || '')}"
                   placeholder="مثلاً: المربّي، والد الطالب، المستشارة">
          </div>
        </div>
        <p class="hint">${storageNote()}</p>
      </div>

      <div class="sticky-save actions">
        <button class="btn" type="submit">${hit ? 'حفظ التعديلات' : 'حفظ الحدث'}</button>
        <a class="btn ghost" href="#/profile/events">إلغاء</a>
        ${hit ? '<button class="btn danger" type="button" id="delEvt">حذف الحدث</button>' : ''}
      </div>
    </form>
  `);

  document.getElementById('evtForm').addEventListener('submit', ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const date = String(fd.get('date') || '');

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date).getTime())) {
      alert('اختر تاريخاً صحيحاً للحدث.');
      return;
    }
    if (date > todayISO() &&
        !confirm('التاريخ المختار (' + fmtDate(date) + ') في المستقبل. المتابعة؟')) return;

    const target = R.students.find(st => st.id === fd.get('student'));
    if (!target) { alert('اختر الطالب.'); return; }

    const data = {
      type: String(fd.get('type') || 'other'),
      date,
      time: String(fd.get('time') || ''),
      title: String(fd.get('title') || '').replace(/\s+/g, ' ').trim(),
      body: String(fd.get('body') || '').trim(),
      action: String(fd.get('action') || '').trim(),
      people: String(fd.get('people') || '').replace(/\s+/g, ' ').trim(),
    };
    if (!data.body && !data.title) { alert('اكتب عنواناً أو وصفاً للحدث.'); return; }

    if (hit) {
      // تغيير الطالب ينقل الحدث من سجل إلى سجل
      if (hit.st.id !== target.id) {
        hit.st.events = eventsOf(hit.st).filter(x => x.id !== hit.e.id);
        target.events = eventsOf(target).concat([Object.assign({ id: hit.e.id }, data,
          { createdAt: hit.e.createdAt, updatedAt: new Date().toISOString() })]);
      } else {
        Object.assign(hit.e, data, { updatedAt: new Date().toISOString() });
      }
      toast('حُفظت التعديلات');
    } else {
      target.events = eventsOf(target).concat([Object.assign({ id: uid() }, data,
        { createdAt: new Date().toISOString() })]);
      toast('وُثّق الحدث');
    }
    save();
    go('/profile/events' + (hit ? '' : '/' + target.id));
  });

  const del = document.getElementById('delEvt');
  if (del) del.addEventListener('click', () => {
    if (!confirm('حذف هذا الحدث نهائياً؟')) return;
    hit.st.events = eventsOf(hit.st).filter(x => x.id !== hit.e.id);
    save();
    toast('حُذف الحدث');
    go('/profile/events');
  });
}

/* ---------------------- مراسلات مع الأهل ---------------------- */

/** صيغة المخاطبة: m ابن · f ابنة · '' الصيغتان معاً كما في النموذج الورقي. */
const GENDERS = { m: 'ذكر', f: 'أنثى', '': 'صيغة عامة (ابنك / ابنتك)' };

/** كلمة حسب الجنس: [مذكر، مؤنث، عامة]. */
const gw = (g, m, f, both) => g === 'm' ? m : g === 'f' ? f : both;

const blank = (v, w) => v
  ? '<b class="lt-fill">' + esc(v) + '</b>'
  : '<span class="lt-blank" style="min-width:' + (w || 120) + 'px"></span>';

/** أنواع المراسلات — كل نوع يرسم متن الرسالة من حقولها. */
const LETTER_TYPES = {
  late: {
    label: 'تأخرات صباحية',
    desc: 'رسالة لولي الأمر بتكرار تأخر الطالب عن الدوام المدرسي الصباحي.',
    body: L => {
      const g = L.gender;
      const son = gw(g, 'ابنك', 'ابنتك', 'ابنك / ابنتك');
      const sonPl = gw(g, 'ابنكم', 'ابنتكم', 'ابنكم / ابنتكم');
      return `
        <p class="lt-subj"><span>الموضوع :-</span>
          <u>تأخرات ${son} عن الدوام المدرسيّ.</u></p>

        <div class="lt-item"><span class="lt-num">1)</span><div>
          <p>كما هو معلوم لحضرتك فإن أحد الأنظمة وقوانين المدرسة تفرض على
            ${gw(g, 'الطالب', 'الطالبة', 'الطالب/ـة')} المحافظة على الدوام المدرسيّ
            والوصول بالوقت المحدد للمدرسة.</p>
          <p>في الفترة الأخيرة لوحظ أن ${son} قد ${gw(g, 'تأخّر', 'تأخّرت', 'تأخّر/ت')}
            في ${gw(g, 'حضوره', 'حضورها', 'حضوره/ها')} الصباحي للمدرسة بدون أي عذر / سبب مقنع
            حيث تكررت التأخرات الصباحية ${gw(g, 'عنده', 'عندها', 'عنده/ها')} خلال
            ${blank(L.period, 130)} الأمر الذي يؤثر سلبياً على النظام المدرسيّ من جهة
            ويضر ${gw(g, 'بمصلحته', 'بمصلحتها', 'بمصلحته / ها')} التعليمية من جهة أخرى.</p>
        </div></div>

        <div class="lt-item"><span class="lt-num">2)</span><div>
          <p>نحن كأسرة في المدرسة مقتنعون بأن تعاونكم معنا هو الأساس الأول في منع
            هذه الظاهرة حفاظاً على مصلحة وسلامة أبنائنا.</p>
          <p>بناءً عليه نأمل تعاونكم معنا في تطبيق الأسس السليمة والعمل على انتظام
            ${sonPl} أعلاه.</p>
        </div></div>`;
    },
  },
  lateRepeat: {
    label: 'تأخرات صباحية متكررة',
    desc: 'إنذار من المدير بعد تكرار التأخر رغم التوجّه للطالب شخصياً.',
    signer: 'principal',
    noNote: true,
    noPeriod: true,
    body: L => {
      const g = L.gender;
      const sonPl = gw(g, 'ابنكم', 'ابنتكم', 'ابنكم / ابنتكم');
      return `
        <p class="lt-subj"><span>الموضوع :-</span>
          <u>التأخرات الصباحية المتكررة لدى ${sonPl}.</u></p>

        <div class="lt-item"><span class="lt-num">1)</span><div>
          <p>بودّي أن ألفت نظر حضرتكم إلى التأخرات الصباحية المتكررة لدى ${sonPl}
            ${blank(L.studentName, 150)} من الصف ${blank(L.grade, 80)} وذلك بالرغم من
            توجّهاتنا ${gw(g, 'إليه', 'إليها', 'إليه / ها')} شخصياً لمنع هذه الظاهرة والتي
            تؤثر على نظام المدرسة بشكل سلبي.</p>
        </div></div>

        <div class="lt-item"><span class="lt-num">2)</span><div>
          <p>لذا آمل تعاونكم معنا لاستئصال هذه الظاهرة السلبية لما فيه مصلحة ${sonPl}
            والمدرسة معاً وإلا سنضطر آسفين لاتخاذ إجراءات أخرى.</p>
        </div></div>`;
    },
  },
  absence: {
    label: 'تغيب عن المدرسة',
    desc: 'إعلام ولي الأمر بتغيّب الطالب دون إعلام المدرسة أو إبداء السبب.',
    signer: 'mentor',
    noNote: true,
    noPeriod: true,
    absence: true,
    copy: 'الشخصي',
    body: L => {
      const g = L.gender;
      const son = gw(g, 'ابنك', 'ابنتك', 'ابنك / ابنتك');
      return `
        <p class="lt-subj"><span>الموضوع :-</span>
          <u>تغيّب ${son} أعلاه عن المدرسة.</u></p>

        <div class="lt-item"><span class="lt-num">1)</span><div>
          <p>أُعلمك بهذا أن ${son} ${blank(L.studentName, 150)} من الصف ${blank(L.grade, 80)}
            قد ${gw(g, 'تغيّب', 'تغيّبت', 'تغيّب/ت')} عن المدرسة يوم
            ${blank(L.absFrom ? weekdayAr(L.absFrom) : '', 80)} بتاريخ ${blank(dmy(L.absFrom), 110)}
            واستمر حتى تاريخ ${blank(dmy(L.absTo), 110)} بدون إعلام المدرسة وإبداء السبب الشرعي
            ${gw(g, 'لتغيّبه', 'لتغيّبها', 'لتغيّبه/ها')} مما يقتضي إخبارك بذلك حفاظاً على
            سلامة وأمن طلابنا.</p>
        </div></div>

        <div class="lt-item"><span class="lt-num">2)</span><div>
          <p>نأمل تعاونك معنا وعدم تكرار مثل هذه الظاهرة وإعلامنا في مثل هذه الحالات
            كي نقوم بواجبنا نحو طلابنا على أفضل وجه، ولك الشكر سلفاً.</p>
        </div></div>`;
    },
  },
  leave: {
    label: 'ترك المدرسة',
    desc: 'إعلام ولي الأمر بترك الطالب المدرسة أثناء الدوام دون عذر أو إعلام الإدارة.',
    signer: 'principal',
    subjTeacher: true,
    noNote: true,
    noPeriod: true,
    leave: true,
    body: L => {
      const g = L.gender;
      const son = gw(g, 'ابنك', 'ابنتك', 'ابنك / ابنتك');
      return `
        <p class="lt-subj"><span>الموضوع :-</span>
          <u>ترك ${son} للمدرسة.</u></p>

        <div class="lt-item"><span class="lt-num">1)</span><div>
          <p>أُعلم حضرتكم بهذا أن ${son} أعلاه قد ${gw(g, 'ترك', 'تركت', 'ترك / تركت')} المدرسة يوم
            ${blank(L.leftDate ? weekdayAr(L.leftDate) : '', 80)} الموافق ${blank(dmy(L.leftDate), 110)}
            الحصة ${blank(L.lesson, 50)} في موضوع ${blank(L.subject, 110)} بدون أي عذر شرعي وبدون
            إعلام إدارة المدرسة بذلك، الأمر الذي يعتبر في غاية الخطورة من حيث الحفاظ على أمن
            وسلامة أبنائنا.</p>
        </div></div>

        <div class="lt-item"><span class="lt-num">2)</span><div>
          <p>نأمل تعاونك معنا وعدم تكرار مثل هذا وإعلامنا في مثل هذه الحالات كي نقوم
            بواجبنا نحو طلابنا على أفضل وجه، ولك الشكر سلفاً.</p>
        </div></div>`;
    },
  },
  warning: {
    label: 'توجيه إنذار',
    desc: 'إعلام ولي الأمر بتوجيه إنذار للطالب مع أسبابه.',
    signer: 'principal',
    subjTeacher: true,
    noNote: true,
    noPeriod: true,
    warn: true,
    copy: 'الشخصي',
    body: L => {
      const g = L.gender;
      const son = gw(g, 'لابنك', 'لابنتك', 'لابنك / ابنتك');
      const picked = L.reasons || [];
      const line = (on, text) => `<li><span class="lt-chk">${on ? '✓' : ''}</span>${text}</li>`;
      const other = v => line(!!v, v ? esc(v) : '<span class="lt-blank" style="min-width:260px"></span>');
      return `
        <p class="lt-subj"><span>الموضوع :-</span>
          <u>توجيه إنذار ${son}</u> ${blank(L.studentName, 150)}.</p>

        <div class="lt-item"><span class="lt-num">1)</span><div>
          <p>نُعلمكم بهذا ولأسفنا الشديد أنه تقرر اليوم
            ${blank(L.warnDate ? weekdayAr(L.warnDate) : '', 80)} الموافق ${blank(dmy(L.warnDate), 110)}
            توجيه إنذار ${blank(L.warnLevel, 70)} ${son} وذلك بسبب :-</p>
          <ul class="lt-reasons">
            ${WARN_REASONS.map((r, i) => line(picked.indexOf(String(i)) !== -1, r(g))).join('')}
            ${other(L.other1)}
            ${other(L.other2)}
          </ul>
        </div></div>

        <div class="lt-item"><span class="lt-num">2)</span><div>
          <p>نأمل تعاونكم معنا لعدم تكرار ذلك، ولك الشكر سلفاً.</p>
        </div></div>`;
    },
  },
  meeting: {
    label: 'حضوركم للمدرسة',
    desc: 'دعوة ولي الأمر لمقابلة في المدرسة بموعد محدد وموضوع اللقاء.',
    teacherLabel: 'المعلم/ـة',
    noNote: true,
    noPeriod: true,
    meet: true,
    body: L => {
      const g = L.gender;
      const t = L.topics || [];
      const on = k => t.indexOf(k) !== -1;
      const row = (mark, label, text) =>
        `<li><span class="lt-chk">${mark ? '✓' : ''}</span>${label} ${text}</li>`;
      return `
        <p class="lt-subj"><span>الموضوع :-</span> <u>حضوركم للمدرسة.</u></p>

        <div class="lt-item"><span class="lt-num">1)</span><div>
          <p>أرجو حضوركم للمدرسة وذلك يوم ${blank(L.meetDate ? weekdayAr(L.meetDate) : '', 80)}
            تاريخ ${blank(dmy(L.meetDate), 110)} في تمام الساعة ${blank(L.meetTime, 60)}
            لمقابلة ضرورية مع ${blank(L.meetWith, 120)} أو ترتيب الموعد هاتفياً في حالة عدم
            ملاءمته، وذلك للتباحث حول :-</p>
          <ul class="lt-reasons">
            ${row(on('behavior'), 'أ)', 'سلوكيات ' + gw(g, 'ابنك', 'ابنتك', 'ابنك / ابنتك') + '.')}
            ${row(on('study'), 'ب)', gw(g, 'تحصيله', 'تحصيلها', 'تحصيله / ها') + ' الدراسي.')}
            ${row(!!L.topicOther, 'ج)', 'آخر : ' + blank(L.topicOther, 240))}
          </ul>
        </div></div>`;
    },
  },
  suspend: {
    label: 'قرار فصل',
    desc: 'إعلام ولي الأمر بقرار فصل الطالب مؤقتاً وشرط عودته للصف.',
    signer: 'principal',
    noPeriod: true,
    noteInBody: true,
    susp: true,
    copyText: g => '1) ملف ' + gw(g, 'الطالب', 'الطالبة', 'الطالب/ـة') + ' في المدرسة',
    body: L => {
      const g = L.gender;
      const son = gw(g, 'ابنك', 'ابنتك', 'ابنك / ابنتك');
      const day = iso => blank(iso ? weekdayAr(iso) : '', 80);
      return `
        <p class="lt-subj"><span>الموضوع :-</span>
          <u>إعلام عن قرار لفصل ${son}</u> ${blank(L.studentName, 150)}.</p>

        <div class="lt-item"><span class="lt-num">1)</span><div>
          <p>نظراً لسلوكيات ${son} أعلاه الأخيرة والمتكررة وعدم
            ${gw(g, 'انصياعه', 'انصياعها', 'انصياعه / ها')} لتوجيهات ${blank(L.directives, 130)}
            يؤسفني إعلامك أنه تقرر ${gw(g, 'فصله', 'فصلها', 'فصله / ها')} عن المدرسة ابتداءً من
            يوم ${day(L.susFrom)} تاريخ ${blank(dmy(L.susFrom), 110)} وحتى يوم ${day(L.susTo)}
            تاريخ ${blank(dmy(L.susTo), 110)}.</p>
        </div></div>

        <div class="lt-item"><span class="lt-num">2)</span><div>
          <p>يُشترط ${gw(g, 'دخوله', 'دخولها', 'دخوله / ها')} للصف بحضورك شخصياً للمدرسة يوم
            ${day(L.returnDate)} ${L.returnDate ? blank(dmy(L.returnDate), 110) : ''}
            للبحث في السلوكيات السيئة الصادرة من ${son}.</p>
        </div></div>

        <div class="lt-item"><span class="lt-num">3)</span><div>
          <p>نأمل تعاونكم معنا لما فيه المصلحة.</p>
        </div></div>

        <div class="lt-item"><span class="lt-num">4)</span><div style="flex:1">
          <p>ملاحظات :</p>
          ${L.note
            ? '<div class="lt-note-t">' + nl2br(L.note) + '</div>'
            : '<div class="lt-blank lt-rule"></div><div class="lt-blank lt-rule"></div>'}
        </div></div>`;
    },
  },
  expel: {
    label: 'إخراج من الصف',
    desc: 'إعلام ولي الأمر بإخراج الطالب من الدرس مع سبب الإخراج.',
    signer: 'principal',
    subjTeacher: true,
    subjFirst: true,
    subjLabel: 'معلم/ة الموضوع',
    noNote: true,
    noPeriod: true,
    out: true,
    copyText: () => 'للملف الشخصي',
    body: L => {
      const g = L.gender;
      const son = gw(g, 'ابنك', 'ابنتك', 'ابنك / ابنتك');
      const came = gw(g, 'حضر', 'حضرت', 'حضر/ت');
      const r = L.outReasons || [];
      const line = (k, text) =>
        `<li><span class="lt-chk">${r.indexOf(k) !== -1 ? '✓' : ''}</span>${text}</li>`;
      return `
        <p class="lt-subj"><span>الموضوع :-</span>
          <u>إعلام عن إخراج ${son} أعلاه من الصف.</u></p>

        <div class="lt-item"><span class="lt-num">1)</span><div>
          <p>أود إعلامكم بهذا أن ${son} ${blank(L.studentName, 150)} من الصف ${blank(L.grade, 80)}
            قد ${gw(g, 'أُخرج', 'أُخرجت', 'أُخرج/ت')} اليوم
            ${blank(L.outDate ? weekdayAr(L.outDate) : '', 80)} الموافق ${blank(dmy(L.outDate), 110)}
            في درس المعلم/ـة ${blank(L.subjTeacher, 120)} خلال الحصة ${blank(L.lesson, 50)}
            وذلك بسبب :-</p>
          <ul class="lt-reasons">
            ${line('disrupt', 'عرقلة سير الدرس.')}
            ${line('books', came + ' بدون كتب أو دفاتر للمرة ' + blank(L.booksCount, 50))}
            ${line('hw', came + ' بدون تحضير ' + gw(g, 'وظائفه', 'وظائفها', 'وظائفه/ها') +
                   ' البيتية للمرة ' + blank(L.hwCount, 50))}
            ${line('behave', gw(g, 'تصرّف', 'تصرّفت', 'تصرّف/ت') + ' تصرفاً غير لائق أثناء الدرس.')}
          </ul>
        </div></div>

        <div class="lt-item"><span class="lt-num">2)</span><div>
          <p>نأمل تعاونكم معنا لمنع تكرار هذه الظاهرة وإلا سنضطر آسفين إلى اتخاذ
            إجراءات أخرى.</p>
        </div></div>`;
    },
  },
  pledge: {
    label: 'تعهّد',
    desc: 'تعهّد يوقّعه الطالب أمام المعلم ومربي الصف بعدم تكرار سلوك غير لائق.',
    pledge: true,
    noNote: true,
    noPeriod: true,
    head: L => `
      <div class="lt-to">
        <div>حضرة،</div>
        <div>الأستاذ / المعلمة ${blank(L.teacher, 170)} المحترم/ة</div>
        <div>مربي/ة الصف ${blank(L.mentor, 150)}</div>
      </div>`,
    foot: L => `
      <div class="lt-sign">
        <div>مع فائق الاحترام،</div>
        <div>اسم ${gw(L.gender, 'الطالب', 'الطالبة', 'الطالب/ـة')} ${blank(L.studentName, 160)}</div>
        <div>التوقيع ${blank('', 160)}</div>
      </div>
      <div class="lt-copy">للمعلومية :-
        <div>اسم وليّ/ة الأمر ${blank(L.guardian, 170)} &nbsp; التوقيع ${blank('', 120)}</div>
      </div>`,
    body: L => {
      const r = L.reasons || [];
      const line = (on, text) => `<li><span class="lt-chk">${on ? '✓' : ''}</span>${text}</li>`;
      const other = v => line(!!v, v ? esc(v) : '<span class="lt-blank" style="min-width:260px"></span>');
      return `
        <p class="lt-subj"><span>الموضوع :-</span> <u>تعهّد.</u></p>

        <div class="lt-item"><span class="lt-num">1)</span><div>
          <p>بودّي أن أعبّر لك بهذا عن أسفي الشديد على سلوكي المبيّن أدناه :-</p>
          <ul class="lt-reasons">
            ${PLEDGE_REASONS.map((t, i) => line(r.indexOf(String(i)) !== -1, t)).join('')}
            ${other(L.other1)}
            ${other(L.other2)}
          </ul>
        </div></div>

        <div class="lt-item"><span class="lt-num">2)</span><div>
          <p>أعدك بهذا أن السلوك أعلاه أو أي سلوك آخر غير لائق والذي يتعارض وأنظمة المدرسة،
            لن يتكرر من طرفي مستقبلاً. وفيما لو تكرر ثانيةً تكون لك كامل الصلاحية باتخاذ
            الإجراءات التي تراها مناسبة بحقّي بما في ذلك حرماني من أيّة فعالية أو نشاط مدرسيّ
            دون اعتراض من طرفي على ذلك، وذلك مراعاةً لتخوّفات المدرسة من عرقلته وحفاظاً على
            سيره وتنفيذه كاملاً لما فيه مصلحة طلاب المدرسة.</p>
        </div></div>`;
    },
  },
  absences: {
    label: 'غيابات متكررة',
    desc: 'رسالة لولي الأمر بتكرار غياب الطالب عن المدرسة دون سبب مقنع.',
    absRate: true,
    body: L => {
      const g = L.gender;
      const son = gw(g, 'ابنك', 'ابنتك', 'ابنك / ابنتك');
      const sonPl = gw(g, 'ابنكم', 'ابنتكم', 'ابنكم / ابنتكم');
      return `
        <p class="lt-subj"><span>الموضوع :-</span>
          <u>غيابات ${son} المتكررة عن المدرسة.</u></p>

        <div class="lt-item"><span class="lt-num">1)</span><div>
          <p>كما هو معلوم لحضرتك فإن أحد الأنظمة وقوانين المدرسة تفرض على
            ${gw(g, 'الطالب', 'الطالبة', 'الطالب/ـة')} المحافظة على الدوام المدرسيّ وعدم التغيّب
            المتكرر عن المدرسة (بدون سبب شرعي).</p>
          <p>في الفترة الأخيرة لوحظ أن ${son} ${gw(g, 'تغيّب', 'تغيّبت', 'تغيّب/ت')} عن المدرسة
            بدون أي عذر / سبب مقنع حيث تكررت ${gw(g, 'غياباته', 'غياباتها', 'غياباته/ها')} بمعدل
            ${blank(L.absDays, 50)} أيام خلال ${blank(L.period, 130)} الأمر الذي يؤثر سلبياً على
            النظام المدرسيّ من جهة ويضر ${gw(g, 'بمصلحته', 'بمصلحتها', 'بمصلحته / ها')} التعليمية
            من جهة أخرى.</p>
        </div></div>

        <div class="lt-item"><span class="lt-num">2)</span><div>
          <p>نحن كأسرة في المدرسة مقتنعون بأن تعاونكم معنا هو الأساس الأول في منع
            هذه الظاهرة حفاظاً على مصلحة وسلامة أبنائنا.</p>
          <p>بناءً عليه نأمل تعاونكم معنا في تطبيق الأسس السليمة والعمل على انتظام
            ${sonPl} أعلاه.</p>
        </div></div>`;
    },
  },
};

/** بنود التعهّد بصيغة المتكلم كما في النموذج الورقي. */
const PLEDGE_REASONS = [
  'الاعتداء على طالب / ـة.',
  'الاعتداء على ممتلكات الغير.',
  'الاعتداء على ممتلكات المدرسة.',
  'تصرّف غير لائق مع معلم / ـة.',
  'إهمال وتقصير في واجباتي البيتية والمدرسية.',
  'عرقلة سير الدرس.',
];

/** أسباب الإنذار كما في النموذج الورقي — تُحفظ بأرقامها. */
const WARN_REASONS = [
  g => 'الاعتداء على طالب / ـة.',
  g => 'الاعتداء على ممتلكات ' + gw(g, 'غيره', 'غيرها', 'غيره / ها') + '.',
  g => 'الاعتداء على ممتلكات المدرسة.',
  g => 'تصرّف غير لائق مع معلم / ـة.',
  g => 'الإهمال والتقصير في ' + gw(g, 'واجباته', 'واجباتها', 'واجباته / ها') + '.',
  g => 'عرقلة سير الدرس.',
];
const LETTER_KEYS = Object.keys(LETTER_TYPES);
const letterLabel = t => (LETTER_TYPES[t] || { label: 'مراسلة' }).label;

/** 2026-09-24 ← 24/09/2026 كما يُكتب على الورق. */
const dmy = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('/') : '';

/** الورقة نفسها: ترويسة المدرسة، المرسَل إليه، المتن، التواقيع. */
function letterSheet(L) {
  const T = LETTER_TYPES[L.type] || LETTER_TYPES.late;
  const g = L.gender;
  const subjLine = '<div>' + (T.subjLabel || 'معلم الموضوع') + ' ' + blank(L.subjTeacher, 120) + '</div>';
  return `
    <img class="lt-logo" src="assets/school-header.png" alt="المدرسة الإعدادية دير الأسد">
    <div class="lt-date">التاريخ ${blank(dmy(L.date), 130)}</div>

    ${T.head ? T.head(L) : `<div class="lt-to">
      <div>حضرة،</div>
      <div>السيد/ة ${blank(L.guardian, 170)} المحترم/ة</div>
      <div>وليّ/ة أمر ${gw(g, 'الطالب', 'الطالبة', 'الطالب/ـة')} ${blank(L.studentName, 150)}</div>
      <div>الصف ${blank(L.grade, 80)}</div>
    </div>`}

    <p class="lt-greet">احتراماً وبعد،</p>
    ${T.body(L)}

    ${T.noteInBody || (T.noNote && !L.note) ? '' : `<div class="lt-note"><span>ملاحظة:-</span>
      ${L.note ? '<div class="lt-note-t">' + nl2br(L.note) + '</div>' : '<span class="lt-blank lt-line"></span>'}
    </div>`}

    ${T.foot ? T.foot(L) : `<div class="lt-sign">
      <div>باحترام،</div>
      ${T.signer === 'principal'
        ? '<div><b>' + esc(L.principal || '') + '</b> – مدير المدرسة ' + blank('', 140) + '</div>'
        : T.signer === 'mentor' ? ''
        : '<div>' + (T.teacherLabel || 'الأستاذ/المعلمة') + ' ' + blank(L.teacher, 160) + '</div>'}
      ${T.subjTeacher && T.subjFirst ? subjLine : ''}
      <div>مربي/ة الصف ${blank(L.mentor, 120)}${
        T.signer === 'mentor' ? ' &nbsp; التوقيع ' + blank('', 120) : ''}</div>
      ${T.subjTeacher && !T.subjFirst ? subjLine : ''}
    </div>

    <div class="lt-copy">نسخة :- ${T.copyText ? T.copyText(g)
      : 'لملف ' + gw(g, 'الطالب', 'الطالبة', 'الطالب/ـة') + (T.copy ? ' ' + T.copy : '')}</div>`}`;
}

function findLetter(id) {
  return DB.roster.letters.find(x => x.id === id);
}

function viewLetters() {
  const R = DB.roster;
  const list = R.letters.slice().sort((a, b) =>
    (b.date + b.createdAt).localeCompare(a.date + a.createdAt));

  const types = LETTER_KEYS.map(k => `
      <a class="lt-type" href="#/profile/letter/new/${k}">
        <b>${esc(LETTER_TYPES[k].label)}</b>
        <span>${esc(LETTER_TYPES[k].desc)}</span>
        <span class="btn sm">+ نموذج جديد</span>
      </a>`).join('');

  const rows = list.map((L, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="mono">${esc(dmy(L.date))}</td>
        <td>${esc(L.studentName)}</td>
        <td><span class="pill late">${esc(letterLabel(L.type))}</span></td>
        <td>${esc(L.guardian || '—')}</td>
        <td class="actions">
          <a class="btn ghost sm" href="#/profile/letter/${L.id}">فتح وطباعة</a>
          <button class="btn ghost sm danger-link" data-dlt="${L.id}">حذف</button>
        </td>
      </tr>`).join('');

  render(`
    <div class="crumb"><a href="#/">الرئيسية</a> ←
      <a href="#/profile">ملف الصف</a> ← مراسلات مع الأهل</div>

    <div class="page-head">
      <div>
        <h1>مراسلات مع الأهل</h1>
        <p class="sub">${esc(R.name)} · ${list.length} مستنداً محفوظاً</p>
      </div>
      <div class="actions"><a class="btn ghost" href="#/profile">البطاقات</a></div>
    </div>

    <h2>نموذج جديد</h2>
    <div class="lt-types">${types}</div>

    <h2>المستندات المحفوظة</h2>
    ${list.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>التاريخ</th><th>الطالب</th><th>النوع</th><th>ولي الأمر</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
      : '<div class="empty">لم تُحفظ أي مراسلة بعد.</div>'}
    <p class="hint">${storageNote()}</p>
  `);

  app.querySelectorAll('[data-dlt]').forEach(b => b.addEventListener('click', () => {
    const L = findLetter(b.dataset.dlt);
    if (!L || !confirm('حذف رسالة «' + letterLabel(L.type) + '» لـ' + L.studentName + ' نهائياً؟')) return;
    R.letters = R.letters.filter(x => x.id !== L.id);
    save();
    toast('حُذفت الرسالة');
    viewLetters();
  }));
}

/** نموذج التعبئة ومعاينة حيّة للورقة كما ستُطبع. */
function viewLetterForm(letterId, type) {
  const R = DB.roster;
  if (!R.students.length) {
    return render(`<div class="empty">لا توجد بطاقات في ملف الصف بعد.<br><br>
      <a class="btn" href="#/profile">ملف الصف</a></div>`);
  }

  const saved = letterId ? findLetter(letterId) : null;
  if (letterId && !saved) return notFound('المستند');
  if (!saved && !LETTER_TYPES[type]) return notFound('نوع المراسلة');

  const first = R.students[0];
  const L = saved ? Object.assign({}, saved) : {
    type, studentId: first.id, studentName: first.name, gender: '',
    date: todayISO(), guardian: first.father || first.mother || '', grade: R.name,
    period: '', note: '', teacher: R.letterTeacher || '', mentor: first.mentors || '',
    principal: R.letterPrincipal || 'علي موسى', absFrom: '', absTo: '',
    leftDate: todayISO(), lesson: '', subject: '', subjTeacher: '',
    warnDate: todayISO(), warnLevel: '', reasons: [], other1: '', other2: '',
    meetDate: '', meetTime: '', meetWith: '', topics: [], topicOther: '',
    directives: '', susFrom: '', susTo: '', returnDate: '',
    outDate: todayISO(), outReasons: [], booksCount: '', hwCount: '', absDays: '',
  };
  const T = LETTER_TYPES[L.type] || LETTER_TYPES.late;

  const studentOpts = R.students.map(st =>
    `<option value="${esc(st.id)}"${st.id === L.studentId ? ' selected' : ''}>${esc(st.name)}</option>`).join('');
  const genderOpts = Object.keys(GENDERS).map(k =>
    `<option value="${k}"${k === L.gender ? ' selected' : ''}>${GENDERS[k]}</option>`).join('');

  const inp = (key, label, ph, wide) => `<div class="field${wide ? ' wide' : ''}">
      <label for="l_${key}">${label}</label>
      <input type="text" id="l_${key}" name="${key}" value="${esc(L[key] || '')}"
             placeholder="${ph || ''}"></div>`;

  render(`
    <div class="crumb no-print"><a href="#/">الرئيسية</a> ←
      <a href="#/profile">ملف الصف</a> ←
      <a href="#/profile/letters">مراسلات مع الأهل</a> ← ${esc(letterLabel(L.type))}</div>

    <div class="page-head no-print">
      <div>
        <h1>${esc(letterLabel(L.type))}</h1>
        <p class="sub">${saved ? 'مستند محفوظ · ' + esc(L.studentName) : 'نموذج جديد'} · ${esc(R.name)}</p>
      </div>
      <div class="actions">
        <a class="btn ghost" href="#/profile/letters">كل المراسلات</a>
      </div>
    </div>

    <div class="lt-wrap">
      <form id="ltForm" class="card no-print">
        <div class="cardgrid">
          <div class="field wide">
            <label for="l_student">الطالب</label>
            <select id="l_student" name="studentId">${studentOpts}</select>
          </div>
          <div class="field">
            <label for="l_gender">صيغة المخاطبة</label>
            <select id="l_gender" name="gender">${genderOpts}</select>
          </div>
          <div class="field">
            <label for="l_date">التاريخ</label>
            <input type="date" id="l_date" name="date" value="${esc(L.date)}" required>
          </div>
          ${inp('guardian', 'السيد/ة (ولي الأمر)', 'اسم ولي الأمر', true)}
          ${inp('grade', 'الصف', '')}
          ${T.absence ? `<div class="field">
              <label for="l_absFrom">تغيّب من تاريخ</label>
              <input type="date" id="l_absFrom" name="absFrom" value="${esc(L.absFrom || '')}"></div>
            <div class="field">
              <label for="l_absTo">واستمر حتى تاريخ</label>
              <input type="date" id="l_absTo" name="absTo" value="${esc(L.absTo || '')}"></div>` : ''}
          ${T.leave ? `<div class="field">
              <label for="l_leftDate">ترك المدرسة يوم</label>
              <input type="date" id="l_leftDate" name="leftDate" value="${esc(L.leftDate || '')}"></div>
            ${inp('lesson', 'الحصة', 'مثلاً: الثالثة')}
            ${inp('subject', 'في موضوع', 'مثلاً: الرياضيات')}` : ''}
          ${T.warn ? `<div class="field">
              <label for="l_warnDate">تقرر اليوم</label>
              <input type="date" id="l_warnDate" name="warnDate" value="${esc(L.warnDate || '')}"></div>
            <div class="field">
              <label for="l_warnLevel">توجيه إنذار</label>
              <input type="text" id="l_warnLevel" name="warnLevel" list="warnLevels"
                     value="${esc(L.warnLevel || '')}" placeholder="أول، ثانٍ، نهائي…">
              <datalist id="warnLevels"><option value="أول"><option value="ثانٍ">
                <option value="ثالث"><option value="نهائي"></datalist></div>
            <div class="field wide">
              <label>بسبب</label>
              ${WARN_REASONS.map((r, i) => `<label class="lt-check">
                <input type="checkbox" name="reasons" value="${i}"${
                  (L.reasons || []).indexOf(String(i)) !== -1 ? ' checked' : ''}> ${r(L.gender)}</label>`).join('')}
              <input type="text" name="other1" value="${esc(L.other1 || '')}" placeholder="سبب آخر (اختياري)"
                     style="margin-top:6px">
              <input type="text" name="other2" value="${esc(L.other2 || '')}" placeholder="سبب آخر (اختياري)"
                     style="margin-top:6px">
            </div>` : ''}
          ${T.meet ? `<div class="field">
              <label for="l_meetDate">موعد الحضور</label>
              <input type="date" id="l_meetDate" name="meetDate" value="${esc(L.meetDate || '')}"></div>
            <div class="field">
              <label for="l_meetTime">في تمام الساعة</label>
              <input type="time" id="l_meetTime" name="meetTime" value="${esc(L.meetTime || '')}"></div>
            ${inp('meetWith', 'لمقابلة ضرورية مع', 'مثلاً: مربي الصف، المستشارة', true)}
            <div class="field wide">
              <label>للتباحث حول</label>
              <label class="lt-check"><input type="checkbox" name="topics" value="behavior"${
                (L.topics || []).indexOf('behavior') !== -1 ? ' checked' : ''}> أ) سلوكيات الطالب</label>
              <label class="lt-check"><input type="checkbox" name="topics" value="study"${
                (L.topics || []).indexOf('study') !== -1 ? ' checked' : ''}> ب) تحصيله الدراسي</label>
              <input type="text" name="topicOther" value="${esc(L.topicOther || '')}"
                     placeholder="ج) آخر (اختياري)" style="margin-top:6px">
            </div>` : ''}
          ${T.susp ? `${inp('directives', 'وعدم انصياعه لتوجيهات', 'مثلاً: المعلمين وإدارة المدرسة', true)}
            <div class="field">
              <label for="l_susFrom">الفصل ابتداءً من</label>
              <input type="date" id="l_susFrom" name="susFrom" value="${esc(L.susFrom || '')}"></div>
            <div class="field">
              <label for="l_susTo">وحتى</label>
              <input type="date" id="l_susTo" name="susTo" value="${esc(L.susTo || '')}"></div>
            <div class="field wide">
              <label for="l_returnDate">حضور ولي الأمر شخصياً يوم</label>
              <input type="date" id="l_returnDate" name="returnDate" value="${esc(L.returnDate || '')}"></div>` : ''}
          ${T.out ? `<div class="field">
              <label for="l_outDate">أُخرج اليوم</label>
              <input type="date" id="l_outDate" name="outDate" value="${esc(L.outDate || '')}"></div>
            ${inp('lesson', 'خلال الحصة', 'مثلاً: الثانية')}
            ${inp('subjTeacher', 'في درس المعلم/ـة', 'اسم المعلم', true)}
            <div class="field wide">
              <label>بسبب</label>
              ${[['disrupt', 'عرقلة سير الدرس'], ['books', 'حضر بدون كتب أو دفاتر'],
                 ['hw', 'حضر بدون تحضير وظائفه البيتية'], ['behave', 'تصرّف تصرفاً غير لائق أثناء الدرس']]
                .map(([k, t]) => `<div class="lt-check">
                  <label class="lt-check" style="margin:0"><input type="checkbox" name="outReasons" value="${k}"${
                    (L.outReasons || []).indexOf(k) !== -1 ? ' checked' : ''}> ${t}</label>
                  ${k === 'books' || k === 'hw' ? `<input type="text" name="${k === 'books' ? 'booksCount' : 'hwCount'}"
                    value="${esc(L[k === 'books' ? 'booksCount' : 'hwCount'] || '')}" placeholder="للمرة…"
                    style="width:90px;padding:4px 8px">` : ''}</div>`).join('')}
            </div>` : ''}
          ${T.pledge ? `<div class="field wide">
              <label>السلوك المبيّن</label>
              ${PLEDGE_REASONS.map((r, i) => `<label class="lt-check">
                <input type="checkbox" name="reasons" value="${i}"${
                  (L.reasons || []).indexOf(String(i)) !== -1 ? ' checked' : ''}> ${r}</label>`).join('')}
              <input type="text" name="other1" value="${esc(L.other1 || '')}" placeholder="سلوك آخر (اختياري)"
                     style="margin-top:6px">
              <input type="text" name="other2" value="${esc(L.other2 || '')}" placeholder="سلوك آخر (اختياري)"
                     style="margin-top:6px">
            </div>` : ''}
          ${T.absRate ? inp('absDays', 'تكررت الغيابات بمعدل (أيام)', 'مثلاً: 5') : ''}
          ${T.noPeriod ? '' : inp('period', T.absRate ? 'خلال' : 'تكررت التأخرات خلال',
                                  'مثلاً: الأسبوعين الأخيرين')}
          <div class="field wide">
            <label for="l_note">ملاحظة</label>
            <textarea id="l_note" name="note" style="min-height:70px"
              placeholder="اختياري — مثلاً: عدد مرات التأخر وتواريخها">${esc(L.note || '')}</textarea>
            ${T.noNote ? '<p class="hint">تظهر في الورقة فقط إن كتبت فيها شيئاً.</p>' : ''}
          </div>
          ${T.signer === 'principal' ? inp('principal', 'مدير المدرسة', 'اسم المدير')
            : T.signer === 'mentor' ? ''
            : inp('teacher', T.teacherLabel || 'الأستاذ/المعلمة', 'اسم المعلم')}
          ${inp('mentor', 'مربي/ة الصف', '')}
          ${T.subjTeacher && !T.out ? inp('subjTeacher', T.subjLabel || 'معلم الموضوع', '') : ''}
        </div>
        <p class="hint">اسم ولي الأمر ومربّي الصف يُملآن من بطاقة الطالب، ويمكن تعديلهما.
          «حفظ PDF» من نافذة الطباعة يحفظ المستند ملفاً على جهازك.</p>
        <div class="actions">
          <button class="btn" type="submit">حفظ</button>
          <button class="btn" type="button" id="ltSavePrint">حفظ وطباعة</button>
          <button class="btn ghost" type="button" id="ltPrint">طباعة فقط</button>
          ${saved ? '<button class="btn ghost danger-link" type="button" id="ltDel">حذف</button>' : ''}
        </div>
      </form>

      <div class="lt-preview">
        <div class="hint no-print">معاينة الورقة كما ستُطبع</div>
        <article class="lt-sheet" id="ltSheet">${letterSheet(L)}</article>
      </div>
    </div>
  `);

  const form = document.getElementById('ltForm');
  const sheet = document.getElementById('ltSheet');

  /** يقرأ النموذج إلى L ثم يعيد رسم المعاينة. */
  const read = () => {
    const fd = new FormData(form);
    ['studentId', 'gender', 'date', 'guardian', 'grade', 'period', 'teacher', 'mentor', 'principal', 'absFrom', 'absTo',
      'leftDate', 'lesson', 'subject', 'subjTeacher',
      'warnDate', 'warnLevel', 'other1', 'other2', 'meetDate', 'meetTime', 'meetWith', 'topicOther',
      'directives', 'susFrom', 'susTo', 'returnDate', 'outDate', 'booksCount', 'hwCount', 'absDays']
      .forEach(k => { if (fd.has(k)) L[k] = String(fd.get(k) || '').replace(/\s+/g, ' ').trim(); });
    L.note = String(fd.get('note') || '').trim();
    if (T.warn || T.pledge) L.reasons = fd.getAll('reasons').map(String);
    if (T.meet) L.topics = fd.getAll('topics').map(String);
    if (T.out) L.outReasons = fd.getAll('outReasons').map(String);
    const st = R.students.find(x => x.id === L.studentId);
    if (st) L.studentName = st.name;
    sheet.innerHTML = letterSheet(L);
  };
  form.addEventListener('input', read);

  // تغيير الطالب يجلب ولي أمره ومربّيه من بطاقته
  document.getElementById('l_student').addEventListener('change', e => {
    const st = R.students.find(x => x.id === e.target.value);
    if (!st) return;
    form.guardian.value = st.father || st.mother || '';
    form.mentor.value = st.mentors || '';
    read();
  });

  const store = () => {
    read();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(L.date)) { alert('اختر تاريخاً صحيحاً.'); return false; }
    if (!L.studentName) { alert('اختر الطالب.'); return false; }
    if (L.susFrom && L.susTo && L.susTo < L.susFrom) {
      alert('تاريخ «وحتى» يسبق تاريخ بداية الفصل.');
      return false;
    }
    if (L.absFrom && L.absTo && L.absTo < L.absFrom) {
      alert('تاريخ «حتى» يسبق تاريخ بداية التغيّب.');
      return false;
    }
    const now = new Date().toISOString();
    if (saved) {
      Object.assign(saved, L, { updatedAt: now });
    } else {
      L.id = uid();
      L.createdAt = now;
      R.letters.push(L);
    }
    if (L.teacher) R.letterTeacher = L.teacher;
    if (L.principal) R.letterPrincipal = L.principal;
    save();
    toast('حُفظ المستند');
    return true;
  };

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (store()) go('/profile/letter/' + (saved ? saved.id : L.id));
  });

  document.getElementById('ltSavePrint').addEventListener('click', () => {
    if (!store()) return;
    if (!saved) history.replaceState(null, '', '#/profile/letter/' + L.id);
    window.print();
    if (!saved) viewLetterForm(L.id, '');
  });

  document.getElementById('ltPrint').addEventListener('click', () => { read(); window.print(); });

  const del = document.getElementById('ltDel');
  if (del) del.addEventListener('click', () => {
    if (!confirm('حذف هذا المستند نهائياً؟')) return;
    R.letters = R.letters.filter(x => x.id !== saved.id);
    save();
    toast('حُذف المستند');
    go('/profile/letters');
  });
}

/* ---------------------- النسخ الاحتياطي ---------------------- */

function viewBackup() {
  const size = (localStorage.getItem(STORE_KEY) || '').length;
  const sessions = DB.classes.reduce((n, c) => n + c.sessions.length, 0);
  const students = DB.classes.reduce((n, c) => n + c.students.length, 0);

  const remote = REMOTE.mode === 'remote';
  const lastSync = REMOTE.updatedAt
    ? new Date(REMOTE.updatedAt).toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

  render(`
    <h1>التخزين والنسخ الاحتياطي</h1>
    <p class="sub">${remote
      ? 'البيانات محفوظة على خادم الموقع وتظهر على أي جهاز يفتح الرابط.'
      : 'لا يوجد خادم متاح — البيانات محفوظة في متصفح هذا الجهاز فقط.'}</p>

    <div class="card">
      <h2>حالة التخزين</h2>
      <div class="grid g2">
        <div><label>الوضع</label>
          <div>${remote ? '☁️ على خادم الموقع (Netlify Blobs)' : '💾 محلي في هذا المتصفح'}</div></div>
        <div><label>آخر حفظ على الخادم</label><div>${esc(lastSync)}</div></div>
      </div>
      ${remote ? `<div class="actions" style="margin-top:16px">
        <button class="btn ghost" id="syncNow">مزامنة الآن</button>
        ${REMOTE.protected ? '<button class="btn ghost" id="logout">تسجيل الخروج</button>' : ''}
      </div>` : `<div class="hint" style="margin-top:12px">
        لتفعيل الحفظ على الخادم، انشر الموقع على Netlify مع مجلد <code>netlify/functions</code>.
      </div>`}
    </div>

    <div class="grid g3" style="margin-bottom:22px">
      <div class="stat"><b>${DB.classes.length}</b><span>صف</span></div>
      <div class="stat"><b>${students}</b><span>طالب</span></div>
      <div class="stat"><b>${sessions}</b><span>حصة</span></div>
      <div class="stat"><b>${(size / 1024).toFixed(1)}</b><span>كيلوبايت مستخدمة</span></div>
    </div>

    <div class="card">
      <h2>تصدير</h2>
      <p class="hint" style="margin-top:0">يُنزّل ملف JSON يحتوي كل الصفوف والطلاب والحصص.</p>
      <button class="btn" id="expAll">تنزيل نسخة احتياطية</button>
    </div>

    <div class="card">
      <h2>استيراد</h2>
      <div class="field">
        <label>اختر ملف النسخة الاحتياطية (JSON)</label>
        <input type="file" id="impFile" accept=".json,application/json">
      </div>
      <div class="actions">
        <button class="btn ghost" id="impMerge">دمج مع البيانات الحالية</button>
        <button class="btn danger" id="impReplace">استبدال كل البيانات</button>
      </div>
    </div>

    <div class="card">
      <h2>مسح كامل</h2>
      <p class="hint" style="margin-top:0">يحذف جميع الصفوف والطلاب والحصص
        ${remote ? 'من الخادم ومن كل الأجهزة' : 'من هذا المتصفح'} نهائياً.</p>
      <button class="btn danger" id="wipe">مسح كل البيانات</button>
    </div>
  `);

  const syncBtn = document.getElementById('syncNow');
  if (syncBtn) syncBtn.addEventListener('click', async () => {
    await pull();
    toast('تمت المزامنة');
    viewBackup();
  });

  const outBtn = document.getElementById('logout');
  if (outBtn) outBtn.addEventListener('click', () => {
    localStorage.removeItem(KEY_STORE);
    localStorage.removeItem(STORE_KEY);
    REMOTE.key = '';
    DB = { classes: [] };
    setStatus('locked');
    router();
  });

  document.getElementById('expAll').addEventListener('click', () => {
    download('نسخة-سجل-الصف-' + todayISO() + '.json', JSON.stringify(DB, null, 2), false);
    toast('تم تنزيل النسخة الاحتياطية');
  });

  const readFile = cb => {
    const f = document.getElementById('impFile').files[0];
    if (!f) { toast('اختر ملفاً أولاً'); return; }
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data || !Array.isArray(data.classes)) throw new Error('bad');
        cb(data);
      } catch (e) {
        alert('الملف غير صالح أو تالف.');
      }
    };
    r.readAsText(f, 'UTF-8');
  };

  document.getElementById('impMerge').addEventListener('click', () => readFile(data => {
    const existing = new Set(DB.classes.map(c => c.id));
    const added = data.classes.filter(c => !existing.has(c.id));
    DB.classes = DB.classes.concat(added);
    save();
    toast('تمت إضافة ' + added.length + ' صف');
    viewBackup();
  }));

  document.getElementById('impReplace').addEventListener('click', () => readFile(data => {
    if (!confirm('سيتم استبدال كل البيانات الحالية. متابعة؟')) return;
    DB = data;
    save();
    toast('تم الاستيراد');
    viewBackup();
  }));

  document.getElementById('wipe').addEventListener('click', () => {
    if (!confirm('حذف كل البيانات نهائياً من هذا المتصفح؟')) return;
    if (!confirm('تأكيد أخير: لا يمكن التراجع عن هذه العملية.')) return;
    DB = { classes: [] };
    save();
    toast('تم مسح البيانات');
    go('/');
  });
}

/* ---------------------- الإقلاع ---------------------- */

async function boot() {
  loadSession();
  paintSession();
  load();                       // عرض فوري من الذاكرة المحلية
  document.getElementById('todayBadge').textContent = fmtDate(todayISO()) + ' — ' + nowTime();
  window.addEventListener('hashchange', router);
  document.getElementById('logoutBtn').addEventListener('click', e => {
    e.preventDefault();
    if (confirm('تسجيل الخروج من الموقع؟')) endSession();
  });
  router();

  if (await detectServer()) {
    await pull();
    router();                   // إعادة الرسم ببيانات الخادم
  } else {
    setStatus('local');
  }

  // تحذير عند الإغلاق قبل اكتمال الحفظ على الخادم
  window.addEventListener('beforeunload', e => {
    if (REMOTE.mode === 'remote' && (REMOTE.status === 'syncing' || REMOTE.status === 'offline')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

boot();
