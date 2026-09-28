#!/usr/bin/env python3
"""Generates public/mannequin.gltf — an articulated artist mannequin.

Design notes
------------
* Rest pose is a T-pose, character faces +z, +x is the character's left.
* Every joint node has identity rotation; only translations encode the rig.
  (This keeps IK maths simple: bone axis = child local translation.)
* Limb geometries are baked at real size with node scale = 1, so vertex-space
  outline offsets stay uniform.
"""
import base64
import json
import math
import os
import struct

# ---------------------------------------------------------------- geometry --


def _rows_sphere(radius, radial, cap_seg, cyl_h):
    """List of rings [(pos, normal)] from bottom pole to top pole."""
    rows = []
    cy_b = -cyl_h / 2.0
    # bottom cap: theta -90deg .. 0deg
    for i in range(cap_seg + 1):
        th = -math.pi / 2 + (i / cap_seg) * (math.pi / 2)
        y = cy_b + radius * math.sin(th)
        rr = radius * math.cos(th)
        row = []
        for j in range(radial):
            ph = 2 * math.pi * j / radial
            n = (math.cos(th) * math.cos(ph), math.sin(th), math.cos(th) * math.sin(ph))
            row.append(((rr * math.cos(ph), y, rr * math.sin(ph)), n))
        rows.append(row)
    # top cap: theta 0deg .. 90deg (skip theta==0 duplicate for a pure sphere)
    start = 1 if cyl_h == 0 else 0
    for i in range(start, cap_seg + 1):
        th = (i / cap_seg) * (math.pi / 2)
        y = (cyl_h / 2.0) + radius * math.sin(th)
        rr = radius * math.cos(th)
        row = []
        for j in range(radial):
            ph = 2 * math.pi * j / radial
            n = (math.cos(th) * math.cos(ph), math.sin(th), math.cos(th) * math.sin(ph))
            row.append(((rr * math.cos(ph), y, rr * math.sin(ph)), n))
        rows.append(row)
    return rows


def _stitch(rows, radial):
    verts, norms, idx = [], [], []
    base = []
    for row in rows:
        base.append(len(verts))
        for p, n in row:
            verts.append(p)
            norms.append(n)
    for r in range(len(rows) - 1):
        a0, b0 = base[r], base[r + 1]
        for j in range(radial):
            jn = (j + 1) % radial
            a, b, c, d = a0 + j, a0 + jn, b0 + j, b0 + jn
            idx.extend([a, c, b, b, c, d])
    return verts, norms, idx


def _fix_winding(verts, idx, radial):
    """Make sure triangles face outward (away from the local axis)."""
    dot = 0.0
    checked = 0
    for t in range(0, min(len(idx), 60), 3):
        ia, ib, ic = idx[t], idx[t + 1], idx[t + 2]
        ax, ay, az = verts[ia]
        bx, by, bz = verts[ib]
        cx, cy, cz = verts[ic]
        # face normal
        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx - ax, cy - ay, cz - az
        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        # outward reference: away from the shape axis (x=z=0) at this height
        d = nx * ax + nz * az
        if abs(d) > 1e-12:
            dot += d
            checked += 1
    if checked and dot < 0:
        # swap 2nd/3rd of every triangle
        out = []
        for t in range(0, len(idx), 3):
            out.extend([idx[t], idx[t + 2], idx[t + 1]])
        idx = out
    return idx


def capsule(radius, cyl_h, radial=16, cap_seg=6, axis="y"):
    rows = _rows_sphere(radius, radial, cap_seg, cyl_h)
    verts, norms, idx = _stitch(rows, radial)
    idx = _fix_winding(verts, idx, radial)
    if axis == "x":
        # rotate -90 deg around z: (x, y, z) -> (y, -x, z)   maps +Y -> +X
        verts = [(y, -x, z) for (x, y, z) in verts]
        norms = [(ny, -nx, nz) for (nx, ny, nz) in norms]
    return verts, norms, idx


def sphere(radius, radial=16, cap_seg=8):
    return capsule(radius, 0.0, radial, cap_seg)


