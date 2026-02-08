/* ========= Helpers ========= */
const $ = (id) => document.getElementById(id);
const tblBody = $("tblBody");
const canvas = $("plot");
const ctx = canvas.getContext("2d");

function uid(){ return Math.random().toString(16).slice(2); }
function avg(a){ return a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN; }
function fmt(x,dp=3){ return Number.isFinite(x) ? x.toFixed(dp) : "—"; }

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

// per-row GPS watch handles
const gpsWatch = new Map(); // rowId -> {watchId, timer}

/* ========= Row utilities ========= */
function rowIndexById(id){
  const rows = [...tblBody.querySelectorAll("tr")];
  const idx = rows.findIndex(r=>r.dataset.rowid===id);
  return idx>=0 ? idx+1 : "?";
}

function renumberRows(){
  const rows = [...tblBody.querySelectorAll("tr")];
  rows.forEach((tr,i)=>{
    tr.querySelector(".idx").textContent = String(i+1);
    tr.querySelector(".refTag").textContent = (tr.dataset.rowid===refRowId) ? "REF" : "";
  });
  $("selRowLabel").textContent = selectedRowId ? `row ${rowIndexById(selectedRowId)}` : "none";
  $("refLabel").textContent = refRowId ? `row ${rowIndexById(refRowId)}` : "none";
}

/* ========= Add row ========= */
function addRow(pref={}){
  const id = uid();
  const tr = document.createElement("tr");
  tr.dataset.rowid = id;

  tr.innerHTML = `
    <td class="idx"></td>

    <td><input class="sel" type="radio" name="selrow"></td>

    <td>
      <select class="mode">
        <option value="manual">Manual</option>
        <option value="gps">GPS</option>
      </select>
    </td>

    <td><input class="dist" type="number" step="0.1" value="${pref.d ?? ""}"></td>
    <td><input class="mv" type="number" step="0.1" value="${pref.mv ?? ""}"></td>

    <td><input class="lat" type="number" step="0.000001" value="${pref.lat ?? ""}"></td>
    <td><input class="lon" type="number" step="0.000001" value="${pref.lon ?? ""}"></td>

    <td>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="tinybtn btnSync" type="button">Sync GPS</button>
        <button class="tinybtn btnStop" type="button" style="display:none;">Stop</button>
        <button class="tinybtn btnMap" type="button">Map</button>
        <span class="tag refTag"></span>
      </div>
    </td>

    <td>
      <div class="status"><span class="gpsStatus">—</span></div>
    </td>

    <td><input class="ex" type="checkbox"></td>
  `;

  tblBody.appendChild(tr);

  if (pref.mode) tr.querySelector(".mode").value = pref.mode;

  wireRow(tr);
  renumberRows();
}

function addRows(n){
  for(let i=0;i<n;i++) addRow({});
  renumberRows();
}

/* ========= GPS Sync (stabilised lock) ========= */
function stopGps(rowId){
  const h = gpsWatch.get(rowId);
  if(!h) return;
  try { navigator.geolocation.clearWatch(h.watchId); } catch {}
  try { clearTimeout(h.timer); } catch {}
  gpsWatch.delete(rowId);
}

function setRowStatus(tr, msg){
  tr.querySelector(".gpsStatus").innerHTML = msg;
}

