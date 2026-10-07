import {
  Camera,
  Cylinder,
  Mesh,
  Program,
  Quat,
  Renderer,
  Sphere,
  Torus,
  Transform,
  Vec3,
} from "ogl";

import { EXTENT, RING, STROKE } from "./logo-3d-geometry";

// Seconds the cube rests in the flat logo pose, then tumbles once around itself.
const HOLD = 1.5;
const SPIN = 6;
// How long the canvas takes to fade in over the SVG placeholder.
const FADE_MS = 250;

// Soft wrap-around light from the upper right plus a small highlight. Normals are in view space, and the
// orthographic camera looks straight down -z, so the light and view directions are constants.
const vertex = /* glsl */ `
  attribute vec3 position;
  attribute vec3 normal;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat3 normalMatrix;
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragment = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  varying vec3 vNormal;
  const vec3 LIGHT = normalize(vec3(2.0, 3.0, 4.0));
  const vec3 HALF = normalize(LIGHT + vec3(0.0, 0.0, 1.0));
  void main() {
    vec3 n = normalize(vNormal);
    float diffuse = 0.7 + 0.4 * max(dot(n, LIGHT), 0.0);
    float specular = 0.2 * pow(max(dot(n, HALF), 0.0), 24.0);
    gl_FragColor = vec4(min(uColor * diffuse + specular, 1.0), 1.0);
  }
`;

/** The rotation taking unit vector `from` onto unit vector `to`. */
const between = (from: Vec3, to: Vec3) => {
  const axis = new Vec3().cross(from, to);
  const sin = axis.len();
  return sin < 1e-6
    ? new Quat()
    : new Quat().fromAxisAngle(axis.normalize(), Math.atan2(sin, from.dot(to)));
};

/**
 * Builds the WebGL cube inside `host` (sized `size` px), fades it in over whatever is already there and
 * calls `onShown` once it fully covers it. Lives in its own module so OGL is only fetched by pages that
 * show the logo, and never when reduced motion is requested. Returns a cleanup.
 */
