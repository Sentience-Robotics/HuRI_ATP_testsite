import { Suspense, useEffect } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Environment } from "@react-three/drei";
import Character from "./Character.jsx";
import useStore from "../store/index.js";

function CameraRig() {
  const { camera } = useThree();
  const eyeHeight = useStore((s) => s.eyeHeight);

  useEffect(() => {
    if (eyeHeight == null) return;
    camera.position.set(0, eyeHeight, 300);
    camera.lookAt(0, eyeHeight, 0);
  }, [camera, eyeHeight]);

  return null;
}

export default function Scene() {
  return (
    <Canvas
      camera={{ position: [0, 1.6, 5], fov: 45 }}
      shadows
      gl={{ antialias: true }}
    >
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[3, 5, 3]}
        intensity={1.2}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />
      <pointLight position={[-2, 3, -2]} intensity={0.6} color="#8080ff" />

      <Suspense fallback={null}>
        <Character />
        <Environment preset="city" />
      </Suspense>

      <CameraRig />
    </Canvas>
  );
}
