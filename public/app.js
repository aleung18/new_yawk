// new yawk: front-end for the trip planner (clock, nav, places + map, schedule).
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
}

const state = {
  places: [], schedule: [], trip: { start: null, end: null },
  kind: 'all', hood: '', cuisine: '', cat: '',   // filters
  day: null,                                      // selected schedule day (YYYY-MM-DD)
};

// ---------------- Date helpers ----------------
const parseDay = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDow = s => parseDay(s).toLocaleDateString('en-US', { weekday: 'short' });
const fmtShort = s => parseDay(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtLong = s => parseDay(s).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// All trip days (arrive → leave), plus any day that has plans outside that range
function tripDays() {
  const days = new Set(state.schedule.map(s => s.day));
  if (state.trip.start && state.trip.end) {
    for (let d = parseDay(state.trip.start), n = 0; dayKey(d) <= state.trip.end && n < 60; d.setDate(d.getDate() + 1), n++) {
      days.add(dayKey(d));
    }
  } else if (state.trip.start) days.add(state.trip.start);
  return [...days].sort();
}

// ---------------- NYC clock ----------------
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
function tickClock() {
  const now = new Date();
  $('#clock-time').innerHTML = timeFmt.formatToParts(now).map(p =>
    p.type === 'literal' && p.value === ':' ? '<span class="colon">:</span>' : esc(p.value)).join('');
  $('#clock-date').textContent = dateFmt.format(now);
}
tickClock();
setInterval(tickClock, 1000);

// Top bar gets a hairline once you scroll past the top
const topbar = $('#topbar');
addEventListener('scroll', () => topbar.classList.toggle('scrolled', scrollY > 8), { passive: true });

// ---------------- Maps (Leaflet + OpenStreetMap tiles, no API key; grayscaled in CSS) ----------------
const NYC = [40.7359, -73.9911];
function makeMap(id, zoom = 12) {
  const map = L.map(id, { scrollWheelZoom: false }).setView(NYC, zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
  map.on('focus click', () => map.scrollWheelZoom.enable());   // wheel-zoom only after you click the map
  map.on('mouseout', () => map.scrollWheelZoom.disable());
  return map;
}
const pinIcon = kind => L.divIcon({ className: '', html: `<span class="pin ${kind}"></span>`, iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -8] });
const numIcon = n => L.divIcon({ className: '', html: `<span class="num-pin">${n}</span>`, iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] });

const placesMap = makeMap('map');
const placesLayer = L.layerGroup().addTo(placesMap);
const dayMap = makeMap('day-map');
const dayLayer = L.layerGroup().addTo(dayMap);
const markers = new Map();   // place id -> marker

function fitTo(map, latlngs) {
  if (!latlngs.length) map.setView(NYC, 12);
  else if (latlngs.length === 1) map.setView(latlngs[0], 15);
  else map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 15 });
}

// ---------------- Food & Events ----------------
const hasCoords = p => p.lat != null && p.lng != null;
const placeMeta = p => [
  p.category, p.cuisine, p.neighborhood,
  p.kind === 'event' && p.event_date ? `${fmtShort(p.event_date)}${p.event_time ? ' · ' + fmtTime(p.event_time) : ''}` : '',
].filter(Boolean).join(' · ');

function matches(p, skip) {
  return (state.kind === 'all' || p.kind === state.kind)
    && (skip === 'hood' || !state.hood || p.neighborhood === state.hood)
    && (skip === 'cuisine' || !state.cuisine || p.cuisine === state.cuisine)
    && (skip === 'cat' || !state.cat || p.category === state.cat);
}

