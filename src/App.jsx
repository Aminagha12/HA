import { useState, useEffect, useCallback } from "react";
import { CapacitorHttp } from "@capacitor/core";

const BINANCE_API_KEY = import.meta.env.VITE_BINANCE_API_KEY || "";
const BINANCE_BASE    = "https://api.binance.com";
const LICENSE_KEY     = "Hamidi2026@#AK";

// ── JP225 لرې شو ──────────────────────────────────────
const SYMBOLS = [
  { id:"XAUUSD", binanceSymbol:"PAXGUSDT", label:"XAUUSD.m", name:"GOLD vs USD",   emoji:"🥇", decimals:2 },
  { id:"BTCUSD", binanceSymbol:"BTCUSDT",  label:"BTCUSD.m", name:"Bitcoin vs USD", emoji:"₿",  decimals:2 },
];

// ── localStorage helpers (د Login د persist لپاره) ────
const LS_USERS = "forex_users";
const loadUsers  = () => { try { const s = localStorage.getItem(LS_USERS); return s ? JSON.parse(s) : []; } catch { return []; } };
const saveUsers  = (u) => { try { localStorage.setItem(LS_USERS, JSON.stringify(u)); } catch {} };

// ─────────────────────────────────────────────────────
//  INDICATOR CALCULATIONS
// ─────────────────────────────────────────────────────
const calcEMA = (data, period) => {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const r = new Array(period - 1).fill(null);
  r.push(ema);
  for (let i = period; i < data.length; i++) { ema = data[i] * k + ema * (1 - k); r.push(ema); }
  return r;
};

const calcSMA = (data, period) => {
  const r = new Array(period - 1).fill(null);
  for (let i = period - 1; i < data.length; i++)
    r.push(data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  return r;
};

const calcRSI = (closes, period = 14) => {
  if (closes.length < period + 1) return [];
  const r = new Array(period).fill(null);
  let gS = 0, lS = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i]-closes[i-1]; if(d>0) gS+=d; else lS-=d; }
  let ag = gS/period, al = lS/period;
  r.push(al===0?100:100-100/(1+ag/al));
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag = (ag*(period-1)+Math.max(d,0))/period;
    al = (al*(period-1)+Math.max(-d,0))/period;
    r.push(al===0?100:100-100/(1+ag/al));
  }
  return r;
};

const calcMACD = (closes, fast=12, slow=26, sig=9) => {
  const ef=calcEMA(closes,fast), es=calcEMA(closes,slow);
  const ml=closes.map((_,i)=>ef[i]!=null&&es[i]!=null?ef[i]-es[i]:null);
  const mv=ml.filter(v=>v!=null), se=calcEMA(mv,sig);
  const sf=new Array(ml.length).fill(null); let si=0;
  for(let i=0;i<ml.length;i++) if(ml[i]!=null){sf[i]=se[si]??null;si++;}
  const h=closes.map((_,i)=>ml[i]!=null&&sf[i]!=null?ml[i]-sf[i]:null);
  return {macdLine:ml,signalLine:sf,histogram:h};
};

const calcStoch = (highs,lows,closes,kp=14,dp=3) => {
  const k=new Array(kp-1).fill(null);
  for(let i=kp-1;i<closes.length;i++){
    const hh=Math.max(...highs.slice(i-kp+1,i+1)), ll=Math.min(...lows.slice(i-kp+1,i+1));
    k.push(hh===ll?50:((closes[i]-ll)/(hh-ll))*100);
  }
  const kv=k.filter(v=>v!=null), d=calcSMA(kv,dp);
  return {kLast:kv[kv.length-1],dLast:d[d.length-1]};
};

const calcBB = (closes,period=20,mult=2) => {
  const sma=calcSMA(closes,period);
  return closes.map((_,i)=>{
    if(sma[i]==null)return null;
    const sl=closes.slice(i-period+1,i+1);
    const std=Math.sqrt(sl.reduce((s,v)=>s+Math.pow(v-sma[i],2),0)/period);
    return {upper:sma[i]+mult*std,lower:sma[i]-mult*std};
  });
};

