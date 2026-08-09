let pages = [];
let selectedPageId = null;

const $ = s => document.querySelector(s);

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers||{}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.needsReauth = data.needsReauth;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg, ms=3000){
  const t=$('#toast'); t.textContent=msg; t.hidden=false;
  setTimeout(()=> t.hidden=true, ms);
}

function fmt(n){ if(n==null) return '—'; if(n>=1000) return (n/1000).toFixed(n>=10000?0:1)+'k'; return String(n); }
function pct(v){ if(v==null||isNaN(v)) return '—'; const s=v>0?'+':''; return s+(v*100).toFixed(1)+'%'; }

async function loadAuth(){
  try{
    const s = await api('/api/auth/status');
    const pill = $('#demoPill');
    pill.hidden = !s.isDemo;

    const loginBtn = $('#loginBtn');
    const authStatus = $('#authStatus');
    const banner = $('#reauthBanner');

    if(s.needsReauth || s.tokenStatus==='expired'){
      banner.hidden=false;
      $('#reauthMsg').textContent = s.authErrors?.[0]?.last_error || 'Long-lived token expired — please reconnect.';
    } else {
      banner.hidden=true;
    }

    if(s.connected){
      loginBtn.textContent='Re-connect Facebook';
      loginBtn.onclick=()=> location.href='/api/auth/login';
      let exp = s.expiresInDays!=null ? ` · expires in ${s.expiresInDays.toFixed(1)}d` : '';
      if(s.tokenStatus==='expiring_soon') exp+=' ⚠️ soon';
      authStatus.textContent = s.tokenStatus==='valid' ? `Connected${exp}` : `${s.tokenStatus}${exp}`;
      authStatus.title = `Pages: ${s.pages.map(p=>p.name).join(', ')}`;
    } else {
      loginBtn.textContent='Connect Facebook';
      loginBtn.onclick=()=> location.href='/api/auth/login';
      authStatus.textContent = s.configured ? 'Not connected' : 'Demo mode — set FB_APP_ID in .env to connect';
    }

    // handle ?auth=success
    const params=new URLSearchParams(location.search);
    if(params.get('auth')==='success'){
      toast(`Connected! Found ${params.get('pages')||0} page(s).`);
      history.replaceState(null,'',location.pathname);
    }
  }catch(e){ console.error(e); }
}

async function loadPages(){
  const res = await api('/api/pages');
  pages = res;
  const list = $('#pagesList');
  const sel = $('#composerPage');
  list.innerHTML=''; sel.innerHTML='';
  if(!pages.length){
    list.innerHTML='<p class="muted small">No pages yet. Connect Facebook or use demo data.</p>';
    return;
  }
  if(!selectedPageId) selectedPageId = pages[0].id;
  for(const p of pages){
    const div=document.createElement('div');
    div.className='page-item'+(p.id===selectedPageId?' active':'');
    div.innerHTML=`<div><div class="name">${escapeHtml(p.name)}</div><div class="meta">${escapeHtml(p.category||'Page')} · ${p.id.slice(0,6)}…</div></div><div class="meta">›</div>`;
    div.onclick=()=>{ selectedPageId=p.id; loadPages(); loadPageData(); };
    list.appendChild(div);

    const opt=document.createElement('option');
    opt.value=p.id; opt.textContent=p.name; if(p.id===selectedPageId) opt.selected=true;
    sel.appendChild(opt);
  }
}

