/**
 * ==============================================================================
 * data-sync.js
 * Network synchronization layer: Google Apps Script Web App GET & POST pipelines,
 * date normalizer, and localStorage resilience.
 * ==============================================================================
 */

// PASTE YOUR DEPLOYED GOOGLE APPS SCRIPT WEB APP URL HERE:
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwOFVSn5oEva5wGU_asCXGhQu3PoO82OnyP3Ogh9HKZ2Px65dD42Wyqdw90pJa2tQ0MSw/exec";
const API_SECRET = "";

const STORAGE_KEYS = {
  CONFIG: "AUDITORIUM_CONFIG_LIVE",
  SPACES: "AUDITORIUM_SPACES_LIVE",
  BOOKINGS: "AUDITORIUM_BOOKINGS_LIVE",
  TENANTS: "AUDITORIUM_TENANTS_LIVE",
  PAYMENTS: "AUDITORIUM_PAYMENTS_LIVE"
};

const DEFAULT_CONFIG = {
  RATE_FULL_MORN: 15000,
  RATE_FULL_EVE: 15000,
  RATE_FULL_SAME_DAY_BOTH: 40000,
  RATE_FULL_EVE_NEXT_MORN: 25000,
  RATE_FULL_TWO_MORNINGS: 35000,
  RATE_FULL_TWO_EVENINGS: 35000,
  RATE_TOP_PER_SLOT: 5000,
  PARKING_MIN_FEE: 4000,
  PARKING_PER_SQFT: 200,
  WASTE_DISPOSAL_FEE: 1000,
  CAUTION_DEPOSIT_FULL: 10000,
  CAUTION_DEPOSIT_TOP: 0,
  ADVANCE_PCT_FULL: 50,
  ADVANCE_PCT_TOP: 100,
  HOLD_HOURS_FULL: 48,
  HOLD_HOURS_TOP: 24,
  GST_PERCENT: 18,
  EXTRA_PAX_SURCHARGE_PER_HEAD: 200
};

const DEFAULT_SPACES = [
  {
    space_id: "SP-MAIN-FULL",
    name: "Full Auditorium (Ground + Top Floor)",
    capacity: 500,
    conflict_group: "GRP_MAIN_AUDITORIUM",
    is_composite: true,
    base_rate: 15000,
    description: "Complete venue (400 Ground + 100 Top). Locks First Floor automatically."
  },
  {
    space_id: "SP-TOP-SOLO",
    name: "First / Top Floor Only",
    capacity: 100,
    conflict_group: "GRP_MAIN_AUDITORIUM",
    is_composite: false,
    base_rate: 5000,
    description: "Mini hall (100 pax). Locks Full Venue automatically."
  },
  {
    space_id: "SP-PARKING-ONLY",
    name: "Parking Area (Standalone Event)",
    capacity: 300,
    conflict_group: "GRP_PARKING_STANDALONE",
    is_composite: false,
    base_rate: 4000,
    description: "Open paved parking area for outdoor expos, flea markets or food stalls."
  }
];

/**
 * Robust Date Normalizer: Converts date strings or Date objects into clean YYYY-MM-DD
 */
function normalizeIsoDate(val) {
  if (!val) return "";
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  let s = String(val).trim();
  if (s.includes("T")) s = s.split("T")[0].trim();

  // YYYY-MM-DD or YYYY/MM/DD
  const m1 = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m1) return `${m1[1]}-${String(m1[2]).padStart(2, "0")}-${String(m1[3]).padStart(2, "0")}`;  // DD-MM-YYYY or DD/MM/YYYY const m2 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); if (m2) return `${m2[3]}-${String(m2[2]).padStart(2, "0")}-${String(m2[1]).padStart(2, "0")}`;

  return s;
}

