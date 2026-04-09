// ── admin-map.js ──────────────────────────────────────────────────────────
// Harita paneli: render, drag, resize, zoom, pan, kayıt

import { db } from './firebase-config.js';
import {
  collection, addDoc, updateDoc, doc, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';

import { $, escapeHtml, getClassrooms, getBlocks, getCampuses, getBlockFloors } from './admin-state.js';
import { getClassroomFloorValue, getFloorOptionsForBlock, loadAll } from './admin-core.js';

// ── Element Tipi Tanımları ─────────────────────────────────────────────────
const ELEMENT_TYPES = {
  classroom:  { icon: '🪑', label: 'Sınıf',      defaultW: 80,  defaultH: 56  },
  corridor:   { icon: '🛤',  label: 'Koridor',    defaultW: 120, defaultH: 40  },
  door:       { icon: '🚪', label: 'Tek Kapı',    defaultW: 30,  defaultH: 40  },
  doubleDoor: { icon: '🚪🚪',label: 'Çift Kapı', defaultW: 30,  defaultH: 80  },
  toilet:     { icon: '🚺', label: 'WC',          defaultW: 50,  defaultH: 50  },
  office:     { icon: '💼', label: 'Ofis',        defaultW: 70,  defaultH: 60  },
  stairs:     { icon: '🪧', label: 'Merdiven',    defaultW: 60,  defaultH: 80  },
  elevator:   { icon: '🛗', label: 'Asansör',     defaultW: 50,  defaultH: 50  },
  cafeteria:  { icon: '☕', label: 'Kafeterya',   defaultW: 100, defaultH: 80  },
  library:    { icon: '📚', label: 'Kütüphane',   defaultW: 120, defaultH: 100 },
  lab:        { icon: '🧪', label: 'Lab',          defaultW: 90,  defaultH: 70  },
  storage:    { icon: '📦', label: 'Depo',         defaultW: 60,  defaultH: 60  }
};

// ── Map State ──────────────────────────────────────────────────────────────
let mapScale = 1;
let mapOffsetX = 0, mapOffsetY = 0;
let mapSelectedId = null;
let activeTool = 'select';
let tempIdCounter = 0;
let snapToGrid = true;
const GRID_SIZE = 20;
const SNAP_THRESHOLD = 15;
const EDGE_DETECTION_THRESHOLD = 8;
let hoveredEdge = null;
let mapData = {};

// ── DOM Referansları ───────────────────────────────────────────────────────
const mapCanvas       = $('mapCanvas');
const mapOuter        = $('mapCanvasOuter');
const mapZoomLabel    = $('mapZoomLabel');
const mapInfoCard     = $('mapInfoCard');
const mapUnplacedList = $('mapUnplacedList');

// ── Export edilen fonksiyonlar (admin-core ve admin-auth tarafından çağrılır)
export function fillMapCampusFilter() {
  const sel = $('mapCampusFilter');
  sel.innerHTML = '<option value="">— Kampüs Seç —</option>' +
    getCampuses().map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const blockSel = $('mapBlockFilter');
  const floorSel = $('mapFloorSelect');
  blockSel.innerHTML = '<option value="">— Önce Kampüs Seçin —</option>';
  blockSel.disabled = true; blockSel.style.opacity = '0.5'; blockSel.style.cursor = 'not-allowed';
  floorSel.innerHTML = '<option value="">— Önce Blok Seçin —</option>';
  floorSel.disabled = true; floorSel.style.opacity = '0.5'; floorSel.style.cursor = 'not-allowed';
  updateMapUIState();
}

export function updateMapUIState() {
  const campusId = $('mapCampusFilter').value;
  const blockId  = $('mapBlockFilter').value;
  const floor    = $('mapFloorSelect').value;
  const isReady  = campusId && blockId && floor;

  if ($('mapPlaceholder')) $('mapPlaceholder').style.display = isReady ? 'none' : 'flex';
  if ($('mapMainArea'))    $('mapMainArea').style.display    = isReady ? 'block' : 'none';

  const toolPalette = $('mapToolPalette');
  if (toolPalette) {
    toolPalette.style.opacity      = isReady ? '1' : '0.4';
    toolPalette.style.pointerEvents= isReady ? 'auto' : 'none';
  }
  if ($('mapUnplacedCard')) $('mapUnplacedCard').style.display = isReady ? 'block' : 'none';

  if (!isReady) {
    if ($('mapInfoCard')) $('mapInfoCard').style.display = 'none';
    activeTool = 'select';
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    const sel = document.querySelector('.tool-btn[data-type="select"]');
    if (sel) sel.classList.add('active');
  }
}

export function loadMapPositions() {
  getClassrooms().forEach(c => {
    if (c.mapX !== undefined) {
      // Eğer kampüs, blok veya floor bilgisi boşsa (eski veriler), yerleşmemiş gibi göster
      // Böylece kullanıcı tekrar yerleştirip kaydedebilir
      const campusId = c.campusId || '';
      const blockId = c.blockId || '';
      const floor = c.floor || '';
      
      // Sadece tam bilgisi olan derslikleri yükle
      if (!campusId || !blockId || !floor) {
        // Bu derslik yerleşmemiş gibi davranacak (mapData'ya eklenmeyecek)
        return;
      }
      
      mapData[c.id] = {
        id: c.id,
        type: c.elementType || 'classroom',
        x: c.mapX || 0,
        y: c.mapY || 0,
        w: c.mapW || 80,
        h: c.mapH || 56,
        shapes: c.shapes || [],
        rotation: c.rotation || 0,
        label: c.label || c.code || '',
        attachedTo: c.attachedTo || '',
        attachedEdge: c.attachedEdge || '',
        stairDirection: c.stairDirection || '',
        campusId,
        blockId,
        floor
      };
    }
  });
}

export function renderMapPanel() {
  // currentTab kontrolü için admin-state'e bakarız; map sekmesi aktifse render et
  const campusId = $('mapCampusFilter').value;
  const blockId  = $('mapBlockFilter').value;
  const floor    = $('mapFloorSelect').value;
  if (!campusId || !blockId || !floor) {
    if (mapCanvas) mapCanvas.innerHTML = '';
    return;
  }

  const filtered  = getFilteredClassrooms();
  const placed    = filtered.filter(c => mapData[c.id]);
  const unplaced  = filtered.filter(c => !mapData[c.id]);
  
  // Seçilen kampüs ve blok nesnelerini bul
  const selectedCampus = campusId ? getCampuses().find(c => c.id === campusId) : null;
  const selectedBlock = blockId ? getBlocks().find(b => b.id === blockId) : null;
  
  const placedElements = Object.values(mapData).filter(d => {
    if (!d.type || d.type === 'classroom') return placed.some(c => c.id === d.id);
    
    // Diğer elementler için (kapı, koridor vb) - ID veya name karşılaştır
    if (campusId && d.campusId && d.campusId !== campusId) return false;
    if (blockId && d.blockId && d.blockId !== blockId) return false;
    if (floor && d.floor && d.floor !== floor) return false;
    
    return true;
  });

  $('mapUnplacedCount').textContent = unplaced.length;
  if (!$('mapBlockFilter').value) {
    mapUnplacedList.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:12px">Blok seçin</div>`;
  } else if (unplaced.length === 0) {
    mapUnplacedList.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:12px">Tüm sınıflar yerleştirilmiş ✓</div>`;
  } else {
    mapUnplacedList.innerHTML = unplaced.map(c => `
      <div class="map-unplaced-item" data-id="${c.id}" title="Haritaya ekle">
        <span>${escapeHtml(c.code || c.id)}</span>
        <span class="add-icon">＋</span>
      </div>
    `).join('');
    mapUnplacedList.querySelectorAll('.map-unplaced-item').forEach(el => {
      el.addEventListener('click', () => placeClassroom(el.dataset.id));
    });
  }

  mapCanvas.innerHTML = '';
  placed.forEach(c => renderRoomEl(c));
  placedElements.forEach(d => {
    if (d.type && d.type !== 'classroom' && !getClassrooms().some(c => c.id === d.id)) {
      renderMapElement(d.id, d, null);
    }
  });
}

// ── İç yardımcı: paylaşılan state erişimi ─────────────────────────────────
// ── Zoom ───────────────────────────────────────────────────────────────────
function applyCanvasTransform() {
  mapCanvas.style.transform = `translate(${mapOffsetX}px,${mapOffsetY}px) scale(${mapScale})`;
}
function updateZoomLabel() { mapZoomLabel.textContent = Math.round(mapScale * 100) + '%'; }

$('mapZoomIn').addEventListener('click',    () => { mapScale = Math.min(2, mapScale + 0.1);  updateZoomLabel(); applyCanvasTransform(); });
$('mapZoomOut').addEventListener('click',   () => { mapScale = Math.max(0.2, mapScale - 0.1); updateZoomLabel(); applyCanvasTransform(); });
$('mapZoomReset').addEventListener('click', () => { mapScale = 1; mapOffsetX = 0; mapOffsetY = 0; updateZoomLabel(); applyCanvasTransform(); });

mapOuter.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.08 : -0.08;
  mapScale = Math.max(0.2, Math.min(2, mapScale + delta));
  updateZoomLabel(); applyCanvasTransform();
}, { passive: false });

