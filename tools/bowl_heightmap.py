import bpy, sys, mathutils, json, math
import numpy as np
outdir=sys.argv[-1]
picks={'6.1':'toilet_01','1.1':'toilet_02','12.1':'toilet_03','16.1':'toilet_04','18.1':'toilet_05'}
res={}
for name,fn in picks.items():
    o=bpy.data.objects[name]
    mw=o.matrix_world.copy()
    bb=[mathutils.Vector(v) for v in o.bound_box]
    mn=mathutils.Vector((min(v.x for v in bb),min(v.y for v in bb),min(v.z for v in bb)))
    mx=mathutils.Vector((max(v.x for v in bb),max(v.y for v in bb),max(v.z for v in bb)))
    step=0.02
    xs=np.arange(mn.x,mx.x,step); ys=np.arange(mn.y,mx.y,step)
    H=np.full((len(ys),len(xs)),np.nan)
    for j,y in enumerate(ys):
        for i,x in enumerate(xs):
            ok,loc,nrm,idx=o.ray_cast(mathutils.Vector((x,y,mx.z+1)),mathutils.Vector((0,0,-1)))
            if ok: H[j,i]=loc.z
    np.save(f"{outdir}/{fn}_H.npy",H)
    res[fn]=dict(src=name,mn=list(mn),mx=list(mx),step=step,nx=len(xs),ny=len(ys))
json.dump(res,open(f"{outdir}/hm.json","w"),indent=1)
print("DONE")
