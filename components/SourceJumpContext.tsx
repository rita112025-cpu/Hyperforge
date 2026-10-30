"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface SourceJump {
  docId: string;
  start: number;
  end: number;
}

type SourceJumpHandler = (source: SourceJump) => void;

const SourceJumpContext = createContext<SourceJumpHandler | null>(null);

export function SourceJumpProvider({ onJump, children }: { onJump: SourceJumpHandler; children: ReactNode }) {
  return <SourceJumpContext.Provider value={onJump}>{children}</SourceJumpContext.Provider>;
}

export function useSourceJump(): SourceJumpHandler | null {
  return useContext(SourceJumpContext);
}