// Each dropdown only offers values that exist in the places matching the *other* filters
function fillSelect(sel, key, filterKey, allLabel) {
  const values = [...new Set(state.places.filter(p => matches(p, filterKey)).map(p => p[key]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  if (state[filterKey] && !values.includes(state[filterKey])) values.unshift(state[filterKey]);
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    values.map(v => `<option${v === state[filterKey] ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function renderPlaces() {
  $$('#kind-tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.kind === state.kind));
  fillSelect($('#f-hood'), 'neighborhood', 'hood', 'All neighborhoods');
  fillSelect($('#f-cuisine'), 'cuisine', 'cuisine', 'All cuisines');
  fillSelect($('#f-cat'), 'category', 'cat', 'All types');
  $('#f-cuisine').hidden = state.kind === 'event';

  const list = state.places.filter(p => matches(p));
  const ul = $('#place-list');
  if (!list.length) {
    const filtered = state.hood || state.cuisine || state.cat;
    ul.innerHTML = `<li class="empty">${state.places.length
      ? (filtered ? 'Nothing matches those filters.' : 'Nothing here yet.')
      : 'No spots yet. Add your first restaurant or event.'}<br>
      ${filtered ? '<button class="btn small" data-clear>Clear filters</button>' : `<button class="btn small" data-add="${state.kind === 'event' ? 'event' : 'food'}">+ Add a spot</button>`}</li>`;
  } else {
    ul.innerHTML = list.map(p => `
      <li class="card" data-id="${p.id}">
        <span class="pin ${p.kind}" title="${p.kind}"></span>
        <div>
          <h3>${esc(p.name)}</h3>
          <p class="meta">${esc(placeMeta(p)) || '&nbsp;'}</p>
          ${p.notes ? `<p class="notes">${esc(p.notes)}</p>` : ''}
        </div>
        <div class="actions">
          <button class="btn small" data-sched title="Add to schedule">+ Day</button>
          <button class="icon-btn" data-del title="Delete" aria-label="Delete ${esc(p.name)}">×</button>
        </div>
      </li>`).join('');
  }

  placesLayer.clearLayers();
  markers.clear();
  for (const p of list.filter(hasCoords)) {
    const m = L.marker([p.lat, p.lng], { icon: pinIcon(p.kind), title: p.name })
      .bindPopup(`<strong>${esc(p.name)}</strong><br>${esc(placeMeta(p))}${p.address ? `<br>${esc(p.address)}` : ''}${p.url ? `<br><a href="${esc(p.url)}" target="_blank" rel="noopener">link ↗</a>` : ''}`)
      .on('click', () => highlightCard(p.id))
      .addTo(placesLayer);
    markers.set(p.id, m);
  }
  fitTo(placesMap, list.filter(hasCoords).map(p => [p.lat, p.lng]));
}

function highlightCard(id) {
  $$('.card').forEach(c => c.classList.toggle('active', Number(c.dataset.id) === id));
  $(`.card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('#place-list').addEventListener('click', async e => {
  if (e.target.closest('[data-clear]')) { state.hood = state.cuisine = state.cat = ''; return renderPlaces(); }
  const card = e.target.closest('.card');
  if (!card) return;
  const p = state.places.find(x => x.id === Number(card.dataset.id));
  if (e.target.closest('[data-del]')) {
    if (!confirm(`Delete "${p.name}"? It will also be removed from the schedule.`)) return;
    await api(`/api/places/${p.id}`, { method: 'DELETE' });
    return load();
  }
  if (e.target.closest('[data-sched]')) return openSchedDialog(p);
  highlightCard(p.id);
  const m = markers.get(p.id);
  if (m) { placesMap.flyTo(m.getLatLng(), 16, { duration: 0.6 }); m.openPopup(); }
});

$('#kind-tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setKind(b.dataset.kind);
});
function setKind(kind, category = '') {
  state.kind = kind; state.cat = category; state.hood = ''; state.cuisine = '';
  renderPlaces();
}
$('#f-hood').addEventListener('change', e => { state.hood = e.target.value; renderPlaces(); });
$('#f-cuisine').addEventListener('change', e => { state.cuisine = e.target.value; renderPlaces(); });
$('#f-cat').addEventListener('change', e => { state.cat = e.target.value; renderPlaces(); });

// Nav stops + any "add" button, wherever they are on the page
document.addEventListener('click', e => {
  const add = e.target.closest('[data-add]');
  if (add) { e.preventDefault(); return openAddDialog(add.dataset.add); }
  const tab = e.target.closest('.lines [data-tab]');
  if (tab) setKind(tab.dataset.tab, tab.dataset.category || '');
  const day = e.target.closest('.lines [data-day]');
  if (day) selectDay(day.dataset.day);
  if (e.target.closest('.lines a')) document.activeElement?.blur();   // close the dropdown after picking
});

// ---------------- Add a spot ----------------
const addDialog = $('#add-dialog'), addForm = $('#add-form');
let pickMap, pickMarker;

function setPin(lat, lng, pan = true) {
  addForm.lat.value = lat; addForm.lng.value = lng;
  if (pickMarker) pickMarker.setLatLng([lat, lng]);
  else pickMarker = L.marker([lat, lng], { icon: pinIcon(addForm.dataset.kind) }).addTo(pickMap);
  if (pan) pickMap.setView([lat, lng], 16);
}

function setAddKind(kind) {
  addForm.dataset.kind = kind;
  addForm.kind.value = kind;
  addForm.category.setAttribute('list', kind === 'event' ? 'cat-event' : 'cat-food');
  addForm.category.placeholder = kind === 'event' ? 'Show, Museum…' : 'Café, Dessert…';
  pickMarker?.setIcon(pinIcon(kind));
}

function openAddDialog(kind = 'food') {
  addForm.reset();
  $('#add-error').textContent = '';
  $('#geo-status').textContent = 'Find the address, or click the map to drop a pin.';
  setAddKind(kind);
  addDialog.showModal();
  if (!pickMap) {
    pickMap = makeMap('pick-map', 11);
    pickMap.on('click', e => { setPin(e.latlng.lat, e.latlng.lng, false); $('#geo-status').textContent = 'Pin dropped.'; });
  }
  if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  setTimeout(() => { pickMap.invalidateSize(); pickMap.setView(NYC, 11); }, 50);  // map was hidden until now
  addForm.name.focus();
}

$('#add-kind').addEventListener('change', e => setAddKind(e.target.value));

// OpenStreetMap often labels NYC areas by "Community Board" instead of neighborhood,
// so fall back to a ZIP code → neighborhood guess (it's prefilled, so you can edit it).
const ZIP_HOODS = {
  10001: 'Chelsea', 10002: 'Lower East Side', 10003: 'East Village', 10004: 'Financial District',
  10005: 'Financial District', 10006: 'Financial District', 10007: 'Tribeca', 10009: 'East Village',
  10010: 'Gramercy', 10011: 'Chelsea', 10012: 'SoHo', 10013: 'SoHo', 10014: 'West Village',
  10016: 'Murray Hill', 10017: 'Midtown', 10018: 'Midtown', 10019: 'Midtown', 10020: 'Midtown',
  10021: 'Upper East Side', 10022: 'Midtown', 10023: 'Upper West Side', 10024: 'Upper West Side',
  10025: 'Upper West Side', 10026: 'Harlem', 10027: 'Harlem', 10028: 'Upper East Side',
  10029: 'East Harlem', 10030: 'Harlem', 10031: 'Hamilton Heights', 10032: 'Washington Heights',
  10033: 'Washington Heights', 10034: 'Inwood', 10035: 'East Harlem', 10036: 'Midtown',
  10037: 'Harlem', 10038: 'Financial District', 10039: 'Harlem', 10040: 'Washington Heights',
  10044: 'Roosevelt Island', 10065: 'Upper East Side', 10069: 'Upper West Side', 10075: 'Upper East Side',
  10128: 'Upper East Side', 10280: 'Battery Park City', 10282: 'Battery Park City',
  11201: 'Brooklyn Heights', 11205: 'Fort Greene', 11206: 'Williamsburg', 11211: 'Williamsburg',
  11249: 'Williamsburg', 11222: 'Greenpoint', 11215: 'Park Slope', 11217: 'Boerum Hill',
  11231: 'Carroll Gardens', 11238: 'Prospect Heights', 11237: 'Bushwick', 11221: 'Bushwick',
  11216: 'Bed-Stuy', 11233: 'Bed-Stuy', 11213: 'Crown Heights', 11225: 'Crown Heights',
  11220: 'Sunset Park', 11232: 'Sunset Park', 11224: 'Coney Island', 11226: 'Flatbush',
  11101: 'Long Island City', 11109: 'Long Island City', 11102: 'Astoria', 11103: 'Astoria',
  11105: 'Astoria', 11106: 'Astoria', 11354: 'Flushing', 11355: 'Flushing',
  11372: 'Jackson Heights', 11377: 'Woodside',
};
function guessNeighborhood(a) {
  const n = a.neighbourhood || a.quarter;
  if (n && !/community board/i.test(n)) return n;
  return ZIP_HOODS[String(a.postcode || '').slice(0, 5)] || a.suburb || '';
}

// Look up the address (or the name) with OpenStreetMap's free geocoder, limited to NYC
async function geocode() {
  const q = addForm.address.value.trim() || addForm.name.value.trim();
  const status = $('#geo-status');
  if (!q) { status.textContent = 'Type an address or a name first.'; return; }
  status.textContent = 'Searching…';
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1'
      + '&viewbox=-74.27,40.92,-73.68,40.49&bounded=1&q=' + encodeURIComponent(q);
    const [hit] = await (await fetch(url)).json();
    if (!hit) { status.textContent = 'Couldn’t find that in NYC. Try the street address, or click the map.'; return; }
    setPin(Number(hit.lat), Number(hit.lon));
    const a = hit.address || {};
    if (!addForm.neighborhood.value) addForm.neighborhood.value = guessNeighborhood(a);
    if (!addForm.address.value) {
      addForm.address.value = [[a.house_number, a.road].filter(Boolean).join(' '), a.suburb].filter(Boolean).join(', ');
    }
    status.textContent = `Found: ${hit.display_name.split(',').slice(0, 3).join(',')}`;
  } catch {
    status.textContent = 'Search failed (are you online?). You can click the map instead.';
  }
}
$('#geo-btn').addEventListener('click', geocode);
addForm.address.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); geocode(); } });

