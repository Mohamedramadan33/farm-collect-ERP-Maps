import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useAdvancedMarkerRef,
  useMap,
} from '@vis.gl/react-google-maps';
import type { BBox, Feature, FeatureCollection, Point } from 'geojson';
import Supercluster, { type ClusterProperties } from 'supercluster';

export interface MapFarmItem {
  id: string;
  name: string;
  status: string;
  lat: number;
  lon: number;
  governorate: string | null;
  markaz: string | null;
  village: string | null;
  area: number | null;
  areaUnit?: string | null;
}

interface FarmsMapProps {
  apiKey: string;
  farms: MapFarmItem[];
  focusLocation: { lat: number; lng: number; zoom?: number } | null;
  onInspectFarm: (farmId: string) => void;
}

type FarmGeoFeature = Feature<Point, MapFarmItem>;

function degreesPerPixel(zoomLevel: number): number {
  return 360 / (Math.pow(2, zoomLevel) * 256);
}

function useMapViewport(padding = 80): { bbox: BBox; zoom: number } {
  const map = useMap();
  const [bbox, setBbox] = useState<BBox>([-180, -90, 180, 90]);
  const [zoom, setZoom] = useState(6);

  useEffect(() => {
    if (!map) return;

    const updateViewport = () => {
      const bounds = map.getBounds();
      const currentZoom = map.getZoom();
      if (!bounds || currentZoom === undefined) return;

      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const padDeg = degreesPerPixel(currentZoom) * padding;

      setBbox([
        sw.lng() - padDeg,
        Math.max(-90, sw.lat() - padDeg),
        ne.lng() + padDeg,
        Math.min(90, ne.lat() + padDeg),
      ]);
      setZoom(currentZoom);
    };

    updateViewport();
    const listener = map.addListener('idle', updateViewport);
    return () => listener.remove();
  }, [map, padding]);

  return { bbox, zoom };
}

function MapViewportController({
  farms,
  focusLocation,
}: {
  farms: MapFarmItem[];
  focusLocation: { lat: number; lng: number; zoom?: number } | null;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map || !focusLocation) return;
    map.panTo({ lat: focusLocation.lat, lng: focusLocation.lng });
    map.setZoom(focusLocation.zoom ?? 11);
  }, [map, focusLocation]);

  useEffect(() => {
    if (!map || farms.length === 0 || focusLocation) return;

    let north = -90;
    let south = 90;
    let east = -180;
    let west = 180;
    for (const farm of farms) {
      if (farm.lat > north) north = farm.lat;
      if (farm.lat < south) south = farm.lat;
      if (farm.lon > east) east = farm.lon;
      if (farm.lon < west) west = farm.lon;
    }
    if (north - south < 0.01 && east - west < 0.01) {
      map.setCenter({ lat: (north + south) / 2, lng: (east + west) / 2 });
      map.setZoom(13);
    } else {
      map.fitBounds({ north, south, east, west }, 48);
    }
  }, [map, farms, focusLocation]);

  return null;
}

function ClusterMarker({
  position,
  count,
  onClick,
}: {
  position: { lat: number; lng: number };
  count: number;
  onClick: () => void;
}) {
  return (
    <AdvancedMarker position={position} onClick={onClick} title={`${count} مزرعة في هذه المنطقة`}>
      <div className="flex items-center justify-center min-w-[38px] h-[38px] px-2.5 rounded-full bg-emerald-700 text-white text-xs font-semibold font-mono tabular-nums border-2 border-white shadow-md cursor-pointer hover:bg-emerald-800 transition-colors">
        {count}
      </div>
    </AdvancedMarker>
  );
}

function FarmPinMarker({
  farm,
  isSelected,
  onSelect,
  onClose,
  onInspectFarm,
}: {
  farm: MapFarmItem;
  isSelected: boolean;
  onSelect: () => void;
  onClose: () => void;
  onInspectFarm: (farmId: string) => void;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: farm.lat, lng: farm.lon }}
        onClick={onSelect}
        title={farm.name}
      >
        <Pin background="#15803d" borderColor="#14532d" glyphColor="#ffffff" />
      </AdvancedMarker>

      {isSelected && marker && (
        <InfoWindow anchor={marker} maxWidth={300} onCloseClick={onClose}>
          <div dir="rtl" className="p-1 space-y-2 text-right font-sans text-slate-900 min-w-[220px]">
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-slate-900">{farm.name}</p>
              <p className="text-[11px] font-mono text-slate-500">ID: {farm.id}</p>
            </div>

            <div className="text-xs text-slate-700 space-y-1 border-t border-slate-200 pt-2">
              <div>
                <span className="font-semibold">المساحة:</span>{' '}
                {farm.area !== null
                  ? `${farm.area.toLocaleString('en-US', { maximumFractionDigits: 2 })}${farm.areaUnit ? ` ${farm.areaUnit}` : ''}`
                  : 'غير مسجلة'}
              </div>
              <div>
                <span className="font-semibold">المركز:</span> {farm.markaz || 'غير محدد'}
              </div>
              <div>
                <span className="font-semibold">المحافظة:</span> {farm.governorate || 'غير محدد'}
              </div>
              {farm.village && farm.village !== 'غير محدد' && (
                <div>
                  <span className="font-semibold">القرية / المنطقة:</span> {farm.village}
                </div>
              )}
              <div className="font-mono text-[11px] text-slate-500" dir="ltr">
                {farm.lat.toFixed(5)}, {farm.lon.toFixed(5)}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => onInspectFarm(farm.id)}
                className="w-full px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors"
              >
                عرض كل بيانات المزرعة
              </button>
              <a
                href={`https://earth.google.com/web/@${farm.lat.toFixed(6)},${farm.lon.toFixed(6)},0a,1500d,35y,0h,0t,0r`}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100 transition-colors"
              >
                فتح في Google Earth
              </a>
            </div>
          </div>
        </InfoWindow>
      )}
    </>
  );
}

