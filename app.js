let excluded = new Set();
let last = null;

const $ = (id) => document.getElementById(id);

function parseData(text){
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const pts = [];
  for (const line of lines){
    const parts = line.split(/[\s,;\t]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const d = Number(parts[0]);
    const mv = Number(parts[1]);
    if (Number.isFinite(d) && Number.isFinite(mv)) pts.push({d, mv});
  }
  pts.sort((a,b)=>a.d-b.d);
  return pts;
}
function avg(a){ return a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN; }
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
function buildIncluded(pts){
  const inc=[];
  pts.forEach((p,i)=>{ if(!excluded.has(i)) inc.push({i, ...p}); });
  return inc;
}

// Knee via best 2-line split on R(d)
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

/* ==== Plot (no libs) ==== */
const canvas = $("plot");
const ctx = canvas.getContext("2d");

function fmt(x,dp=3){ return Number.isFinite(x) ? x.toFixed(dp) : "—"; }

function drawPlot(allPts){
  // HiDPI
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 1000;
  const cssH = canvas.clientHeight || 340;
  canvas.width = Math.floor(cssW*dpr);
  canvas.height = Math.floor(cssH*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);

  const padL=56, padR=16, padT=14, padB=40;
  const w=cssW-padL-padR, h=cssH-padT-padB;

  ctx.clearRect(0,0,cssW,cssH);
  ctx.fillStyle="#fff"; ctx.fillRect(0,0,cssW,cssH);

  if(!allPts.length) return;

  const xs = allPts.map(p=>p.d);
  const ys = allPts.map(p=>p.mv);
  const xmin=Math.min(...xs), xmax=Math.max(...xs);
  const ymin=Math.min(...ys), ymax=Math.max(...ys);
  const xspan=(xmax-xmin)||1, yspan=(ymax-ymin)||1;

  const X0 = xmin - 0.03*xspan, X1 = xmax + 0.03*xspan;
  const Y0 = ymin - 0.06*yspan, Y1 = ymax + 0.06*yspan;

  const xpix = (x)=> padL + ((x-X0)/(X1-X0))*w;
  const ypix = (y)=> padT + (1-((y-Y0)/(Y1-Y0)))*h;

  // grid + axes
  ctx.strokeStyle="#ddd"; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(padL,padT); ctx.lineTo(padL,padT+h); ctx.lineTo(padL+w,padT+h); ctx.stroke();

  ctx.font="12px system-ui,-apple-system,Segoe UI,Roboto,Arial";
  ctx.fillStyle="#666";

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
    ctx.fillText(y.toFixed(0), 8, yp+4);
  }

  ctx.fillStyle="#333";
  ctx.fillText("Distance (m)", padL + w/2 - 34, padT+h+34);
  ctx.save();
  ctx.translate(16, padT + h/2 + 34);
  ctx.rotate(-Math.PI/2);
  ctx.fillText("Voltage (mV)", 0, 0);
  ctx.restore();

  // line
  ctx.strokeStyle="#111"; ctx.lineWidth=1.8;
  ctx.beginPath();
  allPts.forEach((p,i)=>{
    const xp=xpix(p.d), yp=ypix(p.mv);
    if(i===0) ctx.moveTo(xp,yp); else ctx.lineTo(xp,yp);
  });
  ctx.stroke();

  // points
  allPts.forEach((p,i)=>{
    const xp=xpix(p.d), yp=ypix(p.mv);
    if(excluded.has(i)){
      ctx.strokeStyle="#b00020"; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(xp-6,yp-6); ctx.lineTo(xp+6,yp+6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xp-6,yp+6); ctx.lineTo(xp+6,yp-6); ctx.stroke();
    } else {
      ctx.fillStyle="#000";
      ctx.beginPath(); ctx.arc(xp,yp,3.6,0,Math.PI*2); ctx.fill();
    }
  });

  last.plot = { xpix, ypix };
}

canvas.addEventListener("click", (e)=>{
  if(!last?.pts?.length || !last.plot) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  let best = {idx:null, d2:Infinity};
  for(let i=0;i<last.pts.length;i++){
    const p = last.pts[i];
    const xp = last.plot.xpix(p.d);
    const yp = last.plot.ypix(p.mv);
    const dx=xp-x, dy=yp-y;
    const d2=dx*dx+dy*dy;
    if(d2 < best.d2) best = {idx:i, d2};
  }
  if(best.idx!==null && best.d2 <= 14*14){
    excluded.has(best.idx) ? excluded.delete(best.idx) : excluded.add(best.idx);
    recalc();
  }
});

function recalc(){
  const pts = parseData($("data").value);
  const itest = Number($("itest").value);
  const ifault = Number($("ifault").value);
  const sf = Number($("sf").value);
  const remoteMode = $("remoteMode").value;
  const nLast = Math.max(3, Number($("nLast").value));
  const tailMin = Math.max(3, Number($("tailMin").value));

  if(!pts.length || !Number.isFinite(itest) || itest<=0){
    alert("Enter valid data and I_test > 0.");
    return;
  }

  const inc = buildIncluded(pts);
  if(inc.length < 3){
    alert("Too many excluded points. Need ≥3 included.");
    return;
  }

  const dist = inc.map(p=>p.d);
  const mv   = inc.map(p=>p.mv);
  const V    = mv.map(x=>x/1000);
  const R    = V.map(v=>v/itest);

  const knee = piecewiseKnee(dist,R);
  const kneeDistance = knee.idx===null ? null : dist[knee.idx];

  $("knee").textContent = kneeDistance===null ? "—" : `${kneeDistance.toFixed(1)} m`;
  $("kneeDetail").textContent = knee.detail;

  // Tail selection
  let tailDist=[], tailV=[];
  if(knee.idx!==null && (dist.length-knee.idx) >= tailMin){
    tailDist = dist.slice(knee.idx);
    tailV = V.slice(knee.idx);
  } else {
    const n = Math.min(tailMin, dist.length);
    tailDist = dist.slice(-n);
    tailV = V.slice(-n);
  }

  // Remote estimation
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

  last = { pts, itest, ifault, sf, remoteMode, kneeDistance, Vinf, Rg, scale, EPR_scaled, excluded:Array.from(excluded) };
  drawPlot(pts);
}

function downloadCSV(){
  if(!last?.pts) return;
  const rows = [];
  rows.push(["Distance_m","mV","Excluded"]);
  last.pts.forEach((p,i)=>rows.push([p.d,p.mv,excluded.has(i)?"Y":""]));
  rows.push([]);
  rows.push(["I_test_A", last.itest]);
  rows.push(["I_fault_A", last.ifault]);
  rows.push(["SF", last.sf]);
  rows.push(["RemoteMode", last.remoteMode]);
  rows.push(["KneeDistance_m", last.kneeDistance ?? ""]);
  rows.push(["Vinf_V", last.Vinf]);
  rows.push(["Rg_ohm", last.Rg]);
  rows.push(["Scale_total", last.scale]);
  rows.push(["EPR_scaled_V", last.EPR_scaled]);

  const csv = rows.map(r=>r.join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "epr_plot.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function loadExample(){
  excluded.clear();
  $("data").value =
`0.1 141
1 151
2 155
3 155
4 156
6 144
11 171
17 181
28 196
61 197
147 218
408 220`;
  recalc();
}

$("btnUpdate").addEventListener("click", recalc);
$("btnReset").addEventListener("click", ()=>{excluded.clear(); recalc();});
$("btnExample").addEventListener("click", loadExample);
$("btnCSV").addEventListener("click", downloadCSV);

loadExample();
