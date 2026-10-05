'use client';
import { useEffect, useRef, useState } from 'react';
import { Logo } from '@/components/logo';
import { cn } from '@/lib/cn';

// Seconds the cube rests in the flat logo pose, then tumbles once around itself.
const HOLD = 1.5;
const SPIN = 6;

// Logo proportions (viewBox units): hexagon radius 40, circle radius 15, stroke 6.
// A unit cube corner projects to sqrt(8/3) from the centre when viewed down its diagonal.
const HEX_RADIUS = Math.sqrt(8 / 3);
const STROKE = (3 / 40) * HEX_RADIUS;
const RING = (15 / 40) * HEX_RADIUS;
// Half the visible area: room for a corner pointing straight at the viewer mid-turn.
const EXTENT = Math.sqrt(3) + STROKE + 0.05;

/**
 * The opendevhub mark as a 3D wireframe cube with an "O" inside. It starts in the exact pose of the
 * flat logo (looking down the cube's diagonal), then turns around itself so every side shows.
 * Click and drag to stop the animation and turn the cube by hand.
 * Renders the flat SVG until three.js has loaded, and keeps it when reduced motion is requested.
 */
export function Logo3D({ size = 160, className }: { size?: number; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let disposed = false;
    let cleanup = () => {};

    void import('three').then((THREE) => {
      if (disposed) return;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(size, size);
      renderer.domElement.style.position = 'absolute';
      renderer.domElement.style.inset = '0';
      renderer.domElement.style.cursor = 'grab';
      renderer.domElement.style.touchAction = 'none';
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-EXTENT, EXTENT, EXTENT, -EXTENT, 0.1, 20);
      camera.position.set(0, 0, 10);
      scene.add(new THREE.AmbientLight(0xffffff, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 2);
      sun.position.set(2, 3, 4);
      scene.add(sun);

      const material = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 });
      const geometries: InstanceType<typeof THREE.BufferGeometry>[] = [];
      const model = new THREE.Group();

      const corners: InstanceType<typeof THREE.Vector3>[] = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push(new THREE.Vector3(x, y, z));

      const joint = new THREE.SphereGeometry(STROKE, 16, 12);
      const edge = new THREE.CylinderGeometry(STROKE, STROKE, 2, 16, 1, true);
      geometries.push(joint, edge);
      const up = new THREE.Vector3(0, 1, 0);
      for (const [i, a] of corners.entries()) {
        const ball = new THREE.Mesh(joint, material);
        ball.position.copy(a);
        model.add(ball);
        for (const b of corners.slice(i + 1)) {
          if (a.distanceTo(b) !== 2) continue;
          const bar = new THREE.Mesh(edge, material);
          bar.position.copy(a).add(b).multiplyScalar(0.5);
          bar.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
          model.add(bar);
        }
      }

      // Point the cube's diagonal at the camera, then turn it so a corner sits at the top like the SVG.
      model.quaternion.setFromUnitVectors(new THREE.Vector3(1, 1, 1).normalize(), new THREE.Vector3(0, 0, 1));
      const top = new THREE.Vector3(1, 1, -1).applyQuaternion(model.quaternion);
      model.quaternion.premultiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2 - Math.atan2(top.y, top.x)),
      );

      // The "O" stays in the camera plane of the starting pose, so it reads as the logo's circle.
      const ringGeometry = new THREE.TorusGeometry(RING, STROKE, 24, 64);
      geometries.push(ringGeometry);
      const ring = new THREE.Mesh(ringGeometry, material);

      const spin = new THREE.Group();
      spin.add(model, ring);
      scene.add(spin);

      const syncColor = () => {
        // Normalise whatever CSS colour syntax the theme uses (hsl, oklch, …) by painting one pixel.
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = getComputedStyle(host).color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        material.color.setStyle(`rgb(${r}, ${g}, ${b})`);
      };
      syncColor();
      const themeObserver = new MutationObserver(syncColor);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

      const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
      const clock = new THREE.Clock();

      // Grabbing the cube ends the animation for good; dragging then turns it around the screen axes.
      const canvas = renderer.domElement;
      let auto = true;
      let last: { x: number; y: number } | null = null;
      const turn = new THREE.Quaternion();
      const xAxis = new THREE.Vector3(1, 0, 0);
      const yAxis = new THREE.Vector3(0, 1, 0);
      const radiansPerPixel = (Math.PI * 1.5) / size;
      const onDown = (e: PointerEvent) => {
        auto = false;
        last = { x: e.clientX, y: e.clientY };
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
      };
      const onMove = (e: PointerEvent) => {
        if (!last) return;
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        spin.quaternion.premultiply(turn.setFromAxisAngle(yAxis, dx * radiansPerPixel));
        spin.quaternion.premultiply(turn.setFromAxisAngle(xAxis, dy * radiansPerPixel));
      };
      const onUp = (e: PointerEvent) => {
        last = null;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        canvas.style.cursor = 'grab';
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);

      renderer.setAnimationLoop(() => {
        if (!auto) {
          renderer.render(scene, camera);
          return;
        }
        const t = clock.getElapsedTime() % (HOLD + SPIN);
        const p = t < HOLD ? 0 : ease((t - HOLD) / SPIN);
        // One full turn on two axes brings every face past the camera and lands back in the logo pose.
        spin.rotation.set(p * Math.PI * 2, p * Math.PI * 2, 0);
        renderer.render(scene, camera);
      });
      setReady(true);

      cleanup = () => {
        themeObserver.disconnect();
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        renderer.setAnimationLoop(null);
        for (const g of geometries) g.dispose();
        material.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [size]);

  return (
    <div
      ref={hostRef}
      className={cn('relative shrink-0 flex items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      {/* Scaled so the SVG hexagon (radius 40 of 100) matches the rendered cube in its starting pose. */}
      {!ready && <Logo size={Math.round((size * HEX_RADIUS) / EXTENT / 0.8)} />}
    </div>
  );
}
