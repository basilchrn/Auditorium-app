/**
 * ==============================================================================
 * app-logic.js
 * Application controller, state management, dynamic pricing calculator,
 * and the 8-Month Multi-Venue Calendar controller.
 * ==============================================================================
 */

let currentRole = 'admin';
let db = {
  config: { ...DEFAULT_CONFIG },
  spaces: [ ...DEFAULT_SPACES ],
  bookings: []
};

// 8-Month Rolling Window Constants
let gMonthlyOffset = 0; // 0 = Live Month, -1 = Previous Month, +1 to +6 = Future Months
const MIN_MONTH_OFFSET = -1;
const MAX_MONTH_OFFSET = 6;

window.addEventListener("DOMContentLoaded", () => {
  const today = new Date().toISOString().split("T")[0];
  const mDate = document.getElementById("matrixDate");
  const bDate = document.getElementById("bookStartDate");
  if (mDate) mDate.value = today;
  if (bDate) bDate.value = today;

  // 1. Load initial cache
  db = DataStore.getLocal();
  populateSpaceDropdown();

  // 2. Initialize Calendar & Views
  initMonthlyCalendar();
  renderApp();

  // 3. Trigger live sync with Google Sheets
  syncWithSheets(false);
});

async function syncWithSheets(isManual = false) {
  const dot = document.getElementById("syncDot");
  const statusText = document.getElementById("syncStatusText");
  const tsEl = document.getElementById("syncTimestamp");

  if (dot) dot.className = "sync-dot syncing";
  if (statusText) statusText.innerText = "Syncing with Google Sheets...";

  const res = await DataStore.fetchFromSheets();

  if (res.success) {
    db = res.data;
    if (dot) dot.className = "sync-dot";
    if (statusText) statusText.innerText = "✓ Live Sheet Sync Active";
    if (tsEl) tsEl.innerText = "Updated " + (res.timestamp || new Date().toLocaleTimeString());
    
    populateSpaceDropdown();
    renderApp();
    renderMonthlyCalendar();

    if (isManual) showToast("Synced with Google Sheets!");
  } else {
    if (dot) dot.className = res.isConfigured ? "sync-dot offline" : "sync-dot";
    if (statusText) statusText.innerText = res.message;
    if (isManual) showToast(res.message);
  }
}

function setRole(role, btnElement) {
  currentRole = role;
  document.querySelectorAll(".role-btn").forEach(b => b.classList.remove("active"));
  btnElement.classList.add("active");

  const isCustomer = role === 'customer';
  const isAdmin = role === 'admin';

  const kpi = document.getElementById("kpiSection");
  const addBtn = document.getElementById("addVenueBtn");
  const bookBtn = document.getElementById("topBookBtn");
  const ledger = document.getElementById("ledgerSection");

  if (kpi) kpi.style.display = isCustomer ? "none" : "grid";
  if (addBtn) addBtn.style.display = isAdmin ? "inline-flex" : "none";
  if (bookBtn) bookBtn.innerText = isCustomer ? "Request Hold" : "+ New Booking";
  if (ledger) ledger.style.display = isCustomer ? "none" : "block";

  showToast(`Switched to ${role.toUpperCase()} mode.`);
  renderApp();
}

function populateSpaceDropdown() {
  const select = document.getElementById("bookSpaceSelect");
  if (!select) return;
  if (!db.spaces || !db.spaces.length) {
    select.innerHTML = `<option value="">No spaces available</option>`;
    return;
  }
  select.innerHTML = db.spaces.map(s => `
    <option value="${s.space_id}">${s.name} (Cap: ${s.capacity} pax)</option>
  `).join("");

  onSpaceOrDateChange();
}

function renderApp() {
  renderKPIs();
  renderSlotMatrix();
  renderSpacesList();
  renderMonthlyCalendar();
  renderBookingsTable();
}

function renderKPIs() {
  const sEl = document.getElementById("kpiSpaces");
  const bEl = document.getElementById("kpiBookings");
  const hEl = document.getElementById("kpiHolds");
  const aEl = document.getElementById("kpiAdvance");

  if (sEl) sEl.innerText = db.spaces.length;
  if (bEl) bEl.innerText = db.bookings.length;

  const holds = db.bookings.filter(b => b.status === "Tentative_Hold").length;
  if (hEl) hEl.innerText = holds;

  const totalAdvance = db.bookings.reduce((sum, b) => sum + Number(b.advance_paid || 0), 0);
  if (aEl) aEl.innerText = `₹${totalAdvance.toLocaleString()}`;
}