function startGpsSync(tr){
  const rowId = tr.dataset.rowid;

  // stop any existing watch
  stopGps(rowId);

  // show stop button
  tr.querySelector(".btnStop").style.display = "inline-block";
  tr.querySelector(".btnSync").disabled = true;

  // mode to GPS (makes sense in field)
  tr.querySelector(".mode").value = "gps";

  const targetAcc = Math.max(1, Number($("gpsTargetAcc").value) || 10);
  const timeoutS = Math.max(5, Number($("gpsTimeout").value) || 20);

  let best = null; // {lat, lon, acc, ts}

  setRowStatus(tr, `Syncing… target ≤ <strong>${targetAcc} m</strong> (max ${timeoutS}s)`);

  const watchId = navigator.geolocation.watchPosition(
    (pos)=>{
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const acc = pos.coords.accuracy; // meters
      const ts = Date.now();

      // Track best accuracy
      if(!best || (Number.isFinite(acc) && acc < best.acc)){
        best = {lat, lon, acc, ts};
      }

      const curr = `acc <strong>${acc?.toFixed(1) ?? "?"} m</strong>`;
      const bestTxt = best ? `best <strong>${best.acc.toFixed(1)} m</strong>` : "";
      setRowStatus(tr, `GPS: ${curr} · ${bestTxt}`);

      // If good enough, lock it
      if(Number.isFinite(acc) && acc <= targetAcc){
        lockBest();
      }
    },
    (err)=>{
      setRowStatus(tr, `GPS error: ${err.message || err.code}`);
      cleanup();
    },
    { enableHighAccuracy:true, maximumAge:0, timeout:15000 }
  );

  const timer = setTimeout(()=>{
    // timeout: lock best we have
    lockBest(true);
  }, timeoutS * 1000);

  gpsWatch.set(rowId, {watchId, timer});

  function cleanup(){
    stopGps(rowId);
    tr.querySelector(".btnStop").style.display = "none";
    tr.querySelector(".btnSync").disabled = false;
  }

  function lockBest(isTimeout=false){
    if(!best){
      setRowStatus(tr, isTimeout ? `Timed out – no GPS fix` : `No GPS fix yet`);
      cleanup();
      return;
    }
    tr.querySelector(".lat").value = best.lat.toFixed(6);
    tr.querySelector(".lon").value = best.lon.toFixed(6);
    setRowStatus(tr, `${isTimeout ? "Locked (timeout)" : "Locked"}: best <strong>${best.acc.toFixed(1)} m</strong>`);
    cleanup();
    recalc();
  }
}

/* ========= Map modal ========= */
let map = null, marker = null;
let layerOSM = null, layerEsri = null;

function openMapForSelected(){
  if(!selectedRowId){
    alert("Select a row first.");
    return;
  }
  $("mapModal").style.display = "block";
  $("mapRowTag").textContent = `row ${rowIndexById(selectedRowId)}`;

  if(!map){
    map = L.map("map").setView([-34.9285, 138.6007], 17);
    layerOSM = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 });
    layerEsri = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19 }
    );
    layerEsri.addTo(map);

    map.on("click", (e)=>{
      const tr = [...tblBody.querySelectorAll("tr")].find(x=>x.dataset.rowid===selectedRowId);
      if(!tr) return;
      tr.querySelector(".lat").value = e.latlng.lat.toFixed(6);
      tr.querySelector(".lon").value = e.latlng.lng.toFixed(6);

      if(!marker) marker = L.marker([e.latlng.lat,e.latlng.lng]).addTo(map);
      else marker.setLatLng([e.latlng.lat,e.latlng.lng]);

      // GPS mode makes sense after picking a GPS point
      tr.querySelector(".mode").value = "gps";
      recalc();
    });
  }

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

/* ========= Wire row events ========= */
function wireRow(tr){
  const rowId = tr.dataset.rowid;

  tr.querySelector(".sel").addEventListener("change", ()=>{
    selectedRowId = rowId;
    renumberRows();
  });

  tr.querySelector(".btnSync").addEventListener("click", ()=>{
    selectedRowId = rowId;
    renumberRows();
    startGpsSync(tr);
  });

  tr.querySelector(".btnStop").addEventListener("click", ()=>{
    stopGps(rowId);
    tr.querySelector(".btnStop").style.display = "none";
    tr.querySelector(".btnSync").disabled = false;
    setRowStatus(tr, "Sync stopped");
  });

  tr.querySelector(".btnMap").addEventListener("click", ()=>{
    selectedRowId = rowId;
    renumberRows();
    openMapForSelected();
  });

  // Auto-grow: if user types into last row, add more rows automatically
  const inputs = [".dist",".mv",".lat",".lon"];
  inputs.forEach(sel=>{
    tr.querySelector(sel).addEventListener("input", ()=>{
      autoGrowIfNeeded();
      recalc();
    });
  });
  ["change"].forEach(evt=>{
    tr.querySelector(".mode").addEventListener(evt, recalc);
    tr.querySelector(".ex").addEventListener(evt, recalc);
  });
}

