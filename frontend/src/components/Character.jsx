import { useEffect, useMemo, useRef } from "react";
import { useFBX } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import useStore from "../store/index.js";
import { getElapsed } from "../audio/playback.js";

// SMPL-X body-joint hierarchy (indices match poses[:, j*3:(j+1)*3] for j = 0..21).
// Parent of each joint; pelvis is the root.
const SMPLX_PARENT = {
  pelvis: null,
  left_hip: "pelvis",
  right_hip: "pelvis",
  spine1: "pelvis",
  left_knee: "left_hip",
  right_knee: "right_hip",
  spine2: "spine1",
  left_ankle: "left_knee",
  right_ankle: "right_knee",
  spine3: "spine2",
  left_foot: "left_ankle",
  right_foot: "right_ankle",
  neck: "spine3",
  left_collar: "spine3",
  right_collar: "spine3",
  head: "neck",
  left_shoulder: "left_collar",
  right_shoulder: "right_collar",
  left_elbow: "left_shoulder",
  right_elbow: "right_shoulder",
  left_wrist: "left_elbow",
  right_wrist: "right_elbow",
  // Fingers — pinky omitted (no Mixamo bones on this rig).
  left_thumb1: "left_wrist",
  left_thumb2: "left_thumb1",
  left_thumb3: "left_thumb2",
  left_index1: "left_wrist",
  left_index2: "left_index1",
  left_index3: "left_index2",
  left_middle1: "left_wrist",
  left_middle2: "left_middle1",
  left_middle3: "left_middle2",
  left_ring1: "left_wrist",
  left_ring2: "left_ring1",
  left_ring3: "left_ring2",
  right_thumb1: "right_wrist",
  right_thumb2: "right_thumb1",
  right_thumb3: "right_thumb2",
  right_index1: "right_wrist",
  right_index2: "right_index1",
  right_index3: "right_index2",
  right_middle1: "right_wrist",
  right_middle2: "right_middle1",
  right_middle3: "right_middle2",
  right_ring1: "right_wrist",
  right_ring2: "right_ring1",
  right_ring3: "right_ring2",
};

// Topological order — every entry's parent appears before it.
const SMPLX_ORDER = [
  "pelvis",
  "left_hip", "right_hip", "spine1",
  "left_knee", "right_knee", "spine2",
  "left_ankle", "right_ankle", "spine3",
  "left_foot", "right_foot", "neck",
  "left_collar", "right_collar", "head",
  "left_shoulder", "right_shoulder",
  "left_elbow", "right_elbow",
  "left_wrist", "right_wrist",
  "left_thumb1", "left_thumb2", "left_thumb3",
  "left_index1", "left_index2", "left_index3",
  "left_middle1", "left_middle2", "left_middle3",
  "left_ring1", "left_ring2", "left_ring3",
  "right_thumb1", "right_thumb2", "right_thumb3",
  "right_index1", "right_index2", "right_index3",
  "right_middle1", "right_middle2", "right_middle3",
  "right_ring1", "right_ring2", "right_ring3",
];

// SMPL-X joint → Mixamo bone (1:1, no L/R swap — the math handles frame differences).
const BONE_MAP = {
  pelvis: "mixamorigHips",
  left_hip: "mixamorigLeftUpLeg",
  right_hip: "mixamorigRightUpLeg",
  spine1: "mixamorigSpine",
  left_knee: "mixamorigLeftLeg",
  right_knee: "mixamorigRightLeg",
  spine2: "mixamorigSpine1",
  left_ankle: "mixamorigLeftFoot",
  right_ankle: "mixamorigRightFoot",
  spine3: "mixamorigSpine2",
  left_foot: "mixamorigLeftToeBase",
  right_foot: "mixamorigRightToeBase",
  neck: "mixamorigNeck",
  left_collar: "mixamorigLeftShoulder",
  right_collar: "mixamorigRightShoulder",
  head: "mixamorigHead",
  left_shoulder: "mixamorigLeftArm",
  right_shoulder: "mixamorigRightArm",
  left_elbow: "mixamorigLeftForeArm",
  right_elbow: "mixamorigRightForeArm",
  left_wrist: "mixamorigLeftHand",
  right_wrist: "mixamorigRightHand",
  left_thumb1: "mixamorigLeftHandThumb1",
  left_thumb2: "mixamorigLeftHandThumb2",
  left_thumb3: "mixamorigLeftHandThumb3",
  left_index1: "mixamorigLeftHandIndex1",
  left_index2: "mixamorigLeftHandIndex2",
  left_index3: "mixamorigLeftHandIndex3",
  left_middle1: "mixamorigLeftHandMiddle1",
  left_middle2: "mixamorigLeftHandMiddle2",
  left_middle3: "mixamorigLeftHandMiddle3",
  left_ring1: "mixamorigLeftHandRing1",
  left_ring2: "mixamorigLeftHandRing2",
  left_ring3: "mixamorigLeftHandRing3",
  right_thumb1: "mixamorigRightHandThumb1",
  right_thumb2: "mixamorigRightHandThumb2",
  right_thumb3: "mixamorigRightHandThumb3",
  right_index1: "mixamorigRightHandIndex1",
  right_index2: "mixamorigRightHandIndex2",
  right_index3: "mixamorigRightHandIndex3",
  right_middle1: "mixamorigRightHandMiddle1",
  right_middle2: "mixamorigRightHandMiddle2",
  right_middle3: "mixamorigRightHandMiddle3",
  right_ring1: "mixamorigRightHandRing1",
  right_ring2: "mixamorigRightHandRing2",
  right_ring3: "mixamorigRightHandRing3",
};

