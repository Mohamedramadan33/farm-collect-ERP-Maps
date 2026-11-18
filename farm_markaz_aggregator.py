# ==============================================================================
# Required Dependencies (run these commands locally before executing the script):
#   pip install playwright pandas openpyxl geopy folium
#   playwright install chromium
# ==============================================================================

from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path
from typing import Any

import folium
from folium.plugins import MarkerCluster
from geopy.exc import GeopyError
from geopy.extra.rate_limiter import RateLimiter
from geopy.geocoders import Nominatim
import pandas as pd
from playwright.sync_api import Locator, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


# ------------------------------------------------------------------------------
# Configuration Constants
# ------------------------------------------------------------------------------
LOGIN_URL = "https://erp-sys.sekem.com/login"
REPORT_URL = (
    "https://erp-sys.sekem.com/app/farm/view/report"
    "?creation_date=%5B%22Between%22%2C%5B%222026-01-01%22%2C%222026-11-15%22%5D%5D"
    "&farm_status=%5B%22%21%3D%22%2C%22Cancelled%22%5D"
    "&type=Farm"
)

BASE_DIR = Path(".")
DOWNLOADS_DIR = BASE_DIR / "downloads"
OUTPUT_DIR = BASE_DIR / "output"
RAW_EXCEL_PATH = DOWNLOADS_DIR / "raw_farms.xlsx"
OUTPUT_EXCEL_PATH = OUTPUT_DIR / "Farms_By_Markaz.xlsx"
OUTPUT_MAP_PATH = OUTPUT_DIR / "Farms_Map.html"
CACHE_PATH = BASE_DIR / "geocode_cache.json"
DEBUG_SCREENSHOT_PATH = BASE_DIR / "error_debug.png"

LOGIN_TIMEOUT_MS = 180_000
PAGE_TIMEOUT_MS = 60_000
DOWNLOAD_TIMEOUT_MS = 120_000