// ── Pan ────────────────────────────────────────────────────────────────────
let isPanning = false, panStartX = 0, panStartY = 0, panStartOX = 0, panStartOY = 0;
mapOuter.addEventListener('mousedown', e => {
  if (e.button === 1 || (e.button === 0 && (e.target === mapCanvas || e.target === mapOuter))) {
    isPanning = true; mapOuter.classList.add('panning');
    panStartX = e.clientX; panStartY = e.clientY;
    panStartOX = mapOffsetX; panStartOY = mapOffsetY;
  }
});
window.addEventListener('mousemove', e => {
  if (!isPanning) return;
  mapOffsetX = panStartOX + (e.clientX - panStartX);
  mapOffsetY = panStartOY + (e.clientY - panStartY);
  applyCanvasTransform();
});
window.addEventListener('mouseup', () => { isPanning = false; mapOuter.classList.remove('panning'); });

// ── Filtre Select'leri ─────────────────────────────────────────────────────
$('mapCampusFilter').addEventListener('change', () => {
  const cid = $('mapCampusFilter').value;
  const blockSel = $('mapBlockFilter'), floorSel = $('mapFloorSelect');
  floorSel.innerHTML = '<option value="">— Önce Blok Seçin —</option>';
  floorSel.disabled = true; floorSel.style.opacity = '0.5'; floorSel.style.cursor = 'not-allowed';
  if (cid) {
    const filtered = getBlocks().filter(b => b.campusId === cid);
    blockSel.innerHTML = '<option value="">— Blok Seçin —</option>' +
      filtered.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    blockSel.disabled = false; blockSel.style.opacity = '1'; blockSel.style.cursor = 'pointer';
  } else {
    blockSel.innerHTML = '<option value="">— Önce Kampüs Seçin —</option>';
    blockSel.disabled = true; blockSel.style.opacity = '0.5'; blockSel.style.cursor = 'not-allowed';
  }
  updateMapUIState(); renderMapPanel();
});

$('mapBlockFilter').addEventListener('change', () => {
  const bid = $('mapBlockFilter').value;
  const floorSel = $('mapFloorSelect');
  if (bid) {
    const floorOptions = getFloorOptionsForBlock(bid);
    floorSel.innerHTML = '<option value="">— Kat Seçin —</option>' +
      floorOptions.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
    floorSel.disabled = false; floorSel.style.opacity = '1'; floorSel.style.cursor = 'pointer';
  } else {
    floorSel.innerHTML = '<option value="">— Önce Blok Seçin —</option>';
    floorSel.disabled = true; floorSel.style.opacity = '0.5'; floorSel.style.cursor = 'not-allowed';
  }
  updateMapUIState(); renderMapPanel();
});

$('mapFloorSelect').addEventListener('change', () => { updateMapUIState(); renderMapPanel(); });