function renderSlotMatrix() {
  const mDateInput = document.getElementById("matrixDate");
  const grid = document.getElementById("matrixGrid");
  if (!mDateInput || !grid) return;

  const targetDate = mDateInput.value;
  if (!targetDate) return;

  const slots = [
    { code: "MORN", name: "Morning (10:00 - 16:00)" },
    { code: "EVE", name: "Evening (17:00 - 22:00)" }
  ];

  let html = `
    <div style="display:grid; grid-template-columns: 180px repeat(2, 1fr); gap:0.5rem; align-items:center;">
      <div class="matrix-th">Venue Space</div>
      <div class="matrix-th">Morning Slot (10-16h)</div>
      <div class="matrix-th">Evening Slot (17-22h)</div>
    </div>
  `;

  db.spaces.forEach(space => {
    html += `
      <div style="display:grid; grid-template-columns: 180px repeat(2, 1fr); gap:0.5rem; margin-top:0.5rem; align-items:stretch;">
        <div style="background:var(--bg-surface); padding:0.75rem; border-radius:var(--radius-md); border:1px solid var(--border-color); display:flex; flex-direction:column; justify-content:center;">
          <strong style="font-size:0.85rem;">${space.name}</strong>
          <span style="font-size:0.68rem; color:var(--text-muted);">${space.capacity} Pax • Group: ${space.conflict_group}</span>
        </div>
    `;

    slots.forEach(slot => {
      const statusObj = getSlotStatus(space, targetDate, slot.code);
      const isAvail = statusObj.status === "Available";
      const isHold = statusObj.status === "Tentative_Hold";
      const isBooked = statusObj.status === "Confirmed";

      let cardClass = "is-available";
      let badgeText = "Available";
      if (isHold) { cardClass = "is-hold"; badgeText = "Hold"; }
      if (isBooked) { cardClass = "is-booked"; badgeText = "Booked"; }

      html += `
        <div class="matrix-card ${cardClass}" onclick="handleSlotCardClick('${space.space_id}', '${targetDate}', '${slot.code}', '${statusObj.status}', '${statusObj.bookingId || ''}')">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem;">
            <span class="slot-badge ${slot.code === 'MORN' ? 'badge-morn' : 'badge-eve'}">${slot.code}</span>
            <span style="font-size:0.65rem; font-weight:800; color:${isAvail ? 'var(--success)' : isHold ? 'var(--hold)' : 'var(--danger)'};">
              ${badgeText}
            </span>
          </div>
          <div style="font-size:0.75rem; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${statusObj.label}
          </div>
          ${isHold && statusObj.holdExpires ? `
            <div style="font-size:0.62rem; color:var(--hold); margin-top:2px;">Expires: ${statusObj.holdExpires}</div>
          ` : ''}
          ${statusObj.conflictWith ? `
            <div style="font-size:0.6rem; color:var(--danger); margin-top:2px;">Conflict: ${statusObj.conflictWith}</div>
          ` : ''}
        </div>
      `;
    });

    html += `</div>`;
  });

  grid.innerHTML = html;
}

function getSlotStatus(space, dateStr, slotCode) {
  const normDate = normalizeIsoDate(dateStr);

  const direct = db.bookings.find(b => 
    b.space_id === space.space_id &&
    b.dates.some(d => normalizeIsoDate(d) === normDate) &&
    b.slots.includes(slotCode) &&
    String(b.status).toLowerCase() !== "cancelled"
  );

  if (direct) {
    return {
      status: direct.status,
      label: direct.tenant_name || "Reserved",
      bookingId: direct.booking_id,
      holdExpires: direct.hold_expires_time || null
    };
  }

  const conflict = db.bookings.find(b => {
    const bookedSpace = db.spaces.find(s => s.space_id === b.space_id);
    if (!bookedSpace) return false;
    return (
      bookedSpace.conflict_group === space.conflict_group &&
      b.dates.some(d => normalizeIsoDate(d) === normDate) &&
      b.slots.includes(slotCode) &&
      String(b.status).toLowerCase() !== "cancelled"
    );
  });

  if (conflict) {
    const conflictingSpace = db.spaces.find(s => s.space_id === conflict.space_id);
    return {
      status: conflict.status,
      label: `Locked by ${conflictingSpace ? conflictingSpace.name : 'Subspace'}`,
      bookingId: conflict.booking_id,
      conflictWith: conflictingSpace ? conflictingSpace.name : "Conflict Group",
      holdExpires: conflict.hold_expires_time || null
    };
  }

  return { status: "Available", label: "Open to Reserve" };
}

function renderSpacesList() {
  const container = document.getElementById("spacesGrid");
  if (!container) return;

  container.innerHTML = db.spaces.map(s => {
    const isAuditoriumGroup = s.conflict_group === "GRP_MAIN_AUDITORIUM";
    return `
      <div class="venue-card">
        <div>
          <div class="venue-header">
            <span class="venue-name">${s.name}</span>
            <span class="venue-group-tag">${s.conflict_group}</span>
          </div>
          <div class="venue-info">
            <span>Capacity: <b>${s.capacity} Pax</b></span> • 
            <span>Rate: <b>₹${s.base_rate.toLocaleString()}/slot</b></span>
          </div>
          ${isAuditoriumGroup ? `
            <div class="venue-conflict-warning">
              <span>⚡ Shares acoustic zone: cannot run concurrently with other ${s.conflict_group} spaces.</span>
            </div>
          ` : ''}
          <p style="font-size:0.75rem; color:var(--text-muted); margin-bottom:1rem;">
            ${s.description || 'Configured rental unit'}
          </p>
        </div>
        <div>
          <button type="button" class="btn btn-outline btn-sm" onclick="quickBook('${s.space_id}')" style="width:100%;">
            Select & Book Space
          </button>
        </div>
      </div>
    `;
  }).join("");
}