addForm.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const place = await api('/api/places', { method: 'POST', body: Object.fromEntries(new FormData(addForm)) });
    addDialog.close();
    if (state.kind !== 'all' && state.kind !== place.kind) state.kind = place.kind;
    await load();
    highlightCard(place.id);
  } catch (err) { $('#add-error').textContent = err.message; }
});

// ---------------- Add to schedule ----------------
const schedDialog = $('#sched-dialog'), schedForm = $('#sched-form');

function openSchedDialog(p) {
  schedForm.reset();
  $('#sched-error').textContent = '';
  schedForm.place_id.value = p.id;
  $('#sched-name').textContent = p.name;
  const days = tripDays();
  const preset = p.event_date || state.day || days[0] || '';
  // With trip dates set, pick from the trip's days; otherwise any date
  $('#sched-day-field').innerHTML = days.length
    ? `<select name="day" required>${days.map(d => `<option value="${d}"${d === preset ? ' selected' : ''}>${fmtDow(d)}, ${fmtShort(d)}</option>`).join('')}${p.event_date && !days.includes(p.event_date) ? `<option value="${p.event_date}" selected>${fmtDow(p.event_date)}, ${fmtShort(p.event_date)}</option>` : ''}</select>`
    : `<input type="date" name="day" required value="${preset}">`;
  if (p.event_time) schedForm.time.value = p.event_time;
  schedDialog.showModal();
}

