import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response } from 'express';

const USER_DATA_DIR = process.env.USER_DATA_DIR || '';
const RESOURCES_PATH = process.env.RESOURCES_PATH || process.cwd();
const PORTABLE_DIR =
  process.env.PORTABLE_EXECUTABLE_DIR ||
  process.env.EXECUTABLE_DIR ||
  (process.env.ELECTRON_RUN_AS_NODE === '1' ? path.dirname(process.execPath) : process.cwd());

const envCandidates = [
  process.env.ENV_FILE_PATH,
  path.join(PORTABLE_DIR, '.env'),
  USER_DATA_DIR ? path.join(USER_DATA_DIR, '.env') : undefined,
  RESOURCES_PATH ? path.join(RESOURCES_PATH, '.env') : undefined,
  path.resolve(process.cwd(), '.env'),
].filter((p): p is string => Boolean(p));

const loadedEnvPaths: string[] = [];
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    loadedEnvPaths.push(envPath);
  }
}

const PORT = Number(process.env.PORT) || 3000;
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const ERPNEXT_URL = (process.env.ERPNEXT_URL || 'https://erp-sys.sekem.com').replace(/\/+$/, '');

const SEED_CACHE_CANDIDATES = [
  path.join(PORTABLE_DIR, 'geocode_cache.json'),
  path.join(RESOURCES_PATH, 'geocode_cache.json'),
  path.resolve(process.cwd(), 'geocode_cache.json'),
];
const CACHE_FILE = USER_DATA_DIR
  ? path.join(USER_DATA_DIR, 'geocode_cache.json')
  : path.resolve(process.cwd(), 'geocode_cache.json');

const PYTHON_SCRIPT_PATH = fs.existsSync(path.join(RESOURCES_PATH, 'farm_markaz_aggregator.py'))
  ? path.join(RESOURCES_PATH, 'farm_markaz_aggregator.py')
  : path.resolve(process.cwd(), 'farm_markaz_aggregator.py');

const DIST_DIR_CANDIDATES = [
  process.env.STATIC_DIST_DIR,
  path.resolve(process.cwd(), 'dist'),
  process.argv[1] ? path.resolve(path.dirname(process.argv[1]), '../dist') : undefined,
].filter((p): p is string => Boolean(p));
const DIST_DIR =
  DIST_DIR_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ||
  path.resolve(process.cwd(), 'dist');

function ensureWritableCacheFile(): void {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(CACHE_FILE)) {
      const seed = SEED_CACHE_CANDIDATES.find(
        (candidate) => candidate !== CACHE_FILE && fs.existsSync(candidate),
      );
      if (seed) {
        fs.copyFileSync(seed, CACHE_FILE);
      }
    }
  } catch {
    // Non-fatal: cache continues in memory if userData dir is unavailable
  }
}

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
  isEgypt?: boolean;
  countryCode?: string;
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

function isWithinEgyptBounds(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < 21.65 || lat > 31.72 || lon < 24.65 || lon > 36.95) return false;
  // Exclude Saudi Arabia / Jordan east of Red Sea & Gulf of Aqaba (above Halayeb/Shalateen)
  if (lat > 24.5 && lon > 34.95) return false;
  // Exclude northeast border beyond Rafah–Taba line
  if (lat > 29.49 && lon > 34.94 - (lat - 29.49) * 0.38) return false;
  return true;
}

function normalizeEgyptCoords(
  lat: number,
  lon: number,
): { lat: number | null; lon: number | null; outOfEgypt: boolean; rawLat: number; rawLon: number } {
  if (isWithinEgyptBounds(lat, lon)) {
    return { lat, lon, outOfEgypt: false, rawLat: lat, rawLon: lon };
  }
  if (isWithinEgyptBounds(lon, lat)) {
    return { lat: lon, lon: lat, outOfEgypt: false, rawLat: lat, rawLon: lon };
  }
  return { lat: null, lon: null, outOfEgypt: true, rawLat: lat, rawLon: lon };
}

function parseCoordNumber(val: unknown): number | null {
  if (val === null || val === undefined || typeof val === 'boolean' || typeof val === 'object') {
    return null;
  }
  const str = String(val).trim();
  if (!str) return null;
  const num = Number(str);
  if (!Number.isFinite(num) || num === 0) return null;
  return num;
}

