"use client";
import { useEffect, useRef } from "react";
import type { GraphController } from "../lib/graph/controller";
import { drawGraph } from "../lib/graph/draw";
import { FrameLoop } from "../lib/graph/frame-loop";
import type { GraphModel } from "../lib/graph/types";

export interface CanvasContextMenuEvent {
  /** canvas 內的 CSS px 座標（選單定位用） */
  x: number;
  y: number;
  hitId: string | null;
  selected: string[];
}

interface Props {
  controller: GraphController;
  model: GraphModel;
  onContextMenu: (e: CanvasContextMenuEvent) => void;
  /** 僅在網址帶 ?e2e=1 時啟用：掛上唯讀的 window.__HYPERFORGE_E2E__（節點螢幕座標、frame 計時），供瀏覽器驗收腳本使用 */
  e2e: boolean;
}

interface PerfSample {
  frames: number;
  workMs: number[];
}

/**
 * Canvas 畫布。位置 / 速度 / viewport / hover / 框選都在 GraphController（ref）中，
 * 這個元件只負責：建立 rAF 迴圈、把 DOM 事件轉給 controller、處理尺寸與 devicePixelRatio。
 * 不會在 animation frame 內寫入 React state / Zustand。
 */
export default function GraphCanvas({ controller, model, onContextMenu, e2e }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const loopRef = useRef<FrameLoop | null>(null);
  const menuRef = useRef(onContextMenu);
  const perfRef = useRef<PerfSample>({ frames: 0, workMs: [] });

  useEffect(() => {
    menuRef.current = onContextMenu;
  }, [onContextMenu]);

  // 迴圈、尺寸、wheel。StrictMode 的 mount → cleanup → mount：cleanup 會 dispose 舊迴圈，不會留下第二個。
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !wrap || !ctx) return;

    let w = 1;
    let h = 1;
    let dpr = 1;
    const loop = new FrameLoop((dt) => {
      const t0 = e2e ? performance.now() : 0;
      // devicePixelRatio 在尺寸沒變時也可能改變（瀏覽器縮放、拖到不同 DPR 的螢幕）：每個 frame 檢查，變了就重設 canvas 緩衝區，避免模糊
      if ((window.devicePixelRatio || 1) !== dpr) resize();
      controller.tick(dt);
      if (controller.consumeDirty()) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawGraph(ctx, controller, w, h);
        if (e2e) {
          const p = perfRef.current;
          p.frames++;
          p.workMs.push(performance.now() - t0);
          if (p.workMs.length > 2000) p.workMs.shift();
        }
      }
      return controller.needsFrame();
    });
    loopRef.current = loop;
    controller.onInvalidate = () => loop.kick();

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      w = Math.max(1, Math.floor(r.width));
      h = Math.max(1, Math.floor(r.height));
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      controller.setSize(w, h);
      controller.markDirty();
      loop.kick();
    };
    // 休眠中（沒有 frame）時 DPR 改變：以 matchMedia 喚醒。每次 DPR 改變後要用新的值重新註冊監聽。
    let mq: MediaQueryList | null = null;
    const onDprChange = () => {
      resize();
      watchDpr();
    };
    const watchDpr = () => {
      mq?.removeEventListener("change", onDprChange);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener("change", onDprChange);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    watchDpr();

    // wheel 必須是 non-passive 的原生 listener，才能 preventDefault，滾輪只縮放圖、不帶動整頁捲動。
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      controller.wheel(e.clientX - r.left, e.clientY - r.top, e.deltaY, e.deltaMode);
      canvas.style.cursor = controller.cursor();
      loop.kick();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      canvas.removeEventListener("wheel", onWheel);
      mq?.removeEventListener("change", onDprChange);
      ro.disconnect();
      controller.onInvalidate = null;
      loop.dispose();
      loopRef.current = null;
    };
  }, [controller, e2e]);

  // 圖更新時交給 controller（沿用既有節點位置）
  useEffect(() => {
    controller.setGraph(model.nodes, model.edges);
    loopRef.current?.kick();
  }, [controller, model]);

  // 唯讀的 e2e 驗收介面（只有 ?e2e=1 才存在）
  useEffect(() => {
    if (!e2e) return;
    const api = {
      snapshot() {
        const c = controller;
        return {
          size: c.size,
          viewport: { ...c.viewport },
          asleep: c.sim.asleep,
          ticks: c.sim.ticks,
          selection: [...c.selection],
          hover: c.hoverId,
          boxMode: c.boxMode,
          nodes: c.nodes.map((n, i) => ({
            id: n.id,
            label: n.label,
            kind: n.kind,
            temporary: n.temporary,
            heuristic: n.heuristic,
            r: n.r,
            x: c.sim.x[i],
            y: c.sim.y[i],
            sx: c.sim.x[i] * c.viewport.zoom + c.viewport.panX,
            sy: c.sim.y[i] * c.viewport.zoom + c.viewport.panY,
            pinned: c.sim.pinned[i] === 1,
          })),
        };
      },
      perf: () => ({ frames: perfRef.current.frames, workMs: [...perfRef.current.workMs] }),
      resetPerf: () => {
        perfRef.current = { frames: 0, workMs: [] };
      },
    };
    (window as unknown as { __HYPERFORGE_E2E__?: typeof api }).__HYPERFORGE_E2E__ = api;
    return () => {
      delete (window as unknown as { __HYPERFORGE_E2E__?: typeof api }).__HYPERFORGE_E2E__;
    };
  }, [controller, e2e]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const after = () => {
    if (canvasRef.current) canvasRef.current.style.cursor = controller.cursor();
    loopRef.current?.kick();
  };

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="知識圖譜畫布：節點為概念，連線為同一句話內共同出現"
        data-testid="graph-canvas"
        tabIndex={0}
        className="block touch-none select-none outline-none"
        style={{ cursor: "grab" }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          canvasRef.current?.setPointerCapture(e.pointerId);
          const p = local(e);
          controller.pointerDown(p.x, p.y, { shift: e.shiftKey, button: e.button });
          after();
        }}
        onPointerMove={(e) => {
          const p = local(e);
          controller.pointerMove(p.x, p.y);
          after();
        }}
        onPointerUp={(e) => {
          if (canvasRef.current?.hasPointerCapture(e.pointerId)) canvasRef.current.releasePointerCapture(e.pointerId);
          const p = local(e);
          controller.pointerUp(p.x, p.y);
          after();
        }}
        onPointerCancel={() => {
          controller.cancelInteraction();
          after();
        }}
        onPointerLeave={() => {
          controller.pointerLeave();
          after();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const p = local(e);
          const info = controller.contextMenuAt(p.x, p.y);
          menuRef.current({ x: p.x, y: p.y, ...info });
          after();
        }}
      />
    </div>
  );
}