function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function loadPageData(){
  if(!selectedPageId) return;
  const p = pages.find(x=>x.id===selectedPageId);
  $('#pageHeader').innerHTML=`<h2>${escapeHtml(p.name)}</h2><p>${escapeHtml(p.category||'') } · ${p.id} — performance vs your own page average (not industry benchmarks)</p>`;

  // parallel fetches
  let reelsData, recData;
  try{
    [reelsData, recData] = await Promise.all([
      api(`/api/insights/pages/${selectedPageId}/reels`),
      api(`/api/insights/pages/${selectedPageId}/recommendations`)
    ]);
  }catch(e){
    if(e.needsReauth){
      $('#reauthBanner').hidden=false;
      toast('Token expired — please re-authenticate');
    }
    return;
  }

  // KPIs
  const kpis = $('#kpis');
  const av = reelsData.averages;
  const totalViews = reelsData.reels.reduce((s,r)=>s+(r.post_video_views||0),0);
  const avgEng = av.avg_engagement? (av.avg_engagement*100).toFixed(2)+'%':'—';
  kpis.innerHTML=`
    <div class="kpi"><div class="label">Avg views / Reel</div><div class="value">${fmt(Math.round(av.avg_views))}</div><div class="sub">${av.n} reels in history</div></div>
    <div class="kpi"><div class="label">Avg watch time</div><div class="value">${av.avg_watch? av.avg_watch.toFixed(1)+'s':'—'}</div><div class="sub">per view</div></div>
    <div class="kpi"><div class="label">Total views (history)</div><div class="value">${fmt(totalViews)}</div><div class="sub">stored locally — not re-fetched</div></div>
    <div class="kpi"><div class="label">Avg engagement rate</div><div class="value">${avgEng}</div><div class="sub">(likes+comments+shares)/reach</div></div>
  `;

  // Best time
  const bt = $('#bestTime');
  const hw = $('#heatmapWrap');
  if(recData.insufficientData){
    bt.innerHTML=`<p class="muted">${escapeHtml(recData.message)}</p>`;
    hw.innerHTML='';
  }else{
    bt.innerHTML=`<p class="small muted">${recData.totalPosts} posts analyzed. Top slots (hour your audience actually watched):</p>
      <div class="top-slots">${recData.topSlots.map(s=>`<span class="slot"><strong>${escapeHtml(s.label)}</strong> · ${fmt(s.medianViews)} med views · ${s.count} post(s)</span>`).join('')}</div>`;
    hw.innerHTML = renderHeatmap(recData.heatmap);
  }

  // Reels table
  const tbody = $('#reelsTable tbody');
  const empty = $('#reelsEmpty');
  tbody.innerHTML='';
  if(!reelsData.reels.length){
    empty.hidden=false;
  }else{
    empty.hidden=true;
    for(const r of reelsData.reels){
      const vs = r.vs_avg_views;
      let badge='flat', badgeTxt='avg';
      if(vs>0.15) {badge='up'; badgeTxt='+'+ (vs*100).toFixed(0)+'%';}
      else if(vs<-0.15){badge='down'; badgeTxt=(vs*100).toFixed(0)+'%';}
      else badgeTxt=(vs*100).toFixed(0)+'%';
      const eng = r.engagement_rate? (r.engagement_rate*100).toFixed(2)+'%':'—';
      const ret = r.retention_rate!=null? (r.retention_rate*100).toFixed(1)+'%':'—';
      const created = new Date(r.created_time).toLocaleString();
      const tr=document.createElement('tr');
      tr.innerHTML=`
        <td class="post-cell"><div class="msg">${escapeHtml((r.message||'(no caption)').slice(0,120))}</div><div class="meta">${r.is_reel?'🎬 Reel':'📄 Post'} · <a href="${escapeHtml(r.permalink_url||'#')}" target="_blank">View on Facebook</a></div></td>
        <td class="small">${escapeHtml(created)}</td>
        <td class="num"><strong>${fmt(r.post_video_views)}</strong></td>
        <td class="num"><span class="badge ${badge}">${badgeTxt}</span></td>
        <td class="num">${r.post_video_avg_time_watched? r.post_video_avg_time_watched.toFixed(1)+'s':'—'}</td>
        <td class="num">${fmt(r.post_reach)}</td>
        <td class="num">${eng}</td>
        <td class="num">${ret}</td>
        <td class="num"><a href="${escapeHtml(r.permalink_url||'#')}" target="_blank" class="btn small">Open</a></td>
      `;
      tbody.appendChild(tr);
    }
  }
}