const calcATR = (highs,lows,closes,period=14) => {
  const tr=[null];
  for(let i=1;i<closes.length;i++)
    tr.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  const a=calcSMA(tr.filter(v=>v!=null),period);
  return a[a.length-1];
};

const calcOBV = (closes,volumes) => {
  let last=0,prev=0;
  for(let i=1;i<closes.length-1;i++){
    if(closes[i]>closes[i-1]) prev+=volumes[i];
    else if(closes[i]<closes[i-1]) prev-=volumes[i];
  }
  last=prev; const n=closes.length-1;
  if(closes[n]>closes[n-1]) last+=volumes[n];
  else if(closes[n]<closes[n-1]) last-=volumes[n];
  return {last,prev};
};

// ── Signal Engine — threshold 6, trend filter ────────
const generateSignal = (candles) => {
  if(!candles||candles.length<210)return null;
  const closes=candles.map(c=>c.close), highs=candles.map(c=>c.high);
  const lows=candles.map(c=>c.low),   volumes=candles.map(c=>c.volume);

  const ema9=calcEMA(closes,9),   ema21=calcEMA(closes,21);
  const ema50=calcEMA(closes,50), ema200=calcEMA(closes,200);
  const sma200=calcSMA(closes,200), rsi=calcRSI(closes,14);
  const macd=calcMACD(closes,12,26,9), stoch=calcStoch(highs,lows,closes,14,3);
  const bb=calcBB(closes,20,2), atr=calcATR(highs,lows,closes,14);
  const obv=calcOBV(closes,volumes), volMA=calcSMA(volumes,20);

  const n=closes.length-1;
  const e9c=ema9[n],e9p=ema9[n-1], e21c=ema21[n],e21p=ema21[n-1];
  const e50=ema50[n],e200=ema200[n], s200=sma200[n];
  const rsiC=rsi[n],rsiP=rsi[n-1];
  const macdC=macd.macdLine[n],macdP=macd.macdLine[n-1];
  const sigC=macd.signalLine[n],sigP=macd.signalLine[n-1];
  const histC=macd.histogram[n],histP=macd.histogram[n-1];
  const bbC=bb[n], close=closes[n], prevClose=closes[n-1];
  const volLast=volumes[n], volMALast=volMA[n];

  let buy=0, sell=0;

  // EMA 9/21 crossover (weight 2)
  if(e9p!=null&&e21p!=null){
    if(e9p<=e21p&&e9c>e21c) buy+=2;
    else if(e9p>=e21p&&e9c<e21c) sell+=2;
    else if(e9c>e21c) buy+=1; else sell+=1;
  }
  // EMA 50/200 trend direction (weight 2)
  if(e50!=null&&e200!=null){
    if(e50>e200) buy+=2; else sell+=2;
  }
  // SMA200 price position (weight 1)
  if(s200!=null){ if(close>s200) buy+=1; else sell+=1; }

  // RSI (weight 2)
  if(rsiC!=null&&rsiP!=null){
    if(rsiC<35&&rsiC>rsiP) buy+=2;
    else if(rsiC>65&&rsiC<rsiP) sell+=2;
    else if(rsiC>55&&rsiC<65) buy+=1;
    else if(rsiC<45&&rsiC>35) sell+=1;
  }
  // MACD crossover (weight 2)
  if(macdC!=null&&sigC!=null&&macdP!=null&&sigP!=null){
    if(macdP<=sigP&&macdC>sigC) buy+=2;
    else if(macdP>=sigP&&macdC<sigC) sell+=2;
    if(histC!=null&&histP!=null){
      if(histC>0&&histC>histP) buy+=1;
      else if(histC<0&&histC<histP) sell+=1;
    }
  }
  // Stochastic (weight 1)
  if(stoch.kLast!=null){
    if(stoch.kLast<25&&stoch.kLast>stoch.dLast) buy+=1;
    else if(stoch.kLast>75&&stoch.kLast<stoch.dLast) sell+=1;
  }
  // Bollinger Bands (weight 2)
  if(bbC!=null){
    if(close<=bbC.lower) buy+=2;
    else if(close>=bbC.upper) sell+=2;
  }
  // OBV (weight 1)
  if(obv.last>obv.prev) buy+=1; else sell+=1;
  // Volume (weight 1)
  if(volMALast!=null&&volLast>volMALast){
    if(close>prevClose) buy+=1; else sell+=1;
  }

  // ── Trend filter: د EMA200 پرته BUY/SELL نه ──
  const trendUp   = e200!=null && close > e200;
  const trendDown = e200!=null && close < e200;

  let direction="NEUTRAL";
  // threshold=6, د trend سره موافق وي
 if(buy>sell) direction="BUY";
else if(sell>buy) direction="SELL";

  if(direction==="NEUTRAL")
    return {direction:"NEUTRAL",macd:macdC,signal:sigC,rsi:rsiC};

  const entry=close;
  const stopLoss   = direction==="BUY" ? entry-1.0*atr : entry+1.0*atr;
  const takeProfit = direction==="BUY" ? entry+1.4*atr : entry-1.4*atr;
  return {direction,entry,stopLoss,takeProfit,macd:macdC,signal:sigC,rsi:rsiC,atr};
};