function ClusteredFarmMarkers({
  farms,
  onInspectFarm,
}: {
  farms: MapFarmItem[];
  onInspectFarm: (farmId: string) => void;
}) {
  const map = useMap();
  const [selectedFarmId, setSelectedFarmId] = useState<string | null>(null);
  const { bbox, zoom } = useMapViewport(100);

  const geojson: FeatureCollection<Point, MapFarmItem> = useMemo(
    () => ({
      type: 'FeatureCollection',
      features: farms.map((farm) => ({
        type: 'Feature',
        id: farm.id,
        geometry: {
          type: 'Point',
          coordinates: [farm.lon, farm.lat],
        },
        properties: farm,
      })),
    }),
    [farms],
  );

  const clusterer = useMemo(
    () =>
      new Supercluster<MapFarmItem, ClusterProperties>({
        radius: 56,
        maxZoom: 16,
      }),
    [],
  );

  const [version, bumpVersion] = useReducer((v: number) => v + 1, 0);

  useEffect(() => {
    clusterer.load(geojson.features);
    bumpVersion();
  }, [clusterer, geojson]);

  const clusters = useMemo(() => {
    if (version === 0) return [];
    return clusterer.getClusters(bbox, Math.floor(zoom));
  }, [clusterer, bbox, zoom, version]);

  const handleClusterClick = useCallback(
    (clusterId: number, lat: number, lng: number) => {
      if (!map) return;
      const nextZoom = Math.min(clusterer.getClusterExpansionZoom(clusterId), 17);
      map.panTo({ lat, lng });
      map.setZoom(nextZoom);
    },
    [clusterer, map],
  );

  return (
    <>
      {clusters.map((feature) => {
        const [lng, lat] = feature.geometry.coordinates;
        const props = feature.properties as ClusterProperties & Partial<MapFarmItem>;

        if (props.cluster) {
          return (
            <ClusterMarker
              key={`cluster-${props.cluster_id}`}
              position={{ lat, lng }}
              count={props.point_count}
              onClick={() => handleClusterClick(props.cluster_id, lat, lng)}
            />
          );
        }

        const farmFeature = feature as FarmGeoFeature;
        const farm = farmFeature.properties;

        return (
          <FarmPinMarker
            key={farm.id}
            farm={farm}
            isSelected={selectedFarmId === farm.id}
            onSelect={() => setSelectedFarmId(farm.id)}
            onClose={() => setSelectedFarmId(null)}
            onInspectFarm={onInspectFarm}
          />
        );
      })}
    </>
  );
}

export default function FarmsMap({
  apiKey,
  farms,
  focusLocation,
  onInspectFarm,
}: FarmsMapProps) {
  const [mapType, setMapType] = useState<'roadmap' | 'hybrid'>('roadmap');

  if (!apiKey) {
    return (
      <div
        dir="rtl"
        className="h-[480px] w-full flex items-center justify-center bg-slate-100 border border-slate-200 rounded-lg p-6 text-center text-sm text-slate-600"
      >
        مفتاح Google Maps غير متاح حالياً في متغيرات البيئة. تأكد من إعادة تشغيل السيرفر بعد تفعيل الخرائط.
      </div>
    );
  }

  return (
    <div className="relative h-[520px] w-full rounded-lg overflow-hidden border border-slate-200 bg-slate-100">
      <div
        dir="rtl"
        role="group"
        aria-label="نوع الخريطة"
        className="absolute top-3 right-3 z-10 inline-flex items-center p-1 bg-white/95 backdrop-blur-xs border border-slate-200 rounded-lg shadow-sm"
      >
        <button
          type="button"
          onClick={() => setMapType('roadmap')}
          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
            mapType === 'roadmap'
              ? 'bg-slate-900 text-white'
              : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          خريطة الطرق
        </button>
        <button
          type="button"
          onClick={() => setMapType('hybrid')}
          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
            mapType === 'hybrid'
              ? 'bg-slate-900 text-white'
              : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          قمر صناعي (Google Earth)
        </button>
      </div>

      <APIProvider apiKey={apiKey} language="ar" region="EG" version="beta">
        <GoogleMap
          mapId="DEMO_MAP_ID"
          mapTypeId={mapType}
          mapTypeControl={false}
          streetViewControl={false}
          defaultCenter={{ lat: 26.8206, lng: 30.8025 }}
          defaultZoom={6}
          minZoom={5}
          gestureHandling="greedy"
          style={{ width: '100%', height: '100%' }}
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
        >
          <MapViewportController farms={farms} focusLocation={focusLocation} />
          <ClusteredFarmMarkers farms={farms} onInspectFarm={onInspectFarm} />
        </GoogleMap>
      </APIProvider>
    </div>
  );
}