function renderHeatmap(hm){
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html='<div class="heatmap"><table><thead><tr><th></th>';
  for(let h=0;h<24;h++) html+=`<th>${h}</th>`;
  html+='</tr></thead><tbody>';
  for(let d=0;d<7;d++){
    html+=`<tr><th>${days[d]}</th>`;
    for(let h=0;h<24;h++){
      const cell=hm[d][h];
      if(!cell){ html+='<td style="background:#f9fafb"></td>'; continue; }
      const intensity = Math.round(cell.norm*255);
      // blue scale
      const bg = `rgba(24,119,242,${(0.08+cell.norm*0.82).toFixed(2)})`;
      const color = cell.norm>0.5?'#fff':'#111827';
      html+=`<td style="background:${bg};color:${color}" title="${days[d]} ${h}:00 — ${cell.views} med views, ${cell.count} post(s)">${cell.count? '●':''}</td>`;
    }
    html+='</tr>';
  }
  html+='</tbody></table><p class="small muted">Darker = higher median views in your history for that hour. Dots = you’ve posted there.</p></div>';
  return html;
}

// Composer
$('#composerForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const pageId=$('#composerPage').value;
  const caption=$('#composerCaption').value;
  const file=$('#composerFile').files[0];
  const url=$('#composerUrl').value.trim();
  const time=$('#composerTime').value;
  const msg=$('#composerMsg');
  if(!pageId){ toast('Select a page'); return; }
  if(!file && !url){ toast('Add a video file or file_url'); return; }
  msg.textContent='Uploading…';
  try{
    const form=new FormData();
    form.append('caption',caption);
    if(file) form.append('video',file);
    if(url) form.append('file_url',url);
    if(time) form.append('scheduled_time', new Date(time).toISOString());
    const res=await fetch(`/api/composer/pages/${pageId}/reels`,{method:'POST', body:form});
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`);
    msg.textContent=data.scheduled? `✓ Scheduled — id ${data.result.id}` : `✓ Published — id ${data.result.id}`;
    msg.style.color='#166534';
    toast(data.scheduled? 'Reel scheduled':'Reel published');
    $('#composerForm').reset();
  }catch(err){
    msg.textContent='✗ '+err.message;
    msg.style.color='#991b1b';
    if(err.message.includes('Token')||err.message.includes('auth')) $('#reauthBanner').hidden=false;
  }
});

$('#syncBtn').addEventListener('click', async ()=>{
  const btn=$('#syncBtn'); const m=$('#syncMsg');
  btn.disabled=true; btn.textContent='Syncing…'; m.textContent='';
  try{
    const r=await api(`/api/insights/pages/${selectedPageId}/sync`,{method:'POST'});
    m.textContent=`✓ Fetched ${r.fetched}/${r.total}`;
    m.style.color='#166534';
    toast('Sync complete');
    await loadPageData();
  }catch(e){
    m.textContent='✗ '+e.message;
    m.style.color='#991b1b';
    if(e.needsReauth) $('#reauthBanner').hidden=false;
    if(e.status===429) toast('Rate limited — try again in a minute');
  }finally{ btn.disabled=false; btn.textContent='↻ Sync now'; }
});

$('#refreshPagesBtn').addEventListener('click', async ()=>{
  try{
    await api('/api/pages/refresh',{method:'POST'});
    toast('Pages refreshed');
    await loadPages(); await loadPageData();
  }catch(e){
    toast(e.message);
    if(e.needsReauth) $('#reauthBanner').hidden=false;
  }
});

// boot
await loadAuth();
await loadPages();
if(selectedPageId) await loadPageData();
else $('#pageHeader').innerHTML='<p class="muted">No pages yet.</p>';