schedForm.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(schedForm));
    await api('/api/schedule', { method: 'POST', body });
    schedDialog.close();
    state.day = body.day;
    await load();
  } catch (err) { $('#sched-error').textContent = err.message; }
});

$$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------------- Schedule ----------------
const tripStart = $('#trip-start'), tripEnd = $('#trip-end');
async function saveTrip() {
  const msg = $('#trip-msg');
  if (tripStart.value && !tripEnd.value) tripEnd.min = tripStart.value;
  try {
    state.trip = await api('/api/trip', { method: 'PUT', body: { start: tripStart.value || null, end: tripEnd.value || null } });
    msg.textContent = '';
    renderSchedule();
  } catch (err) { msg.textContent = err.message; }
}
tripStart.addEventListener('change', () => { tripEnd.min = tripStart.value; saveTrip(); });
tripEnd.addEventListener('change', saveTrip);

function selectDay(day) { state.day = day; renderSchedule(); }

function renderSchedule() {
  tripStart.value = state.trip.start || '';
  tripEnd.value = state.trip.end || '';
  tripEnd.min = state.trip.start || '';

  const days = tripDays();
  if (!days.includes(state.day)) {
    const today = dayKey(new Date());
    state.day = days.includes(today) ? today : days[0] || null;
  }
  const count = d => state.schedule.filter(s => s.day === d).length;

  // Nav dropdown: one stop per day
  $('#nav-days').innerHTML = days.length
    ? days.slice(0, 10).map(d => `<li><a href="#schedule" data-day="${d}">${fmtDow(d)} ${fmtShort(d)}${count(d) ? ` · ${count(d)}` : ''}</a></li>`).join('')
    : '<li><a href="#schedule">Set trip dates</a></li>';

  // The day "line"
  $('#days').innerHTML = days.map(d => `
    <button class="day" role="tab" aria-selected="${d === state.day}" data-day="${d}">
      <span class="dow">${fmtDow(d)}</span>
      <span class="date">${fmtShort(d)}</span>
      <span class="count">${count(d) ? `${count(d)} stop${count(d) > 1 ? 's' : ''}` : '—'}</span>
    </button>`).join('');

  const detail = $('#day-detail');
  dayLayer.clearLayers();
  if (!state.day) {
    detail.innerHTML = '<p class="empty">Set your arrival and departure dates above to lay out the trip.</p>';
    fitTo(dayMap, []);
    return;
  }

  const items = state.schedule.filter(s => s.day === state.day);
  let n = 0;
  const numbered = items.map(s => ({ ...s, n: hasCoords(s) ? ++n : null }));
  detail.innerHTML = `<h3>${fmtLong(state.day)}</h3>` + (items.length
    ? `<ul class="itinerary">${numbered.map(s => `
        <li class="stop" data-id="${s.id}">
          ${s.n ? `<span class="num-pin">${s.n}</span>` : '<span></span>'}
          <span class="time">${fmtTime(s.time) || '—'}</span>
          <div>
            <div class="name">${esc(s.name)}</div>
            <div class="meta">${esc([s.category, s.cuisine, s.neighborhood].filter(Boolean).join(' · '))}</div>
            ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
          </div>
          <button class="icon-btn" data-unsched title="Remove from this day" aria-label="Remove ${esc(s.name)}">×</button>
        </li>`).join('')}</ul>`
    : '<p class="empty">Nothing planned yet. Use “+ Day” on any spot in Food &amp; Events.</p>');

  // Map: numbered stops in time order, joined by a line, so you can see if the day hangs together
  const pts = numbered.filter(s => s.n).map(s => {
    L.marker([s.lat, s.lng], { icon: numIcon(s.n), title: s.name })
      .bindPopup(`<strong>${s.n}. ${esc(s.name)}</strong>${s.time ? `<br>${fmtTime(s.time)}` : ''}${s.neighborhood ? `<br>${esc(s.neighborhood)}` : ''}`)
      .addTo(dayLayer);
    return [s.lat, s.lng];
  });
  if (pts.length > 1) L.polyline(pts, { color: '#ee352e', weight: 5, opacity: 0.85 }).addTo(dayLayer);
  fitTo(dayMap, pts);
}

$('#days').addEventListener('click', e => {
  const b = e.target.closest('.day');
  if (b) selectDay(b.dataset.day);
});
$('#day-detail').addEventListener('click', async e => {
  const btn = e.target.closest('[data-unsched]');
  if (!btn) return;
  await api(`/api/schedule/${btn.closest('.stop').dataset.id}`, { method: 'DELETE' });
  load();
});

// ---------------- Load everything ----------------
async function load() {
  [state.places, state.schedule, state.trip] = await Promise.all([
    api('/api/places'), api('/api/schedule'), api('/api/trip'),
  ]);
  renderPlaces();
  renderSchedule();
}
load();
