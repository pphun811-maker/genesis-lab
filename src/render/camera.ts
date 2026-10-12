/**
 * 相机：视口中心（世界坐标）+ 缩放（屏幕像素 / 世界单位）。
 * 支持平移、以光标为锚点的缩放、跟随个体。
 */
export class Camera {
  x = 0;
  y = 0;
  scale = 4;
  followId: number | null = null;
  worldW = 100;
  worldH = 100;

  fit(viewW: number, viewH: number, worldW: number, worldH: number): void {
    this.worldW = worldW;
    this.worldH = worldH;
    this.scale = Math.min(viewW / worldW, viewH / worldH) * 0.96;
    this.x = worldW / 2;
    this.y = worldH / 2;
  }

  screenToWorld(sx: number, sy: number, viewW: number, viewH: number): [number, number] {
    return [
      (sx - viewW / 2) / this.scale + this.x,
      (sy - viewH / 2) / this.scale + this.y,
    ];
  }

  worldToScreen(wx: number, wy: number, viewW: number, viewH: number): [number, number] {
    return [
      (wx - this.x) * this.scale + viewW / 2,
      (wy - this.y) * this.scale + viewH / 2,
    ];
  }

  panBy(dx: number, dy: number): void {
    this.followId = null;
    this.x -= dx / this.scale;
    this.y -= dy / this.scale;
    this.clamp();
  }

  zoomAt(sx: number, sy: number, factor: number, viewW: number, viewH: number): void {
    const [wx, wy] = this.screenToWorld(sx, sy, viewW, viewH);
    const newScale = Math.min(96, Math.max(0.6, this.scale * factor));
    if (newScale === this.scale) return;
    this.scale = newScale;
    // 保持光标下的世界点不动
    this.x = wx - (sx - viewW / 2) / this.scale;
    this.y = wy - (sy - viewH / 2) / this.scale;
    this.clamp();
  }

  /** 跟随个体时把视口中心对到它身上 */
  centerOn(wx: number, wy: number): void {
    this.x = wx;
    this.y = wy;
    this.clamp();
  }

  private clamp(): void {
    const margin = 40;
    this.x = Math.min(this.worldW + margin, Math.max(-margin, this.x));
    this.y = Math.min(this.worldH + margin, Math.max(-margin, this.y));
  }
}
