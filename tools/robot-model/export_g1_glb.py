#!/usr/bin/env python3
"""Convert the MuJoCo Menagerie Unitree G1 model into public/models/unitree-g1.glb.

The GLB keeps the MJCF body tree as a glTF node hierarchy, named exactly like
the MuJoCo bodies (`left_knee_link`, `right_hip_pitch_link`, ...), because the
ground-robots layer poses joints at runtime through `Cesium.Model#getNode(name)`
(src/data/robotPose.js). Baking the hierarchy flat would render a rigid statue.

Axis convention: MuJoCo is Z-up with +X forward; the emitted GLB is Y-up with
+Z forward, which is what Cesium's default glTF axis correction turns into
"model +X = heading direction" — i.e. the same convention as the aircraft GLBs,
with no heading offset. The conversion lives on the ROOT node only, so every
child transform (and therefore every runtime joint rotation) stays in native
MuJoCo axes.

Usage:
    python3 tools/robot-model/export_g1_glb.py \
        --xml ../mujoco_playground/mujoco_playground/_src/locomotion/g1/xmls/g1_mjx_feetonly.xml \
        --out public/models/unitree-g1.glb

Requires: mujoco, numpy, pygltflib, fast_simplification (optional, for decimation).
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import mujoco
import numpy as np

# MuJoCo visual geoms live in group 2 in both the Menagerie and the playground
# MJCFs; groups 3/4 are collision capsules/boxes and must not ship in the GLB.
VISUAL_GROUP = 2

# glTF constants.
FLOAT = 5126
UNSIGNED_INT = 5125
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


def mj_to_gltf_root_matrix() -> list[float]:
    """Column-major glTF node matrix mapping MuJoCo axes onto glTF axes.

    Sends MuJoCo +X (forward) to glTF −X, MuJoCo +Z (up) to glTF +Y, and MuJoCo
    +Y (left) to glTF +Z, which is the nose−X / +Y-up convention every other
    bundled model in `public/models/` already uses. The determinant is +1, so
    the mesh is rotated, never mirrored.
    """
    basis = np.array(
        [
            [-1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
        ]
    )
    matrix = np.eye(4)
    matrix[:3, :3] = basis
    return [float(v) for v in matrix.T.reshape(-1)]


def decimate(vertices: np.ndarray, faces: np.ndarray, ratio: float):
    """Reduce a mesh to `ratio` of its triangles; identity when unavailable."""
    if ratio >= 1.0 or len(faces) < 64:
        return vertices, faces
    try:
        import fast_simplification
    except ImportError:
        return vertices, faces
    out_v, out_f = fast_simplification.simplify(
        vertices.astype(np.float32), faces.astype(np.int32), 1.0 - ratio
    )
    if len(out_f) == 0:
        return vertices, faces
    return np.asarray(out_v, dtype=np.float32), np.asarray(out_f, dtype=np.uint32)


def face_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals (the STLs carry no shared-vertex normals)."""
    normals = np.zeros(vertices.shape, dtype=np.float64)
    tri = vertices[faces]
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    for i in range(3):
        np.add.at(normals, faces[:, i], cross)
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    lengths[lengths == 0] = 1.0
    return (normals / lengths).astype(np.float32)