export const mountLogoScene = (
  host: HTMLElement,
  size: number,
  onShown: () => void
): (() => void) => {
  const renderer = new Renderer({
    alpha: true,
    antialias: true,
    dpr: window.devicePixelRatio,
    height: size,
    width: size,
  });
  const { gl } = renderer;
  gl.clearColor(0, 0, 0, 0);
  const { canvas } = gl;
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.cursor = "grab";
  canvas.style.touchAction = "none";

  const camera = new Camera(gl, {
    bottom: -EXTENT,
    far: 20,
    left: -EXTENT,
    near: 0.1,
    right: EXTENT,
    top: EXTENT,
  });
  camera.position.set(0, 0, 10);

  const program = new Program(gl, {
    fragment,
    uniforms: { uColor: { value: [0, 0, 0] } },
    vertex,
  });
  const joint = new Sphere(gl, {
    heightSegments: 12,
    radius: STROKE,
    widthSegments: 16,
  });
  const edge = new Cylinder(gl, {
    height: 2,
    openEnded: true,
    radialSegments: 16,
    radiusBottom: STROKE,
    radiusTop: STROKE,
  });
  const ringGeometry = new Torus(gl, {
    radialSegments: 24,
    radius: RING,
    tube: STROKE,
    tubularSegments: 64,
  });
  const geometries = [joint, edge, ringGeometry];

  const scene = new Transform();
  const model = new Transform();
  const corners: Vec3[] = [];
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      for (const z of [-1, 1]) {
        corners.push(new Vec3(x, y, z));
      }
    }
  }

  const up = new Vec3(0, 1, 0);
  for (const [i, a] of corners.entries()) {
    const ball = new Mesh(gl, { geometry: joint, program });
    ball.position.copy(a);
    ball.setParent(model);
    for (const b of corners.slice(i + 1)) {
      if (a.distance(b) !== 2) {
        continue;
      }
      const bar = new Mesh(gl, { geometry: edge, program });
      bar.position.add(a, b).scale(0.5);
      bar.quaternion.copy(between(up, new Vec3().sub(b, a).normalize()));
      bar.setParent(model);
    }
  }

  // Point the cube's diagonal at the camera, then turn it so a corner sits at the top like the SVG.
  const pose = between(new Vec3(1, 1, 1).normalize(), new Vec3(0, 0, 1));
  const top = new Vec3(1, 1, -1).applyQuaternion(pose);
  model.quaternion.multiply(
    new Quat().fromAxisAngle(
      new Vec3(0, 0, 1),
      Math.PI / 2 - Math.atan2(top.y, top.x)
    ),
    pose
  );

  // The "O" stays in the camera plane of the starting pose, so it reads as the logo's circle.
  const ring = new Mesh(gl, { geometry: ringGeometry, program });

  const spin = new Transform();
  spin.rotation.reorder("XYZ");
  model.setParent(spin);
  ring.setParent(spin);
  spin.setParent(scene);

  const syncColor = () => {
    // Normalise whatever CSS colour syntax the theme uses (hsl, oklch, …) by painting one pixel.
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.fillStyle = getComputedStyle(host).color;
    ctx.fillRect(0, 0, 1, 1);
    program.uniforms.uColor.value = Array.from(
      ctx.getImageData(0, 0, 1, 1).data.subarray(0, 3),
      (c) => c / 255
    );
  };
  syncColor();
  const themeObserver = new MutationObserver(syncColor);
  themeObserver.observe(document.documentElement, {
    attributeFilter: ["class", "style"],
    attributes: true,
  });

  const ease = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  let elapsed = 0;
  let autoFrom = 0;

  // Grabbing the cube pauses the animation and dragging turns it around the screen axes. On release it
  // keeps the throw's momentum while a spring pulls it back to the logo pose, then the animation resumes.
  let mode: "auto" | "drag" | "spring" = "auto";
  let last: { x: number; y: number } | null = null;
  const dragged = new Vec3(); // rotation (screen axes) dragged since the last frame
  const velocity = new Vec3(); // angular velocity, rad/s around the screen axes
  const offset = new Vec3();
  const step = new Vec3();
  const axis = new Vec3();
  const turn = new Quat();
  const radiansPerPixel = (Math.PI * 1.5) / size;
  const STIFFNESS = 30;
  const DAMPING = 2 * Math.sqrt(STIFFNESS) * 0.4; // under-damped, so it overshoots a little

  const rotate = (rotation: Vec3) => {
    const angle = rotation.len();
    if (angle > 0) {
      spin.quaternion.multiply(
        turn.fromAxisAngle(axis.copy(rotation).scale(1 / angle), angle),
        spin.quaternion
      );
    }
  };
  const onDown = (e: PointerEvent) => {
    mode = "drag";
    velocity.set(0, 0, 0);
    dragged.set(0, 0, 0);
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  };
  const onMove = (e: PointerEvent) => {
    if (!last) {
      return;
    }
    const delta = new Vec3(
      (e.clientY - last.y) * radiansPerPixel,
      (e.clientX - last.x) * radiansPerPixel,
      0
    );
    last = { x: e.clientX, y: e.clientY };
    dragged.add(delta);
    rotate(delta);
  };
  const onUp = (e: PointerEvent) => {
    if (!last) {
      return;
    }
    last = null;
    mode = "spring";
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    canvas.style.cursor = "grab";
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  const update = (dt: number) => {
    if (mode === "drag") {
      // Smoothed so the throw's speed is what the pointer did over the last few frames.
      if (dt > 0) {
        velocity.lerp(dragged.scale(1 / dt), 0.5);
      }
      dragged.set(0, 0, 0);
    } else if (mode === "spring") {
      // How far the cube is turned away from the logo pose, as a rotation vector (shortest way round).
      const q = spin.quaternion;
      if (q.w < 0) {
        q.set(-q.x, -q.y, -q.z, -q.w);
      }
      const angle = 2 * Math.acos(Math.min(q.w, 1));
      const s = Math.sqrt(1 - q.w * q.w);
      if (s > 1e-6) {
        offset.set(q.x, q.y, q.z).scale(angle / s);
      } else {
        offset.set(0, 0, 0);
      }
      velocity
        .add(step.copy(offset).scale(-STIFFNESS * dt))
        .scale(Math.max(0, 1 - DAMPING * dt));
      rotate(step.copy(velocity).scale(dt));
      if (angle < 0.002 && velocity.len() < 0.02) {
        spin.quaternion.identity();
        mode = "auto";
        autoFrom = elapsed;
      }
    } else {
      const t = (elapsed - autoFrom) % (HOLD + SPIN);
      const p = t < HOLD ? 0 : ease((t - HOLD) / SPIN);
      // One full turn on two axes brings every face past the camera and lands back in the logo pose.
      spin.rotation.set(p * Math.PI * 2, p * Math.PI * 2, 0);
    }
    renderer.render({ camera, scene });
  };

  // Draw the logo pose once before the canvas goes in (this also compiles the shaders), then fade it in
  // over the matching SVG so the hand-over is seamless; the animation then holds that pose for HOLD seconds.
  update(0);
  host.append(canvas);
  const fade = canvas.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: FADE_MS,
    easing: "ease-out",
  });
  fade.finished.then(onShown, () => undefined);

  let frame = 0;
  let then = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(Math.max(now - then, 0) / 1000, 1 / 30);
    then = now;
    elapsed += dt;
    update(dt);
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  return () => {
    fade.cancel();
    cancelAnimationFrame(frame);
    themeObserver.disconnect();
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    for (const g of geometries) {
      g.remove();
    }
    program.remove();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
  };
};
