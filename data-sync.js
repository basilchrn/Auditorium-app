/**
 * ==============================================================================
 * data-sync.js
 * Synchronizes the Auditorium Management System with Google Sheets API Web App.
 * Includes Date Normalization and 8-Month Multi-Venue Availability Calendar Engine.
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
 * Robust Date Normalizer: Converts any date string or Date object into clean YYYY-MM-DD
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
  if (m1) return `${m1[1]}-${String(m1[2]).padStart(2, "0")}-${String(m1[3]).padStart(2, "0")}`;

  // DD-MM-YYYY or DD/MM/YYYY
  const m2 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m2) return `${m2[3]}-${String(m2[2]).padStart(2, "0")}-${String(m2[1]).padStart(2, "0")}`;

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

      // Map spaces
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

      // Map tenants
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

      // Using text/plain avoids CORS preflight OPTIONS rejection in Google Apps Script
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

/**
 * ==============================================================================
 * 8-MONTH MULTI-VENUE CALENDAR CONTROLLER
 * Window: Previous Month (-1), Live Month (0), Next 6 Months (+1 to +6)
 * ==============================================================================
 */

let gMonthlyOffset = 0; // 0 = Live Month, -1 = Previous Month, +1 to +6 = Future Months
const MIN_MONTH_OFFSET = -1;
const MAX_MONTH_OFFSET = 6;

function initMonthlyCalendar() {
  populateMonthlyDropdown();
  renderMonthlyCalendar();
}

function getOffsetDate(offsetMonths) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1);
}

function populateMonthlyDropdown() {
  const select = document.getElementById("monthlyCalSelect");
  if (!select) return;

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  select.innerHTML = "";
  for (let offset = MIN_MONTH_OFFSET; offset <= MAX_MONTH_OFFSET; offset++) {
    const d = getOffsetDate(offset);
    const mName = monthNames[d.getMonth()];
    const yr = d.getFullYear();
    const tag = offset === 0 ? " (Live Month)" : (offset === -1 ? " (Prev Month)" : "");
    
    const opt = document.createElement("option");
    opt.value = offset;
    opt.text = `${mName} ${yr}${tag}`;
    if (offset === gMonthlyOffset) opt.selected = true;
    select.appendChild(opt);
  }
}

function onMonthlySelectChange(val) {
  gMonthlyOffset = parseInt(val, 10);
  renderMonthlyCalendar();
}

function changeMonthlyCalOffset(delta) {
  const target = gMonthlyOffset + delta;
  if (target >= MIN_MONTH_OFFSET && target <= MAX_MONTH_OFFSET) {
    gMonthlyOffset = target;
    const select = document.getElementById("monthlyCalSelect");
    if (select) select.value = gMonthlyOffset;
    renderMonthlyCalendar();
  }
}

function jumpToLiveMonth() {
  gMonthlyOffset = 0;
  const select = document.getElementById("monthlyCalSelect");
  if (select) select.value = 0;
  renderMonthlyCalendar();
}

/**
 * Evaluates Status for All Venues on a Specific Day
 * Exact Business Rules:
 * 1. Full Area: red-booked / green-vacant
 * 2. First Floor: red-(full area booked / first floor booked) / green-vacant
 * 3. Parking Area: red-(parking booked / full area booked / first floor booked) / green-vacant
 * 4. Venue 4, Venue 5, etc.: red-booked / green-vacant
 */
function evaluateDayStatuses(isoDate) {
  const normTarget = normalizeIsoDate(isoDate);

  const activeBookings = (db.bookings || []).filter(b => {
    if (String(b.status).toLowerCase() === "cancelled") return false;
    if (!Array.isArray(b.dates)) return false;
    return b.dates.some(d => normalizeIsoDate(d) === normTarget);
  });

  // Check specific bookings
  const fullAreaBooking = activeBookings.find(b => b.space_id === "SP-MAIN-FULL");
  const firstFloorBooking = activeBookings.find(b => b.space_id === "SP-TOP-SOLO");
  const parkingBooking = activeBookings.find(b => 
    b.space_id === "SP-PARKING-ONLY" || 
    Number(b.parking_sqft || 0) > 0 || 
    Number(b.parking_fee || 0) > 0
  );

  const isFullAreaBooked = Boolean(fullAreaBooking);
  const isFirstFloorBooked = Boolean(firstFloorBooking);
  const isParkingDirectBooked = Boolean(parkingBooking);

  // 1. Full Area Status
  const fullAreaStatus = {
    isBooked: isFullAreaBooked,
    label: isFullAreaBooked ? "Full Area: Booked" : "Full Area: Vacant",
    booking: fullAreaBooking
  };

  // 2. First Floor Status: red if full area booked OR first floor booked, else green
  let firstFloorLabel = "First Floor: Vacant";
  let firstFloorIsRed = false;
  if (isFullAreaBooked) {
    firstFloorIsRed = true;
    firstFloorLabel = "First Floor: Full Area Booked";
  } else if (isFirstFloorBooked) {
    firstFloorIsRed = true;
    firstFloorLabel = "First Floor: Booked";
  }
  const firstFloorStatus = {
    isBooked: firstFloorIsRed,
    label: firstFloorLabel,
    booking: firstFloorBooking || fullAreaBooking
  };

  // 3. Parking Area Status: red if parking booked OR full area booked OR first floor booked, else green
  let parkingLabel = "Parking: Vacant";
  let parkingIsRed = false;
  if (isParkingDirectBooked) {
    parkingIsRed = true;
    parkingLabel = "Parking: Booked";
  } else if (isFullAreaBooked) {
    parkingIsRed = true;
    parkingLabel = "Parking: Full Area Booked";
  } else if (isFirstFloorBooked) {
    parkingIsRed = true;
    parkingLabel = "Parking: First Floor Booked";
  }
  const parkingStatus = {
    isBooked: parkingIsRed,
    label: parkingLabel,
    booking: parkingBooking || fullAreaBooking || firstFloorBooking
  };

  // 4. Custom Expansion Venues (Venue 4, Venue 5, etc.)
  const customVenuesStatus = [];
  (db.spaces || []).forEach(space => {
    if (["SP-MAIN-FULL", "SP-TOP-SOLO", "SP-PARKING-ONLY"].includes(space.space_id)) {
      return; // Handled by standard cards
    }
    const venueBooking = activeBookings.find(b => b.space_id === space.space_id);
    const isBooked = Boolean(venueBooking);
    customVenuesStatus.push({
      spaceId: space.space_id,
      name: space.name,
      isBooked: isBooked,
      label: isBooked ? `${space.name}: Booked` : `${space.name}: Vacant`,
      booking: venueBooking
    });
  });

  return {
    fullArea: fullAreaStatus,
    firstFloor: firstFloorStatus,
    parking: parkingStatus,
    customVenues: customVenuesStatus,
    allActive: activeBookings
  };
}