function autoGrowIfNeeded(){
  const rows = [...tblBody.querySelectorAll("tr")];
  if(rows.length === 0) return;
  const last = rows[rows.length-1];
  const anyFilled =
    (last.querySelector(".dist").value.trim() !== "") ||
    (last.querySelector(".mv").value.trim() !== "") ||
    (last.querySelector(".lat").value.trim() !== "") ||
    (last.querySelector(".lon").value.trim() !== "");
  if(anyFilled){
    // add 5 more automatically
    for(let i=0;i<5;i++) addRow({});
    renumberRows();
  }
}

/* ========= Data extraction ========= */
function getPointsFromTable(){
  const rows = [...tblBody.querySelectorAll("tr")].map(tr=>{
    const id = tr.dataset.rowid;
    const mode = tr.querySelector(".mode").value;
    const dist = Number(tr.querySelector(".dist").value);
    const mv = Number(tr.querySelector(".mv").value);
    const lat = Number(tr.querySelector(".lat").value);
    const lon = Number(tr.querySelector(".lon").value);
    const ex = tr.querySelector(".ex").checked;
    return { id, mode, dist, mv, lat, lon, ex, tr };
  });

  const ref = rows.find(r => r.id === refRowId);
  const refOK = ref && Number.isFinite(ref.lat) && Number.isFinite(ref.lon);

  if(refOK){
    for (const r of rows){
      if(r.mode === "gps" && Number.isFinite(r.lat) && Number.isFinite(r.lon)){
        r.dist = haversine_m(ref.lat, ref.lon, r.lat, r.lon);
        // write back so user sees it
        if(r.tr) r.tr.querySelector(".dist").value = r.dist.toFixed(1);
      }
    }
  }

  const pts = rows
    .filter(r => Number.isFinite(r.dist) && Number.isFinite(r.mv))
    .map(r => ({ d:r.dist, mv:r.mv, excluded:r.ex }));

  pts.sort((a,b)=>a.d-b.d);
  return pts;
}

/* ========= Engineering calculations ========= */
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