// ── Araç Paleti ────────────────────────────────────────────────────────────
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeTool = btn.dataset.type;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (activeTool === 'select') {
      mapOuter.style.cursor = 'grab';
    } else if (activeTool === 'door' || activeTool === 'doubleDoor') {
      mapOuter.style.cursor = 'crosshair';
      const hint = document.createElement('div');
      hint.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#1a56db;color:#fff;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:600;z-index:1000;box-shadow:0 4px 12px rgba(26,86,219,0.3);';
      hint.textContent = `${activeTool === 'doubleDoor' ? '🚪🚪' : '🚪'} Sınıf, koridor veya ofis kenarlarına tıklayarak kapı ekleyin`;
      document.body.appendChild(hint);
      setTimeout(() => hint.remove(), 3000);
    } else {
      mapOuter.style.cursor = 'crosshair';
    }
  });
});

// ── Canvas Tıklama (element yerleştir) ────────────────────────────────────
mapCanvas.addEventListener('click', e => {
  if (activeTool === 'select' || !activeTool) return;
  const campusId = $('mapCampusFilter').value, blockId = $('mapBlockFilter').value;
  if (!campusId || !blockId) { alert('⚠️ Lütfen önce Kampüs, Blok ve Kat seçin!'); return; }

  if (activeTool === 'door' || activeTool === 'doubleDoor') {
    if (hoveredEdge) {
      placeDoorOnEdge(hoveredEdge.elementId, hoveredEdge.edge, activeTool);
      activeTool = 'select';
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.tool-btn[data-type="select"]').classList.add('active');
      mapOuter.style.cursor = 'grab';
    } else {
      alert('🚪 Kapı eklemek için bir sınıf, koridor veya ofis kenarına tıklayın!');
    }
    return;
  }

  if (e.target !== mapCanvas) return;
  const rect = mapCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / mapScale;
  const y = (e.clientY - rect.top)  / mapScale;
  placeElement(activeTool, { x: Math.max(0, x), y: Math.max(0, y) });
  activeTool = 'select';
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.tool-btn[data-type="select"]').classList.add('active');
  mapOuter.style.cursor = 'grab';
});

// ── Mouse Move (kenar tespiti) ─────────────────────────────────────────────
mapCanvas.addEventListener('mousemove', e => {
  if (activeTool !== 'door' && activeTool !== 'doubleDoor') {
    if (hoveredEdge) {
      const prevEl = mapCanvas.querySelector(`[data-id="${hoveredEdge.elementId}"]`);
      if (prevEl) prevEl.classList.remove('edge-highlight-top', 'edge-highlight-right', 'edge-highlight-bottom', 'edge-highlight-left');
      hoveredEdge = null;
    }
    return;
  }
  const rect = mapCanvas.getBoundingClientRect();
  const mouseX = (e.clientX - rect.left) / mapScale;
  const mouseY = (e.clientY - rect.top)  / mapScale;
  let newHoveredEdge = null;

  Object.entries(mapData).forEach(([id, element]) => {
    if (element.type === 'door' || element.type === 'doubleDoor') return;
    const { x: ex, y: ey, w: ew, h: eh } = element;
    if (mouseX >= ex - EDGE_DETECTION_THRESHOLD && mouseX <= ex + ew + EDGE_DETECTION_THRESHOLD &&
        mouseY >= ey - EDGE_DETECTION_THRESHOLD && mouseY <= ey + eh + EDGE_DETECTION_THRESHOLD) {
      const dTop = Math.abs(mouseY - ey), dRight = Math.abs(mouseX - (ex + ew));
      const dBottom = Math.abs(mouseY - (ey + eh)), dLeft = Math.abs(mouseX - ex);
      const minDist = Math.min(dTop, dRight, dBottom, dLeft);
      if (minDist <= EDGE_DETECTION_THRESHOLD) {
        let edge;
        if (minDist === dTop) edge = 'top';
        else if (minDist === dRight) edge = 'right';
        else if (minDist === dBottom) edge = 'bottom';
        else edge = 'left';
        newHoveredEdge = { elementId: id, edge };
      }
    }
  });

  if (hoveredEdge) {
    const prevEl = mapCanvas.querySelector(`[data-id="${hoveredEdge.elementId}"]`);
    if (prevEl) prevEl.classList.remove('edge-highlight-top', 'edge-highlight-right', 'edge-highlight-bottom', 'edge-highlight-left');
  }
  if (newHoveredEdge) {
    const newEl = mapCanvas.querySelector(`[data-id="${newHoveredEdge.elementId}"]`);
    if (newEl) newEl.classList.add(`edge-highlight-${newHoveredEdge.edge}`);
  }
  hoveredEdge = newHoveredEdge;
});

// ── Kapı Yerleştirme ───────────────────────────────────────────────────────
function placeDoorOnEdge(parentElementId, edge, doorType = 'door') {
  const parent = mapData[parentElementId];
  if (!parent) return;
  const tempId = 'temp_' + (tempIdCounter++);
  const campusId = $('mapCampusFilter').value, blockId = $('mapBlockFilter').value, floor = $('mapFloorSelect').value;
  const doorThickness = 6, isDouble = doorType === 'doubleDoor', doorLength = isDouble ? 80 : 40;
  let doorX, doorY, doorW, doorH;
  if (edge === 'top')    { doorX = parent.x + parent.w / 2 - doorLength / 2; doorY = parent.y - doorThickness / 2;         doorW = doorLength;     doorH = doorThickness * 5; }
  else if (edge === 'right')  { doorX = parent.x + parent.w - doorThickness / 2; doorY = parent.y + parent.h / 2 - doorLength / 2; doorW = doorThickness * 5; doorH = doorLength; }
  else if (edge === 'bottom') { doorX = parent.x + parent.w / 2 - doorLength / 2; doorY = parent.y + parent.h - doorThickness / 2; doorW = doorLength;     doorH = doorThickness * 5; }
  else                        { doorX = parent.x - doorThickness * 5;             doorY = parent.y + parent.h / 2 - doorLength / 2; doorW = doorThickness * 5; doorH = doorLength; }

  mapData[tempId] = { id: tempId, type: doorType, x: doorX, y: doorY, w: doorW, h: doorH, shapes: [], rotation: 0, label: isDouble ? 'ÇİFT KAPI' : 'KAPI', campusId, blockId, floor, attachedTo: parentElementId, attachedEdge: edge, isNew: true };
  renderMapPanel();
  selectRoom(tempId);
}

