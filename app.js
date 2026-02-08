/* ========= Helpers ========= */
const $ = (id) => document.getElementById(id);
const tblBody = $("tblBody");
const canvas = $("plot");
const ctx = canvas.getContext("2d");

function uid(){ return Math.random().toString(16).slice(2); }
function avg(a){ return a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN; }
function fmt(x,dp=3){ return Number.isFinite(x) ? x.toFixed(dp) : "—"; }

/* Haversine distance (m) */
function haversine_m(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const toRad = d => d * Math.PI/180;
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dphi = toRad(lat2-lat1);
  const dl = toRad(lon2-lon1);
  const a = Math.sin(dphi/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

/* Linear regression y = a + b x */
function linReg(x,y){
  const n=x.length, xb=avg(x), yb=avg(y);
  let sxx=0,sxy=0,syy=0;
  for (let i=0;i<n;i++){
    const dx=x[i]-xb, dy=y[i]-yb;
    sxx+=dx*dx; sxy+=dx*dy; syy+=dy*dy;
  }
  const b = sxx===0 ? NaN : sxy/sxx;
  const a = yb - b*xb;

  let sse=0;
  for (let i=0;i<n;i++){
    const yhat=a+b*x[i];
    sse += (y[i]-yhat)*(y[i]-yhat);
  }
  const r2 = syy===0 ? 1 : (1 - sse/syy);
  return {a,b,r2};
}

/* ========= State ========= */
let refRowId = null;
let selectedRowId = null;

let map = null, marker = null;
let layerOSM = null, layerEsri = null;

/* ========= Table rows ========= */
function renumberRows(){
  const rows = [...tblBody.querySelectorAll("tr")];
  rows.forEach((tr,i)=>{
    tr.querySelector(".idx").textContent = String(i+1);
    const refTag = tr.querySelector(".refTag");
    refTag.textContent = (tr.dataset.rowid === refRowId) ? "REF" : "";
  });

  $("selRowLabel").textContent = selectedRowId ? `row ${rowIndexById(selectedRowId)}` : "none";
  $("refLabel").textContent = refRowId ? `row ${rowIndexById(refRowId)}` : "none";
}

function rowIndexById(id){
  const rows = [...tblBody.querySelectorAll("tr")];
  const idx = rows.findIndex(r=>r.dataset.rowid===id);
  return idx>=0 ? idx+1 : "?";
}

function addRow(pref={}){
  const id = uid();
  const tr = document.createElement("tr");
  tr.dataset.rowid = id;

  tr.innerHTML = `
    <td class="idx"></td>

    <td>
      <input class="sel" type="radio" name="selrow">
    </td>

    <td>
      <select class="mode">
        <option value="manual">Manual</option>
        <option value="gps">GPS</option>
      </select>
    </td>

    <td>
      <input class="dist" type="number" step="0.1" value="${pref.d ?? ""}">
    </td>

    <td>
      <input class="mv" type="number" step="0.1" value="${pref.mv ?? ""}">
    </td>

    <td>
      <input class="lat" type="number" step="0.000001" value="${pref.lat ?? ""}">
    </td>

    <td>
      <input class="lon" type="number" step="0.000001" value="${pref.lon ?? ""}">
    </td>

    <td>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="tinybtn btnGps" type="button">Use GPS</button>
        <button class="tinybtn btnMap" type="button">Map</button>
        <span class="tag refTag"></span>
      </div>
    </td>

    <td>
      <input class="ex" type="checkbox">
    </td>
  `;

  tblBody.appendChild(tr);
  wireRow(tr);

  // preset mode
  if (pref.mode) tr.querySelector(".mode").value = pref.mode;

  renumberRows();
}

function wireRow(tr){
  tr.querySelector(".sel").addEventListener("change", ()=>{
    selectedRowId = tr.dataset.rowid;
    renumberRows();
  });

  tr.querySelector(".btnGps").addEventListener("click", async ()=>{
    selectedRowId = tr.dataset.rowid;
    renumberRows();
    try{
      const pos = await new Promise((resolve, reject)=>{
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy:true, timeout:15000 });
      });
      tr.querySelector(".lat").value = pos.coords.latitude.toFixed(6);
      tr.querySelector(".lon").value = pos.coords.longitude.toFixed(6);
      recalc();
    }catch(e){
      alert("GPS failed. Check: Settings → Privacy → Location Services ON; Safari allowed for location.");
    }
  });

  tr.querySelector(".btnMap").addEventListener("click", ()=>{
    selectedRowId = tr.dataset.rowid;
    renumberRows();
    openMapForSelected();
  });

  // Auto update on edits
  ["input","change"].forEach(evt=>{
    tr.querySelector(".mode").addEventListener(evt, recalc);
    tr.querySelector(".dist").addEventListener(evt, recalc);
    tr.querySelector(".mv").addEventListener(evt, recalc);
    tr.querySelector(".lat").addEventListener(evt, recalc);
    tr.querySelector(".lon").addEventListener(evt, recalc);
    tr.querySelector(".ex").addEventListener(evt, recalc);
  });
}