def ellipsoid(rx, ry, rz, radial=16, cap_seg=8):
    verts, norms, idx = capsule(1.0, 0.0, radial, cap_seg)
    verts = [(x * rx, y * ry, z * rz) for (x, y, z) in verts]
    norms = []
    for (x, y, z) in verts:
        nx, ny, nz = x / (rx * rx), y / (ry * ry), z / (rz * rz)
        l = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        norms.append((nx / l, ny / l, nz / l))
    return verts, norms, idx


def box(sx, sy, sz):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    faces = [
        # (normal, 4 corners CCW seen from outside)
        ((0, 0, 1),  [(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]),
        ((0, 0, -1), [(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)]),
        ((1, 0, 0),  [(hx, -hy, hz), (hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz)]),
        ((-1, 0, 0), [(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz)]),
        ((0, 1, 0),  [(-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz), (-hx, hy, -hz)]),
        ((0, -1, 0), [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz)]),
    ]
    verts, norms, idx = [], [], []
    for n, corners in faces:
        b = len(verts)
        for c in corners:
            verts.append(c)
            norms.append(n)
        idx.extend([b, b + 1, b + 2, b, b + 2, b + 3])
    return verts, norms, idx


# ------------------------------------------------------------------ layout --

WORLD_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(WORLD_ROOT, "public", "mannequin.gltf")

geometries = {}
geom_order = []


def add_geom(name, data):
    if name not in geometries:
        geometries[name] = data
        geom_order.append(name)
    return geom_order.index(name)


# limb / body parts ----------------------------------------------------------
G_UPARM = add_geom("uparm", capsule(0.045, 0.16, axis="x"))
G_FOREARM = add_geom("forearm", capsule(0.038, 0.15, axis="x"))
G_HAND = add_geom("hand", box(0.09, 0.07, 0.03))
G_THIGH = add_geom("thigh", capsule(0.07, 0.26))
G_CALF = add_geom("calf", capsule(0.055, 0.26))
G_FOOT = add_geom("foot", box(0.085, 0.075, 0.21))
G_CHEST = add_geom("chest", capsule(0.12, 0.14))
G_WAIST = add_geom("waist", sphere(0.095))
G_PELVIS = add_geom("pelvis", ellipsoid(0.145, 0.105, 0.105))
G_NECK = add_geom("neck", capsule(0.035, 0.06))
G_HEAD = add_geom("head", ellipsoid(0.095, 0.12, 0.105))
G_NOSE = add_geom("nose", sphere(0.022, 10, 5))
G_BALL_SH = add_geom("ball_sh", sphere(0.052))
G_BALL_EL = add_geom("ball_el", sphere(0.046))
G_BALL_WR = add_geom("ball_wr", sphere(0.032))
G_BALL_HIP = add_geom("ball_hip", sphere(0.075))
G_BALL_KN = add_geom("ball_kn", sphere(0.06))
G_BALL_AN = add_geom("ball_an", sphere(0.046))

WOOD, DARK = 0, 1

# node table -----------------------------------------------------------------
nodes = []


def N(**kw):
    nodes.append(kw)
    return len(nodes) - 1


def joint(name, translation, children):
    return N(name=name, translation=translation, children=children)


# add_geom above already stored geometry data; mesh() helper needs the index:
def mnode(name, gname, translation, material):
    gidx = geom_order.index(gname)
    return N(name=name, translation=translation, mesh=gidx, material=material)


# We assign material per primitive instead of per node -> build mesh list from
# geom_order with fixed materials:
MATERIAL_OF = {
    "uparm": WOOD, "forearm": WOOD, "hand": WOOD, "thigh": WOOD, "calf": WOOD,
    "foot": WOOD, "chest": WOOD, "waist": WOOD, "pelvis": WOOD, "neck": WOOD,
    "head": WOOD, "nose": DARK,
    "ball_sh": DARK, "ball_el": DARK, "ball_wr": DARK, "ball_hip": DARK,
    "ball_kn": DARK, "ball_an": DARK,
}