// ── Sınıf & Element Yerleştirme ────────────────────────────────────────────
function placeClassroom(id) {
  if (mapData[id]) return;
  const c = getClassrooms().find(x => x.id === id);
  if (!c) return;
  const type = c.elementType || 'classroom';
  const defaults = ELEMENT_TYPES[type] || ELEMENT_TYPES.classroom;
  
  // Eğer classroom'da campusId, blockId veya floor yoksa, seçilen filtreden al
  const campusId = c.campusId || $('mapCampusFilter').value || '';
  const blockId = c.blockId || $('mapBlockFilter').value || '';
  const floor = c.floor || $('mapFloorSelect').value || '';
  
  mapData[id] = { 
    id, type, x: 40, y: 40, w: defaults.defaultW, h: defaults.defaultH, 
    shapes: [], rotation: 0, label: c.code || '',
    campusId, blockId, floor
  };
  renderMapPanel();
  selectRoom(id);
}

function placeElement(type, position) {
  const defaults = ELEMENT_TYPES[type] || ELEMENT_TYPES.classroom;
  const tempId = 'temp_' + (tempIdCounter++);
  const campusId = $('mapCampusFilter').value, blockId = $('mapBlockFilter').value, floor = $('mapFloorSelect').value;
  let x = position.x, y = position.y;
  if (snapToGrid) { x = Math.round(x / GRID_SIZE) * GRID_SIZE; y = Math.round(y / GRID_SIZE) * GRID_SIZE; }
  if (type === 'door') {
    const snapped = snapDoorToStructure(x, y, defaults.defaultW, defaults.defaultH);
    if (snapped) { x = snapped.x; y = snapped.y; }
  }
  mapData[tempId] = { id: tempId, type, x, y, w: defaults.defaultW, h: defaults.defaultH, shapes: [], rotation: 0, label: defaults.label, campusId, blockId, floor, isNew: true };
  renderMapPanel();
  selectRoom(tempId);
}

function snapDoorToStructure(x, y, w, h) {
  let bestSnap = null, minDist = SNAP_THRESHOLD * 2;
  Object.values(mapData).forEach(element => {
    if (!element.type || element.type === 'door') return;
    const { x: ex, y: ey, w: ew, h: eh } = element;
    const edges = [
      { x: ex + ew/2 - w/2, y: ey - h,        side: 'top'    },
      { x: ex + ew,          y: ey + eh/2 - h/2, side: 'right'  },
      { x: ex + ew/2 - w/2, y: ey + eh,        side: 'bottom' },
      { x: ex - w,           y: ey + eh/2 - h/2, side: 'left'   }
    ];
    edges.forEach(edge => {
      const dist = Math.sqrt(Math.pow(edge.x - x, 2) + Math.pow(edge.y - y, 2));
      if (dist < minDist) { minDist = dist; bestSnap = edge; }
    });
  });
  return bestSnap;
}

