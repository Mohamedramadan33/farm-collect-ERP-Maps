/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Download,
  ExternalLink,
  FileSpreadsheet,
  Globe,
  LogIn,
  LogOut,
  MapPin,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import FarmsMap, { type MapFarmItem } from './components/FarmsMap';

type NavSection = 'overview' | 'map' | 'markaz' | 'account';
type TableDensity = 'compact' | 'all-fields';

interface ErpSessionState {
  checked: boolean;
  connected: boolean;
  erpUrl: string;
  userId?: string;
  fullName?: string;
}

interface FarmRecord {
  id: string;
  code?: string | null;
  name: string;
  type: string;
  status: string;
  creation: string;
  area: number | null;
  areaUnit?: string | null;
  lat: number | null;
  lon: number | null;
  outOfEgypt?: boolean;
  rawLat?: number | null;
  rawLon?: number | null;
  cacheKey: string | null;
  governorate: string | null;
  markaz: string | null;
  village: string | null;
  raw?: Record<string, string | number | boolean | null>;
}

interface ErpSchemaInfo {
  nameField: string | null;
  areaField: string | null;
  fieldLabels: Record<string, string>;
}

interface ArabicRegionRow {
  key: string;
  areaName: string;
  markaz: string;
  governorate: string;
  farmCount: number;
  nearbyCount: number;
  totalArea: number;
  centerLat: number | null;
  centerLon: number | null;
}

const NAV_ITEMS: { id: NavSection; label: string }[] = [
  { id: 'overview', label: 'نظرة عامة' },
  { id: 'map', label: 'الخريطة والمناطق' },
  { id: 'markaz', label: 'جدول المراكز' },
  { id: 'account', label: 'اتصال ERPNext' },
];

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildGoogleEarthUrl(lat: number, lon: number, distanceMeters = 1500): string {
  return `https://earth.google.com/web/@${lat.toFixed(6)},${lon.toFixed(6)},0a,${distanceMeters}d,35y,0h,0t,0r`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeCdata(value: string): string {
  return value.replace(/]]>/g, ']]]]><![CDATA[>');
}

function normalizeEgyptLonLat(a: number, b: number): [number, number] | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a >= 24 && a <= 37.5 && b >= 21 && b <= 32.5) return [a, b];
  if (b >= 24 && b <= 37.5 && a >= 21 && a <= 32.5) return [b, a];
  return null;
}

function extractRingCoords(rawRing: unknown): [number, number][] | null {
  if (!Array.isArray(rawRing) || rawRing.length < 3) return null;
  const parsed: [number, number][] = [];
  for (const pt of rawRing) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const norm = normalizeEgyptLonLat(Number(pt[0]), Number(pt[1]));
    if (norm) parsed.push(norm);
  }
  if (parsed.length < 3) return null;
  const first = parsed[0];
  const last = parsed[parsed.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    parsed.push([first[0], first[1]]);
  }
  return parsed;
}

function extractPolygonsFromGeoJson(node: unknown, acc: [number, number][][][]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : '';

  if (type === 'FeatureCollection' && Array.isArray(obj.features)) {
    for (const f of obj.features) extractPolygonsFromGeoJson(f, acc);
    return;
  }
  if (type === 'Feature' && obj.geometry) {
    extractPolygonsFromGeoJson(obj.geometry, acc);
    return;
  }
  if (type === 'GeometryCollection' && Array.isArray(obj.geometries)) {
    for (const g of obj.geometries) extractPolygonsFromGeoJson(g, acc);
    return;
  }
  if (type === 'Polygon' && Array.isArray(obj.coordinates)) {
    const rings = obj.coordinates
      .map(extractRingCoords)
      .filter((r): r is [number, number][] => r !== null);
    if (rings.length > 0) acc.push(rings);
    return;
  }
  if (type === 'MultiPolygon' && Array.isArray(obj.coordinates)) {
    for (const poly of obj.coordinates) {
      if (!Array.isArray(poly)) continue;
      const rings = poly
        .map(extractRingCoords)
        .filter((r): r is [number, number][] => r !== null);
      if (rings.length > 0) acc.push(rings);
    }
  }
}

function extractFarmPolygons(farm: FarmRecord): [number, number][][][] {
  if (!farm.raw) return [];
  const polygons: [number, number][][][] = [];
  for (const val of Object.values(farm.raw)) {
    if (typeof val !== 'string') continue;
    const trimmed = val.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    if (!trimmed.includes('Polygon') && !trimmed.includes('Feature')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      extractPolygonsFromGeoJson(parsed, polygons);
    } catch {
      // Ignore non-JSON strings
    }
  }
  return polygons;
}