def configure_console_encoding() -> None:
    """Ensure UTF-8 console output on Windows so Arabic strings never raise UnicodeEncodeError."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def save_debug_screenshot(page: Page, step_name: str, exc: Exception) -> None:
    """Capture a full-page screenshot when an ERPNext UI interaction fails."""
    try:
        page.screenshot(path=str(DEBUG_SCREENSHOT_PATH), full_page=True)
        print(
            f"[ERROR] Failed during '{step_name}': {exc}\n"
            f"[INFO] Saved debug screenshot to: {DEBUG_SCREENSHOT_PATH.resolve()}"
        )
    except Exception as shot_exc:
        print(
            f"[ERROR] Failed during '{step_name}': {exc}\n"
            f"[WARN] Could not capture debug screenshot: {shot_exc}"
        )


def find_first_visible_locator(page: Page, selectors: list[str], timeout_ms: int = 10_000) -> Locator:
    """Return the first visible locator from an ordered list of candidate selectors."""
    per_selector_timeout = max(1_500, timeout_ms // max(len(selectors), 1))
    last_error: Exception | None = None

    for selector in selectors:
        locator = page.locator(selector).first
        try:
            locator.wait_for(state="visible", timeout=per_selector_timeout)
            return locator
        except Exception as exc:
            last_error = exc

    raise TimeoutError(
        f"None of the candidate selectors became visible: {selectors}. Last error: {last_error}"
    )


def click_with_debug(page: Page, selectors: list[str], step_name: str, timeout_ms: int = 15_000) -> None:
    """Locate and click an element, saving error_debug.png if any selector fails."""
    try:
        locator = find_first_visible_locator(page, selectors, timeout_ms=timeout_ms)
        locator.scroll_into_view_if_needed()
        locator.click()
    except Exception as exc:
        save_debug_screenshot(page, step_name, exc)
        raise RuntimeError(f"UI step failed at '{step_name}': {exc}") from exc


# ------------------------------------------------------------------------------
# Phase 1: ERPNext Browser Automation (Playwright Sync API)
# ------------------------------------------------------------------------------
def download_erpnext_report() -> Path:
    """Automate login wait, report navigation, and Excel export in ERPNext."""
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=50)
        context = browser.new_context(
            accept_downloads=True,
            viewport={"width": 1440, "height": 900},
        )
        page = context.new_page()

        try:
            print(f"[INFO] Opening ERPNext login page: {LOGIN_URL}")
            page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)

            print("Please log in manually in the browser window...")
            try:
                page.wait_for_url(
                    lambda url: "/login" not in url.lower(),
                    timeout=LOGIN_TIMEOUT_MS,
                )
            except PlaywrightTimeoutError as exc:
                save_debug_screenshot(page, "manual_login_wait", exc)
                raise TimeoutError(
                    "Timed out after 180 seconds waiting for manual login."
                ) from exc

            page.wait_for_load_state("domcontentloaded")
            print("[OK] Login detected. Navigating to filtered Farm report...")

            page.goto(REPORT_URL, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)

            try:
                page.locator(".dt-scrollable, .report-wrapper").first.wait_for(
                    state="visible",
                    timeout=PAGE_TIMEOUT_MS,
                )
                page.wait_for_timeout(1500)
            except Exception as exc:
                save_debug_screenshot(page, "wait_for_report_table", exc)
                raise RuntimeError(f"Report table failed to render: {exc}") from exc

            print("[OK] Report table rendered. Opening Menu -> Export...")

            # 1) Click Menu button (supports ERPNext v14/v15 selectors)
            menu_selectors = [
                ".page-actions .menu-btn-group button:visible",
                ".menu-btn-group button:visible",
                'button:has-text("Menu"):visible',
                'button[aria-label="Menu"]:visible',
            ]
            click_with_debug(page, menu_selectors, "click_menu_button")

            # 2) Click Export in the dropdown
            export_menu_selectors = [
                '.menu-btn-group .dropdown-menu.show a:has-text("Export")',
                '.menu-btn-group .dropdown-menu.show li:has-text("Export")',
                '.dropdown-menu.show .dropdown-item:has-text("Export")',
                '.dropdown-menu.show a:has-text("Export")',
                'span.menu-item-label:has-text("Export")',
                'a.grey-link:has-text("Export")',
            ]
            click_with_debug(page, export_menu_selectors, "click_export_dropdown_item")

            # 3) Inside Export modal, ensure Excel is selected
            try:
                modal = find_first_visible_locator(
                    page,
                    [".modal.show .modal-content", ".modal-dialog:visible"],
                    timeout_ms=15_000,
                )
                selects = modal.locator("select")
                select_count = selects.count()
                excel_selected = False

                for idx in range(select_count):
                    sel = selects.nth(idx)
                    options = sel.locator("option").all_inner_texts()
                    for opt in options:
                        if opt.strip().lower() == "excel":
                            sel.select_option(label=opt.strip())
                            excel_selected = True
                            break
                    if excel_selected:
                        break

                if not excel_selected:
                    # Fallback for custom radio/checkbox/label controls if present
                    excel_radio = modal.locator('label:has-text("Excel"), input[value="Excel"]').first
                    if excel_radio.count() > 0:
                        excel_radio.click()
                        excel_selected = True

                if not excel_selected:
                    raise RuntimeError("Could not find an 'Excel' format option in the Export modal.")
            except Exception as exc:
                save_debug_screenshot(page, "select_excel_format", exc)
                raise

            # 4) Click primary Download / Export button inside expect_download()
            download_btn_selectors = [
                '.modal.show .modal-footer button.btn-primary:has-text("Download")',
                '.modal.show .modal-footer button.btn-primary:has-text("Export")',
                '.modal.show .modal-footer button.btn-primary',
                'button.btn-primary:has-text("Download"):visible',
                'button.btn-primary:has-text("Export"):visible',
            ]
            try:
                download_btn = find_first_visible_locator(page, download_btn_selectors, timeout_ms=15_000)
                download_btn.scroll_into_view_if_needed()
                with page.expect_download(timeout=DOWNLOAD_TIMEOUT_MS) as download_info:
                    download_btn.click()
                download = download_info.value
                download.save_as(str(RAW_EXCEL_PATH))
            except Exception as exc:
                save_debug_screenshot(page, "click_modal_download_button", exc)
                raise RuntimeError(f"Failed while downloading Excel file: {exc}") from exc

            if not RAW_EXCEL_PATH.exists() or RAW_EXCEL_PATH.stat().st_size == 0:
                raise FileNotFoundError(f"Downloaded file is missing or empty: {RAW_EXCEL_PATH}")

            print(f"[OK] Saved raw report to: {RAW_EXCEL_PATH.resolve()}")
            return RAW_EXCEL_PATH
        finally:
            context.close()
            browser.close()


# ------------------------------------------------------------------------------
# Phase 2: Spatial Clustering by Markaz ("المركز") with Local Caching
# ------------------------------------------------------------------------------
def detect_coordinate_columns(df: pd.DataFrame) -> tuple[str, str]:
    """Auto-detect Latitude and Longitude columns (case-insensitive)."""
    normalized_cols = {col: re.sub(r"[\s_\-]+", " ", str(col).strip().lower()) for col in df.columns}

    lat_exact = {"lat", "latitude", "خط العرض"}
    lon_exact = {"lng", "long", "longitude", "lon", "خط الطول"}

    lat_col: str | None = None
    lon_col: str | None = None

    # Pass 1: exact normalized name matches
    for orig, norm in normalized_cols.items():
        if lat_col is None and norm in lat_exact:
            lat_col = orig
        if lon_col is None and norm in lon_exact:
            lon_col = orig

    # Pass 2: token / substring fallback (e.g. "farm_latitude", "gps_lng")
    if lat_col is None:
        for orig, norm in normalized_cols.items():
            tokens = norm.split()
            if any(tok in {"lat", "latitude"} for tok in tokens) or "latitude" in norm or re.search(r"\blat\b", norm):
                lat_col = orig
                break

    if lon_col is None:
        for orig, norm in normalized_cols.items():
            tokens = norm.split()
            if (
                any(tok in {"lng", "long", "longitude", "lon"} for tok in tokens)
                or "longitude" in norm
                or re.search(r"\b(lng|long|lon)\b", norm)
            ):
                lon_col = orig
                break

    if lat_col is None or lon_col is None:
        raise ValueError(
            f"Could not auto-detect Latitude/Longitude columns. Available columns: {list(df.columns)}"
        )

    return lat_col, lon_col


def detect_farm_name_column(df: pd.DataFrame, lat_col: str, lon_col: str) -> str:
    """Pick the best column to display as the farm name in map popups."""
    priority_patterns = [
        "farm_name",
        "farm name",
        "اسم المزرعة",
        "المزرعة",
        "farm",
        "title",
        "name",
        "id",
    ]
    cols_lower = {str(col).strip().lower(): col for col in df.columns if col not in (lat_col, lon_col)}

    for pattern in priority_patterns:
        for lower_col, orig_col in cols_lower.items():
            if lower_col == pattern:
                return str(orig_col)

    for pattern in priority_patterns:
        for lower_col, orig_col in cols_lower.items():
            if pattern in lower_col:
                return str(orig_col)

    for col in df.columns:
        if col not in (lat_col, lon_col):
            return str(col)
    return str(lat_col)


def load_geocode_cache(cache_path: Path) -> dict[str, dict[str, str]]:
    """Load local JSON reverse-geocoding cache if available."""
    if not cache_path.exists():
        return {}
    try:
        content = cache_path.read_text(encoding="utf-8").strip()
        if not content:
            return {}
        data = json.loads(content)
        if isinstance(data, dict):
            return data
    except Exception as exc:
        print(f"[WARN] Could not parse existing cache ({cache_path}): {exc}. Starting fresh.")
    return {}


def save_geocode_cache(cache_path: Path, cache: dict[str, dict[str, str]]) -> None:
    """Persist reverse-geocoding cache to disk using UTF-8."""
    cache_path.write_text(
        json.dumps(cache, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def extract_egypt_admin_fields(address: dict[str, Any]) -> dict[str, str]:
    """Extract Arabic Governorate, Markaz, and Village/Suburb from Nominatim address dict."""
    governorate = str(address.get("state") or "غير محدد").strip() or "غير محدد"
    markaz = (
        str(
            address.get("county")
            or address.get("city_district")
            or address.get("town")
            or "غير محدد"
        ).strip()
        or "غير محدد"
    )
    village = (
        str(
            address.get("village")
            or address.get("suburb")
            or "غير محدد"
        ).strip()
        or "غير محدد"
    )
    return {
        "المحافظة": governorate,
        "المركز": markaz,
        "القرية_المنطقة": village,
    }


def geocode_farms(excel_path: Path) -> tuple[pd.DataFrame, str, str]:
    """Read raw report, clean coordinates, and enrich with Arabic Markaz via Nominatim + cache."""
    print(f"[INFO] Reading Excel report: {excel_path}")
    df = pd.read_excel(excel_path, engine="openpyxl")
    if df.empty:
        raise ValueError("The downloaded Excel report contains 0 rows.")

    lat_col, lon_col = detect_coordinate_columns(df)
    print(f"[OK] Detected coordinate columns -> Latitude: '{lat_col}', Longitude: '{lon_col}'")

    df = df.copy()
    df[lat_col] = pd.to_numeric(df[lat_col], errors="coerce")
    df[lon_col] = pd.to_numeric(df[lon_col], errors="coerce")

    valid_mask = (
        df[lat_col].notna()
        & df[lon_col].notna()
        & (df[lat_col] != 0)
        & (df[lon_col] != 0)
        & (df[lat_col].between(-90.0, 90.0))
        & (df[lon_col].between(-180.0, 180.0))
    )

    dropped_count = int((~valid_mask).sum())
    df_clean = df.loc[valid_mask].copy().reset_index(drop=True)
    print(f"[INFO] Valid coordinate rows: {len(df_clean)} (removed {dropped_count} invalid/null/zero rows)")

    if df_clean.empty:
        raise ValueError("No valid non-zero farm coordinates remain after cleaning.")

    cache = load_geocode_cache(CACHE_PATH)
    geolocator = Nominatim(user_agent="sekem_farm_mapper", timeout=15)
    reverse_geocode = RateLimiter(
        geolocator.reverse,
        min_delay_seconds=1.1,
        max_retries=3,
        error_wait_seconds=2.0,
        swallow_exceptions=False,
    )

    governorates: list[str] = []
    markazes: list[str] = []
    villages: list[str] = []

    cache_hits = 0
    api_calls = 0

    try:
        total = len(df_clean)
        for idx, row in df_clean.iterrows():
            lat = float(row[lat_col])
            lon = float(row[lon_col])
            cache_key = f"{round(lat, 3)}_{round(lon, 3)}"

            if cache_key in cache:
                geo_info = cache[cache_key]
                cache_hits += 1
            else:
                try:
                    location = reverse_geocode(
                        (lat, lon),
                        exactly_one=True,
                        language="ar",
                        addressdetails=True,
                    )
                    address = location.raw.get("address", {}) if location and location.raw else {}
                    geo_info = extract_egypt_admin_fields(address)
                    cache[cache_key] = geo_info
                    api_calls += 1

                    if api_calls % 10 == 0:
                        save_geocode_cache(CACHE_PATH, cache)
                except (GeopyError, Exception) as exc:
                    print(f"[WARN] Nominatim lookup failed for ({lat}, {lon}) [key={cache_key}]: {exc}")
                    geo_info = {
                        "المحافظة": "غير محدد",
                        "المركز": "غير محدد",
                        "القرية_المنطقة": "غير محدد",
                    }

            governorates.append(geo_info.get("المحافظة", "غير محدد"))
            markazes.append(geo_info.get("المركز", "غير محدد"))
            villages.append(geo_info.get("القرية_المنطقة", "غير محدد"))

            if (idx + 1) % 25 == 0 or (idx + 1) == total:
                print(
                    f"[INFO] Processed {idx + 1}/{total} farms "
                    f"(cache hits: {cache_hits}, new API calls: {api_calls})"
                )
    finally:
        save_geocode_cache(CACHE_PATH, cache)
        print(f"[OK] Saved geocode cache ({len(cache)} keys) to: {CACHE_PATH.resolve()}")

    df_clean["المحافظة"] = governorates
    df_clean["المركز"] = markazes
    df_clean["القرية_المنطقة"] = villages

    return df_clean, lat_col, lon_col


# ------------------------------------------------------------------------------
# Phase 3: Outputs (Excel Workbook + Folium Interactive Map)
# ------------------------------------------------------------------------------
def export_excel_outputs(df_mapped: pd.DataFrame, output_excel_path: Path) -> None:
    """Export All_Farms_Mapped and Markaz_Summary sheets to ./output/Farms_By_Markaz.xlsx."""
    output_excel_path.parent.mkdir(parents=True, exist_ok=True)

    markaz_summary = (
        df_mapped.groupby(["المحافظة", "المركز"], dropna=False)
        .size()
        .reset_index(name="عدد_المزارع")
        .sort_values(by="عدد_المزارع", ascending=False)
        .reset_index(drop=True)
    )

    with pd.ExcelWriter(output_excel_path, engine="openpyxl") as writer:
        df_mapped.to_excel(writer, sheet_name="All_Farms_Mapped", index=False)
        markaz_summary.to_excel(writer, sheet_name="Markaz_Summary", index=False)

        for sheet_name in ("All_Farms_Mapped", "Markaz_Summary"):
            ws = writer.sheets[sheet_name]
            ws.views.sheetView[0].rightToLeft = True
            for col_cells in ws.columns:
                col_letter = col_cells[0].column_letter
                max_len = max((len(str(cell.value or "")) for cell in col_cells), default=10)
                ws.column_dimensions[col_letter].width = min(max(max_len + 4, 12), 45)

    print(f"[OK] Exported Excel workbook to: {output_excel_path.resolve()}")


def generate_folium_map(
    df_mapped: pd.DataFrame,
    lat_col: str,
    lon_col: str,
    output_map_path: Path,
) -> None:
    """Generate interactive Folium MarkerCluster map at ./output/Farms_Map.html."""
    output_map_path.parent.mkdir(parents=True, exist_ok=True)

    farm_name_col = detect_farm_name_column(df_mapped, lat_col, lon_col)
    center_lat = float(df_mapped[lat_col].mean())
    center_lon = float(df_mapped[lon_col].mean())

    fmap = folium.Map(location=[center_lat, center_lon], zoom_start=7, tiles="OpenStreetMap")
    marker_cluster = MarkerCluster(name="Farms by Markaz").add_to(fmap)

    for _, row in df_mapped.iterrows():
        lat = float(row[lat_col])
        lon = float(row[lon_col])
        farm_name = html.escape(str(row.get(farm_name_col, "N/A")))
        gov = html.escape(str(row.get("المحافظة", "غير محدد")))
        markaz = html.escape(str(row.get("المركز", "غير محدد")))
        village = html.escape(str(row.get("القرية_المنطقة", "غير محدد")))

        popup_html = (
            f'<div dir="rtl" style="font-family: Tahoma, Arial, sans-serif; font-size: 13px; min-width: 200px;">'
            f'<div style="font-weight: bold; font-size: 14px; margin-bottom: 6px; color: #1b5e20;">{farm_name}</div>'
            f'<div><b>المركز:</b> {markaz}</div>'
            f'<div><b>المحافظة:</b> {gov}</div>'
            f'<div><b>القرية / المنطقة:</b> {village}</div>'
            f'<div style="margin-top: 4px; color: #555; font-size: 11px;">({lat:.5f}, {lon:.5f})</div>'
            f"</div>"
        )

        folium.Marker(
            location=[lat, lon],
            tooltip=f"{farm_name} - {markaz}",
            popup=folium.Popup(popup_html, max_width=320),
            icon=folium.Icon(color="green", icon="leaf", prefix="fa"),
        ).add_to(marker_cluster)

    folium.LayerControl().add_to(fmap)
    fmap.save(str(output_map_path))
    print(f"[OK] Generated interactive map at: {output_map_path.resolve()}")


def main() -> None:
    configure_console_encoding()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

    raw_excel = download_erpnext_report()
    df_mapped, lat_col, lon_col = geocode_farms(raw_excel)
    export_excel_outputs(df_mapped, OUTPUT_EXCEL_PATH)
    generate_folium_map(df_mapped, lat_col, lon_col, OUTPUT_MAP_PATH)

    print("[DONE] Farm Markaz aggregation completed successfully.")


if __name__ == "__main__":
    main()