// ── Filtrelenmiş sınıflar ──────────────────────────────────────────────────
function getFilteredClassrooms() {
  const cid = $('mapCampusFilter').value, bid = $('mapBlockFilter').value, floor = $('mapFloorSelect').value;
  
  // Seçilen kampüs ve blok nesnelerini bul
  const selectedCampus = cid ? getCampuses().find(c => c.id === cid) : null;
  const selectedBlock = bid ? getBlocks().find(b => b.id === bid) : null;
  
  return getClassrooms().filter(c => {
    // Kampüs filtresi - ID veya name karşılaştır
    if (cid) {
      const matches = c.campusId === cid || 
                     (selectedCampus && (c.campus === selectedCampus.name || c.campusName === selectedCampus.name));
      if (!matches) return false;
    }
    
    // Blok filtresi - ID veya name karşılaştır
    if (bid) {
      const matches = c.blockId === bid || 
                     (selectedBlock && (c.building === selectedBlock.name || c.blockName === selectedBlock.name));
      if (!matches) return false;
    }
    
    // Kat filtresi
    const cf = getClassroomFloorValue(c);
    if (floor !== '' && cf !== floor) return false;
    
    return true;
  });
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderRoomEl(c) {
  const d = mapData[c.id];
  if (!d) return;
  if (!d.type)     d.type     = c.elementType || 'classroom';
  if (!d.shapes)   d.shapes   = [];
  if (d.rotation === undefined) d.rotation = 0;
  renderMapElement(c.id, d, c);
}

function renderMapElement(id, d, c) {
  const el = document.createElement('div');
  const type = d.type || 'classroom';
  el.className = 'map-room ' + type + (c && c.active === false ? ' inactive' : '');
  el.dataset.id = id;
  el.dataset.type = type;

  const rotationTransform = d.rotation ? `rotate(${d.rotation}deg)` : '';

  if (d.shapes && d.shapes.length > 0) {
    // Multi-shape rendering
    el.style.left = d.x + 'px'; el.style.top = d.y + 'px';
    el.style.width = 'auto'; el.style.height = 'auto';
    el.style.background = 'transparent'; el.style.border = 'none'; el.style.boxShadow = 'none';
    d.shapes.forEach((shape, idx) => {
      const shapeDiv = document.createElement('div');
      shapeDiv.className = 'map-room ' + type;
      shapeDiv.style.cssText = `position:absolute;left:${shape.offsetX||0}px;top:${shape.offsetY||0}px;width:${shape.w||40}px;height:${shape.h||30}px;`;
      if (rotationTransform) shapeDiv.style.transform = rotationTransform;
      const handle = document.createElement('div');
      handle.className = 'resize-handle'; handle.dataset.shapeIndex = idx;
      shapeDiv.appendChild(handle);
      el.appendChild(shapeDiv);
    });
    const labelDiv = document.createElement('div');
    labelDiv.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:100;';
    labelDiv.innerHTML = `<span class="room-code">${escapeHtml(d.label || ELEMENT_TYPES[type]?.icon || '')}</span>`;
    el.appendChild(labelDiv);
  } else {
    el.style.left = d.x + 'px'; el.style.top = d.y + 'px';
    el.style.width = d.w + 'px'; el.style.height = d.h + 'px';
    el.style.transformOrigin = 'center center';
    el.style.transform = d.rotation ? `rotate(${d.rotation}deg)` : '';

    if (type === 'door' || type === 'doubleDoor') {
      const isDouble = type === 'doubleDoor';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', d.w); svg.setAttribute('height', d.h);
      svg.setAttribute('viewBox', `0 0 ${d.w} ${d.h}`);
      svg.style.cssText = 'position:absolute;top:0;left:0;overflow:visible;pointer-events:none;';
      const attachedEdge = d.attachedEdge || (d.w > d.h ? 'bottom' : 'right');
      const W = d.w, H = d.h;

      const makePath = d_attr => {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d_attr); p.setAttribute('stroke', '#a67c52'); p.setAttribute('stroke-width', '1.5');
        p.setAttribute('fill', 'rgba(166,124,82,0.08)'); p.setAttribute('stroke-dasharray', '3,2'); p.setAttribute('opacity', '0.75');
        return p;
      };
      const makeLine = (x1,y1,x2,y2) => {
        const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
        l.setAttribute('stroke', '#8b6f47'); l.setAttribute('stroke-width', '4'); l.setAttribute('stroke-linecap', 'round');
        return l;
      };

      if (attachedEdge === 'bottom') {
        svg.appendChild(makeLine(0,0,W,0));
        if (isDouble) { const r=W/2; svg.appendChild(makePath(`M 0 0 L 0 ${r} A ${r} ${r} 0 0 0 ${W/2} 0`)); svg.appendChild(makePath(`M ${W} 0 L ${W} ${r} A ${r} ${r} 0 0 1 ${W/2} 0`)); }
        else { const r=W*0.9; svg.appendChild(makePath(`M 0 0 L 0 ${r} A ${r} ${r} 0 0 0 ${r} 0`)); }
      } else if (attachedEdge === 'top') {
        svg.appendChild(makeLine(0,H,W,H));
        if (isDouble) { const r=W/2; svg.appendChild(makePath(`M 0 ${H} L 0 ${H-r} A ${r} ${r} 0 0 1 ${W/2} ${H}`)); svg.appendChild(makePath(`M ${W} ${H} L ${W} ${H-r} A ${r} ${r} 0 0 0 ${W/2} ${H}`)); }
        else { const r=W*0.9; svg.appendChild(makePath(`M 0 ${H} L 0 ${H-r} A ${r} ${r} 0 0 1 ${r} ${H}`)); }
      } else if (attachedEdge === 'right') {
        svg.appendChild(makeLine(0,0,0,H));
        if (isDouble) { const r=H/2; svg.appendChild(makePath(`M 0 0 L ${r} 0 A ${r} ${r} 0 0 0 0 ${H/2}`)); svg.appendChild(makePath(`M 0 ${H} L ${r} ${H} A ${r} ${r} 0 0 1 0 ${H/2}`)); }
        else { const r=H*0.9; svg.appendChild(makePath(`M 0 0 L ${r} 0 A ${r} ${r} 0 0 0 0 ${r}`)); }
      } else {
        svg.appendChild(makeLine(W,0,W,H));
        if (isDouble) { const r=H/2; svg.appendChild(makePath(`M ${W} 0 L ${W-r} 0 A ${r} ${r} 0 0 1 ${W} ${H/2}`)); svg.appendChild(makePath(`M ${W} ${H} L ${W-r} ${H} A ${r} ${r} 0 0 0 ${W} ${H/2}`)); }
        else { const r=H*0.9; svg.appendChild(makePath(`M ${W} 0 L ${W-r} 0 A ${r} ${r} 0 0 1 ${W} ${r}`)); }
      }
      el.appendChild(svg);
    } else {
      let content = '';
      if (type === 'classroom' && c) {
        content = `<span class="room-code">${escapeHtml(c.code || c.id)}</span>${c.capacity ? `<span class="room-cap">${c.capacity} kişi</span>` : ''}`;
      } else {
        const typeInfo = ELEMENT_TYPES[type] || {};
        content = `<span class="room-code">${typeInfo.icon || ''}${escapeHtml(d.label || typeInfo.label || '')}</span>`;
      }
      el.innerHTML = content + '<div class="resize-handle"></div>';

      // Merdiven yön oku
      if (type === 'stairs' && d.stairDirection) {
        const arrowSpan = document.createElement('span');
        arrowSpan.className = 'stair-dir-arrow';
        arrowSpan.textContent = d.stairDirection === 'up' ? '▲' : d.stairDirection === 'down' ? '▼' : '⬍';
        el.appendChild(arrowSpan);
      }
    }
  }

  makeDraggable(el, id);
  if (type !== 'door' && type !== 'doubleDoor') {
    if (!d.shapes || d.shapes.length === 0) makeResizable(el, id);
    else makeShapeResizable(el, id);
  }
  el.addEventListener('click', e => { if (!e._wasDragged) selectRoom(id); });

  const qDel = document.createElement('button');
  qDel.className = 'quick-delete'; qDel.textContent = '×'; qDel.title = 'Sil';
  qDel.addEventListener('click', e => { e.stopPropagation(); deleteMapElement(id); });
  el.appendChild(qDel);

  mapCanvas.appendChild(el);
}

