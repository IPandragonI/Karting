import * as THREE from "three";
import type { Models } from "./assets";
import type { CameraRig } from "./Camera";
import { isTypingTarget } from "./InputManager";
import {
  autoLevel,
  changeLevel,
  checkPiecePlacement,
  checkPropPlacement,
  eraseAt,
  History,
  makePiece,
  mirrorTrack,
  pieceAt,
  placePiece,
  placeProp,
  propNear,
  snapProp,
  type EditResult,
} from "./track/editing";
import {
  CELL,
  DIR_VEC,
  LEVEL_HEIGHT,
  MAX_LEVEL,
  PIECE_TYPES,
  PIECES,
  PROP_TYPES,
  type PieceType,
  type PropType,
  type Rot,
} from "./track/pieces";
import {
  analyzeTrack,
  cloneTrack,
  footprintCells,
  pieceLevel,
  toWorld,
  trackBounds,
  type TrackData,
  type TrackLayout,
} from "./track/Track";
import { buildTrack, type BuiltTrack } from "./track/TrackBuilder";

// Grid editor. Interaction model (same for mouse and touch):
// - click / tap: use the current tool (place, raise, or erase); right click erases (lowers with
//   the height tool);
// - drag (one finger or mouse): pan; wheel / pinch: zoom; arrow keys / WASD pan too;
// - R rotates (Shift+R backwards), F flips, + / − change the level for new pieces, I picks up
//   the piece under the pointer, 1–9 pick tools, H height tool, X erase, Ctrl+Z / Ctrl+Y undo.
// New pieces join raised road at its level automatically; the chosen level applies elsewhere.
// The editor only edits TrackData; the host rebuilds the real track after every change, so the
// preview is exactly what will be driven.

export type EditorTool = PieceType | PropType | "level" | "erase";
export const EDITOR_TOOLS: EditorTool[] = [...PIECE_TYPES, ...PROP_TYPES, "level", "erase"];

export type EditorUi = {
  tool: EditorTool;
  rot: Rot;
  canUndo: boolean;
  canRedo: boolean;
  /** What would happen on click at the hovered spot. */
  hint: string | null;
  hintOk: boolean;
  preview: boolean;
  /** Level for new pieces that do not join raised road. */
  level: number;
  /** New pieces are mirrored. */
  flip: boolean;
  /** The circuit differs from the one being driven (unsaved until Drive). */
  dirty: boolean;
};

export type EditorHost = {
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
  camera: () => THREE.PerspectiveCamera;
  models: () => Models | null;
  /** Called after every edit with the new track. */
  onChange: (track: TrackData, layout: TrackLayout) => void;
  onUi: (ui: Partial<EditorUi>) => void;
  onNote: (text: string, tone: "info" | "warning") => void;
};

const GHOST_OK = new THREE.Color("#7cc35a");
const GHOST_BAD = new THREE.Color("#ff6b5e");

export class TrackEditor {
  track: TrackData;
  private layout: TrackLayout;
  private readonly history = new History();
  private tool: EditorTool = "straight";
  private rot: Rot = 0;
  private level = 0;
  private flip = false;
  private preview = false;
  private active = false;
  /** The circuit as it was when the editor opened (revert target, unsaved-changes check). */
  private base: TrackData;
  private baseKey = "";
  /** Level the ghost piece is currently built at. */
  private ghostLevel = 0;
  private readonly labels = new THREE.Group();
  private readonly labelTextures = new Map<string, THREE.CanvasTexture>();
  private readonly labelMats: THREE.SpriteMaterial[] = [];