function parseCacheKeyCoords(key: string): { lat: number; lon: number } | null {
  const parts = key.split('_');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function readGeocodeCache(): Record<string, MarkazEntry> {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const normalized: Record<string, MarkazEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== 'object') continue;
      const coords = parseCacheKeyCoords(k);
      if (coords && !isWithinEgyptBounds(coords.lat, coords.lon)) continue;
      const gov = String(v.governorate || v['المحافظة'] || 'غير محدد');
      const mkz = String(v.markaz || v['المركز'] || 'غير محدد');
      const vlg = String(v.village || v['القرية_المنطقة'] || 'غير محدد');
      const countryCode = typeof v.countryCode === 'string' ? v.countryCode.toLowerCase() : undefined;
      const isEgypt =
        v.isEgypt === false ||
        gov === 'خارج مصر' ||
        mkz === 'خارج مصر' ||
        (countryCode !== undefined && countryCode !== 'eg')
          ? false
          : true;
      if (isEgypt && gov === 'غير محدد' && mkz === 'غير محدد') continue;
      normalized[k] = {
        governorate: gov,
        markaz: mkz,
        village: vlg,
        isEgypt,
        countryCode,
      };
    }
    return normalized;
  } catch {
    return {};
  }
}

function writeGeocodeCache(cache: Record<string, MarkazEntry>): void {
  const serializable: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(cache)) {
    serializable[k] = {
      المحافظة: v.governorate,
      المركز: v.markaz,
      القرية_المنطقة: v.village,
      isEgypt: v.isEgypt !== false,
      ...(v.countryCode ? { countryCode: v.countryCode } : {}),
    };
  }
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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

function coordCacheKey(lat: number, lon: number): string {
  return `${Number(lat.toFixed(2))}_${Number(lon.toFixed(2))}`;
}

let googleQuotaBlockedUntil = 0;

function hasArabicText(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

function normalizeArabicPlaceName(raw?: string | null): string {
  if (!raw) return '';
  let text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text
    .replace(/\bمدينه\b/g, 'مدينة')
    .replace(/\bمنطقه\b/g, 'منطقة')
    .replace(/\bقريه\b/g, 'قرية')
    .replace(/\bمحافظه\b/g, 'محافظة')
    .replace(/\bعزبه\b/g, 'عزبة')
    .replace(/\bناحيه\b/g, 'ناحية')
    .replace(/الكتيبه$/g, 'الكتيبة')
    .replace(/البحريه$/g, 'البحرية')
    .replace(/الفرافره$/g, 'الفرافرة')
    .replace(/الخارجه$/g, 'الخارجة')
    .replace(/الداخله$/g, 'الداخلة')
    .replace(/سيوه$/g, 'سيوة')
    .replace(/الاسماعيليه$/g, 'الإسماعيلية');
  return text;
}

function normalizeEgyptGovernorateName(raw?: string | null): string {
  const cleaned = normalizeArabicPlaceName(raw).replace(/^محافظة\s+/, '').trim();
  if (!cleaned) return 'غير محدد';

  const compact = cleaned
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة$/g, 'ه');

  const map: Record<string, string> = {
    'القاهره': 'القاهرة',
    'الجيزه': 'الجيزة',
    'الاسكندريه': 'الإسكندرية',
    'القليوبيه': 'القليوبية',
    'الشرقيه': 'الشرقية',
    'الدقهليه': 'الدقهلية',
    'البحيره': 'البحيرة',
    'الغربيه': 'الغربية',
    'المنوفيه': 'المنوفية',
    'كفر الشيخ': 'كفر الشيخ',
    'دمياط': 'دمياط',
    'بورسعيد': 'بورسعيد',
    'الاسماعيليه': 'الإسماعيلية',
    'السويس': 'السويس',
    'شمال سيناء': 'شمال سيناء',
    'جنوب سيناء': 'جنوب سيناء',
    'مطروح': 'مطروح',
    'الفيوم': 'الفيوم',
    'بني سويف': 'بني سويف',
    'المنيا': 'المنيا',
    'المنيه': 'المنيا',
    'اسيوط': 'أسيوط',
    'سوهاج': 'سوهاج',
    'قنا': 'قنا',
    'الاقصر': 'الأقصر',
    'اسوان': 'أسوان',
    'البحر الاحمر': 'البحر الأحمر',
    'الوادي الجديد': 'الوادي الجديد',
  };

  return map[compact] || cleaned;
}

interface GoogleGeocodeAddressComponent {
  long_name?: string;
  short_name?: string;
  types?: string[];
}

interface GoogleGeocodeResult {
  types?: string[];
  address_components?: GoogleGeocodeAddressComponent[];
}

