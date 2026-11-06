/**
 * ==============================================================================
 * MONTHLY CALENDAR ENGINE (8-Month Rolling Window)
 * Range: Previous Month (-1), Live Month (0), and Next 6 Months (+1 to +6)
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
 * Evaluates Venue & Parking Status for any given date
 */
function getDayBookingEvaluation(isoDate) {
  // Active bookings on this date (not cancelled)
  const activeBookings = (db.bookings || []).filter(b => 
    b.status !== "Cancelled" &&
    Array.isArray(b.dates) &&
    b.dates.includes(isoDate)
  );

  // 1. Check Main Venue or Top Floor (both belong to GRP_MAIN_AUDITORIUM)
  const venueBooking = activeBookings.find(b => 
    b.space_id === "SP-MAIN-FULL" || b.space_id === "SP-TOP-SOLO"
  );
  const isVenueBooked = Boolean(venueBooking);

  // 2. Check Parking Reservation (Standalone space or add-on parking fee)
  const parkingBooking = activeBookings.find(b => 
    b.space_id === "SP-PARKING-ONLY" || 
    Number(b.parking_sqft || 0) > 0 || 
    Number(b.parking_fee || 0) > 0
  );
  const isParkingBooked = Boolean(parkingBooking);

  return {
    isVenueBooked,
    venueBooking,
    isParkingBooked,
    parkingBooking,
    allBookings: activeBookings
  };
}

/**
 * Renders the full monthly grid
 */
function renderMonthlyCalendar() {
  const grid = document.getElementById("monthlyCalendarGrid");
  const prevBtn = document.getElementById("calPrevMonthBtn");
  const nextBtn = document.getElementById("calNextMonthBtn");
  if (!grid) return;

  // Toggle boundary button states
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

  // Current today reference
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

    const evalResult = getDayBookingEvaluation(isoDate);

    // Build tabs based on business logic:
    // a) Main venue or top floor: RED if booked, GREEN if both vacant
    let venueTabHtml = "";
    if (evalResult.isVenueBooked) {
      const spaceLabel = evalResult.venueBooking.space_id === "SP-MAIN-FULL" ? "Main Venue" : "Top Floor";
      venueTabHtml = `<div class="status-tab tab-booked-red" title="${spaceLabel} Booked">🔴 Booked</div>`;
    } else {
      venueTabHtml = `<div class="status-tab tab-avail-green" title="Main & Top Floor Vacant">🟢 Available</div>`;
    }

    // b) Parking: RED tab if booked
    let parkingTabHtml = "";
    if (evalResult.isParkingBooked) {
      parkingTabHtml = `<div class="status-tab tab-parking-red" title="Parking Area Booked">🚗 Parking Booked</div>`;
    }

    cell.innerHTML = `
      <div class="monthly-day-header">
        <span class="monthly-day-number">${day}</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:3px;">
        ${venueTabHtml}
        ${parkingTabHtml}
      </div>
    `;

    // Click handler to open inspection or booking modal directly
    cell.addEventListener("click", () => {
      if (evalResult.venueBooking && currentRole !== 'customer') {
        inspectBooking(evalResult.venueBooking.booking_id);
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
