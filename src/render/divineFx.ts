import * as THREE from 'three';

type FxKind = 'impact' | 'flames' | 'light' | 'gloom' | 'earth';

interface Fx {
  kind: FxKind;
  group: THREE.Group;
  age: number;
  life: number;
  radius: number;
}

const additive = (color: number, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

/** Short-lived visual effects marking a divine intervention. Purely cosmetic: the real effects are in the simulation. */
export class DivineFx {
  readonly group = new THREE.Group();
  private active: Fx[] = [];

  /** @param point world position on the ground, @param radius metres */
  spawn(kind: FxKind, point: THREE.Vector3, radius: number): void {
    const up = point.clone().normalize();
    const g = new THREE.Group();
    g.position.copy(point);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    let life = 3;
    switch (kind) {
      case 'impact': {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), additive(0xffd9a0));
        ball.name = 'ball';
        const streak = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.05, radius * 0.16, 900, 8, 1, true), additive(0xffb060, 0.9));
        streak.position.set(120, 450, 60);
        streak.rotation.set(0.13, 0, -0.26);
        streak.name = 'streak';
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2), additive(0xffe6c0));
        ring.position.y = 2;
        ring.name = 'ring';
        g.add(ball, streak, ring);
        life = 3.2;
        break;
      }
      case 'flames': {
        for (let i = 0; i < 26; i++) {
          const a = (i * 2.399) % (Math.PI * 2), r = radius * Math.sqrt((i + 0.5) / 26) * 0.85;
          const h = 5 + (i % 5) * 2.2;
          const f = new THREE.Mesh(new THREE.ConeGeometry(1.8 + (i % 3), h, 6), additive(i % 2 ? 0xff7a1a : 0xffc04a, 0.85));
          f.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
          f.userData.phase = i * 1.7;
          g.add(f);
        }
        life = 9;
        break;
      }
      case 'light':
      case 'gloom': {
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.5, radius * 0.9, 700, 20, 1, true), additive(kind === 'light' ? 0xffe2a0 : 0x7a5cff, 0.45));
        beam.position.y = 350;
        beam.name = 'beam';
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 56).rotateX(-Math.PI / 2), additive(kind === 'light' ? 0xfff0c8 : 0xa890ff));
        ring.position.y = 3;
        ring.name = 'ring';
        g.add(beam, ring);
        life = 4.5;
        break;
      }
      case 'earth': {
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 56).rotateX(-Math.PI / 2), additive(0xd8c39a, 0.9));
        ring.position.y = 6;
        ring.name = 'ring';
        g.add(ring);
        life = 3.5;
        break;
      }
    }
    this.group.add(g);
    this.active.push({ kind, group: g, age: 0, life, radius });
  }

  update(dt: number): void {
    for (const fx of [...this.active]) {
      fx.age += dt;
      const k = fx.age / fx.life;
      if (k >= 1) {
        this.group.remove(fx.group);
        fx.group.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          (m.material as THREE.Material | undefined)?.dispose();
        });
        this.active = this.active.filter((x) => x !== fx);
        continue;
      }
      const fade = 1 - k;
      for (const o of fx.group.children) {
        const m = o as THREE.Mesh;
        const mat = m.material as THREE.MeshBasicMaterial;
        if (m.name === 'ball') { const impact = Math.max(0, k - 0.22) / 0.78; m.scale.setScalar(1 + Math.sqrt(impact) * fx.radius * 0.8); mat.opacity = k < 0.22 ? 0 : Math.pow(1 - impact, 2) * 0.9; }
        else if (m.name === 'streak') { const fall = Math.min(1, k / 0.22); m.visible = k < 0.3; m.position.set(120 * (1 - fall), 450 * (1 - fall) + 20, 60 * (1 - fall)); }
        else if (m.name === 'ring') { const grow = fx.kind === 'impact' ? Math.max(0, k - 0.22) / 0.78 : k; m.scale.setScalar(1 + grow * fx.radius * (fx.kind === 'impact' ? 3 : 1.4)); mat.opacity = fade * 0.9; }
        else if (m.name === 'beam') { mat.opacity = 0.5 * Math.sin(Math.min(1, k * 4) * Math.PI * 0.5) * fade; }
        else { const ph = m.userData.phase ?? 0; m.scale.set(1, 0.7 + 0.5 * Math.abs(Math.sin(fx.age * 7 + ph)), 1); mat.opacity = 0.85 * Math.min(1, fade * 2.5); }
      }
    }
  }
}