// ── Styles ────────────────────────────────────────────
const S = {
  inp:{width:"100%",padding:"13px 14px",background:"rgba(0,200,255,0.06)",border:"1px solid rgba(0,200,255,0.22)",borderRadius:12,color:"#e8f4ff",fontSize:15,marginBottom:14,boxSizing:"border-box",outline:"none"},
  btn:{width:"100%",padding:"15px",background:"linear-gradient(135deg,#0077aa,#004d75)",border:"1px solid rgba(0,180,255,0.3)",borderRadius:12,color:"#e8f8ff",fontWeight:800,fontSize:15,cursor:"pointer",letterSpacing:1.5,marginTop:4},
  btnRed:{width:"100%",padding:"14px",background:"linear-gradient(135deg,#9b1c1c,#7b1010)",border:"1px solid rgba(255,80,80,0.3)",borderRadius:12,color:"#ffe0e0",fontWeight:800,fontSize:14,cursor:"pointer",letterSpacing:1.5,marginTop:4},
  card:{background:"linear-gradient(160deg,#0d1e30,#091624)",border:"1px solid rgba(0,200,255,0.15)",borderRadius:16,padding:20,marginBottom:14},
  lbl:{color:"#5bc8e8",fontSize:12,fontWeight:700,letterSpacing:1,marginBottom:8,display:"block"},
  err:{color:"#ff6b80",background:"rgba(255,80,90,0.08)",border:"1px solid rgba(255,80,90,0.25)",padding:"11px 14px",borderRadius:10,marginBottom:14,fontSize:13},
  ok:{color:"#00e676",background:"rgba(0,230,118,0.07)",border:"1px solid rgba(0,230,118,0.2)",padding:"11px 14px",borderRadius:10,marginBottom:14,fontSize:13},
};

// ── Robot SVG Icon ────────────────────────────────────
const RobotIcon = ({ size=90,style={} }) => (
  <div style={{width:size,height:size,borderRadius:"50%",background:"linear-gradient(135deg,#071828,#003d5c)",border:"2.5px solid #00c8ff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 28px rgba(0,200,255,0.35)",flexShrink:0,...style}}>
    <svg width={size*0.55} height={size*0.55} viewBox="0 0 64 64" fill="none">
      <rect x="16" y="20" width="32" height="28" rx="6" fill="#00c8ff" opacity="0.15" stroke="#00c8ff" strokeWidth="1.5"/>
      <rect x="22" y="26" width="8"  height="8" rx="2" fill="#00e5ff"/>
      <rect x="34" y="26" width="8"  height="8" rx="2" fill="#00e5ff"/>
      <rect x="26" y="38" width="12" height="3" rx="1.5" fill="#00e5ff" opacity="0.8"/>
      <rect x="29" y="12" width="6"  height="8" rx="3" fill="#00c8ff" opacity="0.9"/>
      <circle cx="32" cy="11" r="3" fill="#00e5ff"/>
      <rect x="8"  y="28" width="8" height="14" rx="4" fill="#00c8ff" opacity="0.5" stroke="#00c8ff" strokeWidth="1"/>
      <rect x="48" y="28" width="8" height="14" rx="4" fill="#00c8ff" opacity="0.5" stroke="#00c8ff" strokeWidth="1"/>
      <rect x="22" y="48" width="8" height="10" rx="4" fill="#00c8ff" opacity="0.5"/>
      <rect x="34" y="48" width="8" height="10" rx="4" fill="#00c8ff" opacity="0.5"/>
    </svg>
  </div>
);