# --- leaves (created before joints so children indices exist) ----------------
# arms L
uparm_l = mnode("UpperArmMeshL", "uparm", [0.135, 0, 0], WOOD)
ball_sh_l = mnode("BallShoulderL", "ball_sh", [0, 0, 0], DARK)
forearm_l = mnode("ForearmMeshL", "forearm", [0.12, 0, 0], WOOD)
ball_el_l = mnode("BallElbowL", "ball_el", [0, 0, 0], DARK)
hand_l = mnode("HandMeshL", "hand", [0.045, 0, 0], WOOD)
ball_wr_l = mnode("BallWristL", "ball_wr", [0, 0, 0], DARK)
# arms R
uparm_r = mnode("UpperArmMeshR", "uparm", [-0.135, 0, 0], WOOD)
ball_sh_r = mnode("BallShoulderR", "ball_sh", [0, 0, 0], DARK)
forearm_r = mnode("ForearmMeshR", "forearm", [-0.12, 0, 0], WOOD)
ball_el_r = mnode("BallElbowR", "ball_el", [0, 0, 0], DARK)
hand_r = mnode("HandMeshR", "hand", [-0.045, 0, 0], WOOD)
ball_wr_r = mnode("BallWristR", "ball_wr", [0, 0, 0], DARK)
# legs L
thigh_l = mnode("ThighMeshL", "thigh", [0, -0.21, 0], WOOD)
ball_hip_l = mnode("BallHipL", "ball_hip", [0, 0, 0], DARK)
calf_l = mnode("CalfMeshL", "calf", [0, -0.19, 0], WOOD)
ball_kn_l = mnode("BallKneeL", "ball_kn", [0, 0, 0], DARK)
foot_l = mnode("FootMeshL", "foot", [0, -0.06, 0.045], WOOD)
ball_an_l = mnode("BallAnkleL", "ball_an", [0, 0, 0], DARK)
# legs R
thigh_r = mnode("ThighMeshR", "thigh", [0, -0.21, 0], WOOD)
ball_hip_r = mnode("BallHipR", "ball_hip", [0, 0, 0], DARK)
calf_r = mnode("CalfMeshR", "calf", [0, -0.19, 0], WOOD)
ball_kn_r = mnode("BallKneeR", "ball_kn", [0, 0, 0], DARK)
foot_r = mnode("FootMeshR", "foot", [0, -0.06, 0.045], WOOD)
ball_an_r = mnode("BallAnkleR", "ball_an", [0, 0, 0], DARK)
# body
pelvis_m = mnode("PelvisMesh", "pelvis", [0, -0.03, 0], WOOD)
waist_m = mnode("WaistMesh", "waist", [0, 0.05, 0], WOOD)
chest_m = mnode("ChestMesh", "chest", [0, 0, 0], WOOD)
neck_m = mnode("NeckMesh", "neck", [0, 0.02, 0], WOOD)
head_m = mnode("HeadMesh", "head", [0, 0.11, 0], WOOD)
nose_m = mnode("NoseMesh", "nose", [0, 0.10, 0.092], DARK)

# --- joints ------------------------------------------------------------------
foot_l_j = joint("FootL", [0, -0.40, 0], [foot_l, ball_an_l])
lower_l = joint("LowerLegL", [0, -0.42, 0], [calf_l, ball_kn_l, foot_l_j])
upper_l = joint("UpperLegL", [0.09, -0.02, 0], [thigh_l, ball_hip_l, lower_l])
foot_r_j = joint("FootR", [0, -0.40, 0], [foot_r, ball_an_r])
lower_r = joint("LowerLegR", [0, -0.42, 0], [calf_r, ball_kn_r, foot_r_j])
upper_r = joint("UpperLegR", [-0.09, -0.02, 0], [thigh_r, ball_hip_r, lower_r])

hand_l_j = joint("HandL", [0.24, 0, 0], [hand_l, ball_wr_l])
forearm_l_j = joint("ForearmL", [0.27, 0, 0], [forearm_l, ball_el_l, hand_l_j])
upperarm_l_j = joint("UpperArmL", [0.17, 0.13, 0], [uparm_l, ball_sh_l, forearm_l_j])

hand_r_j = joint("HandR", [-0.24, 0, 0], [hand_r, ball_wr_r])
forearm_r_j = joint("ForearmR", [-0.27, 0, 0], [forearm_r, ball_el_r, hand_r_j])
upperarm_r_j = joint("UpperArmR", [-0.17, 0.13, 0], [uparm_r, ball_sh_r, forearm_r_j])