const DataStore = {
  getLocal() {
    try {
      const cfg = localStorage.getItem(STORAGE_KEYS.CONFIG);
      const sp = localStorage.getItem(STORAGE_KEYS.SPACES);
      const bk = localStorage.getItem(STORAGE_KEYS.BOOKINGS);
      return {
        config: cfg ? JSON.parse(cfg) : { ...DEFAULT_CONFIG },
        spaces: sp ? JSON.parse(sp) : [ ...DEFAULT_SPACES ],
        bookings: bk ? JSON.parse(bk) : []
      };
    } catch (e) {
      return { config: { ...DEFAULT_CONFIG }, spaces: [ ...DEFAULT_SPACES ], bookings: [] };
    }
  },

  saveLocal(data) {
    try {
      if (data.config) localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(data.config));
      if (data.spaces) localStorage.setItem(STORAGE_KEYS.SPACES, JSON.stringify(data.spaces));
      if (data.bookings) localStorage.setItem(STORAGE_KEYS.BOOKINGS, JSON.stringify(data.bookings));
    } catch (e) {
      console.error("Local cache write error:", e);
    }
  },

  async fetchFromSheets() {
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.includes("YOUR_APPS_SCRIPT_WEB_APP_URL")) {
      return {
        success: false,
        isConfigured: false,
        message: "Google Apps Script URL is not configured. Running in offline mode.",
        data: this.getLocal()
      };
    }

    try {
      let url = APPS_SCRIPT_URL;
      if (API_SECRET) {
        url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(API_SECRET);
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP error " + res.status);

      const json = await res.json();
      if (json.status !== "success" || !json.data) {
        throw new Error(json.message || "Invalid payload format from Apps Script");
      }

      const liveSpaces = (json.data.spaces && json.data.spaces.length > 0)
        ? json.data.spaces.map(s => ({
            space_id: String(s.space_id),
            name: s.name,
            capacity: Number(s.capacity || 0),
            conflict_group: String(s.conflict_group || "GRP_INDEPENDENT").trim().toUpperCase(),
            is_composite: String(s.is_composite).toUpperCase() === "TRUE",
            base_rate: Number(s.base_rate || 5000),
            description: s.description || ""
          }))
        : [ ...DEFAULT_SPACES ];

      const tenantsMap = new Map();
      if (json.data.tenants && Array.isArray(json.data.tenants)) {
        json.data.tenants.forEach(t => tenantsMap.set(String(t.booking_id), t));
      }

      // Map bookings with NORMALIZED dates (YYYY-MM-DD)
      const liveBookings = (json.data.bookings && Array.isArray(json.data.bookings))
        ? json.data.bookings.map(b => {
            const t = tenantsMap.get(String(b.booking_id)) || {};
            const rawDates = String(b.dates_csv || "").split(",").map(d => d.trim()).filter(Boolean);
            const normalizedDates = rawDates.map(normalizeIsoDate);
            const slots = String(b.slots_csv || "").split(",").map(s => s.trim()).filter(Boolean);

            return {
              booking_id: String(b.booking_id),
              created_at: b.created_at,
              space_id: String(b.space_id),
              slot_package: b.slot_package,
              slot_package_name: b.slot_package,
              dates: normalizedDates,
              slots: slots,
              expected_pax: Number(b.expected_pax || 0),
              base_venue_fee: Number(b.base_venue_fee || 0),
              extra_pax_fee: Number(b.extra_pax_fee || 0),
              parking_sqft: Number(b.parking_sqft || 0),
              parking_fee: Number(b.parking_fee || 0),
              waste_fee: Number(b.waste_fee || 0),
              caution_deposit: Number(b.caution_deposit || 0),
              taxable_subtotal: Number(b.taxable_subtotal || 0),
              gst_amount: Number(b.gst_amount || 0),
              grand_total: Number(b.grand_total || 0),
              advance_required: Number(b.advance_required || 0),
              advance_paid: Number(b.advance_paid || 0),
              balance_due: Number(b.balance_due || 0),
              status: b.booking_status,
              hold_expires_time: b.hold_expiry_timestamp,
              refund_status: b.refund_status,
              tenant_name: t.full_name || "Guest",
              tenant_phone: t.phone_primary || "",
              tenant_alt_phone: t.phone_alternate || "",
              tenant_purpose: t.event_purpose || "",
              tenant_org: t.organization_name || "",
              suggested_by: t.suggested_by || "",
              remarks: t.special_remarks || "",
              id_proof_url: t.govt_id_drive_url || ""
            };
          })
        : [];

      const liveConfig = (json.config && Object.keys(json.config).length > 0)
        ? { ...DEFAULT_CONFIG, ...json.config }
        : { ...DEFAULT_CONFIG };

      const unifiedData = {
        config: liveConfig,
        spaces: liveSpaces,
        bookings: liveBookings
      };

      this.saveLocal(unifiedData);
      return { success: true, isConfigured: true, data: unifiedData, timestamp: json.timestamp };
    } catch (err) {
      return {
        success: false,
        isConfigured: true,
        message: "Live fetch failed: " + err.message + ". Showing cached records.",
        data: this.getLocal()
      };
    }
  },

  async postToSheets(action, payload) {
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.includes("YOUR_APPS_SCRIPT_WEB_APP_URL")) {
      return { status: "success", message: "Saved locally (Offline Mode)" };
    }

    try {
      let url = APPS_SCRIPT_URL;
      if (API_SECRET) {
        url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(API_SECRET);
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: action, payload: payload })
      });

      return await response.json();
    } catch (err) {
      console.error("Sheets POST error:", err);
      throw err;
    }
  }
};
