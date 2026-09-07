Here is a complete architectural plan to build this system, breaking down the frontend, backend, and the AI model pipelines.

### 1. System Architecture Overview

Your application will use a **bidirectional WebSocket stream**. As soon as the client connects, the Python backend will trigger the pipeline: it will generate the texture from the hardcoded string, synthesize the audio from text using CosyVoice2, pass that audio to EMAGE to generate the 3D motion data, and finally stream everything back to the frontend for synchronized playback.

### 2. Local Inference Links

Before building, you will need to clone and set up the local inference environments for both AI models:

* **EMAGE (Gestures):** The official maintained repository for EMAGE inference is now unified under the PantoMatrix repository.
* **Link:** [https://github.com/PantoMatrix/PantoMatrix](https://github.com/PantoMatrix/PantoMatrix)
* *Note:* You can run local inference using `test_camn_audio.py` for EMAGE (full body + face) which accepts an audio file and outputs SMPL-X and FLAME parameters.


* **CosyVoice2-0.5B (Audio):** The official repository from FunAudioLLM.
* **Link:** [https://github.com/FunAudioLLM/CosyVoice](https://github.com/FunAudioLLM/CosyVoice)
* *Note:* It supports streaming inference (`vLLM` engine) which will be critical for achieving the low latency you want.



---

### 3. Backend Strategy (Python + FastAPI)

You need an asynchronous backend capable of streaming binary data (audio) and JSON data (gesture frames) concurrently. **FastAPI** is the best choice here due to its native ASGI and WebSocket support.

**The Pipeline Flow on Connection:**

1. **Client Connects:** The WebSocket connection is established.
2. **Texture Generation:** A background task takes your hardcoded string (e.g., `"Cyberpunk leather jacket and neon jeans"`) and pings an image generation API (like Stable Diffusion or OpenAI's DALL-E 3 API) to generate a diffuse texture map. The resulting image URL/bytes are sent to the frontend immediately.
3. **Audio Generation:** The text script is fed into `CosyVoice2-0.5B`. Because CosyVoice2 supports bi-streaming, it can yield audio chunks in real-time (as low as 150ms latency).
4. **Gesture Generation:** As audio chunks are generated, they are buffered and fed into the `EMAGE` model. EMAGE processes the speech audio and outputs 3D motion parameters (SMPL-X/FLAME or ARKit blendshapes).
5. **Streaming:** The backend packages the audio chunk and its corresponding chunk of motion frames into a unified payload and sends it down the WebSocket.

**Key Backend Technologies:**

* **FastAPI:** For WebSocket management.
* **Librosa / Soundfile:** For audio chunking and processing between CosyVoice and EMAGE.
* **PyTorch:** To run the local inference for both models.

---

### 4. Frontend Strategy (React + Three.js)

For the frontend, the gold standard for rendering interactive 3D in the browser is **React Three Fiber (R3F)**, which is a React wrapper around **Three.js**.

**Core Components:**

1. **The 3D Model:** You will need a `.glb` or `.gltf` character model that has a skeletal rig compatible with SMPL-X (the skeleton format EMAGE uses) and morph targets (blendshapes) for the face.
2. **Dynamic Texturing:**
* When the WebSocket receives the generated texture image, you will use Three.js's `TextureLoader` to load the image and map it to your character's `MeshStandardMaterial.map` property.


3. **Synchronization (The tricky part):**
* **Audio Playback:** Use the Web Audio API to queue and play the incoming audio chunks seamlessly.
* **Animation Loop:** R3F has a `useFrame` hook that runs at 60 FPS. You will maintain an array of the motion parameters received from the backend.
* You must sync the character's bone rotations (quaternions) and facial blendshape weights to the `currentTime` of the Web Audio API context. If the audio is at 2.5 seconds, the `useFrame` loop should look up the EMAGE motion frame corresponding to 2.5 seconds and apply those rotations to the 3D model's bones.



**Recommended Frontend Libraries:**

* `three` and `@react-three/fiber` (Core 3D rendering)
* `@react-three/drei` (Useful helpers like `useGLTF` for loading the model and `OrbitControls` for camera movement)
* `zustand` (For managing the streaming state and buffering the gesture frames without causing React re-renders).

---

### 5. Implementation Roadmap

If I were to build this, I would follow this strict order to avoid integration nightmares:

1. **Stand up the AI locally first:** Write an isolated Python script that proves you can successfully pass text to CosyVoice2, save the `.wav`, and pass that `.wav` into EMAGE to get the `.npz` motion file. If this local pipeline fails, the web app won't work.
2. **Build the static frontend:** Load a static 3D model in React Three Fiber. Prove that you can manually change its texture using a local image file, and manually apply a static rotation to its bones.
3. **Build the WebSocket bridge:** Connect the FastAPI backend to the React frontend. Send dummy data (e.g., a simple sine wave for audio and a simple repeating rotation for the arm) to ensure your playback synchronization logic works perfectly.
4. **Connect the real pipeline:** Swap the dummy data out for the live outputs of CosyVoice and EMAGE.