const BLENDSHAPE_MAP = {
  eyeBlinkLeft: "eyeBlinkLeft",
  eyeBlinkRight: "eyeBlinkRight",
  jawOpen: "jawOpen",
  mouthSmileLeft: "mouthSmileLeft",
  mouthSmileRight: "mouthSmileRight",
  browDownLeft: "browDownLeft",
  browDownRight: "browDownRight",
  cheekPuff: "cheekPuff",
  noseSneerLeft: "noseSneerLeft",
  noseSneerRight: "noseSneerRight",
};

const ROOT_JOINT = "pelvis";

// Each sliding-window gesture chunk is an independent inference, so the first
// frame of a new chunk doesn't exactly continue the last frame of the previous
// one — a single inter-frame interp can't hide that seam. Easing every bone
// toward its target with this time constant (seconds) smooths the discontinuity
// without server changes. Smaller = snappier/jerkier, larger = smoother/laggier.
const SMOOTH_TIME_CONST = 0.06;

function binarySearchFrame(frames, t) {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Interpolation weight between the frame at/just-before time `t` and the next.
function sampleAt(frames, t) {
  const idx = binarySearchFrame(frames, t);
  const nextIdx = Math.min(idx + 1, frames.length - 1);
  const frame = frames[idx];
  const nextFrame = frames[nextIdx];
  const t0 = frame.t ?? 0;
  const t1 = nextFrame?.t ?? t0;
  const alpha = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
  return { frame, nextFrame, alpha };
}

export default function Character() {
  const scene = useFBX("/model.fbx");
  const { frames, setEyeHeight } = useStore();

  // Resolved Mixamo bones keyed by SMPL-X joint name.
  const bonesRef = useRef({});
  // World-space quaternion of each mapped Mixamo bone at rest pose (captured once).
  const restWorldRef = useRef({});
  // World-space quat of the Hips' parent (FBX armature root) — does not animate.
  const rootParentWorldRef = useRef(new THREE.Quaternion());

  const morphMeshRef = useRef(null);

  // Pre-allocated temporaries — avoid allocating in useFrame.
  const tmp = useMemo(() => ({
    q0: new THREE.Quaternion(),
    q1: new THREE.Quaternion(),
    qLocal: new THREE.Quaternion(),
    qTarget: new THREE.Quaternion(),
    parentInv: new THREE.Quaternion(),
    smplxGlobal: Object.fromEntries(SMPLX_ORDER.map((n) => [n, new THREE.Quaternion()])),
    desiredWorld: Object.fromEntries(SMPLX_ORDER.map((n) => [n, new THREE.Quaternion()])),
  }), []);

  useEffect(() => {
    scene.position.set(0, 0, 0);
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const height = box.max.y - box.min.y;
    scene.position.y = -box.min.y;
    scene.updateMatrixWorld(true);
    const eye = height * 0.80;
    setEyeHeight(eye);
    console.log("[Avatar] Height:", height.toFixed(2), "Eye height:", eye.toFixed(2));

    const bonesByName = {};
    scene.traverse((obj) => {
      if (obj.isBone) bonesByName[obj.name] = obj;
      if (obj.isMesh && obj.morphTargetDictionary && !morphMeshRef.current) {
        morphMeshRef.current = obj;
        console.log("[Avatar] Morph targets:", Object.keys(obj.morphTargetDictionary));
      }
    });

    const resolved = {};
    const restWorld = {};
    for (const [smplxName, mixamoName] of Object.entries(BONE_MAP)) {
      const bone = bonesByName[mixamoName];
      if (!bone) {
        console.warn(`[Avatar] Missing bone "${mixamoName}" for SMPL-X joint "${smplxName}"`);
        continue;
      }
      resolved[smplxName] = bone;
      const wq = new THREE.Quaternion();
      bone.getWorldQuaternion(wq);
      restWorld[smplxName] = wq;
    }
    bonesRef.current = resolved;
    restWorldRef.current = restWorld;

    const hips = resolved[ROOT_JOINT];
    if (hips?.parent) {
      hips.parent.getWorldQuaternion(rootParentWorldRef.current);
    } else {
      rootParentWorldRef.current.identity();
    }
  }, [scene]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, delta) => {
    // Drive bones against the shared audio clock so gesture stays in sync with
    // speech (both share the pts timeline). null until the first chunk plays.
    const elapsed = getElapsed();
    if (elapsed == null || elapsed < 0 || frames.length === 0) return;

    // Frame-rate-independent easing toward each bone's target rotation, used to
    // soften the discontinuity at gesture-chunk seams (see SMOOTH_TIME_CONST).
    const smooth = 1 - Math.exp(-delta / SMOOTH_TIME_CONST);

    // The per-bone easing below is a first-order low-pass, so each bone trails
    // its target by ~SMOOTH_TIME_CONST. Sample the BODY target that far in the
    // future so, once eased, bones land on the correct pose at `elapsed` —
    // removing the lag without giving up the seam smoothing. Blendshapes aren't
    // eased, so the mouth is sampled at `elapsed` and stays tight to the audio.
    const body = sampleAt(frames, elapsed + SMOOTH_TIME_CONST);
    const face = sampleAt(frames, elapsed);
    const bodyAlpha = body.alpha;

    const bones = bonesRef.current;
    const restWorld = restWorldRef.current;
    const rotations0 = body.frame.rotations ?? {};
    const rotations1 = body.nextFrame?.rotations ?? rotations0;

    // For each joint in topological order:
    //   1. Slerp local SMPL-X rotation between frames.
    //   2. Chain into SMPL-X world rotation: smplxGlobal = parentSmplxGlobal * localSlerped.
    //   3. Desired Mixamo bone world rot = smplxGlobal * mixamoRestWorld.
    //      (Valid because SMPL-X rest = identity, so smplxGlobal *is* the world-space
    //      rotation delta from rest. Right-multiplying by the Mixamo rest orientation
    //      transports that delta onto our rig's bone frame.)
    //   4. Bone local rot = inv(parentDesiredWorld) * desiredWorld.
    for (const name of SMPLX_ORDER) {
      const q0 = rotations0[name];
      if (!q0) continue;
      const q1 = rotations1[name] ?? q0;

      tmp.q0.set(q0[0], q0[1], q0[2], q0[3]);
      tmp.q1.set(q1[0], q1[1], q1[2], q1[3]);
      tmp.qLocal.copy(tmp.q0).slerp(tmp.q1, bodyAlpha);

      const parentName = SMPLX_PARENT[name];
      const smplxGlobal = tmp.smplxGlobal[name];
      if (parentName === null) {
        smplxGlobal.copy(tmp.qLocal);
      } else {
        smplxGlobal.copy(tmp.smplxGlobal[parentName]).multiply(tmp.qLocal);
      }

      const rest = restWorld[name];
      if (!rest) continue;
      tmp.desiredWorld[name].copy(smplxGlobal).multiply(rest);

      const bone = bones[name];
      if (!bone) continue;

      if (parentName === null) {
        tmp.parentInv.copy(rootParentWorldRef.current).invert();
      } else {
        tmp.parentInv.copy(tmp.desiredWorld[parentName]).invert();
      }
      // Ease the bone toward its target rather than snapping, smoothing seams.
      tmp.qTarget.copy(tmp.parentInv).multiply(tmp.desiredWorld[name]);
      bone.quaternion.slerp(tmp.qTarget, smooth);
    }

    const mesh = morphMeshRef.current;
    if (mesh && mesh.morphTargetDictionary) {
      const shapes0 = face.frame.blendshapes ?? {};
      const shapes1 = face.nextFrame?.blendshapes ?? shapes0;
      for (const [name, weight] of Object.entries(shapes0)) {
        const targetName = BLENDSHAPE_MAP[name] ?? name;
        const morphIdx = mesh.morphTargetDictionary[targetName];
        if (morphIdx !== undefined) {
          const nextWeight = shapes1[name] ?? weight;
          mesh.morphTargetInfluences[morphIdx] = weight + (nextWeight - weight) * face.alpha;
        }
      }
    }
    // Root translation is intentionally ignored: the avatar gestures in place
    // (bones + blendshapes only) rather than drifting around the scene. The
    // pelvis still rotates via BONE_MAP, so weight shifts still read.
  });

  return <primitive object={scene} />;
}