class GlbBuilder:
    """Minimal single-buffer glTF 2.0 writer."""

    def __init__(self) -> None:
        self.blob = bytearray()
        self.buffer_views: list[dict] = []
        self.accessors: list[dict] = []
        self.meshes: list[dict] = []
        self.materials: list[dict] = []
        self.nodes: list[dict] = []

    def _view(self, data: bytes, target: int) -> int:
        while len(self.blob) % 4:
            self.blob.append(0)
        offset = len(self.blob)
        self.blob.extend(data)
        self.buffer_views.append(
            {"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": target}
        )
        return len(self.buffer_views) - 1

    def add_vec3(self, values: np.ndarray) -> int:
        data = np.ascontiguousarray(values, dtype=np.float32)
        view = self._view(data.tobytes(), ARRAY_BUFFER)
        self.accessors.append(
            {
                "bufferView": view,
                "componentType": FLOAT,
                "count": int(len(data)),
                "type": "VEC3",
                "min": [float(v) for v in data.min(axis=0)],
                "max": [float(v) for v in data.max(axis=0)],
            }
        )
        return len(self.accessors) - 1

    def add_indices(self, faces: np.ndarray) -> int:
        data = np.ascontiguousarray(faces.reshape(-1), dtype=np.uint32)
        view = self._view(data.tobytes(), ELEMENT_ARRAY_BUFFER)
        self.accessors.append(
            {
                "bufferView": view,
                "componentType": UNSIGNED_INT,
                "count": int(len(data)),
                "type": "SCALAR",
            }
        )
        return len(self.accessors) - 1

    def add_material(self, rgba, metallic: float, roughness: float, name: str) -> int:
        self.materials.append(
            {
                "name": name,
                "pbrMetallicRoughness": {
                    "baseColorFactor": [float(c) for c in rgba],
                    "metallicFactor": metallic,
                    "roughnessFactor": roughness,
                },
                "doubleSided": False,
            }
        )
        return len(self.materials) - 1

    def add_mesh(self, name: str, positions: int, normals: int, indices: int, material: int) -> int:
        self.meshes.append(
            {
                "name": name,
                "primitives": [
                    {
                        "attributes": {"POSITION": positions, "NORMAL": normals},
                        "indices": indices,
                        "material": material,
                        "mode": 4,
                    }
                ],
            }
        )
        return len(self.meshes) - 1

    def add_node(self, node: dict) -> int:
        self.nodes.append(node)
        return len(self.nodes) - 1

    def write(self, out_path: Path, root_nodes: list[int], generator: str) -> None:
        while len(self.blob) % 4:
            self.blob.append(0)
        gltf = {
            "asset": {"version": "2.0", "generator": generator},
            "scene": 0,
            "scenes": [{"nodes": root_nodes}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self.blob)}],
        }
        json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
        total = 12 + 8 + len(json_bytes) + 8 + len(self.blob)
        with out_path.open("wb") as handle:
            handle.write(struct.pack("<III", 0x46546C67, 2, total))
            handle.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
            handle.write(json_bytes)
            handle.write(struct.pack("<II", len(self.blob), 0x004E4942))
            handle.write(self.blob)