// ── Seçim & Info Card ──────────────────────────────────────────────────────
function selectRoom(id) {
  mapSelectedId = id;
  mapCanvas.querySelectorAll('.map-room').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
  const c = getClassrooms().find(x => x.id === id);
  const d = mapData[id];
  if (!d) { mapInfoCard.style.display = 'none'; return; }
  mapInfoCard.style.display = 'block';

  let infoHTML = '';
  if (c) {
    infoHTML = `
      <div class="info-row"><span>Kod:</span><strong>${escapeHtml(c.code||c.id)}</strong></div>
      <div class="info-row"><span>Tür:</span><strong>${escapeHtml(ELEMENT_TYPES[d.type]?.label || d.type)}</strong></div>
      <div class="info-row"><span>Kapasite:</span><strong>${c.capacity||'—'}</strong></div>
      <div class="info-row"><span>Kat:</span><strong>${escapeHtml(getClassroomFloorValue(c)||'—')}</strong></div>
    `;
  } else {
    const typeInfo = ELEMENT_TYPES[d.type] || {};
    infoHTML = `
      <div class="info-row"><span>Tür:</span><strong>${escapeHtml(typeInfo.label || d.type)}</strong></div>
      <div class="info-row"><span>Etiket:</span><strong>${escapeHtml(d.label || '—')}</strong></div>
    `;
    if (d.type === 'stairs' && d.stairDirection) {
      const dirLabels = { up: '▲ Yukarı', down: '▼ Aşağı', both: '⬍ İkisi' };
      infoHTML += `<div class="info-row"><span>Yön:</span><strong>${dirLabels[d.stairDirection] || '—'}</strong></div>`;
    }
    if ((d.type === 'door' || d.type === 'doubleDoor') && d.attachedTo) {
      const attachedElement = mapData[d.attachedTo];
      const attachedClassroom = getClassrooms().find(c => c.id === d.attachedTo);
      const attachedName = attachedClassroom ? attachedClassroom.code : (attachedElement?.label || d.attachedTo);
      const edgeNames = { top: 'Üst', right: 'Sağ', bottom: 'Alt', left: 'Sol' };
      infoHTML += `
        <div class="info-row"><span>Bağlı:</span><strong>${escapeHtml(attachedName)}</strong></div>
        <div class="info-row"><span>Kenar:</span><strong>${edgeNames[d.attachedEdge] || d.attachedEdge}</strong></div>
      `;
    }
  }
  infoHTML += `<div class="info-row"><span>Konum:</span><strong>${Math.round(d.x)}, ${Math.round(d.y)}</strong></div>`;
  $('mapSelectedInfo').innerHTML = infoHTML;
  $('mapRoomW').value = Math.round(d.w);
  $('mapRoomH').value = Math.round(d.h);

  const showDimensions = d.type !== 'door' && d.type !== 'doubleDoor';
  $('mapRoomW').parentElement.parentElement.style.display = showDimensions ? 'grid' : 'none';
  $('mapApplyDim').style.display = showDimensions ? 'block' : 'none';

  const showRotation = ['door', 'doubleDoor', 'corridor'].includes(d.type);
  $('mapRotationSection').style.display = showRotation ? 'block' : 'none';

  const showShapeEditor = d.type !== 'door' && d.type !== 'doubleDoor';
  $('mapShapeSection').style.display = showShapeEditor ? 'block' : 'none';

  const showStairDir = d.type === 'stairs';
  $('mapStairSection').style.display = showStairDir ? 'block' : 'none';
  if (showStairDir) {
    document.querySelectorAll('.stair-dir-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.dir === (d.stairDirection || ''));
    });
  }

  if (showShapeEditor) renderShapeEditor(id);
}

function renderShapeEditor(id) {
  const d = mapData[id];
  if (!d) return;
  const shapeList = $('mapShapeList');
  const shapes = d.shapes || [];
  if (shapes.length === 0) {
    shapeList.innerHTML = '<div style="color:var(--muted);font-size:11px;text-align:center;padding:8px">Tek dikdörtgen - Çoklu eklemek için + tıklayın</div>';
    return;
  }
  shapeList.innerHTML = shapes.map((shape, idx) => `
    <div class="shape-item">
      <input type="number" placeholder="X" value="${shape.offsetX||0}" data-idx="${idx}" data-prop="offsetX" />
      <input type="number" placeholder="Y" value="${shape.offsetY||0}" data-idx="${idx}" data-prop="offsetY" />
      <input type="number" placeholder="W" value="${shape.w||40}"      data-idx="${idx}" data-prop="w" />
      <input type="number" placeholder="H" value="${shape.h||30}"      data-idx="${idx}" data-prop="h" />
      <button data-idx="${idx}">×</button>
    </div>
  `).join('');
  shapeList.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      const idx = parseInt(input.dataset.idx), prop = input.dataset.prop, value = parseFloat(input.value) || 0;
      if (d.shapes[idx]) { d.shapes[idx][prop] = value; renderMapPanel(); selectRoom(id); }
    });
  });
  shapeList.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      d.shapes.splice(parseInt(btn.dataset.idx), 1);
      renderMapPanel(); selectRoom(id);
    });
  });
}

// ── Info Card Kontrolleri ──────────────────────────────────────────────────
$('mapAddShape').addEventListener('click', () => {
  if (!mapSelectedId || !mapData[mapSelectedId]) return;
  const d = mapData[mapSelectedId];
  if (!d.shapes) d.shapes = [];
  d.shapes.push({ offsetX: 0, offsetY: 0, w: 60, h: 40 });
  renderMapPanel(); selectRoom(mapSelectedId);
});

document.querySelectorAll('.stair-dir-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!mapSelectedId || !mapData[mapSelectedId]) return;
    const d = mapData[mapSelectedId];
    if (d.type !== 'stairs') return;
    d.stairDirection = btn.dataset.dir;
    renderMapPanel(); selectRoom(mapSelectedId);
  });
});

$('mapRotateLeft').addEventListener('click', () => {
  if (!mapSelectedId || !mapData[mapSelectedId]) return;
  mapData[mapSelectedId].rotation = ((mapData[mapSelectedId].rotation || 0) + 90) % 360;
  renderMapPanel(); selectRoom(mapSelectedId);
});
$('mapRotateRight').addEventListener('click', () => {
  if (!mapSelectedId || !mapData[mapSelectedId]) return;
  mapData[mapSelectedId].rotation = ((mapData[mapSelectedId].rotation || 0) - 90 + 360) % 360;
  renderMapPanel(); selectRoom(mapSelectedId);
});
$('mapApplyDim').addEventListener('click', () => {
  if (!mapSelectedId || !mapData[mapSelectedId]) return;
  mapData[mapSelectedId].w = Math.max(40, parseInt($('mapRoomW').value) || 80);
  mapData[mapSelectedId].h = Math.max(30, parseInt($('mapRoomH').value) || 56);
  const el = mapCanvas.querySelector(`[data-id="${mapSelectedId}"]`);
  if (el) { el.style.width = mapData[mapSelectedId].w + 'px'; el.style.height = mapData[mapSelectedId].h + 'px'; }
  selectRoom(mapSelectedId);
});