  private readonly root = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private ghost: THREE.Group | null = null;
  private ghostTrack: BuiltTrack | null = null;
  private readonly ghostFootprint: THREE.Mesh;
  private grid: THREE.GridHelper;
  private readonly overlayGeo = new THREE.PlaneGeometry(CELL * 0.96, CELL * 0.96).rotateX(
    -Math.PI / 2,
  );
  private readonly issueMat = new THREE.MeshBasicMaterial({
    color: "#ff6b5e",
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  // Markers write depth so translucent overlays (ghost, issue cells) drawn later cannot hide them.
  private readonly openMat = new THREE.MeshBasicMaterial({ color: "#ff3b2e" });
  private readonly arrowMat = new THREE.MeshBasicMaterial({ color: "#f2c14e" });
  private readonly openGeo = new THREE.ConeGeometry(1.1, 2.2, 3).rotateX(Math.PI / 2);

  // Camera.
  private camX = 0;
  private camZ = 0;
  private camH = 120;

  // Pointer state.
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private dragStart: { x: number; y: number } | null = null;
  private dragged = false;
  private pinchDist = 0;
  private readonly hover = new THREE.Vector3();
  private hasHover = false;
  private readonly keys = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly ndc = new THREE.Vector2();

  constructor(
    private readonly host: EditorHost,
    track: TrackData,
  ) {
    this.track = track;
    this.layout = analyzeTrack(track);
    this.base = track;
    this.grid = new THREE.GridHelper(CELL * 41, 41, "#ffffff", "#ffffff");
    // 41 divisions centred on the origin put the lines on cell edges (cells are centred on k·CELL).
    this.grid.position.set(0, 0.05, 0);
    const gm = this.grid.material as THREE.LineBasicMaterial;
    gm.transparent = true;
    gm.opacity = 0.22;
    gm.depthWrite = false;
    this.ghostFootprint = new THREE.Mesh(
      this.overlayGeo,
      new THREE.MeshBasicMaterial({
        color: GHOST_OK,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
    this.root.add(this.grid, this.overlay, this.labels);
    this.root.visible = false;
    host.scene.add(this.root);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  enable(track: TrackData) {
    this.track = track;
    this.layout = analyzeTrack(track);
    this.base = cloneTrack(track);
    this.baseKey = trackKey(track);
    this.history.clear();
    this.active = true;
    this.preview = false;
    this.root.visible = true;
    this.frameTrack();
    this.applyWorkingLevel();
    const c = this.host.canvas;
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    c.addEventListener("pointerleave", this.onPointerLeave);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.rebuildGhost();
    this.refreshOverlay();
    this.pushUi();
  }

  disable() {
    this.active = false;
    this.root.visible = false;
    this.clearGhost();
    this.pointers.clear();
    this.keys.clear();
    const c = this.host.canvas;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  dispose() {
    this.disable();
    this.host.scene.remove(this.root);
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.overlayGeo.dispose();
    this.openGeo.dispose();
    this.issueMat.dispose();
    this.openMat.dispose();
    this.arrowMat.dispose();
    for (const t of this.labelTextures.values()) t.dispose();
    for (const m of this.labelMats) m.dispose();
    (this.ghostFootprint.material as THREE.Material).dispose();
  }

  // ─── Public actions (toolbar) ────────────────────────────────────────────

  setTool(tool: EditorTool) {
    this.tool = tool;
    this.rebuildGhost();
    this.pushUi();
  }

  rotate(dir: 1 | -1 = 1) {
    this.rot = ((((this.rot + dir) % 4) + 4) % 4) as Rot;
    this.rebuildGhost();
    this.pushUi();
  }

  /** Level for new pieces placed away from raised road. */
  setLevel(level: number) {
    this.level = Math.max(0, Math.min(MAX_LEVEL, level));
    this.applyWorkingLevel();
    this.updateGhost();
    this.pushUi();
  }

  toggleFlip() {
    this.flip = !this.flip;
    this.rebuildGhost();
    this.pushUi();
  }

  /**
   * The working level is where the pointer is projected (clicks land on the cell under the cursor
   * at that height, raised road included) and where the grid is drawn, so the height being edited
   * is always visible.
   */
  private applyWorkingLevel() {
    const y = this.level * LEVEL_HEIGHT;
    this.plane.constant = -y;
    this.grid.position.y = y + 0.05;
  }

  /** Mirror the whole circuit left ↔ right (undoable). */
  mirror() {
    this.apply({ ok: true, track: mirrorTrack(this.track), note: "Circuit mirrored" });
  }

  /** Back to the circuit as it was when the editor opened (undoable). */
  revert() {
    if (!this.dirty) return;
    this.history.push(this.track);
    this.setTrack(cloneTrack(this.base));
    this.host.onNote("Changes discarded", "info");
  }

  get dirty() {
    return trackKey(this.track) !== this.baseKey;
  }

  /** Eyedropper: the hovered piece becomes the current tool (type, rotation, flip, level). */
  private pick() {
    if (!this.hasHover) return;
    const i = pieceAt(
      this.track,
      Math.round(this.hover.x / CELL),
      Math.round(this.hover.z / CELL),
      this.level,
    );
    const p = this.track.pieces[i];
    if (!p) return;
    this.tool = p.type;
    this.rot = p.rot;
    this.flip = !!p.flip;
    this.level = pieceLevel(p);
    this.applyWorkingLevel();
    this.rebuildGhost();
    this.pushUi();
    this.host.onNote(`Picked ${PIECES[p.type].label}`, "info");
  }

  undo() {
    const prev = this.history.undo(this.track);
    if (prev) this.setTrack(prev);
  }

  redo() {
    const next = this.history.redo(this.track);
    if (next) this.setTrack(next);
  }

  /** Replace the whole track (reset to default, clear, import) as one undoable step. */
  replace(track: TrackData) {
    this.history.push(this.track);
    this.setTrack(track);
    this.frameTrack();
  }

  rename(name: string) {
    this.track = { ...this.track, name };
    this.pushUi();
  }

  setPreview(preview: boolean) {
    this.preview = preview;
    this.grid.visible = !preview;
    this.overlay.visible = !preview;
    this.labels.visible = !preview;
    if (this.ghost) this.ghost.visible = !preview;
    this.pushUi();
  }

  get isPreview() {
    return this.preview;
  }

  // ─── Camera ──────────────────────────────────────────────────────────────

  private frameTrack() {
    const b = trackBounds(this.track);
    this.camX = (b.minX + b.maxX) / 2;
    this.camZ = (b.minZ + b.maxZ) / 2;
    const span = Math.max(b.maxX - b.minX, (b.maxZ - b.minZ) * 1.3, CELL * 4);
    const cam = this.host.camera();
    const fitH =
      span /
      2 /
      Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) /
      Math.max(0.6, Math.min(cam.aspect, 1.6));
    this.camH = THREE.MathUtils.clamp(fitH * 1.35, 30, 320);
    // The camera is tilted (it sits south of its target); nudge the view so the track is centred.
    this.camZ -= this.camH * 0.06;
  }

  update(rig: CameraRig, dt: number) {
    // Keyboard panning, speed proportional to zoom.
    const speed = this.camH * 0.9 * dt;
    let dx = 0;
    let dz = 0;
    if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) dz += 1;
    if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) dz -= 1;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) dx += 1;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) dx -= 1;
    this.camX += dx * speed;
    this.camZ += dz * speed;
    rig.editor(this.camX, this.camZ, this.camH);
    if (this.preview) {
      // Gentle drift so the preview feels alive without taking control away.
      rig.camera.position.x += Math.sin(performance.now() * 0.0003) * 2;
    }
  }

  get cameraTarget() {
    return { x: this.camX, z: this.camZ };
  }

  // ─── Editing ─────────────────────────────────────────────────────────────

  private setTrack(track: TrackData) {
    this.track = track;
    this.layout = analyzeTrack(track);
    this.host.onChange(track, this.layout);
    this.refreshOverlay();
    this.updateGhost();
    this.pushUi();
  }

  private apply(result: EditResult) {
    if (!result.ok) {
      this.host.onNote(result.reason, "warning");
      return;
    }
    this.history.push(this.track);
    this.setTrack(result.track);
    if (result.note) this.host.onNote(result.note, "info");
  }

  private act(erase: boolean) {
    if (!this.hasHover || this.preview) return;
    const { x, z } = this.hover;
    if (this.tool === "level") {
      const lower = erase || this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      this.apply(
        changeLevel(
          this.track,
          Math.round(x / CELL),
          Math.round(z / CELL),
          lower ? -1 : 1,
          this.level,
        ),
      );
    } else if (erase || this.tool === "erase") {
      this.apply(eraseAt(this.track, x, z, this.level));
    } else if (this.tool === "cone" || this.tool === "tires") {
      this.apply(placeProp(this.track, this.tool, x, z));
    } else {
      const cx = Math.round(x / CELL);
      const cz = Math.round(z / CELL);
      this.apply(
        placePiece(this.track, this.tool, cx, cz, this.rot, {
          y: this.placementLevel(this.tool, cx, cz),
          flip: this.flip,
        }),
      );
    }
  }

  /** Level a new piece gets at a cell: joins raised road next to it, else the chosen level. */
  private placementLevel(type: PieceType, cx: number, cz: number): number {
    const auto = autoLevel(
      this.track,
      makePiece(type, cx, cz, this.rot, { flip: this.flip }),
      this.level,
    );
    return auto ?? Math.min(this.level, MAX_LEVEL - PIECES[type].rise);
  }

  private pushUi() {
    this.host.onUi({
      tool: this.tool,
      rot: this.rot,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      preview: this.preview,
      level: this.level,
      flip: this.flip,
      dirty: this.dirty,
    });
  }

  // ─── Ghost preview ───────────────────────────────────────────────────────

  private clearGhost() {
    if (this.ghost) {
      this.root.remove(this.ghost);
      this.ghost = null;
    }
    if (this.ghostTrack) {
      this.ghostTrack.dispose();
      this.ghostTrack = null;
    }
  }

  private rebuildGhost() {
    this.clearGhost();
    if (!this.active) return;
    const ghost = new THREE.Group();
    const tool = this.tool;
    if (tool === "erase" || tool === "level") {
      // Footprint highlight only.
    } else if (tool === "cone" || tool === "tires") {
      const models = this.host.models();
      if (tool === "cone" && models) {
        const cone = models.cone.clone();
        cone.scale.setScalar(1.2);
        ghost.add(cone);
      } else {
        const tire = new THREE.Mesh(
          new THREE.CylinderGeometry(0.42, 0.42, 0.8, 10).translate(0, 0.4, 0),
          new THREE.MeshLambertMaterial({ color: "#2a2c31" }),
        );
        ghost.add(tire);
      }
    } else {
      // The real piece geometry at the origin, made translucent.
      const single: TrackData = {
        version: 1,
        name: "",
        pieces: [makePiece(tool, 0, 0, this.rot, { y: this.ghostLevel, flip: this.flip })],
        props: [],
      };
      this.ghostTrack = buildTrack(single, analyzeTrack(single), null);
      this.ghostTrack.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          m.transparent = true;
          m.opacity = 0.7;
          m.depthWrite = false;
        }
      });
      this.ghostTrack.group.position.y = 0.06;
      ghost.add(this.ghostTrack.group);
      // Direction arrow for the start piece.
      if (tool === "start") ghost.add(this.startArrow(0));
    }
    ghost.visible = this.hasHover && !this.preview;
    this.ghost = ghost;
    this.root.add(ghost);
    this.updateGhost();
  }

  private startArrow(rot: number) {
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(1.6, 3.2, 3).rotateX(Math.PI / 2),
      this.arrowMat,
    );
    arrow.position.set(0, 0.4, 2.5);
    const g = new THREE.Group();
    g.add(arrow);
    g.rotation.y = (rot * Math.PI) / 2;
    return g;
  }

  /** Positions and tints the ghost for the hovered cell; updates the hint text. */
  private updateGhost() {
    const ghost = this.ghost;
    if (!ghost || !this.hasHover) {
      if (ghost) ghost.visible = false;
      this.host.onUi({ hint: null });
      return;
    }
    ghost.visible = !this.preview;
    const { x, z } = this.hover;
    const tool = this.tool;
    let ok = true;
    let hint: string;
    // Footprint squares under the ghost.
    for (const child of [...ghost.children]) if (child.userData.footprint) ghost.remove(child);
    const footprint = (cells: [number, number][], color: THREE.Color, level = this.level) => {
      const footY = level * LEVEL_HEIGHT;
      for (const [cx, cz] of cells) {
        const sq = this.ghostFootprint.clone();
        (sq.material as THREE.MeshBasicMaterial).color = color;
        sq.position.set(cx * CELL - ghost.position.x, footY + 0.07, cz * CELL - ghost.position.z);
        sq.userData.footprint = true;
        ghost.add(sq);
      }
    };

    if (tool === "level") {
      ghost.position.set(0, 0, 0);
      const piece = pieceAt(this.track, Math.round(x / CELL), Math.round(z / CELL), this.level);
      const p = this.track.pieces[piece];
      if (p) {
        const level = pieceLevel(p);
        const top = MAX_LEVEL - PIECES[p.type].rise;
        hint =
          level < top
            ? `Raise ${PIECES[p.type].label} to level ${level + 1}` +
              (level > 0 ? ` · right-click: lower to ${level - 1}` : "")
            : `Top level · right-click: lower to ${level - 1}`;
        footprint(footprintCells(p), GHOST_OK, pieceLevel(p));
      } else {
        hint = "Click a piece to raise it, right-click (or Shift) to lower it";
        ok = false;
      }
    } else if (tool === "erase") {
      ghost.position.set(0, 0, 0);
      const prop = propNear(this.track, x, z, 1.2);
      const piece = pieceAt(this.track, Math.round(x / CELL), Math.round(z / CELL), this.level);
      if (prop >= 0) {
        hint = `Erase ${this.track.props[prop]!.type === "cone" ? "cone" : "tire stack"}`;
      } else if (piece >= 0) {
        hint = `Erase ${PIECES[this.track.pieces[piece]!.type].label}`;
        footprint(
          footprintCells(this.track.pieces[piece]!),
          GHOST_BAD,
          pieceLevel(this.track.pieces[piece]!),
        );
      } else {
        hint = "Nothing to erase";
        ok = false;
      }
    } else if (tool === "cone" || tool === "tires") {
      const sx = snapProp(x);
      const sz = snapProp(z);
      ghost.position.set(sx, 0, sz);
      const check = checkPropPlacement(this.track, sx, sz);
      ok = check.ok;
      hint = check.ok ? `Place ${tool === "cone" ? "cone" : "tire stack"}` : check.reason;
    } else {
      const cx = Math.round(x / CELL);
      const cz = Math.round(z / CELL);
      const level = this.placementLevel(tool, cx, cz);
      if (level !== this.ghostLevel) {
        // The ghost shows the piece at the height it will be placed (rebuilding re-enters here).
        this.ghostLevel = level;
        this.rebuildGhost();
        return;
      }
      ghost.position.set(cx * CELL, 0, cz * CELL);
      const piece = makePiece(tool, cx, cz, this.rot, { y: level, flip: this.flip });
      const check = checkPiecePlacement(this.track, piece);
      ok = check.ok;
      const where = level > 0 || PIECES[tool].rise > 0 ? ` · level ${level}` : "";
      hint = check.ok
        ? (check.replaces !== null
            ? `Replace with ${PIECES[tool].label}`
            : `Place ${PIECES[tool].label}`) + where
        : check.reason;
      footprint(footprintCells(piece), ok ? GHOST_OK : GHOST_BAD);
    }
    this.host.onUi({ hint, hintOk: ok });
  }

  // ─── Validation overlay ──────────────────────────────────────────────────

  private refreshOverlay() {
    for (const child of [...this.overlay.children]) this.overlay.remove(child);
    const marked = new Set<string>();
    for (const issue of this.layout.issues) {
      if (issue.severity !== "error") continue;
      for (const [cx, cz] of issue.cells) {
        const key = `${cx},${cz}`;
        if (marked.has(key)) continue;
        marked.add(key);
        const sq = new THREE.Mesh(this.overlayGeo, this.issueMat);
        sq.position.set(cx * CELL, 0.08, cz * CELL);
        this.overlay.add(sq);
      }
    }
    // Open ends: red arrows pointing out of the cell edge where the road stops.
    for (const end of this.layout.openEnds) {
      const [dx, dz] = DIR_VEC[end.dir];
      const m = new THREE.Mesh(this.openGeo, this.openMat);
      m.position.set(
        end.cell[0] * CELL + dx * (CELL / 2 - 1.2),
        1.2 + end.level * LEVEL_HEIGHT,
        end.cell[1] * CELL + dz * (CELL / 2 - 1.2),
      );
      m.rotation.y = Math.atan2(dx, dz);
      this.overlay.add(m);
    }
    // Race direction on the start piece.
    const start = this.track.pieces[this.layout.startIndex];
    if (start) {
      const arrow = this.startArrow(start.rot);
      const c = toWorld(start, { x: 0, z: 0 });
      arrow.position.set(c.x, pieceLevel(start) * LEVEL_HEIGHT, c.z);
      this.overlay.add(arrow);
    }
    this.refreshLabels();
  }

  /**
   * Elevation indicator: a tag over every raised piece ("2") and ramp ("1→2"), so heights read at
   * a glance from the top-down view. Ramps on the circuit read in the race direction ("2→1" is a
   * descent); others from their low end.
   */
  private refreshLabels() {
    for (const child of [...this.labels.children]) this.labels.remove(child);
    const reversed = new Map(this.layout.order.map((o) => [o.index, o.reversed]));
    let used = 0;
    for (const [index, p] of this.track.pieces.entries()) {
      const rise = PIECES[p.type].rise;
      const level = pieceLevel(p);
      if (level === 0 && rise === 0) continue;
      const text = !rise
        ? `${level}`
        : reversed.get(index)
          ? `${level + rise}→${level}`
          : `${level}→${level + rise}`;
      let mat = this.labelMats[used];
      if (!mat) {
        mat = new THREE.SpriteMaterial({ depthTest: false, transparent: true });
        this.labelMats.push(mat);
      }
      used++;
      mat.map = this.labelTexture(text);
      const sprite = new THREE.Sprite(mat);
      const cells = footprintCells(p);
      const cx = cells.reduce((a, c) => a + c[0], 0) / cells.length;
      const cz = cells.reduce((a, c) => a + c[1], 0) / cells.length;
      sprite.position.set(cx * CELL, (level + rise / 2) * LEVEL_HEIGHT + 2.5, cz * CELL);
      sprite.scale.set(rise ? 6 : 3.6, 3, 1);
      sprite.renderOrder = 5;
      this.labels.add(sprite);
    }
  }

  private labelTexture(text: string): THREE.CanvasTexture {
    const cached = this.labelTextures.get(text);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = text.length > 1 ? 128 : 76;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(20, 24, 32, 0.78)";
    ctx.beginPath();
    ctx.roundRect(2, 2, canvas.width - 4, 60, 28);
    ctx.fill();
    ctx.fillStyle = "#ffd76a";
    ctx.font = "bold 40px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, 34);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.labelTextures.set(text, tex);
    return tex;
  }

  // ─── Input ───────────────────────────────────────────────────────────────

  private updateHover(clientX: number, clientY: number) {
    const rect = this.host.canvas.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.host.camera());
    this.hasHover = this.raycaster.ray.intersectPlane(this.plane, this.hover) !== null;
    this.updateGhost();
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    try {
      this.host.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already released; drag still works while it stays over the canvas.
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragged = false;
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      this.dragged = true;
    }
    if (e.pointerType === "mouse") this.updateHover(e.clientX, e.clientY);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === "mouse") this.updateHover(e.clientX, e.clientY);
      return;
    }
    if (this.pointers.size === 2) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (this.pinchDist > 0) this.zoom(this.pinchDist / d);
      this.pinchDist = d;
      return;
    }
    const start = this.dragStart;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) this.dragged = true;
    if (this.dragged) {
      // Pan: move the camera so the ground stays under the pointer.
      const cam = this.host.camera();
      const worldPerPx =
        (2 * this.camH * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) /
        this.host.canvas.clientHeight;
      this.camX += (e.clientX - prev.x) * worldPerPx;
      this.camZ += (e.clientY - prev.y) * worldPerPx;
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.updateHover(e.clientX, e.clientY);
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const wasTap = this.pointers.size === 1 && !this.dragged && this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    if (wasTap) {
      this.updateHover(e.clientX, e.clientY);
      this.act(e.button === 2);
    }
    if (this.pointers.size === 0) {
      this.dragStart = null;
      if (e.pointerType !== "mouse") {
        this.hasHover = false;
        this.updateGhost();
      }
    }
  };

  private readonly onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && this.pointers.size === 0) {
      this.hasHover = false;
      this.updateGhost();
    }
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom(Math.exp(e.deltaY * 0.0015));
    this.updateHover(e.clientX, e.clientY);
  };

  private zoom(factor: number) {
    this.camH = THREE.MathUtils.clamp(this.camH * factor, 25, 320);
  }

  private readonly onContextMenu = (e: Event) => e.preventDefault();

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === "KeyZ") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && e.code === "KeyY") {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod || e.altKey) return;
    if (e.code.startsWith("Digit")) {
      // 1–9, then 0 for the tenth tool.
      const n = Number(e.code.slice(5));
      const tool = EDITOR_TOOLS[(n === 0 ? 10 : n) - 1];
      if (tool) this.setTool(tool);
      return;
    }
    switch (e.code) {
      case "KeyR":
      case "KeyQ":
      case "KeyE":
        this.rotate(e.shiftKey || e.code === "KeyQ" ? -1 : 1);
        break;
      case "KeyF":
        this.toggleFlip();
        break;
      case "KeyI":
        this.pick();
        break;
      case "KeyH":
        this.setTool("level");
        break;
      case "Equal":
      case "NumpadAdd":
      case "PageUp":
        e.preventDefault();
        this.setLevel(this.level + 1);
        break;
      case "Minus":
      case "NumpadSubtract":
      case "PageDown":
        e.preventDefault();
        this.setLevel(this.level - 1);
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.keys.add(e.code);
        break;
      case "KeyX":
      case "Delete":
      case "Backspace":
        this.setTool("erase");
        break;
      case "KeyP":
        this.setPreview(!this.preview);
        break;
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
      case "KeyW":
      case "KeyA":
      case "KeyS":
      case "KeyD":
        e.preventDefault();
        this.keys.add(e.code);
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
}

/** Comparable snapshot of what the editor changes (name, pieces, props). */
function trackKey(t: TrackData): string {
  return JSON.stringify([t.name, t.pieces, t.props]);
}
