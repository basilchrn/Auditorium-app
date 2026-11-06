/**
 * ==============================================================================
 * data-sync.js
 * Synchronizes the Auditorium Management System with Google Sheets API Web App.
 * 
 * Supports:
 * - GET: Live pricing config, spaces, bookings, KYC, and payment ledger.
 * - POST: Creating bookings (with mutual exclusion & ID upload), balance settlements,
 *         discretionary refunds, and adding new venues.
 * - Offline-first caching via localStorage for seamless operation during network drops.
 * ==============================================================================
 */

// PASTE YOUR DEPLOYED GOOGLE APPS SCRIPT WEB APP URL HERE:
const APPS_SCRIPT_URL = "YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";

// Optional API Secret Key for header/query verification
const API_SECRET = "";

const STORAGE_KEYS = {
  CONFIG: "AUDITORIUM_CONFIG_LIVE",
  SPACES: "AUDITORIUM_SPACES_LIVE",
  BOOKINGS: "AUDITORIUM_BOOKINGS_LIVE",
  TENANTS: "AUDITORIUM_TENANTS_LIVE",
  PAYMENTS: "AUDITORIUM_PAYMENTS_LIVE"
};

// Default fallback configuration matching your sheet setup
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

const DataStore = {
  // Read local cache or default
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
      console.warn("Local cache read error:", e);
      return {
        config: { ...DEFAULT_CONFIG },
        spaces: [ ...DEFAULT_SPACES ],
        bookings: []
      };
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

  // HTTP GET: Fetch live data from Google Sheet Web App
  async fetchFromSheets() {
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.includes("YOUR_APPS_SCRIPT_WEB_APP_URL")) {
      return {
        success: false,
        isConfigured: false,
        message: "Google Apps Script URL is not configured. Running in offline localStorage mode.",
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

      // Map incoming sheet rows into application state
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

      // Merge bookings with tenant details
      const tenantsMap = new Map();
      if (json.data.tenants && Array.isArray(json.data.tenants)) {
        json.data.tenants.forEach(t => tenantsMap.set(String(t.booking_id), t));
      }

      const liveBookings = (json.data.bookings && Array.isArray(json.data.bookings))
        ? json.data.bookings.map(b => {
            const t = tenantsMap.get(String(b.booking_id)) || {};
            const dates = String(b.dates_csv || "").split(",").map(d => d.trim()).filter(Boolean);
            const slots = String(b.slots_csv || "").split(",").map(s => s.trim()).filter(Boolean);
            return {
              booking_id: String(b.booking_id),
              created_at: b.created_at,
              space_id: String(b.space_id),
              slot_package: b.slot_package,
              slot_package_name: b.slot_package,
              dates: dates,
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
      console.warn("Live fetch error, falling back to local cache:", err);
      return {
        success: false,
        isConfigured: true,
        message: "Live fetch failed: " + err.message + ". Showing cached records.",
        data: this.getLocal()
      };
    }
  },

  // HTTP POST: Send data to Google Sheet Web App
  async postToSheets(action, payload) {
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.includes("YOUR_APPS_SCRIPT_WEB_APP_URL")) {
      console.warn("Apps Script URL not set. Action saved locally only.");
      return { status: "success", message: "Saved locally (Offline Mode)" };
    }

    try {
      let url = APPS_SCRIPT_URL;
      if (API_SECRET) {
        url += (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(API_SECRET);
      }

      // Using text/plain prevents unwanted CORS preflight OPTIONS rejection on Google Apps Script
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify({
          action: action,
          payload: payload
        })
      });

      const result = await response.json();
      return result;
    } catch (err) {
      console.error("Sheets POST error:", err);
      throw err;
    }
  }
};