// ── Element Silme ──────────────────────────────────────────────────────────
function deleteMapElement(id) {
  if (!id || !mapData[id]) return;
  const removingData = mapData[id];
  if (removingData.type !== 'door' && removingData.type !== 'doubleDoor') {
    Object.keys(mapData).forEach(did => { if (mapData[did].attachedTo === id) delete mapData[did]; });
  }
  delete mapData[id];
  if (mapSelectedId === id) { mapSelectedId = null; mapInfoCard.style.display = 'none'; }
  renderMapPanel();
}

$('mapRemoveBtn').addEventListener('click', () => { if (mapSelectedId) deleteMapElement(mapSelectedId); });

document.addEventListener('keydown', e => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && mapSelectedId) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    deleteMapElement(mapSelectedId);
  }
});

// ── Drag ───────────────────────────────────────────────────────────────────
function makeDraggable(el, id) {
  let startX, startY, startL, startT, dragged;
  el.addEventListener('mousedown', e => {
    if (e.target.classList.contains('resize-handle')) return;
    e.stopPropagation();
    dragged = false;
    startX = e.clientX; startY = e.clientY;
    startL = mapData[id].x; startT = mapData[id].y;
    let prevX = startL, prevY = startT;

    const onMove = ev => {
      const dx = (ev.clientX - startX) / mapScale, dy = (ev.clientY - startY) / mapScale;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
      let newX = Math.max(0, startL + dx), newY = Math.max(0, startT + dy);
      if (snapToGrid && !ev.shiftKey) {
        newX = Math.round(newX / GRID_SIZE) * GRID_SIZE;
        newY = Math.round(newY / GRID_SIZE) * GRID_SIZE;
      }
      const isDoor = mapData[id].type === 'door' || mapData[id].type === 'doubleDoor';
      if (!isDoor) { const snapped = snapToNearbyElements(id, newX, newY, mapData[id].w, mapData[id].h, ev.shiftKey); newX = snapped.x; newY = snapped.y; }
      const actualDx = newX - prevX, actualDy = newY - prevY;
      mapData[id].x = newX; mapData[id].y = newY;
      el.style.left = newX + 'px'; el.style.top = newY + 'px';
      prevX = newX; prevY = newY;
      updateAttachedDoors(id, actualDx, actualDy);
      if (isDoor && mapData[id].attachedTo) constrainDoorToParent(id);
      if (mapSelectedId === id) {
        const infoRow = $('mapSelectedInfo').querySelector('.info-row:last-child strong');
        if (infoRow) infoRow.textContent = `${Math.round(mapData[id].x)}, ${Math.round(mapData[id].y)}`;
      }
    };
    const onUp = ev => {
      ev.target._wasDragged = dragged;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setTimeout(() => { el._wasDragged = false; }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function snapToNearbyElements(currentId, x, y, w, h, shiftPressed) {
  if (shiftPressed) return { x, y };
  let snappedX = x, snappedY = y, minXDist = SNAP_THRESHOLD, minYDist = SNAP_THRESHOLD;
  Object.entries(mapData).forEach(([otherId, other]) => {
    if (otherId === currentId || other.type === 'door' || other.type === 'doubleDoor') return;
    const { x: ox, y: oy, w: ow, h: oh } = other;
    const checks = [
      [Math.abs(x - ox), ox, true],
      [Math.abs((x + w) - (ox + ow)), ox + ow - w, true],
      [Math.abs(x - (ox + ow)), ox + ow, true],
      [Math.abs((x + w) - ox), ox - w, true],
    ];
    checks.forEach(([dist, snap]) => { if (dist < minXDist) { snappedX = snap; minXDist = dist; } });
    const vchecks = [
      [Math.abs(y - oy), oy],
      [Math.abs((y + h) - (oy + oh)), oy + oh - h],
      [Math.abs(y - (oy + oh)), oy + oh],
      [Math.abs((y + h) - oy), oy - h],
    ];
    vchecks.forEach(([dist, snap]) => { if (dist < minYDist) { snappedY = snap; minYDist = dist; } });
  });
  return { x: snappedX, y: snappedY };
}

function updateAttachedDoors(parentId, dx, dy) {
  Object.values(mapData).forEach(door => {
    if (door.attachedTo === parentId && ['door', 'doubleDoor'].includes(door.type)) {
      door.x += dx; door.y += dy;
      const doorEl = mapCanvas.querySelector(`[data-id="${door.id}"]`);
      if (doorEl) { doorEl.style.left = door.x + 'px'; doorEl.style.top = door.y + 'px'; }
    }
  });
}

function constrainDoorToParent(doorId) {
  const door = mapData[doorId];
  if (!door || !door.attachedTo) return;
  const parent = mapData[door.attachedTo];
  if (!parent) return;
  const edge = door.attachedEdge, dt = 6;
  if (edge === 'top')    { door.y = parent.y - dt / 2;                door.x = Math.max(parent.x, Math.min(parent.x + parent.w - door.w, door.x)); }
  if (edge === 'bottom') { door.y = parent.y + parent.h - dt / 2;     door.x = Math.max(parent.x, Math.min(parent.x + parent.w - door.w, door.x)); }
  if (edge === 'left')   { door.x = parent.x - dt * 5;                door.y = Math.max(parent.y, Math.min(parent.y + parent.h - door.h, door.y)); }
  if (edge === 'right')  { door.x = parent.x + parent.w - dt / 2;    door.y = Math.max(parent.y, Math.min(parent.y + parent.h - door.h, door.y)); }
  const doorEl = mapCanvas.querySelector(`[data-id="${doorId}"]`);
  if (doorEl) { doorEl.style.left = door.x + 'px'; doorEl.style.top = door.y + 'px'; }
}

// ── Resize ─────────────────────────────────────────────────────────────────
function makeResizable(el, id) {
  const handle = el.querySelector('.resize-handle');
  if (!handle) return;
  handle.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    const startX = e.clientX, startY = e.clientY, startW = mapData[id].w, startH = mapData[id].h;
    const onMove = ev => {
      mapData[id].w = Math.max(40, startW + (ev.clientX - startX) / mapScale);
      mapData[id].h = Math.max(30, startH + (ev.clientY - startY) / mapScale);
      el.style.width = mapData[id].w + 'px'; el.style.height = mapData[id].h + 'px';
      if (mapSelectedId === id) { $('mapRoomW').value = Math.round(mapData[id].w); $('mapRoomH').value = Math.round(mapData[id].h); }
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  });
}

function makeShapeResizable(el, id) {
  el.querySelectorAll('.resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', e => {
      e.stopPropagation(); e.preventDefault();
      const shapeIndex = parseInt(handle.dataset.shapeIndex);
      if (shapeIndex === undefined || !mapData[id].shapes[shapeIndex]) return;
      const startX = e.clientX, startY = e.clientY;
      const shape = mapData[id].shapes[shapeIndex];
      const startW = shape.w || 40, startH = shape.h || 30;
      const onMove = ev => {
        shape.w = Math.max(20, startW + (ev.clientX - startX) / mapScale);
        shape.h = Math.max(15, startH + (ev.clientY - startY) / mapScale);
        renderMapPanel(); if (mapSelectedId === id) selectRoom(id);
      };
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    });
  });
}

// ── Firestore Kayıt ────────────────────────────────────────────────────────
$('mapSaveAllBtn').addEventListener('click', async () => {
  const btn = $('mapSaveAllBtn'), old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Kaydediliyor...';
  try {
    const batch = writeBatch(db);
    let saveCount = 0, newCount = 0, removeCount = 0;

    // Önce temp_ ID'li yeni elementleri kaydet
    const tempElements = Object.entries(mapData).filter(([id]) => id.startsWith('temp_'));
    for (const [tempId, pos] of tempElements) {
      const newDocData = {
        code: pos.label || pos.type, elementType: pos.type || 'classroom',
        campusId: pos.campusId || '', blockId: pos.blockId || '', floor: pos.floor || '',
        active: true, mapX: pos.x, mapY: pos.y, mapW: pos.w, mapH: pos.h,
        shapes: pos.shapes || [], rotation: pos.rotation || 0, label: pos.label || '',
        attachedTo: pos.attachedTo || '', attachedEdge: pos.attachedEdge || '',
        stairDirection: pos.stairDirection || '',
        capacity: 0, images: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      };
      const newDocRef = await addDoc(collection(db, 'classrooms'), newDocData);
      delete mapData[tempId];
      mapData[newDocRef.id] = { ...pos, id: newDocRef.id, isNew: false };
      Object.values(mapData).forEach(door => { if (door.attachedTo === tempId) door.attachedTo = newDocRef.id; });
      newCount++;
    }

    // Haritadan silinen derslikleri bul (Firestore'da mapX var ama mapData'da yok)
    const currentCampusId = $('mapCampusFilter').value;
    const currentBlockId = $('mapBlockFilter').value;
    const currentFloor = $('mapFloorSelect').value;
    
    getClassrooms().forEach(c => {
      // Eğer bu dersliğin harita bilgisi var ama mapData'da yoksa
      if (c.mapX !== undefined && !mapData[c.id]) {
        // Sadece şu an seçili olan kampüs/blok/kat'taki silmeleri kaydet
        const selectedCampus = currentCampusId ? getCampuses().find(cp => cp.id === currentCampusId) : null;
        const selectedBlock = currentBlockId ? getBlocks().find(b => b.id === currentBlockId) : null;
        
        const isInCurrentFilter = 
          (c.campusId === currentCampusId || (selectedCampus && (c.campus === selectedCampus.name || c.campusName === selectedCampus.name))) &&
          (c.blockId === currentBlockId || (selectedBlock && (c.building === selectedBlock.name || c.blockName === selectedBlock.name))) &&
          (getClassroomFloorValue(c) === currentFloor);
        
        if (isInCurrentFilter) {
          // Harita bilgilerini temizle
          batch.update(doc(db, 'classrooms', c.id), {
            mapX: null,
            mapY: null,
            mapW: null,
            mapH: null,
            shapes: [],
            rotation: 0,
            attachedTo: '',
            attachedEdge: '',
            stairDirection: '',
            mapUpdatedAt: serverTimestamp()
          });
          removeCount++;
        }
      }
    });

    // Mevcut elementleri güncelle
    Object.entries(mapData).forEach(([id, pos]) => {
      if (id.startsWith('temp_')) return;
      
      // Eğer pos'ta campusId/blockId/floor yoksa, classroom nesnesinden al
      const classroom = getClassrooms().find(c => c.id === id);
      const updateData = {
        mapX: pos.x, mapY: pos.y, mapW: pos.w, mapH: pos.h,
        elementType: pos.type || 'classroom', rotation: pos.rotation || 0,
        shapes: pos.shapes || [], label: pos.label || '',
        attachedTo: pos.attachedTo || '', attachedEdge: pos.attachedEdge || '',
        stairDirection: pos.stairDirection || '',
        campusId: pos.campusId || '',
        blockId: pos.blockId || '',
        floor: pos.floor || '',
        mapUpdatedAt: serverTimestamp()
      };
      
      // Eğer classroom nesnesinde de bu bilgiler boşsa, mapData'dan güncelle
      if (classroom && !classroom.campusId && pos.campusId) updateData.campusId = pos.campusId;
      if (classroom && !classroom.blockId && pos.blockId) updateData.blockId = pos.blockId;
      if (classroom && !classroom.floor && pos.floor) updateData.floor = pos.floor;
      
      batch.update(doc(db, 'classrooms', id), updateData);
      saveCount++;
    });

    try { await batch.commit(); } catch (batchErr) { if (saveCount > 0) throw batchErr; }

    await loadAll();
    renderMapPanel();
    const msg = removeCount > 0 
      ? `✓ Kaydedildi (${saveCount} güncellendi, ${newCount} yeni, ${removeCount} kaldırıldı)`
      : `✓ Kaydedildi (${saveCount} güncellendi, ${newCount} yeni)`;
    btn.textContent = msg;
    btn.style.background = 'var(--success)';
    setTimeout(() => { btn.textContent = old; btn.style.background = ''; btn.disabled = false; }, 2500);
  } catch (e) {
    console.error(e); alert('Kayıt hatası: ' + e.message);
    btn.disabled = false; btn.textContent = old;
  }
});

// ── Tab Switch Hook ────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'map') { fillMapCampusFilter(); renderMapPanel(); }
  });
});
