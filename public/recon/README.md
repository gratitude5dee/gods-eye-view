# Reconstruction assets (`recon-cloud` layer / DISASTER RECON)

Drop an [ABot-Recon](https://github.com/gratitude5dee/ABot-Recon) export here:

| File | Written by | Used for |
| --- | --- | --- |
| `reconstruction.ply` | `scripts/export_reconstruction_ply.py --output` | the point cloud (`binary_little_endian`, `float x/y/z` + `uchar red/green/blue`) |
| `camera_poses.npy` | `demo.py --output-dir` | the replayed trajectory (`[N,4,4]` camera-to-world) |

Neither file is committed: they are session artifacts, sized in tens to
hundreds of megabytes. Without them the DISASTER RECON pill reports
`NO RECONSTRUCTION PUBLISHED` and changes nothing else.

Produce them with, from an ABot-Recon checkout:

```sh
python demo.py --image-dir <frames> --output-dir outputs/g1 \
  --attention-backend auto --no-loop-closure --save-world-points
python scripts/export_reconstruction_ply.py \
  --poses outputs/g1/camera_poses.npy --points outputs/g1/local_points.pt \
  --colors outputs/g1/colors.pt --metadata outputs/g1/metadata.json \
  --output outputs/g1/reconstruction.ply \
  --bev-output outputs/g1/trajectory_bev.png \
  --point-stride 4 --max-points 2000000
cp outputs/g1/reconstruction.ply outputs/g1/camera_poses.npy <gods-eye-view>/public/recon/
```

A reconstruction is metric but ungeoreferenced — its origin is the first
camera — so `config/recon/g1-anchor.json` says where on Earth to put it
(`lat`/`lon` of the first frame, `headingDeg` the bearing that camera looked
along). The clip's own geometry is real; the place is chosen, which is why the
replay is labelled `SIMULATED · VIRTUAL TRANSPOSITION`.
