/**
 * تخزين بيانات سجل الصف على الخادم (Netlify Blobs).
 *
 *   GET  /api/ping   → هل الخادم متاح؟ وهل هو محمي بكلمة مرور؟
 *   GET  /api/data   → جلب كل البيانات
 *   PUT  /api/data   → حفظ كل البيانات
 *
 * كلمة المرور تُضبط من لوحة Netlify كمتغيّر بيئة باسم APP_PASSWORD.
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'sijil';
const KEY = 'db';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

/**
 * فك ترميز المفتاح القادم في الترويسة.
 * الترويسات لا تقبل إلا محارف ASCII، لذا يرسله المتصفح بترميز base64
 * حتى تعمل كلمات المرور العربية.
 */
function decodeKey(raw) {
  if (!raw) return '';
  try {
    const bin = atob(raw);
    const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    return '';
  }
}

/** مقارنة لا يتسرّب منها طول التطابق. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async (req) => {
  const url = new URL(req.url);
  const password = (process.env.APP_PASSWORD || '').trim();

  // فحص التوفّر — بدون مصادقة، ولا يكشف أي بيانات
  if (url.pathname.endsWith('/ping')) {
    return json({ ok: true, server: true, protected: password !== '' });
  }

  if (password && !sameSecret(decodeKey(req.headers.get('x-app-key')), password)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let store;
  try {
    store = getStore({ name: STORE_NAME, consistency: 'strong' });
  } catch (e) {
    return json({ ok: false, error: 'storage_unavailable' }, 500);
  }

  if (req.method === 'GET') {
    const saved = await store.get(KEY, { type: 'json' });
    return json({
      ok: true,
      data: saved && saved.data ? saved.data : null,
      updatedAt: saved ? saved.updatedAt : null,
    });
  }

  if (req.method === 'PUT') {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return json({ ok: false, error: 'invalid_json' }, 400);
    }

    const data = body && body.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.classes)) {
      return json({ ok: false, error: 'invalid_payload' }, 400);
    }

    // منع الكتابة فوق تعديل جاء من جهاز آخر
    const current = await store.get(KEY, { type: 'json' });
    const currentAt = current ? current.updatedAt : null;
    if (!body.force && currentAt && body.baseUpdatedAt !== currentAt) {
      return json({ ok: false, error: 'conflict', updatedAt: currentAt }, 409);
    }

    const record = { data, updatedAt: new Date().toISOString() };
    await store.setJSON(KEY, record);
    return json({ ok: true, updatedAt: record.updatedAt });
  }

  return json({ ok: false, error: 'method_not_allowed' }, 405);
};

export const config = { path: ['/api/data', '/api/ping'] };