head_j = joint("Head", [0, 0.06, 0], [head_m, nose_m])
neck_j = joint("Neck", [0, 0.17, 0], [neck_m, head_j])
chest_j = joint("Chest", [0, 0.15, 0], [chest_m, neck_j, upperarm_l_j, upperarm_r_j])
spine_j = joint("Spine", [0, 0.10, 0], [waist_m, chest_j])
hips_j = joint("Hips", [0, 0.94, 0], [pelvis_m, spine_j, upper_l, upper_r])
root_j = joint("Root", [0, 0, 0], [hips_j])

# ---------------------------------------------------------------- gltf ------

blob = bytearray()


def align4():
    while len(blob) % 4:
        blob.append(0)


accessors = []
buffer_views = []


def push_view(data_bytes, target):
    align4()
    off = len(blob)
    blob.extend(data_bytes)
    buffer_views.append({
        "buffer": 0,
        "byteOffset": off,
        "byteLength": len(data_bytes),
        **({"target": target} if target else {}),
    })
    return len(buffer_views) - 1


meshes = []
for gname in geom_order:
    verts, norms, idx = geometries[gname]
    # stored tuple is (verts, norms, idx) — see add_geom call sites
    pos_b = b"".join(struct.pack("<3f", *v) for v in verts)
    nrm_b = b"".join(struct.pack("<3f", *n) for n in norms)
    idx_b = b"".join(struct.pack("<H", i) for i in idx)
    pv = push_view(pos_b, 34962)
    nv = push_view(nrm_b, 34962)
    iv = push_view(idx_b, 34963)
    xs = [v[0] for v in verts]
    ys = [v[1] for v in verts]
    zs = [v[2] for v in verts]
    acc_p = len(accessors)
    accessors.append({
        "bufferView": pv, "componentType": 5126, "count": len(verts),
        "type": "VEC3", "min": [min(xs), min(ys), min(zs)],
        "max": [max(xs), max(ys), max(zs)],
    })
    acc_n = len(accessors)
    accessors.append({
        "bufferView": nv, "componentType": 5126, "count": len(norms),
        "type": "VEC3",
    })
    acc_i = len(accessors)
    accessors.append({
        "bufferView": iv, "componentType": 5123, "count": len(idx),
        "type": "SCALAR",
    })
    meshes.append({
        "name": gname,
        "primitives": [{
            "attributes": {"POSITION": acc_p, "NORMAL": acc_n},
            "indices": acc_i,
            "material": MATERIAL_OF[gname],
        }],
    })

# nodes: our table stores per-node 'mesh' = geometry index, but glTF wants a
# mesh-table index. Both tables were built in the same order (geom_order), and
# a mesh entry was appended per geometry in the same loop above -> indexes match.
gltf = {
    "asset": {"version": "2.0", "generator": "pose-tool gen_gltf.py"},
    "scene": 0,
    "scenes": [{"name": "Scene", "nodes": [root_j]}],
    "nodes": [
        {k: v for k, v in n.items()} for n in nodes
    ],
    "meshes": meshes,
    "materials": [
        {
            "name": "Wood",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.878, 0.71, 0.53, 1.0],
                "roughnessFactor": 0.62,
                "metallicFactor": 0.0,
            },
        },
        {
            "name": "WoodDark",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.545, 0.392, 0.259, 1.0],
                "roughnessFactor": 0.5,
                "metallicFactor": 0.0,
            },
        },
    ],
    "accessors": accessors,
    "bufferViews": buffer_views,
    "buffers": [{
        "byteLength": len(blob),
        "uri": "data:application/octet-stream;base64," +
               base64.b64encode(bytes(blob)).decode("ascii"),
    }],
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(gltf, f, separators=(",", ":"))

n_joints = sum(1 for n in nodes if n.get("name") and "Mesh" not in n["name"]
               and "Ball" not in n["name"])
print(f"wrote {OUT}  ({os.path.getsize(OUT)/1024:.1f} KB)")
print(f"nodes={len(nodes)} meshes={len(meshes)} joint-ish={n_joints}")
