import bpy, sys, mathutils
out, thumbs = sys.argv[-2:]
picks={'6.1':'toilet_01','1.1':'toilet_02','12.1':'toilet_03','16.1':'toilet_04','18.1':'toilet_05'}
sc=bpy.context.scene
objs=[o for o in bpy.data.objects if o.type=='MESH']
cam_data=bpy.data.cameras.new('C'); cam=bpy.data.objects.new('C',cam_data); sc.collection.objects.link(cam); sc.camera=cam
light=bpy.data.lights.new('L','SUN'); light.energy=3; lo=bpy.data.objects.new('L',light); sc.collection.objects.link(lo); lo.rotation_euler=(0.6,0.2,0.4)
sc.render.engine='BLENDER_EEVEE'; sc.render.film_transparent=True
sc.render.resolution_x=sc.render.resolution_y=256
for name,fn in picks.items():
    o=bpy.data.objects[name]
    print("DELTA",name,tuple(o.delta_rotation_euler),tuple(o.delta_location),tuple(o.delta_scale),o.parent)
    o.parent=None; o.location=(0,0,0); o.rotation_euler=(0,0,0); o.scale=(1,1,1)
    o.delta_location=(0,0,0); o.delta_rotation_euler=(0,0,0); o.delta_rotation_quaternion=(1,0,0,0); o.delta_scale=(1,1,1)
    o.rotation_mode="XYZ"; o.rotation_quaternion=(1,0,0,0); o.rotation_euler=(0,0,0); bpy.context.view_layer.update(); o.matrix_world=mathutils.Matrix.Identity(4)
    o.name=fn
    for p in objs: p.hide_render=(p!=o); p.hide_set(p!=o); p.select_set(p==o)
    bpy.context.view_layer.objects.active=o
    bpy.context.view_layer.update()
    print("WORLD",fn,[round(x,3) for x in o.matrix_world.to_translation()],[round(x,3) for x in o.matrix_world.to_euler()])
    bpy.ops.export_scene.gltf(filepath=f"{out}/{fn}.glb",use_selection=True,export_format='GLB',export_apply=True,export_yup=True)
    ctr=mathutils.Vector((0,0,o.dimensions.z*0.45))
    d=mathutils.Vector((0.45,-1.0,0.65)).normalized()
    cam.location=ctr+d*max(o.dimensions)*2.4
    cam.rotation_euler=(ctr-cam.location).to_track_quat('-Z','Y').to_euler()
    sc.render.filepath=f"{thumbs}/{fn}.png"; bpy.ops.render.render(write_still=True)