/**
 * Renders the Monthly Calendar Grid for the Selected Month Offset
 */
function renderMonthlyCalendar() {
  const grid = document.getElementById("monthlyCalendarGrid");
  const prevBtn = document.getElementById("calPrevMonthBtn");
  const nextBtn = document.getElementById("calNextMonthBtn");
  if (!grid) return;

  if (prevBtn) prevBtn.disabled = (gMonthlyOffset <= MIN_MONTH_OFFSET);
  if (nextBtn) nextBtn.disabled = (gMonthlyOffset >= MAX_MONTH_OFFSET);

  grid.innerHTML = "";

  const targetMonthDate = getOffsetDate(gMonthlyOffset);
  const year = targetMonthDate.getFullYear();
  const month = targetMonthDate.getMonth();

  const firstDayIndex = new Date(year, month, 1).getDay(); // 0 = Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthLastDate = new Date(year, month, 0).getDate();

  // 1. Previous month trailing days
  for (let i = firstDayIndex - 1; i >= 0; i--) {
    const prevDateNum = prevMonthLastDate - i;
    const cell = document.createElement("div");
    cell.className = "monthly-day-cell other-month";
    cell.innerHTML = `
      <div class="monthly-day-header">
        <span class="monthly-day-number">${prevDateNum}</span>
      </div>
    `;
    grid.appendChild(cell);
  }

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  // 2. Current Month Days
  for (let day = 1; day <= daysInMonth; day++) {
    const mStr = String(month + 1).padStart(2, "0");
    const dStr = String(day).padStart(2, "0");
    const isoDate = `${year}-${mStr}-${dStr}`;

    const cell = document.createElement("div");
    cell.className = "monthly-day-cell";
    if (isoDate === todayIso) {
      cell.classList.add("is-today");
    }

    const statuses = evaluateDayStatuses(isoDate);

    // Build Status Tabs
    let tabsHtml = "";

    // Tab 1: Full Area (red-booked / green-vacant)
    tabsHtml += `
      <div class="cal-status-tab ${statuses.fullArea.isBooked ? 'tab-red' : 'tab-green'}" title="${statuses.fullArea.label}">
        ${statuses.fullArea.isBooked ? '🔴' : '🟢'} ${statuses.fullArea.label}
      </div>
    `;

    // Tab 2: First Floor (red-full area booked/first floor booked, green-vacant)
    tabsHtml += `
      <div class="cal-status-tab ${statuses.firstFloor.isBooked ? 'tab-red' : 'tab-green'}" title="${statuses.firstFloor.label}">
        ${statuses.firstFloor.isBooked ? '🔴' : '🟢'} ${statuses.firstFloor.label}
      </div>
    `;

    // Tab 3: Parking Area (red-parking booked/full area booked/first floor booked, green-vacant)
    tabsHtml += `
      <div class="cal-status-tab ${statuses.parking.isBooked ? 'tab-red' : 'tab-green'}" title="${statuses.parking.label}">
        ${statuses.parking.isBooked ? '🔴' : '🟢'} ${statuses.parking.label}
      </div>
    `;

    // Tab 4+: Custom Venues (Venue 4, 5, etc.: red-booked, green-vacant)
    statuses.customVenues.forEach(cv => {
      tabsHtml += `
        <div class="cal-status-tab ${cv.isBooked ? 'tab-red' : 'tab-green'}" title="${cv.label}">
          ${cv.isBooked ? '🔴' : '🟢'} ${cv.label}
        </div>
      `;
    });

    cell.innerHTML = `
      <div class="monthly-day-header">
        <span class="monthly-day-number">${day}</span>
      </div>
      <div class="cal-tabs-wrap">
        ${tabsHtml}
      </div>
    `;

    // Click on date opens reservation modal or inspection drawer
    cell.addEventListener("click", () => {
      if (statuses.allActive.length > 0 && currentRole !== 'customer') {
        inspectBooking(statuses.allActive[0].booking_id);
      } else {
        document.getElementById("bookStartDate").value = isoDate;
        openNewBookingModal();
      }
    });

    grid.appendChild(cell);
  }

  // 3. Next month leading days
  const totalRendered = firstDayIndex + daysInMonth;
  const trailingCount = (7 - (totalRendered % 7)) % 7;
  for (let nextDay = 1; nextDay <= trailingCount; nextDay++) {
    const cell = document.createElement("div");
    cell.className = "monthly-day-cell other-month";
    cell.innerHTML = `
      <div class="monthly-day-header">
        <span class="monthly-day-number">${nextDay}</span>
      </div>
    `;
    grid.appendChild(cell);
  }
}