// ── Auth Wrapper — CENTERED ───────────────────────────
const AuthWrap = ({ children }) => (
  <div style={{
    minHeight:"100vh",
    background:"radial-gradient(ellipse at 30% 20%,#071828,#030d16,#010810)",
    display:"flex",
    flexDirection:"column",
    alignItems:"center",
    justifyContent:"center",   // ← CENTER fix
    padding:"20px",
    fontFamily:"'Segoe UI',system-ui,sans-serif",
  }}>
    {/* Header block — centered */}
    <div style={{textAlign:"center",marginBottom:32}}>
      <RobotIcon size={96} style={{margin:"0 auto 16px"}}/>
      <div style={{fontSize:26,fontWeight:900,color:"#3de8ff",letterSpacing:3,textShadow:"0 0 24px rgba(0,200,255,0.6)"}}>
        FOREX ROBOT
      </div>
      <div style={{fontSize:12,color:"#60e8cc",letterSpacing:4,marginTop:6,fontWeight:600}}>
        ◆ SIGNAL BOT ◆
      </div>
    </div>
    {children}
  </div>
);

// ─────────────────────────────────────────────────────
//  MAIN APP
// ─────────────────────────────────────────────────────
export default function App() {
  const [screen,       setScreen]       = useState("login");
  // ── localStorage د users persist ──
  const [users,        setUsers]        = useState(loadUsers);
  const [currentUser,  setCurrentUser]  = useState(null);
  const [signupForm,   setSignupForm]   = useState({email:"",password:"",confirm:""});
  const [loginForm,    setLoginForm]    = useState({email:"",password:""});
  const [licenseVal,   setLicenseVal]   = useState("");
  const [authErr,      setAuthErr]      = useState("");
  const [licenseErr,   setLicenseErr]   = useState("");
  const [signals,      setSignals]      = useState({});
  const [loading,      setLoading]      = useState(false);
  const [lastUpdated,  setLastUpdated]  = useState(null);
  const [profile,      setProfile]      = useState({name:"",photo:null});
  const [profileDraft, setProfileDraft] = useState({name:"",photo:null});
  const [changePw,     setChangePw]     = useState({current:"",next:"",confirm:""});
  const [pwErr,        setPwErr]        = useState("");
  const [pwOk,         setPwOk]         = useState("");

  const updateUsers = (newUsers) => { setUsers(newUsers); saveUsers(newUsers); };

  // ── Fetch — 1h candles, CapacitorHttp ─────────────
  const fetchSignals = useCallback(async () => {
    setLoading(true);
    const result = {};
    for(const sym of SYMBOLS){
      try{
        const url=`${BINANCE_BASE}/api/v3/klines?symbol=${sym.binanceSymbol}&interval=1h&limit=300`;
        const headers=BINANCE_API_KEY?{"X-MBX-APIKEY":BINANCE_API_KEY}:{};
        const res=await CapacitorHttp.get({url,headers,responseType:"json"});
        const data=res.data;
        if(!Array.isArray(data)||data.length<210)throw new Error("no data");
        const candles=data.map(k=>({
          open:parseFloat(k[1]),high:parseFloat(k[2]),
          low:parseFloat(k[3]),close:parseFloat(k[4]),
          volume:parseFloat(k[5]),
        }));
        result[sym.label]=generateSignal(candles)||{noData:true,reason:"Signals not aligned"};
      }catch(e){
        result[sym.label]={noData:true,reason:"Fetch failed"};
      }
    }
    setSignals(result);
    setLastUpdated(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}));
    setLoading(false);
  },[]);

  useEffect(()=>{
    if(screen==="home"){
      fetchSignals();
      const t=setInterval(fetchSignals,60000);
      return()=>clearInterval(t);
    }
  },[screen,fetchSignals]);

  const fmt=(v,d=2)=>v==null?"—":v.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});

  // ── SIGN UP ───────────────────────────────────────
  if(screen==="signup"){
    const go=()=>{
      if(!signupForm.email||!signupForm.password)return setAuthErr("Please fill all fields.");
      if(signupForm.password!==signupForm.confirm)return setAuthErr("Passwords do not match.");
      if(users.find(u=>u.email===signupForm.email))return setAuthErr("Email already registered.");
      const newUsers=[...users,{email:signupForm.email,password:signupForm.password}];
      updateUsers(newUsers);
      setAuthErr(""); setSignupForm({email:"",password:"",confirm:""}); setScreen("login");
    };
    return(
      <AuthWrap>
        <div style={{width:"100%",maxWidth:360,...S.card}}>
          <div style={{color:"#3de8ff",fontWeight:800,fontSize:17,textAlign:"center",letterSpacing:1,marginBottom:20}}>CREATE ACCOUNT</div>
          {authErr&&<div style={S.err}>{authErr}</div>}
          <input placeholder="Email" value={signupForm.email} onChange={e=>setSignupForm(p=>({...p,email:e.target.value}))} style={S.inp}/>
          <input type="password" placeholder="Password" value={signupForm.password} onChange={e=>setSignupForm(p=>({...p,password:e.target.value}))} style={S.inp}/>
          <input type="password" placeholder="Confirm Password" value={signupForm.confirm} onChange={e=>setSignupForm(p=>({...p,confirm:e.target.value}))} style={S.inp}/>
          <button onClick={go} style={S.btn}>SIGN UP</button>
          <div style={{textAlign:"center",marginTop:16,color:"#4a7080",fontSize:13}}>
            Already have an account?{" "}
            <span onClick={()=>{setAuthErr("");setScreen("login");}} style={{color:"#3de8ff",cursor:"pointer",fontWeight:700}}>Login</span>
          </div>
        </div>
      </AuthWrap>
    );
  }

  // ── LOGIN ─────────────────────────────────────────
  if(screen==="login"){
    const go=()=>{
      if(!loginForm.email||!loginForm.password)return setAuthErr("Please fill all fields.");
      // تازه users له localStorage نه لوست
      const freshUsers=loadUsers();
      const u=freshUsers.find(u=>u.email===loginForm.email&&u.password===loginForm.password);
      if(!u)return setAuthErr("Invalid email or password.");
      setCurrentUser(u); setAuthErr(""); setScreen("license");
    };
    return(
      <AuthWrap>
        <div style={{width:"100%",maxWidth:360,...S.card}}>
          <div style={{color:"#3de8ff",fontWeight:800,fontSize:17,textAlign:"center",letterSpacing:1,marginBottom:20}}>LOGIN</div>
          {authErr&&<div style={S.err}>{authErr}</div>}
          <input placeholder="Email" value={loginForm.email} onChange={e=>setLoginForm(p=>({...p,email:e.target.value}))} style={S.inp}/>
          <input type="password" placeholder="Password" value={loginForm.password} onChange={e=>setLoginForm(p=>({...p,password:e.target.value}))} style={S.inp}/>
          <button onClick={go} style={S.btn}>LOGIN</button>
          <div style={{textAlign:"center",marginTop:16,color:"#4a7080",fontSize:13}}>
            No account?{" "}
            <span onClick={()=>{setAuthErr("");setScreen("signup");}} style={{color:"#3de8ff",cursor:"pointer",fontWeight:700}}>Sign Up</span>
          </div>
        </div>
      </AuthWrap>
    );
  }

  // ── LICENSE ───────────────────────────────────────
  if(screen==="license"){
    const go=()=>{
      if(licenseVal===LICENSE_KEY){setLicenseErr("");setScreen("home");}
      else setLicenseErr("Invalid License Key. Access denied.");
    };
    return(
      <AuthWrap>
        <div style={{width:"100%",maxWidth:360,...S.card}}>
          {/* Back Button → Login */}
          <button onClick={()=>{setLicenseErr("");setLicenseVal("");setScreen("login");}}
            style={{background:"none",border:"none",color:"#3de8ff",fontSize:13,cursor:"pointer",marginBottom:12,display:"flex",alignItems:"center",gap:6,padding:0}}>
            ← Back to Login
          </button>
          <div style={{color:"#3de8ff",fontWeight:800,fontSize:17,textAlign:"center",letterSpacing:1,marginBottom:4}}>LICENSE KEY</div>
          <div style={{color:"#4a8090",fontSize:13,textAlign:"center",marginBottom:20}}>Enter your license key to access Signal Bot</div>
          {licenseErr&&<div style={S.err}>{licenseErr}</div>}
          <input placeholder="Enter License Key" value={licenseVal}
            onChange={e=>setLicenseVal(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&go()}
            style={{...S.inp,letterSpacing:2,fontFamily:"monospace"}}/>
          <button onClick={go} style={S.btn}>ACTIVATE</button>
        </div>
      </AuthWrap>
    );
  }

  // ── PROFILE ───────────────────────────────────────
  if(screen==="profile"){
    const save=()=>{setProfile({...profileDraft});alert("Profile saved!");};
    const chpw=()=>{
      setPwErr("");setPwOk("");
      if(changePw.current!==currentUser.password)return setPwErr("Current password incorrect.");
      if(changePw.next.length<4)return setPwErr("New password too short.");
      if(changePw.next!==changePw.confirm)return setPwErr("Passwords do not match.");
      const updated=users.map(u=>u.email===currentUser.email?{...u,password:changePw.next}:u);
      updateUsers(updated);
      setCurrentUser({...currentUser,password:changePw.next});
      setChangePw({current:"",next:"",confirm:""}); setPwOk("Password changed successfully.");
    };
    const logout=()=>{
      setCurrentUser(null);setLicenseVal("");setLoginForm({email:"",password:""});setScreen("login");
    };
    return(
      <div style={{minHeight:"100vh",background:"radial-gradient(ellipse at 30% 20%,#071828,#030d16)",fontFamily:"'Segoe UI',system-ui,sans-serif",color:"#e0f0ff"}}>
        <div style={{background:"#071828",padding:"14px 18px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid rgba(0,200,255,0.15)"}}>
          <button onClick={()=>setScreen("home")} style={{background:"none",border:"none",color:"#3de8ff",fontSize:22,cursor:"pointer"}}>←</button>
          <span style={{color:"#3de8ff",fontWeight:800,fontSize:16,letterSpacing:1}}>PROFILE</span>
        </div>
        <div style={{padding:"20px 16px 60px"}}>
          <div style={{textAlign:"center",marginBottom:24}}>
            <div style={{width:90,height:90,borderRadius:"50%",border:"3px solid #00c8ff",margin:"0 auto 12px",overflow:"hidden",background:"#071828",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {profileDraft.photo?<img src={profileDraft.photo} alt="P" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span style={{fontSize:40,color:"#00c8ff"}}>👤</span>}
            </div>
            <label style={{display:"inline-block",padding:"8px 18px",background:"rgba(0,200,255,0.08)",border:"1px solid rgba(0,200,255,0.2)",borderRadius:8,color:"#3de8ff",fontSize:12,fontWeight:700,cursor:"pointer"}}>
              UPLOAD PHOTO
              <input type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>setProfileDraft(p=>({...p,photo:ev.target.result}));r.readAsDataURL(f);}}/>
            </label>
          </div>
          <div style={S.card}>
            <span style={S.lbl}>FULL NAME</span>
            <input placeholder="Enter your name" value={profileDraft.name} onChange={e=>setProfileDraft(p=>({...p,name:e.target.value}))} style={S.inp}/>
            <button onClick={save} style={S.btn}>SAVE PROFILE</button>
          </div>
          <div style={S.card}>
            <span style={S.lbl}>CHANGE PASSWORD</span>
            {pwErr&&<div style={S.err}>{pwErr}</div>}
            {pwOk&&<div style={S.ok}>{pwOk}</div>}
            <input type="password" placeholder="Current Password" value={changePw.current} onChange={e=>setChangePw(p=>({...p,current:e.target.value}))} style={S.inp}/>
            <input type="password" placeholder="New Password"     value={changePw.next}    onChange={e=>setChangePw(p=>({...p,next:e.target.value}))}    style={S.inp}/>
            <input type="password" placeholder="Confirm New"      value={changePw.confirm}  onChange={e=>setChangePw(p=>({...p,confirm:e.target.value}))} style={S.inp}/>
            <button onClick={chpw} style={S.btn}>CHANGE PASSWORD</button>
          </div>
          <button onClick={logout} style={S.btnRed}>🚪 LOG OUT</button>
        </div>
      </div>
    );
  }

  // ── HOME ──────────────────────────────────────────
  return(
    <div style={{minHeight:"100vh",background:"radial-gradient(ellipse at 20% 10%,#071828,#030c14)",fontFamily:"'Segoe UI',system-ui,sans-serif",color:"#e0f0ff"}}>
      {/* Header */}
      <div style={{background:"#07182a",padding:"12px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(0,200,255,0.15)",position:"sticky",top:0,zIndex:10}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          {/* Back Button → License */}
          <button onClick={()=>setScreen("license")}
            style={{background:"none",border:"none",color:"#3de8ff",fontSize:20,cursor:"pointer",padding:"0 6px 0 0"}}>
            ←
          </button>
          <RobotIcon size={42}/>
          <div>
            <div style={{fontSize:17,fontWeight:900,color:"#3de8ff",letterSpacing:1.5,lineHeight:1.2}}>FOREX ROBOT</div>
            {/* روښانه متن — brighter text */}
            <div style={{fontSize:9,color:"#7ecce0",lineHeight:1.4}}>Build Forex Robot Signal Bot By Amin Agha Hamidi in 07/10/2026</div>
            <div style={{fontSize:11,color:"#00ffcc",fontWeight:700}}>● Signal Bot</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{background:"rgba(0,255,80,0.1)",border:"1px solid rgba(0,255,80,0.4)",borderRadius:20,padding:"4px 10px",fontSize:11,color:"#00ff64",fontWeight:800}}>● LIVE</div>
          <button onClick={()=>{setProfileDraft({...profile});setScreen("profile");}}
            style={{width:36,height:36,borderRadius:"50%",background:"rgba(0,200,255,0.08)",border:"1px solid rgba(0,200,255,0.25)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}}>
            {profile.photo?<img src={profile.photo} style={{width:36,height:36,objectFit:"cover"}} alt="P"/>:<span style={{fontSize:18}}>👤</span>}
          </button>
        </div>
      </div>

      {/* Signal Cards */}
      <div style={{padding:"12px 12px 100px"}}>
        {SYMBOLS.map(sym=>{
          const sig=signals[sym.label];
          const noData=!sig||sig.noData;
          const neutral=sig&&!sig.noData&&sig.direction==="NEUTRAL";
          const isBuy=sig&&!sig.noData&&sig.direction==="BUY";
          const isSell=sig&&!sig.noData&&sig.direction==="SELL";
          return(
            <div key={sym.label} style={{background:"linear-gradient(160deg,#0d1e32,#08131e)",border:"1px solid rgba(0,200,255,0.15)",borderRadius:16,padding:16,marginBottom:14,boxShadow:"0 4px 24px rgba(0,0,0,0.35)"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                <span style={{fontSize:20}}>{sym.emoji}</span>
                <span style={{color:"#3de8ff",fontWeight:800,fontSize:15}}>{sym.label}</span>
                <span style={{color:"#2a4050"}}>—</span>
                <span style={{color:"#9ac8e0",fontSize:13}}>{sym.name}</span>
              </div>
              {noData&&(
                <div style={{background:"rgba(255,170,0,0.06)",border:"1px solid rgba(255,170,0,0.2)",borderRadius:10,padding:"14px",textAlign:"center",color:"#ffa726",fontSize:13,marginBottom:10}}>
                  ⚠ {sig?.reason||"Loading…"}
                </div>
              )}
              {neutral&&(
                <div style={{background:"rgba(80,120,200,0.07)",border:"1px solid rgba(80,120,200,0.2)",borderRadius:10,padding:"14px",textAlign:"center",color:"#7090d0",fontSize:14,marginBottom:10}}>
                  ⏳ WAIT — Signals not aligned
                </div>
              )}
              {(isBuy||isSell)&&(
                <>
                  <div style={{background:isBuy?"linear-gradient(135deg,#0a3d1e,#0d5228)":"linear-gradient(135deg,#3d0a0e,#521010)",border:`2px solid ${isBuy?"#00c853":"#f44336"}`,borderRadius:12,padding:"16px",textAlign:"center",marginBottom:14}}>
                    <div style={{fontSize:24,fontWeight:900,color:isBuy?"#00e676":"#ff5252",letterSpacing:5,display:"flex",alignItems:"center",justifyContent:"center",gap:12}}>
                      <span>{isBuy?"▲":"▼"}</span><span>{sig.direction}</span>
                    </div>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{color:"#f59e0b",fontSize:13}}>📍 Entry:</span>
                      <span style={{color:"#fff",fontWeight:700,fontSize:14,fontFamily:"monospace"}}>{fmt(sig.entry,sym.decimals)}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{color:"#f44336",fontSize:13}}>🔴 Stop Loss (1.0×ATR):</span>
                      <span style={{color:"#ff6b6b",fontWeight:700,fontSize:14,fontFamily:"monospace"}}>{fmt(sig.stopLoss,sym.decimals)}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{color:"#00c853",fontSize:13}}>🟢 Take Profit (1.4×ATR):</span>
                      <span style={{color:"#69f0ae",fontWeight:700,fontSize:14,fontFamily:"monospace"}}>{fmt(sig.takeProfit,sym.decimals)}</span>
                    </div>
                  </div>
                  <div style={{borderTop:"1px solid rgba(0,200,255,0.1)",paddingTop:10,fontSize:11,color:"#4a6878",display:"flex",gap:12,flexWrap:"wrap"}}>
                    {sig.macd!=null&&<span>MACD: {sig.macd.toFixed(4)}</span>}
                    {sig.signal!=null&&<span>Signal: {sig.signal.toFixed(4)}</span>}
                    {sig.rsi!=null&&<span>RSI: {sig.rsi.toFixed(1)}</span>}
                    {sig.atr!=null&&<span>ATR: {sig.atr.toFixed(sym.decimals)}</span>}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {lastUpdated&&(
        <div style={{position:"fixed",bottom:76,left:0,right:0,textAlign:"center",color:"#3a5a68",fontSize:11}}>
          ✅ Updated at {lastUpdated}
        </div>
      )}

      {/* Refresh Button */}
      <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"10px 14px 16px",background:"#060e18",borderTop:"1px solid rgba(0,200,255,0.12)"}}>
        <button onClick={fetchSignals} disabled={loading} style={{width:"100%",padding:"16px",background:loading?"#2a3a3a":"linear-gradient(90deg,#f9a825,#e65100)",border:"none",borderRadius:12,color:loading?"#666":"#000",fontWeight:900,fontSize:15,cursor:loading?"not-allowed":"pointer",letterSpacing:1.5,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <span style={{fontSize:18}}>{loading?"⟳":"🔄"}</span>
          {loading?"LOADING…":"REFRESH SIGNALS"}
        </button>
      </div>
    </div>
  );
}