/**
 * ==============================================================================
 * 8-MONTH MULTI-VENUE CALENDAR CONTROLLER
 * Window: Previous Month (-1), Live Month (0), Next 6 Months (+1 to +6)
 * ==============================================================================
 */

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

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  select.innerHTML = "";
  for (let offset = MIN_MONTH_OFFSET; offset <= MAX_MONTH_OFFSET; offset++) {
    const d = getOffsetDate(offset);
    const tag = offset === 0 ? " (Live Month)" : (offset === -1 ? " (Prev Month)" : "");
    const opt = document.createElement("option");
    opt.value = offset;
    opt.text = `${monthNames[d.getMonth()]} ${d.getFullYear()}${tag}`;
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
 * Multi-Venue Status Evaluator (Per-Day Rule Application)
 * - Full Area: red-booked / green-vacant
 * - First Floor: red-(full area booked / first floor booked) / green-vacant
 * - Parking Area: red-(parking booked / full area booked / first floor booked) / green-vacant
 * - Venue 4, 5, etc.: red-booked / green-vacant
 */
function evaluateDayStatuses(isoDate) {
  const normTarget = normalizeIsoDate(isoDate);

  const activeBookings = (db.bookings || []).filter(b => {
    if (String(b.status).toLowerCase() === "cancelled") return false;
    if (!Array.isArray(b.dates)) return false;
    return b.dates.some(d => normalizeIsoDate(d) === normTarget);
  });

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

  // 1. Full Area
  const fullAreaStatus = {
    isBooked: isFullAreaBooked,
    label: isFullAreaBooked ? "Full Area: Booked" : "Full Area: Vacant"
  };

  // 2. First Floor: red if full area booked OR first floor booked, else green
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
    label: firstFloorLabel
  };

  // 3. Parking Area: red if parking booked OR full area booked OR first floor booked, else green
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
    label: parkingLabel
  };

  // 4. Custom Expansion Venues (Venue 4, 5, etc.)
  const customVenuesStatus = [];
  (db.spaces || []).forEach(space => {
    if (["SP-MAIN-FULL", "SP-TOP-SOLO", "SP-PARKING-ONLY"].includes(space.space_id)) return;
    const vb = activeBookings.find(b => b.space_id === space.space_id);
    const isBooked = Boolean(vb);
    customVenuesStatus.push({
      name: space.name,
      isBooked: isBooked,
      label: isBooked ? `${space.name}: Booked` : `${space.name}: Vacant`
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

  const firstDayIndex = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthLastDate = new Date(year, month, 0).getDate();

  for (let i = firstDayIndex - 1; i >= 0; i--) {
    const prevDateNum = prevMonthLastDate - i;
    const cell = document.createElement("div");
    cell.className = "monthly-day-cell other-month";
    cell.innerHTML = `<div class="monthly-day-header"><span class="monthly-day-number">${prevDateNum}</span></div>`;
    grid.appendChild(cell);
  }

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  for (let day = 1; day <= daysInMonth; day++) {
    const mStr = String(month + 1).padStart(2, "0");
    const dStr = String(day).padStart(2, "0");
    const isoDate = `${year}-${mStr}-${dStr}`;

    const cell = document.createElement("div");
    cell.className = "monthly-day-cell";
    if (isoDate === todayIso) cell.classList.add("is-today");

    const st = evaluateDayStatuses(isoDate);

    let tabsHtml = "";
    // Full Area
    tabsHtml += `<div class="cal-status-tab ${st.fullArea.isBooked ? 'tab-red' : 'tab-green'}">${st.fullArea.isBooked ? '🔴' : '🟢'} ${st.fullArea.label}</div>`;
    // First Floor
    tabsHtml += `<div class="cal-status-tab ${st.firstFloor.isBooked ? 'tab-red' : 'tab-green'}">${st.firstFloor.isBooked ? '🔴' : '🟢'} ${st.firstFloor.label}</div>`;
    // Parking Area
    tabsHtml += `<div class="cal-status-tab ${st.parking.isBooked ? 'tab-red' : 'tab-green'}">${st.parking.isBooked ? '🔴' : '🟢'} ${st.parking.label}</div>`;
    // Venue 4, 5, etc.
    st.customVenues.forEach(cv => {
      tabsHtml += `<div class="cal-status-tab ${cv.isBooked ? 'tab-red' : 'tab-green'}">${cv.isBooked ? '🔴' : '🟢'} ${cv.label}</div>`;
    });

    cell.innerHTML = `
      <div class="monthly-day-header"><span class="monthly-day-number">${day}</span></div>
      <div class="cal-tabs-wrap">${tabsHtml}</div>
    `;

    cell.addEventListener("click", () => {
      if (st.allActive.length > 0 && currentRole !== 'customer') {
        inspectBooking(st.allActive[0].booking_id);
      } else {
        const bStart = document.getElementById("bookStartDate");
        if (bStart) bStart.value = isoDate;
        openNewBookingModal();
      }
    });

    grid.appendChild(cell);
  }

  const totalRendered = firstDayIndex + daysInMonth;
  const trailingCount = (7 - (totalRendered % 7)) % 7;
  for (let nextDay = 1; nextDay <= trailingCount; nextDay++) {
    const cell = document.createElement("div");
    cell.className = "monthly-day-cell other-month";
    cell.innerHTML = `<div class="monthly-day-header"><span class="monthly-day-number">${nextDay}</span></div>`;
    grid.appendChild(cell);
  }
}

function renderBookingsTable() {
  const tbody = document.getElementById("bookingsTableBody");
  if (!tbody) return;

  if (!db.bookings || db.bookings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:1.5rem; color:var(--text-muted);">No reservations recorded in sheet ledger.</td></tr>`;
    return;
  }

  tbody.innerHTML = db.bookings.map(b => {
    const space = db.spaces.find(s => s.space_id === b.space_id);
    const due = Math.max(0, Number(b.grand_total) - Number(b.advance_paid));
    const isHold = b.status === "Tentative_Hold";

    return `
      <tr>
        <td style="font-family:monospace; font-weight:700;">${b.booking_id}</td>
        <td style="font-weight:700;">${space ? space.name : b.space_id}</td>
        <td>
          <div>${b.tenant_name}</div>
          <div style="font-size:0.68rem; color:var(--text-muted);">${b.tenant_phone}</div>
        </td>
        <td>
          <div style="font-size:0.72rem;">${b.dates.join(", ")}</div>
          <div style="font-size:0.65rem; color:var(--primary); font-weight:700;">${b.slot_package_name || b.slots.join("+")}</div>
        </td>
        <td>
          <span style="font-size:0.65rem; font-weight:800; padding:2px 6px; border-radius:4px; background:${isHold ? 'var(--hold-bg)' : 'var(--success-bg)'}; color:${isHold ? 'var(--hold)' : 'var(--success)'};">
            ${b.status}
          </span>
        </td>
        <td style="font-weight:700;">₹${Number(b.grand_total).toLocaleString()}</td>
        <td style="color:var(--success); font-weight:700;">₹${Number(b.advance_paid).toLocaleString()}</td>
        <td style="color:${due > 0 ? 'var(--accent-gold)' : 'var(--text-dim)'}; font-weight:800;">₹${due.toLocaleString()}</td>
        <td style="text-align:right;">
          <button type="button" class="btn btn-outline btn-sm" onclick="inspectBooking('${b.booking_id}')">
            Inspect
          </button>
        </td>
      </tr>
    `;
  }).join("");
}

function onSpaceOrDateChange() {
  const spaceSelect = document.getElementById("bookSpaceSelect");
  if (!spaceSelect) return;
  const spaceId = spaceSelect.value;
  const space = db.spaces.find(s => s.space_id === spaceId);
  if (!space) return;

  const pkgSelect = document.getElementById("bookPackageSelect");
  const cautionToggle = document.getElementById("cautionToggle");
  const cautionInfo = document.getElementById("cautionInfoText");

  if (space.space_id === "SP-MAIN-FULL") {
    pkgSelect.innerHTML = `
      <option value="Single_Morn">Single Morning Slot (10-16h) - ₹15,000</option>
      <option value="Single_Eve">Single Evening Slot (17-22h) - ₹15,000</option>
      <option value="D1_Morn_Eve">Same Day Morning + Evening - ₹40,000</option>
      <option value="D1_Eve_D2_Morn">D1 Evening + D2 Morning - ₹25,000</option>
      <option value="Two_Mornings">Two Mornings (D1 Morn + D2 Morn) - ₹35,000</option>
      <option value="Two_Evenings">Two Evenings (D1 Eve + D2 Eve) - ₹35,000</option>
    `;
    cautionToggle.disabled = false;
    cautionToggle.checked = true;
    cautionInfo.innerText = "Full Venue refundable caution deposit (₹10,000)";
  } else if (space.space_id === "SP-TOP-SOLO") {
    pkgSelect.innerHTML = `
      <option value="Single_Morn">Single Morning Slot (10-16h) - ₹5,000</option>
      <option value="Single_Eve">Single Evening Slot (17-22h) - ₹5,000</option>
    `;
    cautionToggle.checked = false;
    cautionToggle.disabled = true;
    cautionInfo.innerText = "Caution deposit not applicable for First Floor";
  } else {
    pkgSelect.innerHTML = `
      <option value="Single_Morn">Morning Slot - ₹${space.base_rate.toLocaleString()}</option>
      <option value="Single_Eve">Evening Slot - ₹${space.base_rate.toLocaleString()}</option>
      <option value="D1_Morn_Eve">Full Day (Both Slots) - ₹${(space.base_rate * 2).toLocaleString()}</option>
    `;
    cautionToggle.checked = false;
    cautionInfo.innerText = "Optional deposit";
  }

  recalcLedger();
}

function onSlotPackageChange() { recalcLedger(); }

function toggleParkingInput() {
  const isChecked = document.getElementById("parkingToggle").checked;
  const wrap = document.getElementById("parkingInputWrap");
  if (wrap) wrap.style.display = isChecked ? "block" : "none";
  recalcLedger();
}

function togglePayFields() {
  const mode = document.getElementById("payMode").value;
  const upiBox = document.getElementById("upiFields");
  if (upiBox) upiBox.style.display = mode === "UPI" ? "grid" : "none";
}

function recalcLedger() {
  const spaceSelect = document.getElementById("bookSpaceSelect");
  if (!spaceSelect) return;
  const spaceId = spaceSelect.value;
  const space = db.spaces.find(s => s.space_id === spaceId);
  if (!space) return;

  const pkg = document.getElementById("bookPackageSelect").value;
  const guestPax = parseInt(document.getElementById("bookGuestPax").value) || 0;
  const cfg = db.config;

  let venueBase = 0;
  let slotCount = 1;

  if (space.space_id === "SP-MAIN-FULL") {
    switch (pkg) {
      case "Single_Morn": venueBase = cfg.RATE_FULL_MORN; slotCount = 1; break;
      case "Single_Eve": venueBase = cfg.RATE_FULL_EVE; slotCount = 1; break;
      case "D1_Morn_Eve": venueBase = cfg.RATE_FULL_SAME_DAY_BOTH; slotCount = 2; break;
      case "D1_Eve_D2_Morn": venueBase = cfg.RATE_FULL_EVE_NEXT_MORN; slotCount = 2; break;
      case "Two_Mornings": venueBase = cfg.RATE_FULL_TWO_MORNINGS; slotCount = 2; break;
      case "Two_Evenings": venueBase = cfg.RATE_FULL_TWO_EVENINGS; slotCount = 2; break;
      default: venueBase = cfg.RATE_FULL_MORN; slotCount = 1;
    }
  } else if (space.space_id === "SP-TOP-SOLO") {
    venueBase = cfg.RATE_TOP_PER_SLOT;
    slotCount = 1;
  } else {
    slotCount = pkg === "D1_Morn_Eve" ? 2 : 1;
    venueBase = space.base_rate * slotCount;
  }

  let extraPaxCharge = 0;
  const paxNotice = document.getElementById("paxSurchargeNotice");
  if (space.capacity > 0 && guestPax > space.capacity) {
    const excess = guestPax - space.capacity;
    extraPaxCharge = excess * (cfg.EXTRA_PAX_SURCHARGE_PER_HEAD || 200);
    if (paxNotice) paxNotice.style.display = "block";
  } else {
    if (paxNotice) paxNotice.style.display = "none";
  }

  let parkingFee = 0;
  const isParking = document.getElementById("parkingToggle").checked;
  const lineParking = document.getElementById("lineParking");
  if (isParking) {
    const sqft = parseFloat(document.getElementById("parkingSqft").value) || 0;
    const minFee = cfg.PARKING_MIN_FEE || 4000;
    const rateSqft = cfg.PARKING_PER_SQFT || 200;
    parkingFee = Math.max(minFee, sqft * rateSqft) * slotCount;
    if (lineParking) lineParking.style.display = "flex";
    document.getElementById("leadParking").innerText = `₹${parkingFee.toLocaleString()}`;
  } else {
    if (lineParking) lineParking.style.display = "none";
  }

  let wasteFee = 0;
  const isWaste = document.getElementById("wasteToggle").checked;
  const lineWaste = document.getElementById("lineWaste");
  if (isWaste) {
    wasteFee = cfg.WASTE_DISPOSAL_FEE || 1000;
    if (lineWaste) lineWaste.style.display = "flex";
    document.getElementById("leadWaste").innerText = `₹${wasteFee.toLocaleString()}`;
  } else {
    if (lineWaste) lineWaste.style.display = "none";
  }

  const subtotal = venueBase + extraPaxCharge + parkingFee + wasteFee;

  let gstAmount = 0;
  const isGst = document.getElementById("gstToggle").checked;
  const lineGst = document.getElementById("lineGst");
  if (isGst) {
    gstAmount = Math.round(subtotal * ((cfg.GST_PERCENT || 18) / 100));
    if (lineGst) lineGst.style.display = "flex";
    document.getElementById("leadGst").innerText = `₹${gstAmount.toLocaleString()}`;
  } else {
    if (lineGst) lineGst.style.display = "none";
  }

  let cautionDeposit = 0;
  const isCaution = document.getElementById("cautionToggle").checked;
  const lineCaution = document.getElementById("lineCaution");
  if (isCaution && space.space_id === "SP-MAIN-FULL") {
    cautionDeposit = cfg.CAUTION_DEPOSIT_FULL || 10000;
    if (lineCaution) lineCaution.style.display = "flex";
    document.getElementById("leadCaution").innerText = `₹${cautionDeposit.toLocaleString()}`;
  } else {
    if (lineCaution) lineCaution.style.display = "none";
  }

  const grandTotal = subtotal + gstAmount + cautionDeposit;
  const advPct = space.space_id === "SP-MAIN-FULL" ? (cfg.ADVANCE_PCT_FULL || 50) : (cfg.ADVANCE_PCT_TOP || 100);
  const advRequired = Math.round(grandTotal * (advPct / 100));

  document.getElementById("leadVenueBase").innerText = `₹${venueBase.toLocaleString()}`;
  document.getElementById("leadExtraPax").innerText = `+₹${extraPaxCharge.toLocaleString()}`;
  document.getElementById("leadGrandTotal").innerText = `₹${grandTotal.toLocaleString()}`;
  document.getElementById("leadAdvancePct").innerText = advPct;
  document.getElementById("leadAdvanceReq").innerText = `₹${advRequired.toLocaleString()}`;

  const payInput = document.getElementById("payAmount");
  if (!payInput.value || payInput.dataset.autoFilled === "true") {
    payInput.value = advRequired;
    payInput.dataset.autoFilled = "true";
  }
}

function handleIdProofFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById("idProofBase64").value = e.target.result;
    const img = document.getElementById("idImagePreview");
    img.src = e.target.result;
    img.style.display = "block";
  };
  reader.readAsDataURL(file);
}

function generateStandaloneTestId() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 190;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#1e293b";
  ctx.fillRect(0, 0, 320, 190);

  ctx.fillStyle = "#38bdf8";
  ctx.fillRect(0, 0, 320, 32);

  ctx.fillStyle = "#0f172a";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText("GOVERNMENT ID PROOF (VERIFIED)", 20, 21);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 13px sans-serif";
  const name = document.getElementById("tName").value || "Authorized Tenant";
  ctx.fillText(name, 20, 65);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "11px sans-serif";
  ctx.fillText("DOB: 14/08/1992   Gender: Male", 20, 88);
  ctx.fillText("Address: MG Road, Bangalore", 20, 108);

  ctx.fillStyle = "#f59e0b";
  ctx.font = "bold 11px monospace";
  ctx.fillText("DOC REF: IN-VERIFIED-KYC-902", 20, 135);

  ctx.strokeStyle = "#10b981";
  ctx.lineWidth = 2;
  ctx.strokeRect(210, 130, 95, 40);
  ctx.fillStyle = "#10b981";
  ctx.font = "bold 10px sans-serif";
  ctx.fillText("OFFICIAL STAMP", 216, 154);

  const base64 = canvas.toDataURL("image/jpeg");
  document.getElementById("idProofBase64").value = base64;
  const img = document.getElementById("idImagePreview");
  img.src = base64;
  img.style.display = "block";
  showToast("Standalone Test ID Generated!");
}