/* Extract points from table + apply GPS distance if mode=gps and REF set */
function getPointsFromTable(){
  const rows = [...tblBody.querySelectorAll("tr")].map(tr=>{
    const id = tr.dataset.rowid;
    const mode = tr.querySelector(".mode").value;
    const dist = Number(tr.querySelector(".dist").value);
    const mv = Number(tr.querySelector(".mv").value);
    const lat = Number(tr.querySelector(".lat").value);
    const lon = Number(tr.querySelector(".lon").value);
    const ex = tr.querySelector(".ex").checked;
    return { id, mode, dist, mv, lat, lon, ex };
  });

  // Apply GPS distance from REF (straight line)
  const ref = rows.find(r => r.id === refRowId);
  if (ref && Number.isFinite(ref.lat) && Number.isFinite(ref.lon)){
    for (const r of rows){
      if (r.mode === "gps" && Number.isFinite(r.lat) && Number.isFinite(r.lon)){
        r.dist = haversine_m(ref.lat, ref.lon, r.lat, r.lon);
      }
    }
  }

  // Write back computed distances to the table for GPS rows (so user sees it)
  for (const r of rows){
    if (r.mode === "gps" && Number.isFinite(r.dist)){
      const tr = [...tblBody.querySelectorAll("tr")].find(t=>t.dataset.rowid===r.id);
      if (tr){
        // only overwrite if we have a REF and valid coords
        if (ref && Number.isFinite(ref.lat) && Number.isFinite(ref.lon) && Number.isFinite(r.lat) && Number.isFinite(r.lon)){
          tr.querySelector(".dist").value = r.dist.toFixed(1);
        }
      }
    }
  }

  // Points list for calculations/plot
  const pts = rows
    .filter(r => Number.isFinite(r.dist) && Number.isFinite(r.mv))
    .map(r => ({ d: r.dist, mv: r.mv, excluded: r.ex }));

  pts.sort((a,b)=>a.d-b.d);
  return pts;
}

/* ========= Map modal (Leaflet) ========= */
function openMapForSelected(){
  if(!selectedRowId){
    alert("Select a row first.");
    return;
  }
  $("mapModal").style.display = "block";
  $("mapRowTag").textContent = `row ${rowIndexById(selectedRowId)}`;

  if(!map){
    map = L.map("map").setView([-34.9285, 138.6007], 17); // default centre

    layerOSM = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 });
    layerEsri = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19 }
    );
    layerEsri.addTo(map);

    map.on("click", (e)=>{
      if(!selectedRowId) return;
      const tr = [...tblBody.querySelectorAll("tr")].find(x=>x.dataset.rowid===selectedRowId);
      if(!tr) return;

      const { lat, lng } = e.latlng;
      tr.querySelector(".lat").value = lat.toFixed(6);
      tr.querySelector(".lon").value = lng.toFixed(6);

      if(!marker) marker = L.marker([lat,lng]).addTo(map);
      else marker.setLatLng([lat,lng]);

      recalc();
    });
  }

  // centre to selected row coords if present
  const tr = [...tblBody.querySelectorAll("tr")].find(x=>x.dataset.rowid===selectedRowId);
  if(tr){
    const lat = Number(tr.querySelector(".lat").value);
    const lon = Number(tr.querySelector(".lon").value);
    if(Number.isFinite(lat) && Number.isFinite(lon)){
      map.setView([lat,lon], 18);
      if(!marker) marker = L.marker([lat,lon]).addTo(map);
      else marker.setLatLng([lat,lon]);
    }
  }

  setTimeout(()=>map.invalidateSize(), 200);
}

$("btnCloseMap").addEventListener("click", ()=>{ $("mapModal").style.display="none"; });

$("mapLayer").addEventListener("change", (e)=>{
  if(!map) return;
  const v = e.target.value;
  map.eachLayer(l=>map.removeLayer(l));
  (v==="osm" ? layerOSM : layerEsri).addTo(map);
  if(marker) marker.addTo(map);
});