function buildKmlDocument(farmsList: FarmRecord[], docName: string): string {
  const validFarms = farmsList.filter(
    (f): f is FarmRecord & { lat: number; lon: number } =>
      !f.outOfEgypt &&
      f.lat !== null &&
      f.lon !== null &&
      f.governorate !== 'خارج مصر' &&
      f.markaz !== 'خارج مصر',
  );

  const grouped = new Map<string, Map<string, (FarmRecord & { lat: number; lon: number })[]>>();
  for (const farm of validFarms) {
    const gov = farm.governorate && farm.governorate !== 'غير محدد' ? farm.governorate : 'مزارع مصر';
    const mkz = farm.markaz && farm.markaz !== 'غير محدد' ? farm.markaz : 'بدون مركز محدد';
    if (!grouped.has(gov)) grouped.set(gov, new Map());
    const mkzMap = grouped.get(gov)!;
    if (!mkzMap.has(mkz)) mkzMap.set(mkz, []);
    mkzMap.get(mkz)!.push(farm);
  }

  const renderPlacemark = (farm: FarmRecord & { lat: number; lon: number }): string => {
    const areaText =
      farm.area !== null
        ? `${farm.area.toLocaleString('en-US', { maximumFractionDigits: 2 })}${farm.areaUnit ? ` ${farm.areaUnit}` : ''}`
        : 'غير مسجلة';
    const govText = farm.governorate || 'غير محدد';
    const mkzText = farm.markaz || 'غير محدد';
    const villageText = farm.village && farm.village !== 'غير محدد' ? farm.village : '—';

    const htmlBalloon = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:13px;min-width:240px;text-align:right;">
  <h3 style="margin:0 0 6px 0;color:#14532d;">${escapeXml(farm.name || farm.id)}</h3>
  <table style="border-collapse:collapse;width:100%;font-size:12px;">
    <tr><td style="padding:3px 6px;font-weight:bold;color:#475569;">ID المزرعة:</td><td style="padding:3px 6px;font-family:monospace;">${escapeXml(farm.id)}</td></tr>
    <tr><td style="padding:3px 6px;font-weight:bold;color:#475569;">المساحة:</td><td style="padding:3px 6px;">${escapeXml(areaText)}</td></tr>
    <tr><td style="padding:3px 6px;font-weight:bold;color:#475569;">المحافظة:</td><td style="padding:3px 6px;">${escapeXml(govText)}</td></tr>
    <tr><td style="padding:3px 6px;font-weight:bold;color:#475569;">المركز:</td><td style="padding:3px 6px;">${escapeXml(mkzText)}</td></tr>
    <tr><td style="padding:3px 6px;font-weight:bold;color:#475569;">القرية / المنطقة:</td><td style="padding:3px 6px;">${escapeXml(villageText)}</td></tr>
    <tr><td style="padding:3px 6px;font-weight:bold;color:#475569;">الحالة:</td><td style="padding:3px 6px;">${escapeXml(farm.status || '—')}</td></tr>
    <tr><td style="padding:3px 6px;font-weight:bold;color:#475569;">الإحداثيات:</td><td style="padding:3px 6px;direction:ltr;text-align:left;font-family:monospace;">${farm.lat.toFixed(6)}, ${farm.lon.toFixed(6)}</td></tr>
  </table>
</div>`;

    const polygons = extractFarmPolygons(farm);
    const pointXml = `<Point><coordinates>${farm.lon.toFixed(6)},${farm.lat.toFixed(6)},0</coordinates></Point>`;
    const polygonsXml = polygons
      .map((rings) => {
        const outer = rings[0]
          .map(([lng, lt]) => `${lng.toFixed(6)},${lt.toFixed(6)},0`)
          .join(' ');
        const inners = rings
          .slice(1)
          .map(
            (ring) =>
              `<innerBoundaryIs><LinearRing><coordinates>${ring
                .map(([lng, lt]) => `${lng.toFixed(6)},${lt.toFixed(6)},0`)
                .join(' ')}</coordinates></LinearRing></innerBoundaryIs>`,
          )
          .join('');
        return `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${outer}</coordinates></LinearRing></outerBoundaryIs>${inners}</Polygon>`;
      })
      .join('');

    const geometryXml =
      polygons.length > 0 ? `<MultiGeometry>${pointXml}${polygonsXml}</MultiGeometry>` : pointXml;

    return `      <Placemark id="${escapeXml(farm.id)}">
        <name>${escapeXml(farm.name || farm.id)}</name>
        <styleUrl>#sekemFarmStyle</styleUrl>
        <description><![CDATA[${escapeCdata(htmlBalloon)}]]></description>
        <ExtendedData>
          <Data name="farm_id"><value>${escapeXml(farm.id)}</value></Data>
          <Data name="farm_name"><value>${escapeXml(farm.name || farm.id)}</value></Data>
          <Data name="area"><value>${escapeXml(farm.area !== null ? String(farm.area) : '')}</value></Data>
          <Data name="area_unit"><value>${escapeXml(farm.areaUnit || '')}</value></Data>
          <Data name="governorate"><value>${escapeXml(govText)}</value></Data>
          <Data name="markaz"><value>${escapeXml(mkzText)}</value></Data>
          <Data name="village"><value>${escapeXml(villageText)}</value></Data>
          <Data name="status"><value>${escapeXml(farm.status || '')}</value></Data>
          <Data name="latitude"><value>${farm.lat.toFixed(6)}</value></Data>
          <Data name="longitude"><value>${farm.lon.toFixed(6)}</value></Data>
        </ExtendedData>
        ${geometryXml}
      </Placemark>`;
  };

  const foldersXml = Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'ar'))
    .map(([gov, mkzMap]) => {
      const subFolders = Array.from(mkzMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'ar'))
        .map(([mkz, list]) => {
          return `    <Folder>
      <name>${escapeXml(mkz)} (${list.length})</name>
${list.map(renderPlacemark).join('\n')}
    </Folder>`;
        })
        .join('\n');

      const govCount = Array.from(mkzMap.values()).reduce((s, arr) => s + arr.length, 0);
      return `  <Folder>
    <name>${escapeXml(gov)} (${govCount})</name>
${subFolders}
  </Folder>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${escapeXml(docName)}</name>
  <description>مزارع سيكم في مصر - تم التصدير مع ID المزرعة والاسم والمساحة والمركز</description>
  <Style id="sekemFarmStyle">
    <IconStyle>
      <scale>1.1</scale>
      <Icon>
        <href>http://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href>
      </Icon>
    </IconStyle>
    <LabelStyle>
      <scale>0.85</scale>
    </LabelStyle>
    <LineStyle>
      <color>ff1e7e34</color>
      <width>2</width>
    </LineStyle>
    <PolyStyle>
      <color>6634a853</color>
    </PolyStyle>
  </Style>
${foldersXml}
</Document>
</kml>`;
}

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('overview');
  const [tableView, setTableView] = useState<TableDensity>('compact');
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [session, setSession] = useState<ErpSessionState>({
    checked: false,
    connected: false,
    erpUrl: 'https://erp-sys.sekem.com',
  });

  // Google Maps quota & key state
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [mapsApiKey, setMapsApiKey] = useState<string>(
    import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
  );
  const [mapFocus, setMapFocus] = useState<{ lat: number; lng: number; zoom?: number } | null>(null);
  const [nearbyRadiusKm, setNearbyRadiusKm] = useState<number>(10);

  // Login form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Farms & filter state (empty dates = pull ALL farms across all time)
  const [farms, setFarms] = useState<FarmRecord[]>([]);
  const [schemaInfo, setSchemaInfo] = useState<ErpSchemaInfo>({
    nameField: null,
    areaField: null,
    fieldLabels: {},
  });
  const [farmsLoading, setFarmsLoading] = useState(false);
  const [farmsError, setFarmsError] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [excludeCancelled, setExcludeCancelled] = useState(false);
  const [showOnlyOutOfEgypt, setShowOnlyOutOfEgypt] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Markaz geocoding state
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeMessage, setGeocodeMessage] = useState<string | null>(null);

  // Selected farm full details drawer
  const [selectedFarm, setSelectedFarm] = useState<FarmRecord | null>(null);
  const [farmDetails, setFarmDetails] = useState<Record<string, unknown> | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  useEffect(() => {
    const onQuotaExceeded = () => setQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuotaExceeded);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuotaExceeded);
  }, []);

  useEffect(() => {
    fetch('/api/maps-config')
      .then((res) => res.json())
      .then((data: { apiKey?: string }) => {
        if (data?.apiKey) setMapsApiKey(data.apiKey);
      })
      .catch(() => {});
  }, []);

  const authHeaders = useCallback(
    (extra?: Record<string, string>): Record<string, string> => {
      const headers: Record<string, string> = { ...(extra || {}) };
      if (sessionToken) {
        headers['x-erp-session'] = sessionToken;
      }
      return headers;
    },
    [sessionToken],
  );

  const resolveMarkazForList = useCallback(
    async (targetFarms: FarmRecord[], tokenOverride?: string | null) => {
      const unresolvedMap = new Map<string, { lat: number; lon: number }>();
      for (const f of targetFarms) {
        if (
          !f.outOfEgypt &&
          f.lat !== null &&
          f.lon !== null &&
          (!f.markaz || !f.governorate || f.markaz === 'غير محدد')
        ) {
          const key = f.cacheKey || `${Number(f.lat.toFixed(2))}_${Number(f.lon.toFixed(2))}`;
          if (!unresolvedMap.has(key)) {
            unresolvedMap.set(key, { lat: f.lat, lon: f.lon });
          }
        }
      }

      let pendingCoords = Array.from(unresolvedMap.values());
      if (pendingCoords.length === 0) return;

      setGeocoding(true);
      let totalNew = 0;
      const effectiveToken = tokenOverride !== undefined ? tokenOverride : sessionToken;

      try {
        while (pendingCoords.length > 0) {
          setGeocodeMessage(
            `جاري تحديد المراكز والمحافظات بالعربي تلقائياً (${pendingCoords.length} موقع متبقي)...`,
          );

          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (effectiveToken) {
            headers['x-erp-session'] = effectiveToken;
          }

          const resp = await fetch('/api/erp/geocode-markaz', {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({ coordinates: pendingCoords }),
          });

          const data = (await resp.json().catch(() => ({}))) as {
            resolved?: Record<
              string,
              { governorate: string; markaz: string; village: string; isEgypt?: boolean }
            >;
            newLookups?: number;
            remainingUncached?: number;
            error?: string;
          };

          if (!resp.ok) {
            throw new Error(data.error || 'تعذر تحديد المراكز من خدمة الخرائط.');
          }

          const resolvedMap = data.resolved || {};
          totalNew += data.newLookups || 0;

          setFarms((prev) =>
            prev.map((farm) => {
              const key =
                farm.cacheKey ||
                (farm.lat !== null && farm.lon !== null
                  ? `${Number(farm.lat.toFixed(2))}_${Number(farm.lon.toFixed(2))}`
                  : null);
              if (key && resolvedMap[key]) {
                const entry = resolvedMap[key];
                if (
                  entry.isEgypt === false ||
                  entry.governorate === 'خارج مصر' ||
                  entry.markaz === 'خارج مصر'
                ) {
                  return {
                    ...farm,
                    rawLat: farm.rawLat ?? farm.lat,
                    rawLon: farm.rawLon ?? farm.lon,
                    lat: null,
                    lon: null,
                    outOfEgypt: true,
                    governorate: null,
                    markaz: null,
                    village: null,
                  };
                }
                return {
                  ...farm,
                  cacheKey: key,
                  governorate: entry.governorate,
                  markaz: entry.markaz,
                  village: entry.village,
                };
              }
              return farm;
            }),
          );

          pendingCoords = pendingCoords.filter((coord) => {
            const k = `${Number(coord.lat.toFixed(2))}_${Number(coord.lon.toFixed(2))}`;
            return !resolvedMap[k];
          });

          if (
            (data.remainingUncached || 0) === 0 ||
            ((data.newLookups || 0) === 0 && Object.keys(resolvedMap).length === 0)
          ) {
            break;
          }
        }

        setGeocodeMessage(
          totalNew > 0
            ? `تم تحديد المراكز والمحافظات بالعربي بنجاح (${totalNew} موقع جديد تم حفظه).`
            : 'تم تحميل كافة المراكز والمناطق بالعربي.',
        );
      } catch (error) {
        setGeocodeMessage(error instanceof Error ? error.message : 'تعذر تحديد المراكز.');
      } finally {
        setGeocoding(false);
      }
    },
    [sessionToken],
  );

  const fetchFarms = useCallback(
    async (tokenOverride?: string | null) => {
      setFarmsLoading(true);
      setFarmsError(null);
      setGeocodeMessage(null);
      try {
        const params = new URLSearchParams();
        if (fromDate) params.set('fromDate', fromDate);
        if (toDate) params.set('toDate', toDate);
        if (excludeCancelled) params.set('excludeCancelled', 'true');

        const headers: Record<string, string> = {};
        const effectiveToken = tokenOverride !== undefined ? tokenOverride : sessionToken;
        if (effectiveToken) {
          headers['x-erp-session'] = effectiveToken;
        }

        const resp = await fetch(`/api/erp/farms?${params.toString()}`, {
          credentials: 'include',
          headers,
        });
        const data = (await resp.json().catch(() => ({}))) as {
          farms?: FarmRecord[];
          schemaInfo?: Partial<ErpSchemaInfo>;
          error?: string;
        };

        if (!resp.ok) {
          if (resp.status === 401) {
            setSession((prev) => ({ ...prev, connected: false }));
          }
          throw new Error(data.error || `تعذر سحب المزارع (${resp.status})`);
        }

        const loaded = Array.isArray(data.farms) ? data.farms : [];
        setMapFocus(null);
        setShowOnlyOutOfEgypt(false);
        setFarms(loaded);
        setSchemaInfo({
          nameField: data.schemaInfo?.nameField ?? null,
          areaField: data.schemaInfo?.areaField ?? null,
          fieldLabels: data.schemaInfo?.fieldLabels ?? {},
        });

        // Auto-resolve Markaz and Governorate in Arabic for farms with valid Egypt GPS coordinates
        void resolveMarkazForList(loaded, effectiveToken);
      } catch (error) {
        setFarmsError(error instanceof Error ? error.message : 'تعذر الاتصال بسيرفر ERPNext.');
      } finally {
        setFarmsLoading(false);
      }
    },
    [excludeCancelled, fromDate, resolveMarkazForList, sessionToken, toDate],
  );

  useEffect(() => {
    let active = true;
    const checkSession = async () => {
      try {
        const resp = await fetch('/api/erp/session', {
          credentials: 'include',
        });
        const data = (await resp.json()) as {
          connected: boolean;
          erpUrl: string;
          userId?: string;
          fullName?: string;
        };
        if (!active) return;
        setSession({
          checked: true,
          connected: Boolean(data.connected),
          erpUrl: data.erpUrl || 'https://erp-sys.sekem.com',
          userId: data.userId,
          fullName: data.fullName,
        });
        if (data.connected) {
          await fetchFarms(null);
        }
      } catch {
        if (!active) return;
        setSession((prev) => ({ ...prev, checked: true, connected: false }));
      }
    };
    void checkSession();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      const resp = await fetch('/api/erp/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usr: username, pwd: password }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        connected?: boolean;
        erpUrl?: string;
        userId?: string;
        fullName?: string;
        sessionToken?: string;
        error?: string;
      };

      if (!resp.ok || !data.connected) {
        throw new Error(data.error || 'فشل تسجيل الدخول إلى ERPNext.');
      }

      const token = data.sessionToken || null;
      setSessionToken(token);
      setPassword('');
      setSession({
        checked: true,
        connected: true,
        erpUrl: data.erpUrl || 'https://erp-sys.sekem.com',
        userId: data.userId,
        fullName: data.fullName,
      });
      setActiveSection('overview');
      await fetchFarms(token);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'تعذر تسجيل الدخول إلى ERPNext.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/erp/logout', {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders(),
    }).catch(() => {});
    setSessionToken(null);
    setFarms([]);
    setSelectedFarm(null);
    setFarmDetails(null);
    setGeocodeMessage(null);
    setSession((prev) => ({
      ...prev,
      connected: false,
      userId: undefined,
      fullName: undefined,
    }));
  };

  const handleOpenFarmDetails = useCallback(
    async (farmOrId: FarmRecord | string) => {
      const farmObj =
        typeof farmOrId === 'string'
          ? farms.find((item) => item.id === farmOrId) || null
          : farmOrId;
      if (!farmObj) return;

      setSelectedFarm(farmObj);
      setFarmDetails(null);
      setDetailsError(null);
      setDetailsLoading(true);
      try {
        const resp = await fetch(`/api/erp/farms/${encodeURIComponent(farmObj.id)}`, {
          credentials: 'include',
          headers: authHeaders(),
        });
        const data = (await resp.json().catch(() => ({}))) as {
          farm?: Record<string, unknown>;
          error?: string;
        };
        if (!resp.ok) {
          throw new Error(data.error || `تعذر تحميل تفاصيل المزرعة (${resp.status})`);
        }
        setFarmDetails(data.farm || {});
      } catch (error) {
        setDetailsError(error instanceof Error ? error.message : 'تعذر تحميل ملف المزرعة الكامل.');
      } finally {
        setDetailsLoading(false);
      }
    },
    [authHeaders, farms],
  );

  const outOfEgyptFarms = useMemo(
    () => farms.filter((f) => Boolean(f.outOfEgypt)),
    [farms],
  );

  const filteredFarms = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return farms.filter((f) => {
      if (showOnlyOutOfEgypt && !f.outOfEgypt) {
        return false;
      }
      if (!q) return true;
      if (
        f.name.toLowerCase().includes(q) ||
        f.id.toLowerCase().includes(q) ||
        (f.markaz || '').toLowerCase().includes(q) ||
        (f.governorate || '').toLowerCase().includes(q) ||
        (f.village || '').toLowerCase().includes(q) ||
        f.status.toLowerCase().includes(q)
      ) {
        return true;
      }
      if (f.raw) {
        for (const val of Object.values(f.raw)) {
          if (val !== null && val !== undefined && String(val).toLowerCase().includes(q)) {
            return true;
          }
        }
      }
      return false;
    });
  }, [farms, searchQuery, showOnlyOutOfEgypt]);

  const mapFarms: MapFarmItem[] = useMemo(
    () =>
      filteredFarms
        .filter(
          (f): f is FarmRecord & { lat: number; lon: number } =>
            f.lat !== null &&
            f.lon !== null &&
            !f.outOfEgypt &&
            f.governorate !== 'خارج مصر' &&
            f.markaz !== 'خارج مصر',
        )
        .map((f) => ({
          id: f.id,
          name: f.name,
          status: f.status,
          lat: f.lat,
          lon: f.lon,
          governorate: f.governorate,
          markaz: f.markaz,
          village: f.village,
          area: f.area,
          areaUnit: f.areaUnit,
        })),
    [filteredFarms],
  );

  const allErpColumns = useMemo(() => {
    const keys = new Set<string>();
    for (const farm of farms) {
      if (farm.raw) {
        for (const key of Object.keys(farm.raw)) {
          if (!key.startsWith('_')) {
            keys.add(key);
          }
        }
      }
    }
    return Array.from(keys);
  }, [farms]);

  // Arabic Region Table with farm count inside each valid Egyptian area + spatial count of farms around it
  const arabicRegionRows: ArabicRegionRow[] = useMemo(() => {
    const groups = new Map<
      string,
      {
        areaName: string;
        markaz: string;
        governorate: string;
        farmCount: number;
        totalArea: number;
        lats: number[];
        lons: number[];
      }
    >();

    for (const farm of filteredFarms) {
      if (
        farm.outOfEgypt ||
        farm.lat === null ||
        farm.lon === null ||
        farm.governorate === 'خارج مصر' ||
        farm.markaz === 'خارج مصر'
      ) {
        continue;
      }

      if (!farm.governorate && !farm.markaz) {
        continue;
      }

      const gov = farm.governorate || 'غير محدد';
      const mkz = farm.markaz || gov;
      const areaName =
        farm.village && farm.village !== 'غير محدد'
          ? farm.village
          : mkz !== 'غير محدد'
            ? mkz
            : gov;

      const key = `${gov}__${mkz}__${areaName}`;
      const existing = groups.get(key);
      if (existing) {
        existing.farmCount += 1;
        existing.totalArea += farm.area ?? 0;
        existing.lats.push(farm.lat);
        existing.lons.push(farm.lon);
      } else {
        groups.set(key, {
          areaName,
          markaz: mkz,
          governorate: gov,
          farmCount: 1,
          totalArea: farm.area ?? 0,
          lats: [farm.lat],
          lons: [farm.lon],
        });
      }
    }

    const coordPoints = filteredFarms.filter(
      (f): f is FarmRecord & { lat: number; lon: number } =>
        f.lat !== null &&
        f.lon !== null &&
        !f.outOfEgypt &&
        f.governorate !== 'خارج مصر' &&
        f.markaz !== 'خارج مصر',
    );

    const rows: ArabicRegionRow[] = [];
    for (const [key, g] of groups.entries()) {
      const centerLat =
        g.lats.length > 0 ? g.lats.reduce((a, b) => a + b, 0) / g.lats.length : null;
      const centerLon =
        g.lons.length > 0 ? g.lons.reduce((a, b) => a + b, 0) / g.lons.length : null;

      let nearbyCount = 0;
      if (centerLat !== null && centerLon !== null) {
        for (const pt of coordPoints) {
          if (haversineKm(centerLat, centerLon, pt.lat, pt.lon) <= nearbyRadiusKm) {
            nearbyCount += 1;
          }
        }
      }

      rows.push({
        key,
        areaName: g.areaName,
        markaz: g.markaz,
        governorate: g.governorate,
        farmCount: g.farmCount,
        nearbyCount,
        totalArea: g.totalArea,
        centerLat,
        centerLon,
      });
    }

    return rows.sort((a, b) => b.farmCount - a.farmCount || b.nearbyCount - a.nearbyCount);
  }, [filteredFarms, nearbyRadiusKm]);

  const metrics = useMemo(() => {
    const withValidCoords = filteredFarms.filter(
      (f) => f.lat !== null && f.lon !== null && !f.outOfEgypt,
    ).length;
    const withoutCoords = filteredFarms.filter(
      (f) => (f.lat === null || f.lon === null) && !f.outOfEgypt,
    ).length;
    const excludedOutOfEgypt = filteredFarms.filter((f) => Boolean(f.outOfEgypt)).length;
    const mapped = filteredFarms.filter(
      (f) =>
        !f.outOfEgypt &&
        f.markaz &&
        f.markaz !== 'غير محدد' &&
        f.markaz !== 'خارج مصر',
    ).length;
    const distinctRegions = new Set(
      filteredFarms
        .filter(
          (f) =>
            !f.outOfEgypt &&
            f.markaz &&
            f.markaz !== 'غير محدد' &&
            f.markaz !== 'خارج مصر',
        )
        .map((f) => `${f.governorate}_${f.markaz}`),
    ).size;

    const withAreaCount = filteredFarms.filter((f) => f.area !== null).length;
    const totalArea = filteredFarms.reduce((sum, f) => sum + (f.area ?? 0), 0);

    const rangeLabel =
      fromDate && toDate
        ? `من ${fromDate} إلى ${toDate}`
        : fromDate
          ? `من ${fromDate}`
          : toDate
            ? `حتى ${toDate}`
            : 'كل الفترات · جميع السجلات';

    return [
      {
        label: 'إجمالي المزارع',
        value: String(filteredFarms.length),
        detail: `${rangeLabel} · ${allErpColumns.length} حقل`,
      },
      {
        label: 'إجمالي المساحة',
        value: totalArea.toLocaleString('en-US', { maximumFractionDigits: 2 }),
        detail: `${withAreaCount} مزرعة بمساحة مسجلة${schemaInfo.areaField ? ` (${schemaInfo.areaField})` : ''}`,
      },
      {
        label: 'مزارع على خريطة مصر',
        value: String(withValidCoords),
        detail: `${withoutCoords} بدون إحداثيات${excludedOutOfEgypt > 0 ? ` · ${excludedOutOfEgypt} خارج مصر` : ''}`,
      },
      {
        label: 'المراكز والمحافظات',
        value: String(distinctRegions),
        detail: `${mapped} مزرعة تم ربطها بمركز${withValidCoords > mapped ? ` (${withValidCoords - mapped} قيد التحديد)` : ''}`,
      },
    ];
  }, [allErpColumns.length, filteredFarms, fromDate, schemaInfo.areaField, toDate]);

  const googleEarthOverviewUrl = useMemo(() => {
    if (mapFocus) {
      return buildGoogleEarthUrl(mapFocus.lat, mapFocus.lng, 35000);
    }
    if (mapFarms.length > 0) {
      const avgLat = mapFarms.reduce((sum, f) => sum + f.lat, 0) / mapFarms.length;
      const avgLon = mapFarms.reduce((sum, f) => sum + f.lon, 0) / mapFarms.length;
      return buildGoogleEarthUrl(avgLat, avgLon, mapFarms.length === 1 ? 1500 : 850000);
    }
    return buildGoogleEarthUrl(26.8206, 30.8025, 1200000);
  }, [mapFarms, mapFocus]);

  const buildExportRows = () => {
    return filteredFarms.map((f) => {
      const hasValidCoords = !f.outOfEgypt && f.lat !== null && f.lon !== null;
      const row: Record<string, string | number | boolean> = {
        ID_المزرعة: f.id,
        اسم_المزرعة: f.name,
        المساحة: f.area ?? '',
        وحدة_المساحة: f.areaUnit || '',
        المحافظة: f.governorate || '',
        المركز: f.markaz || '',
        القرية_المنطقة: f.village || '',
        خط_العرض_Lat: hasValidCoords ? (f.lat as number) : '',
        خط_الطول_Lon: hasValidCoords ? (f.lon as number) : '',
        رابط_Google_Earth: hasValidCoords ? buildGoogleEarthUrl(f.lat as number, f.lon as number) : '',
      };
      if (f.raw && allErpColumns.length > 0) {
        for (const col of allErpColumns) {
          const val = f.raw[col];
          row[col] = val === null || val === undefined ? '' : val;
        }
      } else {
        row.type = f.type;
        row.status = f.status;
        row.creation = f.creation;
      }
      return row;
    });
  };

  const handleExportExcel = () => {
    if (filteredFarms.length === 0) return;
    const allRows = buildExportRows();
    const summaryRows = arabicRegionRows.map((item) => ({
      المنطقة: item.areaName,
      المركز: item.markaz,
      المحافظة: item.governorate,
      عدد_المزارع_بالمنطقة: item.farmCount,
      [`عدد_المزارع_في_محيط_${nearbyRadiusKm}_كم`]: item.nearbyCount,
      إجمالي_المساحة: Number(item.totalArea.toFixed(2)),
    }));

    const workbook = XLSX.utils.book_new();
    workbook.Workbook = { Views: [{ RTL: true }] };
    const sheetAll = XLSX.utils.json_to_sheet(allRows);
    const sheetSummary = XLSX.utils.json_to_sheet(summaryRows);

    XLSX.utils.book_append_sheet(workbook, sheetAll, 'كل_المزارع');
    XLSX.utils.book_append_sheet(workbook, sheetSummary, 'المناطق_والمراكز');
    XLSX.writeFile(workbook, 'Sekem_Farms_Egypt.xlsx');
  };

  const handleExportKml = (targetFarms?: FarmRecord[], customFilename?: string) => {
    const source = targetFarms ?? filteredFarms;
    const validCount = source.filter(
      (f) =>
        !f.outOfEgypt &&
        f.lat !== null &&
        f.lon !== null &&
        f.governorate !== 'خارج مصر' &&
        f.markaz !== 'خارج مصر',
    ).length;

    if (validCount === 0) {
      setGeocodeMessage('لا توجد مزارع بإحداثيات صحيحة داخل مصر لتصديرها إلى ملف KML.');
      return;
    }

    const docTitle = customFilename ? `مزرعة سيكم - ${source[0]?.name || ''}` : 'خريطة مزارع سيكم في مصر';
    const kmlContent = buildKmlDocument(source, docTitle);
    const blob = new Blob([kmlContent], {
      type: 'application/vnd.google-earth.kml+xml;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = customFilename || 'Sekem_Farms_Egypt.kml';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportCsv = () => {
    if (filteredFarms.length === 0) return;
    const rows = buildExportRows();
    const headers = Object.keys(rows[0] || {});
    const csv = [
      headers,
      ...rows.map((r) => headers.map((h) => String(r[h] ?? ''))),
    ]
      .map((line) => line.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Sekem_Farms_Egypt.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const renderArabicRegionsTable = () => (
    <section className="bg-white border border-slate-200 rounded-lg overflow-hidden text-right">
      <div className="px-6 py-4 border-b border-slate-200 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            جدول المناطق والمراكز وعدد المزارع
          </h2>
          <p className="text-xs text-slate-500">
            اضغط على أي صف للانتقال مباشرة إلى المنطقة على الخريطة ({arabicRegionRows.length} منطقة)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="nearby-radius" className="text-xs font-medium text-slate-600 whitespace-nowrap">
            نطاق المزارع المحيطة:
          </label>
          <select
            id="nearby-radius"
            value={nearbyRadiusKm}
            onChange={(e) => setNearbyRadiusKm(Number(e.target.value))}
            className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-900 font-mono"
          >
            <option value={5}>5 كم</option>
            <option value={10}>10 كم</option>
            <option value={25}>25 كم</option>
            <option value={50}>50 كم</option>
          </select>
        </div>
      </div>

      {arabicRegionRows.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm text-slate-600">
          لا توجد مزارع محملة حالياً لعرض جدول المناطق والمراكز.
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[520px]">
          <table className="w-full text-right border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="px-4 py-3">المنطقة / القرية</th>
                <th className="px-4 py-3">المركز</th>
                <th className="px-4 py-3">المحافظة</th>
                <th className="px-4 py-3 text-left">المزارع</th>
                <th className="px-4 py-3 text-left">المساحة</th>
                <th className="px-4 py-3 text-left">حولها ({nearbyRadiusKm} كم)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {arabicRegionRows.map((row) => (
                <tr
                  key={row.key}
                  onClick={() => {
                    if (row.centerLat !== null && row.centerLon !== null) {
                      setMapFocus({ lat: row.centerLat, lng: row.centerLon, zoom: 11 });
                      if (activeSection === 'markaz') {
                        setActiveSection('map');
                      }
                    }
                  }}
                  className={`transition-colors ${
                    row.centerLat !== null ? 'hover:bg-emerald-50/60 cursor-pointer' : ''
                  }`}
                >
                  <td className="px-4 py-3 font-medium text-slate-900">{row.areaName}</td>
                  <td className="px-4 py-3 text-slate-700">{row.markaz}</td>
                  <td className="px-4 py-3 text-slate-700">{row.governorate}</td>
                  <td className="px-4 py-3 text-left font-mono tabular-nums font-semibold text-slate-900">
                    {row.farmCount}
                  </td>
                  <td className="px-4 py-3 text-left font-mono tabular-nums text-slate-700">
                    {row.totalArea > 0
                      ? row.totalArea.toLocaleString('en-US', { maximumFractionDigits: 2 })
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-left font-mono tabular-nums font-semibold text-emerald-700">
                    {row.centerLat !== null ? row.nearbyCount : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  return (
    <div dir="rtl" className="min-h-screen flex flex-col bg-slate-50 text-slate-900 text-right">
      {/* Demo Key Quota Banner (renders only on gmp-quota-exceeded event) */}
      {quotaExceeded && (
        <div
          dir="ltr"
          className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm"
        >
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#overview"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('overview');
            }}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 rounded"
          >
            خريطة مزارع سيكم
          </a>

          <nav aria-label="التنقل الرئيسي" className="hidden md:flex items-center gap-6">
            {NAV_ITEMS.map((item) => {
              const isActive = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSection(item.id)}
                  className={`py-1.5 text-sm font-medium transition-colors duration-150 whitespace-nowrap shrink-0 border-b-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 ${
                    isActive
                      ? 'text-slate-900 border-slate-900'
                      : 'text-slate-600 border-transparent hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            {session.connected ? (
              <>
                <button
                  type="button"
                  onClick={handleExportExcel}
                  disabled={filteredFarms.length === 0}
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
                >
                  <FileSpreadsheet className="w-4 h-4" aria-hidden="true" />
                  <span>تصدير إكسيل</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportKml()}
                  disabled={mapFarms.length === 0}
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 disabled:opacity-50 transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2"
                >
                  <Globe className="w-4 h-4" aria-hidden="true" />
                  <span>تصدير KML</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setActiveSection('account')}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
              >
                <LogIn className="w-4 h-4" aria-hidden="true" />
                <span>تسجيل الدخول</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-6 py-8 space-y-8">
        {!session.checked ? (
          <section className="bg-white border border-slate-200 rounded-lg p-8 text-sm text-slate-600">
            جاري التحقق من حالة الاتصال بنظام ERPNext...
          </section>
        ) : !session.connected || activeSection === 'account' ? (
          <section className="max-w-xl mx-auto bg-white border border-slate-200 rounded-lg p-6 sm:p-8 space-y-6">
            <div className="space-y-1">
              <p dir="ltr" className="text-xs font-mono text-slate-500 text-right">
                {session.erpUrl}
              </p>
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">
                {session.connected ? 'متصل بنظام ERPNext' : 'تسجيل الدخول إلى نظام سيكم (ERPNext)'}
              </h1>
              <p className="text-sm text-slate-600">
                {session.connected
                  ? 'تم توثيق الجلسة بنجاح عبر الخادم الوسيط الآمن.'
                  : 'أدخل اسم المستخدم أو البريد الإلكتروني وكلمة المرور لسحب جميع المزارع وعرضها على الخريطة.'}
              </p>
            </div>

            {session.connected ? (
              <div className="space-y-5">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-1 text-sm">
                  <p className="font-medium text-slate-900">{session.fullName || session.userId}</p>
                  <p className="text-slate-600 font-mono text-xs">{session.userId}</p>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setActiveSection('overview')}
                    className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors duration-150"
                  >
                    فتح لوحة المزارع والخريطة
                  </button>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors duration-150"
                  >
                    <LogOut className="w-4 h-4" aria-hidden="true" />
                    <span>تسجيل الخروج</span>
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="erp-usr" className="block text-sm font-medium text-slate-700">
                    البريد الإلكتروني أو اسم المستخدم
                  </label>
                  <input
                    id="erp-usr"
                    type="text"
                    required
                    autoComplete="username"
                    dir="ltr"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="user@sekem.com"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="erp-pwd" className="block text-sm font-medium text-slate-700">
                    كلمة المرور
                  </label>
                  <input
                    id="erp-pwd"
                    type="password"
                    required
                    autoComplete="current-password"
                    dir="ltr"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                  />
                </div>

                {authError && (
                  <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {authError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={authLoading}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60 transition-colors duration-150"
                >
                  <LogIn className="w-4 h-4" aria-hidden="true" />
                  <span>{authLoading ? 'جاري تسجيل الدخول...' : 'دخول وسحب كافة المزارع'}</span>
                </button>
              </form>
            )}
          </section>
        ) : (
          <>
            {/* Connected Toolbar */}
            <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-500">
                  {session.erpUrl} · المستخدم: {session.fullName || session.userId}
                </p>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900 text-balance">
                  لوحة متابعة المزارع والمراكز
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="date"
                  aria-label="من تاريخ (اختياري)"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 font-mono"
                />
                <input
                  type="date"
                  aria-label="إلى تاريخ (اختياري)"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 font-mono"
                />
                {(fromDate || toDate) && (
                  <button
                    type="button"
                    onClick={() => {
                      setFromDate('');
                      setToDate('');
                    }}
                    className="px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors duration-150 whitespace-nowrap"
                  >
                    كل التواريخ
                  </button>
                )}

                <label className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={excludeCancelled}
                    onChange={(e) => setExcludeCancelled(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span className="whitespace-nowrap">استبعاد الملغى</span>
                </label>

                <button
                  type="button"
                  onClick={() => void fetchFarms()}
                  disabled={farmsLoading}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-900 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 transition-colors duration-150 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`w-4 h-4 ${farmsLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                  <span>{farmsLoading ? 'جاري التحديث...' : 'تحديث كل المزارع'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void resolveMarkazForList(farms)}
                  disabled={geocoding || farms.length === 0}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50 transition-colors duration-150 whitespace-nowrap shrink-0"
                >
                  <MapPin className="w-4 h-4" aria-hidden="true" />
                  <span>{geocoding ? 'جاري تحديد المراكز...' : 'تحديد المراكز بالعربي'}</span>
                </button>
              </div>
            </section>

            {farmsError && (
              <div role="alert" className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {farmsError}
              </div>
            )}

            {farms.length > 0 && mapFarms.length === 0 && !farmsLoading && (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
                تم سحب {farms.length} مزرعة من ERPNext، ولكن لم يتم العثور على إحداثيات GPS صحيحة داخل حدود مصر لهذه المزارع. اضغط على أي مزرعة في الجدول بالأسفل لفحص حقول الإحداثيات في ERPNext.
              </div>
            )}

            {outOfEgyptFarms.length > 0 && !farmsLoading && (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-950 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  تم استبعاد {outOfEgyptFarms.length} مزرعة من الخريطة وجدول المراكز لأن إحداثياتها المسجلة في ERPNext تقع خارج حدود مصر (أو مسجلة بشكل غير صحيح).
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setShowOnlyOutOfEgypt((prev) => !prev);
                    setActiveSection('overview');
                  }}
                  className="px-3 py-1.5 text-xs font-medium bg-amber-900 text-white rounded-lg hover:bg-amber-800 whitespace-nowrap self-start sm:self-auto"
                >
                  {showOnlyOutOfEgypt ? 'إظهار جميع المزارع' : `فحص المزارع المستبعدة (${outOfEgyptFarms.length})`}
                </button>
              </div>
            )}

            {geocodeMessage && (
              <div className="p-4 bg-white border border-slate-200 rounded-lg text-sm text-slate-700">
                {geocodeMessage}
              </div>
            )}

            {/* Metrics Grid */}
            <section aria-label="ملخص المزارع" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {metrics.map((metric) => (
                <div key={metric.label} className="bg-white border border-slate-200 rounded-lg p-5 space-y-2">
                  <p className="text-sm font-medium text-slate-600">{metric.label}</p>
                  <p className="text-3xl font-semibold tracking-tight text-slate-900 font-mono tabular-nums">
                    {metric.value}
                  </p>
                  <p className="text-xs text-slate-500">{metric.detail}</p>
                </div>
              ))}
            </section>

            {activeSection === 'markaz' ? (
              renderArabicRegionsTable()
            ) : (
              <>
                {/* Interactive Google Map + Arabic Regions Table */}
                <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
                  <div className="xl:col-span-7 bg-white border border-slate-200 rounded-lg p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3 px-1">
                      <div>
                        <h2 className="text-base font-semibold text-slate-900">خريطة مواقع المزارع</h2>
                        <p className="text-xs text-slate-500">
                          {mapFarms.length} مزرعة على الخريطة · يمكنك التبديل إلى القمر الصناعي أو فتحها في Google Earth
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {mapFocus && (
                          <button
                            type="button"
                            onClick={() => setMapFocus(null)}
                            className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap"
                          >
                            عرض كل المزارع
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleExportKml()}
                          disabled={mapFarms.length === 0}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg disabled:opacity-50 whitespace-nowrap"
                        >
                          <Download className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>ملف KML لـ Google Earth</span>
                        </button>
                        <a
                          href={googleEarthOverviewUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg whitespace-nowrap"
                        >
                          <Globe className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>فتح في Google Earth</span>
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      </div>
                    </div>

                    <FarmsMap
                      apiKey={mapsApiKey}
                      farms={mapFarms}
                      focusLocation={mapFocus}
                      onInspectFarm={(farmId) => void handleOpenFarmDetails(farmId)}
                    />
                  </div>

                  <div className="xl:col-span-5">{renderArabicRegionsTable()}</div>
                </section>

                {/* All Farms Data Table */}
                {activeSection === 'overview' && (
                  <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                    <div className="px-6 py-4 border-b border-slate-200 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <h2 className="text-base font-semibold text-slate-900">
                          بيانات جميع المزارع ({filteredFarms.length})
                        </h2>
                        <p className="text-xs text-slate-500">
                          مصدر ERPNext: <span className="font-mono">Farm</span> · حقل الاسم:{' '}
                          <span className="font-mono text-slate-700">{schemaInfo.nameField || 'name'}</span> · حقل المساحة:{' '}
                          <span className="font-mono text-slate-700">{schemaInfo.areaField || 'غير مكتشف'}</span> · إجمالي الحقول:{' '}
                          <span className="font-mono text-slate-700">{allErpColumns.length}</span>
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative">
                          <Search
                            className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
                            aria-hidden="true"
                          />
                          <input
                            type="search"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="ابحث بالـ ID أو الاسم أو المركز..."
                            aria-label="ابحث في كل الحقول"
                            className="w-60 pr-9 pl-3 py-1.5 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                          />
                        </div>

                        <div
                          role="group"
                          aria-label="طريقة عرض الجدول"
                          className="inline-flex items-center p-1 bg-slate-100 border border-slate-200 rounded-lg"
                        >
                          <button
                            type="button"
                            onClick={() => setTableView('compact')}
                            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                              tableView === 'compact'
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            ملخص
                          </button>
                          <button
                            type="button"
                            onClick={() => setTableView('all-fields')}
                            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                              tableView === 'all-fields'
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            كل الحقول ({allErpColumns.length})
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={handleExportExcel}
                          disabled={filteredFarms.length === 0}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-900 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                        >
                          <FileSpreadsheet className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Excel</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleExportKml()}
                          disabled={mapFarms.length === 0}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 disabled:opacity-50 whitespace-nowrap"
                        >
                          <Globe className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>KML</span>
                        </button>

                        <button
                          type="button"
                          onClick={handleExportCsv}
                          disabled={filteredFarms.length === 0}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                        >
                          <Download className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>CSV</span>
                        </button>
                      </div>
                    </div>

                    {farmsLoading ? (
                      <div className="px-6 py-12 text-center text-sm text-slate-600">
                        جاري سحب كل بيانات المزارع من ERPNext...
                      </div>
                    ) : filteredFarms.length === 0 ? (
                      <div className="px-6 py-12 text-center space-y-3">
                        <p className="text-sm text-slate-600">لا توجد مزارع مطابقة للبحث أو الفلتر الحالي.</p>
                        {searchQuery && (
                          <button
                            type="button"
                            onClick={() => setSearchQuery('')}
                            className="px-4 py-2 text-sm font-medium text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg"
                          >
                            مسح البحث
                          </button>
                        )}
                      </div>
                    ) : tableView === 'all-fields' ? (
                      <div className="overflow-x-auto max-h-[600px]">
                        <table className="w-full text-right border-collapse">
                          <thead className="sticky top-0 z-10">
                            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                              <th className="px-4 py-3 whitespace-nowrap">ID المزرعة</th>
                              <th className="px-4 py-3 whitespace-nowrap">اسم المزرعة</th>
                              <th className="px-4 py-3 whitespace-nowrap">المساحة</th>
                              <th className="px-4 py-3 whitespace-nowrap">المحافظة</th>
                              <th className="px-4 py-3 whitespace-nowrap">المركز</th>
                              <th className="px-4 py-3 whitespace-nowrap">القرية_المنطقة</th>
                              {allErpColumns.map((col) => (
                                <th
                                  key={col}
                                  className="px-4 py-3 whitespace-nowrap font-mono"
                                  title={schemaInfo.fieldLabels[col] || col}
                                >
                                  <div>{schemaInfo.fieldLabels[col] || col}</div>
                                  {schemaInfo.fieldLabels[col] && schemaInfo.fieldLabels[col] !== col && (
                                    <div className="text-[10px] font-normal text-slate-400">{col}</div>
                                  )}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 text-xs">
                            {filteredFarms.map((farm) => (
                              <tr
                                key={farm.id}
                                onClick={() => void handleOpenFarmDetails(farm)}
                                className="hover:bg-slate-50 transition-colors cursor-pointer"
                              >
                                <td className="px-4 py-2.5 whitespace-nowrap font-mono font-medium text-slate-900">
                                  {farm.id}
                                </td>
                                <td className="px-4 py-2.5 whitespace-nowrap font-medium text-slate-900">
                                  {farm.name}
                                </td>
                                <td className="px-4 py-2.5 whitespace-nowrap font-mono tabular-nums text-slate-800">
                                  {farm.area !== null
                                    ? `${farm.area.toLocaleString('en-US', { maximumFractionDigits: 2 })}${farm.areaUnit ? ` ${farm.areaUnit}` : ''}`
                                    : '—'}
                                </td>
                                <td className="px-4 py-2.5 whitespace-nowrap font-medium text-slate-900">
                                  {farm.governorate || '—'}
                                </td>
                                <td className="px-4 py-2.5 whitespace-nowrap text-slate-700">
                                  {farm.markaz || '—'}
                                </td>
                                <td className="px-4 py-2.5 whitespace-nowrap text-slate-700">
                                  {farm.village || '—'}
                                </td>
                                {allErpColumns.map((col) => {
                                  const val = farm.raw?.[col];
                                  return (
                                    <td
                                      key={col}
                                      className="px-4 py-2.5 whitespace-nowrap max-w-[240px] truncate text-slate-700 font-mono"
                                      title={val !== null && val !== undefined ? String(val) : ''}
                                    >
                                      {val !== null && val !== undefined && val !== '' ? String(val) : '—'}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="overflow-x-auto max-h-[600px]">
                        <table className="w-full text-right border-collapse">
                          <thead className="sticky top-0 z-10">
                            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                              <th className="px-5 py-3">ID المزرعة</th>
                              <th className="px-5 py-3">اسم المزرعة</th>
                              <th className="px-5 py-3 text-left">المساحة</th>
                              <th className="px-5 py-3">المنطقة / المركز / المحافظة</th>
                              <th className="px-5 py-3 text-left">الإحداثيات</th>
                              <th className="px-5 py-3">الحالة</th>
                              <th className="px-5 py-3">التفاصيل</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 text-sm">
                            {filteredFarms.map((farm) => (
                              <tr
                                key={farm.id}
                                onClick={() => void handleOpenFarmDetails(farm)}
                                className="hover:bg-slate-50 transition-colors cursor-pointer"
                              >
                                <td className="px-5 py-3 font-mono text-xs font-semibold text-slate-900 whitespace-nowrap">
                                  <div>{farm.id}</div>
                                  {farm.code && (
                                    <div className="text-[11px] font-normal text-slate-500">كود: {farm.code}</div>
                                  )}
                                </td>
                                <td className="px-5 py-3">
                                  <div className="font-medium text-slate-900">{farm.name}</div>
                                  <div className="text-xs text-slate-500 font-mono tabular-nums">
                                    {farm.creation}
                                    {farm.type ? ` · ${farm.type}` : ''}
                                  </div>
                                </td>
                                <td className="px-5 py-3 text-left font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                                  {farm.area !== null
                                    ? `${farm.area.toLocaleString('en-US', { maximumFractionDigits: 2 })}${farm.areaUnit ? ` ${farm.areaUnit}` : ''}`
                                    : '—'}
                                </td>
                                <td className="px-5 py-3 text-slate-700">
                                  {farm.outOfEgypt
                                    ? 'إحداثيات خارج مصر (مستبعدة من الخريطة)'
                                    : farm.markaz
                                      ? `${farm.village && farm.village !== 'غير محدد' ? `${farm.village} · ` : ''}${farm.markaz} · ${farm.governorate || ''}`
                                      : farm.lat !== null
                                        ? 'جاري التحديد...'
                                        : 'بدون إحداثيات'}
                                </td>
                                <td
                                  dir="ltr"
                                  className="px-5 py-3 text-left font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap"
                                >
                                  {farm.lat !== null && farm.lon !== null
                                    ? `${farm.lat.toFixed(4)}, ${farm.lon.toFixed(4)}`
                                    : farm.outOfEgypt && farm.rawLat != null && farm.rawLon != null
                                      ? `${farm.rawLat.toFixed(4)}, ${farm.rawLon.toFixed(4)} (خارج مصر)`
                                      : '—'}
                                </td>
                                <td className="px-5 py-3 text-xs font-medium text-slate-700 whitespace-nowrap">
                                  {farm.status}
                                </td>
                                <td className="px-5 py-3 whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleOpenFarmDetails(farm);
                                    }}
                                    className="px-2.5 py-1 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md"
                                  >
                                    كل التفاصيل
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </>
        )}
      </main>

      {/* Full Farm Document Drawer */}
      {selectedFarm && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 flex justify-start"
          onClick={() => setSelectedFarm(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`البيانات الكاملة للمزرعة ${selectedFarm.name}`}
            className="w-full max-w-2xl bg-white h-full overflow-y-auto border-r border-slate-200 p-6 space-y-6 text-right"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
              <div className="space-y-1">
                <p className="text-xs font-mono text-slate-500">{selectedFarm.id}</p>
                <h2 className="text-lg font-semibold text-slate-900">{selectedFarm.name}</h2>
                {selectedFarm.markaz && (
                  <p className="text-xs text-slate-600">
                    {selectedFarm.governorate} · {selectedFarm.markaz} · {selectedFarm.village}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedFarm(null)}
                aria-label="إغلاق تفاصيل المزرعة"
                className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3.5 text-xs">
              <div>
                <p className="text-slate-500">ID المزرعة</p>
                <p className="font-mono font-semibold text-slate-900 mt-0.5 break-all">{selectedFarm.id}</p>
              </div>
              <div>
                <p className="text-slate-500">اسم المزرعة</p>
                <p className="font-semibold text-slate-900 mt-0.5">{selectedFarm.name}</p>
              </div>
              <div>
                <p className="text-slate-500">المساحة</p>
                <p className="font-mono font-semibold text-slate-900 mt-0.5">
                  {selectedFarm.area !== null
                    ? `${selectedFarm.area.toLocaleString('en-US', { maximumFractionDigits: 2 })}${selectedFarm.areaUnit ? ` ${selectedFarm.areaUnit}` : ''}`
                    : 'غير مسجلة'}
                </p>
              </div>
            </div>

            {!selectedFarm.outOfEgypt && selectedFarm.lat !== null && selectedFarm.lon !== null && (
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={buildGoogleEarthUrl(selectedFarm.lat, selectedFarm.lon, 1500)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors"
                >
                  <Globe className="w-4 h-4" aria-hidden="true" />
                  <span>فتح موقع المزرعة في Google Earth</span>
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                </a>
                <button
                  type="button"
                  onClick={() =>
                    handleExportKml(
                      [selectedFarm],
                      `Farm_${selectedFarm.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.kml`,
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  <Download className="w-4 h-4" aria-hidden="true" />
                  <span>تنزيل KML للمزرعة</span>
                </button>
              </div>
            )}

            {detailsLoading ? (
              <p className="text-sm text-slate-600">جاري تحميل كل بيانات المزرعة والجداول الفرعية...</p>
            ) : detailsError ? (
              <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                {detailsError}
              </p>
            ) : (
              <div className="space-y-6">
                {(() => {
                  const source = farmDetails || selectedFarm.raw || {};
                  const scalarEntries = Object.entries(source).filter(
                    ([k, v]) => !k.startsWith('_') && !Array.isArray(v),
                  );
                  const childTables = Object.entries(source).filter(
                    ([k, v]) => !k.startsWith('_') && Array.isArray(v),
                  ) as [string, Record<string, unknown>[]][];

                  return (
                    <>
                      <div className="space-y-2">
                        <h3 className="text-sm font-semibold text-slate-900">
                          جميع الحقول ({scalarEntries.length})
                        </h3>
                        <div className="border border-slate-200 rounded-lg divide-y divide-slate-200">
                          {scalarEntries.map(([key, value]) => (
                            <div
                              key={key}
                              className="px-4 py-2.5 grid grid-cols-3 gap-4 text-xs"
                            >
                              <div className="text-right">
                                {schemaInfo.fieldLabels[key] && (
                                  <div className="font-medium text-slate-700">
                                    {schemaInfo.fieldLabels[key]}
                                  </div>
                                )}
                                <span dir="ltr" className="font-mono text-slate-400 break-all block text-left">
                                  {key}
                                </span>
                              </div>
                              <span className="col-span-2 text-slate-900 break-words font-mono">
                                {value === null || value === undefined || value === ''
                                  ? '—'
                                  : typeof value === 'object'
                                    ? JSON.stringify(value)
                                    : String(value)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {childTables.map(([tableName, rows]) => (
                        <div key={tableName} className="space-y-2">
                          <h3 className="text-sm font-semibold text-slate-900 font-mono">
                            {tableName} ({rows.length})
                          </h3>
                          {rows.length === 0 ? (
                            <p className="text-xs text-slate-500">جدول فارغ</p>
                          ) : (
                            <div className="overflow-x-auto border border-slate-200 rounded-lg">
                              <table className="w-full text-right border-collapse text-xs">
                                <thead>
                                  <tr className="bg-slate-50 border-b border-slate-200">
                                    {Object.keys(rows[0] || {})
                                      .filter((k) => !k.startsWith('_'))
                                      .map((col) => (
                                        <th key={col} className="px-3 py-2 font-mono text-slate-600 whitespace-nowrap">
                                          {col}
                                        </th>
                                      ))}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-200">
                                  {rows.map((r, idx) => (
                                    <tr key={idx}>
                                      {Object.keys(rows[0] || {})
                                        .filter((k) => !k.startsWith('_'))
                                        .map((col) => (
                                          <td key={col} className="px-3 py-2 font-mono text-slate-800 whitespace-nowrap">
                                            {r[col] === null || r[col] === undefined ? '—' : String(r[col])}
                                          </td>
                                        ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      ))}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
