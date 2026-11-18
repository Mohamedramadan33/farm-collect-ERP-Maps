/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, LogIn, LogOut, MapPin, RefreshCw, Search, X } from 'lucide-react';
import * as XLSX from 'xlsx';

type NavSection = 'overview' | 'markaz' | 'account';
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
  name: string;
  type: string;
  status: string;
  creation: string;
  area: number | null;
  lat: number | null;
  lon: number | null;
  cacheKey: string | null;
  governorate: string | null;
  markaz: string | null;
  village: string | null;
  raw?: Record<string, string | number | boolean | null>;
}

const NAV_ITEMS: { id: NavSection; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'markaz', label: 'Markaz Summary' },
  { id: 'account', label: 'ERP Connection' },
];

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('overview');
  const [tableView, setTableView] = useState<TableDensity>('compact');
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [session, setSession] = useState<ErpSessionState>({
    checked: false,
    connected: false,
    erpUrl: 'https://erp-sys.sekem.com',
  });

  // Login form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Farms & filter state (empty dates = pull ALL farms across all time)
  const [farms, setFarms] = useState<FarmRecord[]>([]);
  const [farmsLoading, setFarmsLoading] = useState(false);
  const [farmsError, setFarmsError] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [excludeCancelled, setExcludeCancelled] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Markaz geocoding state
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeMessage, setGeocodeMessage] = useState<string | null>(null);

  // Selected farm full details drawer
  const [selectedFarm, setSelectedFarm] = useState<FarmRecord | null>(null);
  const [farmDetails, setFarmDetails] = useState<Record<string, unknown> | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

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

  const fetchFarms = useCallback(
    async (tokenOverride?: string | null) => {
      setFarmsLoading(true);
      setFarmsError(null);
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
          error?: string;
        };

        if (!resp.ok) {
          if (resp.status === 401) {
            setSession((prev) => ({ ...prev, connected: false }));
          }
          throw new Error(data.error || `Failed to load farms (${resp.status})`);
        }

        setFarms(Array.isArray(data.farms) ? data.farms : []);
      } catch (error) {
        setFarmsError(error instanceof Error ? error.message : 'Unable to fetch farms from ERPNext.');
      } finally {
        setFarmsLoading(false);
      }
    },
    [excludeCancelled, fromDate, sessionToken, toDate],
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
        throw new Error(data.error || 'ERPNext sign-in failed.');
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
      setAuthError(error instanceof Error ? error.message : 'Unable to sign in to ERPNext.');
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

  const handleOpenFarmDetails = async (farm: FarmRecord) => {
    setSelectedFarm(farm);
    setFarmDetails(null);
    setDetailsError(null);
    setDetailsLoading(true);
    try {
      const resp = await fetch(`/api/erp/farms/${encodeURIComponent(farm.id)}`, {
        credentials: 'include',
        headers: authHeaders(),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        farm?: Record<string, unknown>;
        error?: string;
      };
      if (!resp.ok) {
        throw new Error(data.error || `Failed to load details (${resp.status})`);
      }
      setFarmDetails(data.farm || {});
    } catch (error) {
      setDetailsError(error instanceof Error ? error.message : 'Could not load full farm document.');
    } finally {
      setDetailsLoading(false);
    }
  };

  const handleResolveMarkaz = async () => {
    const unresolved = farms
      .filter((f) => f.lat !== null && f.lon !== null && (!f.markaz || !f.governorate))
      .map((f) => ({ lat: f.lat as number, lon: f.lon as number }));

    if (unresolved.length === 0) {
      setGeocodeMessage('All farms with valid coordinates are already mapped to a Markaz.');
      return;
    }

    setGeocoding(true);
    setGeocodeMessage(null);
    try {
      const resp = await fetch('/api/erp/geocode-markaz', {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ coordinates: unresolved }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        resolved?: Record<string, { governorate: string; markaz: string; village: string }>;
        newLookups?: number;
        remainingUncached?: number;
        error?: string;
      };

      if (!resp.ok) {
        throw new Error(data.error || 'Failed to resolve Markaz locations.');
      }

      const resolvedMap = data.resolved || {};
      setFarms((prev) =>
        prev.map((farm) => {
          if (farm.cacheKey && resolvedMap[farm.cacheKey]) {
            const entry = resolvedMap[farm.cacheKey];
            return {
              ...farm,
              governorate: entry.governorate,
              markaz: entry.markaz,
              village: entry.village,
            };
          }
          return farm;
        }),
      );

      if ((data.remainingUncached || 0) > 0) {
        setGeocodeMessage(
          `Mapped batch (${data.newLookups || 0} new lookups). ${data.remainingUncached} unique coordinate clusters remaining—click Group by Markaz again to continue.`,
        );
      } else {
        setGeocodeMessage(`Markaz grouping complete (${data.newLookups || 0} new Nominatim lookups cached).`);
      }
    } catch (error) {
      setGeocodeMessage(error instanceof Error ? error.message : 'Geocoding failed.');
    } finally {
      setGeocoding(false);
    }
  };

  const filteredFarms = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return farms;
    return farms.filter((f) => {
      if (
        f.name.toLowerCase().includes(q) ||
        f.id.toLowerCase().includes(q) ||
        (f.markaz || '').toLowerCase().includes(q) ||
        (f.governorate || '').toLowerCase().includes(q) ||
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
  }, [farms, searchQuery]);

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

  const markazSummary = useMemo(() => {
    const groups = new Map<string, { governorate: string; markaz: string; count: number; area: number }>();
    for (const farm of filteredFarms) {
      const gov = farm.governorate || 'Unmapped';
      const mkz = farm.markaz || 'Unmapped';
      const key = `${gov}__${mkz}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        existing.area += farm.area ?? 0;
      } else {
        groups.set(key, {
          governorate: gov,
          markaz: mkz,
          count: 1,
          area: farm.area ?? 0,
        });
      }
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count || b.area - a.area);
  }, [filteredFarms]);

  const metrics = useMemo(() => {
    const withCoords = filteredFarms.filter((f) => f.lat !== null && f.lon !== null).length;
    const mapped = filteredFarms.filter((f) => f.markaz && f.markaz !== 'Unmapped').length;
    const distinctMarkaz = new Set(
      filteredFarms.filter((f) => f.markaz).map((f) => `${f.governorate}_${f.markaz}`),
    ).size;

    const rangeLabel =
      fromDate && toDate
        ? `${fromDate} to ${toDate}`
        : fromDate
          ? `From ${fromDate}`
          : toDate
            ? `Up to ${toDate}`
            : 'All time · All records';

    return [
      {
        label: 'ERPNext Farms',
        value: String(filteredFarms.length),
        detail: `${rangeLabel} · ${allErpColumns.length} fields`,
      },
      {
        label: 'Valid Coordinates',
        value: String(withCoords),
        detail: `${filteredFarms.length - withCoords} missing lat/lng`,
      },
      {
        label: 'Districts (Markaz)',
        value: String(distinctMarkaz),
        detail: `${mapped} farms assigned`,
      },
      {
        label: 'Pending Geocoding',
        value: String(Math.max(0, withCoords - mapped)),
        detail: 'Cached in geocode_cache.json',
      },
    ];
  }, [allErpColumns.length, filteredFarms, fromDate, toDate]);

  const buildExportRows = () => {
    return filteredFarms.map((f) => {
      const row: Record<string, string | number | boolean> = {};
      if (f.raw && allErpColumns.length > 0) {
        for (const col of allErpColumns) {
          const val = f.raw[col];
          row[col] = val === null || val === undefined ? '' : val;
        }
      } else {
        row.id = f.id;
        row.name = f.name;
        row.type = f.type;
        row.status = f.status;
        row.creation = f.creation;
        row.latitude = f.lat ?? '';
        row.longitude = f.lon ?? '';
      }
      row['المحافظة'] = f.governorate || '';
      row['المركز'] = f.markaz || '';
      row['القرية_المنطقة'] = f.village || '';
      return row;
    });
  };

  const handleExportExcel = () => {
    if (filteredFarms.length === 0) return;
    const allRows = buildExportRows();
    const summaryRows = markazSummary.map((item) => ({
      المحافظة: item.governorate,
      المركز: item.markaz,
      عدد_المزارع: item.count,
      إجمالي_المساحة: Number(item.area.toFixed(2)),
    }));

    const workbook = XLSX.utils.book_new();
    const sheetAll = XLSX.utils.json_to_sheet(allRows);
    const sheetSummary = XLSX.utils.json_to_sheet(summaryRows);

    XLSX.utils.book_append_sheet(workbook, sheetAll, 'All_Farms_Mapped');
    XLSX.utils.book_append_sheet(workbook, sheetSummary, 'Markaz_Summary');
    XLSX.writeFile(workbook, 'Farms_By_Markaz.xlsx');
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
    link.download = 'Farms_By_Markaz.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#overview"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('overview');
            }}
            className="text-lg font-semibold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 rounded"
          >
            FieldMark
          </a>

          <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-6">
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

          <div className="flex items-center shrink-0">
            {session.connected ? (
              <button
                type="button"
                onClick={handleExportExcel}
                disabled={filteredFarms.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
              >
                <FileSpreadsheet className="w-4 h-4" aria-hidden="true" />
                <span>Export Excel</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setActiveSection('account')}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
              >
                <LogIn className="w-4 h-4" aria-hidden="true" />
                <span>Sign In to ERPNext</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-6 py-8 space-y-8">
        {!session.checked ? (
          <section className="bg-white border border-slate-200 rounded-lg p-8 text-sm text-slate-600">
            Checking ERPNext connection status...
          </section>
        ) : !session.connected || activeSection === 'account' ? (
          <section className="max-w-xl mx-auto bg-white border border-slate-200 rounded-lg p-6 sm:p-8 space-y-6">
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-500">{session.erpUrl}</p>
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">
                {session.connected ? 'ERPNext Session Connected' : 'Sign In to Sekem ERPNext'}
              </h1>
              <p className="text-sm text-slate-600">
                {session.connected
                  ? 'Your session is authenticated with ERPNext via the server proxy.'
                  : 'Enter your ERPNext username or email and password to pull all Farm records and fields.'}
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
                    Open Farm Dashboard
                  </button>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors duration-150"
                  >
                    <LogOut className="w-4 h-4" aria-hidden="true" />
                    <span>Sign Out</span>
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="erp-usr" className="block text-sm font-medium text-slate-700">
                    Email or Username
                  </label>
                  <input
                    id="erp-usr"
                    type="text"
                    required
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="user@sekem.com"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="erp-pwd" className="block text-sm font-medium text-slate-700">
                    Password
                  </label>
                  <input
                    id="erp-pwd"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your ERPNext password"
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
                  <span>{authLoading ? 'Signing in...' : 'Connect to ERPNext'}</span>
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
                  {session.erpUrl} · Signed in as {session.fullName || session.userId}
                </p>
                <h1 className="text-2xl font-semibold tracking-tight text-slate-900 text-balance">
                  ERPNext Farm & Markaz Dashboard
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="date"
                  aria-label="Optional creation date from"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 font-mono"
                />
                <input
                  type="date"
                  aria-label="Optional creation date to"
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
                    All Dates
                  </button>
                )}

                <label className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={excludeCancelled}
                    onChange={(e) => setExcludeCancelled(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span className="whitespace-nowrap">Exclude Cancelled</span>
                </label>

                <button
                  type="button"
                  onClick={() => void fetchFarms()}
                  disabled={farmsLoading}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-900 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 transition-colors duration-150 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`w-4 h-4 ${farmsLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                  <span>{farmsLoading ? 'Syncing All...' : 'Sync All Farms'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleResolveMarkaz()}
                  disabled={geocoding || farms.length === 0}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50 transition-colors duration-150 whitespace-nowrap shrink-0"
                >
                  <MapPin className="w-4 h-4" aria-hidden="true" />
                  <span>{geocoding ? 'Geocoding...' : 'Group by Markaz'}</span>
                </button>
              </div>
            </section>

            {farmsError && (
              <div role="alert" className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {farmsError}
              </div>
            )}

            {geocodeMessage && (
              <div className="p-4 bg-white border border-slate-200 rounded-lg text-sm text-slate-700">
                {geocodeMessage}
              </div>
            )}

            {/* Metrics Grid */}
            <section aria-label="Farm summary metrics" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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

            {/* Primary Content */}
            {activeSection === 'markaz' ? (
              <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">Markaz Summary</h2>
                    <p className="text-xs text-slate-500">
                      Live ERPNext farms grouped by Governorate (المحافظة) and Markaz (المركز)
                    </p>
                  </div>
                  <span className="text-xs text-slate-500 font-mono tabular-nums">
                    {markazSummary.length} groups
                  </span>
                </div>

                {markazSummary.length === 0 ? (
                  <div className="px-6 py-12 text-center text-sm text-slate-600">
                    No farm records loaded for the selected filters.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                          <th className="px-6 py-3">المحافظة</th>
                          <th className="px-6 py-3">المركز</th>
                          <th className="px-6 py-3 text-right">Farms</th>
                          <th className="px-6 py-3 text-right">Area</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 text-sm">
                        {markazSummary.map((row) => (
                          <tr key={`${row.governorate}-${row.markaz}`} className="hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-3 font-medium text-slate-900">{row.governorate}</td>
                            <td className="px-6 py-3 text-slate-700">{row.markaz}</td>
                            <td className="px-6 py-3 text-right font-mono tabular-nums text-slate-900">
                              {row.count}
                            </td>
                            <td className="px-6 py-3 text-right font-mono tabular-nums text-slate-700">
                              {row.area.toFixed(1)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : (
              <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
                <div
                  className={`${
                    tableView === 'all-fields' ? 'lg:col-span-3' : 'lg:col-span-2'
                  } bg-white border border-slate-200 rounded-lg overflow-hidden`}
                >
                  <div className="px-6 py-4 border-b border-slate-200 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900">All Farms Data</h2>
                      <p className="text-xs text-slate-500">
                        {filteredFarms.length} farms · Click any row to inspect full ERPNext record & child tables
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative">
                        <Search
                          className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                          aria-hidden="true"
                        />
                        <input
                          type="search"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search any field..."
                          aria-label="Search farms across all fields"
                          className="w-52 pl-9 pr-3 py-1.5 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
                        />
                      </div>

                      <div
                        role="group"
                        aria-label="Table column mode"
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
                          Summary
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
                          All Fields ({allErpColumns.length})
                        </button>
                      </div>

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
                      Fetching all farms from ERPNext...
                    </div>
                  ) : filteredFarms.length === 0 ? (
                    <div className="px-6 py-12 text-center space-y-3">
                      <p className="text-sm text-slate-600">No farms match the current filters or search.</p>
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery('')}
                          className="px-4 py-2 text-sm font-medium text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg"
                        >
                          Clear Search
                        </button>
                      )}
                    </div>
                  ) : tableView === 'all-fields' ? (
                    <div className="overflow-x-auto max-h-[640px]">
                      <table className="w-full text-left border-collapse">
                        <thead className="sticky top-0 z-10">
                          <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                            <th className="px-4 py-3 whitespace-nowrap">المحافظة</th>
                            <th className="px-4 py-3 whitespace-nowrap">المركز</th>
                            <th className="px-4 py-3 whitespace-nowrap">القرية_المنطقة</th>
                            {allErpColumns.map((col) => (
                              <th key={col} className="px-4 py-3 whitespace-nowrap font-mono">
                                {col}
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
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                            <th className="px-6 py-3">Farm</th>
                            <th className="px-6 py-3">Markaz / Governorate</th>
                            <th className="px-6 py-3 text-right">Coordinates</th>
                            <th className="px-6 py-3">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 text-sm">
                          {filteredFarms.map((farm) => (
                            <tr
                              key={farm.id}
                              onClick={() => void handleOpenFarmDetails(farm)}
                              className="hover:bg-slate-50 transition-colors cursor-pointer"
                            >
                              <td className="px-6 py-3">
                                <div className="font-medium text-slate-900">{farm.name}</div>
                                <div className="text-xs text-slate-500 font-mono tabular-nums">
                                  {farm.id} · {farm.creation}
                                </div>
                              </td>
                              <td className="px-6 py-3 text-slate-700">
                                {farm.markaz ? `${farm.markaz} · ${farm.governorate}` : 'Not geocoded yet'}
                              </td>
                              <td className="px-6 py-3 text-right font-mono tabular-nums text-xs text-slate-600">
                                {farm.lat !== null && farm.lon !== null
                                  ? `${farm.lat.toFixed(4)}, ${farm.lon.toFixed(4)}`
                                  : '—'}
                              </td>
                              <td className="px-6 py-3 text-xs font-medium text-slate-700">{farm.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {tableView === 'compact' && (
                  <aside className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold text-slate-900">Top Districts</h2>
                      <p className="text-xs text-slate-500">Farms grouped by Markaz</p>
                    </div>

                    {markazSummary.length === 0 ? (
                      <p className="text-sm text-slate-500">Sync farms to populate district counts.</p>
                    ) : (
                      <div className="divide-y divide-slate-200">
                        {markazSummary.slice(0, 8).map((item) => (
                          <div
                            key={`${item.governorate}-${item.markaz}`}
                            className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-4"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-900 truncate">{item.markaz}</p>
                              <p className="text-xs text-slate-500 truncate">{item.governorate}</p>
                            </div>
                            <span className="text-sm font-semibold text-slate-900 font-mono tabular-nums shrink-0">
                              {item.count}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </aside>
                )}
              </section>
            )}
          </>
        )}
      </main>

      {/* Full Farm Document Drawer */}
      {selectedFarm && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 flex justify-end"
          onClick={() => setSelectedFarm(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Full data for ${selectedFarm.name}`}
            className="w-full max-w-2xl bg-white h-full overflow-y-auto border-l border-slate-200 p-6 space-y-6"
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
                aria-label="Close farm details"
                className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {detailsLoading ? (
              <p className="text-sm text-slate-600">Loading complete ERPNext document & child tables...</p>
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
                          All Farm Fields ({scalarEntries.length})
                        </h3>
                        <div className="border border-slate-200 rounded-lg divide-y divide-slate-200">
                          {scalarEntries.map(([key, value]) => (
                            <div
                              key={key}
                              className="px-4 py-2.5 grid grid-cols-3 gap-4 text-xs"
                            >
                              <span className="font-mono text-slate-500 break-all">{key}</span>
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
                            <p className="text-xs text-slate-500">Empty table</p>
                          ) : (
                            <div className="overflow-x-auto border border-slate-200 rounded-lg">
                              <table className="w-full text-left border-collapse text-xs">
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