/* ========= Engineering checks ========= */
/* Knee via best 2-line split on R(d) */
function piecewiseKnee(dist, R){
  const n = dist.length;
  if (n < 6) return { idx:null, detail:"Need ≥6 included points for knee detection." };
  let best = {sse:Infinity, idx:null, r2a:null, r2b:null};
  for (let k=2; k<=n-3; k++){
    const x1=dist.slice(0,k), y1=R.slice(0,k);
    const x2=dist.slice(k),   y2=R.slice(k);
    const f1=linReg(x1,y1), f2=linReg(x2,y2);
    if(!isFinite(f1.a)||!isFinite(f2.a)) continue;

    let sse=0;
    for(let i=0;i<x1.length;i++){ const yhat=f1.a+f1.b*x1[i]; sse+=(y1[i]-yhat)**2; }
    for(let i=0;i<x2.length;i++){ const yhat=f2.a+f2.b*x2[i]; sse+=(y2[i]-yhat)**2; }
    if(sse<best.sse) best={sse, idx:k, r2a:f1.r2, r2b:f2.r2};
  }
  if(best.idx===null) return { idx:null, detail:"Knee detection failed (too noisy)." };
  return { idx:best.idx, detail:`Split fit (R vs d): R²(pre)=${best.r2a.toFixed(2)}, R²(post)=${best.r2b.toFixed(2)}` };
}

function plateauCheck(dist, R, nLast){
  const n = Math.min(nLast, R.length);
  if(n<3) return {status:"Insufficient", cls:"warn", detail:"Need ≥3 points."};
  const Rs=R.slice(-n), ds=dist.slice(-n);
  const rMean=avg(Rs), rMin=Math.min(...Rs), rMax=Math.max(...Rs);
  const rangePct = rMean ? ((rMax-rMin)/rMean)*100 : Infinity;
  const f=linReg(ds,Rs);
  const slopePctPer100m = rMean ? (f.b/rMean)*100*100 : Infinity;

  if(rangePct<=8 && Math.abs(slopePctPer100m)<=5) return {status:"Likely plateau", cls:"good", detail:`Last ${n}: range ${rangePct.toFixed(1)}%, slope ${slopePctPer100m.toFixed(1)}%/100m.`};
  if(rangePct<=15 && Math.abs(slopePctPer100m)<=10) return {status:"Borderline", cls:"warn", detail:`Last ${n}: range ${rangePct.toFixed(1)}%, slope ${slopePctPer100m.toFixed(1)}%/100m.`};
  return {status:"Unstable / not far enough", cls:"bad", detail:`Last ${n}: range ${rangePct.toFixed(1)}%, slope ${slopePctPer100m.toFixed(1)}%/100m.`};
}

/* ========= Smooth curve (Monotone cubic / PCHIP-style) ========= */
/* Returns sampled points of monotone cubic through (x,y), x strictly increasing */
function monotoneCubicSample(x, y, samplesPerSeg=25){
  const n = x.length;
  if(n < 2) return [];
  if(n === 2){
    // straight line sample
    const out = [];
    const m = samplesPerSeg;
    for(let j=0;j<=m;j++){
      const t=j/m;
      out.push({x: x[0] + t*(x[1]-x[0]), y: y[0] + t*(y[1]-y[0])});
    }
    return out;
  }

  const h = new Array(n-1);
  const d = new Array(n-1);
  for(let i=0;i<n-1;i++){
    h[i] = x[i+1]-x[i];
    d[i] = (y[i+1]-y[i]) / h[i];
  }

  // initial tangents
  const m = new Array(n);
  m[0] = d[0];
  m[n-1] = d[n-2];
  for(let i=1;i<n-1;i++){
    if(d[i-1]*d[i] <= 0){
      m[i] = 0;
    } else {
      const w1 = 2*h[i] + h[i-1];
      const w2 = h[i] + 2*h[i-1];
      m[i] = (w1 + w2) / (w1/d[i-1] + w2/d[i]);
    }
  }

  // Fritsch-Carlson monotonicity adjustment
  for(let i=0;i<n-1;i++){
    if(d[i] === 0){
      m[i] = 0;
      m[i+1] = 0;
      continue;
    }
    const a = m[i]/d[i];
    const b = m[i+1]/d[i];
    const s = a*a + b*b;
    if(s > 9){
      const t = 3 / Math.sqrt(s);
      m[i] = t*a*d[i];
      m[i+1] = t*b*d[i];
    }
  }

  //