def export(xml_path: Path, out_path: Path, ratio: float) -> dict:
    model = mujoco.MjModel.from_xml_path(str(xml_path))
    builder = GlbBuilder()

    # One material per distinct MJCF material colour keeps the draw-call count
    # at two or three without discarding the black/silver read of the robot.
    material_ids: dict[tuple, int] = {}

    def material_for(geom_id: int) -> int:
        matid = int(model.geom_matid[geom_id])
        if matid >= 0:
            rgba = tuple(float(c) for c in model.mat_rgba[matid])
            name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MATERIAL, matid) or f"mat{matid}"
        else:
            rgba = tuple(float(c) for c in model.geom_rgba[geom_id])
            name = "geom_rgba"
        key = (rgba, name)
        if key not in material_ids:
            # Brushed-aluminium read: enough metal to catch the sun on the
            # globe, rough enough not to mirror the sky into a white blob.
            material_ids[key] = builder.add_material(rgba, 0.55, 0.45, name)
        return material_ids[key]

    mesh_cache: dict[tuple[int, int], int] = {}

    def mesh_for(geom_id: int) -> int | None:
        mesh_id = int(model.geom_dataid[geom_id])
        if mesh_id < 0:
            return None
        material = material_for(geom_id)
        cache_key = (mesh_id, material)
        if cache_key in mesh_cache:
            return mesh_cache[cache_key]
        vadr = int(model.mesh_vertadr[mesh_id])
        vnum = int(model.mesh_vertnum[mesh_id])
        fadr = int(model.mesh_faceadr[mesh_id])
        fnum = int(model.mesh_facenum[mesh_id])
        vertices = np.array(model.mesh_vert[vadr : vadr + vnum], dtype=np.float32)
        faces = np.array(model.mesh_face[fadr : fadr + fnum], dtype=np.uint32)
        vertices, faces = decimate(vertices, faces, ratio)
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MESH, mesh_id) or f"mesh{mesh_id}"
        mesh_index = builder.add_mesh(
            name,
            builder.add_vec3(vertices),
            builder.add_vec3(face_normals(vertices, faces)),
            builder.add_indices(faces),
            material,
        )
        mesh_cache[cache_key] = mesh_index
        return mesh_index

    # Body nodes first (so a child can reference its parent's index), then the
    # geom nodes are appended as children of their body.
    body_nodes: dict[int, int] = {}
    children: dict[int, list[int]] = {}

    for body_id in range(1, model.nbody):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id) or f"body{body_id}"
        quat = model.body_quat[body_id]  # MuJoCo stores wxyz
        node = {
            "name": name,
            "translation": [float(v) for v in model.body_pos[body_id]],
            "rotation": [float(quat[1]), float(quat[2]), float(quat[3]), float(quat[0])],
        }
        body_nodes[body_id] = builder.add_node(node)

    for geom_id in range(model.ngeom):
        if int(model.geom_group[geom_id]) != VISUAL_GROUP:
            continue
        if int(model.geom_type[geom_id]) != mujoco.mjtGeom.mjGEOM_MESH:
            continue
        mesh_index = mesh_for(geom_id)
        if mesh_index is None:
            continue
        body_id = int(model.geom_bodyid[geom_id])
        if body_id not in body_nodes:
            continue
        quat = model.geom_quat[geom_id]
        geom_name = (
            mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, geom_id) or f"geom{geom_id}"
        )
        node_index = builder.add_node(
            {
                "name": geom_name,
                "mesh": mesh_index,
                "translation": [float(v) for v in model.geom_pos[geom_id]],
                "rotation": [
                    float(quat[1]),
                    float(quat[2]),
                    float(quat[3]),
                    float(quat[0]),
                ],
            }
        )
        children.setdefault(body_nodes[body_id], []).append(node_index)

    for body_id in range(1, model.nbody):
        parent = int(model.body_parentid[body_id])
        if parent >= 1:
            children.setdefault(body_nodes[parent], []).append(body_nodes[body_id])

    for node_index, kids in children.items():
        builder.nodes[node_index]["children"] = kids

    # Root: the MuJoCo→glTF axis conversion, and the only node the renderer's
    # model matrix multiplies directly.
    root_children = [
        body_nodes[body_id]
        for body_id in range(1, model.nbody)
        if int(model.body_parentid[body_id]) == 0
    ]
    root = builder.add_node(
        {
            "name": "unitree_g1",
            "matrix": mj_to_gltf_root_matrix(),
            "children": root_children,
        }
    )

    tri_total = sum(
        builder.accessors[mesh["primitives"][0]["indices"]]["count"] // 3
        for mesh in builder.meshes
    )
    builder.write(out_path, [root], "gods-eye-view export_g1_glb.py")
    return {
        "meshes": len(builder.meshes),
        "nodes": len(builder.nodes),
        "triangles": tri_total,
        "bytes": out_path.stat().st_size,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xml", required=True, help="MJCF path (playground G1 or Menagerie g1.xml)")
    parser.add_argument("--out", default="public/models/unitree-g1.glb")
    parser.add_argument(
        "--decimate",
        type=float,
        default=0.12,
        help="Fraction of triangles to keep per mesh (1.0 disables decimation)",
    )
    args = parser.parse_args(argv)
    stats = export(Path(args.xml), Path(args.out), args.decimate)
    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