async function handleBookingSubmit(event) {
  event.preventDefault();

  const idData = document.getElementById("idProofBase64").value;
  if (!idData) {
    alert("Mandatory physical government ID proof is missing.");
    return;
  }

  const spaceId = document.getElementById("bookSpaceSelect").value;
  const space = db.spaces.find(s => s.space_id === spaceId);
  const pkg = document.getElementById("bookPackageSelect").value;
  const startDate = document.getElementById("bookStartDate").value;
  const status = document.getElementById("bookStatusSelect").value;
  const advancePaid = parseFloat(document.getElementById("payAmount").value) || 0;
  const guestPax = parseInt(document.getElementById("bookGuestPax").value) || 0;

  let dates = [startDate];
  let slots = ["MORN"];
  let nextDate = getNextDay(startDate);

  if (pkg === "Single_Morn") slots = ["MORN"];
  else if (pkg === "Single_Eve") slots = ["EVE"];
  else if (pkg === "D1_Morn_Eve") slots = ["MORN", "EVE"];
  else if (pkg === "D1_Eve_D2_Morn") { dates = [startDate, nextDate]; slots = ["EVE", "MORN"]; }
  else if (pkg === "Two_Mornings") { dates = [startDate, nextDate]; slots = ["MORN"]; }
  else if (pkg === "Two_Evenings") { dates = [startDate, nextDate]; slots = ["EVE"]; }

  for (const d of dates) {
    for (const s of slots) {
      const check = getSlotStatus(space, d, s);
      if (check.status !== "Available") {
        alert(`Booking Conflict: Slot ${s} on ${d} is already ${check.status} (${check.label}).`);
        return;
      }
    }
  }

  const totalStr = document.getElementById("leadGrandTotal").innerText.replace(/[^0-9]/g, "");
  const grandTotal = parseInt(totalStr) || 0;
  const venueBase = parseInt(document.getElementById("leadVenueBase").innerText.replace(/[^0-9]/g, "")) || 0;
  const extraPax = parseInt(document.getElementById("leadExtraPax").innerText.replace(/[^0-9]/g, "")) || 0;
  const parkingFee = parseInt(document.getElementById("leadParking").innerText.replace(/[^0-9]/g, "")) || 0;
  const wasteFee = parseInt(document.getElementById("leadWaste").innerText.replace(/[^0-9]/g, "")) || 0;
  const cautionDeposit = parseInt(document.getElementById("leadCaution").innerText.replace(/[^0-9]/g, "")) || 0;
  const gstAmount = parseInt(document.getElementById("leadGst").innerText.replace(/[^0-9]/g, "")) || 0;
  const subtotal = venueBase + extraPax + parkingFee + wasteFee;
  const advanceReq = parseInt(document.getElementById("leadAdvanceReq").innerText.replace(/[^0-9]/g, "")) || 0;

  const bookingId = "AUD-" + Date.now().toString().slice(-6);

  const bookingPayload = {
    booking: {
      booking_id: bookingId,
      space_id: spaceId,
      slot_package: pkg,
      dates: dates,
      slots: slots,
      expected_pax: guestPax,
      base_venue_fee: venueBase,
      extra_pax_fee: extraPax,
      parking_sqft: parseFloat(document.getElementById("parkingSqft").value) || 0,
      parking_fee: parkingFee,
      waste_fee: wasteFee,
      caution_deposit: cautionDeposit,
      taxable_subtotal: subtotal,
      gst_amount: gstAmount,
      grand_total: grandTotal,
      advance_required: advanceReq,
      advance_paid: advancePaid,
      booking_status: status
    },
    tenant: {
      full_name: document.getElementById("tName").value,
      phone_primary: document.getElementById("tPhone").value,
      phone_alternate: document.getElementById("tAltPhone").value,
      event_purpose: document.getElementById("tPurpose").value,
      organization_name: document.getElementById("tOrg").value,
      suggested_by: document.getElementById("tSuggestedBy").value,
      special_remarks: document.getElementById("tRemarks").value,
      id_proof_base64: idData
    },
    payment: {
      payment_mode: document.getElementById("payMode").value,
      amount_paid: advancePaid,
      upi_payer_name: document.getElementById("upiPayerName").value,
      upi_id_vpa: document.getElementById("upiVpa").value,
      upi_ref_utr: document.getElementById("upiUtr").value
    }
  };

  const btn = document.getElementById("submitBookingBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerText = "Transmitting to Google Sheet...";
  }

  try {
    const res = await DataStore.postToSheets("create_booking", bookingPayload);

    const localBooking = {
      ...bookingPayload.booking,
      tenant_name: bookingPayload.tenant.full_name,
      tenant_phone: bookingPayload.tenant.phone_primary,
      slot_package_name: document.getElementById("bookPackageSelect").selectedOptions[0].text,
      id_proof_url: res.id_drive_url || idData
    };
    db.bookings.unshift(localBooking);
    DataStore.saveLocal(db);

    closeModal("bookingModal");
    document.getElementById("bookingForm").reset();
    document.getElementById("idProofBase64").value = "";
    document.getElementById("idImagePreview").style.display = "none";

    showToast(`Reservation ${bookingId} synced to Google Sheet!`);
    renderApp();
    syncWithSheets(false);
  } catch (err) {
    alert("Error saving reservation to Google Sheet: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = "✓ Authorize & Push to Google Sheet";
    }
  }
}

