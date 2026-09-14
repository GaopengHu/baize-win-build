import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

type ResizeAxis = 'x' | 'y' | 'both';
type ResizeDirection = 1 | -1;

type Size = {
  width: number;
  height: number;
};

type UseResizablePanelOptions = {
  defaultWidth: number;
  defaultHeight: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function useResizablePanel({
  defaultWidth,
  defaultHeight,
  minWidth = 320,
  minHeight = 120,
  maxWidth = Number.POSITIVE_INFINITY,
  maxHeight = Number.POSITIVE_INFINITY,
}: UseResizablePanelOptions) {
  const [size, setSize] = useState<Size>({
    width: defaultWidth,
    height: defaultHeight,
  });
  const dragRef = useRef<{
    axis: ResizeAxis;
    direction: ResizeDirection;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);

  const stopResizing = useCallback(() => {
    dragRef.current = null;
  }, []);

  const startResize = useCallback(
    (axis: ResizeAxis, direction: ResizeDirection = 1) =>
      (event: ReactPointerEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();

        dragRef.current = {
          axis,
          direction,
          startX: event.clientX,
          startY: event.clientY,
          startWidth: size.width,
          startHeight: size.height,
        };
      },
    [size.height, size.width]
  );

  useEffect(() => {
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const nextWidth =
        drag.axis === 'y'
          ? drag.startWidth
          : clamp(
              drag.startWidth + (event.clientX - drag.startX) * drag.direction,
              minWidth,
              Math.min(maxWidth, Math.max(minWidth, viewportWidth - 24))
            );
      const nextHeight =
        drag.axis === 'x'
          ? drag.startHeight
          : clamp(
              drag.startHeight + (event.clientY - drag.startY) * drag.direction,
              minHeight,
              Math.min(maxHeight, Math.max(minHeight, viewportHeight - 120))
            );

      setSize({ width: nextWidth, height: nextHeight });
    };

    const handlePointerUp = () => {
      stopResizing();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [maxHeight, maxWidth, minHeight, minWidth, stopResizing]);

  return {
    size,
    setSize,
    startResize,
  };
}
