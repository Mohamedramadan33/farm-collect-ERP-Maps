import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';

const PORT = 3000;
const ERPNEXT_URL = (process.env.ERPNEXT_URL || 'https://erp-sys.sekem.com').replace(/\/+$/, '');
const CACHE_FILE = path.resolve(process.cwd(), 'geocode_cache.json');
const DIST_DIR = path.resolve(process.cwd(), 'dist');

interface ErpSession {
  sid: string;
  userId: string;
  fullName: string;
  createdAt: number;
}

interface MarkazEntry {
  governorate: string;
  markaz: string;
  village: string;
}

const sessionStore = new Map<string, ErpSession>();

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      result[key] = decodeURIComponent(val);
    }
  }
  return result;
}

function getSessionFromRequest(req: Request): { token: string; session: ErpSession } | null {
  const headerToken = req.header('x-erp-session');
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies.fm_erp_session;
  const token = headerToken || cookieToken;
  if (!token) return null;
  const session = sessionStore.get(token);
  if (!session) return null;
  return { token, session };
}

function extractSidFromSetCookies(setCookies: string[]): string | null {
  for (const raw of setCookies) {
    const firstPart = raw.split(';')[0]?.trim();
    if (!firstPart) continue;
    if (firstPart.startsWith('sid=')) {
      const value = firstPart.slice(4);
      if (value && value !== 'Guest') {
        return value;
      }
    }
  }
  return null;
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const isHttps = req.secure || req.header('x-forwarded-proto') === 'https';
  const parts = [
    `fm_erp_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Max-Age=28800',
    isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax',
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = req.secure || req.header('x-forwarded-proto') === 'https';
  const parts = [
    'fm_erp_session=',
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax',
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function readGeocodeCache(): Record<string, MarkazEntry> {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
    const normalized: Record<string, MarkazEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== 'object') continue;
      normalized[k] = {
        governorate: v.governorate || v['المحافظة'] || 'غير محدد',
        markaz: v.markaz || v['المركز'] || 'غير محدد',
        village: v.village || v['القرية_المنطقة'] || 'غير محدد',
      };
    }
    return normalized;
  } catch {
    return {};
  }
}

function writeGeocodeCache(cache: Record<string, MarkazEntry>): void {
  const serializable: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(cache)) {
    serializable[k] = {
      المحافظة: v.governorate,
      المركز: v.markaz,
      القرية_المنطقة: v.village,
    };
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(serializable, null, 2), 'utf-8');
}

function buildErpHeaders(session: ErpSession | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const apiKey = process.env.ERPNEXT_API_KEY;
  const apiSecret = process.env.ERPNEXT_API_SECRET;
  if (session?.sid) {
    headers.Cookie = `sid=${session.sid}`;
  } else if (apiKey && apiSecret) {
    headers.Authorization = `token ${apiKey}:${apiSecret}`;
  }
  return headers;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectLatLonFromRecord(record: Record<string, unknown>): { lat: number | null; lon: number | null } {
  const keys = Object.keys(record);
  const latKey =
    keys.find((k) => /^(lat|latitude)$/i.test(k.trim())) ||
    keys.find((k) => /latitude|\blat\b/i.test(k));
  const lonKey =
    keys.find((k) => /^(lng|long|lon|longitude)$/i.test(k.trim())) ||
    keys.find((k) => /longitude|\b(lng|long|lon)\b/i.test(k));

  const rawLat = latKey ? Number(record[latKey]) : NaN;
  const rawLon = lonKey ? Number(record[lonKey]) : NaN;

  let validLat = Number.isFinite(rawLat) && rawLat !== 0 && rawLat >= -90 && rawLat <= 90 ? rawLat : null;
  let validLon = Number.isFinite(rawLon) && rawLon !== 0 && rawLon >= -180 && rawLon <= 180 ? rawLon : null;

  // Fallback for Frappe Geolocation fields storing GeoJSON strings
  if (validLat === null || validLon === null) {
    for (const val of Object.values(record)) {
      if (typeof val === 'string' && val.includes('"coordinates"') && val.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(val) as {
            features?: { geometry?: { type?: string; coordinates?: unknown } }[];
            geometry?: { type?: string; coordinates?: unknown };
          };
          const geom = parsed.features?.[0]?.geometry || parsed.geometry;
          if (geom?.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
            const lon = Number(geom.coordinates[0]);
            const lat = Number(geom.coordinates[1]);
            if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) {
              validLat = lat;
              validLon = lon;
              break;
            }
          } else if (
            geom?.type === 'Polygon' &&
            Array.isArray(geom.coordinates) &&
            Array.isArray(geom.coordinates[0]) &&
            Array.isArray(geom.coordinates[0][0])
          ) {
            const ring = geom.coordinates[0] as number[][];
            const avgLon = ring.reduce((sum, pt) => sum + Number(pt[0] || 0), 0) / ring.length;
            const avgLat = ring.reduce((sum, pt) => sum + Number(pt[1] || 0), 0) / ring.length;
            if (Number.isFinite(avgLat) && Number.isFinite(avgLon) && avgLat !== 0 && avgLon !== 0) {
              validLat = avgLat;
              validLon = avgLon;
              break;
            }
          }
        } catch {
          // Ignore malformed JSON strings
        }
      }
    }
  }

  return { lat: validLat, lon: validLon };
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/erp/session', async (req: Request, res: Response) => {
    const found = getSessionFromRequest(req);
    const hasEnvToken = Boolean(process.env.ERPNEXT_API_KEY && process.env.ERPNEXT_API_SECRET);

    if (!found && !hasEnvToken) {
      res.json({ connected: false, erpUrl: ERPNEXT_URL });
      return;
    }

    try {
      const response = await fetch(`${ERPNEXT_URL}/api/method/frappe.auth.get_logged_user`, {
        headers: buildErpHeaders(found?.session ?? null),
      });

      if (!response.ok) {
        if (found) sessionStore.delete(found.token);
        res.json({ connected: false, erpUrl: ERPNEXT_URL });
        return;
      }

      const payload = (await response.json()) as { message?: string };
      const user = payload.message;
      if (!user || user === 'Guest') {
        if (found) sessionStore.delete(found.token);
        res.json({ connected: false, erpUrl: ERPNEXT_URL });
        return;
      }

      res.json({
        connected: true,
        erpUrl: ERPNEXT_URL,
        userId: user,
        fullName: found?.session.fullName || user,
      });
    } catch {
      res.json({ connected: false, erpUrl: ERPNEXT_URL });
    }
  });

  app.post('/api/erp/login', async (req: Request, res: Response) => {
    const { usr, pwd } = (req.body || {}) as { usr?: string; pwd?: string };
    if (!usr?.trim() || !pwd) {
      res.status(400).json({ error: 'Please enter both your ERPNext username/email and password.' });
      return;
    }

    try {
      const loginResp = await fetch(`${ERPNEXT_URL}/api/method/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ usr: usr.trim(), pwd }),
      });

      const loginData = (await loginResp.json().catch(() => ({}))) as {
        message?: string;
        full_name?: string;
        exc_type?: string;
        verification?: { prompt?: string };
      };

      if (!loginResp.ok) {
        const message =
          loginData.message ||
          (loginResp.status === 401 ? 'Invalid ERPNext username or password.' : `ERPNext login failed (${loginResp.status}).`);
        res.status(401).json({ error: message });
        return;
      }

      if (loginData.verification) {
        res.status(403).json({
          error: loginData.verification.prompt || 'Two-factor verification is enabled on this ERPNext account.',
        });
        return;
      }

      const setCookies =
        typeof loginResp.headers.getSetCookie === 'function' ? loginResp.headers.getSetCookie() : [];
      const sid = extractSidFromSetCookies(setCookies);

      if (!sid) {
        res.status(401).json({ error: 'ERPNext did not issue a valid session cookie.' });
        return;
      }

      const userResp = await fetch(`${ERPNEXT_URL}/api/method/frappe.auth.get_logged_user`, {
        headers: { Cookie: `sid=${sid}`, Accept: 'application/json' },
      });
      const userJson = (await userResp.json().catch(() => ({}))) as { message?: string };
      const userId = userJson.message || usr.trim();
      const fullName = loginData.full_name || userId;

      const token = crypto.randomUUID();
      sessionStore.set(token, {
        sid,
        userId,
        fullName,
        createdAt: Date.now(),
      });

      setSessionCookie(req, res, token);
      res.json({
        connected: true,
        erpUrl: ERPNEXT_URL,
        userId,
        fullName,
        sessionToken: token,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unable to reach ERPNext server.';
      res.status(502).json({ error: `Connection to ${ERPNEXT_URL} failed: ${msg}` });
    }
  });

  app.post('/api/erp/logout', async (req: Request, res: Response) => {
    const found = getSessionFromRequest(req);
    if (found) {
      try {
        await fetch(`${ERPNEXT_URL}/api/method/logout`, {
          method: 'POST',
          headers: { Cookie: `sid=${found.session.sid}` },
        });
      } catch {
        // Ignore remote logout errors when clearing local session
      }
      sessionStore.delete(found.token);
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.get('/api/erp/farms', async (req: Request, res: Response) => {
    const found = getSessionFromRequest(req);
    const hasEnvToken = Boolean(process.env.ERPNEXT_API_KEY && process.env.ERPNEXT_API_SECRET);

    if (!found && !hasEnvToken) {
      res.status(401).json({ error: 'Not logged into ERPNext. Please sign in first.' });
      return;
    }

    const fromDate = typeof req.query.fromDate === 'string' ? req.query.fromDate.trim() : '';
    const toDate = typeof req.query.toDate === 'string' ? req.query.toDate.trim() : '';
    const excludeCancelled = req.query.excludeCancelled === 'true';
    const farmType = typeof req.query.type === 'string' ? req.query.type.trim() : '';

    const filters: unknown[][] = [];
    if (fromDate && toDate) {
      filters.push(['Farm', 'creation', 'Between', [fromDate, toDate]]);
    } else if (fromDate) {
      filters.push(['Farm', 'creation', '>=', fromDate]);
    } else if (toDate) {
      filters.push(['Farm', 'creation', '<=', toDate]);
    }
    if (excludeCancelled) {
      filters.push(['Farm', 'farm_status', '!=', 'Cancelled']);
    }
    if (farmType) {
      filters.push(['Farm', 'type', '=', farmType]);
    }

    const headers = buildErpHeaders(found?.session ?? null);

    try {
      const pageSize = 500;
      const rawRows: Record<string, unknown>[] = [];
      const seenNames = new Set<string>();
      let limitStart = 0;
      let activeFilters = filters;

      while (limitStart < 25000) {
        const params = new URLSearchParams({
          fields: JSON.stringify(['*']),
          limit_page_length: String(pageSize),
          limit_start: String(limitStart),
          order_by: 'creation desc',
        });
        if (activeFilters.length > 0) {
          params.set('filters', JSON.stringify(activeFilters));
        }

        let resourceResp = await fetch(`${ERPNEXT_URL}/api/resource/Farm?${params.toString()}`, { headers });

        // Fallback if filtered fields differ on this ERPNext Farm DocType
        if ((resourceResp.status === 417 || resourceResp.status === 400) && activeFilters.length > 0) {
          activeFilters = [];
          const fallbackParams = new URLSearchParams({
            fields: JSON.stringify(['*']),
            limit_page_length: String(pageSize),
            limit_start: String(limitStart),
            order_by: 'creation desc',
          });
          resourceResp = await fetch(`${ERPNEXT_URL}/api/resource/Farm?${fallbackParams.toString()}`, { headers });
        }

        if (resourceResp.status === 401 || resourceResp.status === 403) {
          res.status(401).json({ error: 'ERPNext session expired or lacks permission to read Farm records.' });
          return;
        }

        if (!resourceResp.ok) {
          const errText = await resourceResp.text();
          res.status(resourceResp.status).json({
            error: `ERPNext returned status ${resourceResp.status}: ${errText.slice(0, 220)}`,
          });
          return;
        }

        const payload = (await resourceResp.json()) as { data?: Record<string, unknown>[] };
        const pageRows = Array.isArray(payload.data) ? payload.data : [];
        if (pageRows.length === 0) break;

        let addedInPage = 0;
        for (const row of pageRows) {
          const rowId = String(row.name || `${limitStart}_${addedInPage}`);
          if (!seenNames.has(rowId)) {
            seenNames.add(rowId);
            rawRows.push(row);
            addedInPage += 1;
          }
        }

        if (pageRows.length < pageSize || addedInPage === 0) {
          break;
        }
        limitStart += pageSize;
      }

      const cache = readGeocodeCache();

      const farms = rawRows.map((row) => {
        const { lat, lon } = detectLatLonFromRecord(row);
        const cacheKey = lat !== null && lon !== null ? `${Number(lat.toFixed(3))}_${Number(lon.toFixed(3))}` : null;
        const cachedGeo = cacheKey ? cache[cacheKey] : undefined;

        const nameVal =
          row.farm_name ||
          row.title ||
          row.farm ||
          row.name ||
          'Unnamed Farm';

        const statusVal = row.farm_status || row.status || row.workflow_state || 'Active';
        const areaRaw = row.area ?? row.total_area ?? row.farm_area ?? row.area_in_feddans ?? null;
        const areaVal = areaRaw !== null && areaRaw !== undefined && Number.isFinite(Number(areaRaw))
          ? Number(areaRaw)
          : null;

        const rawScalars: Record<string, string | number | boolean | null> = {};
        for (const [k, v] of Object.entries(row)) {
          if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            rawScalars[k] = v;
          }
        }

        return {
          id: String(row.name || ''),
          name: String(nameVal),
          type: String(row.type || row.farm_type || ''),
          status: String(statusVal),
          creation: String(row.creation || '').slice(0, 10),
          area: areaVal,
          lat,
          lon,
          cacheKey,
          governorate: cachedGeo?.governorate ?? null,
          markaz: cachedGeo?.markaz ?? null,
          village: cachedGeo?.village ?? null,
          raw: rawScalars,
        };
      });

      res.json({
        farms,
        total: farms.length,
        withCoordinates: farms.filter((f) => f.lat !== null && f.lon !== null).length,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to fetch farms from ERPNext.';
      res.status(502).json({ error: msg });
    }
  });

  app.get('/api/erp/farms/:id', async (req: Request, res: Response) => {
    const found = getSessionFromRequest(req);
    const hasEnvToken = Boolean(process.env.ERPNEXT_API_KEY && process.env.ERPNEXT_API_SECRET);

    if (!found && !hasEnvToken) {
      res.status(401).json({ error: 'Not logged into ERPNext. Please sign in first.' });
      return;
    }

    const farmId = req.params.id;
    if (!farmId) {
      res.status(400).json({ error: 'Missing farm ID.' });
      return;
    }

    try {
      const resp = await fetch(`${ERPNEXT_URL}/api/resource/Farm/${encodeURIComponent(farmId)}`, {
        headers: buildErpHeaders(found?.session ?? null),
      });

      if (resp.status === 401 || resp.status === 403) {
        res.status(401).json({ error: 'ERPNext session expired or lacks permission.' });
        return;
      }

      if (!resp.ok) {
        const text = await resp.text();
        res.status(resp.status).json({ error: `ERPNext error (${resp.status}): ${text.slice(0, 200)}` });
        return;
      }

      const payload = (await resp.json()) as { data?: Record<string, unknown> };
      res.json({ farm: payload.data || {} });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to fetch farm details.';
      res.status(502).json({ error: msg });
    }
  });

  app.post('/api/erp/geocode-markaz', async (req: Request, res: Response) => {
    const { coordinates } = (req.body || {}) as { coordinates?: { lat: number; lon: number }[] };
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      res.status(400).json({ error: 'Provide an array of { lat, lon } coordinates.' });
      return;
    }

    const cache = readGeocodeCache();
    const resolved: Record<string, MarkazEntry> = {};
    let newLookups = 0;

    // Cap per request to keep UI responsive while persisting incremental progress
    const uniquePairs = new Map<string, { lat: number; lon: number }>();
    for (const item of coordinates) {
      if (
        typeof item?.lat === 'number' &&
        typeof item?.lon === 'number' &&
        Number.isFinite(item.lat) &&
        Number.isFinite(item.lon) &&
        item.lat !== 0 &&
        item.lon !== 0
      ) {
        const key = `${Number(item.lat.toFixed(3))}_${Number(item.lon.toFixed(3))}`;
        if (cache[key]) {
          resolved[key] = cache[key];
        } else if (!uniquePairs.has(key)) {
          uniquePairs.set(key, { lat: item.lat, lon: item.lon });
        }
      }
    }

    const maxBatch = 35;
    let processed = 0;
    for (const [key, pair] of uniquePairs.entries()) {
      if (processed >= maxBatch) break;
      if (processed > 0) {
        await delay(1100);
      }
      processed += 1;

      try {
        const url = new URL('https://nominatim.openstreetmap.org/reverse');
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('lat', String(pair.lat));
        url.searchParams.set('lon', String(pair.lon));
        url.searchParams.set('accept-language', 'ar');
        url.searchParams.set('addressdetails', '1');

        const geoResp = await fetch(url.toString(), {
          headers: { 'User-Agent': 'sekem_farm_mapper/1.0' },
        });
        if (geoResp.ok) {
          const geoJson = (await geoResp.json()) as { address?: Record<string, string> };
          const addr = geoJson.address || {};
          const entry: MarkazEntry = {
            governorate: addr.state || 'غير محدد',
            markaz: addr.county || addr.city_district || addr.town || 'غير محدد',
            village: addr.village || addr.suburb || 'غير محدد',
          };
          cache[key] = entry;
          resolved[key] = entry;
          newLookups += 1;
        }
      } catch {
        // Leave unresolved on transient network error
      }
    }

    if (newLookups > 0) {
      writeGeocodeCache(cache);
    }

    res.json({
      resolved,
      newLookups,
      remainingUncached: Math.max(0, uniquePairs.size - processed),
    });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