function inspectBooking(bookingId) {
  const b = db.bookings.find(i => i.booking_id === bookingId);
  if (!b) return;

  const space = db.spaces.find(s => s.space_id === b.space_id);
  const balance = Math.max(0, Number(b.grand_total) - Number(b.advance_paid));

  const body = document.getElementById("inspectBody");
  if (!body) return;

  body.innerHTML = `
    <div style="background:var(--bg-main); padding:0.75rem; border-radius:var(--radius-md); border:1px solid var(--border-color); margin-bottom:0.75rem;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <strong style="color:var(--primary); font-size:0.9rem;">${b.booking_id}</strong>
        <span style="font-size:0.7rem; font-weight:700; color:${b.status === 'Confirmed' ? 'var(--success)' : 'var(--hold)'};">
          ● ${b.status}
        </span>
      </div>
      <div style="font-size:0.8rem; font-weight:700; margin-top:2px;">${space ? space.name : b.space_id}</div>
      <div style="font-size:0.7rem; color:var(--text-muted);">Dates: ${b.dates.join(", ")} | Package: ${b.slot_package_name || b.slot_package}</div>
    </div>

    <div style="margin-bottom:0.75rem;">
      <label>CUSTOMER PROFILE</label>
      <div style="font-size:0.95rem; font-weight:800;">${b.tenant_name}</div>
      <div style="font-size:0.75rem; color:var(--text-muted); font-family:monospace;">📞 ${b.tenant_phone} ${b.tenant_alt_phone ? ' | ' + b.tenant_alt_phone : ''}</div>
      <div style="font-size:0.75rem; margin-top:3px;">Purpose: <b>${b.tenant_purpose || 'Event'}</b> ${b.tenant_org ? `(${b.tenant_org})` : ''}</div>
    </div>

    <div style="margin-bottom:0.75rem;">
      <label>GOVERNMENT ID PROOF</label>
      ${b.id_proof_url ? `
        <a href="${b.id_proof_url}" target="_blank">
          <img src="${b.id_proof_url}" style="width:100%; max-height:160px; object-fit:cover; border-radius:var(--radius-md); border:1px solid var(--border-color); margin-top:4px;">
        </a>
      ` : '<p style="color:var(--text-dim); font-size:0.75rem;">No ID uploaded</p>'}
    </div>

    <div class="ledger-box" style="margin-bottom:0.75rem;">
      <div class="ledger-line"><span>Grand Total:</span><b>₹${Number(b.grand_total).toLocaleString()}</b></div>
      <div class="ledger-line" style="color:var(--success);"><span>Advance Paid:</span><b>₹${Number(b.advance_paid).toLocaleString()}</b></div>
      <div class="ledger-line total" style="color:var(--accent-gold);"><span>Outstanding Balance:</span><span>₹${balance.toLocaleString()}</span></div>
    </div>

    <div style="display:flex; flex-direction:column; gap:0.5rem;">
      ${balance > 0 ? `
        <button type="button" class="btn btn-primary" onclick="settleBalanceDirect('${b.booking_id}', ${balance})">
          Settle Balance (₹${balance.toLocaleString()}) via Sheet
        </button>
      ` : `
        <div style="text-align:center; padding:0.5rem; background:var(--success-bg); color:var(--success); font-weight:700; border-radius:var(--radius-md); font-size:0.8rem;">
          ✓ Fully Settled
        </div>
      `}

      ${currentRole === 'admin' ? `
        <button type="button" class="btn btn-danger" onclick="cancelReservationPrompt('${b.booking_id}')">
          Cancel Reservation & Check Re-Booking Refund
        </button>
      ` : ''}
    </div>
  `;

  openModal("tenantInspectModal");
}

