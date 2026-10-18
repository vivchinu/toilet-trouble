import numpy as np, json, sys, math
d=sys.argv[-1]; meta=json.load(open(f"{d}/hm.json"))
seeds={'toilet_01':(0,-0.12),'toilet_02':(0,0),'toilet_03':(0,-0.15),'toilet_04':(0,-0.1),'toilet_05':(0,-0.1)}
out={}
for fn,m in meta.items():
    H=np.load(f"{d}/{fn}_H.npy"); s=m['step']; mn=m['mn']
    sx,sy=seeds[fn]; i0=int(round((sx-mn[0])/s)); j0=int(round((sy-mn[1])/s))
    maxes=[]
    for a in np.linspace(0,2*math.pi,24,endpoint=False):
        best=-1
        for r in np.arange(0,0.45,s/2):
            i=int(round(i0+math.cos(a)*r/s)); j=int(round(j0+math.sin(a)*r/s))
            if not(0<=i<H.shape[1] and 0<=j<H.shape[0]) or np.isnan(H[j,i]): break
            best=max(best,H[j,i])
        maxes.append(best)
    rim=float(np.percentile(maxes,30))
    thr=rim-0.03
    seen=np.zeros(H.shape,bool); st=[(j0,i0)]; cells=[]
    while st:
        j,i=st.pop()
        if not(0<=i<H.shape[1] and 0<=j<H.shape[0]) or seen[j,i]: continue
        seen[j,i]=True
        if np.isnan(H[j,i]) or H[j,i]>thr: continue
        cells.append((mn[0]+i*s,mn[1]+j*s,H[j,i])); st+= [(j+1,i),(j-1,i),(j,i+1),(j,i-1)]
    c=np.array(cells); cx,cy=c[:,0].mean(),c[:,1].mean()
    hx=(c[:,0].max()-c[:,0].min())/2; hy=(c[:,1].max()-c[:,1].min())/2
    out[fn]=dict(cx=round(cx,3),cy=round(cy,3),hx=round(hx,3),hy=round(hy,3),rim=round(rim,3),bottom=round(float(c[:,2].min()),3),cells=len(c),height=round(m['mx'][2],3),
                 bboxLocal=[round(v,3) for v in m['mn']+m['mx']])
    print(fn,out[fn])
json.dump(out,open(f"{d}/bowls.json","w"),indent=1)