/* ========= Smooth curve (monotone cubic) ========= */
function monotoneCubicSample(x, y, samplesPerSeg=25){
  const n = x.length;
  if(n < 2) return [];
  if(n === 2){
    const out = [];
    for(let j=0;j<=samplesPerSeg;j++){
      const t=j/samplesPerSeg;
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

  const m = new Array(n);
  m[0] = d[0];
  m[n-1] = d[n-2];
  for(let i=1;i<n-1;i++){
    if(d[i-1]*d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2*h[i] + h[i-1];
      const w2 = h[i] + 2*h[i-1];
      m[i] = (w1 + w2) / (w1/d[i-1] + w2/d[i]);
    }
  }

  for(let i=0;i<n-1;i++){
    if(d[i] === 0){ m[i]=0; m[i+1]=0; continue; }
    const a = m[i]/d[i];
    const b = m[i+1]/d[i];
    const s = a*a + b*b;
    if(s > 9){
      const t = 3 / Math.sqrt(s);
      m[i] = t*a*d[i];
      m[i+1] = t*b*d[i];
    }
  }

  const out = [];
  for(let i=0;i<n-1;i++){
    const xi=x[i], xi1=x[i+1];
    const yi=y[i], yi1=y[i+1];
    const hi = h[i];
    const mi = m[i], mi1 = m[i+1];

    for(let j=0;j<=samplesPerSeg;j++){
      const t = j/samplesPerSeg;
      const t2=t*t, t3=t2*t;
      const h00 =  2*t3 - 3*t2 + 1;
      const h10 =      t3 - 2*t2 + t;
      const h01 = -2*t3 + 3*t2;
      const h11 =      t3 -    t2;

      const xs = xi + t*hi;
      const ys = h00*yi + h10*hi*mi + h01*yi1 + h11*hi*mi1;
      out.push({x: xs, y: ys});
    }
  }
  return out;
}

/* ========= Plotting ========= */
function drawPlot(allPts, incPts, smoothCurve, kneeDistance){
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 1100;
  const cssH = canvas.clientHeight || 360;
  canvas.width = Math.floor(cssW*dpr);
  canvas.height = Math.floor(cssH*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);

  const padL=60, padR=16, padT=14, padB=44;
  const w=cssW-padL-padR, h=cssH-padT-padB;

  ctx.clearRect(0,0,cssW,cssH);
  ctx.fillStyle="#fff"; ctx.fillRect(0,0,cssW,cssH);

  if(!allPts.length){
    ctx.fillStyle="#666";
    ctx.fillText("No data", padL, padT+20);
    return;
  }

  const xs = allPts.map(p=>p.d);
  const ys = allPts.map(p=>p.mv);
  const xmin=Math.min(...xs), xmax=Math.max(...xs);
  const ymin=Math.min(...ys), ymax=Math.max(...ys);
  const xspan=(xmax-xmin)||1, yspan=(ymax-ymin)||1;

  const X0 = xmin - 0.03*xspan, X1 = xmax + 0.03*xspan;
  const Y0 = ymin - 0.08*yspan, Y1 = ymax + 0.08*yspan;

  const xpix = (x)=> padL + ((x-X0)/(X1-X0))*w;
  const ypix = (y)=> padT + (1-((y-Y0)/(Y1-Y0)))*h;

  ctx.strokeStyle="#ddd"; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(padL,padT); ctx.lineTo(padL,padT+h); ctx.lineTo(padL+w,padT+h); ctx.stroke();

  ctx.font="12px system-ui,-apple-system,Segoe UI,Roboto,Arial";
  const xt=5, yt=5;

  for(let i=0;i<=xt;i++){
    const x= X0 + (i/xt)*(X1-X0);
    const xp=xpix(x);
    ctx.strokeStyle="#f0f0f0";
    ctx.beginPath(); ctx.moveTo(xp,padT); ctx.lineTo(xp,padT+h); ctx.stroke();
    ctx.fillStyle="#666";
    ctx.fillText(xmax>100 ? x.toFixed(0) : x.toFixed(1), xp-10, padT+h+18);
  }
  for(let i=0;i<=yt;i++){
    const y= Y0 + (i/yt)*(Y1-Y0);
    const yp=ypix(y);
    ctx.strokeStyle="#f0f0f0";
    ctx.beginPath(); ctx.moveTo(padL,yp); ctx.lineTo(padL+w,yp); ctx.stroke();
    ctx.fillStyle="#666";
    ctx.fillText(y.toFixed(0), 10, yp+4);
  }

  ctx.fillStyle="#333";
  ctx.fillText("Distance (m)", padL + w/2 - 34, padT+h+36);
  ctx.save();
  ctx.translate(18, padT + h/2 + 34);
  ctx.rotate(-Math.PI/2);
  ctx.fillText("Voltage (mV)", 0, 0);
  ctx.restore();

  if(smoothCurve && smoothCurve.length >= 2){
    ctx.strokeStyle="#111"; ctx.lineWidth=2.2;
    ctx.beginPath();
    smoothCurve.forEach((p,i)=>{
      const xp = xpix(p.x);
      const yp = ypix(p.y);
      if(i===0) ctx.moveTo(xp,yp); else ctx.lineTo(xp,yp);
    });
    ctx.stroke();
  } else if(incPts.length){
    ctx.strokeStyle="#111"; ctx.lineWidth=1.8;
    ctx.beginPath();
    incPts.forEach((p,i)=>{
      const xp=xpix(p.d), yp=ypix(p.mv);
      if(i===0) ctx.moveTo(xp,yp); else ctx.lineTo(xp,yp);
    });
    ctx.stroke();
  }

  if(Number.isFinite(kneeDistance)){
    const kx = xpix(kneeDistance);
    ctx.setLineDash([6,5]);
    ctx.strokeStyle="#999"; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.moveTo(kx, padT); ctx.lineTo(kx, padT+h); ctx.stroke();
    ctx.setLineDash([]);
  }

  allPts.forEach((p)=>{
    const xp=xpix(p.d), yp=ypix(p.mv);
    if(p.excluded){
      ctx.strokeStyle="#b00020"; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(xp-6,yp-6); ctx.lineTo(xp+6,yp+6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xp-6,yp+6); ctx.lineTo(xp+6,yp-6); ctx.stroke();
    } else {
      ctx.fillStyle="#000";
      ctx.beginPath(); ctx.arc(xp,yp,3.8,0,Math.PI*2); ctx.fill();
    }
  });
}

/* ========= Main calc ========= */
function recalc(){
  const itest = Number($("itest").value);
  const ifault = Number($("ifault").value);
  const sf = Number($("sf").value);
  const remoteMode = $("remoteMode").value;
  const nLast = Math.max(3, Number($("nLast").value));
  const tailMin = Math.max(3, Number($("tailMin").value));

  const allPts = getPointsFromTable();
  const incPts = allPts.filter(p => !p.excluded);

  if(!incPts.length || !Number.isFinite(itest) || itest<=0){
    drawPlot(allPts, incPts, null, null);
    $("knee").textContent = "—";
    $("kneeDetail").textContent = "—";
    $("vinf").textContent = "—";
    $("rg").textContent = "—";
    $("fitDetail").textContent = "—";
    $("scale").textContent = "—";
    $("eprscaled").textContent = "—";
    $("plateau").textContent = "Insufficient";
    $("plateau").className = "warn";
    $("plateauDetail").textContent = "Enter I_test > 0 and at least 1 included point.";
    return;
  }

  incPts.sort((a,b)=>a.d-b.d);

  const dist = incPts.map(p=>p.d);
  const mv   = incPts.map(p=>p.mv);
  const V    = mv.map(x=>x/1000);
  const R    = V.map(v=>v/itest);

  const knee = piecewiseKnee(dist, R);
  const kneeDistance = knee.idx===null ? null : dist[knee.idx];
  $("knee").textContent = kneeDistance===null ? "—" : `${kneeDistance.toFixed(1)} m`;
  $("kneeDetail").textContent = knee.detail;

  let tailDist=[], tailV=[];
  if(knee.idx!==null && (dist.length-knee.idx) >= tailMin){
    tailDist = dist.slice(knee.idx);
    tailV = V.slice(knee.idx);
  } else {
    const n = Math.min(tailMin, dist.length);
    tailDist = dist.slice(-n);
    tailV = V.slice(-n);
  }

  let Vinf = NaN;
  let fitDetail = "—";

  if(remoteMode==="extrap"){
    const x = tailDist.map(d=>1/d);
    const y = tailV;
    const f = linReg(x,y);
    Vinf = f.a;
    fitDetail = `Tail fit (V vs 1/d): pts=${x.length}, R²=${f.r2.toFixed(3)} → V∞=intercept`;
  } else if(remoteMode==="avgLastN"){
    const n = Math.min(nLast, V.length);
    Vinf = avg(V.slice(-n));
    fitDetail = `V∞ = average of last ${n} included points`;
  } else {
    Vinf = V[V.length-1];
    fitDetail = `V∞ = last included point`;
  }

  const Rg = Vinf / itest;
  const scale = (ifault/itest) * sf;
  const EPR_scaled = Vinf * scale;

  $("vinf").textContent = fmt(Vinf,3);
  $("rg").textContent = fmt(Rg,5);
  $("fitDetail").textContent = fitDetail;

  $("scale").textContent = fmt(scale,4);
  $("eprscaled").textContent = fmt(EPR_scaled,1);

  const pchk = plateauCheck(dist, R, nLast);
  const pel = $("plateau");
  pel.textContent = pchk.status;
  pel.className = pchk.cls;
  $("plateauDetail").textContent = pchk.detail;

  const smooth = monotoneCubicSample(dist, mv, 30);
  drawPlot(allPts, incPts, smooth, kneeDistance);
}

/* ========= CSV ========= */
function downloadCSV(){
  const rows = [...tblBody.querySelectorAll("tr")].map(tr=>{
    const mode = tr.querySelector(".mode").value;
    const d = tr.querySelector(".dist").value;
    const mv = tr.querySelector(".mv").value;
    const lat = tr.querySelector(".lat").value;
    const lon = tr.querySelector(".lon").value;
    const ex = tr.querySelector(".ex").checked ? "Y" : "";
    const tag = (tr.dataset.rowid === refRowId) ? "REF" : "";
    const status = tr.querySelector(".gpsStatus").textContent.replace(/\s+/g," ").trim();
    return { mode, d, mv, lat, lon, ex, tag, status };
  });

  const out = [];
  out.push(["#", "Mode", "Distance_m", "mV", "Lat", "Lon", "Exclude", "Tag", "GPS_Status"].join(","));
  rows.forEach((r,i)=>{
    out.push([i+1, r.mode, r.d, r.mv, r.lat, r.lon, r.ex, r.tag, `"${r.status}"`].join(","));
  });

  const blob = new Blob([out.join("\n")], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "epr_plotter.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ========= Buttons ========= */
$("btnUpdate").addEventListener("click", recalc);

$("btnResetExclude").addEventListener("click", ()=>{
  [...tblBody.querySelectorAll("tr")].forEach(tr=>tr.querySelector(".ex").checked = false);
  recalc();
});

$("btnAddRow").addEventListener("click", ()=> addRows(1));
$("btnAdd5").addEventListener("click", ()=> addRows(5));
$("btnAdd20").addEventListener("click", ()=> addRows(20));

$("btnSetRefSelected").addEventListener("click", ()=>{
  if(!selectedRowId){
    alert("Select a row (radio) first.");
    return;
  }
  refRowId = selectedRowId;
  renumberRows();
  recalc();
});

$("btnCSV").addEventListener("click", downloadCSV);

$("btnExample").addEventListener("click", ()=>{
  tblBody.innerHTML = "";
  refRowId = null;
  selectedRowId = null;
  gpsWatch.clear();

  // Example flow:
  addRow({mode:"gps", mv:100});
  const first = [...tblBody.querySelectorAll("tr")][0];
  first.querySelector(".sel").checked = true;
  selectedRowId = first.dataset.rowid;
  refRowId = selectedRowId;
  setRowStatus(first, "Tap Sync GPS to lock REF");

  addRow({mode:"manual", d:0.1, mv:141});
  addRow({mode:"manual", d:1, mv:151});
  addRow({mode:"manual", d:2, mv:155});
  addRow({mode:"manual", d:3, mv:155});
  addRow({mode:"manual", d:4, mv:156});
  addRow({mode:"manual", d:6, mv:144});
  addRow({mode:"manual", d:11, mv:171});
  addRow({mode:"manual", d:17, mv:181});
  addRow({mode:"manual", d:28, mv:196});

  addRows(5);
  renumberRows();
  recalc();
});

$("btnGpsNewRef").addEventListener("click", ()=>{
  // Create row, select it, and start sync; once locked user can press "Set selected as REF" OR we auto-set as REF here.
  addRow({mode:"gps"});
  const last = [...tblBody.querySelectorAll("tr")].slice(-1)[0];
  last.querySelector(".sel").checked = true;
  selectedRowId = last.dataset.rowid;
  refRowId = selectedRowId; // auto make it REF
  renumberRows();
  // Start sync immediately
  startGpsSync(last);
});

/* ========= Init ========= */
addRows(12);          // start with more than 8
renumberRows();
recalc();