async function settleBalanceDirect(bookingId, amount) {
  try {
    await DataStore.postToSheets("settle_payment", {
      booking_id: bookingId,
      amount_paid: amount,
      payment_mode: "Cash",
      collected_by: "Admin Desk"
    });
    showToast("Settlement saved to Google Sheet!");
    closeModal("tenantInspectModal");
    await syncWithSheets(false);
  } catch (err) {
    alert("Payment settlement failed: " + err.message);
  }
}

async function cancelReservationPrompt(bookingId) {
  const b = db.bookings.find(i => i.booking_id === bookingId);
  if (!b) return;

  const confirmCancel = confirm(`Are you sure you want to cancel booking ${b.booking_id}?`);
  if (!confirmCancel) return;

  try {
    const res = await DataStore.postToSheets("cancel_booking", {
      booking_id: bookingId,
      discretionary_refund_status: "Withheld_Awaiting_Formal_Request"
    });

    alert(`Cancellation recorded in Google Sheet. Refund status: ${res.refund_status}`);
    closeModal("tenantInspectModal");
    await syncWithSheets(false);
  } catch (err) {
    alert("Cancellation failed: " + err.message);
  }
}

async function handleCreateSpace(event) {
  event.preventDefault();
  const name = document.getElementById("newSpaceName").value.trim();
  const cap = parseInt(document.getElementById("newSpaceCapacity").value) || 100;
  const rate = parseInt(document.getElementById("newSpaceRate").value) || 5000;
  const group = document.getElementById("newSpaceConflictGroup").value.trim().toUpperCase();
  const desc = document.getElementById("newSpaceDesc").value.trim();

  const btn = document.getElementById("submitSpaceBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerText = "Appending to Spaces Sheet...";
  }

  try {
    await DataStore.postToSheets("add_space", {
      name: name,
      capacity: cap,
      base_rate: rate,
      conflict_group: group,
      is_composite: false,
      description: desc
    });

    showToast(`Space "${name}" added to Google Sheet!`);
    closeModal("addSpaceModal");
    await syncWithSheets(false);
  } catch (err) {
    alert("Failed to add space: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = "Create Space & Save to Sheet";
    }
  }
}