function cleanGoogleAdminName(raw?: string): string {
  if (!raw) return '';
  const cleaned = raw.replace(/^[،,\s]+|[،,\s]+$/g, '').trim();
  if (!cleaned) return '';
  // Reject postal codes / pure numbers and Google Plus Codes (e.g. "5P69+4W4")
  if (/^[\d\s،,.-]+$/.test(cleaned)) return '';
  if (/[A-Z0-9]{2,}\+[A-Z0-9]{2,}/i.test(cleaned)) return '';
  return cleaned;
}

async function reverseGeocodeGoogle(
  lat: number,
  lon: number,
  apiKey: string,
): Promise<{ entry?: MarkazEntry; incomplete?: boolean; quotaBlocked?: boolean }> {
  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${lat},${lon}`);
    url.searchParams.set('language', 'ar');
    url.searchParams.set('key', apiKey);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      return { incomplete: true, quotaBlocked: resp.status === 403 || resp.status === 429 };
    }

    const json = (await resp.json()) as {
      status?: string;
      results?: GoogleGeocodeResult[];
    };

    if (json.status === 'OVER_QUERY_LIMIT' || json.status === 'REQUEST_DENIED') {
      return { incomplete: true, quotaBlocked: true };
    }

    if (json.status !== 'OK' || !Array.isArray(json.results) || json.results.length === 0) {
      return { incomplete: true };
    }

    // Prefer street/political results over raw plus_code results (which occasionally embed postal codes)
    const orderedResults = [
      ...json.results.filter((r) => !(r.types || []).includes('plus_code')),
      ...json.results.filter((r) => (r.types || []).includes('plus_code')),
    ];

    let countryShort = '';
    let gov = '';
    let a2 = '';
    let a3 = '';
    let locality = '';
    let sublocality = '';

    for (const res of orderedResults) {
      for (const comp of res.address_components || []) {
        const types = comp.types || [];
        if (!countryShort && types.includes('country')) {
          countryShort = (comp.short_name || '').toUpperCase();
        }
        const val = cleanGoogleAdminName(comp.long_name);
        if (!val) continue;

        if (!gov && types.includes('administrative_area_level_1')) {
          gov = val;
        }
        if (!a2 && types.includes('administrative_area_level_2')) {
          a2 = val;
        }
        if (!a3 && types.includes('administrative_area_level_3')) {
          a3 = val;
        }
        if (!locality && types.includes('locality')) {
          locality = val;
        }
        if (
          !sublocality &&
          (types.includes('sublocality_level_1') || types.includes('sublocality'))
        ) {
          sublocality = val;
        }
      }
    }

    if (countryShort && countryShort !== 'EG') {
      return {
        entry: {
          governorate: 'خارج مصر',
          markaz: 'خارج مصر',
          village: 'خارج مصر',
          isEgypt: false,
          countryCode: countryShort.toLowerCase(),
        },
      };
    }

    if (!gov && !a2 && !locality) {
      return { incomplete: true };
    }

    const normalizedGov = gov || 'غير محدد';
    const mkz = a2 || locality || a3 || normalizedGov;
    const vlg = a3 || sublocality || locality || mkz;

    return {
      entry: {
        governorate: normalizedGov,
        markaz: mkz,
        village: vlg,
        isEgypt: true,
        countryCode: 'eg',
      },
    };
  } catch {
    return { incomplete: true };
  }
}

async function fetchArcGisAddress(
  lat: number,
  lon: number,
  featureTypes?: string,
): Promise<Record<string, string> | null> {
  try {
    const url = new URL(
      'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode',
    );
    url.searchParams.set('location', `${lon},${lat}`);
    url.searchParams.set('f', 'json');
    url.searchParams.set('langCode', 'ar');
    if (featureTypes) {
      url.searchParams.set('featureTypes', featureTypes);
    }

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;

    const json = (await resp.json()) as {
      error?: unknown;
      address?: Record<string, string>;
    };
    if (json.error || !json.address) return null;
    return json.address;
  } catch {
    return null;
  }
}

async function reverseGeocodeArcGis(lat: number, lon: number): Promise<MarkazEntry | null> {
  const locAddr = await fetchArcGisAddress(lat, lon, 'Locality');
  const needsDefault =
    !locAddr ||
    !locAddr.Region ||
    !locAddr.City ||
    !hasArabicText(locAddr.Region) ||
    !hasArabicText(locAddr.City);

  const defAddr = needsDefault ? await fetchArcGisAddress(lat, lon) : null;
  const primary = locAddr || defAddr;
  if (!primary) return null;

  const countryCode = (locAddr?.CountryCode || defAddr?.CountryCode || '').toUpperCase();
  if (countryCode && countryCode !== 'EGY') {
    return {
      governorate: 'خارج مصر',
      markaz: 'خارج مصر',
      village: 'خارج مصر',
      isEgypt: false,
      countryCode: countryCode.toLowerCase(),
    };
  }

  const pickArabic = (...vals: (string | undefined)[]): string => {
    for (const v of vals) {
      if (v && v.trim() && hasArabicText(v)) return v.trim();
    }
    for (const v of vals) {
      if (v && v.trim()) return v.trim();
    }
    return '';
  };

  const rawRegion = pickArabic(locAddr?.Region, defAddr?.Region, locAddr?.Subregion, defAddr?.Subregion);
  const rawCity = pickArabic(locAddr?.City, defAddr?.City, locAddr?.District, defAddr?.District);
  const rawVillage = pickArabic(
    locAddr?.District,
    locAddr?.Neighborhood,
    defAddr?.District,
    defAddr?.Neighborhood,
    locAddr?.PlaceName,
    rawCity,
  );

  if (!rawRegion && !rawCity) {
    return null;
  }

  const gov = normalizeEgyptGovernorateName(rawRegion);
  const mkz = normalizeArabicPlaceName(rawCity) || gov;
  const vlg = normalizeArabicPlaceName(rawVillage) || mkz;

  return {
    governorate: gov,
    markaz: mkz,
    village: vlg,
    isEgypt: true,
    countryCode: 'eg',
  };
}

async function reverseGeocodeNominatim(lat: number, lon: number): Promise<MarkazEntry | null> {
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('accept-language', 'ar');
    url.searchParams.set('addressdetails', '1');

    const geoResp = await fetch(url.toString(), {
      headers: { 'User-Agent': 'sekem_farm_mapper/1.0 (https://erp-sys.sekem.com)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!geoResp.ok) return null;

    const geoJson = (await geoResp.json()) as {
      error?: string;
      address?: Record<string, string>;
    };
    const addr = geoJson.address || {};
    const countryCode = (addr.country_code || '').toLowerCase();

    if (geoJson.error || countryCode !== 'eg') {
      return {
        governorate: 'خارج مصر',
        markaz: 'خارج مصر',
        village: 'خارج مصر',
        isEgypt: false,
        countryCode: countryCode || 'sea',
      };
    }

    const gov = normalizeEgyptGovernorateName(addr.state || addr.governorate || addr.region || 'غير محدد');
    const mkz =
      normalizeArabicPlaceName(
        addr.county ||
          addr.city_district ||
          addr.town ||
          addr.city ||
          addr.municipality ||
          addr.state_district ||
          addr.suburb ||
          addr.village,
      ) || gov;
    const vlg =
      normalizeArabicPlaceName(
        addr.village || addr.suburb || addr.hamlet || addr.neighbourhood || addr.quarter,
      ) || mkz;

    return {
      governorate: gov,
      markaz: mkz,
      village: vlg,
      isEgypt: true,
      countryCode: 'eg',
    };
  } catch {
    return null;
  }
}

function detectLatLonFromRecord(record: Record<string, unknown>): {
  lat: number | null;
  lon: number | null;
  outOfEgypt: boolean;
  rawLat: number | null;
  rawLon: number | null;
} {
  const keys = Object.keys(record);
  const latKeys = [
    ...keys.filter((k) => /^(lat|latitude)$/i.test(k.trim())),
    ...keys.filter(
      (k) =>
        !/^(lat|latitude)$/i.test(k.trim()) &&
        /(^|[_.\-\s])(lat|latitude)($|[_.\-\s])/i.test(k.trim()),
    ),
  ];
  const lonKeys = [
    ...keys.filter((k) => /^(lng|long|lon|longitude)$/i.test(k.trim())),
    ...keys.filter(
      (k) =>
        !/^(lng|long|lon|longitude)$/i.test(k.trim()) &&
        (/(^|[_.\-\s])(lng|lon|longitude)($|[_.\-\s])/i.test(k.trim()) ||
          /(gps|geo|coord|map|farm|site|loc|point|pos)[_.\-\s]*long$/i.test(k.trim())),
    ),
  ];

  let firstOutOfEgypt: { rawLat: number; rawLon: number } | null = null;

  // 1. Check all explicit lat/lon field pairs, preferring valid Egypt coordinates
  for (const lKey of latKeys) {
    const pLat = parseCoordNumber(record[lKey]);
    if (pLat === null || pLat < -90 || pLat > 90) continue;
    for (const nKey of lonKeys) {
      const pLon = parseCoordNumber(record[nKey]);
      if (pLon === null || pLon < -180 || pLon > 180) continue;
      const norm = normalizeEgyptCoords(pLat, pLon);
      if (!norm.outOfEgypt && norm.lat !== null && norm.lon !== null) {
        return { lat: norm.lat, lon: norm.lon, outOfEgypt: false, rawLat: norm.rawLat, rawLon: norm.rawLon };
      }
      if (!firstOutOfEgypt) {
        firstOutOfEgypt = { rawLat: pLat, rawLon: pLon };
      }
    }
  }

  // 2. Check combined "lat, lon" coordinate strings
  for (const [k, val] of Object.entries(record)) {
    if (typeof val !== 'string') continue;
    if (/date|time|creation|modified/i.test(k)) continue;
    const trimmed = val.trim();
    const pairMatch = trimmed.match(/^(-?\d{1,2}\.\d{2,})\s*[,;\s]\s*(-?\d{1,3}\.\d{2,})$/);
    if (!pairMatch) continue;
    const pLat = Number(pairMatch[1]);
    const pLon = Number(pairMatch[2]);
    if (!Number.isFinite(pLat) || !Number.isFinite(pLon) || pLat === 0 || pLon === 0) continue;
    if (pLat < -90 || pLat > 90 || pLon < -180 || pLon > 180) continue;

    const keyHintsGeo = /lat|lon|lng|coord|gps|geo|loc|map|point|pos/i.test(k);
    const norm = normalizeEgyptCoords(pLat, pLon);
    if (!norm.outOfEgypt && norm.lat !== null && norm.lon !== null) {
      return { lat: norm.lat, lon: norm.lon, outOfEgypt: false, rawLat: norm.rawLat, rawLon: norm.rawLon };
    }
    if (keyHintsGeo && !firstOutOfEgypt) {
      firstOutOfEgypt = { rawLat: pLat, rawLon: pLon };
    }
  }

  // 3. Check Frappe Geolocation fields storing GeoJSON strings
  for (const val of Object.values(record)) {
    if (typeof val !== 'string' || !val.includes('"coordinates"') || !val.trim().startsWith('{')) {
      continue;
    }
    try {
      const parsed = JSON.parse(val) as {
        features?: { geometry?: { type?: string; coordinates?: unknown } }[];
        geometry?: { type?: string; coordinates?: unknown };
      };
      const geom = parsed.features?.[0]?.geometry || parsed.geometry;
      let gLat: number | null = null;
      let gLon: number | null = null;

      if (geom?.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
        gLon = Number(geom.coordinates[0]);
        gLat = Number(geom.coordinates[1]);
      } else if (
        geom?.type === 'Polygon' &&
        Array.isArray(geom.coordinates) &&
        Array.isArray(geom.coordinates[0]) &&
        Array.isArray(geom.coordinates[0][0])
      ) {
        const ring = geom.coordinates[0] as number[][];
        gLon = ring.reduce((sum, pt) => sum + Number(pt[0] || 0), 0) / ring.length;
        gLat = ring.reduce((sum, pt) => sum + Number(pt[1] || 0), 0) / ring.length;
      } else if (
        geom?.type === 'MultiPolygon' &&
        Array.isArray(geom.coordinates) &&
        Array.isArray(geom.coordinates[0]) &&
        Array.isArray(geom.coordinates[0][0]) &&
        Array.isArray(geom.coordinates[0][0][0])
      ) {
        const ring = geom.coordinates[0][0] as number[][];
        gLon = ring.reduce((sum, pt) => sum + Number(pt[0] || 0), 0) / ring.length;
        gLat = ring.reduce((sum, pt) => sum + Number(pt[1] || 0), 0) / ring.length;
      }

      if (gLat !== null && gLon !== null && Number.isFinite(gLat) && Number.isFinite(gLon) && gLat !== 0 && gLon !== 0) {
        const norm = normalizeEgyptCoords(gLat, gLon);
        if (!norm.outOfEgypt && norm.lat !== null && norm.lon !== null) {
          return { lat: norm.lat, lon: norm.lon, outOfEgypt: false, rawLat: norm.rawLat, rawLon: norm.rawLon };
        }
        if (!firstOutOfEgypt) {
          firstOutOfEgypt = { rawLat: gLat, rawLon: gLon };
        }
      }
    } catch {
      // Ignore malformed JSON strings
    }
  }

  if (firstOutOfEgypt) {
    return {
      lat: null,
      lon: null,
      outOfEgypt: true,
      rawLat: firstOutOfEgypt.rawLat,
      rawLon: firstOutOfEgypt.rawLon,
    };
  }

  return { lat: null, lon: null, outOfEgypt: false, rawLat: null, rawLon: null };
}

async function startServer(): Promise<void> {
  ensureWritableCacheFile();
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      status: 'ready',
      port: PORT,
      pythonScriptPath: PYTHON_SCRIPT_PATH,
      pythonScriptAvailable: fs.existsSync(PYTHON_SCRIPT_PATH),
      cacheFile: CACHE_FILE,
      envLoadedFrom: loadedEnvPaths,
    });
  });

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
      // Optionally inspect Farm DocType metadata so we match custom title/area fields & Arabic/English labels
      let docTitleField = '';
      const fieldLabels: Record<string, string> = {};
      const metaAreaFields: string[] = [];

      const docMetaPromise = fetch(
        `${ERPNEXT_URL}/api/method/frappe.desk.form.load.getdoctype?doctype=Farm`,
        { headers },
      )
        .then(async (r) => {
          if (!r.ok) return null;
          return (await r.json()) as {
            docs?: {
              title_field?: string;
              fields?: { fieldname?: string; label?: string; fieldtype?: string }[];
            }[];
          };
        })
        .catch(() => null);

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

      const metaJson = await docMetaPromise;
      const farmMeta = metaJson?.docs?.find((d) => Array.isArray(d.fields)) || metaJson?.docs?.[0];
      if (farmMeta) {
        if (farmMeta.title_field) {
          docTitleField = farmMeta.title_field;
        }
        for (const f of farmMeta.fields || []) {
          if (!f.fieldname) continue;
          if (f.label) {
            fieldLabels[f.fieldname] = f.label;
          }
          const isNumericType = f.fieldtype === 'Float' || f.fieldtype === 'Int' || f.fieldtype === 'Currency';
          const textToCheck = `${f.fieldname} ${f.label || ''}`;
          if (
            isNumericType &&
            /(area|feddan|acre|hectar|size|مساح|فدان|هكتار)/i.test(textToCheck) &&
            !/(price|cost|rate|year|date|count|code)/i.test(f.fieldname)
          ) {
            metaAreaFields.push(f.fieldname);
          }
        }
      }

      const cache = readGeocodeCache();
      let detectedNameField: string | null = null;
      let detectedAreaField: string | null = null;

      const nameCandidateKeys = [
        ...(docTitleField ? [docTitleField] : []),
        'farm_name',
        'farm_name_ar',
        'arabic_name',
        'name_ar',
        'custom_farm_name',
        'custom_name',
        'farm_title',
        'title',
        'farm',
        'farmer_name',
        'display_name',
      ];

      const areaCandidateKeys = [
        ...metaAreaFields,
        'area',
        'total_area',
        'farm_area',
        'total_farm_area',
        'cultivated_area',
        'land_area',
        'area_in_feddans',
        'area_feddan',
        'total_feddans',
        'feddan',
        'feddans',
        'custom_area',
        'custom_total_area',
        'custom_farm_area',
        'custom_feddan',
        'farm_size',
        'size',
        'acres',
        'hectares',
      ];

      const farms = rawRows.map((row) => {
        const detected = detectLatLonFromRecord(row);
        const cacheKey =
          detected.lat !== null && detected.lon !== null
            ? coordCacheKey(detected.lat, detected.lon)
            : null;
        const legacyKey =
          detected.lat !== null && detected.lon !== null
            ? `${Number(detected.lat.toFixed(3))}_${Number(detected.lon.toFixed(3))}`
            : null;
        const cachedGeo =
          (cacheKey ? cache[cacheKey] : undefined) || (legacyKey ? cache[legacyKey] : undefined);
        const cachedOutOfEgypt = cachedGeo?.governorate === 'خارج مصر' || cachedGeo?.markaz === 'خارج مصر';

        const effectiveOutOfEgypt = detected.outOfEgypt || cachedOutOfEgypt;
        const effectiveLat = effectiveOutOfEgypt ? null : detected.lat;
        const effectiveLon = effectiveOutOfEgypt ? null : detected.lon;

        // Detect best human-readable Farm Name
        let nameVal: unknown = null;
        for (const k of nameCandidateKeys) {
          const candidate = row[k];
          if (typeof candidate === 'string' && candidate.trim() !== '') {
            nameVal = candidate.trim();
            if (!detectedNameField) detectedNameField = k;
            break;
          }
        }
        if (nameVal === null) {
          const dynamicNameKey = Object.keys(row).find(
            (k) =>
              /(farm_?name|arabic_?name|title)/i.test(k) &&
              typeof row[k] === 'string' &&
              String(row[k]).trim() !== '',
          );
          if (dynamicNameKey) {
            nameVal = String(row[dynamicNameKey]).trim();
            if (!detectedNameField) detectedNameField = dynamicNameKey;
          } else {
            nameVal = row.name || 'Unnamed Farm';
            if (!detectedNameField && row.name) detectedNameField = 'name';
          }
        }

        // Detect best numeric Farm Area
        let areaVal: number | null = null;
        for (const k of areaCandidateKeys) {
          const rawCandidate = row[k];
          if (rawCandidate !== null && rawCandidate !== undefined && rawCandidate !== '' && typeof rawCandidate !== 'boolean') {
            const num = Number(rawCandidate);
            if (Number.isFinite(num)) {
              areaVal = num;
              if (!detectedAreaField) detectedAreaField = k;
              break;
            }
          }
        }
        if (areaVal === null) {
          const dynamicAreaKey = Object.keys(row).find((k) => {
            if (!/(area|feddan|acre|hectar|size|مساح|فدان)/i.test(k)) return false;
            if (/(name|id|code|manager|owner|type|status|unit|uom|year|date|price|cost|qty)/i.test(k)) return false;
            const v = row[k];
            return v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
          });
          if (dynamicAreaKey) {
            areaVal = Number(row[dynamicAreaKey]);
            if (!detectedAreaField) detectedAreaField = dynamicAreaKey;
          }
        }

        const areaUnitRaw = row.area_uom || row.area_unit || row.uom || row.unit || null;
        const areaUnit = typeof areaUnitRaw === 'string' && areaUnitRaw.trim() ? areaUnitRaw.trim() : null;

        const codeRaw = row.farm_code || row.farm_id || row.code || null;
        const code =
          typeof codeRaw === 'string' || typeof codeRaw === 'number'
            ? String(codeRaw).trim() || null
            : null;

        const statusVal = row.farm_status || row.status || row.workflow_state || 'Active';

        const rawScalars: Record<string, string | number | boolean | null> = {};
        for (const [k, v] of Object.entries(row)) {
          if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            rawScalars[k] = v;
          }
        }

        const erpGov = row.governorate || row.custom_governorate || null;
        const erpMarkaz = row.markaz || row.custom_markaz || null;
        const erpVillage = row.village || row.custom_village || null;

        return {
          id: String(row.name || ''),
          code: code && code !== String(row.name || '') ? code : null,
          name: String(nameVal),
          type: String(row.type || row.farm_type || ''),
          status: String(statusVal),
          creation: String(row.creation || '').slice(0, 10),
          area: areaVal,
          areaUnit,
          lat: effectiveLat,
          lon: effectiveLon,
          outOfEgypt: effectiveOutOfEgypt,
          rawLat: detected.rawLat,
          rawLon: detected.rawLon,
          cacheKey,
          governorate: effectiveOutOfEgypt
            ? null
            : cachedGeo?.governorate ?? (effectiveLat === null && erpGov ? String(erpGov) : null),
          markaz: effectiveOutOfEgypt
            ? null
            : cachedGeo?.markaz ?? (effectiveLat === null && erpMarkaz ? String(erpMarkaz) : null),
          village: effectiveOutOfEgypt
            ? null
            : cachedGeo?.village ?? (effectiveLat === null && erpVillage ? String(erpVillage) : null),
          raw: rawScalars,
        };
      });

      res.json({
        farms,
        total: farms.length,
        withCoordinates: farms.filter((f) => f.lat !== null && f.lon !== null).length,
        outOfEgyptCount: farms.filter((f) => f.outOfEgypt).length,
        schemaInfo: {
          nameField: detectedNameField,
          areaField: detectedAreaField,
          fieldLabels,
        },
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

    // Quantize to ~1.1 km spatial cells so nearby farms share one lookup immediately
    const uniquePairs = new Map<string, { lat: number; lon: number }>();
    for (const item of coordinates) {
      if (
        typeof item?.lat === 'number' &&
        typeof item?.lon === 'number' &&
        isWithinEgyptBounds(item.lat, item.lon)
      ) {
        const key = coordCacheKey(item.lat, item.lon);
        const legacyKey = `${Number(item.lat.toFixed(3))}_${Number(item.lon.toFixed(3))}`;
        if (cache[key]) {
          resolved[key] = cache[key];
        } else if (cache[legacyKey]) {
          cache[key] = cache[legacyKey];
          resolved[key] = cache[legacyKey];
        } else if (!uniquePairs.has(key)) {
          uniquePairs.set(key, { lat: item.lat, lon: item.lon });
        }
      }
    }

    const googleApiKey =
      process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
    const useGoogle = Boolean(googleApiKey) && Date.now() > googleQuotaBlockedUntil;
    const maxBatch = 150;
    const entriesToProcess = Array.from(uniquePairs.entries()).slice(0, maxBatch);
    const processed = entriesToProcess.length;

    const pendingAfterGoogle: [string, { lat: number; lon: number }][] = [];
    let googleQuotaBlocked = false;

    if (useGoogle && entriesToProcess.length > 0) {
      const concurrency = 12;
      for (let i = 0; i < entriesToProcess.length; i += concurrency) {
        if (googleQuotaBlocked) {
          pendingAfterGoogle.push(...entriesToProcess.slice(i));
          break;
        }
        const slice = entriesToProcess.slice(i, i + concurrency);
        const results = await Promise.all(
          slice.map(async ([key, pair]) => ({
            key,
            pair,
            res: await reverseGeocodeGoogle(pair.lat, pair.lon, googleApiKey),
          })),
        );

        for (const item of results) {
          if (item.res.quotaBlocked) {
            googleQuotaBlocked = true;
            googleQuotaBlockedUntil = Date.now() + 10 * 60 * 1000;
          }
          if (item.res.entry && !item.res.incomplete) {
            const normalizedEntry: MarkazEntry = {
              ...item.res.entry,
              governorate:
                item.res.entry.isEgypt === false
                  ? item.res.entry.governorate
                  : normalizeEgyptGovernorateName(item.res.entry.governorate),
            };
            cache[item.key] = normalizedEntry;
            resolved[item.key] = normalizedEntry;
            newLookups += 1;
          } else {
            pendingAfterGoogle.push([item.key, item.pair]);
          }
        }
      }
    } else {
      pendingAfterGoogle.push(...entriesToProcess);
    }

    // Primary high-speed Arabic fallback: ArcGIS World Geocoding (Locality + default, 16 concurrent)
    const fallbackToNominatim: [string, { lat: number; lon: number }][] = [];
    if (pendingAfterGoogle.length > 0) {
      const arcConcurrency = 16;
      for (let i = 0; i < pendingAfterGoogle.length; i += arcConcurrency) {
        const slice = pendingAfterGoogle.slice(i, i + arcConcurrency);
        const results = await Promise.all(
          slice.map(async ([key, pair]) => ({
            key,
            pair,
            entry: await reverseGeocodeArcGis(pair.lat, pair.lon),
          })),
        );

        for (const item of results) {
          if (item.entry) {
            cache[item.key] = item.entry;
            resolved[item.key] = item.entry;
            newLookups += 1;
          } else {
            fallbackToNominatim.push([item.key, item.pair]);
          }
        }
      }
    }

    // Last-resort Nominatim check (capped at 5 items per batch to prevent timeouts)
    const nominatimSlice = fallbackToNominatim.slice(0, 5);
    for (let idx = 0; idx < nominatimSlice.length; idx++) {
      const [key, pair] = nominatimSlice[idx];
      if (idx > 0) {
        await delay(1050);
      }
      const entry = await reverseGeocodeNominatim(pair.lat, pair.lon);
      if (entry) {
        cache[key] = entry;
        resolved[key] = entry;
        newLookups += 1;
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

  app.get('/api/maps-config', (_req: Request, res: Response) => {
    const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
    res.json({ apiKey });
  });

  const isProd = process.env.NODE_ENV === 'production';
  const apiOnly = process.env.ELECTRON_API_ONLY === 'true';
  if (!isProd && !apiOnly) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (isProd && fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'API route not found' });
        return;
      }
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  app.listen(PORT, BIND_HOST, () => {
    console.log(`Server listening on http://${BIND_HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