function openModal(id) { 
  const el = document.getElementById(id);
  if (el) el.classList.add("open"); 
}
function closeModal(id) { 
  const el = document.getElementById(id);
  if (el) el.classList.remove("open"); 
}
function openNewBookingModal() {
  openModal("bookingModal");
  onSpaceOrDateChange();
}
function openAddSpaceModal() { openModal("addSpaceModal"); }

function quickBook(spaceId) {
  const sel = document.getElementById("bookSpaceSelect");
  if (sel) sel.value = spaceId;
  openNewBookingModal();
}

function handleSlotCardClick(spaceId, dateStr, slotCode, status, bookingId) {
  if (status === "Available") {
    const sel = document.getElementById("bookSpaceSelect");
    const bDate = document.getElementById("bookStartDate");
    if (sel) sel.value = spaceId;
    if (bDate) bDate.value = dateStr;
    openNewBookingModal();
  } else if (bookingId && currentRole !== 'customer') {
    inspectBooking(bookingId);
  } else {
    showToast(`Slot is ${status}.`);
  }
}

function getNextDay(dateString) {
  const d = new Date(dateString);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

function scrollToElement(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth' });
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.innerText = msg;
  toast.style.display = "block";
  setTimeout(() => { toast.style.display = "none"; }, 3000);
}
